
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::sync::{LockExt, RwExt};
use serde::Deserialize;
use tokio::sync::mpsc;
use url::Url;

const TELEMETRY_QUEUE: usize = 4096;
const TELEMETRY_MAX_BATCH: usize = 256;
const TELEMETRY_FLUSH_MS: u64 = 250;

const RING_REPORT_MS: u64 = 2500;

const TARGET_TTL: Duration = Duration::from_secs(60);

const TARGET_EXPIRY_MARGIN: Duration = Duration::from_secs(60);

const MIN_TARGET_TTL: Duration = Duration::from_secs(5);

const DEFAULT_REFUSAL: &str = "stream refused: this source is already at its concurrent-stream limit";

pub const RETIRE_TARGET_REJECTED: &str = "target_rejected";

pub const RETIRE_REFRESH_FAILED: &str = "refresh_failed";

const FAILOVER_CURSOR_IDLE: Duration = Duration::from_secs(300);

pub const MAX_FAILOVER_ATTEMPTS: u32 = 12;

const AUTH_TTL: Duration = Duration::from_secs(30);
const AUTH_CACHE_MAX: usize = 4096;

type AuthKey = (String, String, String);

struct AuthDecision {
    allowed: bool,
    status: u16,
    message: String,
    username: Option<String>,
    expires: Instant,
}

#[derive(Clone)]
pub struct AppState {
    pub client: reqwest::Client,
    node_client: reqwest::Client,
    pub proxy_client: reqwest::Client,
    dns: Arc<crate::dns::UpstreamDns>,
    pub node_url: String,
    pub secret: String,
    cache: Arc<Mutex<HashMap<String, Arc<SourcePolicy>>>>,
    targets: Arc<Mutex<HashMap<String, TargetEntry>>>,
    upstream_clients: Arc<Mutex<HashMap<(u64, u32), reqwest::Client>>>,
    telemetry_tx: mpsc::Sender<serde_json::Value>,
    stream_seq: Arc<AtomicU64>,
    auth_cache: Arc<Mutex<HashMap<AuthKey, AuthDecision>>>,
    origins: Arc<Mutex<HashMap<String, Arc<crate::origin::Origin>>>>,
}

pub struct TargetEntry {
    target: String,
    expires: Instant,
    policy_key: String,
    attempt: u32,
    last_access: Instant,
    expires_at_ms: Option<u64>,
    rejected_at: Option<Instant>,
    retire_hint: Option<&'static str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TargetMeta {
    pub attempt: u32,
    pub expires_at_ms: Option<u64>,
}

pub(crate) fn target_key(source: &str, entry: &str) -> String {
    format!("{source}\u{0}{entry}")
}

pub(crate) fn epoch_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn target_ttl(expires_at_ms: Option<u64>, now_ms: u64) -> Duration {
    let Some(exp) = expires_at_ms else {
        return TARGET_TTL;
    };
    let left = Duration::from_millis(exp.saturating_sub(now_ms)).saturating_sub(TARGET_EXPIRY_MARGIN);
    left.clamp(MIN_TARGET_TTL, TARGET_TTL)
}

