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

use serde::Deserialize;
use tokio::sync::mpsc;
use url::Url;

// TEL batching (P3.1). Telemetry events are queued and flushed as one batched `{events:[...]}` POST rather than
// one POST per event, so a burst (a manifest poll + its media + N segment bytes) coalesces. Best-effort: a full
// queue drops (never block/grow the byte path); a short debounce coalesces without latency the stream can feel.
const TELEMETRY_QUEUE: usize = 4096;
const TELEMETRY_MAX_BATCH: usize = 256;
const TELEMETRY_FLUSH_MS: u64 = 250;

/// How long a resolved ENTRY target is reused before re-resolving. This collapses per-poll resolves for a
/// media-playlist entry (so a few-second player poll doesn't re-mint a dulo playbackUrl / re-scrape dlhd
/// every time), while staying well inside typical multi-minute token expiries. A master entry is fetched
/// once (the player then polls the variant HOP, which never resolves), so this mainly guards media-playlist
/// entries. (P3 could honor a per-grant `expiresAt` instead of a fixed cap.)
const TARGET_TTL: Duration = Duration::from_secs(60);

// EDGE-3 gate cache. When Rust is the public edge, the stream-token gate lives in Node (POST
// /api/internal/authorize) but Rust must gate EVERY request — including warm hops that never re-hit the
// resolve seam. So each (token, source) decision is cached for AUTH_TTL: warm requests are an in-memory
// check (no Node round-trip), and revocation of streamTokenEnabled/allowedPlaylists takes effect within the
// TTL. AUTH_CACHE_MAX bounds memory against random-token spam (prune-expired-then-skip on overflow).
const AUTH_TTL: Duration = Duration::from_secs(30);
const AUTH_CACHE_MAX: usize = 4096;

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
    targets: Arc<Mutex<HashMap<String, (String, Instant)>>>,
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
    /// EDGE-3: the per-(token, source) stream-gate decision cache (see AUTH_TTL). Only consulted on the public
    /// edge path (edge.rs); the loopback sidecar path is gated by Node's Express streamGate as before.
    auth_cache: Arc<Mutex<HashMap<(String, String), AuthDecision>>>,
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
    // upstreamHeaders, so this struct declares only the two CLIENT-level knobs Rust applies in P2; serde
    // silently ignores the deferred fields (readTimeoutMs/bufferSizeKb/segmentCacheTtlSec/outputFormat).
    #[serde(rename = "proxyConfig", default)]
    pub proxy_config: ProxyConfigWire,
    // (Node's grant also carries `isEntry`; the sidecar decides entry/hop from the path, so serde ignores it.)
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

impl Default for ProxyConfigWire {
    fn default() -> Self {
        Self {
            connect_timeout_ms: default_connect_ms(),
            max_redirects: default_max_redirects(),
            read_timeout_ms: None,
            buffer_size_kb: None,
            output_format: default_output_format(),
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
        }
    }

