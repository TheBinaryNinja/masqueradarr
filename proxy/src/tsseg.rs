//! S3/ORIGIN Phase 5 — cutting a BARE MPEG-TS socket into ring segments.
//!
//! The HLS ingest gets its segment boundaries handed to it: the upstream playlist says where each segment
//! starts and how long it is. A raw-TS source (`direct`, `hdhomerun`) gives none of that — it is one endless
//! 188-byte-packet stream — so the origin has to find the boundaries itself before anything can go in the
//! ring or be republished as HLS.
//!
//! This is PARSING, not decoding: we read the PSI tables to learn which PID carries video, then cut at
//! packets the stream itself marks as random-access points. No codec is involved and no bytes are rewritten —
//! a produced segment is a byte-exact slice of the input.
//!
//! WHERE TO CUT. A segment must begin at a point a decoder can start cold, or a client joining mid-stream
//! gets garbage until the next keyframe. MPEG-TS advertises exactly that with the adaptation field's
//! `random_access_indicator`, so the rule is: cut at an RAI packet on the video PID, but only once the
//! current segment has reached the target duration — otherwise a stream with frequent keyframes would be
//! chopped into hundreds of tiny segments.
//!
//! HOW LONG IS A SEGMENT. `#EXTINF` has to be accurate or playback drifts, so duration comes from the
//! stream's own PCR (a 27 MHz clock in the adaptation field), NOT from wall-clock read timing — wall-clock
//! happens to work for a live tuner delivering in real time and is badly wrong for anything that arrives
//! faster than real time (a file, a catch-up buffer, a fast CDN).
//!
//! Everything here is deliberately pure and synchronous: `push` takes bytes and returns finished segments,
//! so the whole boundary/duration story is unit-testable against synthetic packets with no network.

use bytes::Bytes;

/// One TS packet. The format is fixed-size and self-framing, which is what makes this tractable.
pub(crate) const PKT: usize = 188;
pub(crate) const SYNC: u8 = 0x47;

/// PCR base ticks per second (the 90 kHz clock the 33-bit base counts in).
const PCR_HZ: f64 = 90_000.0;

/// The 33-bit PCR base wraps roughly every 26.5 hours; a wrap must read as "a bit later", not as a huge
/// negative jump that would produce a nonsense `#EXTINF`.
const PCR_WRAP: u64 = 1 << 33;

/// Stream types that carry video in a PMT. Anything else (audio, subtitles, data) is ignored for cutting —
/// a segment boundary is only meaningful at a VIDEO random-access point.
pub(crate) fn is_video_stream_type(t: u8) -> bool {
    matches!(t, 0x01 | 0x02 | 0x10 | 0x1B | 0x24 | 0x42 | 0xD1 | 0xEA)
}

/// A finished segment: a byte-exact slice of the input plus its measured duration.
#[derive(Debug, Clone, PartialEq)]
pub struct CutSegment {
    pub bytes: Vec<u8>,
    pub duration: f64,
}

pub struct TsSegmenter {
    /// Bytes of an incomplete trailing packet, carried to the next `push`.
    carry: Vec<u8>,
    /// The segment being accumulated.
    cur: Vec<u8>,
    pmt_pid: Option<u16>,
    video_pid: Option<u16>,
    /// PCR base at the START of the current segment, and the most recent one seen.
    seg_start_pcr: Option<u64>,
    last_pcr: Option<u64>,
    /// Cut once the segment reaches this many seconds AND a random-access point arrives.
    target: f64,
    /// Hard cap so a stream that never signals random access (or whose RAI is absent) still produces
    /// segments rather than growing one forever. 3× target is late enough not to pre-empt a real RAI.
    max_duration: f64,
    /// True once the first PAT/PMT has been parsed — before that we cannot know the video PID, so we do not
    /// cut at all (a segment starting at an arbitrary packet would not be decodable from cold).
    ready: bool,
}

impl TsSegmenter {
    pub fn new(target_seconds: f64) -> Self {
        let target = if target_seconds > 0.0 { target_seconds } else { 5.0 };
        Self {
            carry: Vec::new(),
            cur: Vec::new(),
            pmt_pid: None,
            video_pid: None,
            seg_start_pcr: None,
            last_pcr: None,
            target,
            max_duration: target * 3.0,
            ready: false,
        }
    }

    /// Feed a chunk; return every segment that completed within it.
    ///
    /// Chunk boundaries are arbitrary (they are whatever the socket handed us), so a partial trailing packet
    /// is carried rather than dropped — losing it would corrupt the very next packet's framing.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<CutSegment> {
        let mut out = Vec::new();
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(chunk);

        // Resync: a stream may start mid-packet, or a dropped read may desync us. Scan to a 0x47 that is
        // corroborated by a second 0x47 one packet later, so a random payload byte cannot fake a sync.
        let mut i = match find_sync(&buf) {
            Some(i) => i,
            None => {
                // No credible sync yet — keep only a trailing window so `buf` cannot grow without bound.
                let keep = buf.len().min(PKT * 2);
                self.carry = buf[buf.len() - keep..].to_vec();
                return out;
            }
        };

        while i + PKT <= buf.len() {
            let pkt = &buf[i..i + PKT];
            if pkt[0] != SYNC {
                // Lost framing mid-buffer — resync from here rather than emitting garbage.
                match find_sync(&buf[i..]) {
                    Some(off) => {
                        i += off;
                        continue;
                    }
                    None => break,
                }
            }
            self.consume_packet(pkt, &mut out);
            i += PKT;
        }
        self.carry = buf[i..].to_vec();
        out
    }

    /// Flush whatever is buffered as a final segment (upstream ended / ingest stopping).
    pub fn finish(&mut self) -> Option<CutSegment> {
        if self.cur.is_empty() {
            return None;
        }
        let d = self.elapsed().unwrap_or(self.target);
        Some(CutSegment {
            bytes: std::mem::take(&mut self.cur),
            duration: d,
        })
    }

    fn consume_packet(&mut self, pkt: &[u8], out: &mut Vec<CutSegment>) {
        let pid = (((pkt[1] & 0x1F) as u16) << 8) | pkt[2] as u16;
        let (rai, pcr) = adaptation_info(pkt);

        // PSI first: we cannot decide anything until we know which PID is video.
        if pid == 0 {
            if let Some(p) = parse_pat(pkt) {
                self.pmt_pid = Some(p);
            }
        } else if Some(pid) == self.pmt_pid {
            if let Some(v) = parse_pmt_video_pid(pkt) {
                self.video_pid = Some(v);
                self.ready = true;
            }
        }

        if let Some(p) = pcr {
            self.last_pcr = Some(p);
            if self.seg_start_pcr.is_none() {
                self.seg_start_pcr = Some(p);
            }
        }

        // A cut is only legal at a random-access point on the VIDEO pid, and only once the segment has
        // earned its length. `elapsed` is None until two PCRs have been seen, so early packets accumulate.
        let elapsed = self.elapsed();
        let long_enough = elapsed.map(|d| d >= self.target).unwrap_or(false);
        let overlong = elapsed.map(|d| d >= self.max_duration).unwrap_or(false);
        let at_random_access = rai && Some(pid) == self.video_pid;
        let cut = self.ready && !self.cur.is_empty() && ((at_random_access && long_enough) || overlong);

        if cut {
            let d = elapsed.unwrap_or(self.target);
            out.push(CutSegment {
                bytes: std::mem::take(&mut self.cur),
                duration: d,
            });
            // The new segment starts AT this packet, so its clock starts here too.
            self.seg_start_pcr = pcr.or(self.last_pcr);
        }
        self.cur.extend_from_slice(pkt);
    }

    /// Seconds covered by the current segment, from the stream's own clock. None until two PCRs are known.
    fn elapsed(&self) -> Option<f64> {
        let (start, last) = (self.seg_start_pcr?, self.last_pcr?);
        // Wrap-safe: a 33-bit rollover reads as a small forward delta, never a ~26-hour negative one.
        let delta = last.wrapping_sub(start) & (PCR_WRAP - 1);
        Some(delta as f64 / PCR_HZ)
    }
}

/// Find an offset whose 0x47 is corroborated by another 0x47 exactly one packet later — a single stray 0x47
/// in a payload is common, two at a 188-byte stride is not.
fn find_sync(buf: &[u8]) -> Option<usize> {
    for i in 0..buf.len() {
        if buf[i] != SYNC {
            continue;
        }
        if i + PKT >= buf.len() {
            // Cannot corroborate yet; accept it only if it is the very start of what we have.
            return if i + PKT <= buf.len() { Some(i) } else { None };
        }
        if buf[i + PKT] == SYNC {
            return Some(i);
        }
    }
    None
}

/// `(random_access_indicator, pcr_base)` from a packet's adaptation field, if present.
fn adaptation_info(pkt: &[u8]) -> (bool, Option<u64>) {
    let afc = (pkt[3] >> 4) & 0b11;
    if afc != 0b10 && afc != 0b11 {
        return (false, None); // payload only — no adaptation field
    }
    let len = pkt[4] as usize;
    if len == 0 || 5 + len > PKT {
        return (false, None);
    }
    let flags = pkt[5];
    let rai = flags & 0x40 != 0;
    let mut pcr = None;
    if flags & 0x10 != 0 && len >= 7 {
        // PCR: 33-bit base, 6 reserved bits, 9-bit extension — we only need the 90 kHz base.
        let b = &pkt[6..12];
        if b.len() == 6 {
            pcr = Some(
                ((b[0] as u64) << 25)
                    | ((b[1] as u64) << 17)
                    | ((b[2] as u64) << 9)
                    | ((b[3] as u64) << 1)
                    | ((b[4] as u64) >> 7),
            );
        }
    }
    (rai, pcr)
}

/// The payload of a PSI packet, skipping the adaptation field and the `pointer_field`.
fn psi_payload(pkt: &[u8]) -> Option<&[u8]> {
    let pusi = pkt[1] & 0x40 != 0;
    if !pusi {
        return None; // section continuation — we only parse self-contained first sections
    }
    let afc = (pkt[3] >> 4) & 0b11;
    let mut off = 4;
    if afc == 0b10 || afc == 0b11 {
        let len = pkt[4] as usize;
        off = 5 + len;
    }
    if afc == 0b10 || off >= PKT {
        return None; // adaptation only — no payload
    }
    let pointer = pkt[off] as usize;
    let start = off + 1 + pointer;
    if start >= PKT {
        return None;
    }
    Some(&pkt[start..])
}

/// First `program_map_PID` in a PAT.
pub(crate) fn parse_pat(pkt: &[u8]) -> Option<u16> {
    let s = psi_payload(pkt)?;
    if s.len() < 8 || s[0] != 0x00 {
        return None; // table_id 0x00 = PAT
    }
    let section_len = (((s[1] & 0x0F) as usize) << 8) | s[2] as usize;
    let end = 3 + section_len;
    if end > s.len() || section_len < 9 {
        return None;
    }
    // Skip the 5-byte section header; entries run until the 4-byte CRC.
    let mut i = 8;
    while i + 4 <= end - 4 {
        let program = ((s[i] as u16) << 8) | s[i + 1] as u16;
        let pid = (((s[i + 2] & 0x1F) as u16) << 8) | s[i + 3] as u16;
        if program != 0 {
            return Some(pid); // program 0 is the NIT, not a program map
        }
        i += 4;
    }
    None
}

