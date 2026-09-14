//! HLS manifest rewriting — a faithful Rust port of the removed server/src/sources/core/playlist.ts.
//!
//! Every child URI is rewritten so it routes back through this proxy: both BARE URI lines (variants /
//! segments) AND the `URI="…"` attribute on tag lines (#EXT-X-KEY AES key, #EXT-X-MAP init, #EXT-X-MEDIA
//! renditions) — without the tag-attribute pass an AES-128 source would load but fetch its key DIRECT,
//! bypassing the proxy (headers/SSRF/token) and failing decryption silently. URIs are resolved against the
//! POST-REDIRECT final URL so relative variant/segment URIs rebase onto the host that actually served the
//! manifest. Each rewritten child host is collected so the caller can grow the stream's SSRF allowlist.
//!
//! The rewrite is surgical/line-based (not a full parse+reserialize) so the manifest is preserved exactly
//! except for its URIs — unknown tags, comments, and ordering pass through untouched.

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use std::borrow::Cow;
use url::Url;

/// Decode metadata declared IN the manifest (no external probe).
/// A MASTER playlist's `#EXT-X-STREAM-INF` carries RESOLUTION/CODECS/FRAME-RATE (we keep the highest-BANDWIDTH
/// variant's); a MEDIA playlist implies the container (`#EXT-X-MAP` init segment ⇒ fMP4, else `#EXTINF`
/// segments ⇒ TS). Each field is independently optional — the master and the media playlist are separate
/// polls, so Node merges them per channel (non-null overwrite) before humanizing for Active Streams.
#[derive(Default)]
pub struct MediaInfo {
    pub resolution: Option<String>,
    pub codecs: Option<String>,
    pub frame_rate: Option<String>,
    pub container: Option<String>,
    /// The chosen variant's declared BANDWIDTH (bits/sec) — the "channel bitrate" Node's client-side buffering
    /// inference compares each viewer's measured download rate against (P1.2/BUF). None for a media playlist.
    pub bandwidth: Option<i64>,
}

impl MediaInfo {
    /// True when at least one field was learned (so the caller can skip an empty telemetry emit).
    pub fn any(&self) -> bool {
        self.resolution.is_some()
            || self.codecs.is_some()
            || self.frame_rate.is_some()
            || self.container.is_some()
            || self.bandwidth.is_some()
    }
}

pub struct RewriteResult {
    pub body: String,
    /// Lowercased hosts referenced by the rewritten child URIs — the caller adds these to the allowlist.
    pub hosts: Vec<String>,
    /// Decode metadata declared in this manifest (empty for a plain media playlist with no MAP/STREAM-INF).
    pub media: MediaInfo,
}

// Matches JS encodeURIComponent (leaves A-Za-z0-9 and -_.!~*'() unescaped) so the sidecar's child-URL
// encoding is consistent with the existing serialize.ts derivation.
pub const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

pub fn enc(s: &str) -> String {
    utf8_percent_encode(s, COMPONENT).to_string()
}

// ── HOP TAIL: a clean extension for the client's segment check ───────────────────────────────────────────
//
// A hop is `<prefix><enc(upstream)><suffix>`, and `enc` percent-encodes the upstream's `/` and `?` — which keeps
// the whole upstream URL in ONE path segment, so the router needs no escaping rules of its own. The price: the
// hop PATH's extension is whatever follows the last `.` of the encoded upstream. `seg.ts` → `ts`; a signed
// `seg.ts?sig=…` → `ts%3Fsig%3D…`; dlhd's `.png` objects → `png`; zlive's TikTok objects → `image%3Fdr%3D…`.
//
// libavformat reads exactly that. Its HLS demuxer (`hls.c` `test_segment`, read and measured on 8.1.1) refuses
// a segment unless the URL's extension is BOTH in `allowed_segment_extensions` AND among the names of the
// demuxer it detects in the bytes — for every segment, at open and again on every live refresh. So every shape
// above but the first fails in every libavformat client (mpv, ffplay, Jellyfin, Plex, Channels) before a byte
// is read, while hls.js, VHS and ExoPlayer sniff the bytes and never noticed.
//
// The fix is a TAIL after the encoded upstream — `…/h/<enc(upstream)>/s.ts?…` — that exists for that check
// alone: the router strips it before decoding (`strip_hop_tail`), so the upstream never sees it. It is chosen
// PER URI, because a wrong extension fails as surely as a missing one:
//   · Only media SEGMENTS — the bare URI after `#EXTINF` — are checked, so only they are tailed. AES keys,
//     `#EXT-X-MAP` init sections and variant / rendition playlists are never touched.
//   · A segment whose own name already passes, with no query to spoil it, is left alone: the common
//     `seg123.ts` hop keeps today's shape byte for byte.
//   · Otherwise the tail carries the upstream's OWN extension when that is one that passes (`a.mp3?sig` →
//     `/s.mp3`). Not `/s.ts` everywhere: `.ts` passes TS, fMP4 and ADTS AAC (ffmpeg keeps an exception for
//     the last two — YouTube serves AAC as `.ts`), but it FAILS packed MP3 and AC-3. Measured, not assumed.
//   · With nothing usable to keep (`.png`, `.image`, no extension at all), `/s.ts` — every disguised segment
//     seen in the wild is TS — except in a WebVTT subtitle playlist, where `.ts` fails the WHOLE input
//     (`detected format webvtt … mismatches`) and `/s.vtt` is what passes.
//
// Hops minted before tails existed carry none and route exactly as they always did, so a session that is open
// across an upgrade keeps playing.

/// Every tail is this stem plus one of `PASSING_SEGMENT_EXTS`; the router recognises nothing else.
const TAIL_STEM: &str = "s.";

/// Segment extensions a libavformat client accepts for the media they name: each is in ffmpeg's
/// `allowed_segment_extensions` AND a name of the demuxer that reads that media. A segment carrying one is left
/// as it is, or keeps it in its tail when a query forces one.
///
/// `.m4v` is the trap that makes this a list rather than "anything allowed": ffmpeg allows it, but its `mp4`
/// demuxer does not answer to it, so an fMP4 segment named `.m4v` fails as-is — and passes under `/s.ts`.
const PASSING_SEGMENT_EXTS: &[&str] = &[
    "ts", "m4s", "mp4", "m4a", "cmfv", "cmfa", // transport stream / fragmented MP4
    "aac", "ac3", "eac3", "ec3", "mp3", "mp2", // packed audio
    "vtt", "webvtt", // subtitles
];

