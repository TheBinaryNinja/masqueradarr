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
use std::collections::HashSet;
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
    /// This segment's `#EXT-X-PROGRAM-DATE-TIME` in epoch milliseconds: the wall-clock instant the media
    /// starts at. Anchored by the tag and advanced by `#EXTINF` for the segments that follow it (RFC 8216
    /// §4.3.2.6), re-anchored by any later tag. `None` when the playlist carries no PDT at all.
    ///
    /// This is the ONLY cross-rendition identity a demuxed pair has. The media sequence looks like one and is
    /// not: pluto renumbers the two renditions independently across a session renewal, so the same media can
    /// be sequence 10 on the video lane and 11 on the audio lane. See `origin`'s pairing site.
    pub pdt_ms: Option<i64>,
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
    // PDT is an ANCHOR, not a per-segment field: the tag dates the segment that follows it, and every later
    // segment is that instant plus the running sum of `#EXTINF` until a new tag re-anchors it.
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
            pending_discontinuity = true; // the PREFIX guard matters: -SEQUENCE is a playlist header, not a splice
        } else if let Some(v) = line.strip_prefix("#EXT-X-PROGRAM-DATE-TIME:") {
            // An unparseable date is left as `None` rather than guessed: pairing falls back to the sequence
            // index, which is what this whole tag exists to replace — a wrong instant would be worse.
            pdt_cursor = parse_rfc3339_ms(v.trim());
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
                pdt_ms: pdt_cursor,
            });
            // Advance the anchor past the segment just consumed, so the NEXT one dates correctly.
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

/// Parse an RFC 3339 / ISO 8601 instant to epoch milliseconds. The read half of `origin::fmt_rfc3339`.
///
/// Accepts `YYYY-MM-DDThh:mm:ss[.fff…][Z|±hh:mm]` — the shapes RFC 8216 §4.3.2.6 permits for
/// `#EXT-X-PROGRAM-DATE-TIME`. Fractional seconds beyond milliseconds are truncated (they are far below any
/// tolerance that reads this) and a missing zone is treated as UTC. Anything else returns `None`: the caller
/// falls back to sequence-index pairing rather than acting on a date it had to guess at.
///
/// Deliberately hand-rolled — the crate has no date dependency, and adding one for a fixed-shape 20-odd byte
/// string would be the larger change.
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
    // Fractional seconds, then the zone. Both optional.
    let mut rest = &s[19..];
    let mut millis = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return None;
        }
        // Left-align to exactly 3 places: ".5" is 500 ms, ".0115" truncates to 11 ms.
        let ms: String = digits.chars().chain(std::iter::repeat('0')).take(3).collect();
        millis = ms.parse().ok()?;
        rest = &rest[1 + digits.len()..];
    }
    let zone_ms: i64 = match rest.as_bytes().first() {
        None => 0,
        Some(&z) if z == b'Z' || z == b'z' => 0,
        Some(&sign) if sign == b'+' || sign == b'-' => {
            // ±hh:mm or ±hhmm
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
    // days_from_civil (Howard Hinnant): proleptic Gregorian, no lookup tables, valid across the whole range.
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + h * 3_600 + mi * 60 + sec) * 1_000) + millis + zone_ms)
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

