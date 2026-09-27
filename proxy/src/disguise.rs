use std::io::Read;

use flate2::read::{GzDecoder, ZlibDecoder};

use crate::tsseg::{Disguise, PKT, SYNC};

const PNG_SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
const PIXEL_MAGIC: &[u8] = b"TIKTIKPX";
const RAW_MAGIC: &[u8] = b"TIKTIKRAW";
const GZIP_MAGIC: &[u8] = b"TIKTIKTSGZ";
const FAMILY: &[u8] = b"TIKTIK";
const GZIP_ID: [u8; 2] = [0x1F, 0x8B];
const PIXEL_HEADER: usize = PIXEL_MAGIC.len() + 4;
const TS_PROOF: usize = 5;

pub(crate) const MAX_UNWRAPPED: usize = 32 << 20;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Reveal {
    Slice(usize, usize),
    Owned(Vec<u8>),
}

pub(crate) fn is_png(body: &[u8]) -> bool {
    body.starts_with(&PNG_SIG)
}

pub(crate) fn needs_whole_body(head: &[u8]) -> bool {
    is_png(head) || find(head, FAMILY).is_some()
}

pub(crate) fn png(body: &[u8], cap: usize) -> Option<(Reveal, Disguise)> {
    let png = parse_png(body)?;
    if is_ts(&body[png.end..]) {
        return Some((Reveal::Slice(png.end, body.len()), Disguise::PngTrailer));
    }
    pixels(&png, cap).map(|ts| (Reveal::Owned(ts), Disguise::PngPixels))
}

pub(crate) fn markers(body: &[u8], cap: usize) -> Option<(Reveal, Disguise)> {
    if let Some(at) = find(body, GZIP_MAGIC) {
        let (start, end) = framed(body, at + GZIP_MAGIC.len(), |b| b.starts_with(&GZIP_ID))?;
        let ts = gunzip(&body[start..end], cap).filter(|ts| is_ts(ts))?;
        return Some((Reveal::Owned(ts), Disguise::TiktikGzip));
    }
    let at = find(body, RAW_MAGIC)?;
    let (start, end) = framed(body, at + RAW_MAGIC.len(), is_ts)?;
    Some((Reveal::Slice(start, end), Disguise::TiktikRaw))
}

pub(crate) fn is_ts(b: &[u8]) -> bool {
    b.len() >= PKT && (0..TS_PROOF.min(b.len() / PKT)).all(|k| b[k * PKT] == SYNC)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn framed(body: &[u8], at: usize, opens: impl Fn(&[u8]) -> bool) -> Option<(usize, usize)> {
    let rest = body.get(at..)?;
    if opens(rest) {
        return Some((at, body.len()));
    }
    let n = u32::from_be_bytes(rest.get(..4)?.try_into().ok()?) as usize;
    let start = at + 4;
    let end = start.checked_add(n)?;
    (n > 0 && end <= body.len() && opens(&body[start..end])).then_some((start, end))
}

struct Png<'a> {
    width: usize,
    height: usize,
    bpp: usize,
    idat: Vec<&'a [u8]>,
    end: usize,
}

fn be32(b: &[u8]) -> Option<usize> {
    Some(u32::from_be_bytes(b.get(..4)?.try_into().ok()?) as usize)
}

fn parse_png(body: &[u8]) -> Option<Png<'_>> {
    if !is_png(body) {
        return None;
    }
    let mut pos = PNG_SIG.len();
    let mut header: Option<(usize, usize, usize)> = None;
    let mut idat = Vec::new();
    while pos + 12 <= body.len() {
        let len = be32(&body[pos..])?;
        let data = pos + 8;
        let next = data.checked_add(len)?.checked_add(4)?;
        if next > body.len() {
            return None;
        }
        let chunk = &body[data..data + len];
        match &body[pos + 4..data] {
            b"IHDR" if header.is_none() && pos == PNG_SIG.len() => header = Some(ihdr(chunk)?),
            _ if header.is_none() => return None,
            b"IDAT" => idat.push(chunk),
            b"IEND" => {
                let (width, height, bpp) = header?;
                return Some(Png { width, height, bpp, idat, end: next });
            }
            _ => {}
        }
        pos = next;
    }
    None
}

