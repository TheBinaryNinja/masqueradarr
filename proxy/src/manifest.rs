
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use std::borrow::Cow;
use url::Url;

#[derive(Default)]
pub struct MediaInfo {
    pub resolution: Option<String>,
    pub codecs: Option<String>,
    pub frame_rate: Option<String>,
    pub container: Option<String>,
    pub bandwidth: Option<i64>,
}

impl MediaInfo {
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
    pub hosts: Vec<String>,
    pub media: MediaInfo,
}

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


const TAIL_STEM: &str = "s.";

const PASSING_SEGMENT_EXTS: &[&str] = &[
    "ts", "m4s", "mp4", "m4a", "cmfv", "cmfa",
    "aac", "ac3", "eac3", "ec3", "mp3", "mp2",
    "vtt", "webvtt",
];

const TS_TAIL_EXT: &str = "ts";
const VTT_TAIL_EXT: &str = "vtt";

#[derive(Clone, Copy)]
enum Child {
    Untailed,
    Segment { webvtt: bool },
}

fn path_ext(path: &str) -> Option<&str> {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').map(|(_, ext)| ext).filter(|ext| !ext.is_empty())
}

fn passing_ext(ext: Option<&str>) -> Option<&'static str> {
    let ext = ext?;
    PASSING_SEGMENT_EXTS.iter().copied().find(|p| p.eq_ignore_ascii_case(ext))
}

fn segment_tail(abs: &Url, webvtt: bool) -> Option<&'static str> {
    let clean = abs.query().is_none() && abs.fragment().is_none();
    match passing_ext(path_ext(abs.path())) {
        Some(_) if clean => None,
        Some(own) => Some(own),
        None if webvtt => Some(VTT_TAIL_EXT),
        None => Some(TS_TAIL_EXT),
    }
}

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

pub fn strip_hop_tail(hop: &str) -> &str {
    let is_tail = |seg: &str| seg.strip_prefix(TAIL_STEM).is_some_and(|ext| PASSING_SEGMENT_EXTS.contains(&ext));
    match hop.rsplit_once('/') {
        Some((upstream, tail)) if !upstream.is_empty() && is_tail(tail) => upstream,
        _ => hop,
    }
}

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

fn rewrite_uri_attrs(line: &str, base: &Url, prefix: &str, suffix: &str, hosts: &mut Vec<String>) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(idx) = rest.find("URI=\"") {
        let start = idx + 5;
        if let Some(end_rel) = rest[start..].find('"') {
            let end = start + end_rel;
            out.push_str(&rest[..start]);
            out.push_str(&rewrite_one(&rest[start..end], base, prefix, suffix, Child::Untailed, hosts));
            out.push('"');
            rest = &rest[end + 1..];
        } else {
            break;
        }
    }
    out.push_str(rest);
    out
}

