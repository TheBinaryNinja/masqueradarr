//! EDGE-3 — the public edge router. When Node spawns the sidecar with `MASQ_EDGE` set (see
//! `server/src/proxy/sidecar.ts`), Rust binds a SECOND, public listener whose fallback is `edge_dispatch`.
//! It makes Rust the front door: it serves the two stream mounts in-process (gated by the stream token via the
//! auth cache — NOT the loopback secret, which a public client can't have) and reverse-proxies EVERYTHING else
//! — the SPA, `/api/*`, the token-free m3u/compose downloads, and all four WebSocket upgrades — back to Node on
//! its now-loopback internal port. Node stays the control plane (resolve/authorize/telemetry) + WS authority.
//!
//! The loopback internal listener (`/health` + `/probe`, secret-gated) is UNCHANGED and still exists in edge
//! mode — so `/probe` never becomes internet-facing and `probeAll.ts` keeps dialing `127.0.0.1:8787`.

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::header::{HeaderName, HeaderValue};
use axum::http::{HeaderMap, Method, Response, StatusCode};
use bytes::Bytes;
use http_body_util::{BodyExt, BodyStream, Empty};
use hyper_util::rt::TokioIo;
use std::net::SocketAddr;
use tokio_stream::StreamExt;

use crate::log;
use crate::proxy::{header_str, parse_query, serve_stream, text, Identity};
use crate::state::AppState;

// RFC 7230 §6.1 hop-by-hop headers — never forwarded across a proxy hop (they describe the single connection,
// not the message). Stripped in BOTH directions on the reverse-proxy leg.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

fn is_hop_by_hop(name: &str) -> bool {
    HOP_BY_HOP.iter().any(|h| name.eq_ignore_ascii_case(h))
}

/// The public listener's fallback. Stream mounts are served in-process (after the per-request token gate);
/// everything else is reverse-proxied to Node (a WebSocket upgrade splice, or a plain HTTP relay).
pub async fn edge_dispatch(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response<Body> {
    let path = req.uri().path().to_string();
    if let Some(source) = stream_source(&path) {
        log::trace("edge", "", || format!("edge route: STREAM src={source} path={path}"));
        return edge_stream(state, peer, req, source.to_string()).await;
    }
    if is_websocket_upgrade(req.headers()) {
        log::trace("edge", "", || format!("edge route: WS-splice → node ({path})"));
        return ws_proxy(&state, req).await;
    }
    log::trace("edge", "", || format!("edge route: HTTP-proxy → node ({path})"));
    http_proxy(&state, peer, req).await
}

// ── stream branch ───────────────────────────────────────────────────────────────────────────────────────

/// The source path segment if `path` is one of the two stream mounts, else None (→ reverse-proxy branch).
/// GATES ONLY these two prefixes — the else-branch (incl. the token-free m3u/compose download) is never gated.
fn stream_source(path: &str) -> Option<&str> {
    let marker = if path.contains("/api/ext/v1/") {
        "/api/ext/v1/"
    } else if path.contains("/api/v1/") {
        "/api/v1/"
    } else {
        return None;
    };
    let after = &path[path.find(marker)? + marker.len()..];
    let source = after.split('/').next().unwrap_or("");
    if source.is_empty() {
        None
    } else {
        Some(source)
    }
}

async fn edge_stream(state: AppState, peer: SocketAddr, req: Request, source: String) -> Response<Body> {
    let uri = req.uri().clone();
    let method = req.method().clone();
    let path = uri.path().to_string();
    let query = uri.query().unwrap_or("").to_string();

    // Pull the token + synthesized identity from the request BEFORE the gate await ends the header borrow.
    // On the public edge inbound `x-masq-*` are IGNORED (a public client could forge them) — identity is
    // derived server-side: ip from XFF-or-peer, ua from the real User-Agent, username from the gate.
    let (token, pl, ip, ua) = {
        let headers = req.headers();
        let (t, p, _e) = parse_query(&query);
        (t.unwrap_or_default(), p, client_ip(headers, peer), header_str(headers, "user-agent"))
    };

    // The per-request stream-token gate (auth cache → Node). Runs on ENTRY and every HOP, so revocation takes
    // effect within the cache TTL. Deny → the exact 401/403 + plain text the sidecar-mode streamGate returns.
    // `pl` rides along because it selects the playlist's data-plane config Node-side, so it is part of what is
    // being authorized — and therefore part of the cache key.
    let username = match state.authorize(&token, &source, pl.as_deref()).await {
        Ok(u) => {
            log::trace("edge", "", || format!("stream-token gate ALLOW src={source} user={}", u.as_deref().unwrap_or("-")));
            u
        }
        Err((status, msg)) => {
            log::warn("edge", "", || format!("stream-token gate DENY {status} src={source} ip={ip}"));
            return text(status, &msg);
        }
    };

    serve_stream(state, method, &path, &query, Identity { ip, ua, username }).await
}

/// Real client IP: trust an inbound `X-Forwarded-For` (a fronting TLS terminator / LB set it — take the FIRST
/// hop, the origin client) else the socket peer. Mirrors Node's `trust proxy: true` posture so Active Streams
/// geo/attribution is right whether Rust is the outermost edge or sits behind an operator's proxy.
fn client_ip(headers: &HeaderMap, peer: SocketAddr) -> String {
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        let first = xff.split(',').next().unwrap_or("").trim();
        if !first.is_empty() {
            return first.to_string();
        }
    }
    peer.ip().to_string()
}