/// The encryption METHOD a media playlist declares — an OBSERVATION, not a verdict.
///
/// Deliberately NOT `unsupported_encryption` above: that one answers "must we bail to the rewrite?", so it
/// returns None for cleartext AND for AES-128 — collapsing exactly the two states an operator most often
/// needs told apart. Anything reporting encryption for display must use THIS, or every AES-128 channel (which
/// is most of pluto and dlhd) reads as unencrypted.
///
/// Returns the literal `"NONE"` rather than an Option so a consumer can distinguish MEASURED cleartext from
/// an absent reading — on this panel those mean opposite things. Three states, then: `"NONE"` (we read the
/// playlist and it is in the clear), a METHOD we read (`"AES-128"`, `"SAMPLE-AES"`, …), and `"UNKNOWN"` (a
/// key tag IS present but its METHOD could not be read, so the content is encrypted by something we cannot
/// name). A caller gating on `!= "NONE"` therefore treats an unreadable key as encrypted, which is the safe
/// direction: the tag's presence is itself the evidence.
///
/// Last key wins: a KEY applies until the next one replaces it, so what the window ENDS on is the current
/// state. Only meaningful on a MEDIA playlist; a master carries no `#EXT-X-KEY` and would always answer NONE.
pub(crate) fn encryption_method(body: &str) -> String {
    let mut method = "NONE".to_string();
    for l in body.split('\n') {
        if let Some(attrs) = l.trim_start().strip_prefix("#EXT-X-KEY:") {
            let m = split_attrs(attrs)
                .into_iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("METHOD"))
                .map(|(_, v)| v.trim().trim_matches('"').to_ascii_uppercase())
                .unwrap_or_default();
            // A key tag we cannot READ is not a reading of cleartext. RFC 8216 makes METHOD mandatory, so an
            // empty one means a malformed upstream — but `NONE` is this function's word for MEASURED
            // cleartext, and answering it here would tell the operator the exact opposite of what the tag's
            // presence proves. `UNKNOWN` is the third state the doc above promises consumers.
            method = if m.is_empty() { "UNKNOWN".to_string() } else { m };
        }
    }
    method
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

/// One `#EXT-X-MEDIA:TYPE=AUDIO` rendition that carries its OWN `URI=` — audio living in a separate playlist
/// instead of inside the variant.
///
/// The origin follows one of these ALONGSIDE the video variant and rings the pair (`origin::ingest`), so the
/// labelling attributes are kept, not just the URL: our authored `#EXT-X-MEDIA` has to describe the track the
/// same way upstream did or a client loses the language it was showing.
#[derive(Clone, Debug)]
pub(crate) struct AudioRendition {
    /// The `GROUP-ID` a variant's `AUDIO=` attribute points at.
    pub group: String,
    /// The rendition playlist, resolved absolute against the master.
    pub url: Url,
    pub name: String,
    /// `LANGUAGE`, empty when the master omits it.
    pub language: String,
    pub default: bool,
    pub autoselect: bool,
    /// `CHARACTERISTICS` marks this an AUDIO DESCRIPTION track — a narrator describing the picture for
    /// blind viewers, not the programme's own audio. It must never be auto-selected as the main track: a
    /// viewer who did not ask for it hears commentary over (or instead of) the dialogue, which reads as
    /// "the audio is wrong" rather than as an accessibility feature.
    pub describes_video: bool,
}

/// ONE pass over a master's `#EXT-X-MEDIA:TYPE=AUDIO` lines, answering both questions the caller has:
/// which renditions are actually demuxed, and which GROUPS are already muxed into their variant.
///
/// Per RFC 8216 §4.3.4.1 an `#EXT-X-MEDIA` WITHOUT a `URI` means that rendition is already present in the
/// referencing variant's own playlist — so only the URI-bearing ones are actually demuxed, and a bare
/// "does this master mention EXT-X-MEDIA" test would false-positive on every muxed stream that merely
/// labels its audio track.
///
/// THE GROUP VERDICT IS NOT THE MEMBER VERDICT, which is why both come out of the same pass. The
/// per-rendition rule is right on its own but says nothing about the group, and a group can hold both kinds.
/// Live pluto does exactly that:
///
/// ```text
/// #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Original",DEFAULT=YES,CHANNELS="2"       ← no URI
/// #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",AUTOSELECT=YES,URI="…",
///              CHARACTERISTICS="public.accessibility.describes-video"
/// ```
///
/// The programme audio is the URI-less `DEFAULT` one — muxed into the variant — and the only URI-bearing
/// member is an audio-description track. Judging the group by its URI-bearing members alone made this look
/// demuxed, so the origin ringed the video against the DESCRIPTION and the viewer got a narrator instead of
/// the programme. One URI-less member is proof the variant is self-sufficient.
///
/// These two verdicts USED to be two functions, each re-deriving the same line filter, `split_attrs` call,
/// quote-stripping `val` closure and TYPE=AUDIO gate over the same body. Keeping one copy is what stops a
/// future fix to attribute handling landing on one scan and not the other — which would skew exactly the
/// demuxed-vs-muxed verdict the pluto case above shows the cost of getting wrong.
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
        // No URI ⇒ muxed into the variant ⇒ following the variant alone still yields audio. That is the
        // GROUP's verdict, not just this member's: one URI-less rendition makes the whole group playable
        // from the variant, so it is collected here rather than by a second scan that would have to
        // re-derive the same attribute rules and stay in lockstep with them.
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
            // A comma-separated list; `describes-video` is the one that matters here.
            describes_video: val("CHARACTERISTICS")
                .is_some_and(|c| c.to_ascii_lowercase().contains("public.accessibility.describes-video")),
        });
    }
    (out, muxed)
}