/// The fallback tails, for a segment with no passing extension of its own.
const TS_TAIL_EXT: &str = "ts";
const VTT_TAIL_EXT: &str = "vtt";

/// What a child URI is, as far as its hop's tail is concerned.
#[derive(Clone, Copy)]
enum Child {
    /// Something a client never extension-checks: a key, an init section, a variant or rendition playlist.
    Untailed,
    /// A media segment. `webvtt` when its playlist is subtitles, which changes the fallback tail.
    Segment { webvtt: bool },
}

/// A URL path's extension — whatever follows the last `.` of its LAST segment — or `None` when it has none.
fn path_ext(path: &str) -> Option<&str> {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').map(|(_, ext)| ext).filter(|ext| !ext.is_empty())
}

/// `ext` as it appears in `PASSING_SEGMENT_EXTS` (its canonical lowercase), when it is one.
fn passing_ext(ext: Option<&str>) -> Option<&'static str> {
    let ext = ext?;
    PASSING_SEGMENT_EXTS.iter().copied().find(|p| p.eq_ignore_ascii_case(ext))
}

/// The tail extension one segment's hop needs, or `None` when its own name already passes.
fn segment_tail(abs: &Url, webvtt: bool) -> Option<&'static str> {
    // A query or fragment lands INSIDE the hop path once encoded, so the name in front of it no longer counts.
    let clean = abs.query().is_none() && abs.fragment().is_none();
    match passing_ext(path_ext(abs.path())) {
        Some(_) if clean => None,
        Some(own) => Some(own),
        None if webvtt => Some(VTT_TAIL_EXT),
        None => Some(TS_TAIL_EXT),
    }
}

/// Whether a media playlist is WebVTT subtitles: any of its segments is named `.vtt`/`.webvtt`. A media
/// playlist is ONE rendition, so a single such name speaks for every segment — including one whose own name
/// says nothing, which would otherwise fall back to `.ts` and take the whole input down with it.
fn is_webvtt_playlist(body: &str) -> bool {
    let mut after_extinf = false;
    for raw in body.split('\n') {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('#') {
            after_extinf |= line.starts_with("#EXTINF");
            continue;
        }
        if std::mem::take(&mut after_extinf) {
            let path = line.split(['?', '#']).next().unwrap_or(line);
            if matches!(passing_ext(path_ext(path)), Some("vtt" | "webvtt")) {
                return true;
            }
        }
    }
    false
}

/// The upstream half of a hop's path: `hop` with its media tail (see HOP TAIL) removed, if it carries one.
///
/// Matched on the exact literal and only as the LAST segment. `enc` never lets a raw `/` into the encoded
/// upstream, so in every topology we ship the only `/` in a hop is the one the tail put there; a hop minted
/// before tails existed has none and comes back unchanged. (An operator proxy that decodes `%2F` exposes the
/// upstream's own slashes — the literal match still finds our tail, and only an upstream segment literally named
/// `s.<ext>` could be mistaken for one.)
pub fn strip_hop_tail(hop: &str) -> &str {
    let is_tail = |seg: &str| seg.strip_prefix(TAIL_STEM).is_some_and(|ext| PASSING_SEGMENT_EXTS.contains(&ext));
    match hop.rsplit_once('/') {
        Some((upstream, tail)) if !upstream.is_empty() && is_tail(tail) => upstream,
        _ => hop,
    }
}

/// Resolve one child URI → absolute, collect its host, return the proxied `<prefix><enc(abs)>[/<tail>]<suffix>`.
/// A malformed URI is left as-is (mirrors the TS rewriter's try/catch).
fn rewrite_one(uri: &str, base: &Url, prefix: &str, suffix: &str, child: Child, hosts: &mut Vec<String>) -> String {
    match base.join(uri) {
        Ok(abs) => {
            if let Some(h) = abs.host_str() {
                hosts.push(h.to_lowercase());
            }
            let tail = match child {
                Child::Segment { webvtt } => segment_tail(&abs, webvtt),
                Child::Untailed => None,
            };
            match tail {
                Some(ext) => format!("{prefix}{}/{TAIL_STEM}{ext}{suffix}", enc(abs.as_str())),
                None => format!("{prefix}{}{suffix}", enc(abs.as_str())),
            }
        }
        Err(_) => uri.to_string(),
    }
}

/// Rewrite every `URI="…"` attribute occurrence on a tag/comment line; pass the rest through untouched. Never
/// tailed: every URI a tag carries (key, init section, rendition, I-frame playlist) is one a client does not
/// extension-check.
fn rewrite_uri_attrs(line: &str, base: &Url, prefix: &str, suffix: &str, hosts: &mut Vec<String>) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(idx) = rest.find("URI=\"") {
        let start = idx + 5; // past the opening `URI="`
        if let Some(end_rel) = rest[start..].find('"') {
            let end = start + end_rel;
            out.push_str(&rest[..start]); // everything up to and including `URI="`
            out.push_str(&rewrite_one(&rest[start..end], base, prefix, suffix, Child::Untailed, hosts));
            out.push('"');
            rest = &rest[end + 1..];
        } else {
            break; // unterminated quote — leave the remainder as-is
        }
    }
    out.push_str(rest);
    out
}