fn ihdr(d: &[u8]) -> Option<(usize, usize, usize)> {
    if d.len() != 13 {
        return None;
    }
    let (width, height) = (be32(&d[0..])?, be32(&d[4..])?);
    let bpp = match (d[8], d[9]) {
        (8, 2) => 3,
        (8, 6) => 4,
        _ => return None,
    };
    let plain = d[10] == 0 && d[11] == 0 && d[12] == 0;
    (plain && width * 3 >= PIXEL_HEADER && height > 0).then_some((width, height, bpp))
}

fn pixels(png: &Png<'_>, cap: usize) -> Option<Vec<u8>> {
    let stride = png.width.checked_mul(png.bpp)?;
    let raw_len = stride.checked_add(1)?.checked_mul(png.height)?;
    if raw_len > cap {
        return None;
    }
    let idat = png.idat.concat();
    let mut z = ZlibDecoder::new(&idat[..]).take(raw_len as u64);
    let mut row = vec![0u8; stride + 1];
    let mut prev = vec![0u8; stride];
    let mut rgb: Vec<u8> = Vec::new();
    let mut need = PIXEL_HEADER;
    for y in 0..png.height {
        if rgb.len() >= need {
            break;
        }
        z.read_exact(&mut row).ok()?;
        let (filter, line) = row.split_first_mut()?;
        unfilter(*filter, line, &prev, png.bpp)?;
        push_rgb(&mut rgb, line, png.bpp);
        prev.copy_from_slice(line);
        if y == 0 {
            if !rgb.starts_with(PIXEL_MAGIC) {
                return None;
            }
            let n = be32(&rgb[PIXEL_MAGIC.len()..])?;
            need = PIXEL_HEADER.checked_add(n)?;
            if n == 0 || need > png.width * png.height * 3 {
                return None;
            }
            rgb.reserve(need - rgb.len().min(need));
        }
    }
    if rgb.len() < need {
        return None;
    }
    gunzip(&rgb[PIXEL_HEADER..need], cap).filter(|ts| is_ts(ts))
}

