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

pub struct RewriteResult {
    pub body: String,
    /// Lowercased hosts referenced by the rewritten child URIs — the caller adds these to the allowlist.
    pub hosts: Vec<String>,
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

/// Rewrite a whole manifest body. `prefix` is the proxied child mount (e.g. "/api/ext/v1/dlhd/h/") and
/// `suffix` the re-embedded query ("?token=…&pl=…&e=…"). Line endings are normalized to LF (as the TS did).
pub fn rewrite_manifest(body: &str, base: &Url, prefix: &str, suffix: &str) -> RewriteResult {
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
    }
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
}
