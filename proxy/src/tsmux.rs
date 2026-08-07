//! DST-3 continuous raw-TS distribution — a remux-free raw-TS "output format" for the external-player mount.
//!
//! When the (Default)/(Custom) proxyconfig sets `outputFormat: "ts"`, an /api/ext/v1 ENTRY request is served as
//! ONE continuous `video/mp2t` chunked response instead of a rewritten HLS manifest: we follow the upstream
//! MEDIA playlist on its target-duration cadence and CONCATENATE each new segment's raw bytes into the client
//! socket. MPEG-TS packets are self-framing and concatenable, so this needs no remux (RMX stays deferred).
//!
//! ENCRYPTION: full-segment **AES-128 is decrypted server-side** (`#EXT-X-KEY:METHOD=AES-128`) so the
//! ciphertext never reaches the client — the key is fetched through the same retry + SSRF path as segments
//! and cached by URI (HLS keys are stable across a clip, so this is one fetch per rotation, not per segment).
//! Decryption is ALL-OR-NOTHING per segment: CBC can't reconstruct a truncated ciphertext, so an encrypted
//! segment is buffered whole, decrypted, then sent once — where a cleartext segment still streams
//! chunk-by-chunk, partial-tolerant. A failed key fetch / decrypt drops THAT segment (a gap), not the stream.
//!
//! Guards (fall back to the HLS rewrite): `#EXT-X-MAP` (fMP4 — not raw-TS-concatenable) and any `#EXT-X-KEY`
//! METHOD we can't handle server-side (`SAMPLE-AES`/FairPlay and friends — see `unsupported_encryption`).
//! Both log a WARN naming the reason, so a channel that silently falls back is visible to an operator rather
//! than just "not playing in a TS-only client". A DISCONTINUITY is passed through (most TS players re-sync on
//! the PCR/PTS reset); a truly seamless splice would need RMX.
//!
//! Durability reuses the RSL layer: playlist + segment fetches go through `fetch_with_retry` (transient retry),
//! and a persistent media-playlist failure re-resolves the entry (driving dlhd/dami `reprobeMirror` failover).
//! Telemetry uses the SOCKET model (noteSocketViewer* — explicit open/close, a 60s no-byte backstop) rather
//! than the 30s poll-recency model, since a continuous stream never polls: `open` → Node mints a connId; periodic
//! `sbytes` → egress; `close` → session end.

use axum::body::Body;
use axum::http::StatusCode;
use axum::response::Response;
use bytes::Bytes;
use std::io;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;
use url::Url;

// RustCrypto AES-128-CBC + PKCS7 — decrypt encrypted HLS (#EXT-X-KEY:METHOD=AES-128) segments before concat.
use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};

use crate::log;
use crate::proxy::{build_headers, failover_walk, fetch_with_retry, is_private_host, WalkOutcome, MAX_UPSTREAM_RETRIES};
use crate::state::{AppState, SourcePolicy};
use crate::sync::RwExt;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

/// Everything the TS producer needs to follow a stream + attribute its telemetry. Cloned out of the proxy
/// handler at hand-off (the handler returns immediately; the producer runs detached).
pub struct TsContext {
    pub state: AppState,
    pub policy: Arc<SourcePolicy>,
    pub source: String,
    pub entry: String,
    pub pl: Option<String>,
    pub rid: String, // the viewing-session lineage id — shared with the ENTRY that handed off to this producer
    pub client: reqwest::Client,
    pub read_timeout_ms: u64,
    pub ip: String,
    pub ua: String,
    pub username: Option<String>,
}

/// The #EXT-X-KEY active for a segment. A KEY applies to every following segment until the next KEY
/// (METHOD=NONE clears it), so it is tracked POSITIONALLY during parse. We only decrypt AES-128; other
/// methods are still carried so the producer can drop+warn on a mid-stream rotation, but try_ts_response's
/// entry guard already bails such a playlist to the HLS rewrite before the producer starts.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SegKey {
    pub method: String,       // uppercased, e.g. "AES-128"
    pub uri: String,          // key URI, resolved against the media-playlist URL at fetch time
    pub iv: Option<[u8; 16]>, // explicit IV=0x…; None ⇒ derive from the segment's media-sequence number
}

/// One segment line of a media playlist, with the tags that apply to IT (rather than to the playlist).
/// `duration` + `discontinuity` are carried for the S3 ORIGIN ingest (origin.rs), which republishes them as
/// our own `#EXTINF` / `#EXT-X-DISCONTINUITY`; the raw-TS producer ignores both and just concatenates bytes.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SegRef {
    pub uri: String,
    pub key: Option<SegKey>,
    pub duration: f64,       // #EXTINF for this segment (0.0 when absent/unparseable)
    pub discontinuity: bool, // an #EXT-X-DISCONTINUITY tag preceded this segment
    /// Set while an upstream ad-break marker is open over this segment. `None` ⇒ either the segment is
    /// program, or the source emits no cue tags at all (pluto — see `origin::ad_state`, which falls back to
    /// an adapter-declared URI signature).
    pub cue: Option<CueState>,
}

/// Which tag family opened the break. Named rather than a bare bool for the same reason `origin::Boundary`
/// is: the `iop:cue` log has to say WHICH signal fired, or a detector bug is indistinguishable from real
/// ad-pod churn (the lesson from the two removed URL heuristics — `origin.rs:96`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CueKind {
    /// `#EXT-X-CUE-OUT` / `-CONT` — the de-facto ad-break tags most packagers emit.
    CueOut,
    /// `#EXT-X-DATERANGE:…SCTE35-OUT=…` — RFC 8216 §4.3.2.7's spelling of the same thing.
    DateRange,
}