/// First VIDEO `elementary_PID` in a PMT.
fn parse_pmt_video_pid(pkt: &[u8]) -> Option<u16> {
    parse_pmt(pkt).and_then(|m| m.video_pid())
}

/// Everything a PMT declares that a splice check cares about: the PCR clock's PID and the full elementary
/// stream list. `parse_pmt_video_pid` is the cutting path's narrow view of this.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PmtInfo {
    pub pcr_pid: u16,
    /// `(elementary_PID, stream_type)` in PMT order — order is part of the fingerprint, since a reordered
    /// PMT means a different mux even when the set matches.
    pub streams: Vec<(u16, u8)>,
}

impl PmtInfo {
    pub(crate) fn video_pid(&self) -> Option<u16> {
        self.streams.iter().find(|(_, t)| is_video_stream_type(*t)).map(|(p, _)| *p)
    }
}

pub(crate) fn parse_pmt(pkt: &[u8]) -> Option<PmtInfo> {
    let s = psi_payload(pkt)?;
    if s.len() < 12 || s[0] != 0x02 {
        return None; // table_id 0x02 = PMT
    }
    let section_len = (((s[1] & 0x0F) as usize) << 8) | s[2] as usize;
    let end = 3 + section_len;
    if end > s.len() || section_len < 13 {
        return None;
    }
    let pcr_pid = (((s[8] & 0x1F) as u16) << 8) | s[9] as u16;
    let program_info_len = (((s[10] & 0x0F) as usize) << 8) | s[11] as usize;
    let mut streams = Vec::new();
    let mut i = 12 + program_info_len;
    while i + 5 <= end - 4 {
        let stream_type = s[i];
        let pid = (((s[i + 1] & 0x1F) as u16) << 8) | s[i + 2] as u16;
        let es_info_len = (((s[i + 3] & 0x0F) as usize) << 8) | s[i + 4] as usize;
        streams.push((pid, stream_type));
        i += 5 + es_info_len;
    }
    Some(PmtInfo { pcr_pid, streams })
}

// ── S3/CUE: splice-boundary stream fingerprint ───────────────────────────────────────────────────────────
//
// Answers ONE question about a splice: can the decoder keep its configuration across this join, or must it
// reconfigure? That is what decides whether an `#EXT-X-DISCONTINUITY` is load-bearing or merely cosmetic —
// and, later, whether substituted filler can be codec-matched to the program around it.
//
// Parameter sets are HASHED, never parsed. Identical SPS bytes imply identical resolution, profile, level,
// frame rate and VUI *by construction*, and a spurious "changed" (same resolution, re-emitted SPS with a
// different VUI) only makes us MORE conservative. Parsing an H.264 SPS instead would mean un-escaping
// emulation-prevention bytes and Exp-Golomb-decoding through frame cropping — the most error-prone code we
// could add, for a strictly weaker guarantee. This scan is read-only and allocates one bounded buffer.

/// How much video elementary stream to accumulate while hunting for the parameter sets. They sit at the head
/// of the first access unit, so this only has to cover a keyframe's leading NALs — not the whole segment.
const PARAM_SCAN_CAP: usize = 96 * 1024;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h = FNV_OFFSET;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

/// A segment's decoder-configuration fingerprint.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct StreamProfile {
    pub pcr_pid: u16,
    pub streams: Vec<(u16, u8)>,
    /// FNV-1a over the concatenated video parameter-set NALs (H.264 SPS+PPS, HEVC VPS+SPS+PPS). `None` when
    /// none were found — which is itself a reason to stay conservative, not a reason to assume a match.
    pub video_params: Option<u64>,
}

impl StreamProfile {
    /// Whether a decoder configured for `self` can continue into `next` untouched. Deliberately strict:
    /// anything we could not positively verify counts as a change.
    pub fn compatible_with(&self, next: &StreamProfile) -> bool {
        self.pcr_pid == next.pcr_pid
            && self.streams == next.streams
            && self.video_params.is_some()
            && self.video_params == next.video_params
    }
}

/// Fingerprint one decrypted TS segment. `None` when the bytes carry no PMT — parameters are then
/// unverifiable, which callers must treat as "changed".
pub(crate) fn scan_profile(bytes: &[u8]) -> Option<StreamProfile> {
    let mut pmt_pid: Option<u16> = None;
    let mut pmt: Option<PmtInfo> = None;
    let mut video_pid: Option<u16> = None;
    let mut es: Vec<u8> = Vec::new();

    let mut i = 0usize;
    while i + PKT <= bytes.len() {
        if bytes[i] != SYNC {
            // Resync exactly like the segmenter does rather than trusting alignment.
            i += 1;
            continue;
        }
        let pkt = &bytes[i..i + PKT];
        i += PKT;
        let pid = (((pkt[1] & 0x1F) as u16) << 8) | pkt[2] as u16;
        if pid == 0x1FFF || pkt[1] & 0x80 != 0 {
            continue; // null padding, or transport_error_indicator set — never parse corrupt packets
        }
        if pid == 0 {
            pmt_pid = pmt_pid.or_else(|| parse_pat(pkt));
        } else if Some(pid) == pmt_pid && pmt.is_none() {
            pmt = parse_pmt(pkt);
            video_pid = pmt.as_ref().and_then(|m| m.video_pid());
        } else if Some(pid) == video_pid && es.len() < PARAM_SCAN_CAP {
            if let Some(p) = es_payload(pkt) {
                es.extend_from_slice(p);
            }
        }
    }

    let pmt = pmt?;
    let video_params = video_pid.and_then(|_| {
        let types: Vec<u8> = pmt.streams.iter().filter(|(_, t)| is_video_stream_type(*t)).map(|(_, t)| *t).collect();
        parameter_sets(&es, types.first().copied().unwrap_or(0x1B))
    });
    Some(StreamProfile { pcr_pid: pmt.pcr_pid, streams: pmt.streams, video_params })
}

/// A packet's elementary-stream bytes, with any PES header stripped so the NAL scan never sees one.
fn es_payload(pkt: &[u8]) -> Option<&[u8]> {
    let afc = (pkt[3] >> 4) & 0b11;
    let mut off = 4;
    if afc == 0b10 || afc == 0b11 {
        let len = pkt[4] as usize;
        off = 5 + len;
    }
    if afc == 0b10 || off >= PKT {
        return None; // adaptation only
    }
    let payload = &pkt[off..];
    if pkt[1] & 0x40 == 0 {
        return Some(payload); // continuation — already raw ES
    }
    // PUSI: this payload starts with a PES header. `00 00 01 <stream_id>`, then a 3-byte optional-header
    // prelude whose third byte is the length of everything else before the ES data.
    if payload.len() < 9 || payload[0..3] != [0x00, 0x00, 0x01] {
        return Some(payload); // not a PES start we understand — hand it over unmodified
    }
    let hdr = 9 + payload[8] as usize;
    payload.get(hdr..)
}

/// A NAL unit's type, from the first byte of its header. `hevc` picks the grammar: HEVC puts the type in bits
/// 6..1, H.264 in the low 5 bits. Shared by the parameter-set hash and the keyframe scan, so the two can never
/// read the same header differently.
fn nal_type(header: u8, hevc: bool) -> u8 {
    if hevc {
        (header >> 1) & 0x3F
    } else {
        header & 0x1F
    }
}

/// Hash the video parameter-set NALs at the head of an access unit. `stream_type` picks the NAL grammar
/// (`nal_type`): HEVC is 0x24, anything else is read as H.264.
fn parameter_sets(es: &[u8], stream_type: u8) -> Option<u64> {
    let hevc = stream_type == 0x24;
    let mut found: Vec<u8> = Vec::new();
    let mut count = 0;
    let mut i = 0usize;
    while i + 4 < es.len() {
        // Annex-B start code: 00 00 01 (a 4-byte 00 00 00 01 is just this preceded by a zero).
        if es[i] != 0 || es[i + 1] != 0 || es[i + 2] != 1 {
            i += 1;
            continue;
        }
        let head = i + 3;
        let t = nal_type(es[head], hevc);
        // H.264: SPS 7, PPS 8. HEVC: VPS 32, SPS 33, PPS 34.
        let wanted = if hevc { matches!(t, 32..=34) } else { matches!(t, 7 | 8) };
        if wanted {
            // Run to the next start code — that delimits this NAL.
            let mut j = head;
            while j + 3 <= es.len() && !(es[j] == 0 && es[j + 1] == 0 && es[j + 2] == 1) {
                j += 1;
            }
            found.extend_from_slice(&es[head..j.min(es.len())]);
            count += 1;
            // H.264 needs SPS+PPS, HEVC VPS+SPS+PPS. Stop once we plausibly have them so a stream that
            // re-sends parameter sets per keyframe hashes the same bytes every time.
            if count >= if hevc { 3 } else { 2 } {
                break;
            }
            i = j;
            continue;
        }
        i = head;
    }
    (!found.is_empty()).then(|| fnv1a(&found))
}

// ── KEY: where a cold decoder can start ──────────────────────────────────────────────────────────────────
//
// A raw-TS client decodes from the first byte it is sent. When that is not a keyframe, every picture until the
// next one predicts from frames the decoder never received: grey smears and blocking on a hardware decoder, a
// blank until the keyframe on ffmpeg (which throws them away — `non-existing PPS 0 referenced`). An HLS player
// is spared most of this, since it picks its own entry point and many sniff for the keyframe; a bare socket's
// first byte is simply where decoding begins.
//
// A segment boundary is not a keyframe. RFC 8216 does not ask segments to open on one — that is the promise
// `#EXT-X-INDEPENDENT-SEGMENTS` makes, and the source that makes it falsely is the reason this exists: the live
// zlive capture puts its first IDR 0.1–1.9 s into each ~3.75 s segment, behind a run of P and B pictures. Nor can
// the transport stream's own `random_access_indicator` find it: that same capture sets RAI on EVERY video PES,
// keyframe or not. Only the elementary stream says which picture is an IDR, so this reads NAL headers — with no
// cap. `scan_profile`'s 96 KiB is sized for parameter sets at the head of an access unit; the keyframe this has
// to reach sat 915 KB into the captured segment.
//
// The cut is a PES boundary: the packet that opens the keyframe's PES, which opens its access unit — the SPS,
// PPS and SEI ride in front of the slice in that same PES, exactly as they do in the capture. The segment's
// PAT/PMT are kept in front of it, so the demuxer knows the program before the picture arrives, and the audio
// muxed in front of the keyframe goes with the pictures it accompanied, so sound does not start seconds ahead
// of the picture. (What remains keeps the mux's own small audio lead — 0.12 s on the capture.)
//
// Only a JOIN is ever trimmed: once the decoder holds a keyframe every later picture decodes, so every later
// segment is sent exactly as it is. And a segment in which no keyframe can be found is sent whole — an open-GOP
// encoder may never send an IDR at all, and holding the stream back for one would be a blank screen forever.

/// NAL types a cold decoder can start at. H.264: the IDR slice (5). HEVC: every IRAP picture — BLA (16–18), IDR
/// (19, 20) and CRA (21); a decoder that starts at a CRA drops the leading pictures that reach back past it,
/// which is the standard's own random-access procedure.
fn is_keyframe_nal(t: u8, hevc: bool) -> bool {
    if hevc {
        (16..=21).contains(&t)
    } else {
        t == 5
    }
}