/// Parse manifest-declared decode metadata WITHOUT rewriting — the single-source DEC parser, shared by
/// `rewrite_manifest` (the live proxy path) and the `/probe` endpoint (the scheduled channel sweep). A MASTER
/// playlist's highest-BANDWIDTH `#EXT-X-STREAM-INF` supplies resolution/codecs/frame-rate/bandwidth; a MEDIA
/// playlist's `#EXT-X-MAP`/`#EXTINF` supplies the container hint (fMP4 vs TS).
pub fn extract_media(body: &str) -> MediaInfo {
    let mut media = MediaInfo::default();
    let mut best_bw: i64 = -1; // keep the highest-BANDWIDTH variant's attributes
    let mut saw_map = false; // an #EXT-X-MAP init segment ⇒ fMP4 container
    let mut saw_extinf = false; // an #EXTINF media segment ⇒ TS container (unless MAP already said fMP4)
    for raw in body.split('\n') {
        let trimmed = raw.trim();
        if let Some(rest) = trimmed.strip_prefix("#EXT-X-STREAM-INF:") {
            let attrs = parse_attrs(rest);
            let bw = attr(&attrs, "BANDWIDTH").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
            if bw >= best_bw {
                best_bw = bw;
                if bw > 0 {
                    media.bandwidth = Some(bw);
                }
                if let Some(v) = attr(&attrs, "RESOLUTION") {
                    media.resolution = Some(v.to_string());
                }
                if let Some(v) = attr(&attrs, "CODECS") {
                    media.codecs = Some(v.to_string());
                }
                if let Some(v) = attr(&attrs, "FRAME-RATE") {
                    media.frame_rate = Some(v.to_string());
                }
            }
        } else if trimmed.starts_with("#EXT-X-MAP") {
            saw_map = true;
        } else if trimmed.starts_with("#EXTINF") {
            saw_extinf = true;
        }
    }
    if saw_map {
        media.container = Some("fmp4".to_string());
    } else if saw_extinf {
        media.container = Some("ts".to_string());
    }
    media
}

/// Rewrite a whole manifest body. `prefix` is the proxied child mount (e.g. "/api/ext/v1/dlhd/h/") and
/// `suffix` the re-embedded query ("?token=…&pl=…&e=…"). Line endings are normalized to LF (as the TS did).
/// Segment hops may gain a media tail between the two — see HOP TAIL above.
pub fn rewrite_manifest(body: &str, base: &Url, prefix: &str, suffix: &str) -> RewriteResult {
    // DEC: decode metadata comes from the shared parser (one source of truth). A separate pass over the small
    // manifest body is negligible vs. the fetch, and keeps the rewrite loop below purely about URIs.
    let media = extract_media(body);
    // The playlist's kind is needed BEFORE its first segment is rewritten, hence its own (equally cheap) pass.
    let webvtt = is_webvtt_playlist(body);
    let mut hosts: Vec<String> = Vec::new();
    let mut lines: Vec<String> = Vec::with_capacity(body.len() / 32 + 8);
    // Set by `#EXTINF` and spent on the next bare URI: that URI is a media segment. Tags may sit in between
    // (`#EXT-X-BYTERANGE`, `#EXT-X-PROGRAM-DATE-TIME`, …), so it survives them. A bare URI without one — a
    // master's variant — is never tailed.
    let mut after_extinf = false;
    for raw in body.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            lines.push(line.to_string());
        } else if trimmed.starts_with('#') {
            after_extinf |= trimmed.starts_with("#EXTINF");
            lines.push(rewrite_uri_attrs(line, base, prefix, suffix, &mut hosts));
        } else {
            let child = if std::mem::take(&mut after_extinf) { Child::Segment { webvtt } } else { Child::Untailed };
            lines.push(rewrite_one(trimmed, base, prefix, suffix, child, &mut hosts));
        }
    }
    RewriteResult {
        body: lines.join("\n"),
        hosts,
        media,
    }
}

/// STREAM-INF Redux (SIR) — an OPT-IN, non-destructive reorder of an already-rewritten MASTER playlist so the
/// first `#EXT-X-STREAM-INF` lands within the small window a strict player peeks to sniff content-type (VLC's
/// fixed ~8 KiB probe; ffmpeg's `hls_probe` `strstr`s for the same literal). Because `rewrite_manifest` only
/// ever LENGTHENS URIs and never reorders, a master whose `#EXT-X-MEDIA` rendition block precedes the variants
/// can push the first STREAM-INF past that window, and the client fails to recognize the response as HLS.
///
/// This hoists the STREAM-INF variant blocks ABOVE the `#EXT-X-MEDIA`/session block WITHOUT dropping any variant
/// or rendition. Reordering is spec-legal (RFC 8216: only `#EXTM3U` is position-pinned; variant↔rendition
/// association is by GROUP-ID, position-independent) and every current player (ffmpeg/hls.js/VLC) associates
/// renditions after a full parse. proxy.rs applies it ONLY on the external-player mount when the
/// (Default)/(Custom) proxy-config `streamInfRedux` flag is on — a pure post-transform layered OVER
/// `rewrite_manifest` (which is unchanged), so the delivery path is byte-identical when the flag is off. A
/// non-master (no STREAM-INF) is returned borrowed/unchanged — the common media-playlist poll never allocates.
pub fn redux_master(body: &str) -> Cow<'_, str> {
    // Fast path: not a master (media playlist / non-HLS / I-frame-only) → byte-identical, no allocation. Uses
    // the same `#EXT-X-STREAM-INF:` (with colon) detection as extract_media, so #EXT-X-I-FRAME-STREAM-INF alone
    // is NOT treated as a master (there is nothing to hoist, and probes key on the regular literal).
    if !body.split('\n').any(|l| l.trim().starts_with("#EXT-X-STREAM-INF:")) {
        return Cow::Borrowed(body);
    }

    let preserve_trailing_newline = body.ends_with('\n');

    // Four ordered buckets; within-bucket input order is preserved (so default-variant selection is unchanged).
    let mut lead: Vec<&str> = Vec::new(); // #EXTM3U + declarations that must stay near the top
    let mut variants: Vec<String> = Vec::new(); // #EXT-X-STREAM-INF + its URI line (kept together as one unit)
    let mut iframes: Vec<&str> = Vec::new(); // #EXT-X-I-FRAME-STREAM-INF (self-contained line; URI is an attr)
    let mut tail: Vec<&str> = Vec::new(); // #EXT-X-MEDIA / session tags / unknown #EXT-X-* / comments / stray URIs

    // rewrite_manifest already normalized to LF; strip a trailing \r defensively so direct/test callers are safe.
    let lines: Vec<&str> = body.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();
        if trimmed.is_empty() {
            i += 1; // drop pure-blank lines (the only lines removed)
            continue;
        }
        if trimmed.starts_with("#EXT-X-STREAM-INF:") {
            // Pair with the next NON-BLANK, NON-`#` line (the variant URI — matches tsmux::pick_variant).
            let mut j = i + 1;
            while j < lines.len() && lines[j].trim().is_empty() {
                j += 1;
            }
            if j < lines.len() && !lines[j].trim().starts_with('#') {
                variants.push(format!("{}\n{}", line, lines[j]));
                i = j + 1;
            } else {
                // Unpaired (next non-blank is a tag, or EOF) — emit the STREAM-INF alone; never swallow a `#` line.
                variants.push(line.to_string());
                i += 1;
            }
            continue;
        }
        if trimmed.starts_with("#EXT-X-I-FRAME-STREAM-INF") {
            iframes.push(line); // single line — do NOT consume the next line
            i += 1;
            continue;
        }
        if trimmed.starts_with("#EXTM3U")
            || trimmed.starts_with("#EXT-X-VERSION")
            || trimmed.starts_with("#EXT-X-INDEPENDENT-SEGMENTS")
            || trimmed.starts_with("#EXT-X-DEFINE") // variables must be defined BEFORE first use
            || trimmed.starts_with("#EXT-X-START")
        {
            lead.push(line);
            i += 1;
            continue;
        }
        // Renditions, session tags, unknown #EXT-X-*, bare comments, stray bare URIs → tail (preserved, never
        // pushed into the probe window). This is the SAFE default: nothing is dropped except blank lines.
        tail.push(line);
        i += 1;
    }

    // #EXTM3U must be absolute line 1 (RFC 8216 §4.3.1.1). If present out of place, force it to the front.
    if let Some(pos) = lead.iter().position(|l| l.trim().starts_with("#EXTM3U")) {
        if pos != 0 {
            let m = lead.remove(pos);
            lead.insert(0, m);
        }
    }

    // Re-emit: lead → variants → iframes → tail.
    let mut out: Vec<String> = Vec::with_capacity(lead.len() + variants.len() + iframes.len() + tail.len());
    out.extend(lead.into_iter().map(str::to_string));
    out.append(&mut variants);
    out.extend(iframes.into_iter().map(str::to_string));
    out.extend(tail.into_iter().map(str::to_string));

    let mut joined = out.join("\n");
    if preserve_trailing_newline {
        joined.push('\n');
    }
    Cow::Owned(joined)
}

