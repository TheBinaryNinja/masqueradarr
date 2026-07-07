//! log.rs — the masq-proxy structured logging framework.
//!
//! The Rust data plane's counterpart to Node's tagged `logger`. It decorates the whole engine with
//! LEVEL-GATED, LINEAGE-TAGGED trace lines so a single channel's path — client request → source resolve →
//! upstream fetch/failover → manifest rewrite → segment repackage / raw-TS concat → bytes out — is fully
//! observable in the same "View logs" drawer as everything else (the dedicated `proxy` log category).
//!
//! DESIGN (mirrors the telemetry machinery in state.rs):
//!  · The verbosity GATE lives here (in Rust): a line is only formatted + shipped if the current global level
//!    permits it, so IPC stays cheap at low levels. The gate is checked BEFORE `format!` (the public helpers
//!    take a closure) so a suppressed line allocates nothing.
//!  · Lines are BATCHED: `emit`/the helpers enqueue onto a bounded mpsc; a single background `log_flusher`
//!    coalesces + POSTs `{ events:[...] }` to `{node}/api/internal/log`. Best-effort — a full queue DROPS the
//!    event (never blocks the byte path); a transport failure is ignored.
//!  · The level is kept LIVE: every flush response (this endpoint AND /api/internal/telemetry) carries the
//!    current `{ logLevel }`, which `apply_level_response` reads back into the atomic — so an operator's
//!    Settings change reaches the sidecar within one flush cycle, no restart (see server/src/proxy/logLevel.ts).
//!  · Level ladder: 1 = error/warn only · 2 = + info (milestones) · 3 = + trace (full per-stage/hop/segment
//!    lineage). The persisted level is only info|warn|error — Rust's `trace` tier collapses to `info` on ship
//!    (the verbosity distinction is the Rust-side GATE, not a fourth persisted level).
//!
//! The sink + level are process-GLOBALS (a cross-cutting logger, like Node's module-singleton `logger`) so any
//! module logs without threading state. `init()` is called once from `AppState::new` (which runs once).

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::sync::mpsc;

// Batching knobs — same shape as the telemetry flusher (state.rs).
const LOG_QUEUE: usize = 4096;
const LOG_MAX_BATCH: usize = 256;
const LOG_FLUSH_MS: u64 = 250;

// The global log level (1..3). Seeded from MASQ_LOG_LEVEL at init; kept live by apply_level_response.
static LEVEL: AtomicU8 = AtomicU8::new(2);

// The global log sink — the Sender half of the batched flusher's channel. None until init() installs it; a
// log emitted before init (there are none in practice) is silently dropped.
static SINK: OnceLock<mpsc::Sender<Value>> = OnceLock::new();

/// The current global log level (1..3). Read by the gate on every helper + by the tsmux/proxy hot paths.
#[inline]
pub fn level() -> u8 {
    LEVEL.load(Ordering::Relaxed)
}

/// Store the current global log level (clamped 1..3). Called from init (env seed) + apply_level_response.
pub fn set_level(n: u8) {
    LEVEL.store(n.clamp(1, 3), Ordering::Relaxed);
}

/// Install the log sink + spawn the batched flusher, and seed the level from MASQ_LOG_LEVEL. Idempotent (a
/// second call is a no-op via the OnceLock). Must run inside the tokio runtime (AppState::new does).
pub fn init(client: reqwest::Client, url: String, secret: String) {
    let env_level = std::env::var("MASQ_LOG_LEVEL").ok().and_then(|v| v.parse::<u8>().ok()).unwrap_or(2);
    set_level(env_level);
    let (tx, rx) = mpsc::channel::<Value>(LOG_QUEUE);
    if SINK.set(tx).is_ok() {
        tokio::spawn(log_flusher(rx, client, url, secret));
    }
}