// ── reverse-proxy branch: plain HTTP ────────────────────────────────────────────────────────────────────

fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    let has = |name: &str, needle: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_ascii_lowercase().contains(needle))
            .unwrap_or(false)
    };
    has("upgrade", "websocket") && has("connection", "upgrade")
}

/// `node_url` ("http://127.0.0.1:8080") → the authority ("127.0.0.1:8080") for a raw TcpStream connect.
fn node_authority(node_url: &str) -> &str {
    node_url
        .strip_prefix("http://")
        .or_else(|| node_url.strip_prefix("https://"))
        .unwrap_or(node_url)
        .trim_end_matches('/')
}

/// Reverse-proxy a plain HTTP request to Node, streaming both bodies (so the 25/64/256 MB upload routes never
/// buffer), stripping hop-by-hop headers, and stamping X-Forwarded-* so Node's `trust proxy` keeps the real IP.
async fn http_proxy(state: &AppState, peer: SocketAddr, req: Request) -> Response<Body> {
    let (parts, body) = req.into_parts();
    let pq = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let target = format!("{}{}", state.node_url, pq);
    let orig_host = header_str(&parts.headers, "host");
    let fwd_ip = client_ip(&parts.headers, peer);

    // Forward the client headers minus hop-by-hop + Host (reqwest sets it from the target) + Content-Length (we
    // re-frame the body as a stream) + any inbound X-Forwarded-* (we set fresh, canonical ones below). `append`
    // preserves any repeated headers. HeaderMap avoids the TryFrom<&HeaderName> ambiguity of the per-header API.
    let mut fwd = HeaderMap::new();
    for (k, v) in parts.headers.iter() {
        let name = k.as_str();
        if is_hop_by_hop(name)
            || name.eq_ignore_ascii_case("host")
            || name.eq_ignore_ascii_case("content-length")
            || name.starts_with("x-forwarded-")
        {
            continue;
        }
        fwd.append(k, v.clone());
    }
    if let Ok(v) = HeaderValue::from_str(&fwd_ip) {
        fwd.insert(HeaderName::from_static("x-forwarded-for"), v);
    }
    fwd.insert(HeaderName::from_static("x-forwarded-proto"), HeaderValue::from_static("http"));
    if let Ok(v) = HeaderValue::from_str(&orig_host) {
        fwd.insert(HeaderName::from_static("x-forwarded-host"), v);
    }

    let mut rb = state.proxy_client.request(parts.method.clone(), &target).headers(fwd);

    // Only carry a body for methods that have one; stream it (chunked) so a multi-MB upload never buffers.
    if parts.method != Method::GET && parts.method != Method::HEAD {
        let stream = BodyStream::new(body).filter_map(|frame| match frame {
            Ok(f) => f.into_data().ok().map(Ok::<Bytes, axum::Error>),
            Err(e) => Some(Err(e)),
        });
        rb = rb.body(reqwest::Body::wrap_stream(stream));
    }

    let resp = match rb.send().await {
        Ok(r) => r,
        Err(e) => {
            log::warn("edge", "", || format!("reverse-proxy to node failed ({pq}): {e}"));
            return text(502, &format!("edge: node unreachable: {e}"));
        }
    };

    let mut builder = Response::builder().status(resp.status());
    if let Some(h) = builder.headers_mut() {
        for (k, v) in resp.headers().iter() {
            if !is_hop_by_hop(k.as_str()) {
                h.append(k, v.clone());
            }
        }
    }
    builder.body(Body::from_stream(resp.bytes_stream())).unwrap_or_else(|_| text(502, "edge: bad response"))
}

// ── reverse-proxy branch: WebSocket upgrade ─────────────────────────────────────────────────────────────

