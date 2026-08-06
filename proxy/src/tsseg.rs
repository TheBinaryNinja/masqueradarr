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

/// One TS packet. The format is fixed-size and self-framing, which is what makes this tractable.
const PKT: usize = 188;
const SYNC: u8 = 0x47;

/// PCR base ticks per second (the 90 kHz clock the 33-bit base counts in).
const PCR_HZ: f64 = 90_000.0;

/// The 33-bit PCR base wraps roughly every 26.5 hours; a wrap must read as "a bit later", not as a huge
/// negative jump that would produce a nonsense `#EXTINF`.
const PCR_WRAP: u64 = 1 << 33;

/// Stream types that carry video in a PMT. Anything else (audio, subtitles, data) is ignored for cutting —
/// a segment boundary is only meaningful at a VIDEO random-access point.
fn is_video_stream_type(t: u8) -> bool {
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
fn parse_pat(pkt: &[u8]) -> Option<u16> {
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
    let s = psi_payload(pkt)?;
    if s.len() < 12 || s[0] != 0x02 {
        return None; // table_id 0x02 = PMT
    }
    let section_len = (((s[1] & 0x0F) as usize) << 8) | s[2] as usize;
    let end = 3 + section_len;
    if end > s.len() || section_len < 13 {
        return None;
    }
    let program_info_len = (((s[10] & 0x0F) as usize) << 8) | s[11] as usize;
    let mut i = 12 + program_info_len;
    while i + 5 <= end - 4 {
        let stream_type = s[i];
        let pid = (((s[i + 1] & 0x1F) as u16) << 8) | s[i + 2] as u16;
        let es_info_len = (((s[i + 3] & 0x0F) as usize) << 8) | s[i + 4] as usize;
        if is_video_stream_type(stream_type) {
            return Some(pid);
        }
        i += 5 + es_info_len;
    }
    None
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

    #[test]
    fn parses_pat_and_pmt_to_the_video_pid() {
        assert_eq!(parse_pat(&pat(PMTPID)), Some(PMTPID));
        assert_eq!(parse_pmt_video_pid(&pmt(PMTPID, VPID)), Some(VPID));
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
}

