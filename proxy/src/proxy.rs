//! The proxy handler — a faithful port of the removed server/src/sources/core/proxyHandler.ts control flow,
//! split across the Node/Rust plane boundary. Registered as the axum fallback so it serves BOTH stream
//! mounts (/api/v1 appPlayer, /api/ext/v1 externalPlayer) with one handler, exactly like the old MARKER
//! slicing.
//!
//! ENTRY vs HOP is structural (no per-source logic here): the client's first request (from the M3U) has no
//! marker → ENTRY → call the Node resolve seam for the grant + target. Every child the sidecar rewrites is
//! minted under an `h/` marker → HOP → use the cached per-source policy + the observational SSRF allowlist.
//! Children carry `&e=<entry>` so a variant re-poll attributes to the right channel and a cold hop (after a
//! restart/eviction) can re-resolve.

use axum::body::Body;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use percent_encoding::percent_decode_str;
use std::net::IpAddr;
use std::sync::atomic::Ordering;
use std::time::Duration;
use url::Url;

use crate::manifest::{enc, rewrite_manifest, RewriteResult};
use crate::state::{AppState, SourcePolicy};
use crate::stream::{segment_body, TelemetryCtx};

// RSL-3 upstream retry. A transient failure (transport error, or a 502/503/504 gateway status) is retried with
// bounded backoff before the request is failed; a definitive response (2xx, 4xx, or a non-gateway 5xx) is used
// as-is. Kept small so a genuinely dead upstream fails fast (the total added latency is bounded by the sum of
// RETRY_BACKOFF_MS) and a flaky CDN edge still recovers within a poll.
const MAX_UPSTREAM_RETRIES: u32 = 2; // total attempts = 1 + this
const RETRY_BACKOFF_MS: [u64; 2] = [200, 500];

/// Retryable = a transient gateway status. 404 (not live) / 403 (gate) / other 4xx and a plain 500 are
/// DEFINITIVE (retrying would just repeat them) and forwarded verbatim.
fn is_retryable_status(status: u16) -> bool {
    matches!(status, 502..=504)
}

/// Client identity for telemetry attribution, sourced per topology: the loopback SIDECAR handler reads the
/// relay-set `x-masq-*` headers; the public EDGE dispatcher (edge.rs) synthesizes it from the socket (peer/XFF
/// ip, the real `User-Agent`, the gate-resolved username). NOT part of it: `player` — `serve_stream` derives
/// that from the mount path, so an externalPlayer stream is never mislabeled appPlayer in either topology.
pub struct Identity {
    pub ip: String,
    pub ua: String,
    pub username: Option<String>,
}

/// The loopback SIDECAR stream handler (:8787) — secret-gated; identity from the relay's `x-masq-*` headers.
/// Registered as the internal listener's axum fallback; delegates to the shared `serve_stream`. The PUBLIC
/// edge path does NOT pass through here — edge.rs gates by stream token (via the auth cache), not the secret.
pub async fn proxy(
    State(state): State<AppState>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if !check_secret(&headers, &state.secret) {
        return text(403, "forbidden");
    }
    let ip = header_str(&headers, "x-masq-client-ip");
    let ua = header_str(&headers, "x-masq-client-ua");
    let username = {
        let u = header_str(&headers, "x-masq-username");
        if u.is_empty() {
            None
        } else {
            Some(u)
        }
    };
    serve_stream(state, method, uri.path(), uri.query().unwrap_or(""), Identity { ip, ua, username }).await
}