/// An OPEN ad break, carried positionally onto every segment it covers.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct CueState {
    pub kind: CueKind,
    /// The break's ANNOUNCED total, seconds; 0.0 when the tag carried none. Advisory only — the real duration
    /// is what we actually observe, since packagers routinely close a break early with `#EXT-X-CUE-IN`.
    pub duration: f64,
}

pub(crate) struct MediaPlaylist {
    pub media_sequence: i64,  // #EXT-X-MEDIA-SEQUENCE (the sequence of the first listed segment; default 0)
    pub target_duration: f64, // #EXT-X-TARGETDURATION (seconds; 0 when absent → a default poll cadence)
    pub endlist: bool,        // #EXT-X-ENDLIST → the playlist is complete (VOD / finished event)
    // Segments in order (index i ⇒ sequence media_sequence + i). `key: None` ⇒ that segment is cleartext.
    pub segments: Vec<SegRef>,
}

pub(crate) fn parse_media_playlist(body: &str) -> MediaPlaylist {
    let mut media_sequence = 0i64;
    let mut target_duration = 0f64;
    let mut endlist = false;
    let mut segments: Vec<SegRef> = Vec::new();
    let mut active_key: Option<SegKey> = None;
    // Sticky like #EXT-X-KEY (NOT pending): a cue-out covers every following segment until a cue-in closes it.
    let mut active_cue: Option<CueState> = None;
    // Both are PENDING state consumed by the next segment line: an #EXTINF and an #EXT-X-DISCONTINUITY apply
    // to the segment that FOLLOWS them, so they are cleared on use (unlike #EXT-X-KEY, which is sticky).
    let mut pending_duration = 0f64;
    let mut pending_discontinuity = false;
    for raw in body.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw).trim();
        if line.is_empty() {
            continue;
        }
        if let Some(v) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            media_sequence = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            target_duration = v.trim().parse().unwrap_or(0.0);
        } else if line.starts_with("#EXT-X-ENDLIST") {
            endlist = true;
        } else if line.starts_with("#EXT-X-DISCONTINUITY") && !line.starts_with("#EXT-X-DISCONTINUITY-SEQUENCE") {
            pending_discontinuity = true; // the PREFIX guard matters: -SEQUENCE is a playlist header, not a splice
        } else if let Some(v) = line.strip_prefix("#EXTINF:") {
            // "#EXTINF:<duration>[,<title>]" — the title is optional and may itself contain no comma.
            pending_duration = v.split(',').next().unwrap_or("").trim().parse().unwrap_or(0.0);
        } else if let Some(attrs) = line.strip_prefix("#EXT-X-KEY:") {
            active_key = parse_key(attrs); // METHOD=NONE / unparseable ⇒ None ⇒ following segments are cleartext
        } else if line.starts_with("#EXT-X-CUE-IN") {
            active_cue = None;
        } else if line.starts_with("#EXT-X-CUE-OUT") {
            // The PREFIX guard matters here too: `-CONT` merely re-states an already-open break, and its
            // value is "elapsed/total" rather than a total — so it must not overwrite the duration the
            // opening tag announced. It DOES open one when we joined mid-break and never saw the CUE-OUT.
            let cont = line.starts_with("#EXT-X-CUE-OUT-CONT");
            active_cue = Some(match (cont, active_cue) {
                (true, Some(open)) => open,
                _ => CueState { kind: CueKind::CueOut, duration: cue_duration(line) },
            });
        } else if let Some(attrs) = line.strip_prefix("#EXT-X-DATERANGE:") {
            // SCTE35-IN wins when a range carries both: closing is the safer read of an ambiguous marker.
            let pairs = split_attrs(attrs);
            let has = |n: &str| pairs.iter().any(|(k, _)| k.eq_ignore_ascii_case(n));
            if has("SCTE35-IN") {
                active_cue = None;
            } else if has("SCTE35-OUT") {
                let duration = pairs
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("DURATION") || k.eq_ignore_ascii_case("PLANNED-DURATION"))
                    .and_then(|(_, v)| v.trim_matches('"').parse().ok())
                    .unwrap_or(0.0);
                active_cue = Some(CueState { kind: CueKind::DateRange, duration });
            }
        } else if !line.starts_with('#') {
            segments.push(SegRef {
                uri: line.to_string(),
                key: active_key.clone(),
                duration: pending_duration,
                discontinuity: pending_discontinuity,
                cue: active_cue,
            });
            pending_duration = 0f64;
            pending_discontinuity = false;
        }
    }
    MediaPlaylist {
        media_sequence,
        target_duration,
        endlist,
        segments,
    }
}

/// Split an HLS attribute list `KEY=VALUE,KEY=VALUE` into (key, value) pairs, treating commas INSIDE a
/// double-quoted value as literal (an `URI="…?a=1,b=2…"` must not split). Values keep their surrounding
/// quotes; callers strip them where appropriate.
fn split_attrs(s: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut in_quotes = false;
    let mut cur = String::new();
    for c in s.chars() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                cur.push(c);
            }
            ',' if !in_quotes => {
                push_attr(&mut out, &cur);
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    push_attr(&mut out, &cur);
    out
}

fn push_attr(out: &mut Vec<(String, String)>, seg: &str) {
    let seg = seg.trim();
    if let Some(eq) = seg.find('=') {
        out.push((seg[..eq].trim().to_string(), seg[eq + 1..].trim().to_string()));
    }
}

