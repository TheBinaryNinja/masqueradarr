
use axum::body::Body;
use axum::http::StatusCode;
use axum::response::Response;
use bytes::Bytes;
use std::collections::HashSet;
use std::io;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;
use url::Url;

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};

use crate::log;
use crate::proxy::{build_headers, failover_walk, fetch_with_retry, is_private_host, WalkOutcome, MAX_UPSTREAM_RETRIES};
use crate::state::{AppState, SourcePolicy};
use crate::sync::RwExt;
use crate::tsseg::{disguise_prefix_len, DisguiseStripper};

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

pub struct TsContext {
    pub state: AppState,
    pub policy: Arc<SourcePolicy>,
    pub source: String,
    pub entry: String,
    pub pl: Option<String>,
    pub rid: String,
    pub client: reqwest::Client,
    pub read_timeout_ms: u64,
    pub ip: String,
    pub ua: String,
    pub username: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SegKey {
    pub method: String,
    pub uri: String,
    pub iv: Option<[u8; 16]>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SegRef {
    pub uri: String,
    pub key: Option<SegKey>,
    pub duration: f64,
    pub discontinuity: bool,
    pub cue: Option<CueState>,
    pub pdt_ms: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CueKind {
    CueOut,
    DateRange,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct CueState {
    pub kind: CueKind,
    pub duration: f64,
}

pub(crate) struct MediaPlaylist {
    pub media_sequence: i64,
    pub target_duration: f64,
    pub endlist: bool,
    pub segments: Vec<SegRef>,
}

pub(crate) fn parse_media_playlist(body: &str) -> MediaPlaylist {
    let mut media_sequence = 0i64;
    let mut target_duration = 0f64;
    let mut endlist = false;
    let mut segments: Vec<SegRef> = Vec::new();
    let mut active_key: Option<SegKey> = None;
    let mut active_cue: Option<CueState> = None;
    let mut pending_duration = 0f64;
    let mut pending_discontinuity = false;
    let mut pdt_cursor: Option<i64> = None;
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
            pending_discontinuity = true;
        } else if let Some(v) = line.strip_prefix("#EXT-X-PROGRAM-DATE-TIME:") {
            pdt_cursor = parse_rfc3339_ms(v.trim());
        } else if let Some(v) = line.strip_prefix("#EXTINF:") {
            pending_duration = v.split(',').next().unwrap_or("").trim().parse().unwrap_or(0.0);
        } else if let Some(attrs) = line.strip_prefix("#EXT-X-KEY:") {
            active_key = parse_key(attrs);
        } else if line.starts_with("#EXT-X-CUE-IN") {
            active_cue = None;
        } else if line.starts_with("#EXT-X-CUE-OUT") {
            let cont = line.starts_with("#EXT-X-CUE-OUT-CONT");
            active_cue = Some(match (cont, active_cue) {
                (true, Some(open)) => open,
                _ => CueState { kind: CueKind::CueOut, duration: cue_duration(line) },
            });
        } else if let Some(attrs) = line.strip_prefix("#EXT-X-DATERANGE:") {
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
                pdt_ms: pdt_cursor,
            });
            pdt_cursor = pdt_cursor.map(|t| t + (pending_duration * 1000.0).round() as i64);
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

fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] | 0x20) != b't' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> { s.get(r)?.parse::<i64>().ok() };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let mut rest = &s[19..];
    let mut millis = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return None;
        }
        let ms: String = digits.chars().chain(std::iter::repeat('0')).take(3).collect();
        millis = ms.parse().ok()?;
        rest = &rest[1 + digits.len()..];
    }
    let zone_ms: i64 = match rest.as_bytes().first() {
        None => 0,
        Some(&z) if z == b'Z' || z == b'z' => 0,
        Some(&sign) if sign == b'+' || sign == b'-' => {
            let z = &rest[1..];
            let (zh, zm) = match z.find(':') {
                Some(i) => (z.get(..i)?.parse::<i64>().ok()?, z.get(i + 1..i + 3)?.parse::<i64>().ok()?),
                None => (z.get(..2)?.parse::<i64>().ok()?, z.get(2..4)?.parse::<i64>().ok()?),
            };
            let off = (zh * 60 + zm) * 60_000;
            if sign == b'+' {
                -off
            } else {
                off
            }
        }
        _ => return None,
    };
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + h * 3_600 + mi * 60 + sec) * 1_000) + millis + zone_ms)
}

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

fn cue_duration(line: &str) -> f64 {
    let Some((_, v)) = line.split_once(':') else {
        return 0.0;
    };
    let v = v.trim();
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

pub(crate) fn is_master(body: &str) -> bool {
    body.split('\n').any(|l| l.trim_start().starts_with("#EXT-X-STREAM-INF"))
}

pub(crate) fn has_map(body: &str) -> bool {
    body.split('\n').any(|l| l.trim_start().starts_with("#EXT-X-MAP"))
}

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

pub(crate) fn encryption_method(body: &str) -> String {
    let mut method = "NONE".to_string();
    for l in body.split('\n') {
        if let Some(attrs) = l.trim_start().strip_prefix("#EXT-X-KEY:") {
            let m = split_attrs(attrs)
                .into_iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("METHOD"))
                .map(|(_, v)| v.trim().trim_matches('"').to_ascii_uppercase())
                .unwrap_or_default();
            method = if m.is_empty() { "UNKNOWN".to_string() } else { m };
        }
    }
    method
}

pub(crate) fn decrypt_aes128_cbc(key: &[u8; 16], iv: &[u8; 16], ct: &[u8]) -> Option<Vec<u8>> {
    if ct.is_empty() || !ct.len().is_multiple_of(16) {
        return None;
    }
    Aes128CbcDec::new_from_slices(key, iv)
        .ok()?
        .decrypt_padded_vec_mut::<Pkcs7>(ct)
        .ok()
}

#[derive(Clone, Debug)]
pub(crate) struct AudioRendition {
    pub group: String,
    pub url: Url,
    pub name: String,
    pub language: String,
    pub default: bool,
    pub autoselect: bool,
    pub describes_video: bool,
}