/// The shared stream engine — the faithful proxyHandler.ts control flow. Called by the sidecar handler above
/// AND by the public edge dispatcher (edge.rs, which has already run the stream-token gate + synthesized the
/// Identity). `player` is derived from the mount path here (not an inbound header).
pub async fn serve_stream(
    state: AppState,
    method: Method,
    path: &str,
    query: &str,
    id: Identity,
) -> Response {
    // Mount + marker: /api/ext/v1 is checked first (it contains /api/…/v1/, not /api/v1/).
    let (mount_path, marker): (&str, &str) = if path.contains("/api/ext/v1/") {
        ("/api/ext/v1", "/api/ext/v1/")
    } else if path.contains("/api/v1/") {
        ("/api/v1", "/api/v1/")
    } else {
        return text(404, "not found");
    };
    let after = match path.find(marker) {
        Some(i) => &path[i + marker.len()..],
        None => return text(404, "not found"),
    };
    let (source, rest) = match after.split_once('/') {
        Some(pair) => pair,
        None => return text(400, "bad request: missing stream path"),
    };
    if source.is_empty() {
        return text(400, "bad request: missing source");
    }
    // HOP if the segment after the source is the `h/` marker; else ENTRY.
    let (is_hop, encoded) = match rest.split_once('/') {
        Some(("h", e)) => (true, e),
        _ => (false, rest),
    };
    let decoded = match dec(encoded) {
        Some(s) => s,
        None => return text(400, "bad request: malformed encoded url"),
    };

    let (token, pl, e_param) = parse_query(query);
    let ip = id.ip;
    let ua = id.ua;
    let username = id.username;
    let player = if mount_path == "/api/ext/v1" {
        "externalPlayer"
    } else {
        "appPlayer"
    };

    // Resolve the policy + the URL to fetch + the stream's entry (for telemetry attribution). fetch_url is `mut`
    // so the RSL ENTRY failover below can swap in a freshly-resolved master when the first target is dead.
    let (policy, mut fetch_url, stream_entry) = if is_hop {
        let policy = match state.get(source) {
            Some(p) => p,
            None => {
                // Cold hop (sidecar restart / eviction): re-resolve using the propagated entry.
                let entry = e_param.clone().unwrap_or_default();
                if entry.is_empty() {
                    return text(400, "bad request: no cached stream");
                }
                match state.resolve_entry(source, &entry, pl.as_deref()).await {
                    Ok((p, _)) => p,
                    Err(err) => {
                        // A cold-hop re-resolve failed (session/mirror gone) — the channel can't produce a
                        // stream, so mark it failed (a resolve failure has no HTTP status → 502 sentinel).
                        state.report(serde_json::json!({
                            "kind": "upstream", "ok": false, "status": 502, "source": source, "entryUrl": entry.as_str(),
                        }));
                        return text(502, &format!("resolve failed: {err}"));
                    }
                }
            }
        };
        (policy, decoded.clone(), e_param.clone().unwrap_or_default())
    } else {
        match state.resolve_entry(source, &decoded, pl.as_deref()).await {
            Ok((p, target)) => (p, target, decoded.clone()),
            Err(err) => {
                // The channel could not be resolved (unknown source / dead upstream / expired auth) — mark it
                // failed (a resolve failure has no HTTP status → 502 sentinel → noteFailed → `failed`).
                state.report(serde_json::json!({
                    "kind": "upstream", "ok": false, "status": 502, "source": source, "entryUrl": decoded.as_str(),
                }));
                return text(502, &format!("resolve failed: {err}"));
            }
        }
    };

    // SSRF gate on direct hops only (the entry's target is trusted resolve output).
    if is_hop && !ssrf_ok(&policy, &fetch_url) {
        return text(400, "bad request: upstream host not allowed");
    }

    // RSL per-stream knobs (NOT client-level): idle/read timeout for stall detection + read-ahead buffer depth.
    let read_timeout_ms = policy.read_timeout_ms.load(Ordering::Relaxed);
    let buffer_size_kb = policy.buffer_size_kb.load(Ordering::Relaxed);

    // Fetch upstream with RSL retry (transient transport error / 502/503/504 → bounded backoff; 4xx and other
    // definitive responses are used as-is). Client cached by (connect_timeout, max_redirects) — PXY-2; headers
    // replayed from the (possibly just-refreshed) policy.
    let client = state.client_for(
        policy.connect_timeout_ms.load(Ordering::Relaxed),
        policy.max_redirects.load(Ordering::Relaxed),
    );
    let mut resp = fetch_with_retry(&client, &fetch_url, &build_headers(&policy), read_timeout_ms)
        .await
        .ok();

    // RSL mirror failover on a persistent fetch failure:
    //  · ENTRY — the resolved master is dead (the mirror rotated between resolve and fetch). Drop the cached
    //    target and force a FRESH resolve (Node re-runs resolveStream → dlhd/dami reprobeMirror), then fetch the
    //    new master. `policy` is the same cached Arc, re-populated in place by the fresh resolve.
    //  · HOP — a child segment/variant host died; a fresh master can't be substituted for a child mid-poll, so
    //    kick a best-effort async policy refresh (so a re-requested entry / cold hop rides the live mirror) and
    //    fail this request (the player refetches).
    if resp.is_none() {
        if is_hop {
            if !stream_entry.is_empty() {
                let (st, src, ent, plc) =
                    (state.clone(), source.to_string(), stream_entry.clone(), pl.clone());
                tokio::spawn(async move {
                    let _ = st.resolve_fresh(&src, &ent, plc.as_deref()).await;
                });
            }
        } else {
            state.invalidate_target(source, &stream_entry);
            if let Ok((_p, target2)) = state.resolve_fresh(source, &stream_entry, pl.as_deref()).await {
                let client2 = state.client_for(
                    policy.connect_timeout_ms.load(Ordering::Relaxed),
                    policy.max_redirects.load(Ordering::Relaxed),
                );
                if let Ok(r) =
                    fetch_with_retry(&client2, &target2, &build_headers(&policy), read_timeout_ms).await
                {
                    fetch_url = target2;
                    resp = Some(r);
                }
            }
        }
    }

    let resp = match resp {
        Some(r) => r,
        None => {
            // Retries (+ entry failover) exhausted → a transport-level failure with no HTTP response → a
            // TRANSIENT upstream failure (status 0 ⇒ noteFailure), then a 502 to the client.
            state.report(serde_json::json!({
                "kind": "upstream", "ok": false, "status": 0, "source": source, "entryUrl": stream_entry.as_str(),
            }));
            return text(502, "upstream fetch failed (after retries)");
        }
    };

    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        // A DEFINITIVE non-2xx response (404 = not live, 403 = gate, 5xx = upstream error). Report it so the
        // phase machine drops straight to `failed` (a real status ⇒ noteFailed), then forward it verbatim.
        state.report(serde_json::json!({
            "kind": "upstream", "ok": false, "status": status, "source": source, "entryUrl": stream_entry.as_str(),
        }));
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("text/plain")
            .to_string();
        let body = resp.bytes().await.unwrap_or_default();
        return raw(status, &ct, body.to_vec());
    }

    let final_url = resp.url().clone();
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if is_manifest(&final_url, &fetch_url, &ct) {
        // Bound the manifest read by the same idle timeout (a manifest is small; a hang here is a stalled
        // upstream → a transient failure, not a definitive one).
        let read = resp.text();
        let text_body = if read_timeout_ms > 0 {
            match tokio::time::timeout(Duration::from_millis(read_timeout_ms), read).await {
                Ok(Ok(t)) => t,
                Ok(Err(err)) => return text(502, &format!("read manifest failed: {err}")),
                Err(_) => {
                    state.report(serde_json::json!({
                        "kind": "upstream", "ok": false, "status": 0, "source": source, "entryUrl": stream_entry.as_str(),
                    }));
                    return text(502, "read manifest timed out");
                }
            }
        } else {
            match read.await {
                Ok(t) => t,
                Err(err) => return text(502, &format!("read manifest failed: {err}")),
            }
        };
        // DST: continuous raw-TS output on the external mount when the (Default)/(Custom) proxyconfig selects
        // outputFormat 'ts' AND the upstream is pure MPEG-TS. Only on the ENTRY (the client then holds ONE TS
        // socket and issues no HOP polls). Not eligible (fMP4 / AES / no reachable variant) → fall through to
        // the HLS rewrite below (text_body + final_url are cloned so the fallback still owns them).
        if !is_hop && mount_path == "/api/ext/v1" && policy.output_format.read().unwrap().as_str() == "ts" {
            let ts_ctx = crate::tsmux::TsContext {
                state: state.clone(),
                policy: policy.clone(),
                source: source.to_string(),
                entry: stream_entry.clone(),
                pl: pl.clone(),
                client: state.client_for(
                    policy.connect_timeout_ms.load(Ordering::Relaxed),
                    policy.max_redirects.load(Ordering::Relaxed),
                ),
                read_timeout_ms,
                ip: ip.clone(),
                ua: ua.clone(),
                username: username.clone(),
            };
            if let Some(ts) =
                crate::tsmux::try_ts_response(text_body.clone(), final_url.clone(), ts_ctx, buffer_size_kb).await
            {
                return ts;
            }
        }

        let prefix = format!("{mount_path}/{source}/h/");
        let suffix = build_child_query(token.as_deref(), pl.as_deref(), &stream_entry);
        let RewriteResult { body, hosts, media } = rewrite_manifest(&text_body, &final_url, &prefix, &suffix);
        // Grow the source's SSRF allowlist with every host referenced in the manifest (dynamic-allow).
        if !hosts.is_empty() {
            let mut set = policy.hosts.write().unwrap();
            for h in hosts {
                set.insert(h);
            }
        }
        // DEC: manifest-declared decode metadata (master #EXT-X-STREAM-INF + media-playlist container hint).
        // Node merges the master + variant polls per channel and humanizes for Active Streams. Only emit when
        // something was learned so a plain media playlist doesn't spam empty events.
        if media.any() {
            state.report(serde_json::json!({
                "kind": "media", "source": source, "entryUrl": stream_entry.as_str(),
                "resolution": media.resolution, "codecs": media.codecs,
                "frameRate": media.frame_rate, "container": media.container, "bandwidth": media.bandwidth,
            }));
        }
        // Telemetry: a served manifest poll is the viewer heartbeat (also carries the manifest byte count) AND
        // a 2xx upstream success that drives the phase machine establishing→live.
        state.report(serde_json::json!({
            "kind": "viewer", "source": source, "entryUrl": stream_entry.as_str(),
            "ip": ip, "ua": ua, "username": username, "playerType": player,
            "bytes": body.len() as u64,
        }));
        return manifest_response(body);
    }

    // Segment (or any non-manifest): relabel the content-type per the source, then stream via the RSL counted +
    // bounded-buffer + stall-guarded pipe (stream::segment_body). It reports ACCURATE egress at end-of-body
    // (including chunked / no-Content-Length segments the old header-based count missed — which also cured the
    // false client-side buffering that undercount produced), turns an idle stall / mid-body error into a
    // transient upstream event, and reports the partial bytes actually delivered on a client disconnect. HEAD
    // carries no body.
    let out_ct = policy
        .relabel_segment
        .read()
        .unwrap()
        .clone()
        .unwrap_or_else(|| {
            if ct.is_empty() {
                "application/octet-stream".to_string()
            } else {
                ct.clone()
            }
        });
    if method == Method::HEAD {
        return raw(200, &out_ct, Vec::new());
    }
    let ctx = TelemetryCtx {
        state: state.clone(),
        source: source.to_string(),
        entry: stream_entry.clone(),
        ip,
        ua,
        username,
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", out_ct)
        .header("cache-control", "no-store")
        .body(segment_body(resp, ctx, read_timeout_ms, buffer_size_kb))
        .unwrap()
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────

pub(crate) fn check_secret(h: &HeaderMap, secret: &str) -> bool {
    if secret.is_empty() {
        return true; // no secret configured (manual dev run) → allow; Node always sets one in prod
    }
    h.get("x-masq-secret").and_then(|v| v.to_str().ok()) == Some(secret)
}

pub(crate) fn header_str(h: &HeaderMap, k: &str) -> String {
    h.get(k)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

fn dec(s: &str) -> Option<String> {
    percent_decode_str(s).decode_utf8().ok().map(|c| c.into_owned())
}

pub(crate) fn parse_query(q: &str) -> (Option<String>, Option<String>, Option<String>) {
    let (mut token, mut pl, mut e) = (None, None, None);
    for (k, v) in url::form_urlencoded::parse(q.as_bytes()) {
        match k.as_ref() {
            "token" => token = Some(v.into_owned()),
            "pl" => pl = Some(v.into_owned()),
            "e" => e = Some(v.into_owned()),
            _ => {}
        }
    }
    (token, pl, e)
}

fn build_child_query(token: Option<&str>, pl: Option<&str>, e: &str) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(t) = token {
        parts.push(format!("token={}", enc(t)));
    }
    if let Some(p) = pl {
        parts.push(format!("pl={}", enc(p)));
    }
    parts.push(format!("e={}", enc(e))); // always carry the entry for hop attribution + cold re-resolve
    format!("?{}", parts.join("&"))
}

fn is_manifest(final_url: &Url, orig: &str, ct: &str) -> bool {
    if ct.contains("mpegurl") {
        return true;
    }
    let ends_m3u8 = |p: &str| p.to_ascii_lowercase().ends_with(".m3u8");
    if ends_m3u8(final_url.path()) {
        return true;
    }
    match Url::parse(orig) {
        Ok(u) => ends_m3u8(u.path()),
        Err(_) => ends_m3u8(orig),
    }
}

pub(crate) fn is_private_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => {
                v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified()
            }
            IpAddr::V6(v6) => {
                v6.is_loopback()
                    || v6.is_unspecified()
                    || (v6.segments()[0] & 0xfe00) == 0xfc00 // ULA fc00::/7
                    || (v6.segments()[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
            }
        };
    }
    false
}

