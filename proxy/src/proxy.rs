
use axum::body::Body;
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use percent_encoding::percent_decode_str;
use std::borrow::Cow;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use url::Url;

use crate::log;
use crate::manifest::{enc, rewrite_manifest, RewriteResult};
use crate::state::{AppState, ResolveErr, SourcePolicy, MAX_FAILOVER_ATTEMPTS};
use crate::stream::{segment_body, TelemetryCtx};
use crate::sync::RwExt;

pub(crate) const MAX_UPSTREAM_RETRIES: u32 = 2;
const RETRY_BACKOFF_MS: [u64; 2] = [200, 500];

fn is_retryable_status(status: u16) -> bool {
    matches!(status, 502..=504)
}

pub struct Identity {
    pub ip: String,
    pub ua: String,
    pub username: Option<String>,
}

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

pub async fn serve_stream(
    state: AppState,
    method: Method,
    path: &str,
    query: &str,
    id: Identity,
) -> Response {
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
    if let Some(("o", tail)) = rest.split_once('/') {
        let (enc_entry, file) = match tail.rsplit_once('/') {
            Some(p) => p,
            None => return text(400, "bad request: malformed origin segment path"),
        };
        let entry = match dec(enc_entry) {
            Some(s) => s,
            None => return text(400, "bad request: malformed encoded url"),
        };
        let rid = log::rid(source, &entry);
        let lane = match file {
            "v.m3u8" => Some(crate::origin::Lane::Video),
            "a.m3u8" => Some(crate::origin::Lane::Audio),
            _ => None,
        };
        if let Some(lane) = lane {
            let (token, pl, _) = parse_query(query);
            return crate::origin::serve_playlist(&state, mount_path, source, &entry, lane, token.as_deref(), pl.as_deref(), &id, &rid).await;
        }
        return crate::origin::serve_segment(&state, source, &entry, file, &id, &rid).await;
    }
    let (is_hop, encoded) = match rest.split_once('/') {
        Some(("h", e)) => (true, crate::manifest::strip_hop_tail(e)),
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

    let entry_for_rid = if is_hop {
        e_param.clone().unwrap_or_default()
    } else {
        decoded.clone()
    };
    let rid = log::rid(source, &entry_for_rid);
    log::info("proxy", &rid, || {
        format!("▶ {method} {player} src={source} {}", if is_hop { "hop" } else { "entry" })
    });
    log::trace("proxy", &rid, || {
        format!(
            "request url={decoded} ip={ip} ua={} token={} pl={}",
            if ua.is_empty() { "-" } else { ua.as_str() },
            if token.is_some() { "yes" } else { "no" },
            pl.as_deref().unwrap_or("-"),
        )
    });

    let mut prefetched: Option<reqwest::Response> = None;
    let (mut policy, mut fetch_url, stream_entry) = if is_hop {
        let hop_entry = e_param.clone().unwrap_or_default();
        let policy = match state.hop_policy(source, &hop_entry) {
            Some(p) => {
                log::trace("proxy", &rid, || format!("hop → cached policy, fetch {}", host_of(&decoded)));
                p
            }
            None => {
                let entry = e_param.clone().unwrap_or_default();
                if entry.is_empty() {
                    log::error("proxy", &rid, || "cold hop with no propagated entry (&e=) — cannot resolve".to_string());
                    return text(400, "bad request: no cached stream");
                }
                log::info("proxy", &rid, || "cold hop (no cached policy) — re-resolving from entry".to_string());
                match state.resolve_entry(source, &entry, pl.as_deref()).await {
                    Ok((p, _)) => p,
                    Err(ResolveErr::Refused(why)) => {
                        log::info("proxy", &rid, || format!("cold-hop re-resolve refused — {why}"));
                        return text(429, &why);
                    }
                    Err(err) => {
                        log::error("proxy", &rid, || format!("cold-hop re-resolve failed: {err}"));
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
            Ok((p, target)) => {
                log::info("proxy", &rid, || format!("entry resolved → {}", host_of(&target)));
                (p, target, decoded.clone())
            }
            Err(ResolveErr::Refused(why)) => {
                log::info("proxy", &rid, || format!("entry refused by the source's stream cap — {why}"));
                return text(429, &why);
            }
            Err(err) => {
                log::error("proxy", &rid, || format!("entry resolve failed: {err}"));
                let (walk_children, on_definite) = failover_knobs(&state, source);
                let walked = if walk_children {
                    let cursor = state.cursor_attempt(source, &decoded);
                    let (start, wrap) = if matches!(err, ResolveErr::Exhausted) {
                        state.reset_cursor(source, &decoded);
                        (0, false)
                    } else {
                        (cursor.saturating_add(1), cursor > 0)
                    };
                    failover_walk(&state, source, &decoded, pl.as_deref(), true, on_definite, None, start, wrap, &rid)
                        .await
                } else {
                    WalkOutcome::Dead
                };
                match walked {
                    WalkOutcome::Recovered(p, target, r) => {
                        prefetched = Some(r);
                        (p, target, decoded.clone())
                    }
                    WalkOutcome::Refused(why) => return text(429, &why),
                    WalkOutcome::Definitive(p, r) => {
                        prefetched = Some(r);
                        (p, decoded.clone(), decoded.clone())
                    }
                    WalkOutcome::Dead => {
                        state.report(serde_json::json!({
                            "kind": "upstream", "ok": false, "status": 502, "source": source, "entryUrl": decoded.as_str(),
                        }));
                        return text(502, &format!("resolve failed: {err}"));
                    }
                }
            }
        }
    };

    let ident = Identity { ip: ip.clone(), ua: ua.clone(), username: username.clone() };
    if !is_hop && policy.origin_enabled.load(Ordering::Relaxed) {
        if let Some(r) =
            serve_from_origin(&state, &policy, mount_path, source, &stream_entry, token.as_deref(), pl.as_deref(), &ident, &rid)
                .await
        {
            return r;
        }
    }

    let allowed = if is_hop {
        ssrf_ok(&policy, &fetch_url)
    } else {
        ssrf_public_ok(&policy, &fetch_url)
    };
    if !allowed {
        log::warn("proxy", &rid, || {
            format!(
                "SSRF reject ({}): {} not permitted",
                if is_hop { "hop/allowlist" } else { "entry/private" },
                host_of(&fetch_url)
            )
        });
        return text(400, "bad request: upstream host not allowed");
    }

    let read_timeout_ms = policy.read_timeout_ms.load(Ordering::Relaxed);
    let buffer_size_kb = policy.buffer_size_kb.load(Ordering::Relaxed);

    let fetch_what = if is_hop { "hop" } else { "entry" };
    let mut resp = match prefetched.take() {
        Some(r) => Some(r),
        None => {
            let client = state.client_for(
                policy.connect_timeout_ms.load(Ordering::Relaxed),
                policy.max_redirects.load(Ordering::Relaxed),
            );
            fetch_with_retry(
                &client,
                &fetch_url,
                &build_headers(&policy),
                read_timeout_ms,
                &rid,
                fetch_what,
                MAX_UPSTREAM_RETRIES,
            )
            .await
            .ok()
        }
    };

    if resp.is_none() && is_hop {
        log::warn("proxy", &rid, || "hop fetch failed — kicking async policy refresh (client refetches)".to_string());
        if !stream_entry.is_empty() {
            let (st, src, ent, plc) =
                (state.clone(), source.to_string(), stream_entry.clone(), pl.clone());
            tokio::spawn(async move {
                let _ = st.resolve_fresh(&src, &ent, plc.as_deref(), None).await;
            });
        }
    } else if !is_hop {
        let walk_children = policy.failover_enabled.load(Ordering::Relaxed);
        let on_definite = policy.failover_on_definite_error.load(Ordering::Relaxed);
        let definitive_trigger = walk_children
            && on_definite
            && matches!(&resp, Some(r) if !r.status().is_success());
        if resp.is_none() || definitive_trigger {
            log::warn("proxy", &rid, || "entry fetch failed — walking failover candidates (fresh resolve first)".to_string());
            state.invalidate_target(source, &stream_entry);
            let start = state.cursor_attempt(source, &stream_entry);
            let first_definitive = if definitive_trigger { resp.take().map(|r| (policy.clone(), r)) } else { None };
            match failover_walk(
                &state,
                source,
                &stream_entry,
                pl.as_deref(),
                walk_children,
                on_definite,
                first_definitive,
                start,
                true,
                &rid,
            )
            .await
            {
                WalkOutcome::Recovered(p, target, r) => {
                    policy = p;
                    fetch_url = target;
                    if policy.origin_enabled.load(Ordering::Relaxed) {
                        log::info("proxy", &rid, || "the recovered candidate runs on the origin — serving from the ring".to_string());
                        if let Some(served) = serve_from_origin(
                            &state,
                            &policy,
                            mount_path,
                            source,
                            &stream_entry,
                            token.as_deref(),
                            pl.as_deref(),
                            &ident,
                            &rid,
                        )
                        .await
                        {
                            return served;
                        }
                    }
                    resp = Some(r);
                }
                WalkOutcome::Definitive(p, r) => {
                    policy = p;
                    resp = Some(r);
                }
                WalkOutcome::Refused(why) => return text(429, &why),
                WalkOutcome::Dead => resp = None,
            }
        }
    }

    let resp = match resp {
        Some(r) => r,
        None => {
            log::error("proxy", &rid, || "upstream fetch failed after retries + failover → 502".to_string());
            state.report(serde_json::json!({
                "kind": "upstream", "ok": false, "status": 0, "source": source, "entryUrl": stream_entry.as_str(),
            }));
            return text(502, "upstream fetch failed (after retries)");
        }
    };

    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        log::warn("proxy", &rid, || format!("upstream {status} (definitive) → forwarding verbatim"));
        if !is_hop && matches!(status, 401 | 403 | 410) && state.invalidate_rejected_target(source, &stream_entry) {
            log::info("proxy", &rid, || {
                format!("entry target rejected ({status}) — dropping the cached target so the next poll re-resolves")
            });
        }
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
        let read = resp.bytes();
        let raw_body = if read_timeout_ms > 0 {
            match tokio::time::timeout(Duration::from_millis(read_timeout_ms), read).await {
                Ok(Ok(b)) => b,
                Ok(Err(err)) => {
                    log::warn("proxy", &rid, || format!("read manifest failed: {err}"));
                    return text(502, &format!("read manifest failed: {err}"));
                }
                Err(_) => {
                    log::warn("proxy", &rid, || "read manifest timed out (idle) → transient failure".to_string());
                    state.report(serde_json::json!({
                        "kind": "upstream", "ok": false, "status": 0, "source": source, "entryUrl": stream_entry.as_str(),
                    }));
                    return text(502, "read manifest timed out");
                }
            }
        } else {
            match read.await {
                Ok(b) => b,
                Err(err) => {
                    log::warn("proxy", &rid, || format!("read manifest failed: {err}"));
                    return text(502, &format!("read manifest failed: {err}"));
                }
            }
        };
        if !sniff_m3u8(&raw_body) {
            log::info("proxy", &rid, || {
                format!("mpegurl-labeled body is not a manifest ({} bytes) — serving verbatim as octet-stream", raw_body.len())
            });
            return raw(200, "application/octet-stream", raw_body.to_vec());
        }
        let text_body = String::from_utf8_lossy(&raw_body).into_owned();
        log::trace("proxy", &rid, || format!("manifest received ({} bytes) from {}", text_body.len(), host_of(final_url.as_str())));
        if !is_hop && mount_path == "/api/ext/v1" && policy.output_format.read_ok().as_str() == "ts" {
            log::info("proxy", &rid, || "outputFormat=ts — handing off to the raw-TS producer".to_string());
            let ts_ctx = crate::tsmux::TsContext {
                state: state.clone(),
                policy: policy.clone(),
                source: source.to_string(),
                entry: stream_entry.clone(),
                pl: pl.clone(),
                rid: rid.clone(),
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
            log::info("proxy", &rid, || "raw-TS not eligible (fMP4/AES/no variant) — falling back to HLS rewrite".to_string());
        }

        let prefix = format!("{mount_path}/{source}/h/");
        let suffix = build_child_query(token.as_deref(), pl.as_deref(), &stream_entry);
        let RewriteResult { body, hosts, media } = rewrite_manifest(&text_body, &final_url, &prefix, &suffix);
        let body = if mount_path == "/api/ext/v1" && policy.stream_inf_redux.load(Ordering::Relaxed) {
            crate::manifest::redux_master(&body).into_owned()
        } else {
            body
        };
        let dropped = if policy.segment_unwrap.load(Ordering::Relaxed) {
            match crate::manifest::drop_independent_segments(&body) {
                Cow::Owned(b) => Some(b),
                Cow::Borrowed(_) => None,
            }
        } else {
            None
        };
        let body = dropped.unwrap_or(body);
        let grown = hosts.len();
        if !hosts.is_empty() {
            let mut set = policy.hosts.write_ok();
            for h in hosts {
                set.insert(h);
            }
        }
        if media.any() {
            log::trace("proxy", &rid, || {
                format!(
                    "decode metadata: res={} codecs={} fps={} container={}",
                    media.resolution.as_deref().unwrap_or("-"),
                    media.codecs.as_deref().unwrap_or("-"),
                    media.frame_rate.as_deref().unwrap_or("-"),
                    media.container.as_deref().unwrap_or("-"),
                )
            });
            let body_is_master = crate::tsmux::is_master(&text_body);
            let shape = if is_hop { None } else { Some(if body_is_master { "hls-master" } else { "hls-media" }) };
            let encryption = if body_is_master { None } else { Some(crate::tsmux::encryption_method(&text_body)) };
            state.report(serde_json::json!({
                "kind": "media", "source": source, "entryUrl": stream_entry.as_str(),
                "resolution": media.resolution, "codecs": media.codecs,
                "frameRate": media.frame_rate, "container": media.container, "bandwidth": media.bandwidth,
                "upstreamShape": shape,
                "encryption": encryption,
            }));
        }
        log::info("proxy", &rid, || {
            format!("manifest served ({} bytes{})", body.len(), if grown > 0 { format!(", +{grown} host(s) allowed") } else { String::new() })
        });
        state.report(serde_json::json!({
            "kind": "viewer", "source": source, "entryUrl": stream_entry.as_str(),
            "ip": ip, "ua": ua, "username": username, "playerType": player,
            "bytes": body.len() as u64,
        }));
        return manifest_response(body);
    }

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
        log::trace("proxy", &rid, || format!("HEAD segment → 200 {out_ct} (no body)"));
        return raw(200, &out_ct, Vec::new());
    }
    log::trace("proxy", &rid, || format!("streaming segment as {out_ct} from {}", host_of(&fetch_url)));
    let ctx = TelemetryCtx {
        state: state.clone(),
        source: source.to_string(),
        entry: stream_entry.clone(),
        rid: rid.clone(),
        ip,
        ua,
        username,
    };
    let unwrap = policy.segment_unwrap.load(Ordering::Relaxed);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", out_ct)
        .header("cache-control", "no-store")
        .body(segment_body(resp, ctx, read_timeout_ms, buffer_size_kb, unwrap))
        .unwrap()
}


pub(crate) enum WalkOutcome {
    Recovered(Arc<SourcePolicy>, String, reqwest::Response),
    Definitive(Arc<SourcePolicy>, reqwest::Response),
    Refused(String),
    Dead,
}

fn failover_knobs(state: &AppState, source: &str) -> (bool, bool) {
    match state.get(source) {
        Some(p) => (
            p.failover_enabled.load(Ordering::Relaxed),
            p.failover_on_definite_error.load(Ordering::Relaxed),
        ),
        None => (true, false),
    }
}

#[allow(clippy::too_many_arguments)]
async fn serve_from_origin(
    state: &AppState,
    policy: &Arc<SourcePolicy>,
    mount_path: &str,
    source: &str,
    stream_entry: &str,
    token: Option<&str>,
    pl: Option<&str>,
    ident: &Identity,
    rid: &str,
) -> Option<Response> {
    if policy.output_format.read_ok().as_str() == "ts" && mount_path == "/api/ext/v1" {
        log::info("proxy", rid, || "originEnabled + outputFormat=ts — serving raw TS from the ring".to_string());
        crate::origin::serve_ts(state, policy, source, stream_entry, pl, ident, rid).await
    } else {
        log::info("proxy", rid, || "originEnabled — serving the authored manifest from the ring".to_string());
        crate::origin::serve_entry(state, policy, mount_path, source, stream_entry, token, pl, ident, rid).await
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn failover_walk(
    state: &AppState,
    source: &str,
    stream_entry: &str,
    pl: Option<&str>,
    mut walk_children: bool,
    keep_walking_on_definite: bool,
    mut last_definitive: Option<(Arc<SourcePolicy>, reqwest::Response)>,
    start: u32,
    wrap: bool,
    rid: &str,
) -> WalkOutcome {
    let mut attempt = start;
    let mut wrapped = false;
    let mut tried: u32 = 0;
    loop {
        if tried >= MAX_FAILOVER_ATTEMPTS {
            log::warn("failover", rid, || format!("failover walk hit the attempt cap ({MAX_FAILOVER_ATTEMPTS}) — giving up"));
            state.reset_cursor(source, stream_entry);
            break;
        }
        tried += 1;
        log::trace("failover", rid, || format!("attempt {attempt} (tried {tried}/{MAX_FAILOVER_ATTEMPTS})"));
        match state.resolve_at(source, stream_entry, pl, attempt, None).await {
            Ok((p, target)) => {
                if !p.failover_enabled.load(Ordering::Relaxed) {
                    walk_children = false;
                    if attempt > 0 {
                        log::warn("failover", rid, || "failover disabled by config — not serving a backup candidate".to_string());
                        state.reset_cursor(source, stream_entry);
                        break;
                    }
                }
                let client = state.client_for(
                    p.connect_timeout_ms.load(Ordering::Relaxed),
                    p.max_redirects.load(Ordering::Relaxed),
                );
                let read_timeout_ms = p.read_timeout_ms.load(Ordering::Relaxed);
                let retries = if tried == 1 { MAX_UPSTREAM_RETRIES } else { 0 };
                if retries == 0 {
                    log::trace("failover", rid, || format!("candidate {attempt} on reduced budget (one-shot, no backoff)"));
                }
                match fetch_with_retry(&client, &target, &build_headers(&p), read_timeout_ms, rid, "failover", retries).await {
                    Ok(r) if r.status().is_success() => {
                        log::info("failover", rid, || format!("recovered on candidate {attempt} → {} (sticking for the session)", host_of(&target)));
                        return WalkOutcome::Recovered(p, target, r);
                    }
                    Ok(r) => {
                        let s = r.status().as_u16();
                        if walk_children && keep_walking_on_definite {
                            log::warn("failover", rid, || format!("candidate {attempt} answered definitive {s} — walking on"));
                            last_definitive = Some((p, r));
                        } else {
                            log::warn("failover", rid, || format!("candidate {attempt} answered definitive {s} — forwarding"));
                            state.reset_cursor(source, stream_entry);
                            return WalkOutcome::Recovered(p, target, r);
                        }
                    }
                    Err(e) => {
                        log::warn("failover", rid, || format!("candidate {attempt} fetch failed: {e}"));
                    }
                }
            }
            Err(ResolveErr::Exhausted) => {
                if walk_children && wrap && start > 0 && !wrapped {
                    log::info("failover", rid, || "candidate list exhausted — wrapping to the parent".to_string());
                    wrapped = true;
                    attempt = 0;
                    continue;
                }
                if tried > 1 {
                    log::warn("failover", rid, || format!("all backups exhausted after {} attempt(s) — giving up", tried - 1));
                } else {
                    log::trace("failover", rid, || "no failover candidates for this stream".to_string());
                }
                state.reset_cursor(source, stream_entry);
                break;
            }
            Err(ResolveErr::Refused(why)) => {
                log::info("failover", rid, || format!("candidate {attempt} refused by the source's stream cap — ending the walk"));
                return WalkOutcome::Refused(why);
            }
            Err(ResolveErr::Other(e)) => {
                log::warn("failover", rid, || format!("candidate {attempt} resolve failed: {e}"));
            }
        }
        if !walk_children {
            state.reset_cursor(source, stream_entry);
            break;
        }
        attempt += 1;
        if wrapped && attempt >= start {
            state.reset_cursor(source, stream_entry);
            break;
        }
    }
    match last_definitive {
        Some((p, r)) => WalkOutcome::Definitive(p, r),
        None => WalkOutcome::Dead,
    }
}


pub(crate) fn check_secret(h: &HeaderMap, secret: &str) -> bool {
    if secret.is_empty() {
        return true;
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
    parts.push(format!("e={}", enc(e)));
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

fn sniff_m3u8(bytes: &[u8]) -> bool {
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let start = b.iter().position(|c| !c.is_ascii_whitespace()).unwrap_or(b.len());
    b[start..].starts_with(b"#EXTM3U")
}

pub(crate) fn is_private_host(host: &str) -> bool {
    let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    if crate::dns::in_localhost_zone(host) {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => is_private_v4(v4),
            IpAddr::V6(v6) => {
                if let Some(v4) = v6.to_ipv4_mapped() {
                    return is_private_v4(v4);
                }
                v6.is_loopback()
                    || v6.is_unspecified()
                    || (v6.segments()[0] & 0xfe00) == 0xfc00
                    || (v6.segments()[0] & 0xffc0) == 0xfe80
            }
        };
    }
    false
}

fn is_private_v4(v4: Ipv4Addr) -> bool {
    v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified()
}

fn ssrf_public_ok(policy: &SourcePolicy, url: &str) -> bool {
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
    policy.allow_private.load(Ordering::Relaxed) || !is_private_host(&host)
}

fn ssrf_ok(policy: &SourcePolicy, url: &str) -> bool {
    if !ssrf_public_ok(policy, url) {
        return false;
    }
    let host = match Url::parse(url).ok().and_then(|u| u.host_str().map(|h| h.to_lowercase())) {
        Some(h) => h,
        None => return false,
    };
    policy.hosts.read_ok().contains(&host)
}

pub(crate) fn build_headers(policy: &SourcePolicy) -> reqwest::header::HeaderMap {
    use reqwest::header::{HeaderMap as RHeaderMap, HeaderName, HeaderValue};
    let mut hm = RHeaderMap::new();
    let snapshot: Vec<(String, String)> = policy.headers.read_ok().clone();
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

#[allow(clippy::too_many_arguments)]
pub(crate) async fn fetch_with_retry(
    client: &reqwest::Client,
    url: &str,
    headers: &reqwest::header::HeaderMap,
    read_timeout_ms: u64,
    rid: &str,
    what: &str,
    retries: u32,
) -> Result<reqwest::Response, String> {
    let idle = if read_timeout_ms > 0 {
        Some(Duration::from_millis(read_timeout_ms))
    } else {
        None
    };
    let mut last_err = String::from("upstream unreachable");
    for attempt in 0..=retries {
        if attempt > 0 {
            let backoff = RETRY_BACKOFF_MS.get((attempt - 1) as usize).copied().unwrap_or(500);
            log::warn("proxy", rid, || format!("{what} attempt {attempt} failed ({last_err}) — retry in {backoff}ms"));
            tokio::time::sleep(Duration::from_millis(backoff)).await;
        }
        log::trace("proxy", rid, || format!("{what} fetch → {}", host_of(url)));
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
                if is_retryable_status(s) && attempt < retries {
                    last_err = format!("upstream {s}");
                    continue;
                }
                log::trace("proxy", rid, || format!("{what} → {s}"));
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

pub(crate) fn host_of(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()))
        .unwrap_or_else(|| "?".to_string())
}

pub(crate) fn text(code: u16, msg: &str) -> Response {
    Response::builder()
        .status(StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header("content-type", "text/plain")
        .body(Body::from(msg.to_string()))
        .unwrap()
}

pub(crate) fn raw(code: u16, ct: &str, bytes: Vec<u8>) -> Response {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_m3u8_truth_table() {
        assert!(sniff_m3u8(b"#EXTM3U\n#EXT-X-VERSION:3\n"));
        assert!(sniff_m3u8(b"\xEF\xBB\xBF#EXTM3U\n"));
        assert!(sniff_m3u8(b"\r\n  #EXTM3U\n"));
        assert!(sniff_m3u8(b"\xEF\xBB\xBF\n#EXTM3U\n"));

        let key: [u8; 16] = [
            0x8f, 0x2a, 0x00, 0xff, 0x13, 0x37, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
        ];
        assert!(!sniff_m3u8(&key));

        assert!(!sniff_m3u8(b""));
        assert!(!sniff_m3u8(&[0x47u8; 188]));
        assert!(!sniff_m3u8(b"#EXTINF:6.0,"));
    }

    fn host(url: &str) -> String {
        Url::parse(url).unwrap().host_str().unwrap().to_string()
    }

    #[test]
    fn the_long_standing_private_literals_are_still_private() {
        for h in ["localhost", "LOCALHOST", "127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "0.0.0.0"] {
            assert!(is_private_host(h), "{h} must stay blocked");
        }
        for h in ["8.8.8.8", "cdn.example.com", "p16-common-sign.tiktokcdn-us.com"] {
            assert!(!is_private_host(h), "{h} is a public upstream");
        }
    }

    #[test]
    fn the_shared_cgnat_range_is_not_private_to_the_data_plane_gate() {
        for h in ["100.64.0.0", "100.100.100.100", "100.101.102.103", "100.127.255.255", "100.63.255.255", "100.128.0.0"] {
            assert!(!is_private_host(h), "{h} must pass the gate, as it did on main");
        }
        assert!(!is_private_host(&host("http://100.101.102.103:8089/devices/ANY/channels/5/hls/master.m3u8")));
        for h in ["10.0.0.1", "172.16.0.1", "192.168.1.10"] {
            assert!(is_private_host(h), "{h} stays private");
        }
    }

    #[test]
    fn an_ipv4_mapped_ipv6_literal_is_as_private_as_the_address_it_embeds() {
        for u in ["http://[::ffff:127.0.0.1]/", "http://[::ffff:10.0.0.1]/", "http://[::ffff:169.254.169.254]/"] {
            assert!(is_private_host(&host(u)), "{u} → {} must be blocked", host(u));
        }
        assert!(!is_private_host(&host("http://[::ffff:8.8.8.8]/")), "a mapped PUBLIC address stays public");
        assert!(!is_private_host(&host("http://[::ffff:100.64.1.1]/")), "a mapped tailnet address agrees with 100.64.1.1");
        assert!(is_private_host("::ffff:192.168.0.1"), "…and the bare spelling agrees");
    }

    #[test]
    fn bracketed_ipv6_literals_from_a_parsed_url_are_judged_at_all() {
        assert_eq!(host("http://[::1]/"), "[::1]", "precondition: this is how url hands IPv6 over");
        for u in ["http://[::1]/", "http://[fe80::1]/", "http://[fd00::5]/", "http://[::]/"] {
            assert!(is_private_host(&host(u)), "{u} must be blocked");
        }
        assert!(!is_private_host(&host("http://[2606:4700::1111]/")), "a public v6 literal stays public");
    }

    #[test]
    fn every_name_in_the_localhost_zone_is_private() {
        for h in ["localhost", "LOCALHOST", "localhost.", "x.localhost", "evil.localhost.", "a.b.LOCALHOST."] {
            assert!(is_private_host(h), "{h} must be blocked");
        }
        assert!(is_private_host(&host("http://x.localhost:3000/seg.ts")), "as a parsed URL hands it over");
        for h in ["localhost.example.com", "notlocalhost", "mylocalhost.net", "localhost.cdn.test"] {
            assert!(!is_private_host(h), "{h} is an ordinary public name");
        }
    }

    #[tokio::test]
    async fn a_bracketed_ula_target_is_reached_only_when_the_grant_allows_lan_reach() {
        let target = "http://[fd7a:115c:a1e0::1]:8089/devices/ANY/channels/5/hls/master.m3u8";
        let grant = serde_json::json!({
            "target": target, "allowPrivate": false, "proxyConfig": { "originEnabled": false },
        });
        let up = Mock::start(Seam::grant_with("/unused", grant)).await;
        let state = up.state();
        let resp = play(&state).await;
        assert_eq!(resp.status().as_u16(), 400, "a grant without allowPrivate is refused at the entry");
        let body = axum::body::to_bytes(resp.into_body(), 1 << 16).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("upstream host not allowed"), "by the SSRF gate");

        let policy = state.get("zl").expect("the grant was cached");
        assert!(!ssrf_public_ok(&policy, target), "private without allowPrivate");
        policy.allow_private.store(true, Ordering::Relaxed);
        assert!(ssrf_public_ok(&policy, target), "reachable once the grant allows LAN reach");
    }

    #[tokio::test]
    async fn a_direct_grant_without_allow_private_reaches_a_tailnet_ipv4_entry() {
        let target = "http://100.101.102.103:8089/devices/ANY/channels/5/hls/master.m3u8";
        let grant = serde_json::json!({
            "target": target, "allowPrivate": false, "proxyConfig": { "originEnabled": false },
        });
        let up = Mock::start(Seam::grant_with("/unused", grant)).await;
        let state = up.state();
        let (policy, resolved) = match state.resolve_entry("zl", "zl://abc", None).await {
            Ok(v) => v,
            Err(e) => panic!("the stand-in grants it: {e}"),
        };
        assert_eq!(resolved, target, "the grant's target, verbatim");
        assert!(!policy.allow_private.load(Ordering::Relaxed), "precondition: allowPrivate is off");
        assert!(ssrf_public_ok(&policy, &resolved), "the entry gate lets a tailnet address through");
        assert!(
            ssrf_ok(&policy, "http://100.101.102.103:8089/devices/ANY/channels/5/hls/seg-1.ts"),
            "…and so does the hop gate, for a segment on the same host"
        );
        assert!(!ssrf_public_ok(&policy, "http://192.168.1.10:8089/devices/ANY/channels/5/hls/master.m3u8"));
    }


    use crate::testkit::{Mock, Seam, Serve};

    fn viewer() -> Identity {
        Identity { ip: "127.0.0.1".into(), ua: "test".into(), username: None }
    }

    async fn play(state: &AppState) -> Response {
        let path = format!("/api/v1/zl/{}", enc("zl://abc"));
        serve_stream(state.clone(), Method::GET, &path, "", viewer()).await
    }

    #[tokio::test]
    async fn a_stream_cap_refusal_is_answered_429_without_walking_the_failover_chain() {
        let refusal = r#"{"error":"source_stream_cap","message":"ZLive already has 2 of 2 allowed concurrent stream(s) live"}"#;
        let up = Mock::start(Seam::Reply(429, refusal.to_string())).await;
        let resp = play(&up.state()).await;
        assert_eq!(resp.status().as_u16(), 429);
        let body = axum::body::to_bytes(resp.into_body(), 1 << 16).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("2 of 2"), "the viewer is told why");
        assert_eq!(up.resolves(), 1, "one question, one answer — no walk, no retry");
    }

    #[tokio::test]
    async fn a_rejected_entry_target_is_re_resolved_once_per_window_not_once_per_poll() {
        let up = Mock::start(Seam::grant("/pl/gone.m3u8", false)).await;
        up.script(|s| {
            s.paths.insert("/pl/gone.m3u8".into(), Serve::Status(403));
        });
        let state = up.state();
        for poll in 1..=3 {
            assert_eq!(play(&state).await.status().as_u16(), 403, "poll {poll}: the refusal is still forwarded verbatim");
        }
        assert_eq!(up.resolves(), 2, "the first refusal re-resolved once; the second did not re-arm it");
        let reasons: Vec<Option<String>> = up.calls().into_iter().map(|c| c.reason).collect();
        assert_eq!(
            reasons,
            vec![None, Some(crate::state::RETIRE_TARGET_REJECTED.to_string())],
            "the first resolve had nothing to say; the one after the refusal names it"
        );
    }

    #[tokio::test]
    async fn only_a_rejection_status_drops_the_cached_entry_target() {
        let up = Mock::start(Seam::grant("/pl/offair.m3u8", false)).await;
        up.script(|s| {
            s.paths.insert("/pl/offair.m3u8".into(), Serve::Status(404));
        });
        let state = up.state();
        for _ in 0..3 {
            assert_eq!(play(&state).await.status().as_u16(), 404);
        }
        assert_eq!(up.resolves(), 1, "a 404 is not a dead target: the cache rides on");
    }

    #[tokio::test]
    async fn a_backup_recovered_after_a_failed_entry_fetch_is_served_from_the_origin() {
        let dead = serde_json::json!({ "target": "http://127.0.0.1:1/dead.m3u8", "proxyConfig": { "originEnabled": false } });
        let up = Mock::start(Seam::grant_with("/unused", dead)).await;
        up.script(|s| {
            s.by_attempt.insert(1, Seam::grant_with("/pl/live.m3u8", serde_json::json!({ "policySource": "child" })));
            s.paths.insert("/pl/live.m3u8".into(), Serve::Body(crate::testkit::media_playlist(100, 4, 1)));
        });
        let resp = play(&up.state()).await;
        assert_eq!(resp.status().as_u16(), 200);
        let manifest = axum::body::to_bytes(resp.into_body(), 1 << 16).await.unwrap();
        let manifest = String::from_utf8_lossy(&manifest);
        assert!(manifest.contains("/api/v1/zl/o/"), "segments come from the ring:\n{manifest}");
        assert!(!manifest.contains("/api/v1/zl/h/"), "not the backup's playlist rewritten pass-through:\n{manifest}");
        assert!(up.calls().iter().any(|c| c.attempt == 1), "precondition: the walk reached the backup");
    }

    #[tokio::test]
    async fn a_tailed_segment_hop_and_its_tail_less_twin_reach_the_same_upstream_segment() {
        use crate::testkit::{tag_of, tagged_ts};
        let up = Mock::start(Seam::grant("/pl/live.m3u8", false)).await;
        up.script(|s| {
            let body = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:7\n\
                        #EXTINF:4.0,\n/pl/seg7.png\n#EXTINF:4.0,\n/pl/seg8.ts?sig=abc\n";
            s.paths.insert("/pl/live.m3u8".into(), Serve::Body(body.into()));
            s.paths.insert("/pl/seg7.png".into(), Serve::Media(tagged_ts(7)));
            s.paths.insert("/pl/seg8.ts".into(), Serve::Media(tagged_ts(8)));
        });
        let state = up.state();
        let resp = play(&state).await;
        assert_eq!(resp.status().as_u16(), 200);
        let manifest = axum::body::to_bytes(resp.into_body(), 1 << 16).await.unwrap();
        let manifest = String::from_utf8_lossy(&manifest);
        let hops: Vec<&str> = manifest.lines().filter(|l| l.starts_with("/api/v1/zl/h/")).collect();
        assert_eq!(hops.len(), 2, "{manifest}");

        for (hop, (named, tag)) in hops.iter().zip([("seg7.png", 7u64), ("seg8.ts%3Fsig%3Dabc", 8)]) {
            let (path, query) = hop.split_once('?').unwrap();
            assert!(path.ends_with(&format!("{named}/s.ts")), "minted with a tail: {hop}");
            for p in [path, path.strip_suffix("/s.ts").unwrap()] {
                let seg = serve_stream(state.clone(), Method::GET, p, query, viewer()).await;
                assert_eq!(seg.status().as_u16(), 200, "{p}");
                let bytes = axum::body::to_bytes(seg.into_body(), 1 << 16).await.unwrap();
                assert_eq!(tag_of(&bytes), tag, "{p} reached the segment its playlist named");
            }
        }
    }
}
