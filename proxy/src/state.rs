//! Shared state: the HTTP clients (upstream ones on the Settings resolver, dns.rs; the Node one on the system
//! resolver), the Node control-plane endpoint, the shared secret, and the per-source POLICY CACHE. A `SourcePolicy` holds what the sidecar replays for a source's streams — the upstream
//! headers, the segment-relabel rule, and a GROWING allowlist of hosts. The allowlist is observational: it
//! is seeded with the resolved master's host and grown with every host the sidecar rewrites out of a
//! manifest (mirroring each adapter's dynamic-allow), so a client can only reach hosts that appeared in a
//! trusted upstream manifest — never an arbitrary/injected host (and private IPs are rejected outright).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::sync::{LockExt, RwExt};
use serde::Deserialize;
use tokio::sync::mpsc;
use url::Url;

// TEL batching (P3.1). Telemetry events are queued and flushed as one batched `{events:[...]}` POST rather than
// one POST per event, so a burst (a manifest poll + its media + N segment bytes) coalesces. Best-effort: a full
// queue drops (never block/grow the byte path); a short debounce coalesces without latency the stream can feel.
const TELEMETRY_QUEUE: usize = 4096;
const TELEMETRY_MAX_BATCH: usize = 256;
const TELEMETRY_FLUSH_MS: u64 = 250;

/// S3/ORIGIN: how often the aggregate ring footprint is reported. Matches Node's systemStatsHub TICK_MS, so
/// the Dashboard's MEMORY PRESSURE tile gets one fresh frame per tick rather than sampling a stale one.
const RING_REPORT_MS: u64 = 2500;

/// How long a resolved ENTRY target is reused before re-resolving. This collapses per-poll resolves for a
/// media-playlist entry (so a few-second player poll doesn't re-mint a dulo playbackUrl / re-scrape dlhd
/// every time), while staying well inside typical multi-minute token expiries. A master entry is fetched
/// once (the player then polls the variant HOP, which never resolves), so this mainly guards media-playlist
/// entries. It is a CAP: a grant whose target carries its own expiry (`expiresAtMs`) is reused for less when
/// that expiry comes sooner — see `target_ttl`.
const TARGET_TTL: Duration = Duration::from_secs(60);

/// EXP: how far ahead of a target's own expiry the cache stops handing it out. A reused target is fetched at
/// once by the request that reused it, so this only has to outlast one fetch plus a player's poll — and a
/// signed URL that lapses mid-poll is exactly the 403 this exists to avoid.
const TARGET_EXPIRY_MARGIN: Duration = Duration::from_secs(60);

/// EXP: the least a resolved target is ever reused for, however close its stated expiry. Without a floor, an
/// adapter that keeps handing back a target already inside the margin would be re-resolved on EVERY poll — a
/// resolver hammer built out of good intentions. A target this close to expiry that does lapse costs one
/// rejected fetch, which the rejected-target refresh (`invalidate_rejected_target`) then clears.
const MIN_TARGET_TTL: Duration = Duration::from_secs(5);

/// The message a stream-cap refusal carries when Node's reply names none.
const DEFAULT_REFUSAL: &str = "stream refused: this source is already at its concurrent-stream limit";

/// REJ: the resolve `reason` for a re-resolve that follows the upstream REFUSING the target outright — a definitive
/// 401/403/410 on the entry fetch. With `RETIRE_REFRESH_FAILED` it is one of Node's `FRESH_REASONS`
/// (resolveSeam.ts): the adapter is asked for a FRESHLY resolved target rather than the one it cached — a caching
/// resolver (zlive's per-slug Location) would otherwise hand back the very link that was just refused, for as long
/// as its cache believes it. Never sent on a scheduled renewal: that target is still valid, and a cached answer
/// is exactly right for it. Node rate-limits what it does with either, so an upstream that refuses every fresh
/// target too cannot turn these into a resolver hammer.
pub const RETIRE_TARGET_REJECTED: &str = "target_rejected";

/// REJ: the resolve `reason` for the origin ingest's re-resolve after it could not refresh the playlist it was
/// following through its target. See `RETIRE_TARGET_REJECTED`.
pub const RETIRE_REFRESH_FAILED: &str = "refresh_failed";

/// FOG (failover groups): how long a stream's failover cursor survives without ANY request (entry or hop)
/// before it resets to the parent. The cursor pins a stream to its winning candidate for the WHOLE viewing
/// session — a re-resolve never walks back to a dead parent mid-play — so the only reset is "playback
/// stopped": once requests cease for this long, the next session re-probes the channel itself first.
const FAILOVER_CURSOR_IDLE: Duration = Duration::from_secs(300);

/// FOG: hard cap on resolve attempts per failover walk (a runaway backstop over any real group size — the
/// walk normally ends on Node's distinct `failover_exhausted` reply). Sized above any real chain: Node may
/// spend the first attempt(s) on the SOURCE's own alternate upstreams (dlhd's independent player providers)
/// before the channel's configured backups start, so the cap has to clear both stages plus a wrap.
pub const MAX_FAILOVER_ATTEMPTS: u32 = 12;

// EDGE-3 gate cache. When Rust is the public edge, the stream-token gate lives in Node (POST
// /api/internal/authorize) but Rust must gate EVERY request — including warm hops that never re-hit the
// resolve seam. So each (token, source) decision is cached for AUTH_TTL: warm requests are an in-memory
// check (no Node round-trip), and revocation of streamTokenEnabled/allowedPlaylists takes effect within the
// TTL. AUTH_CACHE_MAX bounds memory against random-token spam (prune-expired-then-skip on overflow).
const AUTH_TTL: Duration = Duration::from_secs(30);
const AUTH_CACHE_MAX: usize = 4096;

/// EDGE-3 auth-cache key: (stream token, mount source, `?pl`). `pl` is part of the key — not just the request
/// — because Node gates it as well, so a decision made for one playlist must not authorize another. An absent
/// `pl` keys as the empty string, which is a distinct (and correct) cache slot: no `pl` means "the Default
/// proxy config", which is a different authorization question from any named playlist.
type AuthKey = (String, String, String);

struct AuthDecision {
    allowed: bool,
    status: u16,             // deny HTTP status (401/403) when !allowed
    message: String,         // deny plain-text (mirrors sidecar streamGate's exact message); empty when allowed
    username: Option<String>,
    expires: Instant,
}

#[derive(Clone)]
pub struct AppState {
    /// The DEFAULT UPSTREAM client — the probe's, and `client_for`'s build fallback. Resolves through `dns` (the
    /// Settings nameservers), like every `client_for` client.
    pub client: reqwest::Client,
    /// The loopback CONTROL-PLANE client: the resolve / authorize / telemetry / log calls to Node. Kept on the
    /// system resolver on purpose — see dns.rs SCOPE: no nameserver setting may cut the engine off from Node.
    node_client: reqwest::Client,
    /// EDGE-3: the reverse-proxy client for the non-stream leg (SPA / /api/* → Node). Distinct from `node_client`
    /// because a TRANSPARENT proxy must NOT auto-follow redirects (relay Node's 3xx verbatim) or auto-decompress
    /// (gzip off — else a stale Content-Length survives a stripped Content-Encoding). Only used on the edge path.
    /// System resolver, like `node_client`: it only ever dials Node.
    pub proxy_client: reqwest::Client,
    /// DNS: the upstream resolver every UPSTREAM client shares (dns.rs) — retargeted in place by the flush echo,
    /// so no client is rebuilt when the operator changes nameservers.
    dns: Arc<crate::dns::UpstreamDns>,
    pub node_url: String,
    pub secret: String,
    cache: Arc<Mutex<HashMap<String, Arc<SourcePolicy>>>>,
    targets: Arc<Mutex<HashMap<String, TargetEntry>>>,
    /// PXY-2: upstream clients keyed by the proxy-config knobs that are CLIENT-level in reqwest
    /// (connect_timeout_ms, max_redirects). Distinct combos are few (the Default + a handful of per-playlist
    /// Custom overrides), so this stays a tiny bounded cache; the Default combo serves every non-overriding
    /// source, preserving connection pooling for the common case. Built lazily on first use (client_for).
    upstream_clients: Arc<Mutex<HashMap<(u64, u32), reqwest::Client>>>,
    /// TEL batching (P3.1): report() enqueues here; a single background flusher (spawned in new()) coalesces +
    /// POSTs `{events:[...]}`. Sender is Clone, so every AppState clone shares the one queue + one flusher.
    telemetry_tx: mpsc::Sender<serde_json::Value>,
    /// DST (P3.2): a monotonic per-process stream-id source for continuous raw-TS sessions. Each TS stream mints
    /// one id (open→sbytes→close carry it) that Node maps to a socket-viewer connId (noteSocketViewer*). Node
    /// overwrites the mapping on `open`, so a counter reset after a sidecar restart cannot collide.
    stream_seq: Arc<AtomicU64>,
    /// EDGE-3: the per-(token, source, pl) stream-gate decision cache (see AUTH_TTL). Only consulted on the
    /// public edge path (edge.rs); the loopback sidecar path is gated by Node's Express streamGate as before.
    /// `pl` is in the key because Node gates it too — see `authorize`. Absent `pl` keys as the empty string.
    auth_cache: Arc<Mutex<HashMap<AuthKey, AuthDecision>>>,
    /// S3/ORIGIN: the live per-channel ingests, keyed by `target_key(source, entry)`. Deliberately SEPARATE
    /// from `targets` — that is a short-lived RESOLUTION cache (TARGET_TTL), this holds long-lived MEDIA
    /// (a ring of decrypted segments) whose lifetime is driven by subscriber refcount, not a TTL.
    origins: Arc<Mutex<HashMap<String, Arc<crate::origin::Origin>>>>,
}

