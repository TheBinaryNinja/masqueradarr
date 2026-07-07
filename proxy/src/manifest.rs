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

/// Decode metadata declared IN the manifest — parsed WITHOUT ffprobe (the video-engine teardown removed it).
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

/// Resolve one child URI → absolute, collect its host, return the proxied `<prefix><enc(abs)><suffix>`.
/// A malformed URI is left as-is (mirrors the TS rewriter's try/catch).
fn rewrite_one(uri: &str, base: &Url, prefix: &str, suffix: &str, hosts: &mut Vec<String>) -> String {
    match base.join(uri) {
        Ok(abs) => {
            if let Some(h) = abs.host_str() {
                hosts.push(h.to_lowercase());
            }
            format!("{}{}{}", prefix, enc(abs.as_str()), suffix)
        }
        Err(_) => uri.to_string(),
    }
}

/// Rewrite every `URI="…"` attribute occurrence on a tag/comment line; pass the rest through untouched.
fn rewrite_uri_attrs(line: &str, base: &Url, prefix: &str, suffix: &str, hosts: &mut Vec<String>) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(idx) = rest.find("URI=\"") {
        let start = idx + 5; // past the opening `URI="`
        if let Some(end_rel) = rest[start..].find('"') {
            let end = start + end_rel;
            out.push_str(&rest[..start]); // everything up to and including `URI="`
            out.push_str(&rewrite_one(&rest[start..end], base, prefix, suffix, hosts));
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
pub fn rewrite_manifest(body: &str, base: &Url, prefix: &str, suffix: &str) -> RewriteResult {
    // DEC: decode metadata comes from the shared parser (one source of truth). A separate pass over the small
    // manifest body is negligible vs. the fetch, and keeps the rewrite loop below purely about URIs.
    let media = extract_media(body);
    let mut hosts: Vec<String> = Vec::new();
    let mut lines: Vec<String> = Vec::with_capacity(body.len() / 32 + 8);
    for raw in body.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            lines.push(line.to_string());
        } else if trimmed.starts_with('#') {
            lines.push(rewrite_uri_attrs(line, base, prefix, suffix, &mut hosts));
        } else {
            lines.push(rewrite_one(trimmed, base, prefix, suffix, &mut hosts));
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
        // The relative seg rebases onto the manifest host and routes back through the proxy.
        assert!(r
            .body
            .contains("/api/ext/v1/dlhd/h/https%3A%2F%2Fcdn.example.com%2Flive%2Fseg1.ts?token=abc&pl=dlhd&e=E"));
        // The learned host is collected for the allowlist.
        assert_eq!(r.hosts, vec!["cdn.example.com".to_string()]);
        // Non-URI lines pass through untouched.
        assert!(r.body.contains("#EXTINF:6.0,"));
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