fn ssrf_ok(policy: &SourcePolicy, url: &str) -> bool {
    let u = match Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };
    if !matches!(u.scheme(), "http" | "https") {
        return false;
    }
    let host = match u.host_str() {
        Some(h) => h.to_lowercase(),
        None => return false,
    };
    if !policy.allow_private.load(Ordering::Relaxed) && is_private_host(&host) {
        return false;
    }
    policy.hosts.read().unwrap().contains(&host)
}

pub(crate) fn build_headers(policy: &SourcePolicy) -> reqwest::header::HeaderMap {
    use reqwest::header::{HeaderMap as RHeaderMap, HeaderName, HeaderValue};
    let mut hm = RHeaderMap::new();
    let snapshot: Vec<(String, String)> = policy.headers.read().unwrap().clone();
    for (k, v) in snapshot {
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(&v),
        ) {
            hm.insert(name, val);
        }
    }
    hm
}

/// Fetch an upstream URL with RSL retry (transport error + 502/503/504 → bounded-backoff retry; 4xx / other
/// definitive responses returned as-is). `read_timeout_ms` (when >0) bounds the wait for RESPONSE HEADERS —
/// a connect-but-never-answer stall — per attempt; the body-stall case is handled downstream in stream::pump.
/// Returns the final Response (which may be a definitive non-2xx to forward verbatim) or the last error string
/// after every attempt fails at the transport level.
pub(crate) async fn fetch_with_retry(
    client: &reqwest::Client,
    url: &str,
    headers: &reqwest::header::HeaderMap,
    read_timeout_ms: u64,
) -> Result<reqwest::Response, String> {
    let idle = if read_timeout_ms > 0 {
        Some(Duration::from_millis(read_timeout_ms))
    } else {
        None
    };
    let mut last_err = String::from("upstream unreachable");
    for attempt in 0..=MAX_UPSTREAM_RETRIES {
        if attempt > 0 {
            let backoff = RETRY_BACKOFF_MS.get((attempt - 1) as usize).copied().unwrap_or(500);
            tokio::time::sleep(Duration::from_millis(backoff)).await;
        }
        let send = client.get(url).headers(headers.clone()).send();
        let res = match idle {
            Some(d) => match tokio::time::timeout(d, send).await {
                Ok(r) => r,
                Err(_) => {
                    last_err = "timed out awaiting upstream response".to_string();
                    continue;
                }
            },
            None => send.await,
        };
        match res {
            Ok(resp) => {
                let s = resp.status().as_u16();
                if is_retryable_status(s) && attempt < MAX_UPSTREAM_RETRIES {
                    last_err = format!("upstream {s}");
                    continue;
                }
                return Ok(resp);
            }
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        }
    }
    Err(last_err)
}

pub(crate) fn text(code: u16, msg: &str) -> Response {
    Response::builder()
        .status(StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header("content-type", "text/plain")
        .body(Body::from(msg.to_string()))
        .unwrap()
}

fn raw(code: u16, ct: &str, bytes: Vec<u8>) -> Response {
    Response::builder()
        .status(StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY))
        .header("content-type", ct)
        .header("cache-control", "no-store")
        .body(Body::from(bytes))
        .unwrap()
}

fn manifest_response(body: String) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/vnd.apple.mpegurl")
        .header("cache-control", "no-store")
        .body(Body::from(body))
        .unwrap()
}
