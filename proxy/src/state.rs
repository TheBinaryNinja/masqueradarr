//! Shared state: the HTTP client, the Node control-plane endpoint, the shared secret, and the per-source
//! POLICY CACHE. A `SourcePolicy` holds what the sidecar replays for a source's streams — the upstream
//! headers, the segment-relabel rule, and a GROWING allowlist of hosts. The allowlist is observational: it
//! is seeded with the resolved master's host and grown with every host the sidecar rewrites out of a
//! manifest (mirroring each adapter's dynamic-allow), so a client can only reach hosts that appeared in a
//! trusted upstream manifest — never an arbitrary/injected host (and private IPs are rejected outright).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

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
/// entries. (P3 could honor a per-grant `expiresAt` instead of a fixed cap.)
const TARGET_TTL: Duration = Duration::from_secs(60);

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
    /// The DEFAULT client — used for the loopback Node calls (resolve/authorize/telemetry) and as a build fallback.
    pub client: reqwest::Client,
    /// EDGE-3: the reverse-proxy client for the non-stream leg (SPA / /api/* → Node). Distinct from `client`
    /// because a TRANSPARENT proxy must NOT auto-follow redirects (relay Node's 3xx verbatim) or auto-decompress
    /// (gzip off — else a stale Content-Length survives a stripped Content-Encoding). Only used on the edge path.
    pub proxy_client: reqwest::Client,
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
}

/// The target-cache key for a stream: (mount source, entry url) — NUL-joined like the log rid.
pub(crate) fn target_key(source: &str, entry: &str) -> String {
    format!("{source}\u{0}{entry}")
}

/// A resolve-seam failure. `Exhausted` is Node's DISTINCT 410 `failover_exhausted` reply — the requested
/// entry has no (more) failover candidates — which terminates a failover walk. Everything else (a dead
/// candidate's resolve_failed 502, Node unreachable, a malformed grant, …) is `Other`: a walk advances
/// past it, non-walk callers just log it.
pub enum ResolveErr {
    Exhausted,
    Other(String),
}

impl std::fmt::Display for ResolveErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveErr::Exhausted => write!(f, "failover candidates exhausted"),
            ResolveErr::Other(e) => write!(f, "{e}"),
        }
    }
}

pub struct SourcePolicy {
    /// Upstream headers replayed on every hop of the source's streams (per-stream constant; last resolve wins).
    pub headers: RwLock<Vec<(String, String)>>,
    /// Force this content-type on non-manifest (segment) responses; None = pass upstream through.
    pub relabel_segment: RwLock<Option<String>>,
    /// Permit private/loopback upstream IPs (LAN sources); false for public-CDN sources.
    pub allow_private: AtomicBool,
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
}