/// Which rendition of a group to follow: `DEFAULT=YES` wins, else `AUTOSELECT=YES`, else the first the master
/// listed. The same order a player would apply with no user preference expressed.
///
/// AUDIO DESCRIPTION tracks are held back from all three rungs. A player only selects one when the viewer
/// asks for it; auto-selecting it here would serve commentary as if it were the programme. It stays as a last
/// resort rather than being excluded outright, so a group offering nothing else still yields audio instead of
/// silently declining a channel that used to play.
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

/// The variant the byte-paths will follow.
pub(crate) struct VariantPick {
    pub url: Url,
    /// True when this variant's audio lives in a separate `#EXT-X-MEDIA` rendition playlist — i.e. following
    /// this playlist alone yields VIDEO ONLY.
    pub external_audio: bool,
    /// The rendition to follow ALONGSIDE `url` when `external_audio`. `None` whenever the audio is muxed in.
    ///
    /// The raw-TS paths still DECLINE on `external_audio` — they concatenate one playlist and have no muxer.
    /// The ORIGIN uses this instead: it rings the pair and republishes both, which is the only way a demuxed
    /// source gets `tsnorm`'s pid remap at all (see `origin::ingest`).
    pub audio: Option<AudioRendition>,
    /// The picked variant's `BANDWIDTH` — the one `#EXT-X-STREAM-INF` attribute RFC 8216 makes REQUIRED, so
    /// the origin needs it to author a master over the pair. 0 when the upstream omitted it.
    pub bandwidth: i64,
    /// The rest of the PICKED line's decode attributes, for telemetry.
    ///
    /// These must come off the same line as `bandwidth` or the reported tuple describes two different
    /// renditions: `manifest::extract_media` keeps the highest-BANDWIDTH variant, while this function
    /// deliberately prefers a LOWER-bandwidth muxed one when the top variant would cost the audio track. On
    /// such a ladder the two disagree, and a frame mixing them would advertise a resolution/codec this path
    /// never actually carries. `None` when the upstream omitted the attribute.
    pub resolution: Option<String>,
    pub codecs: Option<String>,
    pub frame_rate: Option<String>,
}

/// The decode attributes of one `#EXT-X-STREAM-INF` line, carried through the pick so the winner's — and only
/// the winner's — reach `VariantPick`.
#[derive(Default, Clone)]
struct VariantAttrs {
    resolution: Option<String>,
    codecs: Option<String>,
    frame_rate: Option<String>,
}