/// Where the first keyframe's PES opens — the byte offset of its first packet, the earliest point in `bytes` a
/// cold decoder can start from — together with the PMT pid, so the caller can keep the tables from ahead of it.
/// `None` when the program carries no H.264/HEVC video (nothing else is read here), or no keyframe opens a PES.
pub(crate) fn first_keyframe(bytes: &[u8]) -> Option<(usize, u16)> {
    let mut pmt_pid: Option<u16> = None;
    let mut video: Option<(u16, bool)> = None; // (pid, hevc)
    // The packet that opened the video PES being read. `None` until the first PES start: a keyframe inside a PES
    // whose head the segment boundary cut off cannot be joined at, so the scan moves on to the next one.
    let mut pes_at: Option<usize> = None;
    // The last ES bytes seen, carried ACROSS packets — a start code split over two packets still counts.
    let mut window = u32::MAX;
    let mut i = 0usize;
    while i + PKT <= bytes.len() {
        if bytes[i] != SYNC {
            i += 1; // resync exactly like `scan_profile`, rather than trusting alignment
            continue;
        }
        let at = i;
        let pkt = &bytes[i..i + PKT];
        i += PKT;
        let pid = (((pkt[1] & 0x1F) as u16) << 8) | pkt[2] as u16;
        if pid == 0x1FFF || pkt[1] & 0x80 != 0 {
            continue; // null padding, or transport_error_indicator set — never parse corrupt packets
        }
        if pid == 0 {
            pmt_pid = pmt_pid.or_else(|| parse_pat(pkt));
            continue;
        }
        if Some(pid) == pmt_pid {
            // Not `?` on the parse: a packet on the PMT pid that does not parse is usually a section continuation.
            if let Some(pmt) = video.is_none().then(|| parse_pmt(pkt)).flatten() {
                let vpid = pmt.video_pid()?; // no video declared ⇒ nothing to join at
                let hevc = match pmt.streams.iter().find(|(p, _)| *p == vpid).map(|(_, t)| *t) {
                    Some(0x1B) => false,
                    Some(0x24) => true,
                    _ => return None, // MPEG-2 and friends: a grammar this does not read
                };
                video = Some((vpid, hevc));
            }
            continue;
        }
        let Some((vpid, hevc)) = video else { continue };
        if pid != vpid {
            continue;
        }
        if pkt[3] & 0xC0 != 0 {
            return None; // scrambled: the NAL headers underneath are not readable
        }
        if pkt[1] & 0x40 != 0 {
            pes_at = Some(at);
            window = u32::MAX; // a new PES: `es_payload` strips its header, so its ES starts clean
        }
        let Some(es) = es_payload(pkt) else { continue };
        for &b in es {
            // The byte after an Annex-B start code (00 00 01) is a NAL header.
            if window & 0x00FF_FFFF == 0x0000_0001 && is_keyframe_nal(nal_type(b, hevc), hevc) {
                if let Some(start) = pes_at {
                    return Some((start, pmt_pid?));
                }
            }
            window = (window << 8) | b as u32;
        }
    }
    None
}

/// A segment trimmed for a client joining cold (see KEY): its program tables, then everything from its first
/// keyframe's PES on, byte for byte. `None` when there is nothing to trim — it already opens on the keyframe,
/// give or take the tables in front — or no keyframe to trim to; either way the caller sends the segment whole.
pub(crate) fn trim_to_keyframe(bytes: &[u8]) -> Option<Vec<u8>> {
    let (cut, pmt_pid) = first_keyframe(bytes)?;
    let mut out = Vec::with_capacity(bytes.len() - cut + 4 * PKT);
    let mut dropped = false;
    // The same resync walk `first_keyframe` took, so it lands on `cut` exactly.
    let mut i = 0usize;
    while i < cut {
        if bytes[i] != SYNC || i + PKT > cut {
            i += 1;
            dropped = true;
            continue;
        }
        let pkt = &bytes[i..i + PKT];
        i += PKT;
        let pid = (((pkt[1] & 0x1F) as u16) << 8) | pkt[2] as u16;
        // EVERY table packet ahead of the cut, not just the first pair: a repeat carries the next continuity
        // counter, so keeping them all leaves the table pids' counters unbroken on a path that serves verbatim.
        if pid == 0 || pid == pmt_pid {
            out.extend_from_slice(pkt);
        } else {
            dropped = true;
        }
    }
    if !dropped {
        return None;
    }
    out.extend_from_slice(&bytes[cut..]);
    Some(out)
}

// ── S3/UND: is this upstream structurally usable? ────────────────────────────────────────────────────────
//
// Every OTHER health signal in the engine answers "are bytes arriving?". A provider can serve flawless
// HTTP 200s that no decoder can turn into a picture, and nothing above notices — serve counts measure
// fetching, not rendering. This layer is the narrow exception: a read-only verdict on the MEDIA, computed
// from what `scan_profile` already extracts.
//
// THE BAR FOR ADDING A REASON, learned the hard way. The first cut struck on "no video parameter sets"
// alone, which is also true of an audio-only program — and dlhd channel 521 draws exactly that shape from
// one of its providers. A WORKING channel was declined off the origin path. So every reason here must have:
//
//   1. a confirmed live TRUE positive, reproduced against the provider DIRECT (proxy out of the path), and
//   2. a test pinning the innocent shape it must NOT fire on.
//
// A reason that cannot show both does not belong here. Hopping off a working provider is a visible
// regression for every viewer of that channel; missing a broken one costs one channel until an operator
// looks. That asymmetry is the whole design constraint.

/// Why an upstream looks structurally unusable. Named rather than a bool so the `iop` log and the burn
/// record both say WHICH fault, and so a future reason cannot silently inherit this one's evidence.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Suspect {
    /// The bytes are not an MPEG transport stream at all — an error page, an image, a truncated body.
    /// Nothing downstream can use them, and today they would be ringed and served verbatim.
    NotTransportStream,
    /// The program DECLARES video, but its elementary stream carries no decoder parameter sets (H.264
    /// SPS/PPS, HEVC VPS/SPS/PPS) — so a decoder has nothing to configure itself from and emits no frames.
    /// Live true positive: dlhd ch 648 via Player 4 (`non-existing PPS 0 referenced` / `no frame!`).
    NoVideoParameterSets,
}

impl Suspect {
    /// Stable slug sent to the resolve seam as `reason`, and recorded against the burnt provider.
    pub(crate) fn slug(self) -> &'static str {
        match self {
            Suspect::NotTransportStream => "not-transport-stream",
            Suspect::NoVideoParameterSets => "undecodable-video",
        }
    }

    /// Operator-facing phrasing for the `iop` line.
    pub(crate) fn describe(self) -> &'static str {
        match self {
            Suspect::NotTransportStream => "segments are not an MPEG transport stream",
            Suspect::NoVideoParameterSets => "declares video but serves no decoder parameter sets",
        }
    }
}

/// How many packet-strides of 0x47 prove a buffer really is a transport stream. `find_sync` corroborates
/// with ONE follow-up, which is right for locating a boundary mid-stream but too weak to judge a whole
/// segment: random payload produces a coincidental pair often enough. Five in a row does not.
const TS_SYNC_PROOF: usize = 5;

/// Enough bytes to judge at all. Below this a short or truncated body is UNVERIFIABLE, not broken — the
/// ingest's own retry is the right response to a partial fetch, not retiring the provider.
const TS_MIN_JUDGEABLE: usize = TS_SYNC_PROOF * PKT * 2;

/// Whether `bytes` is an MPEG transport stream, judged on SYNC BYTES rather than anything about the URL.
/// That distinction is load-bearing: dlhd and pluto both serve valid TS from `.png`-named objects on
/// object storage, so an extension test would condemn perfectly good media.
fn looks_like_transport_stream(bytes: &[u8]) -> bool {
    find_sync(bytes).is_some_and(|start| proven_sync_at(bytes, start))
}

/// THE definition of "a transport stream starts here": `TS_SYNC_PROOF` sync bytes at exact packet strides
/// from `at`. Shared by the verdict layer above and the disguise unwrap below, so the two can never disagree
/// about what counts as proof — one of them retires providers, the other deletes bytes.
fn proven_sync_at(bytes: &[u8], at: usize) -> bool {
    (0..TS_SYNC_PROOF).all(|k| bytes.get(at + k * PKT) == Some(&SYNC))
}

/// Judge ONE decrypted segment. `None` ⇒ nothing to hold against this upstream — either it is healthy, or
/// it cannot be verified (no PSI, too short), which must never be read as a fault.
pub(crate) fn inspect_segment(bytes: &[u8]) -> Option<Suspect> {
    if bytes.len() < TS_MIN_JUDGEABLE {
        return None; // unverifiable
    }
    if !looks_like_transport_stream(bytes) {
        return Some(Suspect::NotTransportStream);
    }
    let p = scan_profile(bytes)?; // no PMT ⇒ unverifiable, NOT a fault
    // BOTH halves, always: video must be DECLARED before its missing parameter sets mean anything. Without
    // this an audio-only program reads as undecodable video — the false positive that cost a live channel.
    let declares_video = p.streams.iter().any(|&(_, t)| is_video_stream_type(t));
    (declares_video && p.video_params.is_none()).then_some(Suspect::NoVideoParameterSets)
}

// ── DSG: transport streams that arrive disguised as something else ───────────────────────────────────────
//
// Some providers park their segments on an IMAGE CDN — cheap, fast, rarely blocked — and an image CDN only
// stores images, so the TS travels inside one. The live case (zlive, on a TikTok ImageX bucket) is a
// RIFF/WEBP file: a 1×1 VP8L picture, then an EXIF chunk whose payload IS the transport stream, byte for byte.
// 42 bytes of wrapper, then the first 0x47, and nothing after the last packet.
//
// hls.js shrugs that off (it scans a few packets for a proven sync before demuxing). ffmpeg does not: it
// probes the head, scores `webp_pipe` at 99, and every Plex / Jellyfin / Channels client gets a 1×1 still.
// The ring is worse off than either. `tsnorm`'s byte walkers resync on a LONE 0x47, and the wrapper's two
// little-endian size fields carry one in ~0.45 % of segments — which frames a bogus packet straight over the
// segment's only PAT, so splice normalisation declines and the PMT pid flips for that one segment.
//
// THE RULE, and why it cannot misfire on real media:
//   · A body whose FIRST byte is 0x47 is never touched, even when its own proof fails. That is every TS
//     source that works today — dlhd's and pluto's `.png`-named objects included, and a TS whose second
//     packet is corrupt. None of them may lose a byte to this.
//   · STRUCTURE first. A RIFF/WEBP file's chunk table is walked to its EXIF chunk, and that payload is taken
//     when it is whole packets opening on a sync byte. The offset comes from sizes the file declares, never
//     from a scan — so a stray 0x47 inside those very sizes cannot move it.
//   · Otherwise the first offset within `MAX_DISGUISE_PREFIX` where `proven_sync_at` holds — the same proof
//     the verdict layer demands. A random or encrypted body fakes it about once in 4096 × 256⁻⁵ ≈ 4·10⁻⁹, and
//     the framing of fMP4, ADTS or 192-byte M2TS never produces it. Whatever DOES fake it already fools
//     `looks_like_transport_stream`, so the unwrap never sees a stream the verdict layer would not.
//
// Anything else is returned unchanged. The proof needs PLAINTEXT, so an encrypted segment is judged after it
// is decrypted, never before — a source that encrypts and THEN wraps would need a structure-only strip ahead
// of the decrypt, and none does.