    /// DST: mint a unique-per-process continuous-TS stream id (monotonic; Node maps it → a socket connId).
    pub fn next_stream_id(&self) -> String {
        format!("ts{}", self.stream_seq.fetch_add(1, Ordering::Relaxed))
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
            let m = self.upstream_clients.lock().unwrap();
            if let Some(c) = m.get(&key) {
                return c.clone();
            }
        }
        let built = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(max_redirects as usize))
            .connect_timeout(Duration::from_millis(connect_ms))
            .build()
            .unwrap_or_else(|_| self.client.clone());
        let mut m = self.upstream_clients.lock().unwrap();
        m.entry(key).or_insert_with(|| built).clone()
    }

    /// Resolve an ENTRY to (policy, target), reusing a recently-resolved target within TARGET_TTL so a
    /// re-polled media-playlist entry doesn't re-hit the provider each poll. Falls through to a live resolve
    /// when the cache is cold/stale or the source policy has been evicted.
    pub async fn resolve_entry(
        &self,
        source: &str,
        entry: &str,
        pl: Option<&str>,
    ) -> Result<(Arc<SourcePolicy>, String), String> {
        let key = format!("{source}\u{0}{entry}");
        let cached = { self.targets.lock().unwrap().get(&key).cloned() };
        if let Some((target, exp)) = cached {
            if exp > Instant::now() {
                if let Some(policy) = self.get(source) {
                    return Ok((policy, target));
                }
            }
        }
        let (policy, target) = self.resolve(source, entry, pl).await?;
        self.targets
            .lock()
            .unwrap()
            .insert(key, (target.clone(), Instant::now() + TARGET_TTL));
        Ok((policy, target))
    }

    /// RSL failover: force a FRESH resolve (bypass the target cache) and re-cache the result. Used when a
    /// cached/resolved target's fetch fails — Node re-runs `resolveStream`, which drives dlhd/dami
    /// `reprobeMirror()` (mirror failover), so a mirror that died mid-window self-heals onto a live base.
    pub async fn resolve_fresh(
        &self,
        source: &str,
        entry: &str,
        pl: Option<&str>,
    ) -> Result<(Arc<SourcePolicy>, String), String> {
        let (policy, target) = self.resolve(source, entry, pl).await?;
        let key = format!("{source}\u{0}{entry}");
        self.targets
            .lock()
            .unwrap()
            .insert(key, (target.clone(), Instant::now() + TARGET_TTL));
        Ok((policy, target))
    }

    /// Drop a cached resolved target so the next ENTRY request re-resolves (RSL: a dead target that failed to
    /// fetch must not be re-served from cache for the rest of its TTL).
    pub fn invalidate_target(&self, source: &str, entry: &str) {
        let key = format!("{source}\u{0}{entry}");
        self.targets.lock().unwrap().remove(&key);
    }

    pub fn get(&self, source: &str) -> Option<Arc<SourcePolicy>> {
        self.cache.lock().unwrap().get(source).cloned()
    }

    fn get_or_create(&self, source: &str) -> Arc<SourcePolicy> {
        let mut m = self.cache.lock().unwrap();
        m.entry(source.to_string())
            .or_insert_with(|| Arc::new(SourcePolicy::empty()))
            .clone()
    }

    /// Call the Node resolve seam for an ENTRY url; update the source's policy (headers/relabel/allow +
    /// seed the master host into the allowlist); return the policy and the resolved target to fetch.
    pub async fn resolve(
        &self,
        source: &str,
        entry_url: &str,
        pl: Option<&str>,
    ) -> Result<(Arc<SourcePolicy>, String), String> {
        let body = serde_json::json!({ "source": source, "url": entry_url, "pl": pl });
        let resp = self
            .client
            .post(format!("{}/api/internal/resolve", self.node_url))
            .header("x-masq-secret", &self.secret)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            let txt = resp.text().await.unwrap_or_default();
            return Err(format!("resolve {}: {}", status.as_u16(), txt));
        }
        let grant: Grant = resp.json().await.map_err(|e| e.to_string())?;
        let policy = self.get_or_create(source);
        *policy.headers.write().unwrap() = grant.upstream_headers.into_iter().collect();
        *policy.relabel_segment.write().unwrap() = grant.relabel_segment;
        policy.allow_private.store(grant.allow_private, Ordering::Relaxed);
        // PXY-2: record the resolved client knobs so proxy.rs selects the matching upstream client per hop.
        policy.connect_timeout_ms.store(grant.proxy_config.connect_timeout_ms, Ordering::Relaxed);
        policy.max_redirects.store(grant.proxy_config.max_redirects, Ordering::Relaxed);
        // P3.1/RSL: the per-stream knobs (null → 0 → disabled). P3.2/DST: the output format.
        policy.read_timeout_ms.store(grant.proxy_config.read_timeout_ms.unwrap_or(0), Ordering::Relaxed);
        policy.buffer_size_kb.store(grant.proxy_config.buffer_size_kb.unwrap_or(0), Ordering::Relaxed);
        *policy.output_format.write().unwrap() = grant.proxy_config.output_format.clone();
        if let Ok(u) = Url::parse(&grant.target) {
            if let Some(h) = u.host_str() {
                policy.hosts.write().unwrap().insert(h.to_lowercase());
            }
        }
        Ok((policy, grant.target))
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
    pub async fn authorize(&self, token: &str, source: &str) -> Result<Option<String>, (u16, String)> {
        let key = (token.to_string(), source.to_string());
        {
            let cache = self.auth_cache.lock().unwrap();
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
        let (allowed, status, message, username) = match self.authorize_remote(token, source).await {
            Some(v) => v,
            None => return Err((403, "Forbidden: authorization unavailable".to_string())),
        };
        {
            let mut cache = self.auth_cache.lock().unwrap();
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
    async fn authorize_remote(&self, token: &str, source: &str) -> Option<(bool, u16, String, Option<String>)> {
        let body = serde_json::json!({ "token": token, "source": source });
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
        let _ = client.post(url.as_str()).header("x-masq-secret", &secret).json(&body).send().await;
    }
}