/// A cached resolved ENTRY target + the stream's FAILOVER CURSOR. `attempt` pins which candidate the
/// stream is on (0 = the channel itself, N >= 1 = its Nth failover child) and `policy_key` names the
/// SourcePolicy that candidate's grants file under — the SERVING adapter, which differs from the URL mount
/// source for a cross-provider child (keying by it is what stops a child grant from overwriting the parent
/// provider's shared policy). The cursor OUTLIVES target validity: invalidate_target only expires the
/// target, the attempt survives so the next resolve resumes at the pinned candidate; `last_access` gives
/// the cursor its idle lifetime (FAILOVER_CURSOR_IDLE — see there).
pub struct TargetEntry {
    target: String,
    expires: Instant,
    policy_key: String,
    attempt: u32,
    last_access: Instant,
    /// EXP: epoch ms at which `target` itself stops being valid, when the grant said (`expiresAtMs`). Already
    /// folded into `expires` for the cache; kept so the origin ingest can schedule its own renewal off the
    /// same number (`target_record`).
    expires_at_ms: Option<u64>,
    /// When a definitive upstream rejection last expired this ENTRY's target (`invalidate_rejected_target`).
    /// Carried across re-resolves on purpose — see `record_target`.
    rejected_at: Option<Instant>,
    /// REJ: why the NEXT resolve of this entry is happening, when a rejection expired the target
    /// (`RETIRE_TARGET_REJECTED`). Taken by that resolve — whichever caller makes it — and never carried across a
    /// re-insert: once a resolve has replaced the refused target, the hint has said all it had to.
    retire_hint: Option<&'static str>,
}

/// What a target record says about the resolve that wrote it — see `AppState::target_record`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TargetMeta {
    /// The failover attempt the target was resolved at (0 = the channel itself).
    pub attempt: u32,
    /// Epoch ms at which the target stops being valid, when the adapter knew.
    pub expires_at_ms: Option<u64>,
}

/// The target-cache key for a stream: (mount source, entry url) — NUL-joined like the log rid.
pub(crate) fn target_key(source: &str, entry: &str) -> String {
    format!("{source}\u{0}{entry}")
}

/// Wall-clock now, as the epoch milliseconds a grant's `expiresAtMs` is written in.
pub(crate) fn epoch_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// EXP: how long a freshly resolved target may be reused — `TARGET_TTL`, or less when the grant says the target
/// itself lapses sooner. Pure so the arithmetic can be pinned without a clock.
fn target_ttl(expires_at_ms: Option<u64>, now_ms: u64) -> Duration {
    let Some(exp) = expires_at_ms else {
        return TARGET_TTL;
    };
    let left = Duration::from_millis(exp.saturating_sub(now_ms)).saturating_sub(TARGET_EXPIRY_MARGIN);
    left.clamp(MIN_TARGET_TTL, TARGET_TTL)
}

/// A resolve-seam failure. `Exhausted` is Node's DISTINCT 410 `failover_exhausted` reply — the requested
/// entry has no (more) failover candidates — which terminates a failover walk. `Refused` is Node's 429
/// `source_stream_cap`: POLICY, not failure — see its own doc. Everything else (a dead candidate's
/// resolve_failed 502, Node unreachable, a malformed grant, …) is `Other`: a walk advances past it, non-walk
/// callers just log it.
pub enum ResolveErr {
    Exhausted,
    /// CAP: the source is at its concurrent-stream cap and this is a NEW channel. Definitive by contract: the seam
    /// must send it only where no candidate could carry the stream instead — an ungrouped entry, or a group whose
    /// backups all sit behind the same cap — and answer a channel whose backup COULD play with a walkable failure
    /// (`Other`), which the walk routes around like any dead candidate. So every caller stops HERE — the relay
    /// answers the client 429 with Node's message, an origin ingest ends, and a retry loop does not ask again
    /// every couple of seconds. Carries that message, which names the source and the cap for the viewer.
    Refused(String),
    Other(String),
}

impl std::fmt::Display for ResolveErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveErr::Exhausted => write!(f, "failover candidates exhausted"),
            ResolveErr::Refused(why) => write!(f, "refused: {why}"),
            ResolveErr::Other(e) => write!(f, "{e}"),
        }
    }
}

/// Classify a non-2xx reply from the resolve seam. Pure so the wire contract can be pinned without a Node.
fn seam_failure(status: u16, body: &str) -> ResolveErr {
    // Node's DISTINCT exhausted reply (410 failover_exhausted) — the walk's terminator. Matched on both
    // signals so neither a proxy in front nor a body tweak can turn it into an endless walk.
    if status == 410 || body.contains("failover_exhausted") {
        return ResolveErr::Exhausted;
    }
    // CAP: 429 `{ error: 'source_stream_cap', message }`. Also matched on the parsed error CODE, for the same
    // reason as above — but on the field, not a substring: an adapter's own failure text is interpolated into
    // a 502's body, and a stray mention there must not turn a walkable failure into a refusal.
    let json = serde_json::from_str::<serde_json::Value>(body).ok();
    let field = |k: &str| json.as_ref().and_then(|v| v.get(k)).and_then(|v| v.as_str());
    if status == 429 || field("error") == Some("source_stream_cap") {
        let message = field("message").map(str::trim).filter(|m| !m.is_empty()).unwrap_or(DEFAULT_REFUSAL);
        return ResolveErr::Refused(message.to_string());
    }
    ResolveErr::Other(format!("resolve {status}: {body}"))
}

/// One successful seam resolve, as `resolve` hands it to `resolve_at`.
struct Granted {
    policy: Arc<SourcePolicy>,
    policy_key: String,
    target: String,
    expires_at_ms: Option<u64>,
}

pub struct SourcePolicy {
    /// Upstream headers replayed on every hop of the source's streams (per-stream constant; last resolve wins).
    pub headers: RwLock<Vec<(String, String)>>,
    /// Force this content-type on non-manifest (segment) responses; None = pass upstream through.
    pub relabel_segment: RwLock<Option<String>>,
    /// Permit private/loopback upstream IPs (LAN sources); false for public-CDN sources.
    pub allow_private: AtomicBool,
    /// Whether the SERVING adapter has alternate upstreams to walk to — Node's `adapter.playerSelectable`.
    ///
    /// The undecodable-upstream detector (S3/UND, `origin.rs`) is scoped to it: retiring a provider is only
    /// useful where there is another one to retire it FOR, and on a single-upstream source the retirement
    /// would just re-resolve the same dead provider on a 2 s loop. It rides the grant because that capability
    /// is the adapter's, and the adapter lives in Node — the data plane used to test `source == "dlhd"`,
    /// which was the crate's only hardcoded provider id and silently excluded the next such adapter.
    pub player_selectable: AtomicBool,
    /// The growing SSRF allowlist (lowercased hosts): seed = resolved master host, grown from manifest children.
    pub hosts: RwLock<HashSet<String>>,
    /// PXY-2: the resolved proxy-config CLIENT knobs for this source's streams (from the grant). proxy.rs
    /// selects the upstream client by these via client_for. Defaults match the old hardcoded client so a cold
    /// policy (pre-resolve) behaves exactly as before.
    pub connect_timeout_ms: AtomicU64,
    pub max_redirects: AtomicU32,
    /// P3.1/RSL: PER-STREAM knobs (NOT client-level — applied in the streaming loop, never in client_for).
    /// read_timeout_ms is an IDLE/read timeout for stall detection (0 = disabled → today's no-truncation
    /// behavior); buffer_size_kb is the bounded read-ahead buffer size (0 = disabled → the direct counted pipe).
    pub read_timeout_ms: AtomicU64,
    pub buffer_size_kb: AtomicU64,
    /// P3.2/DST: the distribution output format for this source's streams — "hls" (per-segment passthrough) or
    /// "ts" (continuous raw-TS, honored only on the /api/ext/v1 mount). RwLock<String> so a re-resolve can flip it.
    pub output_format: RwLock<String>,
    /// SIR: STREAM-INF Redux — opt-in, non-destructive master-playlist reorder (proxy.rs applies it only on the
    /// /api/ext/v1 mount) so the first #EXT-X-STREAM-INF lands within a strict player's manifest probe window
    /// (e.g. VLC's ~8 KiB peek). AtomicBool so a re-resolve can flip it; false = today's byte-identical output.
    pub stream_inf_redux: AtomicBool,
    /// FOG: play-time failover groups — on a failed ENTRY establish, walk the channel's ordered failover
    /// children via attempt=1,2,… resolves. Default ON (configuring a group is the operator's real opt-in;
    /// ungrouped channels behave identically either way — their attempt-1 resolve is `failover_exhausted`).
    pub failover_enabled: AtomicBool,
    /// FOG: also treat a DEFINITIVE upstream non-2xx (4xx/5xx — normally forwarded verbatim) as a failover
    /// trigger. Default OFF: it changes long-standing forward-verbatim semantics, so the operator opts in.
    pub failover_on_definite_error: AtomicBool,
    /// S3/ORIGIN: serve this source's streams from a LOCAL ORIGIN (origin.rs) instead of proxying the
    /// upstream manifest — one refcounted ingest per channel decrypts + caches segments, and the client is
    /// served a masqueradarr-authored stream. Default OFF: `false` is byte-identical to today's behavior, and
    /// a grant from a pre-S3 Node omits the key entirely (see ProxyConfigWire).
    pub origin_enabled: AtomicBool,
    /// S3/ORIGIN: the per-channel ring cap in MiB. Bounds ingest RAM for ONE channel; a 3-segment floor still
    /// wins over it (HLS needs ≥3 target durations to be playable), which origin.rs logs under `iop` so the
    /// operator is told to raise the dial rather than chasing stalls. NOT a global ceiling — see the plan's
    /// postponed `LRU` item.
    pub origin_ring_mb: AtomicU64,
    /// S3/CUE: the adapter-declared ad-segment URI signature (percent-DECODED, lowercased substrings). Empty
    /// for every source that emits real cue tags — or none at all — which is what makes URI-based ad
    /// detection FAIL CLOSED. Never inferred here; Node's adapter is the only author (see `origin::ad_signal`
    /// and the `Boundary` doc comment on why a URI *diff* is not an acceptable substitute). Read-only: breaks
    /// are always served as the provider sent them; this only names them in the log and telemetry.
    pub ad_uri_contains: RwLock<Vec<String>>,
    /// S3/ORIGIN: republish every ingested segment onto ONE timeline with canonical pids. A KILL SWITCH for a
    /// FIX, so it defaults ON — off restores the un-normalised republishing whose pid churn freezes players
    /// mid-pod (see `tsnorm::Splicer`). Meaningless unless `origin_enabled`.
    pub splice_normalize: AtomicBool,
    /// DSG: the SERVING adapter declares that its segments arrive disguised (a transport stream smuggled inside
    /// an image — see `tsseg`'s DSG section), so the PASS-THROUGH byte paths strip the wrapper: the relay pump
    /// (`stream::segment_body`) and the raw-TS producer (`tsmux`). It also drops the upstream's
    /// `#EXT-X-INDEPENDENT-SEGMENTS` from rewritten playlists (`manifest::drop_independent_segments`).
    ///
    /// Adapter-declared and overwritten on every resolve, exactly like `relabel_segment`: whether a candidate's
    /// segments are disguised is a fact about ITS provider, which is also why the pass-through paths read it
    /// from the policy the stream is pinned to (a failover child's, via `&e=`), never the mount source's. The
    /// origin ingest does not consult it at all — it unwraps universally, because the ring is TS by contract.
    pub segment_unwrap: AtomicBool,
}