/// The furthest into a body a disguised stream may start. The live wrapper is 42 bytes; 4 KiB leaves room
/// for a real thumbnail or a metadata chunk without letting the scan wander into media.
const MAX_DISGUISE_PREFIX: usize = 4096;

/// How much of a body's head the unwrap ever reads: enough to prove a sync at the last offset it may accept.
/// Judging on the head ALONE is what lets `DisguiseStripper` decide exactly what the slice form decides.
const DISGUISE_HEAD_BYTES: usize = MAX_DISGUISE_PREFIX + TS_SYNC_PROOF * PKT;

/// How many leading bytes of `bytes` are a disguise around a transport stream — `None` when there is nothing
/// to strip. See the section comment for the rule; callers drop exactly this many bytes and keep the rest.
pub(crate) fn disguise_prefix_len(bytes: &[u8]) -> Option<usize> {
    let head = &bytes[..bytes.len().min(DISGUISE_HEAD_BYTES)];
    if head.first().is_none_or(|&b| b == SYNC) {
        return None; // empty, or already opens on a packet: the veto that keeps every clean source untouched
    }
    riff_exif_payload(head)
        .or_else(|| (1..=MAX_DISGUISE_PREFIX.min(head.len())).find(|&p| proven_sync_at(head, p)))
}

/// A stable name for a disguise `disguise_prefix_len` saw through — for the `iop` frame and the one-shot log
/// lines, so an operator can tell "wrapped in a WebP" from "some prefix we skipped".
pub(crate) fn disguise_label(bytes: &[u8]) -> &'static str {
    if is_riff_webp(bytes) {
        "riff-webp"
    } else {
        "opaque-prefix"
    }
}

fn is_riff_webp(b: &[u8]) -> bool {
    b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP"
}

/// The STRUCTURAL reading: walk a RIFF/WEBP chunk table (fourCC, little-endian u32 size, payload padded to
/// an even length) to its EXIF chunk, and return where that payload starts when it is a transport stream —
/// whole 188-byte packets, opening on a sync byte.
///
/// The declared sizes ARE the proof here, which is why this runs before the scan and why it asks for no
/// five-stride run: a damaged packet near the head would otherwise hand the decision to the scan, and the scan
/// would land past it — dropping the good packets (the PAT among them) that stood in front of the damage.
///
/// Deliberately blind to the body's total length: the streaming form only ever has the head, and a check
/// against a length it cannot know would make the two forms disagree. A chunk table that runs past the head
/// window is simply not taken, and the sync scan gets its turn.
fn riff_exif_payload(head: &[u8]) -> Option<usize> {
    if !is_riff_webp(head) {
        return None;
    }
    let mut pos = 12usize;
    while pos < MAX_DISGUISE_PREFIX && pos + 8 <= head.len() {
        let size = u32::from_le_bytes([head[pos + 4], head[pos + 5], head[pos + 6], head[pos + 7]]) as usize;
        let payload = pos + 8;
        if &head[pos..pos + 4] == b"EXIF" {
            let whole_packets = size > 0 && size.is_multiple_of(PKT);
            let opens_on_sync = head.get(payload) == Some(&SYNC);
            return (payload <= MAX_DISGUISE_PREFIX && whole_packets && opens_on_sync).then_some(payload);
        }
        pos = payload.checked_add(size)?.checked_add(size & 1)?;
    }
    None
}

/// `disguise_prefix_len` for a body that is FORWARDED as it arrives. The relay pump and the raw-TS producer
/// never hold a whole segment, so they cannot hand one to the slice form.
///
/// Holds at most `DISGUISE_HEAD_BYTES` — or the whole body, if it ends first — decides ONCE, and from then on
/// passes every chunk through untouched. A body that opens on a sync byte (every clean TS source) is decided
/// by its first byte and is never held or copied, so enabling this costs a clean stream nothing. Whatever the
/// chunking, the output is exactly `body[disguise_prefix_len(body)..]`, which the tests pin.
pub(crate) struct DisguiseStripper {
    /// The undecided head. `None` once the decision is made.
    held: Option<Vec<u8>>,
    /// Leading bytes the decision dropped (0 = not disguised, or not decided yet).
    stripped: usize,
}

impl DisguiseStripper {
    pub(crate) fn new() -> Self {
        Self { held: Some(Vec::new()), stripped: 0 }
    }

    /// Feed the next chunk; returns the bytes that may be forwarded now (`None` while the head is held).
    pub(crate) fn push(&mut self, chunk: Bytes) -> Option<Bytes> {
        if chunk.is_empty() {
            return None;
        }
        let nothing_held = match &self.held {
            None => return Some(chunk), // decided: pure pass-through, zero copy
            Some(h) => h.is_empty(),
        };
        if nothing_held {
            // Both fast paths decide on this chunk alone, without copying it: one that opens on a sync byte
            // is vetoed by its first byte, and one that already spans the head window holds everything the
            // decision will ever read.
            if chunk[0] == SYNC {
                self.held = None;
                return Some(chunk);
            }
            if chunk.len() >= DISGUISE_HEAD_BYTES {
                self.held = None;
                return self.decide(chunk);
            }
        }
        let held = self.held.as_mut()?;
        held.extend_from_slice(&chunk);
        if held.len() < DISGUISE_HEAD_BYTES {
            return None;
        }
        let head = Bytes::from(self.held.take()?);
        self.decide(head)
    }

    /// The body ended (or stalled) while its head was still held — decide on what arrived and release it.
    /// A short body the rule does not fire on comes back byte-exact; after a decision this returns `None`.
    pub(crate) fn finish(&mut self) -> Option<Bytes> {
        let held = self.held.take()?;
        if held.is_empty() {
            return None;
        }
        self.decide(Bytes::from(held))
    }

    /// Leading bytes the decision dropped — 0 until decided, and for a body that was not disguised.
    pub(crate) fn stripped(&self) -> usize {
        self.stripped
    }

    fn decide(&mut self, head: Bytes) -> Option<Bytes> {
        self.stripped = disguise_prefix_len(&head).unwrap_or(0);
        let rest = head.slice(self.stripped..);
        (!rest.is_empty()).then_some(rest)
    }
}

/// Test fixture shared by every module that has to prove a disguised segment is handled: the EXACT 42-byte
/// wrapper of the live capture (xxd of a real zlive ABC segment) around `ts` —
/// `RIFF <len-8> WEBP | VP8L 13 <1×1 lossless image> <pad> | EXIF <ts.len()> | ts`.
///
/// One definition on purpose: the layout is a measurement, and a second hand-typed copy is a second chance
/// to test against a wrapper that never existed.
#[cfg(test)]
pub(crate) fn webp_disguise(ts: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(ts.len() + 42);
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&((ts.len() + 42 - 8) as u32).to_le_bytes());
    v.extend_from_slice(b"WEBP");
    v.extend_from_slice(b"VP8L");
    v.extend_from_slice(&13u32.to_le_bytes());
    v.extend_from_slice(&[0x2f, 0x00, 0x00, 0x00, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07]);
    v.push(0x00); // RIFF pads the odd-sized VP8L payload to an even length
    v.extend_from_slice(b"EXIF");
    v.extend_from_slice(&(ts.len() as u32).to_le_bytes());
    v.extend_from_slice(ts);
    v
}

/// Test-only: a judgeable segment whose program DECLARES H.264 but whose video carries no parameter sets —
/// `inspect_segment`'s `NoVideoParameterSets`, the shape the undecodable watch retires an upstream for. Shared
/// with the origin's end-to-end tests so they strike on exactly the bytes this module's verdict tests judge.
#[cfg(test)]
pub(crate) fn undecodable_segment() -> Vec<u8> {
    tests::undecodable()
}

/// Test-only: a segment that opens mid-GOP — P pictures flagged random-access, audio interleaved, the first IDR
/// several pictures in — with the offset where that keyframe's PES opens. The shape `trim_to_keyframe` exists
/// for, shared with the origin's end-to-end join test so both judge the same bytes.
#[cfg(test)]
pub(crate) fn mid_gop_segment() -> (Vec<u8>, usize) {
    tests::mid_gop()
}