pub fn extract_media(body: &str) -> MediaInfo {
    let mut media = MediaInfo::default();
    let mut best_bw: i64 = -1;
    let mut saw_map = false;
    let mut saw_extinf = false;
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

pub fn rewrite_manifest(body: &str, base: &Url, prefix: &str, suffix: &str) -> RewriteResult {
    let media = extract_media(body);
    let webvtt = is_webvtt_playlist(body);
    let mut hosts: Vec<String> = Vec::new();
    let mut lines: Vec<String> = Vec::with_capacity(body.len() / 32 + 8);
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

pub fn redux_master(body: &str) -> Cow<'_, str> {
    if !body.split('\n').any(|l| l.trim().starts_with("#EXT-X-STREAM-INF:")) {
        return Cow::Borrowed(body);
    }

    let preserve_trailing_newline = body.ends_with('\n');

    let mut lead: Vec<&str> = Vec::new();
    let mut variants: Vec<String> = Vec::new();
    let mut iframes: Vec<&str> = Vec::new();
    let mut tail: Vec<&str> = Vec::new();

    let lines: Vec<&str> = body.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();
        if trimmed.is_empty() {
            i += 1;
            continue;
        }
        if trimmed.starts_with("#EXT-X-STREAM-INF:") {
            let mut j = i + 1;
            while j < lines.len() && lines[j].trim().is_empty() {
                j += 1;
            }
            if j < lines.len() && !lines[j].trim().starts_with('#') {
                variants.push(format!("{}\n{}", line, lines[j]));
                i = j + 1;
            } else {
                variants.push(line.to_string());
                i += 1;
            }
            continue;
        }
        if trimmed.starts_with("#EXT-X-I-FRAME-STREAM-INF") {
            iframes.push(line);
            i += 1;
            continue;
        }
        if trimmed.starts_with("#EXTM3U")
            || trimmed.starts_with("#EXT-X-VERSION")
            || trimmed.starts_with("#EXT-X-INDEPENDENT-SEGMENTS")
            || trimmed.starts_with("#EXT-X-DEFINE")
            || trimmed.starts_with("#EXT-X-START")
        {
            lead.push(line);
            i += 1;
            continue;
        }
        tail.push(line);
        i += 1;
    }

    if let Some(pos) = lead.iter().position(|l| l.trim().starts_with("#EXTM3U")) {
        if pos != 0 {
            let m = lead.remove(pos);
            lead.insert(0, m);
        }
    }

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

pub fn drop_independent_segments(body: &str) -> Cow<'_, str> {
    let is_tag = |l: &str| l.trim() == "#EXT-X-INDEPENDENT-SEGMENTS";
    if !body.split('\n').any(is_tag) {
        return Cow::Borrowed(body);
    }
    Cow::Owned(body.split('\n').filter(|l| !is_tag(l)).collect::<Vec<_>>().join("\n"))
}