/// Pick the variant to follow (the STREAM-INF URI is the next non-comment line), resolved absolute.
///
/// PREFERS the highest-BANDWIDTH variant whose audio is muxed IN — no `AUDIO=` attribute, or an `AUDIO=`
/// group whose renditions carry no URI of their own. THIS path (the passthrough concatenator) follows exactly
/// ONE playlist and has no muxer that could interleave a second elementary stream, so a video-only variant is
/// served SILENT. Bandwidth is the wrong thing to maximise when the top rendition costs the audio track.
///
/// Only when EVERY variant defers its audio does this report `external_audio = true`, and then `audio` names
/// the rendition to follow beside it. A passthrough raw-TS caller falls back to the HLS rewrite on that; the
/// origin rings the pair, and its raw-TS renderer interleaves it (`tsweave`) rather than declining.
pub(crate) fn pick_variant(body: &str, base: &Url) -> Option<VariantPick> {
    // A group holding even ONE URI-less rendition has its audio inside the variant, so the variant is
    // playable on its own and must not be treated as demuxed — see `audio_media`, which decides both in
    // one pass so the two verdicts can never drift apart.
    let (renditions, muxed) = audio_media(body, base);
    let demuxed: HashSet<String> =
        renditions.iter().map(|r| r.group.clone()).filter(|g| !muxed.contains(g)).collect();
    let mut best: Option<(i64, String, VariantAttrs)> = None; // audio-safe variants only
    let mut best_any: Option<(i64, String, Option<String>, VariantAttrs)> = None; // any variant + its demuxed group
    let mut pending: Option<(i64, Option<String>, VariantAttrs)> = None; // awaiting its URI line
    for raw in body.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw).trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            // Keeping the GROUP-ID (rather than collapsing to a bool) is what lets the origin find the
            // rendition afterwards. A group with no URI-bearing member is NOT demuxed — filtering here keeps
            // the old `external` semantics exactly.
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
        let pick = pick_variant(&first_body, &first_url)?;
        // Every variant defers its audio to a separate #EXT-X-MEDIA rendition, so following any one of them
        // would concatenate VIDEO ONLY. There is no muxer here to interleave the second playlist, so bail to
        // the HLS rewrite (which passes the rendition through) rather than serve a silent socket.
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
        let pick = pick_variant(&body, &furl)?;
        // Mid-session the fallback door is already shut (the client holds a video/mp2t socket), so ending the
        // session is the honest outcome — a silent one would look like working playback.
        if pick.external_audio {
            log::warn("tsmux", &ctx.rid, || {
                format!(
                    "{}/{}: re-resolved upstream defers audio to a separate #EXT-X-MEDIA rendition — cannot continue as raw TS",
                    ctx.source, ctx.entry
                )
            });
            return None;
        }
        let vresp = fetch_with_retry(&ctx.client, pick.url.as_str(), &build_headers(&ctx.policy), ctx.read_timeout_ms, &ctx.rid, "ts-variant", MAX_UPSTREAM_RETRIES)
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
    // WHY this socket ended, for the close frame. Threaded rather than emitted at each exit because all four
    // `break 'outer` sites funnel into ONE close emit in the epilogue.
    //
    // Deliberately left UNINITIALISED: the loop has no fall-through exit, so every path out is a break that
    // names its own reason, and the compiler enforces that. A placeholder default would compile even if a
    // future fifth break forgot to set one — and would then quietly mislabel it.
    let close_reason;
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
                        close_reason = "failover_exhausted";
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
                                        close_reason = "client_gone";
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
                                        close_reason = "client_gone";
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
            close_reason = "endlist";
            break 'outer; // VOD / finished event
        }
        tokio::time::sleep(poll_interval(mp.target_duration)).await;
    }

    // CLOSE: flush residual bytes, then tell Node the socket session ended (noteSocketViewerClose).
    if pending_bytes > 0 {
        ctx.state.report(serde_json::json!({ "kind": "sbytes", "streamId": stream_id, "bytes": pending_bytes }));
    }
    log::info("tsmux", &ctx.rid, || format!("raw-TS session close ({stream_id})"));
    ctx.state.report(serde_json::json!({ "kind": "close", "streamId": stream_id, "reason": close_reason }));
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
        let p = pick_variant(m, &base()).unwrap();
        assert_eq!(p.url.as_str(), "https://cdn.example.com/live/hi.m3u8");
        assert!(!p.external_audio, "no #EXT-X-MEDIA at all ⇒ whatever audio exists is muxed in");
    }

    // ── demuxed audio (the "video plays, no sound" class) ────────────────────────────────────────────────

    #[test]
    fn a_uri_bearing_audio_rendition_marks_the_variant_video_only() {
        // The shape that made channels silent: the only variant defers its audio to a second playlist, so
        // concatenating it yields video with no sound. Nothing here can mux the two back together.
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aac\",NAME=\"English\",DEFAULT=YES,URI=\"audio/en.m3u8\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS=\"avc1.4d401f,mp4a.40.2\",AUDIO=\"aac\"\nv.m3u8\n";
        let p = pick_variant(m, &base()).unwrap();
        assert!(p.external_audio, "every variant defers its audio ⇒ the caller must fall back");
        assert_eq!(p.url.as_str(), "https://cdn.example.com/live/v.m3u8", "…but still names a variant");
    }

    #[test]
    fn an_audio_rendition_without_a_uri_is_muxed_in() {
        // RFC 8216 §4.3.4.1: no URI ⇒ the rendition is already inside the referencing variant. Treating this
        // as demuxed would fall back on perfectly good muxed streams that merely LABEL their audio track.
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aac\",NAME=\"English\",DEFAULT=YES\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=3000000,AUDIO=\"aac\"\nv.m3u8\n";
        let p = pick_variant(m, &base()).unwrap();
        assert!(!p.external_audio);
        assert_eq!(p.url.as_str(), "https://cdn.example.com/live/v.m3u8");
    }

    #[test]
    fn encryption_method_separates_cleartext_from_aes128() {
        // THE WHOLE POINT of this helper: `unsupported_encryption` answers None for BOTH of these, because it
        // is asking "must we bail?" rather than "what is it?". Anything reporting encryption for display that
        // reaches for that one instead labels every AES-128 channel unencrypted.
        let clear = "#EXTM3U\n#EXTINF:6.0,\nseg0.ts\n";
        let aes = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k.bin\"\n#EXTINF:6.0,\nseg0.ts\n";
        assert_eq!(unsupported_encryption(clear), None);
        assert_eq!(unsupported_encryption(aes), None, "the two are indistinguishable to the bail check");
        assert_eq!(encryption_method(clear), "NONE");
        assert_eq!(encryption_method(aes), "AES-128", "…but not to this one");
    }

    #[test]
    fn encryption_method_reports_measured_cleartext_not_absence() {
        // "NONE" is a MEASUREMENT and must be distinguishable downstream from "we have no reading", which is
        // why this returns a String rather than an Option. An explicit METHOD=NONE and a playlist with no key
        // at all are both genuinely cleartext.
        assert_eq!(encryption_method("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6.0,\nseg0.ts\n"), "NONE");
        assert_eq!(encryption_method("#EXTM3U\n#EXTINF:6.0,\nseg0.ts\n"), "NONE");

        // …and a key tag whose METHOD is missing or empty is NEITHER. RFC 8216 requires the attribute, so
        // this is a malformed packager — but the tag's presence proves the content is encrypted by SOMETHING,
        // and reporting the measurement for cleartext would state the opposite of the only fact available.
        let no_method = "#EXTM3U\n#EXT-X-KEY:URI=\"k.key\",IV=0x0123\n#EXTINF:6.0,\nseg0.ts\n";
        assert_eq!(encryption_method(no_method), "UNKNOWN", "an unreadable key tag is not cleartext");
        let empty_method = "#EXTM3U\n#EXT-X-KEY:METHOD=,URI=\"k.key\"\n#EXTINF:6.0,\nseg0.ts\n";
        assert_eq!(encryption_method(empty_method), "UNKNOWN");
        // The gate every consumer uses must read both as encrypted.
        assert_ne!(encryption_method(no_method), "NONE");
    }

    #[test]
    fn encryption_method_takes_the_last_key_and_names_unsupported_ones() {
        // A KEY applies until the next one replaces it, so a window that rotates OFF encryption ends cleartext.
        let rotated = "#EXTM3U\n\
                       #EXT-X-KEY:METHOD=AES-128,URI=\"k.bin\"\n#EXTINF:6.0,\nseg0.ts\n\
                       #EXT-X-KEY:METHOD=NONE\n#EXTINF:6.0,\nseg1.ts\n";
        assert_eq!(encryption_method(rotated), "NONE");
        // An unsupported method is reported verbatim rather than being flattened into "encrypted" — the panel
        // showing SAMPLE-AES by name is what explains why the origin declined the channel.
        let sample = "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"k.bin\"\n#EXTINF:6.0,\nseg0.ts\n";
        assert_eq!(encryption_method(sample), "SAMPLE-AES");
        assert_eq!(unsupported_encryption(sample).as_deref(), Some("SAMPLE-AES"));
    }

    #[test]
    fn a_muxed_variant_wins_over_a_higher_bandwidth_demuxed_one() {
        // Bandwidth is the wrong thing to maximise when the top rendition costs the audio track: prefer the
        // variant that still carries sound, even though it is the smaller one.
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
        // pluto's real shape: every variant defers, and the group offers a DEFAULT track plus an
        // audio-description one. The origin follows the pair, so it needs the URL and the labelling.
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
        // DEFAULT=YES wins even though the audio-description track was listed FIRST and is also AUTOSELECT.
        assert_eq!(a.url.as_str(), "https://cdn.example.com/live/audio/en.m3u8");
        assert_eq!(a.name, "English [Original]");
        assert_eq!(a.language, "en");
    }

    /// THE REGRESSION, from the live Comedy Central master: the group's programme audio is the URI-LESS
    /// `DEFAULT` member (muxed into the variant) and the only URI-bearing member is an audio-description
    /// track. Judging the group by its URI-bearing members alone made this look demuxed, so the origin ringed
    /// the video against the DESCRIPTION and the viewer heard a narrator over the programme.
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
        // A genuinely demuxed group (no URI-less member) offering description ALONGSIDE programme audio: the
        // description is AUTOSELECT and listed first, but must still lose to the plain track.
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",LANGUAGE=\"en\",NAME=\"Described\",AUTOSELECT=YES,URI=\"audio/ad.m3u8\",CHARACTERISTICS=\"public.accessibility.describes-video\"\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",LANGUAGE=\"en\",NAME=\"English\",AUTOSELECT=YES,URI=\"audio/en.m3u8\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=3321280,AUDIO=\"audio\"\n1080p/playlist.m3u8\n";
        let p = pick_variant(m, &base()).unwrap();
        assert!(p.external_audio, "no URI-less member, so this one really is demuxed");
        let a = p.audio.expect("a rendition to pair with");
        assert_eq!(a.url.as_str(), "https://cdn.example.com/live/audio/en.m3u8", "the plain track wins");
        assert!(!a.describes_video);

        // …even when the description is the one flagged DEFAULT — a viewer who did not ask for commentary
        // must not be given it.
        let m2 = m.replace("NAME=\"Described\",AUTOSELECT=YES", "NAME=\"Described\",DEFAULT=YES,AUTOSELECT=YES");
        let a2 = pick_variant(&m2, &base()).unwrap().audio.expect("a rendition");
        assert_eq!(a2.name, "English", "a DEFAULT audio-description still loses to programme audio");
    }

    #[test]
    fn a_description_only_group_is_still_served_rather_than_declined() {
        // Last resort: if description is all a demuxed group offers, pair with it — silence would be worse,
        // and declining would turn a channel that used to play into a fallback.
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",LANGUAGE=\"en\",NAME=\"Described\",AUTOSELECT=YES,URI=\"audio/ad.m3u8\",CHARACTERISTICS=\"public.accessibility.describes-video\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=3321280,AUDIO=\"audio\"\n1080p/playlist.m3u8\n";
        let a = pick_variant(m, &base()).unwrap().audio.expect("the only rendition there is");
        assert!(a.describes_video);
        assert_eq!(a.name, "Described");
    }

    #[test]
    fn a_group_whose_renditions_carry_no_uri_yields_no_pairing_target() {
        // RFC 8216 §4.3.4.1: a URI-less rendition is already inside the variant. The variant is muxed, so
        // there is nothing to pair — and nothing to decline over either.
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aac\",NAME=\"English\",DEFAULT=YES\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO=\"aac\"\nmuxed.m3u8\n";
        let p = pick_variant(m, &base()).unwrap();
        assert!(!p.external_audio);
        assert!(p.audio.is_none());
    }

    #[test]
    fn a_rendition_uri_containing_a_comma_does_not_split_the_attr_list() {
        // split_attrs must own this: a naive comma split would read GROUP-ID off a URI fragment and the
        // variant would look muxed, i.e. silently back to the original bug.
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a1\",NAME=\"en\",URI=\"audio.m3u8?k=1,2\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS=\"avc1,mp4a\",AUDIO=\"a1\"\nv.m3u8\n";
        assert!(pick_variant(m, &base()).unwrap().external_audio);
    }

    #[test]
    fn an_unrelated_audio_group_does_not_condemn_a_variant() {
        // The demuxed group belongs to another variant; this one names no AUDIO group at all.
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
    fn rfc3339_parses_the_shapes_a_playlist_can_carry() {
        // The epoch itself, then the pluto shape (millis + Z), then the offset forms.
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("2026-08-08T09:59:40.000Z"), Some(1_786_183_180_000));
        assert_eq!(parse_rfc3339_ms("2026-08-08T09:59:40.011Z"), Some(1_786_183_180_011));
        // Fractions are left-aligned to milliseconds, not read as an integer.
        assert_eq!(parse_rfc3339_ms("2026-08-08T09:59:40.5Z"), Some(1_786_183_180_500));
        assert_eq!(parse_rfc3339_ms("2026-08-08T09:59:40.0115Z"), Some(1_786_183_180_011));
        // A zone is applied, not ignored — an hour east is an hour EARLIER in absolute terms.
        let z = parse_rfc3339_ms("2026-08-08T10:59:40.000+01:00").unwrap();
        assert_eq!(z, 1_786_183_180_000, "+01:00 resolves to the same instant as the Z form");
        assert_eq!(parse_rfc3339_ms("2026-08-08T08:59:40.000-01:00"), Some(1_786_183_180_000));
        assert_eq!(parse_rfc3339_ms("2026-08-08T10:59:40.000+0100"), Some(1_786_183_180_000));
        // A missing zone is UTC (RFC 8216 permits it); leap day is a real date.
        assert_eq!(parse_rfc3339_ms("2026-08-08T09:59:40"), Some(1_786_183_180_000));
        assert!(parse_rfc3339_ms("2024-02-29T00:00:00Z").is_some());
        // Anything we cannot read is None, never a guess — the caller falls back to the sequence index.
        for bad in ["", "not-a-date", "2026-08-08 09:59:40Z", "2026-13-08T09:59:40Z", "2026-08-08T09:59:40.Z"] {
            assert_eq!(parse_rfc3339_ms(bad), None, "{bad:?} must not parse");
        }
    }

    #[test]
    fn program_date_time_anchors_and_advances_by_extinf() {
        // PDT dates the segment that FOLLOWS it and the rest are derived by adding #EXTINF, so one tag at the
        // head has to date the whole window — that is what makes it a cross-rendition key.
        let m = parse_media_playlist(
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-PROGRAM-DATE-TIME:2026-08-08T09:59:40.000Z\n\
             #EXTINF:5.0,\na.ts\n#EXTINF:5.0,\nb.ts\n#EXTINF:4.992,\nc.ts\n",
        );
        let base = 1_786_183_180_000i64;
        assert_eq!(m.segments[0].pdt_ms, Some(base));
        assert_eq!(m.segments[1].pdt_ms, Some(base + 5_000));
        assert_eq!(m.segments[2].pdt_ms, Some(base + 10_000));

        // A later tag RE-ANCHORS rather than being ignored — that is how a source corrects drift mid-window.
        let m2 = parse_media_playlist(
            "#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-08-08T09:59:40.000Z\n#EXTINF:5.0,\na.ts\n\
             #EXT-X-PROGRAM-DATE-TIME:2026-08-08T10:00:00.000Z\n#EXTINF:5.0,\nb.ts\n",
        );
        assert_eq!(m2.segments[0].pdt_ms, Some(base));
        assert_eq!(m2.segments[1].pdt_ms, Some(base + 20_000), "the second tag wins over the derived time");

        // A playlist with no PDT leaves every segment undated, which is what selects the index fallback.
        let m3 = parse_media_playlist("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:5,\na.ts\n");
        assert_eq!(m3.segments[0].pdt_ms, None);
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
