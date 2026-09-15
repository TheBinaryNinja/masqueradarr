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
        // A DEMUXED origin also publishes its two authored media playlists here, for the same reason its
        // segments live here: answered from the ring, and never seen by buildGrant's stored-entry gate.
        // The bytes are still RAM-only — the policy comes from the cache — but unlike `o/` segments this
        // SUBSCRIBES, so a poll that finds no live ingest restarts one (which does resolve). That is what
        // lets a demuxed session survive an ingest death: its client fetched the master once and has no
        // other subscribing endpoint to poll.
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
    // HOP if the segment after the source is the `h/` marker; else ENTRY. A segment hop may end in a media tail
    // (`/s.ts`, …) that exists only for the client's extension check and was never part of the upstream URL, so
    // it comes off BEFORE the decode — see `manifest::strip_hop_tail`. Only hops: an entry is Node's, never ours.
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
                    // CAP: policy, not a dead channel — no failure telemetry (a `failed` phase would be a lie, and
                    // Node has already counted the refusal), just the refusal itself.
                    Err(ResolveErr::Refused(why)) => {
                        log::info("proxy", &rid, || format!("cold-hop re-resolve refused — {why}"));
                        return text(429, &why);
                    }
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
            // CAP: the source is at its concurrent-stream cap and this channel would be a NEW stream. Answered
            // here, BEFORE the walk below: the walk exists to route around a failed candidate, and a refusal is
            // terminal by contract — the seam answers 429 only where no candidate could carry the channel
            // instead (an ungrouped entry, a group whose backups all sit behind the same cap, or failover
            // switched off), and a walkable 502 where a backup COULD play, so the walk below reaches it
            // (resolveSeam.ts buildGrant / capRefusal).
            // Info, not error: Node warns once per refused channel, and a player retrying every few seconds
            // would otherwise fill the issue log with the same sentence.
            Err(ResolveErr::Refused(why)) => {
                log::info("proxy", &rid, || format!("entry refused by the source's stream cap — {why}"));
                return text(429, &why);
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
                    WalkOutcome::Refused(why) => return text(429, &why),
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
    let ident = Identity { ip: ip.clone(), ua: ua.clone(), username: username.clone() };
    if !is_hop && policy.origin_enabled.load(Ordering::Relaxed) {
        if let Some(r) =
            serve_from_origin(&state, &policy, mount_path, source, &stream_entry, token.as_deref(), pl.as_deref(), &ident, &rid)
                .await
        {
            return r;
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
    //    first (Node re-runs resolveStream — e.g. dlhd's player walk against its configured mirror),
    //    then, when failoverEnabled, the NEXT candidates in Node's order. A DEFINITIVE non-2xx enters the
    //    walk only when failoverOnDefiniteError is on (default keeps the forward-verbatim semantics).
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
                    // S3/ORIGIN — the walk carried the channel onto another candidate, and the origin dispatch
                    // above was decided on the policy that just failed. A candidate whose policy puts it on the
                    // origin (an originRequired backup — zlive — under a plain parent) is served from the ring
                    // from its first request: served pass-through instead, it pulled the upstream per viewer (for
                    // a raw-TS socket, for the whole session) against the one-ingest-per-channel contract
                    // originRequired declares, and the next entry poll — resolving onto the same backup — then
                    // flipped an HLS player onto the ring's numbering mid-session. The response the walk fetched
                    // is dropped; a decline still falls through to the rewrite with it, exactly as above.
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
                    resp = Some(r); // forwarded verbatim by the definitive branch below
                }
                WalkOutcome::Refused(why) => return text(429, &why),
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
        // REJ: an ENTRY target the upstream refused outright is most often a signed URL that lapsed (or a token it
        // revoked) — and the cache would otherwise keep handing out that same dead target for the rest of its
        // TTL, one refusal per poll. Expire it so the next poll re-resolves. Bounded to once per entry per TTL
        // window inside the call, because an upstream that refuses FRESH targets too must not become a resolve
        // per poll. Hops are untouched: a hop's URL came out of a manifest, not out of this cache.
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
        // (S3 Phase 3 retired the ingest-warming hook that used to sit here.) With origin enabled BOTH output
        // shapes normally return from the ring above — including a demuxed source's raw TS, which RMX now
        // weaves rather than declining. What still reaches here is the `Ready::Ineligible` fallback: a shape
        // the ring cannot hold at all (fMP4, `SAMPLE-AES`), where the rewrite below is the correct answer.
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
        // DSG: the source that declares its segments disguised also declares `#EXT-X-INDEPENDENT-SEGMENTS` falsely
        // (they are cut mid-GOP), so the promise is dropped — see `manifest::drop_independent_segments`. `policy`
        // is the one the stream is pinned to (hop_policy via `&e=`), so a failover child's declaration governs
        // its own playlists. Only an OWNED result replaces `body`: a no-tag poll keeps the String it already has.
        let dropped = if policy.segment_unwrap.load(Ordering::Relaxed) {
            match crate::manifest::drop_independent_segments(&body) {
                Cow::Owned(b) => Some(b),
                Cow::Borrowed(_) => None,
            }
        } else {
            None
        };
        let body = dropped.unwrap_or(body);
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
            // The upstream's SHAPE, but ONLY on the entry poll. This branch serves the entry AND every child
            // hop, and a hop's body is by definition the variant/media playlist — so an ungated shape would
            // report `hls-master` once and then be overwritten with `hls-media` on the very next child poll
            // and stay wrong for the life of the channel (noteMedia merges on non-null, and this producer
            // sends no `replace` flag). The failure is silent and permanent, so the gate is the feature.
            let body_is_master = crate::tsmux::is_master(&text_body);
            let shape = if is_hop { None } else { Some(if body_is_master { "hls-master" } else { "hls-media" }) };
            // ENCRYPTION is gated on the exact INVERSE condition to shape, and the asymmetry is the point:
            // shape is a property of the ENTRY, while `#EXT-X-KEY` only ever appears in a MEDIA playlist. Ask
            // a master and it answers "NONE" for every AES channel sitting behind one. So on a master-entry
            // channel the encryption answer legitimately arrives on a later HOP poll — which works because
            // noteMedia merges on non-null, leaving the null we send for the master alone.
            let encryption = if body_is_master { None } else { Some(crate::tsmux::encryption_method(&text_body)) };
            state.report(serde_json::json!({
                "kind": "media", "source": source, "entryUrl": stream_entry.as_str(),
                "resolution": media.resolution, "codecs": media.codecs,
                "frameRate": media.frame_rate, "container": media.container, "bandwidth": media.bandwidth,
                "upstreamShape": shape,
                "encryption": encryption,
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
    // DSG: unwrap only where the serving adapter declared its segments disguised. The relabel above names the
    // content; this makes the BYTES match it. Same pinned policy as the relabel, so a failover child's
    // declaration applies to its own segments and never to the parent provider's.
    let unwrap = policy.segment_unwrap.load(Ordering::Relaxed);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", out_ct)
        .header("cache-control", "no-store")
        .body(segment_body(resp, ctx, read_timeout_ms, buffer_size_kb, unwrap))
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
    /// CAP: the seam refused the stream outright (the source's concurrent-stream cap). Ends the walk on the spot
    /// with Node's message: by contract the seam refuses only where no later candidate could serve instead — a
    /// backup that could must be answered as a walkable failure, never a refusal. → 429.
    Refused(String),
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

/// S3/ORIGIN — answer an ENTRY from the channel's ring rather than the upstream manifest, on `policy`'s output
/// shape: raw TS on the external mount when it selects `ts`, the authored HLS manifest otherwise. `None` when the
/// renderer DECLINES the upstream's shape, which the caller answers with the ordinary rewrite (see the dispatch
/// in `serve_stream`).
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
        match state.resolve_at(source, stream_entry, pl, attempt, None).await {
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
            // CAP: a refusal is about the STREAM, not this candidate. By contract the seam sends one only when
            // walking on could not help (a candidate that is merely capped while a later one could play must be
            // answered as a walkable 502, which lands in the `Other` arm below). The cursor is left where it is:
            // nothing about any candidate was learned, and resetting it would throw away a pin a live session may
            // still be riding.
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

/// Whether a URL host is a loopback / private / link-local / otherwise-internal LITERAL. Literal-only by
/// design — no DNS here — so a name that merely resolves somewhere private is out of scope for this check.
///
/// "Private" is RFC 1918, loopback, link-local and unspecified IPv4 — exactly as on main — plus every IPv6
/// loopback, ULA and link-local literal, and any IPv4-mapped IPv6 literal whose embedded address is one of
/// those. A grant carrying `allowPrivate` re-opens all of it, and every gate that consults this function honours
/// that: the entry and hop gates here, both origin ingest guards, and the raw-TS producer's segment and key
/// guards. Node sends `allowPrivate: false` on every grant today, `direct` imports included — plumbing it on for
/// `direct` would open RFC 1918 and every manifest-learned LAN hop for each public playlist an operator imports.
///
/// Deliberately NOT private: the RFC 6598 shared address space, 100.64.0.0/10. It is shared (carrier-grade NAT)
/// space, not RFC 1918, and homelab operators reach a Channels DVR / xTeVe / Threadfin box over Tailscale by its
/// raw 100.x address. Refusing it here regressed exactly those `direct` imports, which played on main — and with
/// `allowPrivate` off for every grant, the operator had no way to re-open it. The trade is main's: a public-CDN
/// source's manifest may name a 100.x host and have it fetched, as it always could. The one source whose upstream
/// hosts come from a redirect it does not control — zlive — already refuses CGNAT (and every other non-public
/// range) for its own Location hosts in Node, before a grant exists (zlive/resolver.ts isPublicAddress).
pub(crate) fn is_private_host(host: &str) -> bool {
    // `Url::host_str` hands IPv6 literals back BRACKETED (`[::1]`), and a bracketed string never parses as an
    // address — so without this every IPv6 literal that arrived from a parsed URL read as a public hostname,
    // loopback included, and the v6 rules below were unreachable from every real caller.
    let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    // The whole `localhost.` zone, not just the one name: the upstream resolver (dns.rs) and many others answer
    // `anything.localhost` — and `localhost.` — with loopback, so as far as this gate is concerned they are
    // loopback literals in all but spelling. Before, only the exact string `localhost` was refused.
    if crate::dns::in_localhost_zone(host) {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => is_private_v4(v4),
            IpAddr::V6(v6) => {
                // An IPv4-MAPPED address (`::ffff:a.b.c.d`) is dialled as the v4 address it embeds, so it is
                // exactly as private as that address: `[::ffff:127.0.0.1]` is loopback by another spelling.
                if let Some(v4) = v6.to_ipv4_mapped() {
                    return is_private_v4(v4);
                }
                v6.is_loopback()
                    || v6.is_unspecified()
                    || (v6.segments()[0] & 0xfe00) == 0xfc00 // ULA fc00::/7
                    || (v6.segments()[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
            }
        };
    }
    false
}

/// The IPv4 half of `is_private_host` — main's rule set, unchanged. 100.64.0.0/10 is left out on purpose (see
/// `is_private_host`): tailnet addresses are how `direct` imports reach a homelab box.
fn is_private_v4(v4: Ipv4Addr) -> bool {
    v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified()
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

    /// The host exactly as every real caller hands it over: through `Url::host_str`, which is what brackets an
    /// IPv6 literal. Testing bare strings alone is how the bracket gap went unnoticed.
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

    /// D1-01: RFC 6598's 100.64.0.0/10 (carrier-grade NAT — and every Tailscale address) is NOT private to this
    /// gate, as on main: `direct` imports reach homelab boxes over a tailnet by raw 100.x IP, with no grant able
    /// to re-open it for them. Pinned across the range and at both edges, in both spellings a caller hands over.
    #[test]
    fn the_shared_cgnat_range_is_not_private_to_the_data_plane_gate() {
        for h in ["100.64.0.0", "100.100.100.100", "100.101.102.103", "100.127.255.255", "100.63.255.255", "100.128.0.0"] {
            assert!(!is_private_host(h), "{h} must pass the gate, as it did on main");
        }
        assert!(!is_private_host(&host("http://100.101.102.103:8089/devices/ANY/channels/5/hls/master.m3u8")));
        // …while RFC 1918 stays blocked exactly as before.
        for h in ["10.0.0.1", "172.16.0.1", "192.168.1.10"] {
            assert!(is_private_host(h), "{h} stays private");
        }
    }

    /// An IPv4-mapped IPv6 literal is dialled as the v4 address inside it, so `[::ffff:127.0.0.1]` must be
    /// exactly as blocked as `127.0.0.1` — in the bracketed form a parsed URL actually produces. "Exactly as" cuts
    /// both ways: a mapped tailnet address is as reachable as the tailnet address.
    #[test]
    fn an_ipv4_mapped_ipv6_literal_is_as_private_as_the_address_it_embeds() {
        for u in ["http://[::ffff:127.0.0.1]/", "http://[::ffff:10.0.0.1]/", "http://[::ffff:169.254.169.254]/"] {
            assert!(is_private_host(&host(u)), "{u} → {} must be blocked", host(u));
        }
        assert!(!is_private_host(&host("http://[::ffff:8.8.8.8]/")), "a mapped PUBLIC address stays public");
        assert!(!is_private_host(&host("http://[::ffff:100.64.1.1]/")), "a mapped tailnet address agrees with 100.64.1.1");
        assert!(is_private_host("::ffff:192.168.0.1"), "…and the bare spelling agrees");
    }

    /// The bracket gap itself: every IPv6 rule was unreachable from a parsed URL until the brackets came off.
    #[test]
    fn bracketed_ipv6_literals_from_a_parsed_url_are_judged_at_all() {
        assert_eq!(host("http://[::1]/"), "[::1]", "precondition: this is how url hands IPv6 over");
        for u in ["http://[::1]/", "http://[fe80::1]/", "http://[fd00::5]/", "http://[::]/"] {
            assert!(is_private_host(&host(u)), "{u} must be blocked");
        }
        assert!(!is_private_host(&host("http://[2606:4700::1111]/")), "a public v6 literal stays public");
    }

    /// The whole `localhost.` zone is loopback to this gate. The upstream resolver answers `anything.localhost`
    /// with loopback on its own (RFC 6761, hickory), so a manifest child named `x.localhost` passed a gate that
    /// knew only the exact string `localhost` — and the old `localhost.` (root dot) gap with it.
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

    /// The private-host gate is the GRANT's to open. A grant with allowPrivate off never reaches a bracketed IPv6
    /// ULA literal — refused before anything is fetched (on main the brackets hid it from every v6 rule, so it
    /// passed) — while the very same policy with allowPrivate on passes the gate. A tailnet's IPv6 box is reached
    /// by its MagicDNS name instead: this check is literal-only. The pass side is judged AT the gate: dialling the
    /// address for real would leave the machine.
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

    /// D1-01 regression: a `direct`-style grant — allowPrivate OFF, which is what Node sends for every source,
    /// `direct` included — still reaches a raw tailnet IPv4 entry, as it did on main. Both gates it meets are
    /// checked: the entry gate, and the hop gate for a segment on the same host (the entry host seeds the
    /// allow-set). Judged at the gates on the policy a real resolve built — the resolve runs against the loopback
    /// stand-in, and nothing ever dials 100.101.102.103.
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
        // RFC 1918 is still refused on the very same policy — the regression fix re-opened CGNAT, nothing else.
        assert!(!ssrf_public_ok(&policy, "http://192.168.1.10:8089/devices/ANY/channels/5/hls/master.m3u8"));
    }

    // ── end to end through the relay handler (testkit: a loopback Node + upstream) ───────────────────────

    use crate::testkit::{Mock, Seam, Serve};

    fn viewer() -> Identity {
        Identity { ip: "127.0.0.1".into(), ua: "test".into(), username: None }
    }

    async fn play(state: &AppState) -> Response {
        let path = format!("/api/v1/zl/{}", enc("zl://abc"));
        serve_stream(state.clone(), Method::GET, &path, "", viewer()).await
    }

    /// CAP: a source at its stream cap refuses a NEW channel with 429, and the relay hands exactly that to the
    /// client — Node's message included — after ONE question. The resolve-failure walk used to treat the
    /// refusal as a dead candidate and re-ask the same cap at attempt 1, 2, … before answering a 502.
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

    /// REJ: an entry target the upstream refuses outright (a lapsed signed URL) is dropped from the cache so the
    /// next poll re-resolves — but at most once per window, so an upstream that refuses the FRESH target too
    /// costs one extra resolve, not one per poll. Three polls: resolve, refused → drop; re-resolve, refused →
    /// latched, kept; the third rides the cache. The re-resolve also SAYS why (`target_rejected`), so an adapter
    /// that caches its own resolution re-mints the link rather than handing the refused one straight back.
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

    /// REJ is scoped to rejections that mean "this target is dead". A 404 (not live) or a 5xx keeps today's
    /// forward-verbatim behaviour and the cached target.
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

    /// S3/ORIGIN + FOG: the channel's own entry resolves but its upstream cannot be reached, and the walk recovers
    /// onto a backup whose grant runs on the origin (an originRequired provider under a plain parent). That first
    /// request is answered from the ring — the authored manifest, segments under `/o/` — where it used to be the
    /// backup's upstream playlist rewritten pass-through, which the next poll then swapped for the ring's numbering.
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

    /// HOP TAIL, end to end through the relay: a `.png`-named segment and a signed one are both minted with
    /// `/s.ts`, and each line, requested as a client would request it, reaches exactly the segment its playlist
    /// named. The same hops WITHOUT the tail — what a session opened before the upgrade is holding — reach them
    /// too. (The `.png` one is the discriminating case: an unstripped tail lands in ITS path, where the signed
    /// one's would hide in a query this stand-in ignores.)
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