fn unfilter(filter: u8, line: &mut [u8], prev: &[u8], bpp: usize) -> Option<()> {
    match filter {
        0 => {}
        1 => {
            for i in bpp..line.len() {
                line[i] = line[i].wrapping_add(line[i - bpp]);
            }
        }
        2 => {
            for (x, up) in line.iter_mut().zip(prev) {
                *x = x.wrapping_add(*up);
            }
        }
        3 => {
            for i in 0..line.len() {
                let left = if i >= bpp { u16::from(line[i - bpp]) } else { 0 };
                line[i] = line[i].wrapping_add(((left + u16::from(prev[i])) / 2) as u8);
            }
        }
        4 => {
            for i in 0..line.len() {
                let (left, corner) = if i >= bpp { (line[i - bpp], prev[i - bpp]) } else { (0, 0) };
                line[i] = line[i].wrapping_add(paeth(left, prev[i], corner));
            }
        }
        _ => return None,
    }
    Some(())
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let p = i16::from(a) + i16::from(b) - i16::from(c);
    let (pa, pb, pc) = ((p - i16::from(a)).abs(), (p - i16::from(b)).abs(), (p - i16::from(c)).abs());
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

fn push_rgb(out: &mut Vec<u8>, line: &[u8], bpp: usize) {
    if bpp == 3 {
        out.extend_from_slice(line);
    } else {
        for px in line.chunks_exact(bpp) {
            out.extend_from_slice(&px[..3]);
        }
    }
}

fn gunzip(gz: &[u8], cap: usize) -> Option<Vec<u8>> {
    if !gz.starts_with(&GZIP_ID) {
        return None;
    }
    let mut out = Vec::new();
    GzDecoder::new(gz).take(cap as u64 + 1).read_to_end(&mut out).ok()?;
    (out.len() <= cap).then_some(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use flate2::write::{GzEncoder, ZlibEncoder};
    use flate2::{Compression, Crc};
    use std::io::Write;

    pub(crate) fn null_ts(n: usize) -> Vec<u8> {
        (0..n)
            .flat_map(|i| {
                let mut p = vec![0xFFu8; PKT];
                p[0] = SYNC;
                p[1] = 0x1F;
                p[3] = 0x10 | (i as u8 & 0x0F);
                p[4..8].copy_from_slice(&(i as u32).to_be_bytes());
                p
            })
            .collect()
    }

    pub(crate) fn noisy_ts(n: usize, seed: u32) -> Vec<u8> {
        let mut ts = null_ts(n);
        for (p, fill) in ts.chunks_mut(PKT).zip(noise(n * PKT, seed).chunks(PKT)) {
            p[8..].copy_from_slice(&fill[8..]);
        }
        ts
    }

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut e = GzEncoder::new(Vec::new(), Compression::fast());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    fn zlib(data: &[u8]) -> Vec<u8> {
        let mut e = ZlibEncoder::new(Vec::new(), Compression::fast());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        let mut crc = Crc::new();
        crc.update(kind);
        crc.update(data);
        out.extend_from_slice(&crc.sum().to_be_bytes());
    }

    fn filter_row(kind: u8, line: &[u8], prev: &[u8], bpp: usize) -> Vec<u8> {
        let left = |i: usize, s: &[u8]| if i >= bpp { s[i - bpp] } else { 0 };
        let mut out = vec![kind];
        for i in 0..line.len() {
            let pred = match kind {
                0 => 0,
                1 => left(i, line),
                2 => prev[i],
                3 => ((u16::from(left(i, line)) + u16::from(prev[i])) / 2) as u8,
                _ => paeth(left(i, line), prev[i], left(i, prev)),
            };
            out.push(line[i].wrapping_sub(pred));
        }
        out
    }

    pub(crate) struct PngSpec {
        pub(crate) width: usize,
        pub(crate) bpp: usize,
        pub(crate) depth: u8,
        pub(crate) interlace: u8,
        pub(crate) filter_override: Option<u8>,
    }

    impl Default for PngSpec {
        fn default() -> Self {
            Self { width: 17, bpp: 3, depth: 8, interlace: 0, filter_override: None }
        }
    }

    pub(crate) fn png_of(pixels_rgb: &[u8], spec: &PngSpec) -> Vec<u8> {
        let row_px = spec.width;
        let rows = pixels_rgb.len().div_ceil(row_px * 3).max(1);
        let mut rgb = pixels_rgb.to_vec();
        rgb.resize(rows * row_px * 3, 0x5A);
        let stride = row_px * spec.bpp;
        let mut raw = Vec::new();
        let mut prev = vec![0u8; stride];
        for (y, px_row) in rgb.chunks(row_px * 3).enumerate() {
            let line: Vec<u8> = if spec.bpp == 4 {
                px_row.chunks(3).flat_map(|p| [p[0], p[1], p[2], 0xFF]).collect()
            } else {
                px_row.to_vec()
            };
            let kind = spec.filter_override.unwrap_or((y % 5) as u8);
            raw.extend(filter_row(kind.min(4), &line, &prev, spec.bpp));
            if kind > 4 {
                let at = raw.len() - stride - 1;
                raw[at] = kind;
            }
            prev = line;
        }
        let mut out = PNG_SIG.to_vec();
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&(row_px as u32).to_be_bytes());
        ihdr.extend_from_slice(&(rows as u32).to_be_bytes());
        ihdr.extend_from_slice(&[spec.depth, if spec.bpp == 4 { 6 } else { 2 }, 0, 0, spec.interlace]);
        chunk(&mut out, b"IHDR", &ihdr);
        for part in zlib(&raw).chunks(8192) {
            chunk(&mut out, b"IDAT", part);
        }
        chunk(&mut out, b"IEND", &[]);
        out
    }

    pub(crate) fn pixel_payload(ts: &[u8]) -> Vec<u8> {
        let gz = gzip(ts);
        let mut px = PIXEL_MAGIC.to_vec();
        px.extend_from_slice(&(gz.len() as u32).to_be_bytes());
        px.extend(gz);
        px
    }

    pub(crate) fn png_pixel_disguise(ts: &[u8], spec: &PngSpec) -> Vec<u8> {
        png_of(&pixel_payload(ts), spec)
    }

    fn noise(len: usize, seed: u32) -> Vec<u8> {
        let mut x = seed;
        (0..len)
            .map(|_| {
                x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (x >> 24) as u8
            })
            .collect()
    }

    fn owned(r: Option<(Reveal, Disguise)>) -> Option<(Vec<u8>, Disguise)> {
        match r? {
            (Reveal::Owned(v), k) => Some((v, k)),
            (Reveal::Slice(..), _) => None,
        }
    }

    #[test]
    fn paeth_matches_the_png_predictor() {
        for (a, b, c, want) in [
            (10, 20, 15, 15),
            (0, 0, 0, 0),
            (100, 50, 25, 100),
            (50, 100, 25, 100),
            (5, 5, 10, 5),
            (255, 0, 255, 0),
            (3, 7, 5, 5),
        ] {
            assert_eq!(paeth(a, b, c), want, "paeth({a},{b},{c})");
        }
    }

    #[test]
    fn a_pixel_disguised_png_decodes_to_its_transport_stream_for_every_filter_and_layout() {
        let ts = null_ts(300);
        for bpp in [3, 4] {
            for width in [4, 17, 512] {
                let body = png_pixel_disguise(&ts, &PngSpec { width, bpp, ..PngSpec::default() });
                let (got, kind) = owned(png(&body, MAX_UNWRAPPED)).unwrap_or_else(|| panic!("bpp={bpp} width={width}"));
                assert_eq!(kind, Disguise::PngPixels);
                assert_eq!(got, ts, "bpp={bpp} width={width}");
            }
        }
    }

    #[test]
    fn a_genuine_png_is_not_mistaken_for_a_disguise() {
        let body = png_of(&noise(40_000, 9), &PngSpec::default());
        assert_eq!(png(&body, MAX_UNWRAPPED), None);
        assert_eq!(markers(&body, MAX_UNWRAPPED), None);
    }

    #[test]
    fn unsupported_or_damaged_pngs_are_left_alone() {
        let ts = null_ts(40);
        let spec = |f: fn(&mut PngSpec)| {
            let mut s = PngSpec::default();
            f(&mut s);
            png_pixel_disguise(&ts, &s)
        };
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("interlaced", spec(|s| s.interlace = 1)),
            ("16-bit", spec(|s| s.depth = 16)),
            ("filter byte 5", spec(|s| s.filter_override = Some(5))),
            ("too narrow for the header", spec(|s| s.width = 3)),
        ];
        for (what, body) in cases {
            assert_eq!(png(&body, MAX_UNWRAPPED), None, "{what}");
        }

        let mut palette = png_pixel_disguise(&ts, &PngSpec::default());
        palette[8 + 8 + 9] = 3;
        assert_eq!(png(&palette, MAX_UNWRAPPED), None, "palette colour type");

        let mut long = pixel_payload(&ts);
        long[8..12].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(png(&png_of(&long, &PngSpec::default()), MAX_UNWRAPPED), None, "declared length past the pixels");

        let mut bad_crc = pixel_payload(&ts);
        let at = bad_crc.len() - 6;
        bad_crc[at] ^= 0xFF;
        assert_eq!(png(&png_of(&bad_crc, &PngSpec::default()), MAX_UNWRAPPED), None, "gzip CRC mismatch");

        let good = png_pixel_disguise(&ts, &PngSpec::default());
        let idat = good.windows(4).position(|w| w == b"IDAT").unwrap();
        let mut bad_zlib = good.clone();
        bad_zlib[idat + 4 + 2] ^= 0xFF;
        bad_zlib[idat + 4 + 3] ^= 0xFF;
        assert_eq!(png(&bad_zlib, MAX_UNWRAPPED), None, "corrupt deflate");

        assert_eq!(png(&good[..good.len() - 20], MAX_UNWRAPPED), None, "truncated before IEND");
    }

    #[test]
    fn an_oversized_header_is_rejected_before_anything_is_inflated() {
        let mut body = PNG_SIG.to_vec();
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&65_535u32.to_be_bytes());
        ihdr.extend_from_slice(&65_535u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        chunk(&mut body, b"IHDR", &ihdr);
        chunk(&mut body, b"IDAT", &zlib(&[0u8; 64]));
        chunk(&mut body, b"IEND", &[]);
        assert_eq!(png(&body, MAX_UNWRAPPED), None);
    }

    #[test]
    fn a_gzip_bomb_is_cut_off_at_the_cap() {
        let bomb = vec![SYNC; 1 << 20];
        let body = png_pixel_disguise(&bomb, &PngSpec { width: 64, ..PngSpec::default() });
        assert_eq!(png(&body, 64 << 10), None);
        assert!(png(&body, MAX_UNWRAPPED).is_some(), "fixture sanity: it decodes without the cap");
    }

    #[test]
    fn a_stream_appended_after_iend_is_sliced_not_copied() {
        let ts = null_ts(20);
        let mut body = png_of(&noise(30_000, 4), &PngSpec::default());
        let end = body.len();
        body.extend_from_slice(&ts);
        assert_eq!(png(&body, MAX_UNWRAPPED), Some((Reveal::Slice(end, body.len()), Disguise::PngTrailer)));
    }

    #[test]
    fn the_tiktik_markers_are_read_bare_and_length_prefixed() {
        let ts = null_ts(30);
        let junk = noise(10_000, 2);
        let with = |magic: &[u8], prefixed: bool, payload: &[u8]| {
            let mut b = junk.clone();
            b.extend_from_slice(magic);
            if prefixed {
                b.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            }
            b.extend_from_slice(payload);
            b
        };
        for prefixed in [false, true] {
            let raw = with(RAW_MAGIC, prefixed, &ts);
            let start = junk.len() + RAW_MAGIC.len() + if prefixed { 4 } else { 0 };
            assert_eq!(markers(&raw, MAX_UNWRAPPED), Some((Reveal::Slice(start, raw.len()), Disguise::TiktikRaw)));

            let gz = with(GZIP_MAGIC, prefixed, &gzip(&ts));
            assert_eq!(owned(markers(&gz, MAX_UNWRAPPED)), Some((ts.clone(), Disguise::TiktikGzip)));
        }
        assert_eq!(markers(&with(RAW_MAGIC, false, &noise(2000, 1)), MAX_UNWRAPPED), None, "a marker alone proves nothing");
    }

    #[test]
    fn only_image_or_marker_heads_ask_for_the_whole_body() {
        assert!(needs_whole_body(&png_of(&noise(10, 1), &PngSpec::default())));
        let mut marked = noise(3000, 5);
        marked.extend_from_slice(RAW_MAGIC);
        assert!(needs_whole_body(&marked));
        assert!(!needs_whole_body(&noise(5000, 5)));
        assert!(!needs_whole_body(&null_ts(20)));
    }

    #[test]
    #[ignore = "needs a captured segment: MASQ_TIKTOK_PNG=/path/to/segment.png (never commit one)"]
    fn a_captured_tiktok_png_segment_decodes_to_transport_stream() {
        let path = std::env::var("MASQ_TIKTOK_PNG").expect("MASQ_TIKTOK_PNG");
        let body = std::fs::read(path).expect("readable capture");
        let (ts, kind) = owned(png(&body, MAX_UNWRAPPED)).expect("the capture unwraps");
        assert_eq!(kind, Disguise::PngPixels);
        assert_eq!(ts.len() % PKT, 0);
        assert!(ts.chunks(PKT).all(|p| p[0] == SYNC), "every packet on a sync byte");
        assert_eq!(crate::tsseg::inspect_segment(&ts), None, "a healthy stream");
        if let Ok(want) = std::env::var("MASQ_TIKTOK_PNG_TS_LEN") {
            assert_eq!(ts.len().to_string(), want);
        }
    }
}