impl SourcePolicy {
    fn empty() -> Self {
        Self {
            headers: RwLock::new(Vec::new()),
            relabel_segment: RwLock::new(None),
            allow_private: AtomicBool::new(false),
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
        // NO overall request timeout — segment streams are long-lived and a total timeout would truncate
        // them. A connect timeout only bounds the handshake. Redirects are followed (up to 10), and the
        // final URL (Response::url()) is used to rebase relative manifest URIs.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("failed to build reqwest client");
        // EDGE-3 reverse-proxy client: no redirect-follow + no auto-gzip so Node's responses relay byte-exact.
        let proxy_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .gzip(false)
            .build()
            .unwrap_or_else(|_| client.clone());
        // TEL: the telemetry queue + its single background flusher (spawned once; new() runs inside the tokio
        // runtime from #[tokio::main]). Best-effort — the byte path never waits on telemetry.
        let (telemetry_tx, telemetry_rx) = mpsc::channel::<serde_json::Value>(TELEMETRY_QUEUE);
        tokio::spawn(telemetry_flusher(
            telemetry_rx,
            client.clone(),
            format!("{node_url}/api/internal/telemetry"),
            secret.clone(),
        ));
        // S3/ORIGIN: the live-ingest registry, built HERE rather than inline in `Self` so the ring reporter
        // can hold its own handle — it needs the map, not the whole AppState.
        let origins: Arc<Mutex<HashMap<String, Arc<crate::origin::Origin>>>> = Arc::new(Mutex::new(HashMap::new()));
        tokio::spawn(ring_reporter(origins.clone(), telemetry_tx.clone()));
        // LOG: install the global structured-logging sink + its own batched flusher (seeds the level from
        // MASQ_LOG_LEVEL, ships to /api/internal/log, learns live level changes from the flush echo). A
        // cross-cutting global (like Node's `logger`) so every module logs without threading state.
        crate::log::init(client.clone(), format!("{node_url}/api/internal/log"), secret.clone());
        Self {
            client,
            proxy_client,
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
        self.resolve_at(source, entry, pl, attempt).await
    }

    /// FOG: force a FRESH resolve of a SPECIFIC candidate (bypass the target cache) and re-cache the
    /// result — pinning the stream's cursor to that attempt. attempt 0 = the channel itself (Node re-runs
    /// `resolveStream`, which drives dlhd/dami `reprobeMirror()` — the pre-failover "mirror failover");
    /// attempt N >= 1 = the channel's Nth ordered failover child, resolved via the child's own adapter.
    pub async fn resolve_at(
        &self,
        source: &str,
        entry: &str,
        pl: Option<&str>,
        attempt: u32,
    ) -> Result<(Arc<SourcePolicy>, String), ResolveErr> {
        let (policy, policy_key, target) = self.resolve(source, entry, pl, attempt).await?;
        let now = Instant::now();
        self.targets.lock_ok().insert(
            target_key(source, entry),
            TargetEntry {
                target: target.clone(),
                expires: now + TARGET_TTL,
                policy_key,
                attempt,
                last_access: now,
            },
        );
        Ok((policy, target))
    }

    /// RSL failover: a fresh resolve at the stream's CURRENT pinned candidate (see resolve_at). Used by the
    /// hop-failure async refresh + the tsmux producer, so a mid-session re-resolve never snaps a
    /// failover-pinned stream back to its dead parent.
    pub async fn resolve_fresh(
        &self,
        source: &str,
        entry: &str,
        pl: Option<&str>,
    ) -> Result<(Arc<SourcePolicy>, String), ResolveErr> {
        let attempt = self.cursor_attempt(source, entry);
        self.resolve_at(source, entry, pl, attempt).await
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
    ) -> Result<(Arc<SourcePolicy>, String), ResolveErr> {
        let next = self.bump_cursor(source, entry);
        if next >= MAX_FAILOVER_ATTEMPTS {
            self.reset_cursor(source, entry);
            return self.resolve_at(source, entry, pl, 0).await;
        }
        match self.resolve_at(source, entry, pl, next).await {
            Err(ResolveErr::Exhausted) => {
                self.reset_cursor(source, entry);
                self.resolve_at(source, entry, pl, 0).await
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
        if !entry.is_empty() {
            let policy_key = {
                let mut m = self.targets.lock_ok();
                m.get_mut(&target_key(source, entry)).map(|e| {
                    e.last_access = Instant::now();
                    e.policy_key.clone()
                })
            };
            if let Some(pk) = policy_key {
                if let Some(p) = self.get(&pk) {
                    return Some(p);
                }
            }
        }
        self.get(source)
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
    /// allow + seed the master host into the allowlist); return (policy, its cache key, the target to
    /// fetch). FOG: `attempt` selects the failover candidate (0 = the channel itself); the policy is keyed
    /// by the grant's `policySource` — the serving candidate's adapter — NOT the URL mount source, so a
    /// cross-provider child's headers/relabel never overwrite the parent provider's shared policy.
    async fn resolve(
        &self,
        source: &str,
        entry_url: &str,
        pl: Option<&str>,
        attempt: u32,
    ) -> Result<(Arc<SourcePolicy>, String, String), ResolveErr> {
        let rid = crate::log::rid(source, entry_url);
        crate::log::trace("resolve", &rid, || {
            format!(
                "seam POST /resolve source={source} attempt={attempt} entry={}",
                crate::proxy::host_of(entry_url)
            )
        });
        let body =
            serde_json::json!({ "source": source, "url": entry_url, "pl": pl, "attempt": attempt });
        let resp = self
            .client
            .post(format!("{}/api/internal/resolve", self.node_url))
            .header("x-masq-secret", &self.secret)
            .json(&body)
            .send()
            .await
            .map_err(|e| ResolveErr::Other(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            let txt = resp.text().await.unwrap_or_default();
            // Node's DISTINCT exhausted reply (410 failover_exhausted) — the walk's terminator. Matched on
            // both signals so neither a proxy in front nor a body tweak can turn it into an endless walk.
            if status.as_u16() == 410 || txt.contains("failover_exhausted") {
                return Err(ResolveErr::Exhausted);
            }
            return Err(ResolveErr::Other(format!("resolve {}: {}", status.as_u16(), txt)));
        }
        let grant: Grant = resp.json().await.map_err(|e| ResolveErr::Other(e.to_string()))?;
        let policy_key = grant.policy_source.clone().unwrap_or_else(|| source.to_string());
        let policy = self.get_or_create(&policy_key);
        *policy.headers.write_ok() = grant.upstream_headers.into_iter().collect();
        *policy.relabel_segment.write_ok() = grant.relabel_segment;
        policy.allow_private.store(grant.allow_private, Ordering::Relaxed);
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
            format!(
                "grant: target={} policy={policy_key} relabel={} outputFormat={} streamInfRedux={} connectTimeout={}ms maxRedirects={}{failover}",
                crate::proxy::host_of(&grant.target),
                policy.relabel_segment.read_ok().as_deref().unwrap_or("passthrough"),
                policy.output_format.read_ok(),
                policy.stream_inf_redux.load(Ordering::Relaxed),
                policy.connect_timeout_ms.load(Ordering::Relaxed),
                policy.max_redirects.load(Ordering::Relaxed),
            )
        });
        Ok((policy, policy_key, grant.target))
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
            .client
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
        // The telemetry response echoes the current { logLevel } too — apply it so a level change reaches the
        // sidecar even when only telemetry (not logs) is flowing (e.g. an active stream at level 1).
        if let Ok(resp) = client.post(url.as_str()).header("x-masq-secret", &secret).json(&body).send().await {
            crate::log::apply_level_response(resp).await;
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
}