fn audio_media(body: &str, base: &Url) -> (Vec<AudioRendition>, HashSet<String>) {
    let mut out = Vec::new();
    let mut muxed = HashSet::new();
    for l in body.split('\n') {
        let Some(attrs) = l.trim_start().strip_prefix("#EXT-X-MEDIA:") else { continue };
        let attrs = split_attrs(attrs);
        let val = |k: &str| {
            attrs
                .iter()
                .find(|(a, _)| a.eq_ignore_ascii_case(k))
                .map(|(_, v)| v.trim().trim_matches('"').to_string())
        };
        if !val("TYPE").is_some_and(|t| t.eq_ignore_ascii_case("AUDIO")) {
            continue;
        }
        let Some(uri) = val("URI").filter(|u| !u.is_empty()) else {
            if let Some(g) = val("GROUP-ID") {
                muxed.insert(g);
            }
            continue;
        };
        let (Some(group), Ok(url)) = (val("GROUP-ID"), base.join(&uri)) else { continue };
        let yes = |k: &str| val(k).is_some_and(|v| v.eq_ignore_ascii_case("YES"));
        out.push(AudioRendition {
            group,
            url,
            name: val("NAME").unwrap_or_default(),
            language: val("LANGUAGE").unwrap_or_default(),
            default: yes("DEFAULT"),
            autoselect: yes("AUTOSELECT"),
            describes_video: val("CHARACTERISTICS")
                .is_some_and(|c| c.to_ascii_lowercase().contains("public.accessibility.describes-video")),
        });
    }
    (out, muxed)
}


fn pick_rendition(renditions: &[AudioRendition], group: &str) -> Option<AudioRendition> {
    let pick = |ad: bool| {
        let in_group = || renditions.iter().filter(|r| r.group == group && r.describes_video == ad);
        in_group()
            .find(|r| r.default)
            .or_else(|| in_group().find(|r| r.autoselect))
            .or_else(|| in_group().next())
            .cloned()
    };
    pick(false).or_else(|| pick(true))
}

pub(crate) struct VariantPick {
    pub url: Url,
    pub external_audio: bool,
    pub audio: Option<AudioRendition>,
    pub bandwidth: i64,
    pub resolution: Option<String>,
    pub codecs: Option<String>,
    pub frame_rate: Option<String>,
}

#[derive(Default, Clone)]
struct VariantAttrs {
    resolution: Option<String>,
    codecs: Option<String>,
    frame_rate: Option<String>,
}

pub(crate) fn pick_variant(body: &str, base: &Url) -> Option<VariantPick> {
    let (renditions, muxed) = audio_media(body, base);
    let demuxed: HashSet<String> =
        renditions.iter().map(|r| r.group.clone()).filter(|g| !muxed.contains(g)).collect();
    let mut best: Option<(i64, String, VariantAttrs)> = None;
    let mut best_any: Option<(i64, String, Option<String>, VariantAttrs)> = None;
    let mut pending: Option<(i64, Option<String>, VariantAttrs)> = None;
    for raw in body.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw).trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            let parsed = split_attrs(rest);
            let attr = |name: &str| {
                parsed
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(name))
                    .map(|(_, v)| v.trim().trim_matches('"').to_string())
                    .filter(|v| !v.is_empty())
            };
            let group = attr("AUDIO").filter(|g| demuxed.contains(g));
            let attrs = VariantAttrs {
                resolution: attr("RESOLUTION"),
                codecs: attr("CODECS"),
                frame_rate: attr("FRAME-RATE"),
            };
            pending = Some((parse_bandwidth(rest), group, attrs));
        } else if !line.starts_with('#') {
            if let Some((bw, group, attrs)) = pending.take() {
                if group.is_none() && best.as_ref().is_none_or(|(b, _, _)| bw >= *b) {
                    best = Some((bw, line.to_string(), attrs.clone()));
                }
                if best_any.as_ref().is_none_or(|(b, _, _, _)| bw >= *b) {
                    best_any = Some((bw, line.to_string(), group, attrs));
                }
            }
        }
    }
    let (uri, external_audio, group, bandwidth, attrs) = match best {
        Some((bw, u, a)) => (u, false, None, bw, a),
        None => {
            let (bw, u, g, a) = best_any?;
            (u, true, g, bw, a)
        }
    };
    let audio = group.as_deref().and_then(|g| pick_rendition(&renditions, g));
    base.join(&uri).ok().map(|url| VariantPick {
        url,
        external_audio,
        audio,
        bandwidth: bandwidth.max(0),
        resolution: attrs.resolution,
        codecs: attrs.codecs,
        frame_rate: attrs.frame_rate,
    })
}

fn parse_bandwidth(attrs: &str) -> i64 {
    for part in attrs.split(',') {
        if let Some(v) = part.trim().strip_prefix("BANDWIDTH=") {
            return v.trim().parse().unwrap_or(0);
        }
    }
    0
}

pub(crate) fn poll_interval(target_duration: f64) -> Duration {
    let secs = if target_duration > 0.0 { target_duration / 2.0 } else { 3.0 };
    Duration::from_secs_f64(secs.clamp(1.0, 10.0))
}