/// DSG: remove `#EXT-X-INDEPENDENT-SEGMENTS` from an already-rewritten playlist, for a source whose grant says
/// its segments arrive disguised (`segmentUnwrap`). Like `redux_master`, a pure post-transform over
/// `rewrite_manifest`'s output, applied by proxy.rs only when the flag is set.
///
/// The tag promises that every segment decodes without the one before it — in practice, that each opens on a
/// keyframe — and a player may start cold at any segment boundary on the strength of it. The source that
/// declares the flag declares this tag falsely: its segments are cut from a live mux with no regard for the
/// GOP (the first IDR measured 0.1–1.9 s in), so a player trusting the promise renders garbage until the first
/// keyframe arrives. Dropping it is always safe — its ABSENCE promises nothing — which is why it rides the
/// same declaration rather than needing its own. Returned borrowed when the tag is absent, so the common poll
/// never allocates.
pub fn drop_independent_segments(body: &str) -> Cow<'_, str> {
    let is_tag = |l: &str| l.trim() == "#EXT-X-INDEPENDENT-SEGMENTS";
    if !body.split('\n').any(is_tag) {
        return Cow::Borrowed(body);
    }
    Cow::Owned(body.split('\n').filter(|l| !is_tag(l)).collect::<Vec<_>>().join("\n"))
}

/// Find an attribute value by (case-sensitive) key, treating an empty value as absent.
fn attr<'a>(attrs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
}

