
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::dns::UpstreamDns;

const LOG_QUEUE: usize = 4096;
const LOG_MAX_BATCH: usize = 256;
const LOG_FLUSH_MS: u64 = 250;

static LEVEL: AtomicU8 = AtomicU8::new(2);

static SINK: OnceLock<mpsc::Sender<Value>> = OnceLock::new();

#[inline]
pub fn level() -> u8 {
    LEVEL.load(Ordering::Relaxed)
}

pub fn set_level(n: u8) {
    LEVEL.store(n.clamp(1, 3), Ordering::Relaxed);
}

pub fn init(client: reqwest::Client, url: String, secret: String, dns: Arc<UpstreamDns>) {
    let env_level = std::env::var("MASQ_LOG_LEVEL").ok().and_then(|v| v.parse::<u8>().ok()).unwrap_or(2);
    set_level(env_level);
    let (tx, rx) = mpsc::channel::<Value>(LOG_QUEUE);
    if SINK.set(tx).is_ok() {
        tokio::spawn(log_flusher(rx, client, url, secret, dns));
    }
}

pub async fn apply_flush_echo(resp: reqwest::Response, dns: &UpstreamDns) {
    if let Ok(v) = resp.json::<Value>().await {
        if let Some(n) = v.get("logLevel").and_then(|x| x.as_u64()) {
            set_level(n as u8);
        }
        dns.apply_echo(&v);
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn rid(source: &str, entry: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for b in source.bytes().chain(std::iter::once(b'|')).chain(entry.bytes()) {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}


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


async fn log_flusher(
    mut rx: mpsc::Receiver<Value>,
    client: reqwest::Client,
    url: String,
    secret: String,
    dns: Arc<UpstreamDns>,
) {
    loop {
        let first = match rx.recv().await {
            Some(ev) => ev,
            None => break,
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
            apply_flush_echo(resp, &dns).await;
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