pub async fn try_ts_response(
    first_body: String,
    first_url: Url,
    ctx: TsContext,
    buffer_size_kb: u64,
) -> Option<Response> {
    let (media_url, media_body) = if is_master(&first_body) {
        let pick = pick_variant(&first_body, &first_url)?;
        if pick.external_audio {
            log::warn("tsmux", &ctx.rid, || {
                format!(
                    "raw-TS not eligible for {}/{}: audio is a separate #EXT-X-MEDIA rendition — falling back to HLS rewrite",
                    ctx.source, ctx.entry
                )
            });
            return None;
        }
        let resp = fetch_with_retry(&ctx.client, pick.url.as_str(), &build_headers(&ctx.policy), ctx.read_timeout_ms, &ctx.rid, "ts-variant", MAX_UPSTREAM_RETRIES)
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

const REWALK_DEAD: &str = "failover_exhausted";
const REWALK_REFUSED: &str = "source_stream_cap";

const JOIN_FIRST_PROBE: usize = 64 << 10;

const JOIN_HOLD_CAP: usize = 8 << 20;

async fn reresolve_media(ctx: &mut TsContext) -> Result<(Url, String), &'static str> {
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
            ctx.policy = p;
            ctx.client = ctx.state.client_for(
                ctx.policy.connect_timeout_ms.load(Ordering::Relaxed),
                ctx.policy.max_redirects.load(Ordering::Relaxed),
            );
            log::trace("failover", &ctx.rid, || "raw-TS producer swapped onto the winning candidate's policy".to_string());
            r
        }
        WalkOutcome::Refused(why) => {
            log::info("tsmux", &ctx.rid, || format!("re-resolve refused by the source's stream cap — {why}"));
            return Err(REWALK_REFUSED);
        }
        _ => return Err(REWALK_DEAD),
    };
    let furl = resp.url().clone();
    let body = resp.text().await.map_err(|_| REWALK_DEAD)?;
    if is_master(&body) {
        let pick = pick_variant(&body, &furl).ok_or(REWALK_DEAD)?;
        if pick.external_audio {
            log::warn("tsmux", &ctx.rid, || {
                format!(
                    "{}/{}: re-resolved upstream defers audio to a separate #EXT-X-MEDIA rendition — cannot continue as raw TS",
                    ctx.source, ctx.entry
                )
            });
            return Err(REWALK_DEAD);
        }
        let vresp = fetch_with_retry(&ctx.client, pick.url.as_str(), &build_headers(&ctx.policy), ctx.read_timeout_ms, &ctx.rid, "ts-variant", MAX_UPSTREAM_RETRIES)
            .await
            .map_err(|_| REWALK_DEAD)?;
        if !vresp.status().is_success() {
            return Err(REWALK_DEAD);
        }
        let vurl = vresp.url().clone();
        Ok((vurl, vresp.text().await.map_err(|_| REWALK_DEAD)?))
    } else {
        Ok((furl, body))
    }
}

async fn ts_producer(
    mut media_url: Url,
    mut media_body: String,
    mut ctx: TsContext,
    tx: mpsc::Sender<Result<Bytes, io::Error>>,
) {
    let stream_id = ctx.state.next_stream_id();
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
    let mut next_seq: i64 = -1;
    let mut prev_media_seq: i64 = -1;
    let mut pending_bytes: u64 = 0;
    let mut last_flush = Instant::now();
    let close_reason;
    let mut first = true;
    let mut last_key_uri: Option<String> = None;
    let mut last_key: Option<[u8; 16]> = None;
    let mut unwrap_logged = false;
    let mut private_logged = false;
    let mut joined = false;

    'outer: loop {
        if tx.is_closed() {
            close_reason = "client_gone";
            break 'outer;
        }
        if !first {
            match fetch_with_retry(&ctx.client, media_url.as_str(), &build_headers(&ctx.policy), ctx.read_timeout_ms, &ctx.rid, "ts-media", MAX_UPSTREAM_RETRIES)
                .await
            {
                Ok(resp) if resp.status().is_success() => {
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
                    Ok((u, b)) => {
                        media_url = u;
                        media_body = b;
                        joined = false;
                    }
                    Err(reason) => {
                        if reason == REWALK_DEAD {
                            log::warn("failover", &ctx.rid, || "nothing reachable after re-resolve — ending raw-TS stream".to_string());
                        }
                        close_reason = reason;
                        break 'outer;
                    }
                },
            }
        }
        first = false;

        let mp = parse_media_playlist(&media_body);
        log::trace("tsmux", &ctx.rid, || {
            format!("media poll: seq={} segs={} targetDur={}", mp.media_sequence, mp.segments.len(), mp.target_duration)
        });
        if prev_media_seq >= 0 && mp.media_sequence < prev_media_seq {
            next_seq = mp.media_sequence;
            joined = false;
        }
        prev_media_seq = mp.media_sequence;
        if next_seq < 0 {
            next_seq = mp.media_sequence;
        }

        for (i, seg) in mp.segments.iter().enumerate() {
            let seq = mp.media_sequence + i as i64;
            if seq < next_seq {
                continue;
            }
            if tx.is_closed() {
                close_reason = "client_gone";
                break 'outer;
            }
            next_seq = seq + 1;
            let seg_url = match media_url.join(&seg.uri) {
                Ok(u) => u,
                Err(_) => continue,
            };
            if let Some(h) = seg_url.host_str() {
                if !ctx.policy.allow_private.load(Ordering::Relaxed) && is_private_host(h) {
                    if !private_logged {
                        private_logged = true;
                        log::warn("tsmux", &ctx.rid, || format!("segment host {h} private/blocked — skipping its segments"));
                    }
                    continue;
                }
                ctx.policy.hosts.write_ok().insert(h.to_lowercase());
            }

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
                    log::warn("tsmux", &ctx.rid, || format!("unsupported mid-stream encryption METHOD={} — dropping segment seq={seq}", k.method));
                    continue;
                }
            };

            log::trace("tsmux", &ctx.rid, || format!("TS segment seq={seq} → {}", crate::proxy::host_of(seg_url.as_str())));
            let unwrap = ctx.policy.segment_unwrap.load(Ordering::Relaxed);
            if seg.discontinuity {
                joined = false;
            }
            let trim_join = unwrap && !joined;
            match fetch_with_retry(&ctx.client, seg_url.as_str(), &build_headers(&ctx.policy), ctx.read_timeout_ms, &ctx.rid, "ts-segment", MAX_UPSTREAM_RETRIES)
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    let mut s = Box::pin(resp.bytes_stream());
                    match key_material {
                        None => {
                            let mut strip = unwrap.then(DisguiseStripper::new);
                            let mut held: Option<Vec<u8>> = trim_join.then(Vec::new);
                            let mut probe_at = JOIN_FIRST_PROBE;
                            loop {
                                let chunk = match idle {
                                    Some(d) => match tokio::time::timeout(d, s.next()).await {
                                        Ok(x) => x,
                                        Err(_) => break,
                                    },
                                    None => s.next().await,
                                };
                                match chunk {
                                    Some(Ok(b)) => {
                                        let out = match strip.as_mut() {
                                            Some(st) => st.push(b),
                                            None => Some(b),
                                        };
                                        let Some(out) = out else { continue };
                                        let out = match held.take() {
                                            None => out,
                                            Some(mut h) => {
                                                h.extend_from_slice(&out);
                                                if !join_is_ready(&h, &mut probe_at) {
                                                    held = Some(h);
                                                    continue;
                                                }
                                                join_at_keyframe(&ctx, seq, Bytes::from(h))
                                            }
                                        };
                                        let n = out.len() as u64;
                                        if tx.send(Ok(out)).await.is_err() {
                                            close_reason = "client_gone";
                                            break 'outer;
                                        }
                                        pending_bytes += n;
                                        joined = true;
                                    }
                                    Some(Err(_)) => break,
                                    None => break,
                                }
                            }
                            if let Some(st) = strip.as_mut() {
                                if let Some(out) = st.finish() {
                                    if let Some(h) = held.as_mut() {
                                        h.extend_from_slice(&out);
                                    } else {
                                        let n = out.len() as u64;
                                        if tx.send(Ok(out)).await.is_err() {
                                            close_reason = "client_gone";
                                            break 'outer;
                                        }
                                        pending_bytes += n;
                                        joined = true;
                                    }
                                }
                                note_unwrap(&ctx, &mut unwrap_logged, st.stripped());
                            }
                            if let Some(h) = held.take().filter(|h| !h.is_empty()) {
                                let out = join_at_keyframe(&ctx, seq, Bytes::from(h));
                                let n = out.len() as u64;
                                if tx.send(Ok(out)).await.is_err() {
                                    close_reason = "client_gone";
                                    break 'outer;
                                }
                                pending_bytes += n;
                                joined = true;
                            }
                        }
                        Some((key, iv)) => {
                            let mut cipher_buf: Vec<u8> = Vec::new();
                            let mut complete = false;
                            loop {
                                let chunk = match idle {
                                    Some(d) => match tokio::time::timeout(d, s.next()).await {
                                        Ok(x) => x,
                                        Err(_) => break,
                                    },
                                    None => s.next().await,
                                };
                                match chunk {
                                    Some(Ok(b)) => cipher_buf.extend_from_slice(&b),
                                    Some(Err(_)) => break,
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
                                    let plain = Bytes::from(plain);
                                    let out = match unwrap.then(|| disguise_prefix_len(&plain)).flatten() {
                                        Some(n) => {
                                            note_unwrap(&ctx, &mut unwrap_logged, n);
                                            plain.slice(n..)
                                        }
                                        None => plain,
                                    };
                                    let out = if trim_join { join_at_keyframe(&ctx, seq, out) } else { out };
                                    let n = out.len() as u64;
                                    if tx.send(Ok(out)).await.is_err() {
                                        close_reason = "client_gone";
                                        break 'outer;
                                    }
                                    pending_bytes += n;
                                    joined = true;
                                }
                                None => {
                                    log::warn("tsmux", &ctx.rid, || format!("AES-128 decrypt failed for segment seq={seq} ({} bytes) — dropping", cipher_buf.len()));
                                }
                            }
                        }
                    }
                }
                _ => {
                    log::warn("tsmux", &ctx.rid, || format!("TS segment seq={seq} fetch failed — gap (continuing)"));
                    ctx.state.report(serde_json::json!({
                        "kind": "upstream", "ok": false, "status": 0, "source": ctx.source, "entryUrl": ctx.entry,
                    }));
                }
            }
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
            close_reason = "endlist";
            break 'outer;
        }
        let gone = tokio::select! {
            _ = tx.closed() => true,
            _ = tokio::time::sleep(poll_interval(mp.target_duration)) => false,
        };
        if gone {
            close_reason = "client_gone";
            break 'outer;
        }
    }

    if pending_bytes > 0 {
        ctx.state.report(serde_json::json!({ "kind": "sbytes", "streamId": stream_id, "bytes": pending_bytes }));
    }
    log::info("tsmux", &ctx.rid, || format!("raw-TS session close ({stream_id})"));
    ctx.state.report(serde_json::json!({ "kind": "close", "streamId": stream_id, "reason": close_reason }));
}