/// Splice a client WebSocket upgrade through to Node. The client's handshake is forwarded VERBATIM (Host +
/// Origin preserved so Node's `sameOrigin` accepts it), Node's `101` + `Sec-WebSocket-Accept` are relayed
/// back, and the two upgraded connections are copied bidirectionally. Covers all four Node WebSockets.
async fn ws_proxy(state: &AppState, mut req: Request) -> Response<Body> {
    // Capture the client-side upgrade future before consuming the request for the outbound handshake.
    let client_upgrade = hyper::upgrade::on(&mut req);
    let (parts, _body) = req.into_parts();
    let pq = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/").to_string();

    // Dial Node and run an HTTP/1 client connection that is driven WITH upgrades — omitting `.with_upgrades()`
    // is the classic footgun that makes `hyper::upgrade::on(node_resp)` hang forever.
    let stream = match tokio::net::TcpStream::connect(node_authority(&state.node_url)).await {
        Ok(s) => s,
        Err(e) => return text(502, &format!("edge: node ws connect failed: {e}")),
    };
    let _ = stream.set_nodelay(true); // low-latency control/screencast frames (client side is the server default)
    let (mut sender, conn) = match hyper::client::conn::http1::handshake(TokioIo::new(stream)).await {
        Ok(x) => x,
        Err(e) => return text(502, &format!("edge: node ws handshake failed: {e}")),
    };
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });

    // Build the outbound upgrade request in origin form (path+query), forwarding the handshake headers verbatim
    // (Host/Origin/Sec-WebSocket-* + Upgrade/Connection — all load-bearing for the handshake + Node sameOrigin).
    let mut out = axum::http::Request::builder().method(parts.method.clone()).uri(pq);
    if let Some(h) = out.headers_mut() {
        for (k, v) in parts.headers.iter() {
            h.append(k, v.clone());
        }
    }
    let out_req = match out.body(Empty::<Bytes>::new()) {
        Ok(r) => r,
        Err(_) => return text(502, "edge: bad ws request"),
    };
    let mut node_resp = match sender.send_request(out_req).await {
        Ok(r) => r,
        Err(e) => return text(502, &format!("edge: node ws request failed: {e}")),
    };

    // Not a 101 (e.g. Node's sameOrigin rejected the upgrade, or the path is not a WS route) → relay verbatim.
    if node_resp.status() != StatusCode::SWITCHING_PROTOCOLS {
        let (rp, rbody) = node_resp.into_parts();
        let bytes = rbody.collect().await.map(|c| c.to_bytes()).unwrap_or_default();
        let mut builder = Response::builder().status(rp.status);
        if let Some(h) = builder.headers_mut() {
            for (k, v) in rp.headers.iter() {
                if !is_hop_by_hop(k.as_str()) {
                    h.append(k, v.clone());
                }
            }
        }
        return builder.body(Body::from(bytes)).unwrap_or_else(|_| text(502, "edge: bad ws response"));
    }

    // 101: take Node's upgrade future, then relay its handshake response to the client verbatim.
    let node_upgrade = hyper::upgrade::on(&mut node_resp);
    let mut client_resp = Response::builder().status(StatusCode::SWITCHING_PROTOCOLS);
    if let Some(h) = client_resp.headers_mut() {
        for (k, v) in node_resp.headers().iter() {
            h.append(k, v.clone());
        }
    }

    // Once the client 101 is sent, `client_upgrade` resolves; splice the two upgraded byte streams.
    tokio::spawn(async move {
        match tokio::try_join!(client_upgrade, node_upgrade) {
            Ok((client_io, node_io)) => {
                let mut c = TokioIo::new(client_io);
                let mut n = TokioIo::new(node_io);
                let _ = tokio::io::copy_bidirectional(&mut c, &mut n).await;
            }
            Err(_) => { /* one side failed to upgrade — nothing to splice */ }
        }
    });

    client_resp.body(Body::empty()).unwrap_or_else(|_| text(502, "edge: bad ws upgrade"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_stream_mounts() {
        assert_eq!(stream_source("/api/v1/dlhd/aHR0cA"), Some("dlhd"));
        assert_eq!(stream_source("/api/ext/v1/dami/h/aHR0cA"), Some("dami"));
        assert_eq!(stream_source("/api/v1/dulo/x"), Some("dulo"));
    }

    #[test]
    fn non_stream_paths_are_not_gated() {
        assert_eq!(stream_source("/"), None);
        assert_eq!(stream_source("/api/health"), None);
        assert_eq!(stream_source("/assets/app.js"), None);
        assert_eq!(stream_source("/john-a1b2c3.m3u"), None); // token-free m3u download — must NOT gate
        assert_eq!(stream_source("/api/stream-stats"), None); // a WS path
        assert_eq!(stream_source("/api/v1/"), None); // no source segment
    }

    #[test]
    fn hop_by_hop_detection() {
        assert!(is_hop_by_hop("Connection"));
        assert!(is_hop_by_hop("transfer-encoding"));
        assert!(is_hop_by_hop("UPGRADE"));
        assert!(!is_hop_by_hop("content-type"));
        assert!(!is_hop_by_hop("authorization"));
    }

    #[test]
    fn node_authority_strips_scheme() {
        assert_eq!(node_authority("http://127.0.0.1:8080"), "127.0.0.1:8080");
        assert_eq!(node_authority("http://127.0.0.1:8080/"), "127.0.0.1:8080");
    }

    #[test]
    fn xff_first_hop_wins() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", "203.0.113.7, 10.0.0.1".parse().unwrap());
        let peer: SocketAddr = "10.0.0.9:5000".parse().unwrap();
        assert_eq!(client_ip(&h, peer), "203.0.113.7");
        // No XFF → the socket peer.
        assert_eq!(client_ip(&HeaderMap::new(), peer), "10.0.0.9");
    }

    #[test]
    fn detects_ws_upgrade() {
        let mut h = HeaderMap::new();
        h.insert("upgrade", "websocket".parse().unwrap());
        h.insert("connection", "Upgrade".parse().unwrap());
        assert!(is_websocket_upgrade(&h));
        assert!(!is_websocket_upgrade(&HeaderMap::new()));
    }
}