impl SourcePolicy {
    fn empty() -> Self {
        Self {
            headers: RwLock::new(Vec::new()),
            relabel_segment: RwLock::new(None),
            allow_private: AtomicBool::new(false),
            player_selectable: AtomicBool::new(false),
            hosts: RwLock::new(HashSet::new()),
            connect_timeout_ms: AtomicU64::new(15000),
            max_redirects: AtomicU32::new(10),
            read_timeout_ms: AtomicU64::new(0),
            buffer_size_kb: AtomicU64::new(0),
            output_format: RwLock::new("hls".to_string()),
            stream_inf_redux: AtomicBool::new(false),
            failover_enabled: AtomicBool::new(true),
            failover_on_definite_error: AtomicBool::new(false),
            origin_enabled: AtomicBool::new(false),
            origin_ring_mb: AtomicU64::new(crate::origin::DEFAULT_RING_MB),
            ad_uri_contains: RwLock::new(Vec::new()),
            splice_normalize: AtomicBool::new(true),
            segment_unwrap: AtomicBool::new(false),
        }
    }
}

/// The grant the Node resolve seam returns (mirrors server/src/proxy/resolveSeam.ts ResolveGrant).
#[derive(Deserialize)]
pub struct Grant {
    pub target: String,
    #[serde(rename = "upstreamHeaders")]
    pub upstream_headers: HashMap<String, String>,
    #[serde(rename = "relabelSegment")]
    pub relabel_segment: Option<String>,
    #[serde(rename = "allowPrivate")]
    pub allow_private: bool,
    /// S3/UND: does the serving adapter have alternate upstreams? `default` → false → an older Node degrades
    /// to "no undecodable detection", which is the safe direction: the detector only ever RETIRES an upstream.
    #[serde(rename = "playerSelectable", default)]
    pub player_selectable: bool,
    // PXY-2: the resolved (Custom→Default→env) proxy config. Node already merged headerOverrides into
    // upstreamHeaders, so this struct declares the knobs Rust applies: connectTimeoutMs + maxRedirects (P2,
    // client-level), readTimeoutMs + bufferSizeKb (P3.1/RSL, per-stream) and outputFormat (hls|ts, P3.2/DST).
    // serde silently ignores only the still-reserved segmentCacheTtlSec.
    #[serde(rename = "proxyConfig", default)]
    pub proxy_config: ProxyConfigWire,
    /// FOG: which per-source policy this grant belongs to — the SERVING candidate's adapter id (equals the
    /// mount source for attempt 0 / ungrouped; the child's provider for a failover candidate). resolve()
    /// keys the SourcePolicy by this, never the URL mount source. `default` → None → an older Node degrades
    /// to mount-source keying (today's behavior).
    /// S3/CUE: the serving adapter's ad-segment URI signature, when it declared one (pluto). `default` → None
    /// → no URI-based ad detection, which is the correct posture for every source that didn't opt in and for
    /// a pre-CUE Node that omits the key entirely.
    #[serde(rename = "adSignature", default)]
    pub ad_signature: Option<AdSignatureWire>,
    /// DSG: the serving adapter's segments arrive disguised and the pass-through paths must unwrap them
    /// (Node's `SourceProxy.segmentUnwrap`). `default` → false → an older Node, and every adapter that did not
    /// declare it, keep today's byte-exact pass-through.
    #[serde(rename = "segmentUnwrap", default)]
    pub segment_unwrap: bool,
    /// EXP: epoch ms at which `target` stops being valid — a signed URL's own token expiry, when the adapter
    /// knows it (Node's `ResolvedStream.expiresAtMs`). It shortens the relay's target reuse below `TARGET_TTL`
    /// and schedules the origin ingest's renewal ahead of the lapse. `default` → None → an older Node, and every
    /// adapter that knows no expiry, keep the fixed TTL and the reactive (refresh-failed) renewal.
    #[serde(rename = "expiresAtMs", default, deserialize_with = "lenient_epoch_ms")]
    pub expires_at_ms: Option<u64>,
    #[serde(rename = "policySource", default)]
    pub policy_source: Option<String>,
    /// FOG: failover context when this grant serves a candidate (attempt >= 1) — used for log attribution.
    #[serde(rename = "failover", default)]
    pub failover: Option<FailoverWire>,
    // (Node's grant also carries `isEntry`; the sidecar decides entry/hop from the path, so serde ignores it.)
}

/// S3/CUE: the adapter's ad-segment URI signature (mirrors resolveSeam.ts `adSignature`).
#[derive(Deserialize, Clone)]
pub struct AdSignatureWire {
    #[serde(rename = "uriContains", default)]
    pub uri_contains: Vec<String>,
}

/// FOG: the grant's failover block (attempt >= 1 grants only). Node also records the serving candidate for
/// Active Streams itself, so Rust only uses this for log lines — but `total` doubles as a sanity bound.
#[derive(Deserialize, Clone)]
pub struct FailoverWire {
    pub attempt: u32,
    pub total: u32,
    #[serde(rename = "candidateName", default)]
    pub candidate_name: String,
}

/// The resolved proxy config Rust applies. connectTimeoutMs + maxRedirects are CLIENT-level in reqwest (keyed
/// into client_for); readTimeoutMs + bufferSizeKb are PER-STREAM (P3.1/RSL — applied in the streaming loop);
/// outputFormat selects the distribution shape (P3.2/DST). Defaults match the old hardcoded client so a grant
/// from an older Node — or a missing/null field — degrades to today's behavior. NOT Copy: output_format owns a
/// String. Node sends readTimeoutMs/bufferSizeKb as `number | null`, so those are Option (serde `default` only
/// covers an ABSENT key, never an explicit null — Option maps a present null → None → disabled).
#[derive(Deserialize, Clone)]
pub struct ProxyConfigWire {
    #[serde(rename = "connectTimeoutMs", default = "default_connect_ms")]
    pub connect_timeout_ms: u64,
    #[serde(rename = "maxRedirects", default = "default_max_redirects")]
    pub max_redirects: u32,
    #[serde(rename = "readTimeoutMs", default)]
    pub read_timeout_ms: Option<u64>,
    #[serde(rename = "bufferSizeKb", default)]
    pub buffer_size_kb: Option<u64>,
    #[serde(rename = "outputFormat", default = "default_output_format")]
    pub output_format: String,
    // SIR: STREAM-INF Redux flag. serde `default` → false for a grant from an older Node or an absent key, so
    // the data plane degrades to today's byte-identical HLS master output.
    #[serde(rename = "streamInfRedux", default)]
    pub stream_inf_redux: bool,
    // FOG knobs. failoverEnabled defaults TRUE (an absent key — older Node — must not disable the feature
    // the group config opted into); failoverOnDefiniteError defaults false (explicit opt-in).
    #[serde(rename = "failoverEnabled", default = "default_true")]
    pub failover_enabled: bool,
    #[serde(rename = "failoverOnDefiniteError", default)]
    pub failover_on_definite_error: bool,
    // S3/ORIGIN knobs. Both serde-default so a grant from a pre-S3 Node (which sends neither key) degrades to
    // origin OFF at the shipped default cap — i.e. today's behavior exactly. Node wires them in S3 Phase 4.
    #[serde(rename = "originEnabled", default)]
    pub origin_enabled: bool,
    #[serde(rename = "originRingMb", default = "default_origin_ring_mb")]
    pub origin_ring_mb: u64,
    /// Defaults TRUE on an absent key, unlike every other S3 knob: an older Node predates the pid-remap fix,
    /// and degrading to the broken behaviour would be the wrong way to fail.
    #[serde(rename = "spliceNormalize", default = "default_true")]
    pub splice_normalize: bool,
}

fn default_connect_ms() -> u64 {
    15000
}
fn default_max_redirects() -> u32 {
    10
}
fn default_output_format() -> String {
    "hls".to_string()
}
fn default_true() -> bool {
    true
}
fn default_origin_ring_mb() -> u64 {
    crate::origin::DEFAULT_RING_MB
}

/// EXP: `expiresAtMs` as Node sends it (`number | null`), read without trusting its exact numeric shape. A grant
/// that fails to parse fails the WHOLE resolve, so a fractional, negative or non-numeric value has to degrade
/// to "no expiry known" — the fixed TTL every grant had before — and never to a dead stream.
fn lenient_epoch_ms<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    let ms = match Option::<serde_json::Value>::deserialize(d)? {
        Some(serde_json::Value::Number(n)) => {
            n.as_u64().or_else(|| n.as_f64().filter(|f| f.is_finite() && *f > 0.0).map(|f| f as u64))
        }
        _ => None,
    };
    Ok(ms.filter(|&ms| ms > 0))
}