pub enum ResolveErr {
    Exhausted,
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

fn seam_failure(status: u16, body: &str) -> ResolveErr {
    if status == 410 || body.contains("failover_exhausted") {
        return ResolveErr::Exhausted;
    }
    let json = serde_json::from_str::<serde_json::Value>(body).ok();
    let field = |k: &str| json.as_ref().and_then(|v| v.get(k)).and_then(|v| v.as_str());
    if status == 429 || field("error") == Some("source_stream_cap") {
        let message = field("message").map(str::trim).filter(|m| !m.is_empty()).unwrap_or(DEFAULT_REFUSAL);
        return ResolveErr::Refused(message.to_string());
    }
    ResolveErr::Other(format!("resolve {status}: {body}"))
}

struct Granted {
    policy: Arc<SourcePolicy>,
    policy_key: String,
    target: String,
    expires_at_ms: Option<u64>,
}

pub struct SourcePolicy {
    pub headers: RwLock<Vec<(String, String)>>,
    pub relabel_segment: RwLock<Option<String>>,
    pub allow_private: AtomicBool,
    pub player_selectable: AtomicBool,
    pub hosts: RwLock<HashSet<String>>,
    pub connect_timeout_ms: AtomicU64,
    pub max_redirects: AtomicU32,
    pub read_timeout_ms: AtomicU64,
    pub buffer_size_kb: AtomicU64,
    pub output_format: RwLock<String>,
    pub stream_inf_redux: AtomicBool,
    pub failover_enabled: AtomicBool,
    pub failover_on_definite_error: AtomicBool,
    pub origin_enabled: AtomicBool,
    pub origin_ring_mb: AtomicU64,
    pub ad_uri_contains: RwLock<Vec<String>>,
    pub splice_normalize: AtomicBool,
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

#[derive(Deserialize)]
pub struct Grant {
    pub target: String,
    #[serde(rename = "upstreamHeaders")]
    pub upstream_headers: HashMap<String, String>,
    #[serde(rename = "relabelSegment")]
    pub relabel_segment: Option<String>,
    #[serde(rename = "allowPrivate")]
    pub allow_private: bool,
    #[serde(rename = "playerSelectable", default)]
    pub player_selectable: bool,
    #[serde(rename = "proxyConfig", default)]
    pub proxy_config: ProxyConfigWire,
    #[serde(rename = "adSignature", default)]
    pub ad_signature: Option<AdSignatureWire>,
    #[serde(rename = "segmentUnwrap", default)]
    pub segment_unwrap: bool,
    #[serde(rename = "expiresAtMs", default, deserialize_with = "lenient_epoch_ms")]
    pub expires_at_ms: Option<u64>,
    #[serde(rename = "policySource", default)]
    pub policy_source: Option<String>,
    #[serde(rename = "failover", default)]
    pub failover: Option<FailoverWire>,
}

#[derive(Deserialize, Clone)]
pub struct AdSignatureWire {
    #[serde(rename = "uriContains", default)]
    pub uri_contains: Vec<String>,
}

#[derive(Deserialize, Clone)]
pub struct FailoverWire {
    pub attempt: u32,
    pub total: u32,
    #[serde(rename = "candidateName", default)]
    pub candidate_name: String,
}

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
    #[serde(rename = "streamInfRedux", default)]
    pub stream_inf_redux: bool,
    #[serde(rename = "failoverEnabled", default = "default_true")]
    pub failover_enabled: bool,
    #[serde(rename = "failoverOnDefiniteError", default)]
    pub failover_on_definite_error: bool,
    #[serde(rename = "originEnabled", default)]
    pub origin_enabled: bool,
    #[serde(rename = "originRingMb", default = "default_origin_ring_mb")]
    pub origin_ring_mb: u64,
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
        Self::with_dns(node_url, secret, Arc::new(crate::dns::UpstreamDns::new()))
    }

    fn with_dns(node_url: String, secret: String, dns: Arc<crate::dns::UpstreamDns>) -> Self {
        let node_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("failed to build reqwest client");
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            .connect_timeout(Duration::from_secs(15))
            .dns_resolver(dns.clone())
            .build()
            .expect("failed to build reqwest client");
        let proxy_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .gzip(false)
            .build()
            .unwrap_or_else(|_| node_client.clone());
        let (telemetry_tx, telemetry_rx) = mpsc::channel::<serde_json::Value>(TELEMETRY_QUEUE);
        tokio::spawn(telemetry_flusher(
            telemetry_rx,
            node_client.clone(),
            format!("{node_url}/api/internal/telemetry"),
            secret.clone(),
            dns.clone(),
        ));
        let origins: Arc<Mutex<HashMap<String, Arc<crate::origin::Origin>>>> = Arc::new(Mutex::new(HashMap::new()));
        tokio::spawn(ring_reporter(origins.clone(), telemetry_tx.clone()));
        crate::log::init(node_client.clone(), format!("{node_url}/api/internal/log"), secret.clone(), dns.clone());
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

    pub fn next_stream_id(&self) -> String {
        format!("ts{}", self.stream_seq.fetch_add(1, Ordering::Relaxed))
    }

    pub(crate) fn origins(&self) -> &Arc<Mutex<HashMap<String, Arc<crate::origin::Origin>>>> {
        &self.origins
    }

    pub fn client_for(&self, connect_timeout_ms: u64, max_redirects: u32) -> reqwest::Client {
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
                        e.attempt = 0;
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
            Err(ResolveErr::Refused(why)) => {
                self.invalidate_target(source, entry);
                return Err(ResolveErr::Refused(why));
            }
            Err(e) => return Err(e),
        };
        self.record_target(source, entry, &g.target, g.policy_key, attempt, g.expires_at_ms);
        Ok((g.policy, g.target))
    }

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

