//! Test-only: a loopback stand-in for BOTH ends of the data plane — Node's resolve seam and an upstream HLS
//! origin — so the relay handler and the origin ingest can be driven end to end, over real sockets, with no
//! network and no Node.
//!
//! Scripted rather than recorded. A test says what the seam answers and what each upstream path serves, and
//! re-scripts mid-test to model the moments the behaviour under test exists for: a signed URL lapsing, a
//! resolver re-signing onto the same numbering (or a new one), a stream cap filling up. Segments are tiny
//! synthetic transport streams that carry their own upstream sequence number, so a test can read straight off
//! the ring which media landed, in which order, and which did not.

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

/// How the seam answers `POST /api/internal/resolve`.
#[derive(Clone)]
pub(crate) enum Seam {
    /// A grant whose target is `path` on this server. LAN-allowed, because the upstream here is loopback.
    /// `extra` is merged over the grant's top-level fields (`playerSelectable`, `policySource`, …).
    Grant { path: String, origin: bool, expires_at_ms: Option<u64>, extra: serde_json::Value },
    /// A non-2xx reply, verbatim — a refusal, an exhausted chain, a failed resolve.
    Reply(u16, String),
}

impl Seam {
    /// A plain grant for `path`, with the local origin on or off.
    pub(crate) fn grant(path: &str, origin: bool) -> Self {
        Seam::Grant { path: path.to_string(), origin, expires_at_ms: None, extra: serde_json::Value::Null }
    }

    /// An origin grant for `path` with `extra` merged over its top-level fields.
    pub(crate) fn grant_with(path: &str, extra: serde_json::Value) -> Self {
        Seam::Grant { path: path.to_string(), origin: true, expires_at_ms: None, extra }
    }
}

/// What one scripted upstream path (under `/pl/`) serves.
#[derive(Clone)]
pub(crate) enum Serve {
    /// A playlist.
    Body(String),
    /// A segment a test built byte by byte, served as `video/mp2t` — for the shapes `tagged_ts` cannot carry.
    Media(Vec<u8>),
    /// `head` at once, then the connection held open — silent — for `hold` before the body ends: a segment frozen
    /// part-way through its download.
    Stall { head: Vec<u8>, hold: Duration },
    /// A body that never ends: `unit`, over and over, one every millisecond — fast enough to fill any sane buffer
    /// within a second, and slow enough that code holding it all fails a test on its timeout rather than by
    /// exhausting the machine's memory.
    Endless(Vec<u8>),
    Status(u16),
}

/// One question the seam was asked: when (since the stand-in started), at which failover attempt, and with what
/// `reason` — the fields a test of the data plane's side of the resolve contract reads back.
#[derive(Clone, Debug)]
pub(crate) struct Call {
    pub(crate) at: Duration,
    pub(crate) attempt: u32,
    pub(crate) reason: Option<String>,
}

/// The live script: what the seam and each playlist path answer RIGHT NOW, and how often the seam was asked.
pub(crate) struct Script {
    pub(crate) seam: Seam,
    pub(crate) paths: HashMap<String, Serve>,
    pub(crate) resolves: u32,
    /// Every question the seam was asked, in order.
    pub(crate) calls: Vec<Call>,
    /// Answer every failover attempt past the channel itself (attempt >= 1) with Node's 410 `failover_exhausted`,
    /// whatever `seam` says — an UNGROUPED channel on a source with no alternate upstreams (zlive's shape).
    pub(crate) exhaust_advances: bool,
    /// What both flush endpoints reply — Node's `{ logLevel, nameservers }` echo. Empty by default: an echo that
    /// says nothing changes nothing, so every test that does not script one runs on the sidecar's own settings.
    pub(crate) echo: serde_json::Value,
}

#[derive(Clone)]
struct Shared {
    addr: SocketAddr,
    started: Instant,
    script: Arc<Mutex<Script>>,
}

/// One running stand-in, on its own loopback port.
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
            })),
        };
        let app = Router::new()
            .route("/api/internal/resolve", post(resolve))
            // The sidecar's two batched flushers post here, and read the scripted settings echo back.
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

    /// A data plane whose Node is this stand-in.
    pub(crate) fn state(&self) -> AppState {
        AppState::new(format!("http://{}", self.shared.addr), String::new())
    }

    /// The loopback port this stand-in listens on — for a test that must reach it by a NAME, not the literal.
    pub(crate) fn port(&self) -> u16 {
        self.shared.addr.port()
    }

    /// Re-script the stand-in. Takes effect on the very next request.
    pub(crate) fn script(&self, f: impl FnOnce(&mut Script)) {
        f(&mut self.shared.script.lock_ok());
    }

    /// How many times the seam has been asked to resolve.
    pub(crate) fn resolves(&self) -> u32 {
        self.shared.script.lock_ok().resolves
    }

    /// Every question the seam has been asked so far, in order.
    pub(crate) fn calls(&self) -> Vec<Call> {
        self.shared.script.lock_ok().calls.clone()
    }
}

async fn resolve(State(s): State<Shared>, Json(asked): Json<serde_json::Value>) -> Response {
    let attempt = asked.get("attempt").and_then(|a| a.as_u64()).unwrap_or(0) as u32;
    let reason = asked.get("reason").and_then(|r| r.as_str()).map(str::to_string);
    let (seam, exhausted) = {
        let mut sc = s.script.lock_ok();
        sc.resolves += 1;
        sc.calls.push(Call { at: s.started.elapsed(), attempt, reason });
        (sc.seam.clone(), sc.exhaust_advances && attempt >= 1)
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
    let serve = s.script.lock_ok().paths.get(&format!("/pl/{name}")).cloned();
    match serve {
        Some(Serve::Body(b)) => ([("content-type", "application/vnd.apple.mpegurl")], b).into_response(),
        Some(Serve::Media(b)) => ([("content-type", "video/mp2t")], b).into_response(),
        Some(Serve::Stall { head, hold }) => {
            let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(1);
            tokio::spawn(async move {
                let _ = tx.send(Ok(Bytes::from(head))).await;
                tokio::time::sleep(hold).await; // silent, and still open; dropping `tx` then ends the body
            });
            let body = Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx));
            ([("content-type", "video/mp2t")], body).into_response()
        }
        Some(Serve::Endless(unit)) => {
            let unit = Bytes::from(unit);
            let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(1);
            tokio::spawn(async move {
                // Ends when the client does: its dropped body closes the channel.
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

/// A live media playlist: `n` segments from upstream sequence `ms`, `td` seconds each, served at `/seg/<seq>`.
/// Shaped like the saved zlive capture: version 3, no key, no map, no discontinuity.
pub(crate) fn media_playlist(ms: i64, n: usize, td: u32) -> String {
    playlist_under("/seg", ms, n, td)
}

/// The same playlist, but every segment is one the undecodable watch strikes (`/bad/<seq>`).
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

/// Twelve null packets carrying `tag` in the first payload bytes: a segment the ring accepts (it opens on a
/// sync byte) and a test can recognise. It carries no PSI, so the splicer declines it and it is ringed verbatim
/// — which is what keeps the tag readable.
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

/// The tag `tagged_ts` wrote.
pub(crate) fn tag_of(bytes: &[u8]) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&bytes[4..12]);
    u64::from_be_bytes(b)
}

/// Wait until `cond` holds, or fail the test after `within`, naming what never happened.
pub(crate) async fn until(within: Duration, what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + within;
    while !cond() {
        assert!(Instant::now() < deadline, "timed out after {within:?} waiting for: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
