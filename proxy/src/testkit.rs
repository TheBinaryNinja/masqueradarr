
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bytes::Bytes;

use crate::state::AppState;
use crate::sync::LockExt;

#[derive(Clone)]
pub(crate) enum Seam {
    Grant { path: String, origin: bool, expires_at_ms: Option<u64>, extra: serde_json::Value },
    Reply(u16, String),
}

impl Seam {
    pub(crate) fn grant(path: &str, origin: bool) -> Self {
        Seam::Grant { path: path.to_string(), origin, expires_at_ms: None, extra: serde_json::Value::Null }
    }

    pub(crate) fn grant_with(path: &str, extra: serde_json::Value) -> Self {
        Seam::Grant { path: path.to_string(), origin: true, expires_at_ms: None, extra }
    }
}

#[derive(Clone)]
pub(crate) enum Serve {
    Body(String),
    Media(Vec<u8>),
    Stall { head: Vec<u8>, hold: Duration },
    Endless(Vec<u8>),
    Status(u16),
}

#[derive(Clone, Debug)]
pub(crate) struct Call {
    pub(crate) at: Duration,
    pub(crate) attempt: u32,
    pub(crate) reason: Option<String>,
}

pub(crate) struct Script {
    pub(crate) seam: Seam,
    pub(crate) paths: HashMap<String, Serve>,
    pub(crate) resolves: u32,
    pub(crate) calls: Vec<Call>,
    pub(crate) exhaust_advances: bool,
    pub(crate) echo: serde_json::Value,
    pub(crate) hits: HashMap<String, u32>,
    pub(crate) by_attempt: HashMap<u32, Seam>,
}

#[derive(Clone)]
struct Shared {
    addr: SocketAddr,
    started: Instant,
    script: Arc<Mutex<Script>>,
}

pub(crate) struct Mock {
    shared: Shared,
}