fn attr<'a>(attrs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
}

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
        assert_eq!(
            r.body,
            "#EXTM3U\n#EXTINF:6.0,\n/api/ext/v1/dlhd/h/https%3A%2F%2Fcdn.example.com%2Flive%2Fseg1.ts?token=abc&pl=dlhd&e=E\n"
        );
        assert_eq!(r.hosts, vec!["cdn.example.com".to_string()]);
    }

    #[test]
    fn rewrites_key_uri_attribute() {
        let m = "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x1\nseg.ts\n";
        let r = rewrite_manifest(m, &base(), "/p/", "?token=t");
        assert!(r.body.contains("URI=\"/p/https%3A%2F%2Fcdn.example.com%2Flive%2Fkey.bin?token=t\""));
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
        let m = "#EXTM3U\n\
             #EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS=\"avc1.640028,mp4a.40.2\",FRAME-RATE=60\n\
             1080.m3u8\n\
             #EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS=\"avc1.4d401f,mp4a.40.2\",FRAME-RATE=30\n\
             720.m3u8\n";
        let r = rewrite_manifest(m, &base(), "/p/", "");
        assert_eq!(r.media.resolution.as_deref(), Some("1920x1080"));
        assert_eq!(r.media.codecs.as_deref(), Some("avc1.640028,mp4a.40.2"));
        assert_eq!(r.media.frame_rate.as_deref(), Some("60"));
        assert_eq!(r.media.bandwidth, Some(6_000_000));
        assert_eq!(r.media.container, None);
        assert!(r.body.contains("/p/https%3A%2F%2Fcdn.example.com%2Flive%2F1080.m3u8"));
    }

    #[test]
    fn detects_ts_container_from_media_playlist() {
        let m = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.ts\n";
        let r = rewrite_manifest(m, &base(), "/p/", "");
        assert_eq!(r.media.container.as_deref(), Some("ts"));
        assert!(r.media.resolution.is_none());
    }

    #[test]
    fn detects_fmp4_container_from_map() {
        let m = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6.0,\nseg1.m4s\n";
        let r = rewrite_manifest(m, &base(), "/p/", "");
        assert_eq!(r.media.container.as_deref(), Some("fmp4"));
        assert!(r.body.contains("URI=\"/p/https%3A%2F%2Fcdn.example.com%2Flive%2Finit.mp4\""));
    }


    const P: &str = "/api/ext/v1/s/h/";
    const Q: &str = "?token=t&e=E";

    fn segment_hop(segment: &str) -> String {
        let r = rewrite_manifest(&format!("#EXTM3U\n#EXTINF:4.0,\n{segment}\n"), &base(), P, Q);
        r.body.lines().nth(2).expect("the segment line").to_string()
    }

    fn routed(hop: &str) -> String {
        let path = hop.strip_prefix(P).expect("a hop under the prefix").split('?').next().unwrap();
        percent_encoding::percent_decode_str(strip_hop_tail(path)).decode_utf8().unwrap().into_owned()
    }

    #[test]
    fn a_png_named_segment_gets_a_ts_tail_and_still_routes_to_its_upstream() {
        let hop = segment_hop("seg-1.png");
        assert_eq!(hop, format!("{P}https%3A%2F%2Fcdn.example.com%2Flive%2Fseg-1.png/s.ts{Q}"));
        assert_eq!(routed(&hop), "https://cdn.example.com/live/seg-1.png");
    }

    #[test]
    fn a_signed_segment_keeps_its_own_extension_in_a_tail() {
        let hop = segment_hop("seg1.ts?sig=abc%2Fdef");
        assert_eq!(hop, format!("{P}https%3A%2F%2Fcdn.example.com%2Flive%2Fseg1.ts%3Fsig%3Dabc%252Fdef/s.ts{Q}"));
        assert_eq!(routed(&hop), "https://cdn.example.com/live/seg1.ts?sig=abc%2Fdef");
    }

    #[test]
    fn a_zlive_image_segment_gets_a_ts_tail() {
        let up = "https://p16-common-sign.tiktokcdn-us.com/tos-useast8-v-4896-tx2/95c5d9c66e9d0e09b8043bde80b67799\
                  ~tplv-tiktokx-origin.image?dr=9636&refresh_token=8bc28b99&x-expires=1789372800\
                  &x-signature=DPq9nSa7cBGD01k9B2AuHR%2FKRb4%3D&t=4d5b0474&ps=13740610&shp=f21f527a&shcp=9b759fb9&idc=useast8";
        let hop = segment_hop(up);
        assert!(hop.ends_with(&format!("idc%3Duseast8/s.ts{Q}")), "{hop}");
        assert_eq!(routed(&hop), up, "the signed ImageX URL reaches the upstream byte for byte");
    }

    #[test]
    fn a_tail_keeps_a_passing_extension_rather_than_forcing_ts() {
        assert!(segment_hop("a.mp3?sig=1").ends_with(&format!("/s.mp3{Q}")));
        assert!(segment_hop("a.ac3?sig=1").ends_with(&format!("/s.ac3{Q}")));
        assert!(segment_hop("a.aac?sig=1").ends_with(&format!("/s.aac{Q}")));
        assert!(segment_hop("SEG1.TS?sig=1").ends_with(&format!("/s.ts{Q}")), "canonical lowercase");
    }

    #[test]
    fn an_extension_a_client_would_refuse_is_replaced_not_kept() {
        assert!(segment_hop("frag0.m4v").ends_with(&format!("frag0.m4v/s.ts{Q}")));
        assert!(segment_hop("segment-7").ends_with(&format!("segment-7/s.ts{Q}")));
        assert!(segment_hop("v1.2/segment").ends_with(&format!("v1.2%2Fsegment/s.ts{Q}")));
    }

    #[test]
    fn an_init_section_is_never_tailed_and_its_fragments_keep_their_extension() {
        let m = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4?sig=1\"\n#EXTINF:2.0,\nf0.m4s?sig=1\n";
        let r = rewrite_manifest(m, &base(), P, Q);
        assert!(r.body.contains(&format!("URI=\"{P}https%3A%2F%2Fcdn.example.com%2Flive%2Finit.mp4%3Fsig%3D1{Q}\"")));
        assert!(r.body.contains(&format!("f0.m4s%3Fsig%3D1/s.m4s{Q}")));
    }

    #[test]
    fn a_key_uri_is_never_tailed() {
        let m = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?k=1\",IV=0x1\n#EXTINF:4.0,\nenc0.ts?sig=1\n";
        let r = rewrite_manifest(m, &base(), P, Q);
        assert!(r.body.contains(&format!("URI=\"{P}https%3A%2F%2Fcdn.example.com%2Flive%2Fkey.bin%3Fk%3D1{Q}\"")));
        assert!(r.body.contains(&format!("enc0.ts%3Fsig%3D1/s.ts{Q}")));
    }

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

    #[test]
    fn a_webvtt_playlist_gets_vtt_tails_and_never_ts() {
        let m = "#EXTM3U\n#EXTINF:6.0,\nsub1.vtt?sig=1\n#EXTINF:6.0,\nsub2?sig=1\n#EXTINF:6.0,\nsub3.vtt\n";
        let r = rewrite_manifest(m, &base(), P, Q);
        assert!(r.body.contains(&format!("sub1.vtt%3Fsig%3D1/s.vtt{Q}")));
        assert!(r.body.contains(&format!("sub2%3Fsig%3D1/s.vtt{Q}")));
        assert!(r.body.contains(&format!("sub3.vtt{Q}")));
        assert!(!r.body.contains("/s.ts"), "a subtitle playlist never gets a .ts tail:\n{}", r.body);
    }

    #[test]
    fn a_segment_is_recognised_across_the_tags_between_extinf_and_its_uri() {
        let m = "#EXTM3U\n#EXTINF:4.0,\n#EXT-X-BYTERANGE:1000@0\n#EXT-X-PROGRAM-DATE-TIME:2026-09-14T00:00:00Z\nseg.png\n";
        let r = rewrite_manifest(m, &base(), P, Q);
        assert!(r.body.contains(&format!("seg.png/s.ts{Q}")), "{}", r.body);
    }

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
        assert_eq!(strip_hop_tail("https://cdn/v/seg-1.png/s.ts"), "https://cdn/v/seg-1.png");
    }

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


    #[test]
    fn redux_not_a_master_passthrough() {
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
        let mut m = String::from("#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-INDEPENDENT-SEGMENTS\n");
        let long = "x".repeat(360);
        for i in 0..30 {
            m.push_str(&format!(
                "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"g{i}\",NAME=\"n{i}\",URI=\"/api/ext/v1/s/h/{long}\"\n"
            ));
        }
        m.push_str("#EXT-X-STREAM-INF:BANDWIDTH=6000000,AUDIO=\"g0\"\nv0.m3u8\n");
        m.push_str("#EXT-X-STREAM-INF:BANDWIDTH=3000000,AUDIO=\"g0\"\nv1.m3u8\n");
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
        assert!(out.find("#EXT-X-STREAM-INF:").unwrap() < out.find("#EXT-X-I-FRAME-STREAM-INF").unwrap());
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
        let m = "#EXT-X-VERSION:6\n#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n";
        let out = redux_master(m).into_owned();
        assert!(out.starts_with("#EXTM3U\n"), "output must start with #EXTM3U:\n{out}");
    }

    #[test]
    fn redux_hoists_define_before_variants() {
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
    fn a_flagged_playlist_loses_only_its_independent_segments_tag() {
        let m = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:11331\n\
                 #EXT-X-INDEPENDENT-SEGMENTS\n#EXTINF:3.754,\n/api/v1/zlive/h/seg1?e=E\n#EXTINF:3.754,\n/api/v1/zlive/h/seg2?e=E\n";
        let out = drop_independent_segments(m);
        assert!(!out.contains("INDEPENDENT-SEGMENTS"));
        assert_eq!(out, m.replace("#EXT-X-INDEPENDENT-SEGMENTS\n", ""), "nothing else moved or changed");
    }

    #[test]
    fn a_playlist_without_the_tag_is_returned_borrowed() {
        let m = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg1.ts\n";
        assert!(matches!(drop_independent_segments(m), Cow::Borrowed(s) if s == m));
    }

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