fn note_unwrap(ctx: &TsContext, logged: &mut bool, stripped: usize) {
    if stripped == 0 || *logged {
        return;
    }
    *logged = true;
    log::info("tsmux", &ctx.rid, || {
        format!("segments arrive disguised ({stripped} B ahead of the transport stream) — unwrapping each into the raw-TS socket")
    });
}

fn join_is_ready(held: &[u8], probe_at: &mut usize) -> bool {
    if held.len() >= JOIN_HOLD_CAP {
        return true;
    }
    if held.len() < *probe_at {
        return false;
    }
    *probe_at = held.len().saturating_mul(2);
    crate::tsseg::first_keyframe(held).is_some()
}

fn join_at_keyframe(ctx: &TsContext, seq: i64, body: Bytes) -> Bytes {
    match crate::tsseg::trim_to_keyframe(&body) {
        Some(trimmed) => {
            log::info("tsmux", &ctx.rid, || {
                format!(
                    "raw-TS join at seq={seq} opens on its first keyframe ({} KiB of pre-keyframe media skipped)",
                    (body.len() - trimmed.len()) / 1024
                )
            });
            Bytes::from(trimmed)
        }
        None => body,
    }
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
        assert!(mp.segments.iter().all(|s| s.duration == 6.0));
        assert!(mp.segments.iter().all(|s| !s.discontinuity));
    }

    #[test]
    fn parses_extinf_and_discontinuity_positionally() {
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
        assert_eq!(mp.segments[1].duration, 4.0);
        assert_eq!(mp.segments[2].duration, 3.5);
    }

    #[test]
    fn cue_out_is_sticky_until_cue_in() {
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
        let m = "#EXTM3U\n#EXT-X-CUE-OUT:30.000\n#EXTINF:6,\na.ts\n\
                 #EXT-X-CUE-OUT-CONT:6.000/30.000\n#EXTINF:6,\nb.ts\n";
        let mp = parse_media_playlist(m);
        assert_eq!(mp.segments[1].cue.unwrap().duration, 30.0);
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
        let p = pick_variant(m, &base()).unwrap();
        assert_eq!(p.url.as_str(), "https://cdn.example.com/live/hi.m3u8");
        assert!(!p.external_audio, "no #EXT-X-MEDIA at all ⇒ whatever audio exists is muxed in");
    }


    #[test]
    fn a_uri_bearing_audio_rendition_marks_the_variant_video_only() {
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aac\",NAME=\"English\",DEFAULT=YES,URI=\"audio/en.m3u8\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS=\"avc1.4d401f,mp4a.40.2\",AUDIO=\"aac\"\nv.m3u8\n";
        let p = pick_variant(m, &base()).unwrap();
        assert!(p.external_audio, "every variant defers its audio ⇒ the caller must fall back");
        assert_eq!(p.url.as_str(), "https://cdn.example.com/live/v.m3u8", "…but still names a variant");
    }

    #[test]
    fn an_audio_rendition_without_a_uri_is_muxed_in() {
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aac\",NAME=\"English\",DEFAULT=YES\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=3000000,AUDIO=\"aac\"\nv.m3u8\n";
        let p = pick_variant(m, &base()).unwrap();
        assert!(!p.external_audio);
        assert_eq!(p.url.as_str(), "https://cdn.example.com/live/v.m3u8");
    }

    #[test]
    fn encryption_method_separates_cleartext_from_aes128() {
        let clear = "#EXTM3U\n#EXTINF:6.0,\nseg0.ts\n";
        let aes = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k.bin\"\n#EXTINF:6.0,\nseg0.ts\n";
        assert_eq!(unsupported_encryption(clear), None);
        assert_eq!(unsupported_encryption(aes), None, "the two are indistinguishable to the bail check");
        assert_eq!(encryption_method(clear), "NONE");
        assert_eq!(encryption_method(aes), "AES-128", "…but not to this one");
    }

    #[test]
    fn encryption_method_reports_measured_cleartext_not_absence() {
        assert_eq!(encryption_method("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6.0,\nseg0.ts\n"), "NONE");
        assert_eq!(encryption_method("#EXTM3U\n#EXTINF:6.0,\nseg0.ts\n"), "NONE");

        let no_method = "#EXTM3U\n#EXT-X-KEY:URI=\"k.key\",IV=0x0123\n#EXTINF:6.0,\nseg0.ts\n";
        assert_eq!(encryption_method(no_method), "UNKNOWN", "an unreadable key tag is not cleartext");
        let empty_method = "#EXTM3U\n#EXT-X-KEY:METHOD=,URI=\"k.key\"\n#EXTINF:6.0,\nseg0.ts\n";
        assert_eq!(encryption_method(empty_method), "UNKNOWN");
        assert_ne!(encryption_method(no_method), "NONE");
    }

    #[test]
    fn encryption_method_takes_the_last_key_and_names_unsupported_ones() {
        let rotated = "#EXTM3U\n\
                       #EXT-X-KEY:METHOD=AES-128,URI=\"k.bin\"\n#EXTINF:6.0,\nseg0.ts\n\
                       #EXT-X-KEY:METHOD=NONE\n#EXTINF:6.0,\nseg1.ts\n";
        assert_eq!(encryption_method(rotated), "NONE");
        let sample = "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"k.bin\"\n#EXTINF:6.0,\nseg0.ts\n";
        assert_eq!(encryption_method(sample), "SAMPLE-AES");
        assert_eq!(unsupported_encryption(sample).as_deref(), Some("SAMPLE-AES"));
    }

    #[test]
    fn a_muxed_variant_wins_over_a_higher_bandwidth_demuxed_one() {
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aac\",NAME=\"English\",URI=\"audio/en.m3u8\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=6000000,AUDIO=\"aac\"\nhi-videoonly.m3u8\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=800000\nlo-muxed.m3u8\n";
        let p = pick_variant(m, &base()).unwrap();
        assert!(!p.external_audio);
        assert_eq!(p.url.as_str(), "https://cdn.example.com/live/lo-muxed.m3u8");
        assert!(p.audio.is_none(), "a muxed pick has no rendition to follow beside it");
    }

    #[test]
    fn a_demuxed_master_names_the_rendition_the_origin_should_pair_with() {
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",LANGUAGE=\"en\",NAME=\"English\",AUTOSELECT=YES,URI=\"audio/ad.m3u8\",CHARACTERISTICS=\"public.accessibility.describes-video\"\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",LANGUAGE=\"en\",NAME=\"English [Original]\",AUTOSELECT=YES,DEFAULT=YES,URI=\"audio/en.m3u8\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=1042180,AUDIO=\"audio\"\n360p/playlist.m3u8\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=3321280,AUDIO=\"audio\"\n1080p/playlist.m3u8\n";
        let p = pick_variant(m, &base()).unwrap();
        assert!(p.external_audio, "every variant defers its audio");
        assert_eq!(p.url.as_str(), "https://cdn.example.com/live/1080p/playlist.m3u8", "highest bandwidth");
        assert_eq!(p.bandwidth, 3_321_280, "carried so the origin can author a spec-legal master");
        let a = p.audio.expect("the rendition to pair with");
        assert_eq!(a.url.as_str(), "https://cdn.example.com/live/audio/en.m3u8");
        assert_eq!(a.name, "English [Original]");
        assert_eq!(a.language, "en");
    }

    #[test]
    fn a_group_mixing_a_muxed_default_with_an_audio_description_is_not_demuxed() {
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"English\",DEFAULT=NO,FORCED=NO,URI=\"subs/en.m3u8\",LANGUAGE=\"en\"\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",LANGUAGE=\"en\",NAME=\"Original\",AUTOSELECT=YES,DEFAULT=YES,CHANNELS=\"2\"\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",LANGUAGE=\"en\",NAME=\"English\",AUTOSELECT=YES,CHANNELS=\"2\",URI=\"audio/ad.m3u8\",CHARACTERISTICS=\"public.accessibility.describes-video\"\n\
                 #EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1042180,SUBTITLES=\"subs\",AUDIO=\"audio\"\n360p/playlist.m3u8\n\
                 #EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=3321280,SUBTITLES=\"subs\",AUDIO=\"audio\"\n1080p/playlist.m3u8\n";
        let p = pick_variant(m, &base()).unwrap();
        assert!(!p.external_audio, "the URI-less DEFAULT proves the variant already carries the audio");
        assert!(p.audio.is_none(), "so there is no rendition to pair — and no audio-description to mis-serve");
        assert_eq!(p.url.as_str(), "https://cdn.example.com/live/1080p/playlist.m3u8", "highest bandwidth");
    }

    #[test]
    fn an_audio_description_track_never_wins_the_rendition_pick() {
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",LANGUAGE=\"en\",NAME=\"Described\",AUTOSELECT=YES,URI=\"audio/ad.m3u8\",CHARACTERISTICS=\"public.accessibility.describes-video\"\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",LANGUAGE=\"en\",NAME=\"English\",AUTOSELECT=YES,URI=\"audio/en.m3u8\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=3321280,AUDIO=\"audio\"\n1080p/playlist.m3u8\n";
        let p = pick_variant(m, &base()).unwrap();
        assert!(p.external_audio, "no URI-less member, so this one really is demuxed");
        let a = p.audio.expect("a rendition to pair with");
        assert_eq!(a.url.as_str(), "https://cdn.example.com/live/audio/en.m3u8", "the plain track wins");
        assert!(!a.describes_video);

        let m2 = m.replace("NAME=\"Described\",AUTOSELECT=YES", "NAME=\"Described\",DEFAULT=YES,AUTOSELECT=YES");
        let a2 = pick_variant(&m2, &base()).unwrap().audio.expect("a rendition");
        assert_eq!(a2.name, "English", "a DEFAULT audio-description still loses to programme audio");
    }

    #[test]
    fn a_description_only_group_is_still_served_rather_than_declined() {
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",LANGUAGE=\"en\",NAME=\"Described\",AUTOSELECT=YES,URI=\"audio/ad.m3u8\",CHARACTERISTICS=\"public.accessibility.describes-video\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=3321280,AUDIO=\"audio\"\n1080p/playlist.m3u8\n";
        let a = pick_variant(m, &base()).unwrap().audio.expect("the only rendition there is");
        assert!(a.describes_video);
        assert_eq!(a.name, "Described");
    }

    #[test]
    fn a_group_whose_renditions_carry_no_uri_yields_no_pairing_target() {
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aac\",NAME=\"English\",DEFAULT=YES\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO=\"aac\"\nmuxed.m3u8\n";
        let p = pick_variant(m, &base()).unwrap();
        assert!(!p.external_audio);
        assert!(p.audio.is_none());
    }

    #[test]
    fn a_rendition_uri_containing_a_comma_does_not_split_the_attr_list() {
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a1\",NAME=\"en\",URI=\"audio.m3u8?k=1,2\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS=\"avc1,mp4a\",AUDIO=\"a1\"\nv.m3u8\n";
        assert!(pick_variant(m, &base()).unwrap().external_audio);
    }

    #[test]
    fn an_unrelated_audio_group_does_not_condemn_a_variant() {
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"alt\",NAME=\"es\",URI=\"audio/es.m3u8\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=3000000\nv.m3u8\n";
        let p = pick_variant(m, &base()).unwrap();
        assert!(!p.external_audio);
        assert_eq!(p.url.as_str(), "https://cdn.example.com/live/v.m3u8");
    }

    #[test]
    fn a_subtitle_rendition_is_not_audio() {
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"en\",URI=\"subs/en.m3u8\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=3000000,SUBTITLES=\"subs\"\nv.m3u8\n";
        assert!(!pick_variant(m, &base()).unwrap().external_audio);
    }

    #[test]
    fn media_playlist_is_not_master() {
        assert!(!is_master("#EXTM3U\n#EXTINF:6,\ns.ts\n"));
    }

    #[test]
    fn guards_fmp4_and_unsupported_encryption() {
        assert!(has_map("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\ns.m4s\n"));
        assert_eq!(
            unsupported_encryption("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n#EXTINF:6,\ns.ts\n"),
            None
        );
        assert_eq!(
            unsupported_encryption("#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://x\"\n#EXTINF:6,\ns.ts\n"),
            Some("SAMPLE-AES".to_string())
        );
        assert_eq!(unsupported_encryption("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6,\ns.ts\n"), None);
        assert_eq!(unsupported_encryption("#EXTM3U\n#EXTINF:6,\ns.ts\n"), None);
    }

    #[test]
    fn rfc3339_parses_the_shapes_a_playlist_can_carry() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("2026-08-08T09:59:40.000Z"), Some(1_786_183_180_000));
        assert_eq!(parse_rfc3339_ms("2026-08-08T09:59:40.011Z"), Some(1_786_183_180_011));
        assert_eq!(parse_rfc3339_ms("2026-08-08T09:59:40.5Z"), Some(1_786_183_180_500));
        assert_eq!(parse_rfc3339_ms("2026-08-08T09:59:40.0115Z"), Some(1_786_183_180_011));
        let z = parse_rfc3339_ms("2026-08-08T10:59:40.000+01:00").unwrap();
        assert_eq!(z, 1_786_183_180_000, "+01:00 resolves to the same instant as the Z form");
        assert_eq!(parse_rfc3339_ms("2026-08-08T08:59:40.000-01:00"), Some(1_786_183_180_000));
        assert_eq!(parse_rfc3339_ms("2026-08-08T10:59:40.000+0100"), Some(1_786_183_180_000));
        assert_eq!(parse_rfc3339_ms("2026-08-08T09:59:40"), Some(1_786_183_180_000));
        assert!(parse_rfc3339_ms("2024-02-29T00:00:00Z").is_some());
        for bad in ["", "not-a-date", "2026-08-08 09:59:40Z", "2026-13-08T09:59:40Z", "2026-08-08T09:59:40.Z"] {
            assert_eq!(parse_rfc3339_ms(bad), None, "{bad:?} must not parse");
        }
    }

    #[test]
    fn program_date_time_anchors_and_advances_by_extinf() {
        let m = parse_media_playlist(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-PROGRAM-DATE-TIME:2026-08-08T09:59:40.000Z\n\
             #EXTINF:5.0,\na.ts\n#EXTINF:5.0,\nb.ts\n#EXTINF:4.992,\nc.ts\n",
        );
        let base = 1_786_183_180_000i64;
        assert_eq!(m.segments[0].pdt_ms, Some(base));
        assert_eq!(m.segments[1].pdt_ms, Some(base + 5_000));
        assert_eq!(m.segments[2].pdt_ms, Some(base + 10_000));

        let m2 = parse_media_playlist(
            "#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-08-08T09:59:40.000Z\n#EXTINF:5.0,\na.ts\n\
             #EXT-X-PROGRAM-DATE-TIME:2026-08-08T10:00:00.000Z\n#EXTINF:5.0,\nb.ts\n",
        );
        assert_eq!(m2.segments[0].pdt_ms, Some(base));
        assert_eq!(m2.segments[1].pdt_ms, Some(base + 20_000), "the second tag wins over the derived time");

        let m3 = parse_media_playlist("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:5,\na.ts\n");
        assert_eq!(m3.segments[0].pdt_ms, None);
    }

    #[test]
    fn parses_ext_x_key_positionally() {
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
        assert_eq!(mp.segments[2].key, None);
    }

    #[test]
    fn parses_iv_hex() {
        assert_eq!(
            parse_iv("0x000102030405060708090a0b0c0d0e0f"),
            Some([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
        );
        assert_eq!(parse_iv("0xdeadbeef"), None);
        assert_eq!(parse_iv("nothex!!"), None);
    }

    #[test]
    fn aes128_cbc_pkcs7_known_answer() {
        let key: [u8; 16] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
        let iv: [u8; 16] = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31];
        let ct = hex::decode("a44d1e384e0f018cd0a53592855da68441d5b954126f3929ff396a1e7eb9f207").unwrap();
        let pt = decrypt_aes128_cbc(&key, &iv, &ct).expect("decrypt should succeed");
        assert_eq!(pt, b"hello-masqueradarr-tsmux!");
    }

    #[test]
    fn decrypt_rejects_bad_length() {
        let (key, iv) = ([0u8; 16], [0u8; 16]);
        assert!(decrypt_aes128_cbc(&key, &iv, &[]).is_none());
        assert!(decrypt_aes128_cbc(&key, &iv, &[0u8; 17]).is_none());
    }

    #[test]
    fn poll_interval_clamps() {
        assert_eq!(poll_interval(6.0), Duration::from_secs(3));
        assert_eq!(poll_interval(0.0), Duration::from_secs(3));
        assert_eq!(poll_interval(30.0), Duration::from_secs(10));
        assert_eq!(poll_interval(1.0), Duration::from_secs(1));
    }


    use crate::testkit::{media_playlist, tag_of, tagged_ts, Mock, Seam, Serve};
    use crate::tsseg::PKT;

    fn viewer() -> crate::proxy::Identity {
        crate::proxy::Identity { ip: "127.0.0.1".into(), ua: "test".into(), username: None }
    }

    fn raw_ts_grant(extra: serde_json::Value) -> Seam {
        let mut grant = serde_json::json!({ "proxyConfig": { "originEnabled": false, "outputFormat": "ts" } });
        if let (Some(g), serde_json::Value::Object(x)) = (grant.as_object_mut(), extra) {
            g.extend(x);
        }
        Seam::grant_with("/pl/live.m3u8", grant)
    }

    fn one_segment(name: &str) -> String {
        format!("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.0,\n/pl/{name}\n")
    }

    async fn open_socket(state: &AppState) -> axum::body::BodyDataStream {
        let path = format!("/api/ext/v1/zl/{}", crate::manifest::enc("zl://abc"));
        let resp = crate::proxy::serve_stream(state.clone(), axum::http::Method::GET, &path, "", viewer()).await;
        assert_eq!(resp.status().as_u16(), 200);
        assert_eq!(resp.headers()["content-type"], "video/mp2t", "a raw-TS socket, not the HLS fallback");
        resp.into_body().into_data_stream()
    }

    async fn read_until(socket: &mut axum::body::BodyDataStream, n: usize, within: Duration) -> Vec<u8> {
        let deadline = tokio::time::Instant::now() + within;
        let mut got = Vec::new();
        while got.len() < n {
            match tokio::time::timeout_at(deadline, socket.next()).await {
                Ok(Some(Ok(b))) => got.extend_from_slice(&b),
                Ok(_) => panic!("the socket ended after {} of {n} bytes", got.len()),
                Err(_) => panic!("only {} of {n} bytes within {within:?}", got.len()),
            }
        }
        got
    }

    #[tokio::test]
    async fn a_lan_source_s_raw_ts_socket_carries_its_segments() {
        let up = Mock::start(raw_ts_grant(serde_json::json!({}))).await;
        up.script(|s| {
            s.paths.insert("/pl/live.m3u8".into(), Serve::Body(media_playlist(100, 3, 1)));
        });
        let mut socket = open_socket(&up.state()).await;
        let one = tagged_ts(0).len();
        let got = read_until(&mut socket, 3 * one, Duration::from_secs(5)).await;
        let tags: Vec<u64> = got.chunks(one).take(3).map(tag_of).collect();
        assert_eq!(tags, vec![100, 101, 102], "every segment, in order");
    }

    #[tokio::test]
    async fn without_lan_reach_a_private_segment_host_is_never_fetched() {
        let up = Mock::start(raw_ts_grant(serde_json::json!({}))).await;
        let body = media_playlist(100, 3, 1);
        up.script(|s| {
            s.paths.insert("/pl/live.m3u8".into(), Serve::Body(body.clone()));
        });
        let state = up.state();
        let Ok((policy, target)) = state.resolve_entry("zl", "zl://abc", None).await else {
            panic!("the stand-in's seam grants");
        };
        policy.allow_private.store(false, Ordering::Relaxed);
        let ctx = TsContext {
            state: state.clone(),
            policy: policy.clone(),
            source: "zl".into(),
            entry: "zl://abc".into(),
            pl: None,
            rid: "t".into(),
            client: state.client_for(15_000, 10),
            read_timeout_ms: 0,
            ip: "127.0.0.1".into(),
            ua: "test".into(),
            username: None,
        };
        let resp = try_ts_response(body, Url::parse(&target).unwrap(), ctx, 0).await.expect("a TS-eligible playlist");
        let mut socket = resp.into_body().into_data_stream();
        let heard = tokio::time::timeout(Duration::from_millis(1500), socket.next()).await;
        assert!(heard.is_err(), "no loopback segment was fetched and relayed");
    }

    #[tokio::test]
    async fn a_viewer_who_leaves_a_session_with_nothing_to_send_stops_the_polling() {
        let up = Mock::start(raw_ts_grant(serde_json::json!({}))).await;
        let mut body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n".to_string();
        for n in 0..3 {
            body.push_str(&format!("#EXTINF:2.0,\n/pl/x{n}.ts\n"));
        }
        up.script(|s| {
            s.paths.insert("/pl/live.m3u8".into(), Serve::Body(body.clone()));
            for n in 0..3 {
                s.paths.insert(format!("/pl/x{n}.ts"), Serve::Status(403));
            }
        });
        let socket = open_socket(&up.state()).await;
        crate::testkit::until(Duration::from_secs(5), "the producer re-polls the playlist", || {
            up.hits("/pl/live.m3u8") >= 3
        })
        .await;
        assert!(up.hits("/pl/x0.ts") >= 1, "precondition: the segments were asked for, and refused");

        drop(socket);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let after = up.hits("/pl/live.m3u8");
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(up.hits("/pl/live.m3u8"), after, "nobody polls the upstream for a viewer who has gone");
    }

    #[tokio::test]
    async fn a_join_goes_out_once_its_keyframe_is_in_hand_not_when_the_segment_ends() {
        let (gop, cut) = crate::tsseg::mid_gop_segment();
        let mut ts = gop;
        while ts.len() < 2 * JOIN_FIRST_PROBE {
            ts.extend(tagged_ts(0));
        }
        let up = Mock::start(raw_ts_grant(serde_json::json!({ "segmentUnwrap": true }))).await;
        up.script(|s| {
            s.paths.insert("/pl/live.m3u8".into(), Serve::Body(one_segment("g0.ts")));
            let head = crate::tsseg::webp_disguise(&ts);
            s.paths.insert("/pl/g0.ts".into(), Serve::Stall { head, hold: Duration::from_secs(60) });
        });
        let mut socket = open_socket(&up.state()).await;
        let want = [&ts[..2 * PKT], &ts[cut..]].concat();
        let got = read_until(&mut socket, want.len(), Duration::from_secs(5)).await;
        assert_eq!(got.len(), want.len());
        assert!(got == want, "the tables, then everything from the keyframe on — while the segment is still downloading");
    }

    #[tokio::test]
    async fn a_join_that_never_shows_a_keyframe_is_held_no_further_than_the_cap() {
        let unit: Vec<u8> = (0..32).flat_map(|_| tagged_ts(7)).collect();
        let up = Mock::start(raw_ts_grant(serde_json::json!({ "segmentUnwrap": true }))).await;
        up.script(|s| {
            s.paths.insert("/pl/live.m3u8".into(), Serve::Body(one_segment("forever.ts")));
            s.paths.insert("/pl/forever.ts".into(), Serve::Endless(unit));
        });
        let mut socket = open_socket(&up.state()).await;
        let first = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("bytes reach the viewer")
            .expect("a first chunk")
            .expect("readable");
        assert!(first.len() >= JOIN_HOLD_CAP, "the hold went out at its cap ({} B)", first.len());
        assert!(first.len() < 2 * JOIN_HOLD_CAP, "…and not a byte-hoard past it ({} B)", first.len());
        let next = tokio::time::timeout(Duration::from_secs(5), socket.next()).await;
        assert!(matches!(next, Ok(Some(Ok(_)))), "the rest streams behind it");
    }

    #[tokio::test]
    async fn after_a_re_resolve_the_next_segment_is_a_join_again() {
        let (gop, cut) = crate::tsseg::mid_gop_segment();
        let disguised = crate::tsseg::webp_disguise(&gop);
        let unwrap = serde_json::json!({ "segmentUnwrap": true });
        let up = Mock::start(raw_ts_grant(unwrap.clone())).await;
        let listing = |ms: u32, names: &[&str]| {
            let mut p = format!("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:{ms}\n");
            for n in names {
                p.push_str(&format!("#EXTINF:2.0,\n/pl/{n}\n"));
            }
            p
        };
        up.script(|s| {
            s.paths.insert("/pl/live.m3u8".into(), Serve::Body(listing(0, &["g0.ts", "g1.ts"])));
            for g in ["g0.ts", "g1.ts", "h0.ts", "h1.ts"] {
                s.paths.insert(format!("/pl/{g}"), Serve::Media(disguised.clone()));
            }
        });
        let mut socket = open_socket(&up.state()).await;
        let join = 2 * PKT + (gop.len() - cut);
        let first = read_until(&mut socket, join + gop.len(), Duration::from_secs(5)).await;
        assert_eq!(first.len(), join + gop.len(), "precondition: the join, then the next segment whole");

        let mut grant = serde_json::json!({ "proxyConfig": { "originEnabled": false, "outputFormat": "ts" } });
        if let (Some(g), serde_json::Value::Object(x)) = (grant.as_object_mut(), unwrap) {
            g.extend(x);
        }
        up.script(|s| {
            s.paths.insert("/pl/live.m3u8".into(), Serve::Status(403));
            s.paths.insert("/pl/next.m3u8".into(), Serve::Body(listing(10, &["h0.ts", "h1.ts"])));
            s.seam = Seam::grant_with("/pl/next.m3u8", grant);
        });
        let next = read_until(&mut socket, join + gop.len(), Duration::from_secs(10)).await;
        assert_eq!(next.len(), join + gop.len(), "the new session's first segment trimmed, the one after it whole");
        assert_eq!(crate::tsseg::first_keyframe(&next).map(|(at, _)| at), Some(2 * PKT), "opening on its keyframe");
    }
}