/// Parse a #EXT-X-KEY attribute list. None for METHOD=NONE / missing method (⇒ cleartext).
fn parse_key(attrs: &str) -> Option<SegKey> {
    let mut method = String::new();
    let mut uri = String::new();
    let mut iv: Option<[u8; 16]> = None;
    for (k, v) in split_attrs(attrs) {
        match k.to_ascii_uppercase().as_str() {
            "METHOD" => method = v.to_ascii_uppercase(),
            "URI" => uri = v.trim_matches('"').to_string(),
            "IV" => iv = parse_iv(&v),
            _ => {}
        }
    }
    if method.is_empty() || method == "NONE" {
        return None;
    }
    Some(SegKey { method, uri, iv })
}

/// Parse an HLS IV attribute — a `0x`-prefixed 32-hex-digit (16-byte) value — into bytes.
fn parse_iv(v: &str) -> Option<[u8; 16]> {
    let h = v.trim().trim_start_matches("0x").trim_start_matches("0X");
    let bytes = hex::decode(h).ok()?;
    if bytes.len() != 16 {
        return None;
    }
    let mut iv = [0u8; 16];
    iv.copy_from_slice(&bytes);
    Some(iv)
}

/// The announced total, seconds, from a `#EXT-X-CUE-OUT` family tag. There is no standard spelling — this
/// accepts the four shapes seen in the wild and returns 0.0 for anything else (an unannounced break is
/// normal, not an error):
///   `…CUE-OUT:30.000` · `…CUE-OUT:DURATION=30` · `…CUE-OUT-CONT:8.0/30.0` · `…CUE-OUT-CONT:…,Duration=30`
fn cue_duration(line: &str) -> f64 {
    let Some((_, v)) = line.split_once(':') else {
        return 0.0; // a bare `#EXT-X-CUE-OUT` announces nothing
    };
    let v = v.trim();
    // "elapsed/total" — the total is what we want, and it is never the first field.
    if let Some((_, total)) = v.rsplit_once('/') {
        return total.trim().parse().unwrap_or(0.0);
    }
    if v.contains('=') {
        return split_attrs(v)
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("DURATION"))
            .and_then(|(_, d)| d.trim_matches('"').parse().ok())
            .unwrap_or(0.0);
    }
    v.parse().unwrap_or(0.0)
}

/// A MASTER playlist (variant selection needed) vs. a MEDIA playlist (segments directly).
pub(crate) fn is_master(body: &str) -> bool {
    body.split('\n').any(|l| l.trim_start().starts_with("#EXT-X-STREAM-INF"))
}

/// `#EXT-X-MAP` (an fMP4 init segment) ⇒ NOT raw-TS-concatenable.
pub(crate) fn has_map(body: &str) -> bool {
    body.split('\n').any(|l| l.trim_start().starts_with("#EXT-X-MAP"))
}

/// The FIRST #EXT-X-KEY method we CAN'T handle server-side, if any ⇒ bail to the HLS rewrite. We decrypt
/// full-segment AES-128 (see the producer); METHOD=NONE and AES-128 are handleable, everything else
/// (SAMPLE-AES/FairPlay, …) is not. Returns the offending method for a specific fallback log.
pub(crate) fn unsupported_encryption(body: &str) -> Option<String> {
    for l in body.split('\n') {
        if let Some(attrs) = l.trim_start().strip_prefix("#EXT-X-KEY:") {
            let method = split_attrs(attrs)
                .into_iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("METHOD"))
                .map(|(_, v)| v.trim().trim_matches('"').to_ascii_uppercase())
                .unwrap_or_default();
            if !method.is_empty() && method != "NONE" && method != "AES-128" {
                return Some(method);
            }
        }
    }
    None
}

/// AES-128-CBC + PKCS7 decrypt one whole HLS segment. None on a bad length / padding ⇒ the caller drops the
/// segment (all-or-nothing: a valid TS packet stream can't be reconstructed from a partial/garbled decrypt).
pub(crate) fn decrypt_aes128_cbc(key: &[u8; 16], iv: &[u8; 16], ct: &[u8]) -> Option<Vec<u8>> {
    if ct.is_empty() || ct.len() % 16 != 0 {
        return None;
    }
    Aes128CbcDec::new_from_slices(key, iv)
        .ok()?
        .decrypt_padded_vec_mut::<Pkcs7>(ct)
        .ok()
}

/// The highest-BANDWIDTH variant's URI (the STREAM-INF URI is the next non-comment line), resolved absolute.
pub(crate) fn pick_variant(body: &str, base: &Url) -> Option<Url> {
    let mut best_bw: i64 = -1;
    let mut best_uri: Option<String> = None;
    let mut pending_bw: Option<i64> = None;
    for raw in body.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw).trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending_bw = Some(parse_bandwidth(rest));
        } else if !line.starts_with('#') {
            if let Some(bw) = pending_bw.take() {
                if bw >= best_bw {
                    best_bw = bw;
                    best_uri = Some(line.to_string());
                }
            }
        }
    }
    best_uri.and_then(|u| base.join(&u).ok())
}

fn parse_bandwidth(attrs: &str) -> i64 {
    // BANDWIDTH is an unquoted integer, so a plain comma split is safe (a quoted CODECS="a,b" comma only ever
    // produces fragments that don't start with "BANDWIDTH=").
    for part in attrs.split(',') {
        if let Some(v) = part.trim().strip_prefix("BANDWIDTH=") {
            return v.trim().parse().unwrap_or(0);
        }
    }
    0
}