impl Default for ProxyConfigWire {
    fn default() -> Self {
        Self {
            connect_timeout_ms: default_connect_ms(),
            max_redirects: default_max_redirects(),
            read_timeout_ms: None,
            buffer_size_kb: None,
            output_format: default_output_format(),
            stream_inf_redux: false,
            failover_enabled: true,
            failover_on_definite_error: false,
            origin_enabled: false,
            origin_ring_mb: default_origin_ring_mb(),
            splice_normalize: true,
        }
    }
}

impl AppState {
    pub fn new(node_url: String, secret: String) -> Self {
        // DNS: the upstream resolver every upstream client will share. It starts on the OS resolver; `with_dns`
        // gives it MASQ_NAMESERVERS once logging is up to announce it.
        Self::with_dns(node_url, secret, Arc::new(crate::dns::UpstreamDns::new()))
    }

    /// `new`, around a given upstream resolver — the seam a test uses to stand in for the OS resolver. The resolver
    /// comes first because every upstream client below is built with it.
    fn with_dns(node_url: String, secret: String, dns: Arc<crate::dns::UpstreamDns>) -> Self {
        // The loopback Node client — the resolve seam, the edge gate and both flushers. System resolver.
        let node_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("failed to build reqwest client");
        // The default UPSTREAM client. NO overall request timeout — segment streams are long-lived and a total
        // timeout would truncate them. A connect timeout only bounds the handshake (the resolve included, which
        // is why dns.rs keeps its own budget well under it). Redirects are followed (up to 10), and the final URL
        // (Response::url()) is used to rebase relative manifest URIs.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            .connect_timeout(Duration::from_secs(15))
            .dns_resolver(dns.clone())
            .build()
            .expect("failed to build reqwest client");
        // EDGE-3 reverse-proxy client: no redirect-follow + no auto-gzip so Node's responses relay byte-exact.
        let proxy_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .gzip(false)
            .build()
            .unwrap_or_else(|_| node_client.clone());
        // TEL: the telemetry queue + its single background flusher (spawned once; new() runs inside the tokio
        // runtime from #[tokio::main]). Best-effort — the byte path never waits on telemetry.
        let (telemetry_tx, telemetry_rx) = mpsc::channel::<serde_json::Value>(TELEMETRY_QUEUE);
        tokio::spawn(telemetry_flusher(
            telemetry_rx,
            node_client.clone(),
            format!("{node_url}/api/internal/telemetry"),
            secret.clone(),
            dns.clone(),
        ));
        // S3/ORIGIN: the live-ingest registry, built HERE rather than inline in `Self` so the ring reporter
        // can hold its own handle — it needs the map, not the whole AppState.
        let origins: Arc<Mutex<HashMap<String, Arc<crate::origin::Origin>>>> = Arc::new(Mutex::new(HashMap::new()));
        tokio::spawn(ring_reporter(origins.clone(), telemetry_tx.clone()));
        // LOG: install the global structured-logging sink + its own batched flusher (seeds the level from
        // MASQ_LOG_LEVEL, ships to /api/internal/log, learns live level + nameserver changes from the flush
        // echo). A cross-cutting global (like Node's `logger`) so every module logs without threading state.
        crate::log::init(node_client.clone(), format!("{node_url}/api/internal/log"), secret.clone(), dns.clone());
        // DNS: the resolver Node stamped at spawn — after log::init, so its lifecycle line reaches the drawer.
        dns.init_from_env();
        Self {
            client,
            node_client,
            proxy_client,
            dns,
            node_url,
            secret,
            cache: Arc::new(Mutex::new(HashMap::new())),
            targets: Arc::new(Mutex::new(HashMap::new())),
            upstream_clients: Arc::new(Mutex::new(HashMap::new())),
            telemetry_tx,
            stream_seq: Arc::new(AtomicU64::new(0)),
            auth_cache: Arc::new(Mutex::new(HashMap::new())),
            origins,
        }
    }

    /// DST: mint a unique-per-process continuous-TS stream id (monotonic; Node maps it → a socket connId).
    pub fn next_stream_id(&self) -> String {
        format!("ts{}", self.stream_seq.fetch_add(1, Ordering::Relaxed))
    }

    /// S3/ORIGIN: the live-ingest registry (origin.rs owns the lifecycle; this is just the shared map).
    pub(crate) fn origins(&self) -> &Arc<Mutex<HashMap<String, Arc<crate::origin::Origin>>>> {
        &self.origins
    }

