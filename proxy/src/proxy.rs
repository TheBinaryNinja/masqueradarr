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
use url::Url;

use crate::manifest::{enc, rewrite_manifest, RewriteResult};
use crate::state::{AppState, SourcePolicy};

pub async fn proxy(
    State(state): State<AppState>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    // The relay (or the sidecar's own edge, later) must carry the shared secret.
    if !check_secret(&headers, &state.secret) {
        return text(403, "forbidden");
    }

    let path = uri.path();
    let query = uri.query().unwrap_or("");

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
    let player = if header_str(&headers, "x-masq-player") == "externalPlayer" {
        "externalPlayer"
    } else {
        "appPlayer"
    };

    // Resolve the policy + the URL to fetch + the stream's entry (for telemetry attribution).
    let (policy, fetch_url, stream_entry) = if is_hop {
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

    // Fetch upstream (headers replayed from the policy; redirects followed).
    let req_headers = build_headers(&policy);
    let resp = match state.client.get(fetch_url.as_str()).headers(req_headers).send().await {
        Ok(r) => r,
        Err(err) => {
            // A transport/fetch error yields NO HTTP response → a TRANSIENT upstream failure. Report it so
            // Node's phase machine spends a retry (status 0 ⇒ noteFailure), then surface a 502 to the client.
            state.report(serde_json::json!({
                "kind": "upstream", "ok": false, "status": 0, "source": source, "entryUrl": stream_entry.as_str(),
            }));
            return text(502, &format!("upstream fetch failed: {err}"));
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
        let text_body = match resp.text().await {
            Ok(t) => t,
            Err(err) => return text(502, &format!("read manifest failed: {err}")),
        };
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

    // Segment (or any non-manifest): relabel the content-type per the source, count bytes, pipe through.
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
    if let Some(n) = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
    {
        if n > 0 {
            // Bytes carry source+entryUrl too: noteBytes attributes egress by client identity, but the phase
            // machine uses the channel key to note a segment as a 2xx success (keeps a live channel `live`).
            state.report(serde_json::json!({
                "kind": "bytes", "source": source, "entryUrl": stream_entry.as_str(),
                "ip": ip, "ua": ua, "username": username, "bytes": n,
            }));
        }
    }
    if method == Method::HEAD {
        return raw(200, &out_ct, Vec::new());
    }
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", out_ct)
        .header("cache-control", "no-store")
        .body(Body::from_stream(resp.bytes_stream()))
        .unwrap()
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────

pub(crate) fn check_secret(h: &HeaderMap, secret: &str) -> bool {
    if secret.is_empty() {
        return true; // no secret configured (manual dev run) → allow; Node always sets one in prod
    }
    h.get("x-masq-secret")
        .and_then(|v| v.to_str().ok())
        .map_or(false, |v| v == secret)
}

fn header_str(h: &HeaderMap, k: &str) -> String {
    h.get(k)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

fn dec(s: &str) -> Option<String> {
    percent_decode_str(s).decode_utf8().ok().map(|c| c.into_owned())
}

fn parse_query(q: &str) -> (Option<String>, Option<String>, Option<String>) {
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

fn is_private_host(host: &str) -> bool {
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

fn build_headers(policy: &SourcePolicy) -> reqwest::header::HeaderMap {
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