/// Test-only: `seconds` of a bare transport-stream socket as a tuner would send it — PAT, PMT, then one
/// random-access video packet carrying its PCR per second — which a `TsSegmenter` cuts at its target. Shared with
/// the origin's end-to-end tests of the raw-TS ingest, which serve it as an entry that is a socket, not a playlist.
#[cfg(test)]
pub(crate) fn tuner_ts(seconds: u64) -> Vec<u8> {
    tests::tuner(seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build one TS packet. `pcr`/`rai` add an adaptation field; `payload` is appended after it.
    fn pkt(pid: u16, pusi: bool, rai: bool, pcr: Option<u64>, payload: &[u8]) -> Vec<u8> {
        let mut p = vec![0xFFu8; PKT];
        p[0] = SYNC;
        p[1] = ((pid >> 8) as u8 & 0x1F) | if pusi { 0x40 } else { 0 };
        p[2] = (pid & 0xFF) as u8;
        let need_af = rai || pcr.is_some();
        if need_af {
            p[3] = 0x30; // adaptation + payload
            let af_len = if pcr.is_some() { 7 } else { 1 };
            p[4] = af_len as u8;
            p[5] = (if rai { 0x40 } else { 0 }) | (if pcr.is_some() { 0x10 } else { 0 });
            if let Some(v) = pcr {
                p[6] = (v >> 25) as u8;
                p[7] = (v >> 17) as u8;
                p[8] = (v >> 9) as u8;
                p[9] = (v >> 1) as u8;
                p[10] = ((v & 1) << 7) as u8;
                p[11] = 0;
            }
            let start = 5 + af_len;
            for (k, b) in payload.iter().enumerate() {
                if start + k < PKT {
                    p[start + k] = *b;
                }
            }
        } else {
            p[3] = 0x10; // payload only
            for (k, b) in payload.iter().enumerate() {
                if 4 + k < PKT {
                    p[4 + k] = *b;
                }
            }
        }
        p
    }

    /// A PAT announcing program 1 → PMT on `pmt_pid`.
    fn pat(pmt_pid: u16) -> Vec<u8> {
        let mut sec = vec![
            0x00, // table_id
            0xB0, 0x0D, // section_syntax + length 13
            0x00, 0x01, 0xC1, 0x00, 0x00, // header
            0x00, 0x01, // program 1
            (0xE0 | (pmt_pid >> 8) as u8),
            (pmt_pid & 0xFF) as u8,
            0, 0, 0, 0, // CRC
        ];
        sec.insert(0, 0x00); // pointer_field
        pkt(0, true, false, None, &sec)
    }

    /// A PMT declaring H.264 video on `video_pid`.
    fn pmt(pmt_pid: u16, video_pid: u16) -> Vec<u8> {
        let mut sec = vec![
            0x02, // table_id
            0xB0, 0x12, // length 18 = program(2)+ver(1)+sec(1)+last(1)+PCR_PID(2)+prog_info_len(2)+entry(5)+CRC(4)
            0x00, 0x01, 0xC1, 0x00, 0x00, // header
            0xE0, 0x64, // PCR PID
            0xF0, 0x00, // program_info_length 0
            0x1B, // H.264
            (0xE0 | (video_pid >> 8) as u8),
            (video_pid & 0xFF) as u8,
            0xF0, 0x00, // ES_info_length 0
            0, 0, 0, 0, // CRC
        ];
        sec.insert(0, 0x00);
        pkt(pmt_pid, true, false, None, &sec)
    }

    const VPID: u16 = 0x100;
    const PMTPID: u16 = 0x1000;
    const SEC: u64 = 90_000; // one second of PCR base

    /// See `tuner_ts`: the program tables, then one RAI video packet with its PCR per second, `seconds` + 1 of them.
    pub(super) fn tuner(seconds: u64) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend(pat(PMTPID));
        v.extend(pmt(PMTPID, VPID));
        for s in 0..=seconds {
            v.extend(pkt(VPID, true, true, Some(s * SEC), &[0x11; 8]));
        }
        v
    }

    /// An AUDIO-ONLY program — the shape a dlhd provider hands out when it serves `tracks-a1/mono.m3u8`
    /// instead of `tracks-v1a1`. Legitimately has no video pid, so no parameter sets exist to find.
    fn audio_only_pmt(pmt_pid: u16, apid: u16) -> Vec<u8> {
        let mut sec = vec![
            0x02, 0xB0, 0x12, 0x00, 0x01, 0xC1, 0x00, 0x00,
            (0xE0 | (apid >> 8) as u8), (apid & 0xFF) as u8, // PCR on the audio pid
            0xF0, 0x00,
            0x0F, (0xE0 | (apid >> 8) as u8), (apid & 0xFF) as u8, 0xF0, 0x00, // AAC
            0, 0, 0, 0,
        ];
        sec.insert(0, 0x00);
        pkt(pmt_pid, true, false, None, &sec)
    }

    /// The S3/UND rule needs BOTH halves, and this is the half that was missing: a program with NO video
    /// declared must not read as "undecodable video". It cost a live false positive — dlhd channel 521 drew
    /// an audio-only master, struck out three times, and the whole channel was declined off the origin path.
    #[test]
    fn an_audio_only_program_is_not_evidence_of_undecodable_video() {
        let mut s = Vec::new();
        s.extend(pat(PMTPID));
        s.extend(audio_only_pmt(PMTPID, 0x101));
        let p = scan_profile(&s).expect("a PMT is present, so the profile parses");
        assert!(p.video_params.is_none(), "no video pid ⇒ nothing to extract parameter sets from");
        assert!(
            !p.streams.iter().any(|&(_, t)| is_video_stream_type(t)),
            "…and crucially NO video is declared, which is what must veto the strike"
        );
    }

    /// The other half, unchanged: video IS declared and carries no parameter sets — the real fault
    /// (dlhd Boomerang via Player 4, `non-existing PPS 0 referenced` / `no frame!`).
    #[test]
    fn a_declared_video_with_no_parameter_sets_is_the_undecodable_shape() {
        let mut s = Vec::new();
        s.extend(pat(PMTPID));
        s.extend(pmt(PMTPID, VPID));
        // A video PES with slice data but NO SPS/PPS — exactly what a decoder cannot configure itself from.
        let mut payload = vec![0x00, 0x00, 0x01, 0xE0, 0x00, 0x00, 0x80, 0x00, 0x00];
        payload.extend_from_slice(&[0x00, 0x00, 0x01, 0x61, 0x9A, 0x21, 0x0C]); // non-IDR slice only
        s.extend(pkt(VPID, true, true, None, &payload));
        let p = scan_profile(&s).expect("profile parses");
        assert!(p.video_params.is_none(), "no SPS/PPS anywhere in the video ES");
        assert!(
            p.streams.iter().any(|&(_, t)| is_video_stream_type(t)),
            "video IS declared — both halves true, so this is a genuine strike"
        );
    }

    /// …and a healthy segment must satisfy neither half, so it can never strike.
    #[test]
    fn a_healthy_segment_carries_parameter_sets_and_never_strikes() {
        let p = scan_profile(&segment_with(VPID, 0x1F)).expect("profile parses");
        assert!(p.video_params.is_some(), "SPS+PPS found ⇒ no strike regardless of the declaration");
    }

    // ── S3/UND: the verdict layer ────────────────────────────────────────────────────────────────────────

    /// Pad a segment out past `TS_MIN_JUDGEABLE` with null packets so `inspect_segment` will judge it at all.
    fn judgeable(mut s: Vec<u8>) -> Vec<u8> {
        while s.len() < TS_MIN_JUDGEABLE + PKT {
            s.extend(pkt(0x1FFF, false, false, None, &[0xFF; 8]));
        }
        s
    }

    #[test]
    fn a_healthy_segment_is_not_suspect() {
        assert_eq!(inspect_segment(&judgeable(segment_with(VPID, 0x1F))), None);
    }

    /// THE FALSE POSITIVE, pinned. An audio-only program (dlhd ch 521's `tracks-a1` draw) has no video pid
    /// and therefore no parameter sets — innocent, and must never be read as undecodable video.
    #[test]
    fn an_audio_only_program_is_never_suspect() {
        let mut s = Vec::new();
        s.extend(pat(PMTPID));
        s.extend(audio_only_pmt(PMTPID, 0x101));
        assert_eq!(inspect_segment(&judgeable(s)), None, "no video declared ⇒ no verdict, ever");
    }

    /// The true positive: video declared, no parameter sets anywhere in its ES.
    /// Declared H.264, a non-IDR slice, no SPS/PPS anywhere — padded until `inspect_segment` will judge it.
    pub(super) fn undecodable() -> Vec<u8> {
        let mut s = Vec::new();
        s.extend(pat(PMTPID));
        s.extend(pmt(PMTPID, VPID));
        let mut payload = vec![0x00, 0x00, 0x01, 0xE0, 0x00, 0x00, 0x80, 0x00, 0x00];
        payload.extend_from_slice(&[0x00, 0x00, 0x01, 0x61, 0x9A, 0x21, 0x0C]); // non-IDR slice only
        s.extend(pkt(VPID, true, true, None, &payload));
        judgeable(s)
    }

    #[test]
    fn declared_video_with_no_parameter_sets_is_suspect() {
        assert_eq!(inspect_segment(&undecodable()), Some(Suspect::NoVideoParameterSets));
    }

    #[test]
    fn a_body_that_is_not_a_transport_stream_is_suspect() {
        // What a provider actually serves when it breaks: an error page where media should be.
        let html = b"<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body>\
                     <h1>Forbidden</h1><p>Access denied.</p></body></html>";
        let mut body = Vec::new();
        while body.len() < TS_MIN_JUDGEABLE + 512 {
            body.extend_from_slice(html);
        }
        assert_eq!(inspect_segment(&body), Some(Suspect::NotTransportStream));
    }

    /// Sync bytes, never the file name. dlhd and pluto both serve valid TS from `.png`-named objects on
    /// object storage — judging by extension would condemn perfectly good media.
    #[test]
    fn valid_ts_is_judged_by_sync_bytes_not_by_looking_like_media() {
        let s = judgeable(segment_with(VPID, 0x1F));
        assert!(looks_like_transport_stream(&s));
        assert_eq!(inspect_segment(&s), None, "content decides, and this content is a transport stream");
    }

    #[test]
    fn a_short_body_is_unverifiable_rather_than_broken() {
        // A truncated fetch must not retire a provider — the ingest's own retry is the right response.
        assert_eq!(inspect_segment(b"\x47\x40\x00\x10short"), None);
        assert_eq!(inspect_segment(&[]), None);
    }

    #[test]
    fn a_stray_sync_byte_run_does_not_pass_for_a_transport_stream() {
        // `find_sync` corroborates with ONE follow-up, which is too weak to judge a whole body; the verdict
        // layer demands TS_SYNC_PROOF strides so random payload cannot fake it.
        let mut body = vec![0u8; TS_MIN_JUDGEABLE + PKT];
        body[10] = SYNC;
        body[10 + PKT] = SYNC; // exactly the pair find_sync accepts…
        assert!(find_sync(&body).is_some(), "…so the locator is satisfied");
        assert!(!looks_like_transport_stream(&body), "…but the verdict layer is not");
    }

    #[test]
    fn every_suspect_reason_has_a_distinct_slug_and_phrase() {
        // The slug reaches the burn record and the phrase reaches the operator; a collision would make two
        // different faults indistinguishable in both places.
        let all = [Suspect::NotTransportStream, Suspect::NoVideoParameterSets];
        for (i, a) in all.iter().enumerate() {
            for b in &all[i + 1..] {
                assert_ne!(a.slug(), b.slug());
                assert_ne!(a.describe(), b.describe());
            }
            assert!(!a.slug().is_empty() && !a.describe().is_empty());
        }
    }

    #[test]
    fn parses_pat_and_pmt_to_the_video_pid() {
        assert_eq!(parse_pat(&pat(PMTPID)), Some(PMTPID));
        assert_eq!(parse_pmt_video_pid(&pmt(PMTPID, VPID)), Some(VPID));
    }

    // ── S3/CUE: the splice-boundary fingerprint ──────────────────────────────────────────────────────────

    /// A video PES packet carrying Annex-B NALs: SPS (0x67) + PPS (0x68) + an IDR slice (0x65).
    fn video_pes(sps_tail: u8) -> Vec<u8> {
        let mut es = vec![0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x28, sps_tail];
        es.extend_from_slice(&[0x00, 0x00, 0x01, 0x68, 0xEE, 0x3C, 0xB0]);
        es.extend_from_slice(&[0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00]);
        // PES: start code + stream_id 0xE0 (video), unbounded length, no optional fields.
        let mut payload = vec![0x00, 0x00, 0x01, 0xE0, 0x00, 0x00, 0x80, 0x00, 0x00];
        payload.extend_from_slice(&es);
        pkt(VPID, true, true, None, &payload)
    }

    fn segment_with(video_pid: u16, sps_tail: u8) -> Vec<u8> {
        let mut s = Vec::new();
        s.extend(pat(PMTPID));
        s.extend(pmt(PMTPID, video_pid));
        s.extend(video_pes(sps_tail));
        s
    }

    #[test]
    fn scan_profile_reads_the_pmt_and_hashes_the_parameter_sets() {
        let p = scan_profile(&segment_with(VPID, 0x1F)).expect("a segment with a PMT fingerprints");
        assert_eq!(p.pcr_pid, 0x64, "PCR_PID comes from PMT bytes 8-9");
        assert_eq!(p.streams, vec![(VPID, 0x1Bu8)], "one H.264 elementary stream");
        assert!(p.video_params.is_some(), "SPS+PPS were found behind the PES header");
    }

    #[test]
    fn an_identical_encode_is_compatible_and_a_changed_sps_is_not() {
        let a = scan_profile(&segment_with(VPID, 0x1F)).unwrap();
        let same = scan_profile(&segment_with(VPID, 0x1F)).unwrap();
        assert!(a.compatible_with(&same), "byte-identical parameter sets ⇒ no decoder reconfiguration");

        // One SPS byte differing stands in for the real case: pluto's ads are 720p against 1080p program, and
        // a resolution change lives entirely inside the SPS. No timestamp rewrite can hide this.
        let changed = scan_profile(&segment_with(VPID, 0x20)).unwrap();
        assert!(!a.compatible_with(&changed), "a different SPS must read as a parameter change");
    }

    #[test]
    fn a_pid_remap_is_a_parameter_change_even_with_the_same_encode() {
        let a = scan_profile(&segment_with(VPID, 0x1F)).unwrap();
        let remapped = scan_profile(&segment_with(0x200, 0x1F)).unwrap();
        assert!(!a.compatible_with(&remapped), "the demuxer's PID map changed under the decoder");
    }

    #[test]
    fn unverifiable_segments_never_report_compatible() {
        // No PMT at all ⇒ no fingerprint ⇒ callers must treat the splice as load-bearing.
        assert_eq!(scan_profile(&video_pes(0x1F)), None);
        // A PMT but no parameter sets ⇒ a fingerprint that can never match anything, including itself.
        let mut no_params = Vec::new();
        no_params.extend(pat(PMTPID));
        no_params.extend(pmt(PMTPID, VPID));
        let p = scan_profile(&no_params).unwrap();
        assert_eq!(p.video_params, None);
        assert!(!p.compatible_with(&p), "an unverified profile is never declared compatible");
    }

    // ── KEY: keyframe-true joins ─────────────────────────────────────────────────────────────────────────

    const APID: u16 = 0x101;
    /// One picture at 25 fps, in 90 kHz ticks.
    const FRAME: u64 = 3600;
    /// The PES header `pes_on` writes: start code, stream id, length, flags, a 5-byte PTS.
    const PES_HDR: usize = 14;

    /// A PMT declaring `streams` as `(stream_type, pid)`, with the PCR on the first of them.
    fn pmt_of(pmt_pid: u16, streams: &[(u8, u16)]) -> Vec<u8> {
        let pcr = streams[0].1;
        let mut body = vec![0x00, 0x01, 0xC1, 0x00, 0x00, 0xE0 | (pcr >> 8) as u8, pcr as u8, 0xF0, 0x00];
        for &(t, pid) in streams {
            body.extend_from_slice(&[t, 0xE0 | (pid >> 8) as u8, pid as u8, 0xF0, 0x00]);
        }
        let len = body.len() + 4; // + CRC
        let mut sec = vec![0x00, 0x02, 0xB0 | (len >> 8) as u8, len as u8]; // pointer_field, table_id, length
        sec.extend(body);
        sec.extend([0, 0, 0, 0]);
        pkt(pmt_pid, true, false, None, &sec)
    }

    /// One PES on `pid` carrying `es` stamped `pts`, spread over as many packets as it takes: the first opens it —
    /// with RAI when `rai`, the way the live capture flags EVERY picture — and the rest continue it.
    fn pes_on(pid: u16, stream_id: u8, es: &[u8], rai: bool, pts: u64) -> Vec<u8> {
        let mut data = vec![0x00, 0x00, 0x01, stream_id, 0x00, 0x00, 0x80, 0x80, 0x05];
        data.extend_from_slice(&[
            0x21 | (((pts >> 30) as u8 & 0x07) << 1),
            (pts >> 22) as u8,
            (((pts >> 15) as u8 & 0x7F) << 1) | 1,
            (pts >> 7) as u8,
            (((pts as u8) & 0x7F) << 1) | 1,
        ]);
        data.extend_from_slice(es);
        let mut out = Vec::new();
        let mut rest = &data[..];
        let mut first = true;
        while first || !rest.is_empty() {
            let af = first && rai;
            let n = rest.len().min(if af { PKT - 6 } else { PKT - 4 });
            out.extend(pkt(pid, first, af, None, &rest[..n]));
            rest = &rest[n..];
            first = false;
        }
        out
    }

    /// A P picture, Annex-B: an access unit delimiter, then a non-IDR slice (NAL type 1).
    fn h264_p() -> Vec<u8> {
        [&[0, 0, 0, 1, 0x09, 0x30][..], &[0, 0, 0, 1, 0x41, 0x9A, 0x02, 0x03]].concat()
    }

    /// An IDR picture in the live capture's exact NAL order: SPS, PPS, AUD, SEI, then the IDR slice (type 5).
    fn h264_idr() -> Vec<u8> {
        [
            &[0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xAC][..],
            &[0, 0, 0, 1, 0x68, 0xEE, 0x3C, 0xB0],
            &[0, 0, 0, 1, 0x09, 0x10],
            &[0, 0, 1, 0x06, 0x05, 0x01, 0xAA, 0x80],
            &[0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x33],
        ]
        .concat()
    }

    /// An ADTS frame that carries, as a decoy, the bytes of an H.264 IDR start code. Only the VIDEO pid's
    /// elementary stream may be read for keyframes.
    fn adts_with_a_decoy() -> Vec<u8> {
        vec![0xFF, 0xF1, 0x50, 0x80, 0x02, 0x1F, 0xFC, 0x00, 0x00, 0x01, 0x65, 0x21]
    }

    /// The live shape: a segment that opens mid-GOP, on P pictures each flagged random-access, with audio
    /// interleaved and the first keyframe several pictures in. Returns it with the offset where the keyframe's PES
    /// opens. Shared with the origin's end-to-end test through `mid_gop_segment`.
    pub(super) fn mid_gop() -> (Vec<u8>, usize) {
        let mut s = Vec::new();
        s.extend(pat(PMTPID));
        s.extend(pmt_of(PMTPID, &[(0x1B, VPID), (0x0F, APID)]));
        let mut t = 900_000;
        for _ in 0..3 {
            s.extend(pes_on(VPID, 0xE0, &h264_p(), true, t));
            s.extend(pes_on(APID, 0xC0, &adts_with_a_decoy(), false, t));
            t += FRAME;
        }
        let cut = s.len();
        s.extend(pes_on(VPID, 0xE0, &[h264_idr(), vec![0x5A; 400]].concat(), true, t)); // spans three packets
        s.extend(pes_on(APID, 0xC0, &adts_with_a_decoy(), false, t));
        s.extend(pes_on(VPID, 0xE0, &h264_p(), true, t + FRAME));
        (s, cut)
    }

    /// PAT, PMT (video only), then `pictures` in order, one PES each, all flagged RAI.
    fn video_only(pictures: &[Vec<u8>]) -> Vec<u8> {
        let mut s = Vec::new();
        s.extend(pat(PMTPID));
        s.extend(pmt(PMTPID, VPID));
        for (k, p) in pictures.iter().enumerate() {
            s.extend(pes_on(VPID, 0xE0, p, true, 900_000 + k as u64 * FRAME));
        }
        s
    }

    /// THE LIVE CASE. The join keeps the program tables, drops everything in front of the keyframe's PES — the
    /// audio with it, so both start together — and from there on is the segment byte for byte.
    #[test]
    fn a_mid_gop_segment_is_joined_at_its_first_keyframe_behind_its_program_tables() {
        let (seg, cut) = mid_gop();
        let out = trim_to_keyframe(&seg).expect("pictures in front of the keyframe ⇒ something to trim");
        assert_eq!(&out[..PKT], &pat(PMTPID)[..], "the PAT first");
        assert_eq!(&out[PKT..2 * PKT], &pmt_of(PMTPID, &[(0x1B, VPID), (0x0F, APID)])[..], "then the PMT");
        assert_eq!(&out[2 * PKT..], &seg[cut..], "then the segment from the keyframe's PES on, untouched");
        assert_eq!(first_keyframe(&out), Some((2 * PKT, PMTPID)), "…so what goes out opens on its keyframe");
    }

    /// The flags lie; the pictures do not. RAI sits on every PES, keyframe or not — the capture does exactly this
    /// — so the first RAI is NOT the join. The first IDR is.
    #[test]
    fn a_random_access_flag_alone_is_never_taken_for_a_keyframe() {
        let (seg, cut) = mid_gop();
        assert!(adaptation_info(&seg[2 * PKT..3 * PKT]).0, "precondition: the opening P picture is flagged RAI");
        assert_eq!(first_keyframe(&seg).map(|(at, _)| at), Some(cut));
    }

    /// Idempotent: a segment that already opens on its keyframe (tables aside) is left whole — which is every
    /// segment of every source that keeps the usual convention, so a join there costs nothing.
    #[test]
    fn a_segment_that_already_opens_on_its_keyframe_is_left_whole() {
        let once = trim_to_keyframe(&mid_gop().0).unwrap();
        assert_eq!(trim_to_keyframe(&once), None);
        assert_eq!(trim_to_keyframe(&segment_with(VPID, 0x1F)), None, "PAT, PMT, then an IDR");
    }

    /// No keyframe to be found ⇒ sent whole. An open-GOP encoder may never send an IDR at all, and holding the
    /// stream back for one would be a blank screen forever.
    #[test]
    fn a_segment_without_a_keyframe_is_sent_whole_never_held_back() {
        assert_eq!(trim_to_keyframe(&video_only(&[h264_p(), h264_p(), h264_p()])), None);
    }

    /// A start code is 3–4 bytes and a packet payload 184, so sooner or later one straddles two packets. The
    /// scan carries its window across the boundary, and the keyframe is still found.
    #[test]
    fn a_start_code_split_across_two_packets_is_still_found() {
        // A RAI-flagged PES's first packet carries 188 − 4 (header) − 2 (adaptation field) − PES_HDR bytes of ES.
        // End them on `00 00`; the `01 65` of an IDR slice opens the next packet.
        let mut idr = vec![0x5A; PKT - 6 - PES_HDR - 2];
        idr.extend_from_slice(&[0x00, 0x00, 0x01, 0x65, 0x88, 0x84]);
        let s = video_only(&[h264_p(), idr]);
        let cut = 2 * PKT + pes_on(VPID, 0xE0, &h264_p(), true, 0).len();
        assert_eq!(&s[cut + PKT - 2..cut + PKT], &[0x00, 0x00], "precondition: the start code straddles");
        assert_eq!(s[cut + PKT + 4], 0x01, "…and completes in the next packet");
        assert_eq!(first_keyframe(&s).map(|(at, _)| at), Some(cut));
    }

    /// A keyframe inside a PES whose head the segment boundary cut off offers no PES start to cut on, so the scan
    /// passes it over for the next keyframe that opens a PES of its own.
    #[test]
    fn a_keyframe_whose_pes_head_was_cut_off_is_passed_over_for_the_next() {
        let mut s = Vec::new();
        s.extend(pat(PMTPID));
        s.extend(pmt(PMTPID, VPID));
        s.extend(pkt(VPID, false, false, None, &[0x00, 0x00, 0x01, 0x65, 0x88])); // a continuation, IDR bytes in it
        s.extend(pes_on(VPID, 0xE0, &h264_p(), true, 0));
        let cut = s.len();
        s.extend(pes_on(VPID, 0xE0, &h264_idr(), true, FRAME));
        assert_eq!(first_keyframe(&s).map(|(at, _)| at), Some(cut));
    }

    /// Uncapped, unlike `scan_profile`: the captured segment's keyframe sat 915 KB in, and a scan that stopped at
    /// 96 KiB would have called it absent and sent the segment whole.
    #[test]
    fn a_keyframe_past_the_parameter_scan_cap_is_still_found() {
        let mut pictures = Vec::new();
        while pictures.len() * 2000 < 4 * PARAM_SCAN_CAP {
            pictures.push([h264_p(), vec![0x5A; 2000]].concat());
        }
        pictures.push(h264_idr());
        let s = video_only(&pictures);
        assert_eq!(scan_profile(&s).unwrap().video_params, None, "precondition: the capped scan never gets there");
        let out = trim_to_keyframe(&s).expect("found anyway");
        let idr_pes = pes_on(VPID, 0xE0, &h264_idr(), true, 0).len();
        assert_eq!(out.len(), 2 * PKT + idr_pes, "the tables, then the keyframe's PES and nothing before it");
    }

    /// HEVC reads its NAL type from bits 6..1 and can start cold at any IRAP picture — a CRA included.
    #[test]
    fn an_hevc_segment_is_joined_at_its_first_irap_picture() {
        let trail = [0, 0, 0, 1, 0x02, 0x01, 0xD0]; // TRAIL_R (1)
        let cra = [0, 0, 0, 1, 0x2A, 0x01, 0xAF]; // CRA_NUT (21)
        let mut s = Vec::new();
        s.extend(pat(PMTPID));
        s.extend(pmt_of(PMTPID, &[(0x24, VPID)]));
        s.extend(pes_on(VPID, 0xE0, &trail, true, 0));
        let cut = s.len();
        s.extend(pes_on(VPID, 0xE0, &cra, true, FRAME));
        assert_eq!(first_keyframe(&s).map(|(at, _)| at), Some(cut));
        // The grammar matters: the same header byte read as H.264 is type 10 (end of sequence), no keyframe.
        assert!(!is_keyframe_nal(nal_type(0x2A, false), false));
    }

    /// Nothing to join at: an audio-only program, and video in a grammar this does not read (MPEG-2), whose
    /// bytes are no H.264 NAL whatever they look like.
    #[test]
    fn a_program_without_h264_or_hevc_video_is_never_trimmed() {
        let mut audio = Vec::new();
        audio.extend(pat(PMTPID));
        audio.extend(audio_only_pmt(PMTPID, APID));
        audio.extend(pes_on(APID, 0xC0, &adts_with_a_decoy(), false, 0));
        assert_eq!(trim_to_keyframe(&audio), None);

        let mut mpeg2 = Vec::new();
        mpeg2.extend(pat(PMTPID));
        mpeg2.extend(pmt_of(PMTPID, &[(0x02, VPID)]));
        mpeg2.extend(pes_on(VPID, 0xE0, &h264_p(), true, 0));
        mpeg2.extend(pes_on(VPID, 0xE0, &h264_idr(), true, FRAME));
        assert_eq!(trim_to_keyframe(&mpeg2), None);
    }

    /// Table repeats in front of the keyframe are kept too, in order: each carries the next continuity counter,
    /// so dropping one would leave a gap on the table pids for any path that sends the join verbatim.
    #[test]
    fn every_table_packet_ahead_of_the_keyframe_is_kept_in_order() {
        let (pa, pm) = (pat(PMTPID), pmt(PMTPID, VPID));
        let mut s = Vec::new();
        s.extend(&pa);
        s.extend(&pm);
        s.extend(pes_on(VPID, 0xE0, &h264_p(), true, 0));
        s.extend(&pa);
        s.extend(&pm);
        s.extend(pes_on(VPID, 0xE0, &h264_p(), true, FRAME));
        let cut = s.len();
        s.extend(pes_on(VPID, 0xE0, &h264_idr(), true, 2 * FRAME));
        assert_eq!(trim_to_keyframe(&s), Some([&pa[..], &pm, &pa, &pm, &s[cut..]].concat()));
    }

    /// The splice normaliser runs on the join AFTER it is trimmed, so the trimmed segment must still be
    /// everything it asks for. It is, and what comes back still opens on the keyframe.
    #[test]
    fn a_trimmed_join_still_normalises_and_still_opens_on_its_keyframe() {
        let out = trim_to_keyframe(&mid_gop().0).unwrap();
        let normalised = crate::tsnorm::Splicer::new().normalize(&out).expect("PAT/PMT and stamps: it normalises");
        assert_eq!(normalised.len(), out.len(), "length-invariant, as ever");
        assert_eq!(first_keyframe(&normalised).map(|(at, _)| at), Some(2 * PKT));
    }

    #[test]
    fn reads_rai_and_pcr_from_the_adaptation_field() {
        let (rai, pcr) = adaptation_info(&pkt(VPID, false, true, Some(12_345), &[]));
        assert!(rai);
        assert_eq!(pcr, Some(12_345));
        // Payload-only packets carry neither.
        assert_eq!(adaptation_info(&pkt(VPID, false, false, None, &[1, 2, 3])), (false, None));
    }

    /// The core rule: cut at a random-access point, but only once the target duration is reached.
    #[test]
    fn cuts_at_a_random_access_point_after_the_target_duration() {
        let mut s = TsSegmenter::new(2.0);
        let mut stream = Vec::new();
        stream.extend(pat(PMTPID));
        stream.extend(pmt(PMTPID, VPID));
        // t=0 RAI (starts segment 1), t=1 RAI (too early — must NOT cut), t=2 RAI (cut), t=3 RAI (too early).
        for (t, rai) in [(0u64, true), (1, true), (2, true), (3, true)] {
            stream.extend(pkt(VPID, false, rai, Some(t * SEC), &[]));
        }
        let segs = s.push(&stream);
        assert_eq!(segs.len(), 1, "exactly one cut: the t=1 RAI is below target and must be skipped");
        assert!((segs[0].duration - 2.0).abs() < 0.01, "duration comes from PCR: {}", segs[0].duration);
    }

    /// Without this, a stream whose keyframes are rarer than the target would grow one segment forever.
    #[test]
    fn falls_back_to_a_hard_cap_when_random_access_never_arrives() {
        let mut s = TsSegmenter::new(1.0); // max = 3s
        let mut stream = Vec::new();
        stream.extend(pat(PMTPID));
        stream.extend(pmt(PMTPID, VPID));
        for t in 0..6u64 {
            stream.extend(pkt(VPID, false, false, Some(t * SEC), &[])); // never a RAI
        }
        let segs = s.push(&stream);
        assert!(!segs.is_empty(), "the overlong cap must still produce segments");
        assert!(segs[0].duration >= 3.0);
    }

    /// A cut before the PMT is known would start a segment no decoder can begin at.
    #[test]
    fn never_cuts_before_the_video_pid_is_known() {
        let mut s = TsSegmenter::new(0.5);
        let mut stream = Vec::new();
        for t in 0..5u64 {
            stream.extend(pkt(VPID, false, true, Some(t * SEC), &[])); // RAI, but no PAT/PMT yet
        }
        assert!(s.push(&stream).is_empty(), "no PSI ⇒ no cuts");
    }

    /// Socket chunk boundaries are arbitrary; a split packet must not corrupt the next one.
    #[test]
    fn carries_a_partial_packet_across_chunk_boundaries() {
        let mut whole = Vec::new();
        whole.extend(pat(PMTPID));
        whole.extend(pmt(PMTPID, VPID));
        for t in 0..4u64 {
            whole.extend(pkt(VPID, false, true, Some(t * SEC), &[]));
        }
        // Feed it in awkward slices that split packets mid-way.
        let mut split = TsSegmenter::new(2.0);
        let mut got = Vec::new();
        for c in whole.chunks(97) {
            got.extend(split.push(c));
        }
        let mut oneshot = TsSegmenter::new(2.0);
        let expect = oneshot.push(&whole);
        assert_eq!(got, expect, "chunking must not change the segmentation");
    }

    #[test]
    fn resyncs_when_the_stream_starts_mid_packet() {
        let mut stream = vec![0x11, 0x22, 0x33]; // junk before the first sync byte
        stream.extend(pat(PMTPID));
        stream.extend(pmt(PMTPID, VPID));
        for t in 0..4u64 {
            stream.extend(pkt(VPID, false, true, Some(t * SEC), &[]));
        }
        let mut s = TsSegmenter::new(2.0);
        let segs = s.push(&stream);
        assert_eq!(segs.len(), 1, "leading junk must be skipped, not treated as packet data");
        // Every produced segment must itself start on a sync byte, or a client cannot parse it.
        assert_eq!(segs[0].bytes[0], SYNC);
        assert_eq!(segs[0].bytes.len() % PKT, 0, "segments are whole packets");
    }

    /// A 33-bit PCR rollover must read as a small forward delta, not a ~26-hour negative jump.
    #[test]
    fn pcr_wraparound_does_not_produce_a_nonsense_duration() {
        let mut s = TsSegmenter::new(2.0);
        s.ready = true;
        s.video_pid = Some(VPID);
        s.seg_start_pcr = Some(PCR_WRAP - SEC); // 1s before the wrap
        s.last_pcr = Some(SEC); // 1s after it
        let d = s.elapsed().expect("both PCRs known");
        assert!((d - 2.0).abs() < 0.01, "expected ~2s across the wrap, got {d}");
    }

    #[test]
    fn finish_flushes_the_trailing_partial_segment() {
        let mut s = TsSegmenter::new(10.0); // target never reached
        let mut stream = Vec::new();
        stream.extend(pat(PMTPID));
        stream.extend(pmt(PMTPID, VPID));
        stream.extend(pkt(VPID, false, true, Some(0), &[]));
        stream.extend(pkt(VPID, false, false, Some(SEC), &[]));
        assert!(s.push(&stream).is_empty());
        let tail = s.finish().expect("buffered bytes must flush");
        assert!((tail.duration - 1.0).abs() < 0.01);
        assert_eq!(tail.bytes.len() % PKT, 0);
    }

    // ── DSG: disguised segments ──────────────────────────────────────────────────────────────────────────

    /// A real, judgeable transport stream to hide inside the fixtures.
    fn clean_ts() -> Vec<u8> {
        judgeable(segment_with(VPID, 0x1F))
    }

    /// `n` packets of null padding — a transport stream whose length the tests choose to the packet.
    fn null_ts(n: usize) -> Vec<u8> {
        (0..n).flat_map(|_| pkt(0x1FFF, false, false, None, &[])).collect()
    }

    /// Deterministic noise (an LCG) standing in for compressed media: dense, patternless, reproducible.
    fn noise(len: usize, seed: u32) -> Vec<u8> {
        let mut x = seed;
        (0..len)
            .map(|_| {
                x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (x >> 24) as u8
            })
            .collect()
    }

    /// The live shape: a RIFF/WEBP file whose EXIF payload is the whole transport stream, 42 bytes in. What
    /// comes out must be the stream EXACTLY — not merely "something that starts on a sync byte".
    #[test]
    fn a_riff_webp_disguised_segment_unwraps_to_exactly_its_transport_stream() {
        let ts = clean_ts();
        let body = webp_disguise(&ts);
        assert_eq!(&body[34..38], b"EXIF", "fixture sanity: the captured layout puts EXIF at 34");
        assert_eq!(disguise_prefix_len(&body), Some(42));
        assert_eq!(&body[42..], &ts[..], "the remainder is the stream, byte for byte");
        assert_eq!(inspect_segment(&body[42..]), None, "…and a healthy one");
        assert_eq!(disguise_label(&body), "riff-webp");
    }

    /// The veto. Every source that works today opens on a sync byte — dlhd's `.png` objects included — and
    /// must never lose a byte to this, even when its own proof would fail.
    #[test]
    fn a_body_that_already_starts_on_a_sync_byte_is_never_unwrapped() {
        assert_eq!(disguise_prefix_len(&clean_ts()), None);
        let mut damaged = clean_ts();
        damaged[PKT] = 0x00; // the second packet lost its sync: no proof from byte 0 any more
        assert_eq!(disguise_prefix_len(&damaged), None, "byte 0 decides, not the proof");
        assert_eq!(disguise_prefix_len(&[]), None);
    }

    /// The failure that made structure-first worth having. The wrapper's size fields are little-endian, so a
    /// 0x47 lands in one for ~0.45 % of segments, and a byte-wise resync frames a packet there. 97 packets puts
    /// one in BOTH size fields; the unwrap must still land on 42.
    #[test]
    fn a_sync_byte_inside_the_wrappers_size_fields_does_not_fool_the_unwrap() {
        let ts = null_ts(97); // 18 236 B = 0x473C, so the RIFF size is 0x475E
        let body = webp_disguise(&ts);
        assert_eq!((body[5], body[39]), (SYNC, SYNC), "fixture sanity: a 0x47 in each size field");
        assert_eq!(disguise_prefix_len(&body), Some(42));
        assert_eq!(&body[42..], &ts[..]);
    }

    /// The declared sizes outrank the scan. A packet damaged near the head would send a scan past it, dropping
    /// the good packets in front; the chunk table still says exactly where the stream starts.
    #[test]
    fn a_riff_disguise_is_read_from_its_declared_sizes_not_from_a_scan() {
        let mut ts = null_ts(10);
        ts[2 * PKT] = 0x00; // the third packet lost its sync
        assert_eq!(disguise_prefix_len(&webp_disguise(&ts)), Some(42), "not 42 + 3 packets, where a scan lands");
    }

    /// Structure is not a licence on its own: an EXIF payload that is not whole packets opening on a sync byte
    /// is metadata, not a stream.
    #[test]
    fn a_riff_exif_payload_that_is_not_a_transport_stream_is_not_taken() {
        let mut not_whole = vec![SYNC];
        not_whole.extend(noise(999, 7)); // opens on 0x47, but 1000 B is not whole packets
        assert_eq!(disguise_prefix_len(&webp_disguise(&not_whole)), None);
        let mut exif = b"Exif\0\0MM\0*".to_vec(); // a real EXIF block's opening, padded to whole "packets"
        exif.resize(PKT * 6, 0);
        assert_eq!(disguise_prefix_len(&webp_disguise(&exif)), None);
    }

    /// Everything else a flagged relay may carry. None of it carries a five-stride proof, and none of it may be
    /// touched.
    #[test]
    fn non_ts_media_is_never_unwrapped() {
        let mut fmp4 = vec![0, 0, 0, 0x18];
        fmp4.extend_from_slice(b"ftypiso6\0\0\0\0iso6mp41");
        fmp4.extend_from_slice(&[0, 0, 0x20, 0x08]);
        fmp4.extend_from_slice(b"moof");
        fmp4.extend(noise(8192, 1));
        let mut adts = Vec::new();
        for i in 0..40 {
            adts.extend_from_slice(&[0xFF, 0xF1, 0x50, 0x80, 0x1A, 0x1F, 0xFC]);
            adts.extend(noise(201, i));
        }
        let vtt = b"WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nGood evening.\n\n".repeat(120);
        let key = [0x8fu8, 0x2a, 0x00, 0xff, 0x13, 0x37, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06];
        let html = b"<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body>Forbidden</body></html>"
            .repeat(80);
        for (what, body) in [("fMP4", &fmp4[..]), ("ADTS", &adts[..]), ("WebVTT", &vtt[..]), ("AES key", &key[..]), ("HTML", &html[..])] {
            assert_eq!(disguise_prefix_len(body), None, "{what} must pass through untouched");
        }
    }

    /// M2TS puts a 4-byte arrival timestamp ahead of every packet, so its sync bytes stand 192 apart. It is a
    /// transport stream, but not one a 188-byte demuxer reads — so it is not ours to unwrap.
    #[test]
    fn a_192_byte_m2ts_stream_is_not_mistaken_for_a_disguised_188_byte_one() {
        let mut m2ts = Vec::new();
        for i in 0..40u32 {
            m2ts.extend_from_slice(&(i * 1000 + 1).to_be_bytes()); // TP_extra_header
            m2ts.extend(pkt(0x1FFF, false, false, None, &[]));
        }
        assert_ne!(m2ts[0], SYNC, "fixture sanity: the timestamp comes first");
        assert_eq!(disguise_prefix_len(&m2ts), None);
    }

    /// The scan is bounded: a stream may start anywhere in the first `MAX_DISGUISE_PREFIX` bytes and nowhere
    /// after. Past that it is not a wrapper, it is a different file.
    #[test]
    fn an_opaque_prefix_is_unwrapped_only_within_the_window() {
        let behind = |n: usize| {
            let mut b = vec![0u8; n];
            b.extend_from_slice(&null_ts(8));
            b
        };
        assert_eq!(disguise_prefix_len(&behind(MAX_DISGUISE_PREFIX)), Some(MAX_DISGUISE_PREFIX));
        assert_eq!(disguise_prefix_len(&behind(MAX_DISGUISE_PREFIX + 1)), None);
        assert_eq!(disguise_label(&behind(7)), "opaque-prefix");
    }

    /// A coincidental PAIR is exactly what `find_sync` accepts and what random payload produces. The unwrap
    /// demands the full proof, so it walks past the pair to where the stream really starts.
    #[test]
    fn a_stray_sync_pair_in_an_opaque_prefix_is_skipped_for_the_real_proof() {
        let mut body = vec![0u8; 600];
        body[10] = SYNC;
        body[10 + PKT] = SYNC;
        body.extend_from_slice(&null_ts(8));
        assert_eq!(disguise_prefix_len(&body), Some(600));
    }

    /// Proof or nothing: three packets behind an opaque prefix cannot show five strides, so the body is left
    /// exactly as it came.
    #[test]
    fn too_few_packets_behind_an_opaque_prefix_are_left_alone() {
        let mut body = vec![0u8; 42];
        body.extend_from_slice(&null_ts(3));
        assert_eq!(disguise_prefix_len(&body), None);
    }

    /// Feed `body` through a stripper in `n`-byte chunks and collect everything it forwards.
    fn stream_through(body: &[u8], n: usize) -> Vec<u8> {
        let mut s = DisguiseStripper::new();
        let mut out = Vec::new();
        for c in body.chunks(n) {
            if let Some(b) = s.push(Bytes::copy_from_slice(c)) {
                out.extend_from_slice(&b);
            }
        }
        if let Some(b) = s.finish() {
            out.extend_from_slice(&b);
        }
        out
    }

    /// Socket chunking is arbitrary, so it must not change the answer — the property the segmenter pins in
    /// `carries_a_partial_packet_across_chunk_boundaries`. Every shape, every awkward chunk size, including
    /// both sides of the judging window.
    #[test]
    fn the_streaming_unwrap_is_chunking_invariant() {
        let mut opaque = vec![0u8; 600];
        opaque.extend_from_slice(&null_ts(8));
        let bodies = [
            webp_disguise(&clean_ts()),
            webp_disguise(&null_ts(97)),
            opaque,
            clean_ts(),
            noise(20_000, 3),
            b"WEBVTT\n\n".to_vec(),
        ];
        for body in &bodies {
            let want = &body[disguise_prefix_len(body).unwrap_or(0)..];
            for n in [1, 7, 97, PKT, 1000, DISGUISE_HEAD_BYTES - 1, DISGUISE_HEAD_BYTES, 65_536] {
                assert_eq!(stream_through(body, n), want, "chunks of {n} changed the output");
            }
        }
    }

    /// A clean stream must not pay for the feature: decided by its first byte, forwarded at once, never copied.
    #[test]
    fn a_sync_first_body_streams_through_without_being_held_or_copied() {
        let ts = Bytes::from(clean_ts());
        let first = ts.slice(..100);
        let mut s = DisguiseStripper::new();
        let out = s.push(first.clone()).expect("forwarded immediately, not held");
        assert_eq!(out.as_ptr(), first.as_ptr(), "the very same buffer");
        assert_eq!(s.push(ts.slice(100..)).map(|b| b.len()), Some(ts.len() - 100));
        assert_eq!(s.finish(), None);
        assert_eq!(s.stripped(), 0);
    }

    /// A disguised head is held until it can be judged, released ONCE without its wrapper, and nothing after
    /// the decision is ever held again.
    #[test]
    fn a_disguised_head_is_held_until_it_can_be_judged() {
        let body = webp_disguise(&null_ts(40));
        let mut s = DisguiseStripper::new();
        assert!(s.push(Bytes::copy_from_slice(&body[..1000])).is_none(), "1000 B cannot be judged yet");
        let head = s.push(Bytes::copy_from_slice(&body[1000..DISGUISE_HEAD_BYTES])).expect("window full: decided");
        assert_eq!(s.stripped(), 42);
        assert_eq!(&head[..], &body[42..DISGUISE_HEAD_BYTES]);
        let tail = Bytes::copy_from_slice(&body[DISGUISE_HEAD_BYTES..]);
        assert_eq!(s.push(tail.clone()).map(|b| b.as_ptr()), Some(tail.as_ptr()), "pure pass-through after");
    }

    /// One upstream chunk that spans the whole window is decided on the spot and forwarded as a SLICE of the
    /// upstream buffer — the common case, since a CDN hands over far more than 5 KiB at a time.
    #[test]
    fn a_large_first_chunk_is_unwrapped_without_a_copy() {
        let body = Bytes::from(webp_disguise(&null_ts(40)));
        let mut s = DisguiseStripper::new();
        let out = s.push(body.clone()).expect("one chunk spans the window");
        assert_eq!(out.as_ptr(), body[42..].as_ptr(), "a slice of the upstream buffer, not a copy");
        assert_eq!(out.len(), body.len() - 42);
    }

    /// A body that ends inside the window is decided on what arrived. One the rule does not fire on — a 16-byte
    /// AES key — comes back byte-exact rather than swallowed; a short DISGUISED one still loses its wrapper.
    #[test]
    fn a_short_body_is_decided_on_finish() {
        let key = Bytes::from_static(&[0x8f, 0x2a, 0x00, 0xff, 0x13, 0x37, 0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6]);
        let mut s = DisguiseStripper::new();
        assert!(s.push(key.clone()).is_none());
        assert_eq!(s.finish(), Some(key));
        assert_eq!(s.finish(), None, "released once");

        let ts = null_ts(3);
        let mut s = DisguiseStripper::new();
        assert!(s.push(Bytes::from(webp_disguise(&ts))).is_none());
        assert_eq!(s.finish().as_deref(), Some(&ts[..]));
        assert_eq!(s.stripped(), 42);
    }
}