    /// PXY-2: return the upstream client for the given proxy-config knobs, building + caching it on first use.
    /// Only connect_timeout + max_redirects are CLIENT-level in reqwest, so the cache key is exactly those two.
    /// There is still NO overall/read timeout — segment streams are long-lived and a total timeout would
    /// truncate them (the deferred readTimeoutMs lands in P3). Falls back to the default client on build error.
    /// DNS: every client built here shares the one upstream resolver, so a cached client follows a nameserver
    /// change live — the resolver is retargeted, never the client (the cache key stays the two knobs).
    pub fn client_for(&self, connect_timeout_ms: u64, max_redirects: u32) -> reqwest::Client {
        // Guard a degenerate 0 connect timeout (Node clamps to >=100, but never trust the wire).
        let connect_ms = if connect_timeout_ms == 0 { 15000 } else { connect_timeout_ms };
        let key = (connect_ms, max_redirects);
        {
            let m = self.upstream_clients.lock_ok();
            if let Some(c) = m.get(&key) {
                return c.clone();
            }
        }
        let built = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(max_redirects as usize))
            .connect_timeout(Duration::from_millis(connect_ms))
            .dns_resolver(self.dns.clone())
            .build()
            .unwrap_or_else(|_| self.client.clone());
        let mut m = self.upstream_clients.lock_ok();
        m.entry(key).or_insert_with(|| built).clone()
    }

    /// Resolve an ENTRY to (policy, target), reusing a recently-resolved target within TARGET_TTL so a
    /// re-polled media-playlist entry doesn't re-hit the provider each poll. Falls through to a live resolve
    /// when the cache is cold/stale or the pinned policy has been evicted. FOG: cursor-aware — the live
    /// resolve resumes at the stream's pinned candidate (a session stuck to a winning child STAYS on it;
    /// the pin resets to the parent only after FAILOVER_CURSOR_IDLE without requests).
    pub async fn resolve_entry(
        &self,
        source: &str,
        entry: &str,
        pl: Option<&str>,
    ) -> Result<(Arc<SourcePolicy>, String), ResolveErr> {
        let key = target_key(source, entry);
        let now = Instant::now();
        let (cached, attempt) = {
            let mut m = self.targets.lock_ok();
            match m.get_mut(&key) {
                Some(e) => {
                    if now.duration_since(e.last_access) > FAILOVER_CURSOR_IDLE {
                        e.attempt = 0; // playback stopped — a fresh session re-probes the channel itself
                    }
                    e.last_access = now;
                    if e.expires > now {
                        (Some((e.target.clone(), e.policy_key.clone())), e.attempt)
                    } else {
                        (None, e.attempt)
                    }
                }
                None => (None, 0),
            }
        };
        if let Some((target, policy_key)) = cached {
            if let Some(policy) = self.get(&policy_key) {
                return Ok((policy, target));
            }
        }
        self.resolve_at(source, entry, pl, attempt, None).await
    }

    /// FOG: force a FRESH resolve of a SPECIFIC candidate (bypass the target cache) and re-cache the
    /// result — pinning the stream's cursor to that attempt. attempt 0 = the channel itself (Node re-runs
    /// `resolveStream`, e.g. dlhd's player walk against its configured mirror);
    /// attempt N >= 1 = the channel's Nth ordered failover child, resolved via the child's own adapter.
    ///
    /// `reason` tells Node why this resolve is happening, when the caller knows. With none given, a hint the
    /// entry's record holds (`retire_hint` — set when a rejection expired the target) goes instead; either way
    /// the hint is spent, since this resolve replaces the refused target.
    pub async fn resolve_at(
        &self,
        source: &str,
        entry: &str,
        pl: Option<&str>,
        attempt: u32,
        reason: Option<&str>,
    ) -> Result<(Arc<SourcePolicy>, String), ResolveErr> {
        let pending = self.take_retire_hint(source, entry);
        let reason = reason.or(pending);
        let g = match self.resolve(source, entry, pl, attempt, reason).await {
            Ok(g) => g,
            // CAP: a refusal also retires whatever target this entry still has cached. Node said this channel
            // may not stream now; letting `resolve_entry` keep serving the last grant for the rest of its TTL
            // would admit it anyway, around the cap, on every poll that lands inside that window.
            Err(ResolveErr::Refused(why)) => {
                self.invalidate_target(source, entry);
                return Err(ResolveErr::Refused(why));
            }
            Err(e) => return Err(e),
        };
        self.record_target(source, entry, &g.target, g.policy_key, attempt, g.expires_at_ms);
        Ok((g.policy, g.target))
    }

    /// Write the target record for a successful resolve: the cached target (reused for `target_ttl`) plus the
    /// stream's failover cursor, pinned to `attempt`.
    fn record_target(
        &self,
        source: &str,
        entry: &str,
        target: &str,
        policy_key: String,
        attempt: u32,
        expires_at_ms: Option<u64>,
    ) {
        let now = Instant::now();
        let key = target_key(source, entry);
        let mut m = self.targets.lock_ok();
        // The rejected-target latch belongs to the ENTRY, not to one resolve of it, so it survives the
        // re-insert. Re-arming it on every resolve would let an upstream that rejects each FRESH target too
        // cost one resolve per poll — the very loop `invalidate_rejected_target` is bounded to prevent.
        let rejected_at = m.get(&key).and_then(|e| e.rejected_at);
        m.insert(
            key,
            TargetEntry {
                target: target.to_string(),
                expires: now + target_ttl(expires_at_ms, epoch_ms()),
                policy_key,
                attempt,
                last_access: now,
                expires_at_ms,
                rejected_at,
                retire_hint: None,
            },
        );
    }

    /// REJ: take the entry's pending retire hint, if a rejection left one (see `TargetEntry::retire_hint`).
    fn take_retire_hint(&self, source: &str, entry: &str) -> Option<&'static str> {
        self.targets.lock_ok().get_mut(&target_key(source, entry)).and_then(|e| e.retire_hint.take())
    }

    /// The failover attempt and expiry recorded for `target` — `None` unless the entry's record still names
    /// that very target.
    ///
    /// Keyed on the target and not just the entry because the record is SHARED: a concurrent resolve of the
    /// same channel (a client's entry poll, a hop's async refresh, a relay walk) may have overwritten it with a
    /// different candidate since. Attributing that candidate's attempt or expiry to our target would be a
    /// guess; `None` makes the caller take its conservative path instead (origin: no continuity claim, no
    /// scheduled renewal — the reactive one still covers it).
    pub fn target_record(&self, source: &str, entry: &str, target: &str) -> Option<TargetMeta> {
        let m = self.targets.lock_ok();
        let e = m.get(&target_key(source, entry)).filter(|e| e.target == target)?;
        Some(TargetMeta { attempt: e.attempt, expires_at_ms: e.expires_at_ms })
    }

    /// RSL failover: a fresh resolve at the stream's CURRENT pinned candidate (see resolve_at). Used by the
    /// hop-failure async refresh + the origin ingest, so a mid-session re-resolve never snaps a
    /// failover-pinned stream back to its dead parent. `reason` as for `resolve_at` — the origin names a failed
    /// refresh or a refused target (`RETIRE_*`) so the adapter re-mints rather than re-serving its cache.
    pub async fn resolve_fresh(
        &self,
        source: &str,
        entry: &str,
        pl: Option<&str>,
        reason: Option<&str>,
    ) -> Result<(Arc<SourcePolicy>, String), ResolveErr> {
        let attempt = self.cursor_attempt(source, entry);
        self.resolve_at(source, entry, pl, attempt, reason).await
    }

    /// Like `resolve_fresh`, but ADVANCES the stream's failover cursor first — "the candidate you last gave
    /// me is not producing media, give me the next one". The ORIGIN ingest loop needs this because it never
    /// passes through the handler's `failover_walk`: it owns its own retry loop, so without an escalation
    /// path an origin-mode channel would re-resolve the same dead candidate every couple of seconds forever
    /// (and the source's own alternate upstreams — dlhd's independent player providers — would never be
    /// reached). The cursor is bumped even when the resolve then FAILS, so successive passes keep walking
    /// instead of retrying one dead candidate; Node's `failover_exhausted` (or the attempt cap) folds the
    /// cursor back to the channel itself so a stale pin can never strand the ingest.
    pub async fn resolve_advance(
        &self,
        source: &str,
        entry: &str,
        pl: Option<&str>,
        reason: Option<&str>,
    ) -> Result<(Arc<SourcePolicy>, String), ResolveErr> {
        let next = self.bump_cursor(source, entry);
        if next >= MAX_FAILOVER_ATTEMPTS {
            self.reset_cursor(source, entry);
            return self.resolve_at(source, entry, pl, 0, reason).await;
        }
        match self.resolve_at(source, entry, pl, next, reason).await {
            Err(ResolveErr::Exhausted) => {
                self.reset_cursor(source, entry);
                self.resolve_at(source, entry, pl, 0, reason).await
            }
            other => other,
        }
    }

    /// Advance a stream's failover cursor by one and return the new value, PERSISTING it even though no
    /// target has resolved at it yet (`resolve_at` only records the cursor on success, which would make a
    /// failing candidate repeat forever for a caller that drives its own retry loop). A record created here
    /// carries an already-stale target, and `expires > now` is strict, so it can never be served.
    pub fn bump_cursor(&self, source: &str, entry: &str) -> u32 {
        let now = Instant::now();
        let mut m = self.targets.lock_ok();
        match m.get_mut(&target_key(source, entry)) {
            Some(e) => {
                if now.duration_since(e.last_access) > FAILOVER_CURSOR_IDLE {
                    e.attempt = 0;
                }
                e.attempt = e.attempt.saturating_add(1);
                e.last_access = now;
                e.attempt
            }
            None => {
                m.insert(
                    target_key(source, entry),
                    TargetEntry {
                        target: String::new(),
                        expires: now, // stale on arrival — a cursor record, not a cached target
                        policy_key: source.to_string(),
                        attempt: 1,
                        last_access: now,
                        expires_at_ms: None,
                        rejected_at: None,
                        retire_hint: None,
                    },
                );
                1
            }
        }
    }

    /// Expire a cached resolved target so the next ENTRY request re-resolves (RSL: a dead target that failed
    /// to fetch must not be re-served from cache for the rest of its TTL). FOG: expires the TARGET only —
    /// the entry (and its failover cursor) survives, so the re-resolve resumes at the pinned candidate.
    pub fn invalidate_target(&self, source: &str, entry: &str) {
        let now = Instant::now();
        if let Some(e) = self.targets.lock_ok().get_mut(&target_key(source, entry)) {
            e.expires = now; // `expires > now` is strict — equal means stale
        }
    }

    /// REJ: expire a cached target the UPSTREAM just refused outright (401/403/410 on the ENTRY) — at most once
    /// per entry per `TARGET_TTL`. Returns whether it did.
    ///
    /// Those statuses are the shape of a signed URL that lapsed, or a token the upstream revoked: re-serving
    /// the same cached target for the rest of its TTL would earn the same refusal on every poll, where a fresh
    /// resolve may mint a working one. The once-per-window bound is what keeps that from turning into a resolve
    /// per poll when the upstream refuses FRESH targets too (an IP it has stopped serving): one extra resolve a
    /// minute, then the cache's own TTL again.
    ///
    /// It also leaves the entry a `RETIRE_TARGET_REJECTED` hint for that re-resolve. Expiring OUR cache is not
    /// enough on its own: an adapter that caches its own resolution (zlive keeps each channel's signed Location)
    /// would hand the refused link straight back, and the "re-resolve" would change nothing until its cache aged.
    pub fn invalidate_rejected_target(&self, source: &str, entry: &str) -> bool {
        let now = Instant::now();
        let mut m = self.targets.lock_ok();
        let Some(e) = m.get_mut(&target_key(source, entry)) else {
            return false;
        };
        if e.rejected_at.is_some_and(|t| now.duration_since(t) < TARGET_TTL) {
            return false;
        }
        e.rejected_at = Some(now);
        e.expires = now;
        e.retire_hint = Some(RETIRE_TARGET_REJECTED);
        true
    }

    /// FOG: the stream's current failover cursor (0 = the channel itself), after the idle reset.
    pub fn cursor_attempt(&self, source: &str, entry: &str) -> u32 {
        let now = Instant::now();
        let mut m = self.targets.lock_ok();
        match m.get_mut(&target_key(source, entry)) {
            Some(e) => {
                if now.duration_since(e.last_access) > FAILOVER_CURSOR_IDLE {
                    e.attempt = 0;
                }
                e.attempt
            }
            None => 0,
        }
    }

    /// FOG: reset the cursor to the parent (attempt 0) — a failover walk exhausted every candidate (or
    /// ended on a candidate that never actually served), so the NEXT request must start from the channel
    /// itself rather than replaying the dead tail. ALSO expires the cached target: after a reset it names
    /// a candidate the cursor no longer points at, and serving it for the rest of its TTL would mismatch.
    pub fn reset_cursor(&self, source: &str, entry: &str) {
        let now = Instant::now();
        if let Some(e) = self.targets.lock_ok().get_mut(&target_key(source, entry)) {
            e.attempt = 0;
            e.expires = now;
        }
    }

    /// FOG: refresh a stream's cursor-idle clock without an entry/hop request. The raw-TS producer holds
    /// ONE long-lived socket and never re-requests the entry or polls hops through the handler, so its
    /// healthy media-playlist refresh loop calls this each cycle — otherwise a pinned session would be
    /// treated as idle after FAILOVER_CURSOR_IDLE and snap back to the parent on the next re-resolve.
    pub fn touch_stream(&self, source: &str, entry: &str) {
        if let Some(e) = self.targets.lock_ok().get_mut(&target_key(source, entry)) {
            e.last_access = Instant::now();
        }
    }

    /// FOG: the policy for a HOP request. A hop belongs to whatever candidate its stream is pinned to — the
    /// target entry (looked up via the hop's propagated `&e=` entry) names the policy_key; a hop with no
    /// entry record falls back to the mount source's policy (today's behavior). Touches last_access so an
    /// actively-polling session (hops only — HLS players rarely re-request the ENTRY) keeps its cursor.
    pub fn hop_policy(&self, source: &str, entry: &str) -> Option<Arc<SourcePolicy>> {
        self.resolved_target_policy(source, entry).or_else(|| self.get(source))
    }

    /// The policy for a target this process has ACTUALLY resolved — `hop_policy`'s strict half, with no
    /// mount-source fallback.
    ///
    /// The distinction is a gate, not an optimisation. Falling back to the source's policy answers "is this
    /// a source we know", which is true of every source that ever served anything; requiring the target
    /// record answers "is this an entry we have resolved", which is what a caller needs before it may act on
    /// an entry string a client supplied. `origin::serve_playlist` uses it for exactly that: a lane poll may
    /// restart a dead ingest for a channel we were serving, and must not start one for an arbitrary URL.
    ///
    /// A record is written on every resolve and never swept (`expires` only governs REUSE), so this reads as
    /// "resolved at some point in this process" — which is what makes it a usable gate rather than a race
    /// against `TARGET_TTL`.
    pub fn resolved_target_policy(&self, source: &str, entry: &str) -> Option<Arc<SourcePolicy>> {
        if entry.is_empty() {
            return None;
        }
        let policy_key = {
            let mut m = self.targets.lock_ok();
            m.get_mut(&target_key(source, entry)).map(|e| {
                e.last_access = Instant::now();
                e.policy_key.clone()
            })
        };
        self.get(&policy_key?)
    }

    pub fn get(&self, source: &str) -> Option<Arc<SourcePolicy>> {
        self.cache.lock_ok().get(source).cloned()
    }

    fn get_or_create(&self, source: &str) -> Arc<SourcePolicy> {
        let mut m = self.cache.lock_ok();
        m.entry(source.to_string())
            .or_insert_with(|| Arc::new(SourcePolicy::empty()))
            .clone()
    }

    /// Call the Node resolve seam for an ENTRY url; update the SERVING adapter's policy (headers/relabel/
    /// allow + seed the master host into the allowlist); return the policy, its cache key, the target to
    /// fetch and that target's own expiry. FOG: `attempt` selects the failover candidate (0 = the channel
    /// itself); the policy is keyed by the grant's `policySource` — the serving candidate's adapter — NOT the
    /// URL mount source, so a cross-provider child's headers/relabel never overwrite the parent provider's
    /// shared policy.
    async fn resolve(
        &self,
        source: &str,
        entry_url: &str,
        pl: Option<&str>,
        attempt: u32,
        reason: Option<&str>,
    ) -> Result<Granted, ResolveErr> {
        let rid = crate::log::rid(source, entry_url);
        crate::log::trace("resolve", &rid, || {
            format!(
                "seam POST /resolve source={source} attempt={attempt} entry={}",
                crate::proxy::host_of(entry_url)
            )
        });
        // `reason` says why the data plane is resolving again, when it knows. On an ESCALATING resolve it lets the
        // adapter record WHY the upstream it was serving is being retired — without it every burn looks the same
        // in the player memory, and "this provider 404s" is a different operational fact from "this provider
        // serves undecodable video". `RETIRE_TARGET_REJECTED` / `RETIRE_REFRESH_FAILED` additionally ask for a
        // freshly resolved target rather than a cached one (see there).
        let body = serde_json::json!({
            "source": source, "url": entry_url, "pl": pl, "attempt": attempt, "reason": reason,
        });
        let resp = self
            .node_client
            .post(format!("{}/api/internal/resolve", self.node_url))
            .header("x-masq-secret", &self.secret)
            .json(&body)
            .send()
            .await
            .map_err(|e| ResolveErr::Other(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            let txt = resp.text().await.unwrap_or_default();
            return Err(seam_failure(status.as_u16(), &txt));
        }
        let grant: Grant = resp.json().await.map_err(|e| ResolveErr::Other(e.to_string()))?;
        let policy_key = grant.policy_source.clone().unwrap_or_else(|| source.to_string());
        let policy = self.get_or_create(&policy_key);
        *policy.headers.write_ok() = grant.upstream_headers.into_iter().collect();
        *policy.relabel_segment.write_ok() = grant.relabel_segment;
        policy.allow_private.store(grant.allow_private, Ordering::Relaxed);
        policy.player_selectable.store(grant.player_selectable, Ordering::Relaxed);
        // PXY-2: record the resolved client knobs so proxy.rs selects the matching upstream client per hop.
        policy.connect_timeout_ms.store(grant.proxy_config.connect_timeout_ms, Ordering::Relaxed);
        policy.max_redirects.store(grant.proxy_config.max_redirects, Ordering::Relaxed);
        // P3.1/RSL: the per-stream knobs (null → 0 → disabled). P3.2/DST: the output format.
        policy.read_timeout_ms.store(grant.proxy_config.read_timeout_ms.unwrap_or(0), Ordering::Relaxed);
        policy.buffer_size_kb.store(grant.proxy_config.buffer_size_kb.unwrap_or(0), Ordering::Relaxed);
        *policy.output_format.write_ok() = grant.proxy_config.output_format.clone();
        // SIR: the opt-in master-reorder flag (proxy.rs gates it to the /api/ext/v1 mount).
        policy.stream_inf_redux.store(grant.proxy_config.stream_inf_redux, Ordering::Relaxed);
        // FOG: the failover knobs (per-playlist resolved, per-source applied like every other knob).
        policy.failover_enabled.store(grant.proxy_config.failover_enabled, Ordering::Relaxed);
        policy
            .failover_on_definite_error
            .store(grant.proxy_config.failover_on_definite_error, Ordering::Relaxed);
        // S3/ORIGIN: the local-origin opt-in + its per-channel ring cap. Clamped to a sane floor here (not just
        // in Node's input gate) because the grant is the ONLY thing the data plane trusts — a 0 would make every
        // push evict itself, and the 3-segment floor would then be the only thing holding a window open.
        policy.origin_enabled.store(grant.proxy_config.origin_enabled, Ordering::Relaxed);
        policy
            .origin_ring_mb
            .store(grant.proxy_config.origin_ring_mb.max(1), Ordering::Relaxed);
        policy.splice_normalize.store(grant.proxy_config.splice_normalize, Ordering::Relaxed);
        // DSG: the adapter's "my segments arrive disguised" declaration. Stored, never merged — a re-resolve onto
        // a candidate that declares nothing must switch the pass-through unwrap back off.
        policy.segment_unwrap.store(grant.segment_unwrap, Ordering::Relaxed);
        // S3/CUE: the adapter's ad-URI signature. Normalized ONCE here (lowercased, blanks dropped) so the
        // ingest hot path is a plain `contains` — and REPLACED wholesale, never merged, so a re-resolve onto a
        // provider that declares none correctly clears the previous one.
        *policy.ad_uri_contains.write_ok() = grant
            .ad_signature
            .map(|s| {
                s.uri_contains
                    .into_iter()
                    .map(|p| p.trim().to_lowercase())
                    .filter(|p| !p.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        if let Ok(u) = Url::parse(&grant.target) {
            if let Some(h) = u.host_str() {
                policy.hosts.write_ok().insert(h.to_lowercase());
            }
        }
        crate::log::info("resolve", &rid, || {
            let failover = match &grant.failover {
                Some(f) => format!(" failover={}/{} (\"{}\")", f.attempt, f.total, f.candidate_name),
                None => String::new(),
            };
            // Named only when set, like `failover`: it is one adapter's declaration, not a knob every grant has.
            let unwrap = if grant.segment_unwrap { " segmentUnwrap" } else { "" };
            // …and the target's own lifetime, when the adapter knew it — the number both renewals run off.
            let expiry = match grant.expires_at_ms {
                Some(ms) => format!(" expiresIn={}s", ms.saturating_sub(epoch_ms()) / 1000),
                None => String::new(),
            };
            format!(
                "grant: target={} policy={policy_key} relabel={} outputFormat={} streamInfRedux={} connectTimeout={}ms maxRedirects={}{unwrap}{expiry}{failover}",
                crate::proxy::host_of(&grant.target),
                policy.relabel_segment.read_ok().as_deref().unwrap_or("passthrough"),
                policy.output_format.read_ok(),
                policy.stream_inf_redux.load(Ordering::Relaxed),
                policy.connect_timeout_ms.load(Ordering::Relaxed),
                policy.max_redirects.load(Ordering::Relaxed),
            )
        });
        Ok(Granted { policy, policy_key, target: grant.target, expires_at_ms: grant.expires_at_ms })
    }

    /// Enqueue a telemetry event for the batched flusher (best-effort — a full queue DROPS the event so the byte
    /// path never blocks or grows unbounded; a failure must never affect streaming).
    pub fn report(&self, event: serde_json::Value) {
        let _ = self.telemetry_tx.try_send(event);
    }

    /// EDGE-3 gate: may `token` play `source`? Cached per (token, source) for AUTH_TTL; on miss/expiry ask Node
    /// (POST /api/internal/authorize). Ok(username) on allow (username for telemetry attribution); Err((status,
    /// message)) on deny — the exact 401/403 + plain text the sidecar-mode streamGate would have returned.
    /// FAILS CLOSED (403) and does NOT cache when Node is unreachable, so a transient blip re-checks next request
    /// rather than blocking for the whole TTL — consistent with entry resolve, which also can't proceed sans Node.
    pub async fn authorize(
        &self,
        token: &str,
        source: &str,
        pl: Option<&str>,
    ) -> Result<Option<String>, (u16, String)> {
        // `pl` is part of the KEY, not just the request: it selects the playlist whose data-plane config Node
        // applies, and Node gates it against the user's playlist access. Keying on (token, source) alone would
        // let one authorized `pl` mint a cached ALLOW that a different `pl` then rides for the rest of the TTL.
        let key = (token.to_string(), source.to_string(), pl.unwrap_or_default().to_string());
        {
            let cache = self.auth_cache.lock_ok();
            if let Some(d) = cache.get(&key) {
                if d.expires > Instant::now() {
                    return if d.allowed {
                        Ok(d.username.clone())
                    } else {
                        Err((d.status, d.message.clone()))
                    };
                }
            }
        }
        let (allowed, status, message, username) = match self.authorize_remote(token, source, pl).await {
            Some(v) => v,
            None => return Err((403, "Forbidden: authorization unavailable".to_string())),
        };
        {
            let mut cache = self.auth_cache.lock_ok();
            if cache.len() >= AUTH_CACHE_MAX {
                let now = Instant::now();
                cache.retain(|_, d| d.expires > now);
            }
            if cache.len() < AUTH_CACHE_MAX {
                cache.insert(
                    key,
                    AuthDecision {
                        allowed,
                        status,
                        message: message.clone(),
                        username: username.clone(),
                        expires: Instant::now() + AUTH_TTL,
                    },
                );
            }
        }
        if allowed {
            Ok(username)
        } else {
            Err((status, message))
        }
    }

    /// Ask Node for a fresh gate decision. Returns (allowed, status, message, username) or None on any transport/
    /// parse failure (→ the caller fails closed). HTTP stays 2xx for both allow and deny — the decision is the body.
    async fn authorize_remote(
        &self,
        token: &str,
        source: &str,
        pl: Option<&str>,
    ) -> Option<(bool, u16, String, Option<String>)> {
        let body = serde_json::json!({ "token": token, "source": source, "pl": pl });
        let resp = self
            .node_client
            .post(format!("{}/api/internal/authorize", self.node_url))
            .header("x-masq-secret", &self.secret)
            .json(&body)
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let v: serde_json::Value = resp.json().await.ok()?;
        let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
        if ok {
            let username = v.get("username").and_then(|s| s.as_str()).map(|s| s.to_string());
            Some((true, 200, String::new(), username))
        } else {
            let status = v.get("status").and_then(|n| n.as_u64()).unwrap_or(403) as u16;
            let message = v
                .get("message")
                .and_then(|s| s.as_str())
                .unwrap_or("Forbidden: access denied")
                .to_string();
            Some((false, status, message, None))
        }
    }
}

/// S3/ORIGIN: the aggregate ring reporter. Every `iop` event describes ONE channel and only fires while that
/// channel polls, so nothing on the wire says what the process as a whole is holding — which is the number the
/// Dashboard's MEMORY PRESSURE tile needs and the one the postponed `LRU` budget must be sized against.
///
/// Stays SILENT while no ingest exists — an idle sidecar should not POST forever — but emits ONE trailing zero
/// on the transition to empty, without which the tile would freeze on the last non-zero figure after the final
/// channel closed. If that trailing frame is dropped by a full queue, Node's staleness rule is the backstop.
async fn ring_reporter(
    origins: Arc<Mutex<HashMap<String, Arc<crate::origin::Origin>>>>,
    tx: mpsc::Sender<serde_json::Value>,
) {
    let mut had_origins = false;
    loop {
        tokio::time::sleep(Duration::from_millis(RING_REPORT_MS)).await;
        let f = crate::origin::ring_footprint(&origins);
        if f.origins == 0 && !had_origins {
            continue;
        }
        had_origins = f.origins > 0;
        // Best-effort, exactly like AppState::report: a full queue drops the frame rather than stalling.
        let _ = tx.try_send(serde_json::json!({
            "kind": "ring",
            "origins": f.origins,
            "subscribed": f.subscribed,
            "ringBytes": f.bytes,
            "ringCapBytes": f.cap_bytes,
        }));
    }
}

/// The single telemetry flusher: block for the first queued event, coalesce whatever else is immediately
/// available (up to TELEMETRY_MAX_BATCH or a TELEMETRY_FLUSH_MS debounce), then POST them as one
/// `{ events: [...] }` batch. Runs until every AppState (hence every Sender) is dropped — i.e. process exit.
async fn telemetry_flusher(
    mut rx: mpsc::Receiver<serde_json::Value>,
    client: reqwest::Client,
    url: String,
    secret: String,
    dns: Arc<crate::dns::UpstreamDns>,
) {
    loop {
        let first = match rx.recv().await {
            Some(ev) => ev,
            None => break, // all senders dropped → shutting down
        };
        let mut batch = vec![first];
        let deadline = tokio::time::sleep(Duration::from_millis(TELEMETRY_FLUSH_MS));
        tokio::pin!(deadline);
        while batch.len() < TELEMETRY_MAX_BATCH {
            tokio::select! {
                _ = &mut deadline => break,
                next = rx.recv() => match next {
                    Some(ev) => batch.push(ev),
                    None => break, // channel closed mid-coalesce — flush what we have, then the outer recv exits
                },
            }
        }
        let body = serde_json::json!({ "events": batch });
        // The telemetry response echoes the current { logLevel, nameservers } too — apply it so a Settings change
        // reaches the sidecar even when only telemetry (not logs) is flowing (e.g. an active stream at level 1).
        if let Ok(resp) = client.post(url.as_str()).header("x-masq-secret", &secret).json(&body).send().await {
            crate::log::apply_flush_echo(resp, &dns).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The grant wire contract for S3/CUE. Node's `ResolveGrant.adSignature` is `{uriContains}|null`; this
    /// pins BOTH directions of the seam Rust owns — the field name and the null/absent degradation.
    #[test]
    fn grant_carries_the_adapter_ad_signature() {
        let json = r#"{
            "target": "https://cdn.example.com/master.m3u8",
            "upstreamHeaders": {},
            "relabelSegment": null,
            "allowPrivate": false,
            "isEntry": true,
            "proxyConfig": {},
            "adSignature": { "uriContains": ["0_ad/creative/"] },
            "policySource": "pluto",
            "failover": null
        }"#;
        let g: Grant = serde_json::from_str(json).expect("a pluto grant deserializes");
        let sig = g.ad_signature.expect("adSignature rides the grant");
        assert_eq!(sig.uri_contains, vec!["0_ad/creative/".to_string()]);
    }

    /// A source that declares none, and a PRE-CUE Node that omits the key entirely, must both degrade to "no
    /// URI ad detection" rather than to a parse error — the same posture every other knob takes.
    #[test]
    fn a_null_or_absent_ad_signature_degrades_to_none() {
        let base = r#"{"target":"https://x/","upstreamHeaders":{},"relabelSegment":null,
                       "allowPrivate":false,"isEntry":true,"proxyConfig":{}"#;
        let explicit_null: Grant = serde_json::from_str(&format!("{base},\"adSignature\":null}}")).unwrap();
        assert!(explicit_null.ad_signature.is_none(), "every non-pluto source sends null");
        let absent: Grant = serde_json::from_str(&format!("{base}}}")).unwrap();
        assert!(absent.ad_signature.is_none(), "a pre-CUE Node omits the key");
    }

    /// The DSG wire contract: Node's `ResolveGrant.segmentUnwrap` is a plain boolean on BOTH grant builders, and
    /// a Node that predates it — or any adapter that never declared it — must keep the byte-exact pass-through.
    #[test]
    fn grant_carries_the_adapter_segment_unwrap_flag_and_defaults_it_off() {
        let base = r#"{"target":"https://x/","upstreamHeaders":{},"relabelSegment":"video/mp2t",
                       "allowPrivate":false,"isEntry":true,"proxyConfig":{}"#;
        let flagged: Grant = serde_json::from_str(&format!("{base},\"segmentUnwrap\":true}}")).unwrap();
        assert!(flagged.segment_unwrap, "the declaring adapter's grant turns it on");
        let off: Grant = serde_json::from_str(&format!("{base},\"segmentUnwrap\":false}}")).unwrap();
        assert!(!off.segment_unwrap);
        let absent: Grant = serde_json::from_str(&format!("{base}}}")).unwrap();
        assert!(!absent.segment_unwrap, "an older Node omits the key: nothing is unwrapped");
        assert!(!SourcePolicy::empty().segment_unwrap.load(Ordering::Relaxed), "a cold policy unwraps nothing");
    }

    /// The EXP wire contract: Node sends `expiresAtMs: number | null` on BOTH grant builders. Any value it could
    /// send must parse — a grant that fails to parse fails the whole resolve, i.e. a dead stream — and anything
    /// that is not a usable epoch degrades to "no expiry known", which is exactly what every grant was before.
    #[test]
    fn grant_carries_the_target_expiry_and_no_shape_of_it_can_break_the_grant() {
        let base = r#"{"target":"https://x/","upstreamHeaders":{},"relabelSegment":null,
                       "allowPrivate":false,"isEntry":true,"proxyConfig":{}"#;
        let exp = |tail: &str| serde_json::from_str::<Grant>(&format!("{base}{tail}}}")).expect("the grant parses").expires_at_ms;
        assert_eq!(exp(r#","expiresAtMs":1786009000000"#), Some(1_786_009_000_000), "the integer Node's floor produces");
        assert_eq!(exp(r#","expiresAtMs":1786009000000.75"#), Some(1_786_009_000_000), "a fraction is truncated, not fatal");
        assert_eq!(exp(r#","expiresAtMs":null"#), None, "an adapter that knows no expiry");
        assert_eq!(exp(""), None, "an older Node omits the key");
        assert_eq!(exp(r#","expiresAtMs":-5"#), None);
        assert_eq!(exp(r#","expiresAtMs":0"#), None);
        assert_eq!(exp(r#","expiresAtMs":"soon""#), None, "a non-number is ignored, not fatal");
    }

    /// A target is reused for `TARGET_TTL` as before — or for less when it says it lapses sooner, stopping
    /// `TARGET_EXPIRY_MARGIN` short of that. Never below the floor, or a nearly-expired target would be
    /// re-resolved on every poll.
    #[test]
    fn a_target_is_reused_no_longer_than_its_own_expiry_allows() {
        const NOW: u64 = 1_786_000_000_000;
        assert_eq!(target_ttl(None, NOW), TARGET_TTL, "no stated expiry: the fixed cap, as before");
        assert_eq!(target_ttl(Some(NOW + 9_000_000), NOW), TARGET_TTL, "a zlive token has hours left: the cap wins");
        assert_eq!(target_ttl(Some(NOW + 90_000), NOW), Duration::from_secs(30), "90 s left: reuse stops 60 s short");
        assert_eq!(target_ttl(Some(NOW + 61_000), NOW), MIN_TARGET_TTL, "inside the margin: the floor");
        assert_eq!(target_ttl(Some(NOW - 1_000), NOW), MIN_TARGET_TTL, "already lapsed: still the floor, never zero");
    }

    /// CAP: the seam's refusal is classified as its own thing — on the 429 status or on the error CODE — and
    /// carries Node's message, which the relay hands the viewer. The existing classes are unchanged around it.
    #[test]
    fn the_seam_s_refusal_is_told_apart_from_exhaustion_and_failure() {
        let refusal = r#"{"error":"source_stream_cap","message":"ZLive already has 2 of 2 allowed concurrent stream(s) live — stop one before starting another"}"#;
        match seam_failure(429, refusal) {
            ResolveErr::Refused(m) => assert!(m.starts_with("ZLive already has 2 of 2"), "Node's own words: {m}"),
            other => panic!("a 429 is a refusal, got: {other}"),
        }
        // The error code alone is enough — a proxy in front must not turn a refusal into a walk.
        assert!(matches!(seam_failure(502, refusal), ResolveErr::Refused(_)));
        // A 429 with no usable body still refuses, in a sentence of our own.
        match seam_failure(429, "") {
            ResolveErr::Refused(m) => assert_eq!(m, DEFAULT_REFUSAL),
            other => panic!("got: {other}"),
        }
        // A MENTION of the code inside some other failure's text is not the code.
        assert!(matches!(
            seam_failure(502, r#"{"error":"resolve_failed","message":"upstream said source_stream_cap"}"#),
            ResolveErr::Other(_)
        ));
        assert!(matches!(seam_failure(410, r#"{"error":"failover_exhausted"}"#), ResolveErr::Exhausted));
        assert!(matches!(seam_failure(502, r#"{"error":"resolve_failed"}"#), ResolveErr::Other(_)));
        // The cap refusal a backup CAN route around (a grouped parent, a capped child — resolveSeam.ts capRefusal)
        // is Node's walkable form: the same sentence, but a 502 whose code is not `source_stream_cap`. It must
        // stay a plain failure, or the walk would end on a cap that only binds this one candidate.
        let walkable = r#"{"error":"resolve_failed: ZLive stream cap reached","message":"ZLive already has 2 of 2 allowed concurrent stream(s) live — stop one before starting another"}"#;
        assert!(matches!(seam_failure(502, walkable), ResolveErr::Other(_)));
    }

    /// REJ: the rejected-target refresh expires a target at most once per `TARGET_TTL` — and the latch belongs
    /// to the ENTRY, surviving the re-resolve it triggers. Were it re-armed by every resolve, an upstream that
    /// refused each fresh target too would cost a resolve per poll.
    #[tokio::test]
    async fn a_rejected_target_is_dropped_at_most_once_per_window_across_re_resolves() {
        let s = AppState::new("http://127.0.0.1:9".to_string(), String::new());
        assert!(!s.invalidate_rejected_target("zl", "zl://abc"), "nothing cached, nothing to drop");

        s.record_target("zl", "zl://abc", "https://a/1.m3u8", "zl".into(), 0, None);
        assert!(s.invalidate_rejected_target("zl", "zl://abc"), "the first rejection drops the target");
        assert!(s.target_expired("zl", "zl://abc"));

        // The re-resolve that follows writes a fresh record — the latch rides across it.
        s.record_target("zl", "zl://abc", "https://a/2.m3u8", "zl".into(), 0, None);
        assert!(!s.invalidate_rejected_target("zl", "zl://abc"), "a second rejection inside the window is absorbed");
        assert!(!s.target_expired("zl", "zl://abc"), "…and the fresh target stays cached");

        // Once the window has passed, a rejection is news again.
        if let Some(e) = s.targets.lock_ok().get_mut(&target_key("zl", "zl://abc")) {
            e.rejected_at = Some(Instant::now() - TARGET_TTL - Duration::from_secs(1));
        }
        assert!(s.invalidate_rejected_target("zl", "zl://abc"));
    }

    /// REJ: a rejection leaves its reason for exactly the NEXT resolve of the entry — whichever caller makes it —
    /// so the adapter re-mints instead of handing the refused target back from its own cache. The one after goes
    /// out plain, and a caller's own reason is sent as given.
    #[tokio::test]
    async fn a_rejection_leaves_its_reason_for_exactly_the_next_resolve() {
        use crate::testkit::{Mock, Seam};
        let mock = Mock::start(Seam::grant("/pl/a.m3u8", false)).await;
        let s = mock.state();
        assert!(s.resolve_entry("zl", "zl://abc", None).await.is_ok(), "the stand-in grants");
        assert!(s.invalidate_rejected_target("zl", "zl://abc"));
        assert!(s.resolve_entry("zl", "zl://abc", None).await.is_ok(), "the next poll re-resolves the dropped target");
        assert!(s.resolve_at("zl", "zl://abc", None, 0, None).await.is_ok());
        assert!(s.resolve_fresh("zl", "zl://abc", None, Some(RETIRE_REFRESH_FAILED)).await.is_ok());
        let reasons: Vec<Option<String>> = mock.calls().into_iter().map(|c| c.reason).collect();
        assert_eq!(
            reasons,
            vec![None, Some(RETIRE_TARGET_REJECTED.to_string()), None, Some(RETIRE_REFRESH_FAILED.to_string())],
            "the hint rides the one resolve that replaces the refused target, and no other"
        );
    }

    /// `target_record` answers only for the target it is asked about: the record is shared by every resolve of
    /// the channel, and another candidate's attempt or expiry must never be read as ours.
    #[tokio::test]
    async fn a_target_record_speaks_only_for_its_own_target() {
        let s = AppState::new("http://127.0.0.1:9".to_string(), String::new());
        s.record_target("zl", "zl://abc", "https://a/1.m3u8", "zl".into(), 2, Some(1_786_009_000_000));
        assert_eq!(
            s.target_record("zl", "zl://abc", "https://a/1.m3u8"),
            Some(TargetMeta { attempt: 2, expires_at_ms: Some(1_786_009_000_000) })
        );
        assert_eq!(s.target_record("zl", "zl://abc", "https://b/other.m3u8"), None, "overwritten by another resolve");
        assert_eq!(s.target_record("zl", "zl://other", "https://a/1.m3u8"), None);
    }

    /// DNS SCOPE: every UPSTREAM client — the default one (the probe's) and each `client_for` build — resolves
    /// through the shared Settings resolver, and the Node client never does: a nameserver the operator can get
    /// wrong must not be able to cut the engine off from its control plane.
    #[tokio::test]
    async fn upstream_clients_resolve_through_the_settings_resolver_and_the_node_client_never_does() {
        use crate::testkit::{Mock, Seam};
        let web = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let web_port = web.local_addr().unwrap().port();
        tokio::spawn(async move {
            let app = axum::Router::new().route("/", axum::routing::get(|| async { "upstream" }));
            let _ = axum::serve(web, app).await;
        });
        // Only this resolver can place the name, so a 200 proves the client asked it.
        let (dns, asked) = crate::dns::UpstreamDns::over_fake_os(&[("upstream.example.test", "127.0.0.1")]);
        let mock = Mock::start(Seam::Reply(502, String::new())).await;
        // Node reached by NAME, so the Node client has to resolve something too.
        let s = AppState::with_dns(format!("http://localhost:{}", mock.port()), String::new(), Arc::new(dns));
        let url = format!("http://upstream.example.test:{web_port}/");
        let asked_now = || asked.load(Ordering::SeqCst);

        let default = s.client.get(&url).send().await.expect("the default client reaches the upstream");
        assert_eq!(default.status().as_u16(), 200);
        assert_eq!(asked_now(), 1, "…through the shared resolver");
        let knobbed = s.client_for(2_500, 3).get(&url).send().await.expect("a client_for client reaches it too");
        assert_eq!(knobbed.status().as_u16(), 200);
        assert_eq!(asked_now(), 2, "…through the same resolver");

        assert!(s.resolve_at("zl", "zl://abc", None, 0, None).await.is_err(), "the scripted seam refuses");
        assert_eq!(mock.resolves(), 1, "the Node client reached the seam by name…");
        assert_eq!(asked_now(), 2, "…without ever asking the upstream resolver");
    }

    /// DNS: an operator's nameserver change travels Node's flush echo into the RUNNING engine — no restart, and
    /// the resolver the upstream clients were built with is the one retargeted. The telemetry flusher alone must
    /// carry it: at level 1 an active stream ships telemetry and no logs.
    #[tokio::test]
    async fn a_nameserver_change_reaches_the_running_engine_through_the_flush_echo() {
        use crate::testkit::{until, Mock, Seam};
        let mock = Mock::start(Seam::Reply(502, String::new())).await;
        let s = mock.state();
        let within = Duration::from_secs(5);
        let servers = |list: &[&str]| list.iter().map(|ip| ip.parse().unwrap()).collect::<Vec<std::net::IpAddr>>();

        mock.script(|sc| sc.echo = serde_json::json!({ "nameservers": "192.0.2.53,192.0.2.54" }));
        s.report(serde_json::json!({ "kind": "probe" }));
        until(within, "the echoed servers to be in force", || s.dns.servers() == servers(&["192.0.2.53", "192.0.2.54"])).await;

        // An echo that says nothing — an older Node — leaves them be.
        mock.script(|sc| sc.echo = serde_json::json!({}));
        s.report(serde_json::json!({ "kind": "probe" }));
        tokio::time::sleep(Duration::from_millis(3 * TELEMETRY_FLUSH_MS)).await;
        assert_eq!(s.dns.servers(), servers(&["192.0.2.53", "192.0.2.54"]));

        // null is Node's word for "the OS resolver".
        mock.script(|sc| sc.echo = serde_json::json!({ "nameservers": null }));
        s.report(serde_json::json!({ "kind": "probe" }));
        until(within, "the OS resolver to be back in charge", || s.dns.servers().is_empty()).await;
    }

    impl AppState {
        /// Test view: is this entry's cached target past its reuse window?
        fn target_expired(&self, source: &str, entry: &str) -> bool {
            self.targets.lock_ok().get(&target_key(source, entry)).is_none_or(|e| e.expires <= Instant::now())
        }
    }
}