/// Read `{ logLevel }` out of a flush response and update the atomic — the live level-change path. Called by
/// BOTH the log flusher (below) and the telemetry flusher (state.rs), so either flow keeps the level current.
pub async fn apply_level_response(resp: reqwest::Response) {
    if let Ok(v) = resp.json::<Value>().await {
        if let Some(n) = v.get("logLevel").and_then(|x| x.as_u64()) {
            set_level(n as u8);
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The FNV-1a-32 lineage id: a stable 8-hex id for one viewing session, derived from `source|entry`. The
/// ENTRY, every `h/` HOP, each segment, and the TS poller all compute the SAME id (a cold hop recovers `entry`
/// from `&e=`), so grepping one `rid` in the drawer replays a channel's whole path resolve→output — even
/// across the stateless hop requests and a sidecar restart.
pub fn rid(source: &str, entry: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in source.bytes().chain(std::iter::once(b'|')).chain(entry.bytes()) {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

// ── the ship path ─────────────────────────────────────────────────────────────────────────────────────────

/// Compose + emit one line (the gate has already passed). Prints `[tag] [rid] msg` to stderr for local /
/// standalone visibility (in Docker this is the ONE console line — Node persists silently to avoid a duplicate)
/// and enqueues the structured event for the batched flusher. NEVER logs its own errors via this path
/// (recursion guard); a full/absent queue just drops the event.
fn ship(persist_level: &str, tag: &str, rid: &str, msg: String, meta: Option<Value>) {
    let line = if rid.is_empty() { msg.clone() } else { format!("[{rid}] {msg}") };
    eprintln!("[{tag}] {line}");
    if let Some(tx) = SINK.get() {
        let _ = tx.try_send(json!({
            "ts": now_ms(),
            "level": persist_level,
            "tag": tag,
            "rid": rid,
            "msg": line,
            "meta": meta,
        }));
    }
}

// Public helpers. The message is a CLOSURE so it (and its `format!`) is only built when the level admits the
// line — a suppressed line allocates nothing. Level ladder: error/warn → >= 1 · info → >= 2 · trace → >= 3.
// (The `meta` seam — ship's Option<Value> arg + logIngest's merge — is wired end-to-end; the current call
// sites keep the whole line in the message + rid, so they pass None. Add a *_meta helper here if a future
// milestone wants queryable structured fields.)

pub fn error(tag: &str, rid: &str, f: impl FnOnce() -> String) {
    if level() >= 1 {
        ship("error", tag, rid, f(), None);
    }
}
pub fn warn(tag: &str, rid: &str, f: impl FnOnce() -> String) {
    if level() >= 1 {
        ship("warn", tag, rid, f(), None);
    }
}
pub fn info(tag: &str, rid: &str, f: impl FnOnce() -> String) {
    if level() >= 2 {
        ship("info", tag, rid, f(), None);
    }
}
pub fn trace(tag: &str, rid: &str, f: impl FnOnce() -> String) {
    if level() >= 3 {
        ship("info", tag, rid, f(), None);
    }
}

// ── the batched flusher (clone of state.rs::telemetry_flusher, + the level echo-back) ─────────────────────

async fn log_flusher(mut rx: mpsc::Receiver<Value>, client: reqwest::Client, url: String, secret: String) {
    loop {
        let first = match rx.recv().await {
            Some(ev) => ev,
            None => break, // sink dropped → process exit
        };
        let mut batch = vec![first];
        let deadline = tokio::time::sleep(Duration::from_millis(LOG_FLUSH_MS));
        tokio::pin!(deadline);
        while batch.len() < LOG_MAX_BATCH {
            tokio::select! {
                _ = &mut deadline => break,
                next = rx.recv() => match next {
                    Some(ev) => batch.push(ev),
                    None => break,
                },
            }
        }
        let body = json!({ "events": batch });
        if let Ok(resp) = client.post(url.as_str()).header("x-masq-secret", &secret).json(&body).send().await {
            apply_level_response(resp).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rid_is_stable_and_8_hex() {
        let a = rid("dlhd", "https://x/watch.php?id=42");
        let b = rid("dlhd", "https://x/watch.php?id=42");
        assert_eq!(a, b);
        assert_eq!(a.len(), 8);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        // Different entry → different id (so channels don't collide in the drawer).
        assert_ne!(a, rid("dlhd", "https://x/watch.php?id=43"));
    }

    #[test]
    fn set_level_clamps() {
        set_level(9);
        assert_eq!(level(), 3);
        set_level(0);
        assert_eq!(level(), 1);
        set_level(2);
        assert_eq!(level(), 2);
    }
}