/// Parse a comma-separated `KEY=VALUE` attribute list (HLS `#EXT-X-STREAM-INF` etc.), honoring double-quoted
/// values so a quoted `CODECS="avc1,mp4a"` stays ONE value (its inner comma is not a separator). Quotes are
/// stripped from the returned value; keys and values are trimmed.
fn parse_attrs(s: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let (mut key, mut val) = (String::new(), String::new());
    let mut in_key = true;
    let mut in_quotes = false;
    for ch in s.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            '=' if in_key && !in_quotes => in_key = false,
            ',' if !in_quotes => {
                out.push((key.trim().to_string(), val.trim().to_string()));
                key.clear();
                val.clear();
                in_key = true;
            }
            _ => {
                if in_key {
                    key.push(ch);
                } else {
                    val.push(ch);
                }
            }
        }
    }
    if !key.trim().is_empty() {
        out.push((key.trim().to_string(), val.trim().to_string()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("https://cdn.example.com/live/master.m3u8").unwrap()
    }

    #[test]
    fn rewrites_bare_relative_segment() {
        let m = "#EXTM3U\n#EXTINF:6.0,\nseg1.ts\n";
        let r = rewrite_manifest(m, &base(), "/api/ext/v1/dlhd/h/", "?token=abc&pl=dlhd&e=E");
        // The relative seg rebases onto the manifest host and routes back through the proxy — and, its own name
        // already passing a client's extension check, in EXACTLY the shape it always had: no tail.
        assert_eq!(
            r.body,
            "#EXTM3U\n#EXTINF:6.0,\n/api/ext/v1/dlhd/h/https%3A%2F%2Fcdn.example.com%2Flive%2Fseg1.ts?token=abc&pl=dlhd&e=E\n"
        );
        // The learned host is collected for the allowlist.
        assert_eq!(r.hosts, vec!["cdn.example.com".to_string()]);
    }

    #[test]
    fn rewrites_key_uri_attribute() {
        let m = "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x1\nseg.ts\n";
        let r = rewrite_manifest(m, &base(), "/p/", "?token=t");
        // The AES key URI is rewritten (else decryption would bypass the proxy).
        assert!(r.body.contains("URI=\"/p/https%3A%2F%2Fcdn.example.com%2Flive%2Fkey.bin?token=t\""));
        // Other attributes on the same tag line survive.
        assert!(r.body.contains("METHOD=AES-128"));
        assert!(r.body.contains("IV=0x1"));
    }

    #[test]
    fn rewrites_absolute_child_on_other_host() {
        let m = "#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://other.cdn.net/v/variant.m3u8\n";
        let r = rewrite_manifest(m, &base(), "/p/", "");
        assert!(r.body.contains("/p/https%3A%2F%2Fother.cdn.net%2Fv%2Fvariant.m3u8"));
        assert!(r.hosts.contains(&"other.cdn.net".to_string()));
    }

    #[test]
    fn preserves_comments_and_blank_lines() {
        let m = "#EXTM3U\n\n#EXT-X-VERSION:3\n";
        let r = rewrite_manifest(m, &base(), "/p/", "");
        assert!(r.body.contains("#EXTM3U"));
        assert!(r.body.contains("#EXT-X-VERSION:3"));
        assert!(r.hosts.is_empty());
    }

    #[test]
    fn extracts_master_decode_metadata_highest_bandwidth() {
        // Two variants; the higher-BANDWIDTH one (1080p60) must win regardless of file order.
        let m = "#EXTM3U\n\
             #EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS=\"avc1.640028,mp4a.40.2\",FRAME-RATE=60\n\
             1080.m3u8\n\
             #EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS=\"avc1.4d401f,mp4a.40.2\",FRAME-RATE=30\n\
             720.m3u8\n";
        let r = rewrite_manifest(m, &base(), "/p/", "");
        assert_eq!(r.media.resolution.as_deref(), Some("1920x1080"));
        // The quoted CODECS comma is preserved as one value (not split into two attributes).
        assert_eq!(r.media.codecs.as_deref(), Some("avc1.640028,mp4a.40.2"));
        assert_eq!(r.media.frame_rate.as_deref(), Some("60"));
        // The chosen variant's declared BANDWIDTH is surfaced (the client-side buffering reference).
        assert_eq!(r.media.bandwidth, Some(6_000_000));
        // A master carries no segments → no container hint yet (learned on the variant/media poll).
        assert_eq!(r.media.container, None);
        // The variant URIs are still rewritten through the proxy.
        assert!(r.body.contains("/p/https%3A%2F%2Fcdn.example.com%2Flive%2F1080.m3u8"));
    }

    #[test]
    fn detects_ts_container_from_media_playlist() {
        let m = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.ts\n";
        let r = rewrite_manifest(m, &base(), "/p/", "");
        assert_eq!(r.media.container.as_deref(), Some("ts"));
        assert!(r.media.resolution.is_none()); // a media playlist declares no resolution
    }

    #[test]
    fn detects_fmp4_container_from_map() {
        let m = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6.0,\nseg1.m4s\n";
        let r = rewrite_manifest(m, &base(), "/p/", "");
        // An init segment ⇒ fMP4 even though #EXTINF segments follow.
        assert_eq!(r.media.container.as_deref(), Some("fmp4"));
        // The init-segment URI is still rewritten through the proxy (else the player fetches it direct).
        assert!(r.body.contains("URI=\"/p/https%3A%2F%2Fcdn.example.com%2Flive%2Finit.mp4\""));
    }

    // ── HOP TAIL: kind-aware media tails ─────────────────────────────────────────────────────────────────
    //
    // Every expected shape below was played through ffmpeg 8.1.1's HLS demuxer on loopback before it was
    // written down here: the tailed shapes open, and the tail-less ones they replace fail its segment check.

    const P: &str = "/api/ext/v1/s/h/";
    const Q: &str = "?token=t&e=E";

    /// The single rewritten URI line that follows `#EXTINF` in a one-segment playlist.
    fn segment_hop(segment: &str) -> String {
        let r = rewrite_manifest(&format!("#EXTM3U\n#EXTINF:4.0,\n{segment}\n"), &base(), P, Q);
        r.body.lines().nth(2).expect("the segment line").to_string()
    }

    /// The upstream a hop routes to, decoded exactly the way the router does it: tail off, then decode.
    fn routed(hop: &str) -> String {
        let path = hop.strip_prefix(P).expect("a hop under the prefix").split('?').next().unwrap();
        percent_encoding::percent_decode_str(strip_hop_tail(path)).decode_utf8().unwrap().into_owned()
    }

    /// dlhd and pluto serve TS from `.png`-named objects: ffmpeg's check refuses `png` outright.
    #[test]
    fn a_png_named_segment_gets_a_ts_tail_and_still_routes_to_its_upstream() {
        let hop = segment_hop("seg-1.png");
        assert_eq!(hop, format!("{P}https%3A%2F%2Fcdn.example.com%2Flive%2Fseg-1.png/s.ts{Q}"));
        assert_eq!(routed(&hop), "https://cdn.example.com/live/seg-1.png");
    }

    /// A signed segment: the upstream's `?` is encoded INTO the hop path, so its `.ts` no longer ends it. The
    /// tail restores a clean `.ts`, and the signature reaches the upstream intact.
    #[test]
    fn a_signed_segment_keeps_its_own_extension_in_a_tail() {
        let hop = segment_hop("seg1.ts?sig=abc%2Fdef");
        assert_eq!(hop, format!("{P}https%3A%2F%2Fcdn.example.com%2Flive%2Fseg1.ts%3Fsig%3Dabc%252Fdef/s.ts{Q}"));
        assert_eq!(routed(&hop), "https://cdn.example.com/live/seg1.ts?sig=abc%2Fdef");
    }

    /// The live zlive shape, verbatim from a captured playlist: an absolute TikTok ImageX URL, `.image` plus a
    /// query. Nothing usable of its own to keep, so `/s.ts`.
    #[test]
    fn a_zlive_image_segment_gets_a_ts_tail() {
        let up = "https://p16-common-sign.tiktokcdn-us.com/tos-useast8-v-4896-tx2/95c5d9c66e9d0e09b8043bde80b67799\
                  ~tplv-tiktokx-origin.image?dr=9636&refresh_token=8bc28b99&x-expires=1789372800\
                  &x-signature=DPq9nSa7cBGD01k9B2AuHR%2FKRb4%3D&t=4d5b0474&ps=13740610&shp=f21f527a&shcp=9b759fb9&idc=useast8";
        let hop = segment_hop(up);
        assert!(hop.ends_with(&format!("idc%3Duseast8/s.ts{Q}")), "{hop}");
        assert_eq!(routed(&hop), up, "the signed ImageX URL reaches the upstream byte for byte");
    }

    /// Packed MP3 and AC-3 are why the tail is not simply `/s.ts`: ffmpeg's `.ts` exception covers fMP4 and AAC
    /// only, and under `/s.ts` these fail `detected format mp3 … mismatches`. Their own extension is kept.
    #[test]
    fn a_tail_keeps_a_passing_extension_rather_than_forcing_ts() {
        assert!(segment_hop("a.mp3?sig=1").ends_with(&format!("/s.mp3{Q}")));
        assert!(segment_hop("a.ac3?sig=1").ends_with(&format!("/s.ac3{Q}")));
        assert!(segment_hop("a.aac?sig=1").ends_with(&format!("/s.aac{Q}")));
        assert!(segment_hop("SEG1.TS?sig=1").ends_with(&format!("/s.ts{Q}")), "canonical lowercase");
    }

    /// `.m4v` is allowed by ffmpeg but is not a name its `mp4` demuxer answers to, so an fMP4 segment called that
    /// fails as-is; `/s.ts` is what passes. The same for a name with no extension at all.
    #[test]
    fn an_extension_a_client_would_refuse_is_replaced_not_kept() {
        assert!(segment_hop("frag0.m4v").ends_with(&format!("frag0.m4v/s.ts{Q}")));
        assert!(segment_hop("segment-7").ends_with(&format!("segment-7/s.ts{Q}")));
        // A directory with a dot is not an extension: only the LAST path segment's name counts.
        assert!(segment_hop("v1.2/segment").ends_with(&format!("v1.2%2Fsegment/s.ts{Q}")));
    }

    /// An fMP4 media playlist: the `#EXT-X-MAP` init section is not extension-checked and is never tailed, even
    /// signed; the signed fragments keep their `.m4s`.
    #[test]
    fn an_init_section_is_never_tailed_and_its_fragments_keep_their_extension() {
        let m = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4?sig=1\"\n#EXTINF:2.0,\nf0.m4s?sig=1\n";
        let r = rewrite_manifest(m, &base(), P, Q);
        assert!(r.body.contains(&format!("URI=\"{P}https%3A%2F%2Fcdn.example.com%2Flive%2Finit.mp4%3Fsig%3D1{Q}\"")));
        assert!(r.body.contains(&format!("f0.m4s%3Fsig%3D1/s.m4s{Q}")));
    }

    /// An AES key URI is not extension-checked either — a tail would only be something to get wrong. Its
    /// segments are tailed as usual.
    #[test]
    fn a_key_uri_is_never_tailed() {
        let m = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?k=1\",IV=0x1\n#EXTINF:4.0,\nenc0.ts?sig=1\n";
        let r = rewrite_manifest(m, &base(), P, Q);
        assert!(r.body.contains(&format!("URI=\"{P}https%3A%2F%2Fcdn.example.com%2Flive%2Fkey.bin%3Fk%3D1{Q}\"")));
        assert!(r.body.contains(&format!("enc0.ts%3Fsig%3D1/s.ts{Q}")));
    }

    /// A master's variant and rendition playlists are child PLAYLISTS, which ffmpeg never extension-checks: a
    /// bare variant URI has no `#EXTINF` in front of it, and a rendition is a tag attribute. Neither is tailed.
    #[test]
    fn variant_and_rendition_playlists_are_never_tailed() {
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"en\",URI=\"audio.m3u8?tok=1\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO=\"a\"\nv.m3u8?tok=1\n";
        let r = rewrite_manifest(m, &base(), P, Q);
        assert!(r.body.contains(&format!("audio.m3u8%3Ftok%3D1{Q}\"")));
        assert!(r.body.ends_with(&format!("v.m3u8%3Ftok%3D1{Q}\n")));
        assert!(!r.body.contains("/s."), "no tail anywhere in a master:\n{}", r.body);
    }

    /// A WebVTT subtitle playlist: `.ts` there fails ffmpeg's WHOLE input, so its fallback is `/s.vtt` — for a
    /// segment whose own name says nothing, too, because one `.vtt` name speaks for the whole rendition. A plain
    /// `.vtt` segment already passes and is left alone.
    #[test]
    fn a_webvtt_playlist_gets_vtt_tails_and_never_ts() {
        let m = "#EXTM3U\n#EXTINF:6.0,\nsub1.vtt?sig=1\n#EXTINF:6.0,\nsub2?sig=1\n#EXTINF:6.0,\nsub3.vtt\n";
        let r = rewrite_manifest(m, &base(), P, Q);
        assert!(r.body.contains(&format!("sub1.vtt%3Fsig%3D1/s.vtt{Q}")));
        assert!(r.body.contains(&format!("sub2%3Fsig%3D1/s.vtt{Q}")));
        assert!(r.body.contains(&format!("sub3.vtt{Q}")));
        assert!(!r.body.contains("/s.ts"), "a subtitle playlist never gets a .ts tail:\n{}", r.body);
    }

    /// Tags between `#EXTINF` and its URI do not orphan the segment.
    #[test]
    fn a_segment_is_recognised_across_the_tags_between_extinf_and_its_uri() {
        let m = "#EXTM3U\n#EXTINF:4.0,\n#EXT-X-BYTERANGE:1000@0\n#EXT-X-PROGRAM-DATE-TIME:2026-09-14T00:00:00Z\nseg.png\n";
        let r = rewrite_manifest(m, &base(), P, Q);
        assert!(r.body.contains(&format!("seg.png/s.ts{Q}")), "{}", r.body);
    }

    /// The router side. Every tail this module mints comes off; a hop minted before tails existed (a session
    /// open across the upgrade) comes back unchanged; nothing that merely LOOKS like a tail is taken for one.
    #[test]
    fn the_router_strips_exactly_the_tails_this_module_mints() {
        assert_eq!(strip_hop_tail("https%3A%2F%2Fcdn%2Fseg.png/s.ts"), "https%3A%2F%2Fcdn%2Fseg.png");
        assert_eq!(strip_hop_tail("https%3A%2F%2Fcdn%2Fsub%3Fx/s.vtt"), "https%3A%2F%2Fcdn%2Fsub%3Fx");
        assert_eq!(strip_hop_tail("https%3A%2F%2Fcdn%2Fa.mp3%3Fx/s.mp3"), "https%3A%2F%2Fcdn%2Fa.mp3%3Fx");
        assert_eq!(strip_hop_tail("https%3A%2F%2Fcdn%2Fseg1.ts"), "https%3A%2F%2Fcdn%2Fseg1.ts", "tail-less: untouched");
        assert_eq!(strip_hop_tail("x/s.png"), "x/s.png", "not a passing extension, so never ours");
        assert_eq!(strip_hop_tail("x/seg.ts"), "x/seg.ts", "not our stem");
        assert_eq!(strip_hop_tail("x/s.TS"), "x/s.TS", "we mint lowercase; the literal is exact");
        assert_eq!(strip_hop_tail("/s.ts"), "/s.ts", "an empty upstream was never minted");
        // Behind an operator proxy that decodes %2F, the tail is still the last segment and still comes off.
        assert_eq!(strip_hop_tail("https://cdn/v/seg-1.png/s.ts"), "https://cdn/v/seg-1.png");
    }

    /// The whole loop, for every shape above: whatever the rewrite mints, the router turns back into precisely
    /// the absolute URL the playlist named.
    #[test]
    fn every_minted_hop_routes_back_to_the_url_its_playlist_named() {
        let m = "#EXTM3U\n#EXTINF:4,\nseg-1.png\n#EXTINF:4,\nseg1.ts?sig=a\n#EXTINF:4,\nseg2.ts\n\
                 #EXTINF:4,\nhttps://other.example.net/a/b.image?x=1&y=2\n#EXTINF:4,\nnoext\n#EXTINF:4,\na.mp3?s\n";
        let r = rewrite_manifest(m, &base(), P, Q);
        let routed_all: Vec<String> = r.body.lines().filter(|l| l.starts_with(P)).map(routed).collect();
        assert_eq!(
            routed_all,
            [
                "https://cdn.example.com/live/seg-1.png",
                "https://cdn.example.com/live/seg1.ts?sig=a",
                "https://cdn.example.com/live/seg2.ts",
                "https://other.example.net/a/b.image?x=1&y=2",
                "https://cdn.example.com/live/noext",
                "https://cdn.example.com/live/a.mp3?s",
            ]
        );
    }

    // ── STREAM-INF Redux (redux_master) ─────────────────────────────────────────────────────────────

    #[test]
    fn redux_not_a_master_passthrough() {
        // A media playlist (no STREAM-INF) is returned byte-identical AND borrowed (no alloc on the hot path).
        let m = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.ts\n";
        let r = redux_master(m);
        assert!(matches!(r, Cow::Borrowed(_)));
        assert_eq!(r, m);
    }

    #[test]
    fn redux_hoists_stream_inf_before_media() {
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"en\",URI=\"a.m3u8\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO=\"a\"\n\
                 v.m3u8\n";
        let out = redux_master(m).into_owned();
        let si = out.find("#EXT-X-STREAM-INF").unwrap();
        let med = out.find("#EXT-X-MEDIA").unwrap();
        assert!(si < med, "STREAM-INF must precede MEDIA after redux:\n{out}");
    }

    #[test]
    fn redux_first_stream_inf_within_peek_window() {
        // Regression for the real bug shape: many long rendition lines BEFORE the variants push the first
        // STREAM-INF past VLC's 8192-byte probe window. After redux it must sit near the top.
        let mut m = String::from("#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-INDEPENDENT-SEGMENTS\n");
        let long = "x".repeat(360);
        for i in 0..30 {
            m.push_str(&format!(
                "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"g{i}\",NAME=\"n{i}\",URI=\"/api/ext/v1/s/h/{long}\"\n"
            ));
        }
        m.push_str("#EXT-X-STREAM-INF:BANDWIDTH=6000000,AUDIO=\"g0\"\nv0.m3u8\n");
        m.push_str("#EXT-X-STREAM-INF:BANDWIDTH=3000000,AUDIO=\"g0\"\nv1.m3u8\n");
        // Pre-condition: the bug reproduces (first STREAM-INF is past the window before redux).
        assert!(m.find("#EXT-X-STREAM-INF").unwrap() > 8192);
        let out = redux_master(&m).into_owned();
        assert!(out.find("#EXT-X-STREAM-INF").unwrap() < 1024);
    }

    #[test]
    fn redux_pairs_stream_inf_with_correct_uri() {
        let m = "#EXTM3U\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=6000000\nhigh.m3u8\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=3000000\nlow.m3u8\n";
        let out = redux_master(m).into_owned();
        // Each STREAM-INF is immediately followed by ITS OWN URI (no swap).
        assert!(out.contains("BANDWIDTH=6000000\nhigh.m3u8"));
        assert!(out.contains("BANDWIDTH=3000000\nlow.m3u8"));
    }

    #[test]
    fn redux_preserves_within_group_order() {
        let m = "#EXTM3U\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=6000000\nhigh.m3u8\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=3000000\nlow.m3u8\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,NAME=\"first\"\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,NAME=\"second\"\n";
        let out = redux_master(m).into_owned();
        assert!(out.find("high.m3u8").unwrap() < out.find("low.m3u8").unwrap());
        assert!(out.find("NAME=\"first\"").unwrap() < out.find("NAME=\"second\"").unwrap());
    }

    #[test]
    fn redux_iframe_is_single_line_and_after_regular() {
        let m = "#EXTM3U\n\
                 #EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,URI=\"iframe.m3u8\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=6000000\nv.m3u8\n";
        let out = redux_master(m).into_owned();
        // Regular STREAM-INF comes before the I-frame variant (probes strstr the literal #EXT-X-STREAM-INF:).
        assert!(out.find("#EXT-X-STREAM-INF:").unwrap() < out.find("#EXT-X-I-FRAME-STREAM-INF").unwrap());
        // The I-frame line did not swallow the following line (its URI is an attribute).
        assert!(out.contains("#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,URI=\"iframe.m3u8\""));
    }

    #[test]
    fn redux_is_non_destructive() {
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,NAME=\"en\"\n\
                 #EXT-X-MEDIA:TYPE=SUBTITLES,NAME=\"sub\"\n\
                 #EXT-X-SESSION-DATA:DATA-ID=\"x\"\n\
                 #EXT-X-SESSION-KEY:METHOD=AES-128,URI=\"k\"\n\
                 #EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI=\"if.m3u8\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=6000000\nv.m3u8\n";
        let out = redux_master(m).into_owned();
        let count = |hay: &str, needle: &str| hay.matches(needle).count();
        // #EXT-X-I-FRAME-STREAM-INF: does NOT contain the substring #EXT-X-STREAM-INF: — count is exact.
        assert_eq!(count(&out, "#EXT-X-STREAM-INF:"), 1);
        assert_eq!(count(&out, "#EXT-X-I-FRAME-STREAM-INF"), 1);
        assert_eq!(count(&out, "#EXT-X-MEDIA"), 2);
        assert_eq!(count(&out, "#EXT-X-SESSION-DATA"), 1);
        assert_eq!(count(&out, "#EXT-X-SESSION-KEY"), 1);
        assert!(out.contains("v.m3u8"));
    }

    #[test]
    fn redux_drops_blank_lines_keeps_comments() {
        let m = "#EXTM3U\n\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n\n# operator note\n";
        let out = redux_master(m).into_owned();
        assert!(!out.contains("\n\n"), "blank lines should be dropped:\n{out:?}");
        assert!(out.contains("# operator note"), "bare comments must be preserved (routed to tail)");
    }

    #[test]
    fn redux_extm3u_stays_first_line() {
        // #EXTM3U not first in the input (unusual) is forced back to line 1.
        let m = "#EXT-X-VERSION:6\n#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n";
        let out = redux_master(m).into_owned();
        assert!(out.starts_with("#EXTM3U\n"), "output must start with #EXTM3U:\n{out}");
    }

    #[test]
    fn redux_hoists_define_before_variants() {
        // #EXT-X-DEFINE declares variables that must precede any use → it belongs in the lead.
        let m = "#EXTM3U\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n\
                 #EXT-X-DEFINE:NAME=\"host\",VALUE=\"cdn\"\n";
        let out = redux_master(m).into_owned();
        assert!(out.find("#EXT-X-DEFINE").unwrap() < out.find("#EXT-X-STREAM-INF").unwrap());
    }

    #[test]
    fn redux_unknown_tag_goes_to_tail() {
        let m = "#EXTM3U\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n\
                 #EXT-X-FUTURE-TAG:whatever\n";
        let out = redux_master(m).into_owned();
        // Preserved, and positioned AFTER the first STREAM-INF (never pushed into the probe window).
        assert!(out.contains("#EXT-X-FUTURE-TAG:whatever"));
        assert!(out.find("#EXT-X-STREAM-INF").unwrap() < out.find("#EXT-X-FUTURE-TAG").unwrap());
    }

    #[test]
    fn redux_handles_crlf() {
        let m = "#EXTM3U\r\n#EXT-X-MEDIA:TYPE=AUDIO,NAME=\"en\"\r\n#EXT-X-STREAM-INF:BANDWIDTH=1\r\nv.m3u8\r\n";
        let out = redux_master(m).into_owned();
        assert!(out.find("#EXT-X-STREAM-INF").unwrap() < out.find("#EXT-X-MEDIA").unwrap());
        assert!(!out.contains('\r'), "\\r must be stripped from classified lines");
    }

    #[test]
    fn redux_stream_inf_without_uri_at_eof_no_panic() {
        let m = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n";
        let out = redux_master(m).into_owned();
        assert!(out.contains("#EXT-X-STREAM-INF:BANDWIDTH=1"));
    }

    #[test]
    fn redux_is_idempotent() {
        let m = "#EXTM3U\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,NAME=\"en\"\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=6000000\nhigh.m3u8\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=3000000\nlow.m3u8\n\
                 #EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI=\"if.m3u8\"\n";
        let once = redux_master(m).into_owned();
        let twice = redux_master(&once).into_owned();
        assert_eq!(once, twice);
    }

    // ── DSG: the false INDEPENDENT-SEGMENTS promise ──────────────────────────────────────────────────────

    /// The live shape (a zlive media playlist, URIs already rewritten): the tag goes, and ONLY the tag — every
    /// other line, the segment URIs included, is the rewrite's output untouched.
    #[test]
    fn a_flagged_playlist_loses_only_its_independent_segments_tag() {
        let m = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:11331\n\
                 #EXT-X-INDEPENDENT-SEGMENTS\n#EXTINF:3.754,\n/api/v1/zlive/h/seg1?e=E\n#EXTINF:3.754,\n/api/v1/zlive/h/seg2?e=E\n";
        let out = drop_independent_segments(m);
        assert!(!out.contains("INDEPENDENT-SEGMENTS"));
        assert_eq!(out, m.replace("#EXT-X-INDEPENDENT-SEGMENTS\n", ""), "nothing else moved or changed");
    }

    /// The common poll — no tag at all — is handed back borrowed: no allocation, byte-identical.
    #[test]
    fn a_playlist_without_the_tag_is_returned_borrowed() {
        let m = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.ts\n";
        assert!(matches!(drop_independent_segments(m), Cow::Borrowed(s) if s == m));
    }

    /// A master can carry the tag too (RFC 8216 allows it in both); it goes there as well, and a tag that
    /// merely STARTS the same way is not this one.
    #[test]
    fn the_tag_is_dropped_from_a_master_and_matched_exactly() {
        let m = "#EXTM3U\r\n#EXT-X-INDEPENDENT-SEGMENTS\r\n#EXT-X-INDEPENDENT-SEGMENTS-FUTURE:1\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n";
        let out = drop_independent_segments(m);
        assert!(!out.contains("#EXT-X-INDEPENDENT-SEGMENTS\r"), "a CRLF-terminated tag is still the tag");
        assert!(out.contains("#EXT-X-INDEPENDENT-SEGMENTS-FUTURE:1"), "a different tag is left alone");
        assert!(out.contains("#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8"));
    }

    #[test]
    fn redux_already_ordered_master_stays_valid() {
        let m = "#EXTM3U\n\
                 #EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n\
                 #EXT-X-MEDIA:TYPE=AUDIO,NAME=\"en\"\n";
        let out = redux_master(m).into_owned();
        assert!(out.starts_with("#EXTM3U\n"));
        assert!(out.find("#EXT-X-STREAM-INF").unwrap() < out.find("#EXT-X-MEDIA").unwrap());
        assert!(out.contains("v.m3u8"));
        assert!(out.contains("#EXT-X-MEDIA"));
    }
}
