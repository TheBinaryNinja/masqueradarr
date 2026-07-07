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
}