impl Mock {
    pub(crate) async fn start(seam: Seam) -> Mock {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind a loopback port");
        let addr = listener.local_addr().expect("a bound address");
        let shared = Shared {
            addr,
            started: Instant::now(),
            script: Arc::new(Mutex::new(Script {
                seam,
                paths: HashMap::new(),
                resolves: 0,
                calls: Vec::new(),
                exhaust_advances: false,
                echo: serde_json::json!({}),
                hits: HashMap::new(),
                by_attempt: HashMap::new(),
            })),
        };
        let app = Router::new()
            .route("/api/internal/resolve", post(resolve))
            .route("/api/internal/telemetry", post(sink))
            .route("/api/internal/log", post(sink))
            .route("/pl/:name", get(playlist))
            .route("/seg/:n", get(segment))
            .route("/bad/:n", get(undecodable))
            .with_state(shared.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Mock { shared }
    }

    pub(crate) fn state(&self) -> AppState {
        AppState::new(format!("http://{}", self.shared.addr), String::new())
    }

    pub(crate) fn port(&self) -> u16 {
        self.shared.addr.port()
    }

    pub(crate) fn script(&self, f: impl FnOnce(&mut Script)) {
        f(&mut self.shared.script.lock_ok());
    }

    pub(crate) fn resolves(&self) -> u32 {
        self.shared.script.lock_ok().resolves
    }

    pub(crate) fn calls(&self) -> Vec<Call> {
        self.shared.script.lock_ok().calls.clone()
    }

    pub(crate) fn hits(&self, path: &str) -> u32 {
        self.shared.script.lock_ok().hits.get(path).copied().unwrap_or(0)
    }
}

async fn resolve(State(s): State<Shared>, Json(asked): Json<serde_json::Value>) -> Response {
    let attempt = asked.get("attempt").and_then(|a| a.as_u64()).unwrap_or(0) as u32;
    let reason = asked.get("reason").and_then(|r| r.as_str()).map(str::to_string);
    let (seam, exhausted) = {
        let mut sc = s.script.lock_ok();
        sc.resolves += 1;
        sc.calls.push(Call { at: s.started.elapsed(), attempt, reason });
        let seam = sc.by_attempt.get(&attempt).cloned().unwrap_or_else(|| sc.seam.clone());
        (seam, sc.exhaust_advances && attempt >= 1)
    };
    if exhausted {
        return (StatusCode::GONE, r#"{"error":"failover_exhausted"}"#).into_response();
    }
    match seam {
        Seam::Grant { path, origin, expires_at_ms, extra } => {
            let mut grant = serde_json::json!({
                "target": format!("http://{}{path}", s.addr),
                "upstreamHeaders": {},
                "relabelSegment": null,
                "allowPrivate": true,
                "isEntry": true,
                "proxyConfig": { "originEnabled": origin },
                "expiresAtMs": expires_at_ms,
            });
            if let (Some(g), serde_json::Value::Object(x)) = (grant.as_object_mut(), extra) {
                g.extend(x);
            }
            Json(grant).into_response()
        }
        Seam::Reply(status, body) => {
            (StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY), body).into_response()
        }
    }
}

async fn sink(State(s): State<Shared>) -> Json<serde_json::Value> {
    Json(s.script.lock_ok().echo.clone())
}

async fn playlist(State(s): State<Shared>, Path(name): Path<String>) -> Response {
    let path = format!("/pl/{name}");
    let serve = {
        let mut sc = s.script.lock_ok();
        *sc.hits.entry(path.clone()).or_default() += 1;
        sc.paths.get(&path).cloned()
    };
    match serve {
        Some(Serve::Body(b)) => ([("content-type", "application/vnd.apple.mpegurl")], b).into_response(),
        Some(Serve::Media(b)) => ([("content-type", "video/mp2t")], b).into_response(),
        Some(Serve::Stall { head, hold }) => {
            let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(1);
            tokio::spawn(async move {
                let _ = tx.send(Ok(Bytes::from(head))).await;
                tokio::time::sleep(hold).await;
            });
            let body = Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx));
            ([("content-type", "video/mp2t")], body).into_response()
        }
        Some(Serve::Endless(unit)) => {
            let unit = Bytes::from(unit);
            let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(1);
            tokio::spawn(async move {
                while tx.send(Ok(unit.clone())).await.is_ok() {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            });
            let body = Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx));
            ([("content-type", "video/mp2t")], body).into_response()
        }
        Some(Serve::Status(code)) => StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn segment(Path(n): Path<u64>) -> Response {
    ([("content-type", "video/mp2t")], tagged_ts(n)).into_response()
}

async fn undecodable(Path(_n): Path<u64>) -> Response {
    ([("content-type", "video/mp2t")], crate::tsseg::undecodable_segment()).into_response()
}

pub(crate) fn media_playlist(ms: i64, n: usize, td: u32) -> String {
    playlist_under("/seg", ms, n, td)
}

pub(crate) fn undecodable_playlist(ms: i64, n: usize, td: u32) -> String {
    playlist_under("/bad", ms, n, td)
}

fn playlist_under(prefix: &str, ms: i64, n: usize, td: u32) -> String {
    let mut body = format!("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:{td}\n#EXT-X-MEDIA-SEQUENCE:{ms}\n");
    for i in 0..n {
        body.push_str(&format!("#EXTINF:{td}.000,\n{prefix}/{}\n", ms + i as i64));
    }
    body
}

pub(crate) fn tagged_ts(tag: u64) -> Vec<u8> {
    (0..12)
        .flat_map(|_| {
            let mut p = vec![0xFFu8; crate::tsseg::PKT];
            p[0] = crate::tsseg::SYNC;
            p[1] = 0x1F;
            p[3] = 0x10;
            p[4..12].copy_from_slice(&tag.to_be_bytes());
            p
        })
        .collect()
}

pub(crate) fn tag_of(bytes: &[u8]) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&bytes[4..12]);
    u64::from_be_bytes(b)
}

pub(crate) async fn until(within: Duration, what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !cond() {
        assert!(Instant::now() < deadline, "timed out after {within:?} waiting for: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
