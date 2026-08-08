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

/// Hash the video parameter-set NALs at the head of an access unit. `stream_type` picks the NAL grammar:
/// HEVC (0x24) puts the type in bits 6..1 of the first header byte, H.264 in the low 5 bits.
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
        let nal_type = if hevc { (es[head] >> 1) & 0x3F } else { es[head] & 0x1F };
        // H.264: SPS 7, PPS 8. HEVC: VPS 32, SPS 33, PPS 34.
        let wanted = if hevc { matches!(nal_type, 32..=34) } else { matches!(nal_type, 7 | 8) };
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
    let Some(start) = find_sync(bytes) else { return false };
    (0..TS_SYNC_PROOF).all(|k| bytes.get(start + k * PKT).is_some_and(|&b| b == SYNC))
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
    #[test]
    fn declared_video_with_no_parameter_sets_is_suspect() {
        let mut s = Vec::new();
        s.extend(pat(PMTPID));
        s.extend(pmt(PMTPID, VPID));
        let mut payload = vec![0x00, 0x00, 0x01, 0xE0, 0x00, 0x00, 0x80, 0x00, 0x00];
        payload.extend_from_slice(&[0x00, 0x00, 0x01, 0x61, 0x9A, 0x21, 0x0C]); // non-IDR slice only
        s.extend(pkt(VPID, true, true, None, &payload));
        assert_eq!(inspect_segment(&judgeable(s)), Some(Suspect::NoVideoParameterSets));
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