/// Re-poll cadence: half the target duration, clamped to a sane [1s, 10s]; a missing target duration → 3s.
pub(crate) fn poll_interval(target_duration: f64) -> Duration {
    let secs = if target_duration > 0.0 { target_duration / 2.0 } else { 3.0 };
    Duration::from_secs_f64(secs.clamp(1.0, 10.0))
}

/// Try to serve the ENTRY as a continuous raw-TS stream. Returns `Some(response)` (a spawned producer streams
/// `video/mp2t`) when the upstream is pure TS, else `None` so the caller falls back to the HLS rewrite.
pub async fn try_ts_response(
    first_body: String,
    first_url: Url,
    ctx: TsContext,
    buffer_size_kb: u64,
) -> Option<Response> {
    // Resolve to the MEDIA playlist to follow (peek the top variant for a master), then guard TS-only.
    let (media_url, media_body) = if is_master(&first_body) {
        let vurl = pick_variant(&first_body, &first_url)?;
        let resp = fetch_with_retry(&ctx.client, vurl.as_str(), &build_headers(&ctx.policy), ctx.read_timeout_ms, &ctx.rid, "ts-variant", MAX_UPSTREAM_RETRIES)
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let furl = resp.url().clone();
        let body = resp.text().await.ok()?;
        (furl, body)
    } else {
        (first_url, first_body)
    };
    // Bail to the HLS rewrite for anything the raw-TS producer can't serve, and WARN specifically so an
    // operator can see which tuner channels silently fall back (and therefore won't play in a TS-only DVR):
    // fMP4 (#EXT-X-MAP) and unsupported encryption (SAMPLE-AES/FairPlay). AES-128 is now handled (decrypted).
    if has_map(&media_body) {
        log::warn("tsmux", &ctx.rid, || {
            format!("raw-TS not eligible for {}/{}: fMP4 (#EXT-X-MAP) — falling back to HLS rewrite", ctx.source, ctx.entry)
        });
        return None;
    }
    if let Some(method) = unsupported_encryption(&media_body) {
        log::warn("tsmux", &ctx.rid, || {
            format!("raw-TS not eligible for {}/{}: unsupported encryption METHOD={method} — falling back to HLS rewrite", ctx.source, ctx.entry)
        });
        return None;
    }

    let (tx, rx) = mpsc::channel::<Result<Bytes, io::Error>>(crate::stream::channel_capacity(buffer_size_kb));
    tokio::spawn(ts_producer(media_url, media_body, ctx, tx));
    Some(
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "video/mp2t")
            .header("cache-control", "no-store")
            .body(Body::from_stream(ReceiverStream::new(rx)))
            .unwrap(),
    )
}

/// Failover: walk the stream's candidates (a fresh resolve of the PINNED candidate first — Node re-runs
/// resolveStream → reprobeMirror, the pre-failover mirror rotation — then, when failoverEnabled, the next
/// failover children via the shared proxy.rs walk) and derive the media playlist again from the winning
/// master. Swaps the producer onto the winning candidate's policy + client (FOG: a cross-provider child's
/// headers live under ITS adapter's policy). `None` ⇒ nothing reachable (the producer ends).
async fn reresolve_media(ctx: &mut TsContext) -> Option<(Url, String)> {
    // Milestone (≥2): a live raw-TS session lost its media playlist and is now failing over.
    log::info("failover", &ctx.rid, || "media playlist unreachable — walking failover candidates".to_string());
    let walk_children = ctx.policy.failover_enabled.load(Ordering::Relaxed);
    let on_definite = ctx.policy.failover_on_definite_error.load(Ordering::Relaxed);
    ctx.state.invalidate_target(&ctx.source, &ctx.entry);
    let start = ctx.state.cursor_attempt(&ctx.source, &ctx.entry);
    let resp = match failover_walk(
        &ctx.state,
        &ctx.source,
        &ctx.entry,
        ctx.pl.as_deref(),
        walk_children,
        on_definite,
        None,
        start,
        true,
        &ctx.rid,
    )
    .await
    {
        WalkOutcome::Recovered(p, _target, r) if r.status().is_success() => {
            // FOG: follow the winning candidate from here on — its policy (headers/relabel/hosts) and the
            // client matching its knobs. Same-provider candidates resolve to the same Arc — a no-op swap.
            ctx.policy = p;
            ctx.client = ctx.state.client_for(
                ctx.policy.connect_timeout_ms.load(Ordering::Relaxed),
                ctx.policy.max_redirects.load(Ordering::Relaxed),
            );
            // Level-3 lineage: the raw-TS producer now follows the winning (possibly cross-provider)
            // candidate's policy + client for the rest of the session (the walk logged the recovery above).
            log::trace("failover", &ctx.rid, || "raw-TS producer swapped onto the winning candidate's policy".to_string());
            r
        }
        _ => return None, // definitive non-2xx / dead — nothing a raw-TS producer can serve
    };
    let furl = resp.url().clone();
    let body = resp.text().await.ok()?;
    if is_master(&body) {
        let vurl = pick_variant(&body, &furl)?;
        let vresp = fetch_with_retry(&ctx.client, vurl.as_str(), &build_headers(&ctx.policy), ctx.read_timeout_ms, &ctx.rid, "ts-variant", MAX_UPSTREAM_RETRIES)
            .await
            .ok()?;
        if !vresp.status().is_success() {
            return None;
        }
        Some((vresp.url().clone(), vresp.text().await.ok()?))
    } else {
        Some((furl, body))
    }
}

