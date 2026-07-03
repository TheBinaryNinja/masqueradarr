//! Shared state: the HTTP client, the Node control-plane endpoint, the shared secret, and the per-source
//! POLICY CACHE. A `SourcePolicy` holds what the sidecar replays for a source's streams — the upstream
//! headers, the segment-relabel rule, and a GROWING allowlist of hosts. The allowlist is observational: it
//! is seeded with the resolved master's host and grown with every host the sidecar rewrites out of a
//! manifest (mirroring each adapter's dynamic-allow), so a client can only reach hosts that appeared in a
//! trusted upstream manifest — never an arbitrary/injected host (and private IPs are rejected outright).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use url::Url;

/// How long a resolved ENTRY target is reused before re-resolving. This collapses per-poll resolves for a
/// media-playlist entry (so a few-second player poll doesn't re-mint a dulo playbackUrl / re-scrape dlhd
/// every time), while staying well inside typical multi-minute token expiries. A master entry is fetched
/// once (the player then polls the variant HOP, which never resolves), so this mainly guards media-playlist
/// entries. (P3 could honor a per-grant `expiresAt` instead of a fixed cap.)
const TARGET_TTL: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct AppState {
    pub client: reqwest::Client,
    pub node_url: String,
    pub secret: String,
    cache: Arc<Mutex<HashMap<String, Arc<SourcePolicy>>>>,
    targets: Arc<Mutex<HashMap<String, (String, Instant)>>>,
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
}

impl SourcePolicy {
    fn empty() -> Self {
        Self {
            headers: RwLock::new(Vec::new()),
            relabel_segment: RwLock::new(None),
            allow_private: AtomicBool::new(false),
            hosts: RwLock::new(HashSet::new()),
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
    // (Node's grant also carries `isEntry`; the sidecar decides entry/hop from the path, so serde ignores it.)
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
        Self {
            client,
            node_url,
            secret,
            cache: Arc::new(Mutex::new(HashMap::new())),
            targets: Arc::new(Mutex::new(HashMap::new())),
        }
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
        if let Ok(u) = Url::parse(&grant.target) {
            if let Some(h) = u.host_str() {
                policy.hosts.write().unwrap().insert(h.to_lowercase());
            }
        }
        Ok((policy, grant.target))
    }

    /// Fire-and-forget a telemetry event to Node (best-effort — a failure must never affect streaming).
    pub fn report(&self, event: serde_json::Value) {
        let client = self.client.clone();
        let url = format!("{}/api/internal/telemetry", self.node_url);
        let secret = self.secret.clone();
        tokio::spawn(async move {
            let _ = client
                .post(url)
                .header("x-masq-secret", secret)
                .json(&event)
                .send()
                .await;
        });
    }
}
