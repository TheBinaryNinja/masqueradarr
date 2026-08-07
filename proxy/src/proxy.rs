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
use std::sync::Arc;
use std::time::Duration;
use url::Url;

use crate::log;
use crate::manifest::{enc, rewrite_manifest, RewriteResult};
use crate::state::{AppState, ResolveErr, SourcePolicy, MAX_FAILOVER_ATTEMPTS};
use crate::stream::{segment_body, TelemetryCtx};
use crate::sync::RwExt;

// RSL-3 upstream retry. A transient failure (transport error, or a 502/503/504 gateway status) is retried with
// bounded backoff before the request is failed; a definitive response (2xx, 4xx, or a non-gateway 5xx) is used
// as-is. Kept small so a genuinely dead upstream fails fast (the total added latency is bounded by the sum of
// RETRY_BACKOFF_MS) and a flaky CDN edge still recovers within a poll.
pub(crate) const MAX_UPSTREAM_RETRIES: u32 = 2; // total attempts = 1 + this
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
    // S3/ORIGIN segment: `<source>/o/<enc-entry>/<generation>-<seq>.ts`. Handled BEFORE everything below
    // because it is answered entirely from the ring — no resolve, no upstream fetch, no Node round-trip.
    // (That also means it must never reach buildGrant's stored-entry gate, which would reject it as an
    // `unrecognized_entry` — a ring segment is not a channel's streamEntryUrl.)
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
        return crate::origin::serve_segment(&state, source, &entry, file, &id, &rid).await;
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

    // Lineage id for this whole viewing session — derived from (source, entry) so the ENTRY + all its HOPs +
    // segments share it (a HOP's entry comes from &e=). rid stitches the drawer's per-channel trace together.
    let entry_for_rid = if is_hop {
        e_param.clone().unwrap_or_default()
    } else {
        decoded.clone()
    };
    let rid = log::rid(source, &entry_for_rid);
    // ▶ the request lands (info milestone). The decoded target + who's asking is level-3 lineage.
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

    // Resolve the policy + the URL to fetch + the stream's entry (for telemetry attribution). fetch_url and
    // policy are `mut` so the RSL/FOG ENTRY failover walk below can swap in a freshly-resolved candidate
    // (its own target AND its own policy — a failover child's grants file under the child's adapter key).
    // `prefetched` carries a response the resolve-failure walk already fetched (skips the initial fetch).
    let mut prefetched: Option<reqwest::Response> = None;
    let (mut policy, mut fetch_url, stream_entry) = if is_hop {
        // FOG: a hop belongs to whatever candidate its stream is pinned to — hop_policy resolves the
        // stream's policy_key via the propagated `&e=` entry (falling back to the mount source's policy),
        // and keeps the failover cursor alive for actively-polling sessions.
        let hop_entry = e_param.clone().unwrap_or_default();
        let policy = match state.hop_policy(source, &hop_entry) {
            Some(p) => {
                log::trace("proxy", &rid, || format!("hop → cached policy, fetch {}", host_of(&decoded)));
                p
            }
            None => {
                // Cold hop (sidecar restart / eviction): re-resolve using the propagated entry.
                let entry = e_param.clone().unwrap_or_default();
                if entry.is_empty() {
                    log::error("proxy", &rid, || "cold hop with no propagated entry (&e=) — cannot resolve".to_string());
                    return text(400, "bad request: no cached stream");
                }
                log::info("proxy", &rid, || "cold hop (no cached policy) — re-resolving from entry".to_string());
                match state.resolve_entry(source, &entry, pl.as_deref()).await {
                    Ok((p, _)) => p,
                    Err(err) => {
                        // A cold-hop re-resolve failed (session/mirror gone) — the channel can't produce a
                        // stream, so mark it failed (a resolve failure has no HTTP status → 502 sentinel).
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
            Err(err) => {
                // The pinned candidate could not even RESOLVE (unknown source / dead upstream / expired
                // auth). FOG: walk the channel's failover candidates before failing — a dead parent whose
                // scrape/auth broke is a primary failover case.
                //  · Exhausted (a pinned attempt outlived its group — children removed/disbanded): reset
                //    the cursor and walk from the parent (attempt 0), so a stale pin can never 502-loop.
                //  · Other: walk from one PAST the failed cursor (re-resolving it now would just repeat
                //    the error), wrapping to the earlier candidates only when there ARE untried ones
                //    (cursor > 0) — an ungrouped channel costs one exhausted probe and 502s like today.
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
                    WalkOutcome::Definitive(p, r) => {
                        // Every candidate exhausted; the last definitive upstream response is forwarded
                        // verbatim by the definitive branch below (it also reports noteFailed telemetry).
                        prefetched = Some(r);
                        (p, decoded.clone(), decoded.clone())
                    }
                    WalkOutcome::Dead => {
                        // A resolve failure has no HTTP status → 502 sentinel → noteFailed → `failed`.
                        state.report(serde_json::json!({
                            "kind": "upstream", "ok": false, "status": 502, "source": source, "entryUrl": decoded.as_str(),
                        }));
                        return text(502, &format!("resolve failed: {err}"));
                    }
                }
            }
        }
    };

    // S3/ORIGIN — the ENTRY is answered from OUR ring, not by proxying the upstream manifest. Dispatched here,
    // AFTER the resolve (which the ingest needs anyway and which is target-cached) but BEFORE the upstream
    // fetch below: an origin entry must not fetch upstream at all, or every client poll would re-hit the
    // provider and defeat the whole point of ingesting once.
    //
    // BOTH output shapes are rendered from the SAME ring — that is what makes `outputFormat` a rendering
    // choice rather than a second pipeline. Raw TS stays external-mount-only (an in-app player is always HLS),
    // exactly as on the passthrough path.
    //
    // Either renderer may DECLINE (`None`) when the upstream's shape cannot be ringed — fMP4, undecryptable
    // segments, or audio carried in a separate #EXT-X-MEDIA rendition that the ring has no muxer to fold in.
    // Falling through to the ordinary rewrite below is then the correct answer, not an error: that path
    // passes renditions through for the player to fetch, so the channel plays WITH sound where the ring could
    // only have served it silent. (Before this seam a decline meant an empty ring, a `READY_TIMEOUT` wait and
    // a 503 — a dead channel.)
    if !is_hop && policy.origin_enabled.load(Ordering::Relaxed) {
        let want_ts = policy.output_format.read_ok().as_str() == "ts" && mount_path == "/api/ext/v1";
        let ident = Identity { ip: ip.clone(), ua: ua.clone(), username: username.clone() };
        if want_ts {
            log::info("proxy", &rid, || "originEnabled + outputFormat=ts — serving raw TS from the ring".to_string());
            if let Some(r) = crate::origin::serve_ts(&state, &policy, source, &stream_entry, pl.as_deref(), &ident, &rid).await {
                return r;
            }
        } else {
            log::info("proxy", &rid, || "originEnabled — serving the authored manifest from the ring".to_string());
            if let Some(r) = crate::origin::serve_entry(
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
                return r;
            }
        }
    }

    // SSRF gate. A HOP is a client-supplied child URL, so it must be IN the observational allowlist. An ENTRY
    // target is resolve output that seeds that allowlist, so membership is meaningless there — but it still
    // gets the scheme + private-host half, because an identity-resolve adapter passes the request URL through
    // verbatim and Node's `unrecognized_entry` gate is a stored-channel check, not an address check. Defense in
    // depth: a channel stored (or drifted) with a loopback/metadata/LAN target must not be fetched.
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

    // RSL per-stream knobs (NOT client-level): idle/read timeout for stall detection + read-ahead buffer depth.
    let read_timeout_ms = policy.read_timeout_ms.load(Ordering::Relaxed);
    let buffer_size_kb = policy.buffer_size_kb.load(Ordering::Relaxed);

    // Fetch upstream with RSL retry (transient transport error / 502/503/504 → bounded backoff; 4xx and other
    // definitive responses are used as-is). Client cached by (connect_timeout, max_redirects) — PXY-2; headers
    // replayed from the (possibly just-refreshed) policy. A resolve-failure walk above may have already
    // fetched the winning candidate — reuse that response instead of a second identical fetch.
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

    // RSL mirror failover + FOG failover-group walk on a failed ENTRY establish:
    //  · HOP — a child segment/variant host died; a fresh master can't be substituted for a child mid-poll,
    //    so kick a best-effort async policy refresh AT THE STREAM'S PINNED CANDIDATE (so a re-requested
    //    entry / cold hop rides the live mirror — and a failover-pinned stream never snaps back to its dead
    //    parent) and fail this request (the player refetches).
    //  · ENTRY — a transport failure always enters the walk: a fresh resolve of the SAME pinned candidate
    //    first (Node re-runs resolveStream → dlhd/dami reprobeMirror — the pre-failover mirror rotation),
    //    then, when failoverEnabled, the NEXT candidates in Node's order. A DEFINITIVE non-2xx enters the
    //    walk only when failoverOnDefiniteError is on (default keeps the forward-verbatim semantics).
    if resp.is_none() && is_hop {
        log::warn("proxy", &rid, || "hop fetch failed — kicking async policy refresh (client refetches)".to_string());
        if !stream_entry.is_empty() {
            let (st, src, ent, plc) =
                (state.clone(), source.to_string(), stream_entry.clone(), pl.clone());
            tokio::spawn(async move {
                let _ = st.resolve_fresh(&src, &ent, plc.as_deref()).await;
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
                    resp = Some(r);
                }
                WalkOutcome::Definitive(p, r) => {
                    policy = p;
                    resp = Some(r); // forwarded verbatim by the definitive branch below
                }
                WalkOutcome::Dead => resp = None,
            }
        }
    }

    let resp = match resp {
        Some(r) => r,
        None => {
            // Retries (+ entry failover) exhausted → a transport-level failure with no HTTP response → a
            // TRANSIENT upstream failure (status 0 ⇒ noteFailure), then a 502 to the client.
            log::error("proxy", &rid, || "upstream fetch failed after retries + failover → 502".to_string());
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
        log::warn("proxy", &rid, || format!("upstream {status} (definitive) → forwarding verbatim"));
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
        // Bound the body read by the same idle timeout (a manifest is small; a hang here is a stalled
        // upstream → a transient failure, not a definitive one). Read RAW BYTES, not resp.text(): a CDN can
        // mislabel a BINARY body with a manifest content-type (Pluto serves its AES-128 ts_aes/*.key files as
        // application/vnd.apple.mpegurl), and resp.text() would lossily UTF-8-mangle those 16 bytes into U+FFFD
        // before we can tell it is not a manifest.
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
        // is_manifest() trusts the upstream content-type / URL suffix, but a CDN can serve a NON-manifest under
        // the manifest MIME (Pluto's ts_aes/*.key files are 16 raw bytes labeled application/vnd.apple.mpegurl).
        // Confirm by CONTENT: a real HLS playlist MUST begin with #EXTM3U (RFC 8216 §4.3.1). If it does not,
        // this is a mislabeled opaque blob (the AES key) — serve it VERBATIM as octet-stream. Do NOT rewrite it
        // (there is no m3u8 to rewrite; the rewriter would corrupt the key → no playback) and do NOT apply
        // relabel_segment (a video MIME — a key is neither video nor a manifest). This is the byte-for-byte
        // passthrough the working AES channels already get when their CDN labels the key octet-stream.
        if !sniff_m3u8(&raw_body) {
            log::info("proxy", &rid, || {
                format!("mpegurl-labeled body is not a manifest ({} bytes) — serving verbatim as octet-stream", raw_body.len())
            });
            return raw(200, "application/octet-stream", raw_body.to_vec());
        }
        let text_body = String::from_utf8_lossy(&raw_body).into_owned();
        // (S3 Phase 3 retired the ingest-warming hook that used to sit here: BOTH origin shapes now return
        // from the ring above, so nothing below this point ever runs with origin enabled.)
        // DST: continuous raw-TS output on the external mount when the (Default)/(Custom) proxyconfig selects
        // outputFormat 'ts' AND the upstream is pure MPEG-TS. Only on the ENTRY (the client then holds ONE TS
        // socket and issues no HOP polls). Not eligible (fMP4 / AES / no reachable variant) → fall through to
        // the HLS rewrite below (text_body + final_url are cloned so the fallback still owns them).
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
        // SIR: STREAM-INF Redux — opt-in, ext-mount-only reorder of the rewritten MASTER so the first
        // #EXT-X-STREAM-INF lands within a strict player's manifest probe window (e.g. VLC's ~8 KiB peek). A pure
        // post-transform layered OVER rewrite_manifest (unchanged) — a no-op (borrowed) when the flag is off or
        // the body is a media playlist, so the served bytes are byte-identical to today when off. Ext-mount only:
        // the in-app player is hls.js (immune, full-string parse) and its /api/v1 path carries no ?pl. Runs BEFORE
        // the telemetry body.len() below so the reported manifest size reflects what is actually served. hosts +
        // media are unaffected (Redux adds/removes no URIs), so the SSRF-grow + DEC report below are untouched.
        let body = if mount_path == "/api/ext/v1" && policy.stream_inf_redux.load(Ordering::Relaxed) {
            crate::manifest::redux_master(&body).into_owned()
        } else {
            body
        };
        // Grow the source's SSRF allowlist with every host referenced in the manifest (dynamic-allow).
        let grown = hosts.len();
        if !hosts.is_empty() {
            let mut set = policy.hosts.write_ok();
            for h in hosts {
                set.insert(h);
            }
        }
        // DEC: manifest-declared decode metadata (master #EXT-X-STREAM-INF + media-playlist container hint).
        // Node merges the master + variant polls per channel and humanizes for Active Streams. Only emit when
        // something was learned so a plain media playlist doesn't spam empty events.
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
            state.report(serde_json::json!({
                "kind": "media", "source": source, "entryUrl": stream_entry.as_str(),
                "resolution": media.resolution, "codecs": media.codecs,
                "frameRate": media.frame_rate, "container": media.container, "bandwidth": media.bandwidth,
            }));
        }
        // Telemetry: a served manifest poll is the viewer heartbeat (also carries the manifest byte count) AND
        // a 2xx upstream success that drives the phase machine establishing→live.
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
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", out_ct)
        .header("cache-control", "no-store")
        .body(segment_body(resp, ctx, read_timeout_ms, buffer_size_kb))
        .unwrap()
}

// ── FOG: failover-group candidate walk ─────────────────────────────────────────────────────────────────

/// Outcome of a failover candidate walk (see `failover_walk`).
pub(crate) enum WalkOutcome {
    /// A candidate resolved and FETCHED — serve its response under the (possibly swapped) policy/target.
    /// May carry a definitive non-2xx when forward-verbatim semantics ended the walk (knob off): the
    /// caller's definitive branch then forwards it exactly like today's mirror-rotation retry.
    Recovered(Arc<SourcePolicy>, String, reqwest::Response),
    /// Every candidate exhausted; the LAST definitive non-2xx response (+ its policy), forwarded verbatim.
    Definitive(Arc<SourcePolicy>, reqwest::Response),
    /// Every candidate exhausted with nothing definitive to forward (transport failures all the way) → 502.
    Dead,
}

/// Read a source's failover knobs from its cached policy — defaults (on, off) when no policy exists yet.
/// The knobs are per-playlist-resolved, so any of the stream's policies carries the same values.
fn failover_knobs(state: &AppState, source: &str) -> (bool, bool) {
    match state.get(source) {
        Some(p) => (
            p.failover_enabled.load(Ordering::Relaxed),
            p.failover_on_definite_error.load(Ordering::Relaxed),
        ),
        None => (true, false),
    }
}

/// Walk the stream's failover candidates after a failed ENTRY establish. `start` is the first attempt to
/// try; the FIRST try keeps the full RSL fetch budget (for the fetch-failure path that is a fresh resolve
/// of the SAME pinned candidate — the pre-failover mirror-rotation retry), later candidates get ONE fetch
/// with no backoff so a multi-child group still establishes inside a player's manifest timeout. Node owns
/// the candidate order and replies a DISTINCT `failover_exhausted` (→ ResolveErr::Exhausted) past the end;
/// with `wrap` the walk then wraps ONCE to the candidates before `start` (including the parent) so a
/// mid-list pin still lets earlier candidates recover (callers pass wrap=false when everything before
/// `start` was already just tried). The cursor only stays pinned to an attempt that actually SERVED 2xx —
/// every other exit resets it (and expires the cached target) so the NEXT request walks from the parent.
/// `walk_children` = failoverEnabled (false ⇒ only the first try); it is also re-read from every resolved
/// grant, so an operator's knob-off is authoritative even when the pre-walk policy cache was cold.
/// `keep_walking_on_definite` = failoverOnDefiniteError (false ⇒ a definitive non-2xx ends the walk and is
/// forwarded verbatim — today's semantics).
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
        // Level-3 lineage: one line per hop of the walk (attempt cursor + how many we've tried this walk).
        log::trace("failover", rid, || format!("attempt {attempt} (tried {tried}/{MAX_FAILOVER_ATTEMPTS})"));
        match state.resolve_at(source, stream_entry, pl, attempt).await {
            Ok((p, target)) => {
                // The grant carries the authoritative failoverEnabled — a cold pre-walk policy cache may
                // have defaulted it on. Never SERVE a child the operator disabled failover to; a disabled
                // knob still permits the attempt-0 (channel itself) mirror-rotation retry.
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
                // Level-3 lineage: backups get a single one-shot fetch (no RSL budget, no backoff) so a
                // multi-child group still establishes inside a player's manifest timeout.
                if retries == 0 {
                    log::trace("failover", rid, || format!("candidate {attempt} on reduced budget (one-shot, no backoff)"));
                }
                match fetch_with_retry(&client, &target, &build_headers(&p), read_timeout_ms, rid, "failover", retries).await {
                    Ok(r) if r.status().is_success() => {
                        // Milestone (≥2): a backup established and now serves the session — the cursor stays
                        // pinned to this attempt (stick-on-winner) for the stream's lifetime.
                        log::info("failover", rid, || format!("recovered on candidate {attempt} → {} (sticking for the session)", host_of(&target)));
                        return WalkOutcome::Recovered(p, target, r);
                    }
                    Ok(r) => {
                        let s = r.status().as_u16();
                        if walk_children && keep_walking_on_definite {
                            log::warn("failover", rid, || format!("candidate {attempt} answered definitive {s} — walking on"));
                            last_definitive = Some((p, r));
                        } else {
                            // Forward-verbatim semantics: a definitive response ends the walk (exactly
                            // today's mirror-rotation behavior — resp is used whatever its status). The
                            // candidate did NOT serve, so un-pin: the next poll re-resolves from the
                            // parent instead of replaying this failure for the cursor's lifetime.
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
                // The terminal event: Node returned failover_exhausted with nothing left to try. Issue-level
                // (≥1) — pairs with the Node resolve-seam "exhausted all N backup(s)" warn (that side names
                // the parent/source; this side carries the session rid). `tried > 1` means we actually tried
                // a candidate before running out; `tried == 1` is an ungrouped channel's one-probe cost (or
                // an emptied group) — that's normal, so it stays quiet at level 1 (Node traces it at 3).
                if tried > 1 {
                    log::warn("failover", rid, || format!("all backups exhausted after {} attempt(s) — giving up", tried - 1));
                } else {
                    log::trace("failover", rid, || "no failover candidates for this stream".to_string());
                }
                state.reset_cursor(source, stream_entry);
                break;
            }
            Err(ResolveErr::Other(e)) => {
                log::warn("failover", rid, || format!("candidate {attempt} resolve failed: {e}"));
            }
        }
        if !walk_children {
            state.reset_cursor(source, stream_entry);
            break; // failover disabled — only the single mirror-rotation retry
        }
        attempt += 1;
        if wrapped && attempt >= start {
            state.reset_cursor(source, stream_entry);
            break;
        }
    }
    // Exhausted with a stashed definitive response: forward the LAST one verbatim (cursor already reset).
    match last_definitive {
        Some((p, r)) => WalkOutcome::Definitive(p, r),
        None => WalkOutcome::Dead,
    }
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

/// Content sniff: does this body actually begin with the `#EXTM3U` tag that RFC 8216 §4.3.1 requires as the
/// first line of every Master/Media Playlist? Tolerates a leading UTF-8 BOM and ASCII whitespace. A raw AES-128
/// key (or any other binary a CDN mislabels as application/vnd.apple.mpegurl) never matches, so the caller can
/// serve it verbatim instead of lossily "rewriting" it as a playlist.
fn sniff_m3u8(bytes: &[u8]) -> bool {
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes); // optional UTF-8 BOM
    let start = b.iter().position(|c| !c.is_ascii_whitespace()).unwrap_or(b.len());
    b[start..].starts_with(b"#EXTM3U")
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

/// The SCHEME + PRIVATE-HOST half of the SSRF gate, WITHOUT the allowlist-membership check.
///
/// This is the right gate for the ENTRY target, which is resolve output rather than a client-supplied child:
/// the entry's host is what *seeds* `policy.hosts` (state.rs, on every resolve), so testing it for membership
/// would either be vacuously true or reject the first request of every stream. What it must still not be is a
/// loopback/link-local/RFC1918 address — an adapter whose `resolveStream` is identity (direct, and any source
/// whose `isEntryUrl` returns false) passes the request URL through verbatim, so without this a stored entry
/// pointing at 169.254.169.254 or a LAN host would be fetched. `allowPrivate` (grant-carried, per adapter)
/// deliberately re-opens that for genuine LAN sources.
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

/// Fetch an upstream URL with RSL retry (transport error + 502/503/504 → bounded-backoff retry; 4xx / other
/// definitive responses returned as-is). `read_timeout_ms` (when >0) bounds the wait for RESPONSE HEADERS —
/// a connect-but-never-answer stall — per attempt; the body-stall case is handled downstream in stream::pump.
/// `retries` is the retry budget (total attempts = 1 + retries): MAX_UPSTREAM_RETRIES normally, 0 for a
/// reduced-budget failover-candidate fetch (FOG — one try, no backoff). Returns the final Response (which
/// may be a definitive non-2xx to forward verbatim) or the last error string after every attempt fails at
/// the transport level.
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

/// The host of a URL for compact log lines (a full stream URL is long + noisy); `?` if unparseable.
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
        // Real manifests — accepted (a mislabeled content-type must not stop these from rewriting).
        assert!(sniff_m3u8(b"#EXTM3U\n#EXT-X-VERSION:3\n"));
        assert!(sniff_m3u8(b"\xEF\xBB\xBF#EXTM3U\n")); // UTF-8 BOM prefix
        assert!(sniff_m3u8(b"\r\n  #EXTM3U\n")); // leading blank line + indent
        assert!(sniff_m3u8(b"\xEF\xBB\xBF\n#EXTM3U\n")); // BOM then blank line

        // A 16-byte Pluto AES-128 key mislabeled application/vnd.apple.mpegurl — rejected (the bug).
        let key: [u8; 16] = [
            0x8f, 0x2a, 0x00, 0xff, 0x13, 0x37, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
        ];
        assert!(!sniff_m3u8(&key));

        // Other non-manifest / mislabeled bodies — rejected.
        assert!(!sniff_m3u8(b"")); // empty body
        assert!(!sniff_m3u8(&[0x47u8; 188])); // a raw MPEG-TS packet (0x47 sync) mislabeled as mpegurl
        assert!(!sniff_m3u8(b"#EXTINF:6.0,")); // starts with '#' but not the #EXTM3U tag
    }
}