async fn ts_producer(
    mut media_url: Url,
    mut media_body: String,
    mut ctx: TsContext,
    tx: mpsc::Sender<Result<Bytes, io::Error>>,
) {
    let stream_id = ctx.state.next_stream_id();
    // OPEN: Node mints a socket-viewer connId for this continuous stream (noteSocketViewerOpen).
    log::info("tsmux", &ctx.rid, || format!("raw-TS session open ({stream_id}) — following {}", crate::proxy::host_of(media_url.as_str())));
    ctx.state.report(serde_json::json!({
        "kind": "open", "streamId": stream_id, "source": ctx.source, "entryUrl": ctx.entry,
        "ip": ctx.ip, "ua": ctx.ua, "username": ctx.username, "playerType": "externalPlayer",
    }));

    let idle = if ctx.read_timeout_ms > 0 {
        Some(Duration::from_millis(ctx.read_timeout_ms))
    } else {
        None
    };
    let mut next_seq: i64 = -1; // -1 = uninitialized (set from the first playlist's head)
    let mut prev_media_seq: i64 = -1;
    let mut pending_bytes: u64 = 0;
    let mut last_flush = Instant::now();
    let mut first = true;
    // AES-128 key cache — HLS keys are stable across the live window, so fetch once per rotation (keyed by URI),
    // not per segment.
    let mut last_key_uri: Option<String> = None;
    let mut last_key: Option<[u8; 16]> = None;

    'outer: loop {
        // Refresh the media playlist each cycle (except the first — we already have it from try_ts_response).
        if !first {
            match fetch_with_retry(&ctx.client, media_url.as_str(), &build_headers(&ctx.policy), ctx.read_timeout_ms, &ctx.rid, "ts-media", MAX_UPSTREAM_RETRIES)
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    // FOG: a raw-TS session holds ONE socket and never re-requests the entry, so keep the
                    // stream's failover-cursor idle clock alive from the healthy refresh loop — otherwise
                    // a pinned session would look idle and snap back to the parent on the next re-resolve.
                    ctx.state.touch_stream(&ctx.source, &ctx.entry);
                    media_url = resp.url().clone();
                    match resp.text().await {
                        Ok(t) => media_body = t,
                        Err(_) => {
                            tokio::time::sleep(Duration::from_secs(1)).await;
                            continue;
                        }
                    }
                }
                _ => match reresolve_media(&mut ctx).await {
                    Some((u, b)) => {
                        media_url = u;
                        media_body = b;
                    }
                    None => {
                        // Issue-level (≥1): the raw-TS session exhausted its failover chain and ends.
                        log::warn("failover", &ctx.rid, || "nothing reachable after re-resolve — ending raw-TS stream".to_string());
                        break 'outer; // nothing reachable — end the stream
                    }
                },
            }
        }
        first = false;

        let mp = parse_media_playlist(&media_body);
        log::trace("tsmux", &ctx.rid, || {
            format!("media poll: seq={} segs={} targetDur={}", mp.media_sequence, mp.segments.len(), mp.target_duration)
        });
        // Playlist reset (media-sequence rewound) → restart from its head so we don't stall on sequence numbers
        // that will never arrive.
        if prev_media_seq >= 0 && mp.media_sequence < prev_media_seq {
            next_seq = mp.media_sequence;
        }
        prev_media_seq = mp.media_sequence;
        if next_seq < 0 {
            next_seq = mp.media_sequence; // first poll: begin at the head of the window
        }

        for (i, seg) in mp.segments.iter().enumerate() {
            let seq = mp.media_sequence + i as i64;
            if seq < next_seq {
                continue; // already served
            }
            next_seq = seq + 1;
            let seg_url = match media_url.join(&seg.uri) {
                Ok(u) => u,
                Err(_) => continue,
            };
            // Defense: never fetch a private/loopback host; grow the observational allowlist with the host.
            if let Some(h) = seg_url.host_str() {
                if is_private_host(h) {
                    continue;
                }
                ctx.policy.hosts.write_ok().insert(h.to_lowercase());
            }

            // Resolve AES-128 key material for this segment (None ⇒ cleartext passthrough). Fetches + caches the
            // 16-byte key by URI, applies the SAME private-host SSRF guard + allowlist grow as segments, and
            // derives the IV (explicit IV=, else the segment media-sequence number). A key we can't fetch/resolve
            // — or an unsupported method appearing mid-stream — drops just this segment (a gap), not the stream.
            let key_material: Option<([u8; 16], [u8; 16])> = match &seg.key {
                None => None,
                Some(k) if k.method == "AES-128" => {
                    let key_url = match media_url.join(&k.uri) {
                        Ok(u) => u,
                        Err(_) => {
                            log::warn("tsmux", &ctx.rid, || format!("bad AES key URI '{}' — dropping segment seq={seq}", k.uri));
                            continue;
                        }
                    };
                    if let Some(h) = key_url.host_str() {
                        if !ctx.policy.allow_private.load(Ordering::Relaxed) && is_private_host(h) {
                            log::warn("tsmux", &ctx.rid, || format!("AES key host {h} private/blocked — dropping segment seq={seq}"));
                            continue;
                        }
                        ctx.policy.hosts.write_ok().insert(h.to_lowercase());
                    }
                    let key = if last_key_uri.as_deref() == Some(key_url.as_str()) {
                        last_key.expect("last_key is set whenever last_key_uri is")
                    } else {
                        match fetch_with_retry(&ctx.client, key_url.as_str(), &build_headers(&ctx.policy), ctx.read_timeout_ms, &ctx.rid, "ts-key", MAX_UPSTREAM_RETRIES)
                            .await
                        {
                            Ok(resp) if resp.status().is_success() => match resp.bytes().await {
                                Ok(b) if b.len() == 16 => {
                                    let mut kb = [0u8; 16];
                                    kb.copy_from_slice(&b);
                                    last_key_uri = Some(key_url.as_str().to_string());
                                    last_key = Some(kb);
                                    kb
                                }
                                Ok(b) => {
                                    log::warn("tsmux", &ctx.rid, || format!("AES key wrong size {} (want 16) — dropping segment seq={seq}", b.len()));
                                    continue;
                                }
                                Err(_) => {
                                    log::warn("tsmux", &ctx.rid, || format!("AES key body read failed — dropping segment seq={seq}"));
                                    continue;
                                }
                            },
                            _ => {
                                log::warn("tsmux", &ctx.rid, || format!("AES key fetch failed — gap (dropping segment seq={seq})"));
                                ctx.state.report(serde_json::json!({
                                    "kind": "upstream", "ok": false, "status": 0, "source": ctx.source, "entryUrl": ctx.entry,
                                }));
                                continue;
                            }
                        }
                    };
                    let iv = k.iv.unwrap_or_else(|| {
                        let mut iv = [0u8; 16];
                        iv[8..].copy_from_slice(&(seq as u64).to_be_bytes());
                        iv
                    });
                    Some((key, iv))
                }
                Some(k) => {
                    // Mid-stream rotation to a method we don't handle (the entry guard only saw the first poll).
                    log::warn("tsmux", &ctx.rid, || format!("unsupported mid-stream encryption METHOD={} — dropping segment seq={seq}", k.method));
                    continue;
                }
            };

            log::trace("tsmux", &ctx.rid, || format!("TS segment seq={seq} → {}", crate::proxy::host_of(seg_url.as_str())));
            match fetch_with_retry(&ctx.client, seg_url.as_str(), &build_headers(&ctx.policy), ctx.read_timeout_ms, &ctx.rid, "ts-segment", MAX_UPSTREAM_RETRIES)
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    let mut s = Box::pin(resp.bytes_stream());
                    match key_material {
                        // CLEARTEXT: stream chunk-by-chunk, partial-tolerant (unchanged — no buffering).
                        None => loop {
                            let chunk = match idle {
                                Some(d) => match tokio::time::timeout(d, s.next()).await {
                                    Ok(x) => x,
                                    Err(_) => break, // segment stalled — truncate + move on (partial tolerance)
                                },
                                None => s.next().await,
                            };
                            match chunk {
                                Some(Ok(b)) => {
                                    pending_bytes += b.len() as u64;
                                    if tx.send(Ok(b)).await.is_err() {
                                        break 'outer; // client disconnected — tear down (close reported below)
                                    }
                                }
                                Some(Err(_)) => break, // truncated segment — tolerate, continue with the next
                                None => break,          // segment complete
                            }
                        },
                        // ENCRYPTED: buffer the WHOLE ciphertext, then AES-128-CBC decrypt and send ONCE. All-or-
                        // nothing — a truncated ciphertext can't be validly CBC-decrypted, so a stall/error drops it.
                        Some((key, iv)) => {
                            let mut cipher_buf: Vec<u8> = Vec::new();
                            let mut complete = false;
                            loop {
                                let chunk = match idle {
                                    Some(d) => match tokio::time::timeout(d, s.next()).await {
                                        Ok(x) => x,
                                        Err(_) => break, // stalled → incomplete → dropped below
                                    },
                                    None => s.next().await,
                                };
                                match chunk {
                                    Some(Ok(b)) => cipher_buf.extend_from_slice(&b),
                                    Some(Err(_)) => break, // truncated → incomplete → dropped below
                                    None => {
                                        complete = true;
                                        break;
                                    }
                                }
                            }
                            if !complete {
                                log::warn("tsmux", &ctx.rid, || format!("encrypted segment seq={seq} truncated ({} bytes) — dropping", cipher_buf.len()));
                                continue;
                            }
                            match decrypt_aes128_cbc(&key, &iv, &cipher_buf) {
                                Some(plain) => {
                                    pending_bytes += plain.len() as u64;
                                    if tx.send(Ok(Bytes::from(plain))).await.is_err() {
                                        break 'outer; // client disconnected — tear down
                                    }
                                }
                                None => {
                                    log::warn("tsmux", &ctx.rid, || format!("AES-128 decrypt failed for segment seq={seq} ({} bytes) — dropping", cipher_buf.len()));
                                }
                            }
                        }
                    }
                }
                _ => {
                    // A segment fetch failed → a gap; report a transient upstream failure and keep going.
                    log::warn("tsmux", &ctx.rid, || format!("TS segment seq={seq} fetch failed — gap (continuing)"));
                    ctx.state.report(serde_json::json!({
                        "kind": "upstream", "ok": false, "status": 0, "source": ctx.source, "entryUrl": ctx.entry,
                    }));
                }
            }
            // Periodic byte flush → a smooth egress rate for a long-lived stream (not just one end burst).
            if pending_bytes > 0 && last_flush.elapsed() >= Duration::from_secs(1) {
                ctx.state.report(serde_json::json!({
                    "kind": "sbytes", "streamId": stream_id, "bytes": pending_bytes,
                }));
                pending_bytes = 0;
                last_flush = Instant::now();
            }
        }

        if mp.endlist {
            log::info("tsmux", &ctx.rid, || "playlist #EXT-X-ENDLIST — raw-TS stream complete".to_string());
            break 'outer; // VOD / finished event
        }
        tokio::time::sleep(poll_interval(mp.target_duration)).await;
    }

    // CLOSE: flush residual bytes, then tell Node the socket session ended (noteSocketViewerClose).
    if pending_bytes > 0 {
        ctx.state.report(serde_json::json!({ "kind": "sbytes", "streamId": stream_id, "bytes": pending_bytes }));
    }
    log::info("tsmux", &ctx.rid, || format!("raw-TS session close ({stream_id})"));
    ctx.state.report(serde_json::json!({ "kind": "close", "streamId": stream_id }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("https://cdn.example.com/live/index.m3u8").unwrap()
    }

    #[test]
    fn parses_media_playlist_seq_and_segments() {
        let m = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:42\n#EXTINF:6.0,\nseg42.ts\n#EXTINF:6.0,\nseg43.ts\n";
        let mp = parse_media_playlist(m);
        assert_eq!(mp.media_sequence, 42);
        assert_eq!(mp.target_duration, 6.0);
        assert!(!mp.endlist);
        let uris: Vec<&str> = mp.segments.iter().map(|s| s.uri.as_str()).collect();
        assert_eq!(uris, vec!["seg42.ts", "seg43.ts"]);
        assert!(mp.segments.iter().all(|s| s.key.is_none()));
        // #EXTINF is captured per segment (ORIGIN republishes it) and applies to the segment that FOLLOWS it.
        assert!(mp.segments.iter().all(|s| s.duration == 6.0));
        assert!(mp.segments.iter().all(|s| !s.discontinuity));
    }

    #[test]
    fn parses_extinf_and_discontinuity_positionally() {
        // A DISCONTINUITY applies only to the segment right after it, and #EXT-X-DISCONTINUITY-SEQUENCE is a
        // playlist HEADER that must not be mistaken for a splice (the prefix guard in parse_media_playlist).
        let m = "#EXTM3U\n#EXT-X-DISCONTINUITY-SEQUENCE:7\n#EXT-X-MEDIA-SEQUENCE:1\n\
                 #EXTINF:5.005,\na.ts\n\
                 #EXT-X-DISCONTINUITY\n#EXTINF:4.0,title here\nb.ts\n\
                 #EXTINF:3.5,\nc.ts\n";
        let mp = parse_media_playlist(m);
        assert_eq!(mp.segments.len(), 3);
        assert!(!mp.segments[0].discontinuity, "-SEQUENCE header must not flag a splice");
        assert!(mp.segments[1].discontinuity, "the tag applies to the NEXT segment");
        assert!(!mp.segments[2].discontinuity, "and is cleared after use");
        assert_eq!(mp.segments[0].duration, 5.005);
        assert_eq!(mp.segments[1].duration, 4.0); // "#EXTINF:4.0,title here" — the title is dropped
        assert_eq!(mp.segments[2].duration, 3.5);
    }

    #[test]
    fn cue_out_is_sticky_until_cue_in() {
        // Unlike #EXTINF/#EXT-X-DISCONTINUITY (pending, one segment), a cue-out covers EVERY following
        // segment until it is closed — the #EXT-X-KEY posture.
        let m = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n\
                 #EXTINF:6,\npgm1.ts\n\
                 #EXT-X-CUE-OUT:30.000\n#EXTINF:6,\nad1.ts\n\
                 #EXTINF:6,\nad2.ts\n\
                 #EXT-X-CUE-IN\n#EXTINF:6,\npgm2.ts\n";
        let mp = parse_media_playlist(m);
        assert_eq!(mp.segments.len(), 4);
        assert_eq!(mp.segments[0].cue, None, "program before the break");
        assert_eq!(mp.segments[1].cue.unwrap().kind, CueKind::CueOut);
        assert_eq!(mp.segments[1].cue.unwrap().duration, 30.0);
        assert!(mp.segments[2].cue.is_some(), "the break stays open across segments");
        assert_eq!(mp.segments[3].cue, None, "CUE-IN closes it");
    }

    #[test]
    fn cue_out_cont_keeps_the_announced_total() {
        // `-CONT` re-states an open break and carries elapsed/total, so it must not clobber the opening
        // tag's total — and it must not be swallowed by the `#EXT-X-CUE-OUT` prefix arm.
        let m = "#EXTM3U\n#EXT-X-CUE-OUT:30.000\n#EXTINF:6,\na.ts\n\
                 #EXT-X-CUE-OUT-CONT:6.000/30.000\n#EXTINF:6,\nb.ts\n";
        let mp = parse_media_playlist(m);
        assert_eq!(mp.segments[1].cue.unwrap().duration, 30.0);
        // …but joining mid-break (a -CONT with nothing open) still opens one, using its total.
        let joined = parse_media_playlist("#EXTM3U\n#EXT-X-CUE-OUT-CONT:12.0/30.0\n#EXTINF:6,\nx.ts\n");
        assert_eq!(joined.segments[0].cue.unwrap().duration, 30.0);
    }

    #[test]
    fn daterange_scte35_opens_and_closes() {
        let m = "#EXTM3U\n\
                 #EXT-X-DATERANGE:ID=\"1\",START-DATE=\"2026-01-01T00:00:00Z\",PLANNED-DURATION=120.0,SCTE35-OUT=0xFC30\n\
                 #EXTINF:6,\nad.ts\n\
                 #EXT-X-DATERANGE:ID=\"1\",SCTE35-IN=0xFC30\n#EXTINF:6,\npgm.ts\n";
        let mp = parse_media_playlist(m);
        assert_eq!(mp.segments[0].cue.unwrap().kind, CueKind::DateRange);
        assert_eq!(mp.segments[0].cue.unwrap().duration, 120.0);
        assert_eq!(mp.segments[1].cue, None);
    }

    #[test]
    fn cue_duration_accepts_the_wild_spellings() {
        assert_eq!(cue_duration("#EXT-X-CUE-OUT:30.000"), 30.0);
        assert_eq!(cue_duration("#EXT-X-CUE-OUT:DURATION=30"), 30.0);
        assert_eq!(cue_duration("#EXT-X-CUE-OUT-CONT:8.0/30.0"), 30.0);
        assert_eq!(cue_duration("#EXT-X-CUE-OUT-CONT:ElapsedTime=8.0,Duration=30.0"), 30.0);
        assert_eq!(cue_duration("#EXT-X-CUE-OUT"), 0.0, "an unannounced break is normal, not an error");
    }

    #[test]
    fn detects_endlist() {
        assert!(parse_media_playlist("#EXTM3U\n#EXTINF:6,\ns.ts\n#EXT-X-ENDLIST\n").endlist);
    }

    #[test]
    fn master_detection_and_highest_bandwidth_variant() {
        let m = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlo.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS=\"avc1,mp4a\"\nhi.m3u8\n";
        assert!(is_master(m));
        assert_eq!(pick_variant(m, &base()).unwrap().as_str(), "https://cdn.example.com/live/hi.m3u8");
    }

    #[test]
    fn media_playlist_is_not_master() {
        assert!(!is_master("#EXTM3U\n#EXTINF:6,\ns.ts\n"));
    }

    #[test]
    fn guards_fmp4_and_unsupported_encryption() {
        assert!(has_map("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\ns.m4s\n"));
        // AES-128 is now HANDLED (decrypted server-side) → NOT unsupported.
        assert_eq!(
            unsupported_encryption("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n#EXTINF:6,\ns.ts\n"),
            None
        );
        // SAMPLE-AES (FairPlay) is unsupported → bail, surfacing the method for the operator warn log.
        assert_eq!(
            unsupported_encryption("#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://x\"\n#EXTINF:6,\ns.ts\n"),
            Some("SAMPLE-AES".to_string())
        );
        assert_eq!(unsupported_encryption("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6,\ns.ts\n"), None);
        assert_eq!(unsupported_encryption("#EXTM3U\n#EXTINF:6,\ns.ts\n"), None);
    }

    #[test]
    fn parses_ext_x_key_positionally() {
        // A KEY applies to following segments until the next KEY; METHOD=NONE clears it. The URI carries commas
        // inside quotes (must not split); IV is optional.
        let m = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n\
                 #EXT-X-KEY:METHOD=AES-128,URI=\"https://k.example/key?a=1,b=2\",IV=0x000102030405060708090A0B0C0D0E0F\n\
                 #EXTINF:6,\nenc1.ts\n\
                 #EXTINF:6,\nenc2.ts\n\
                 #EXT-X-KEY:METHOD=NONE\n\
                 #EXTINF:6,\nclear.ts\n";
        let mp = parse_media_playlist(m);
        let enc = SegKey {
            method: "AES-128".to_string(),
            uri: "https://k.example/key?a=1,b=2".to_string(),
            iv: Some([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
        };
        assert_eq!(mp.segments[0].uri, "enc1.ts");
        assert_eq!(mp.segments[0].key, Some(enc.clone()));
        assert_eq!(mp.segments[1].uri, "enc2.ts");
        assert_eq!(mp.segments[1].key, Some(enc));
        assert_eq!(mp.segments[2].uri, "clear.ts");
        assert_eq!(mp.segments[2].key, None); // cleared by METHOD=NONE
    }

    #[test]
    fn parses_iv_hex() {
        assert_eq!(
            parse_iv("0x000102030405060708090a0b0c0d0e0f"),
            Some([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
        );
        assert_eq!(parse_iv("0xdeadbeef"), None); // wrong length
        assert_eq!(parse_iv("nothex!!"), None);
    }

    #[test]
    fn aes128_cbc_pkcs7_known_answer() {
        // Vector generated INDEPENDENTLY with openssl (not the aes/cbc crate):
        //   printf 'hello-masqueradarr-tsmux!' | openssl enc -aes-128-cbc -K 000102…0f -iv 101112…1f
        let key: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
        let iv: [u8; 16] = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31];
        let ct = hex::decode("a44d1e384e0f018cd0a53592855da68441d5b954126f3929ff396a1e7eb9f207").unwrap();
        let pt = decrypt_aes128_cbc(&key, &iv, &ct).expect("decrypt should succeed");
        assert_eq!(pt, b"hello-masqueradarr-tsmux!");
    }

    #[test]
    fn decrypt_rejects_bad_length() {
        let (key, iv) = ([0u8; 16], [0u8; 16]);
        assert!(decrypt_aes128_cbc(&key, &iv, &[]).is_none()); // empty
        assert!(decrypt_aes128_cbc(&key, &iv, &[0u8; 17]).is_none()); // not a 16-byte multiple
    }

    #[test]
    fn poll_interval_clamps() {
        assert_eq!(poll_interval(6.0), Duration::from_secs(3));
        assert_eq!(poll_interval(0.0), Duration::from_secs(3)); // missing → default 3s
        assert_eq!(poll_interval(30.0), Duration::from_secs(10)); // clamp high
        assert_eq!(poll_interval(1.0), Duration::from_secs(1)); // 0.5 → clamp low to 1s
    }
}