    fn take_retire_hint(&self, source: &str, entry: &str) -> Option<&'static str> {
        self.targets.lock_ok().get_mut(&target_key(source, entry)).and_then(|e| e.retire_hint.take())
    }

    pub fn target_record(&self, source: &str, entry: &str, target: &str) -> Option<TargetMeta> {
        let m = self.targets.lock_ok();
        let e = m.get(&target_key(source, entry)).filter(|e| e.target == target)?;
        Some(TargetMeta { attempt: e.attempt, expires_at_ms: e.expires_at_ms })
    }

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
                        expires: now,
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

    pub fn invalidate_target(&self, source: &str, entry: &str) {
        let now = Instant::now();
        if let Some(e) = self.targets.lock_ok().get_mut(&target_key(source, entry)) {
            e.expires = now;
        }
    }

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

    pub fn reset_cursor(&self, source: &str, entry: &str) {
        let now = Instant::now();
        if let Some(e) = self.targets.lock_ok().get_mut(&target_key(source, entry)) {
            e.attempt = 0;
            e.expires = now;
        }
    }

    pub fn touch_stream(&self, source: &str, entry: &str) {
        if let Some(e) = self.targets.lock_ok().get_mut(&target_key(source, entry)) {
            e.last_access = Instant::now();
        }
    }

    pub fn hop_policy(&self, source: &str, entry: &str) -> Option<Arc<SourcePolicy>> {
        self.resolved_target_policy(source, entry).or_else(|| self.get(source))
    }

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
        policy.connect_timeout_ms.store(grant.proxy_config.connect_timeout_ms, Ordering::Relaxed);
        policy.max_redirects.store(grant.proxy_config.max_redirects, Ordering::Relaxed);
        policy.read_timeout_ms.store(grant.proxy_config.read_timeout_ms.unwrap_or(0), Ordering::Relaxed);
        policy.buffer_size_kb.store(grant.proxy_config.buffer_size_kb.unwrap_or(0), Ordering::Relaxed);
        *policy.output_format.write_ok() = grant.proxy_config.output_format.clone();
        policy.stream_inf_redux.store(grant.proxy_config.stream_inf_redux, Ordering::Relaxed);
        policy.failover_enabled.store(grant.proxy_config.failover_enabled, Ordering::Relaxed);
        policy
            .failover_on_definite_error
            .store(grant.proxy_config.failover_on_definite_error, Ordering::Relaxed);
        policy.origin_enabled.store(grant.proxy_config.origin_enabled, Ordering::Relaxed);
        policy
            .origin_ring_mb
            .store(grant.proxy_config.origin_ring_mb.max(1), Ordering::Relaxed);
        policy.splice_normalize.store(grant.proxy_config.splice_normalize, Ordering::Relaxed);
        policy.segment_unwrap.store(grant.segment_unwrap, Ordering::Relaxed);
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
            let unwrap = if grant.segment_unwrap { " segmentUnwrap" } else { "" };
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

    pub fn report(&self, event: serde_json::Value) {
        let _ = self.telemetry_tx.try_send(event);
    }

    pub async fn authorize(
        &self,
        token: &str,
        source: &str,
        pl: Option<&str>,
    ) -> Result<Option<String>, (u16, String)> {
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
        let _ = tx.try_send(serde_json::json!({
            "kind": "ring",
            "origins": f.origins,
            "subscribed": f.subscribed,
            "ringBytes": f.bytes,
            "ringCapBytes": f.cap_bytes,
        }));
    }
}

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
            None => break,
        };
        let mut batch = vec![first];
        let deadline = tokio::time::sleep(Duration::from_millis(TELEMETRY_FLUSH_MS));
        tokio::pin!(deadline);
        while batch.len() < TELEMETRY_MAX_BATCH {
            tokio::select! {
                _ = &mut deadline => break,
                next = rx.recv() => match next {
                    Some(ev) => batch.push(ev),
                    None => break,
                },
            }
        }
        let body = serde_json::json!({ "events": batch });
        if let Ok(resp) = client.post(url.as_str()).header("x-masq-secret", &secret).json(&body).send().await {
            crate::log::apply_flush_echo(resp, &dns).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn a_null_or_absent_ad_signature_degrades_to_none() {
        let base = r#"{"target":"https://x/","upstreamHeaders":{},"relabelSegment":null,
                       "allowPrivate":false,"isEntry":true,"proxyConfig":{}"#;
        let explicit_null: Grant = serde_json::from_str(&format!("{base},\"adSignature\":null}}")).unwrap();
        assert!(explicit_null.ad_signature.is_none(), "every non-pluto source sends null");
        let absent: Grant = serde_json::from_str(&format!("{base}}}")).unwrap();
        assert!(absent.ad_signature.is_none(), "a pre-CUE Node omits the key");
    }

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

    #[test]
    fn a_target_is_reused_no_longer_than_its_own_expiry_allows() {
        const NOW: u64 = 1_786_000_000_000;
        assert_eq!(target_ttl(None, NOW), TARGET_TTL, "no stated expiry: the fixed cap, as before");
        assert_eq!(target_ttl(Some(NOW + 9_000_000), NOW), TARGET_TTL, "a zlive token has hours left: the cap wins");
        assert_eq!(target_ttl(Some(NOW + 90_000), NOW), Duration::from_secs(30), "90 s left: reuse stops 60 s short");
        assert_eq!(target_ttl(Some(NOW + 61_000), NOW), MIN_TARGET_TTL, "inside the margin: the floor");
        assert_eq!(target_ttl(Some(NOW - 1_000), NOW), MIN_TARGET_TTL, "already lapsed: still the floor, never zero");
    }

    #[test]
    fn the_seam_s_refusal_is_told_apart_from_exhaustion_and_failure() {
        let refusal = r#"{"error":"source_stream_cap","message":"ZLive already has 2 of 2 allowed concurrent stream(s) live — stop one before starting another"}"#;
        match seam_failure(429, refusal) {
            ResolveErr::Refused(m) => assert!(m.starts_with("ZLive already has 2 of 2"), "Node's own words: {m}"),
            other => panic!("a 429 is a refusal, got: {other}"),
        }
        assert!(matches!(seam_failure(502, refusal), ResolveErr::Refused(_)));
        match seam_failure(429, "") {
            ResolveErr::Refused(m) => assert_eq!(m, DEFAULT_REFUSAL),
            other => panic!("got: {other}"),
        }
        assert!(matches!(
            seam_failure(502, r#"{"error":"resolve_failed","message":"upstream said source_stream_cap"}"#),
            ResolveErr::Other(_)
        ));
        assert!(matches!(seam_failure(410, r#"{"error":"failover_exhausted"}"#), ResolveErr::Exhausted));
        assert!(matches!(seam_failure(502, r#"{"error":"resolve_failed"}"#), ResolveErr::Other(_)));
        let walkable = r#"{"error":"resolve_failed: ZLive stream cap reached","message":"ZLive already has 2 of 2 allowed concurrent stream(s) live — stop one before starting another"}"#;
        assert!(matches!(seam_failure(502, walkable), ResolveErr::Other(_)));
    }

    #[tokio::test]
    async fn a_rejected_target_is_dropped_at_most_once_per_window_across_re_resolves() {
        let s = AppState::new("http://127.0.0.1:9".to_string(), String::new());
        assert!(!s.invalidate_rejected_target("zl", "zl://abc"), "nothing cached, nothing to drop");

        s.record_target("zl", "zl://abc", "https://a/1.m3u8", "zl".into(), 0, None);
        assert!(s.invalidate_rejected_target("zl", "zl://abc"), "the first rejection drops the target");
        assert!(s.target_expired("zl", "zl://abc"));

        s.record_target("zl", "zl://abc", "https://a/2.m3u8", "zl".into(), 0, None);
        assert!(!s.invalidate_rejected_target("zl", "zl://abc"), "a second rejection inside the window is absorbed");
        assert!(!s.target_expired("zl", "zl://abc"), "…and the fresh target stays cached");

        if let Some(e) = s.targets.lock_ok().get_mut(&target_key("zl", "zl://abc")) {
            e.rejected_at = Some(Instant::now() - TARGET_TTL - Duration::from_secs(1));
        }
        assert!(s.invalidate_rejected_target("zl", "zl://abc"));
    }

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

    #[tokio::test]
    async fn upstream_clients_resolve_through_the_settings_resolver_and_the_node_client_never_does() {
        use crate::testkit::{Mock, Seam};
        let web = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let web_port = web.local_addr().unwrap().port();
        tokio::spawn(async move {
            let app = axum::Router::new().route("/", axum::routing::get(|| async { "upstream" }));
            let _ = axum::serve(web, app).await;
        });
        let (dns, asked) = crate::dns::UpstreamDns::over_fake_os(&[("upstream.example.test", "127.0.0.1")]);
        let mock = Mock::start(Seam::Reply(502, String::new())).await;
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

        mock.script(|sc| sc.echo = serde_json::json!({}));
        s.report(serde_json::json!({ "kind": "probe" }));
        tokio::time::sleep(Duration::from_millis(3 * TELEMETRY_FLUSH_MS)).await;
        assert_eq!(s.dns.servers(), servers(&["192.0.2.53", "192.0.2.54"]));

        mock.script(|sc| sc.echo = serde_json::json!({ "nameservers": null }));
        s.report(serde_json::json!({ "kind": "probe" }));
        until(within, "the OS resolver to be back in charge", || s.dns.servers().is_empty()).await;
    }

    impl AppState {
        fn target_expired(&self, source: &str, entry: &str) -> bool {
            self.targets.lock_ok().get(&target_key(source, entry)).is_none_or(|e| e.expires <= Instant::now())
        }
    }
}
