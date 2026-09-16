
use bytes::Bytes;

pub(crate) const PKT: usize = 188;
pub(crate) const SYNC: u8 = 0x47;

const PCR_HZ: f64 = 90_000.0;

const PCR_WRAP: u64 = 1 << 33;

pub(crate) fn is_video_stream_type(t: u8) -> bool {
    matches!(t, 0x01 | 0x02 | 0x10 | 0x1B | 0x24 | 0x42 | 0xD1 | 0xEA)
}

#[derive(Debug, Clone, PartialEq)]
pub struct CutSegment {
    pub bytes: Vec<u8>,
    pub duration: f64,
}

pub struct TsSegmenter {
    carry: Vec<u8>,
    cur: Vec<u8>,
    pmt_pid: Option<u16>,
    video_pid: Option<u16>,
    seg_start_pcr: Option<u64>,
    last_pcr: Option<u64>,
    target: f64,
    max_duration: f64,
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

    pub fn push(&mut self, chunk: &[u8]) -> Vec<CutSegment> {
        let mut out = Vec::new();
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(chunk);

        let mut i = match find_sync(&buf) {
            Some(i) => i,
            None => {
                let keep = buf.len().min(PKT * 2);
                self.carry = buf[buf.len() - keep..].to_vec();
                return out;
            }
        };

        while i + PKT <= buf.len() {
            let pkt = &buf[i..i + PKT];
            if pkt[0] != SYNC {
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
            self.seg_start_pcr = pcr.or(self.last_pcr);
        }
        self.cur.extend_from_slice(pkt);
    }

    fn elapsed(&self) -> Option<f64> {
        let (start, last) = (self.seg_start_pcr?, self.last_pcr?);
        let delta = last.wrapping_sub(start) & (PCR_WRAP - 1);
        Some(delta as f64 / PCR_HZ)
    }
}

fn find_sync(buf: &[u8]) -> Option<usize> {
    for i in 0..buf.len() {
        if buf[i] != SYNC {
            continue;
        }
        if i + PKT >= buf.len() {
            return if i + PKT <= buf.len() { Some(i) } else { None };
        }
        if buf[i + PKT] == SYNC {
            return Some(i);
        }
    }
    None
}

fn adaptation_info(pkt: &[u8]) -> (bool, Option<u64>) {
    let afc = (pkt[3] >> 4) & 0b11;
    if afc != 0b10 && afc != 0b11 {
        return (false, None);
    }
    let len = pkt[4] as usize;
    if len == 0 || 5 + len > PKT {
        return (false, None);
    }
    let flags = pkt[5];
    let rai = flags & 0x40 != 0;
    let mut pcr = None;
    if flags & 0x10 != 0 && len >= 7 {
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

fn psi_payload(pkt: &[u8]) -> Option<&[u8]> {
    let pusi = pkt[1] & 0x40 != 0;
    if !pusi {
        return None;
    }
    let afc = (pkt[3] >> 4) & 0b11;
    let mut off = 4;
    if afc == 0b10 || afc == 0b11 {
        let len = pkt[4] as usize;
        off = 5 + len;
    }
    if afc == 0b10 || off >= PKT {
        return None;
    }
    let pointer = pkt[off] as usize;
    let start = off + 1 + pointer;
    if start >= PKT {
        return None;
    }
    Some(&pkt[start..])
}

pub(crate) fn parse_pat(pkt: &[u8]) -> Option<u16> {
    let s = psi_payload(pkt)?;
    if s.len() < 8 || s[0] != 0x00 {
        return None;
    }
    let section_len = (((s[1] & 0x0F) as usize) << 8) | s[2] as usize;
    let end = 3 + section_len;
    if end > s.len() || section_len < 9 {
        return None;
    }
    let mut i = 8;
    while i + 4 <= end - 4 {
        let program = ((s[i] as u16) << 8) | s[i + 1] as u16;
        let pid = (((s[i + 2] & 0x1F) as u16) << 8) | s[i + 3] as u16;
        if program != 0 {
            return Some(pid);
        }
        i += 4;
    }
    None
}

fn parse_pmt_video_pid(pkt: &[u8]) -> Option<u16> {
    parse_pmt(pkt).and_then(|m| m.video_pid())
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PmtInfo {
    pub pcr_pid: u16,
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
        return None;
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

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct StreamProfile {
    pub pcr_pid: u16,
    pub streams: Vec<(u16, u8)>,
    pub video_params: Option<u64>,
}

impl StreamProfile {
    pub fn compatible_with(&self, next: &StreamProfile) -> bool {
        self.pcr_pid == next.pcr_pid
            && self.streams == next.streams
            && self.video_params.is_some()
            && self.video_params == next.video_params
    }
}

pub(crate) fn scan_profile(bytes: &[u8]) -> Option<StreamProfile> {
    let mut pmt_pid: Option<u16> = None;
    let mut pmt: Option<PmtInfo> = None;
    let mut video_pid: Option<u16> = None;
    let mut es: Vec<u8> = Vec::new();

    let mut i = 0usize;
    while i + PKT <= bytes.len() {
        if bytes[i] != SYNC {
            i += 1;
            continue;
        }
        let pkt = &bytes[i..i + PKT];
        i += PKT;
        let pid = (((pkt[1] & 0x1F) as u16) << 8) | pkt[2] as u16;
        if pid == 0x1FFF || pkt[1] & 0x80 != 0 {
            continue;
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

fn es_payload(pkt: &[u8]) -> Option<&[u8]> {
    let afc = (pkt[3] >> 4) & 0b11;
    let mut off = 4;
    if afc == 0b10 || afc == 0b11 {
        let len = pkt[4] as usize;
        off = 5 + len;
    }
    if afc == 0b10 || off >= PKT {
        return None;
    }
    let payload = &pkt[off..];
    if pkt[1] & 0x40 == 0 {
        return Some(payload);
    }
    if payload.len() < 9 || payload[0..3] != [0x00, 0x00, 0x01] {
        return Some(payload);
    }
    let hdr = 9 + payload[8] as usize;
    payload.get(hdr..)
}

fn nal_type(header: u8, hevc: bool) -> u8 {
    if hevc {
        (header >> 1) & 0x3F
    } else {
        header & 0x1F
    }
}

fn parameter_sets(es: &[u8], stream_type: u8) -> Option<u64> {
    let hevc = stream_type == 0x24;
    let mut found: Vec<u8> = Vec::new();
    let mut count = 0;
    let mut i = 0usize;
    while i + 4 < es.len() {
        if es[i] != 0 || es[i + 1] != 0 || es[i + 2] != 1 {
            i += 1;
            continue;
        }
        let head = i + 3;
        let t = nal_type(es[head], hevc);
        let wanted = if hevc { matches!(t, 32..=34) } else { matches!(t, 7 | 8) };
        if wanted {
            let mut j = head;
            while j + 3 <= es.len() && !(es[j] == 0 && es[j + 1] == 0 && es[j + 2] == 1) {
                j += 1;
            }
            found.extend_from_slice(&es[head..j.min(es.len())]);
            count += 1;
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


fn is_keyframe_nal(t: u8, hevc: bool) -> bool {
    if hevc {
        (16..=21).contains(&t)
    } else {
        t == 5
    }
}

pub(crate) fn first_keyframe(bytes: &[u8]) -> Option<(usize, u16)> {
    let mut pmt_pid: Option<u16> = None;
    let mut video: Option<(u16, bool)> = None;
    let mut pes_at: Option<usize> = None;
    let mut window = u32::MAX;
    let mut i = 0usize;
    while i + PKT <= bytes.len() {
        if bytes[i] != SYNC {
            i += 1;
            continue;
        }
        let at = i;
        let pkt = &bytes[i..i + PKT];
        i += PKT;
        let pid = (((pkt[1] & 0x1F) as u16) << 8) | pkt[2] as u16;
        if pid == 0x1FFF || pkt[1] & 0x80 != 0 {
            continue;
        }
        if pid == 0 {
            pmt_pid = pmt_pid.or_else(|| parse_pat(pkt));
            continue;
        }
        if Some(pid) == pmt_pid {
            if let Some(pmt) = video.is_none().then(|| parse_pmt(pkt)).flatten() {
                let vpid = pmt.video_pid()?;
                let hevc = match pmt.streams.iter().find(|(p, _)| *p == vpid).map(|(_, t)| *t) {
                    Some(0x1B) => false,
                    Some(0x24) => true,
                    _ => return None,
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
            return None;
        }
        if pkt[1] & 0x40 != 0 {
            pes_at = Some(at);
            window = u32::MAX;
        }
        let Some(es) = es_payload(pkt) else { continue };
        for &b in es {
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

pub(crate) fn trim_to_keyframe(bytes: &[u8]) -> Option<Vec<u8>> {
    let (cut, pmt_pid) = first_keyframe(bytes)?;
    let mut out = Vec::with_capacity(bytes.len() - cut + 4 * PKT);
    let mut dropped = false;
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


#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Suspect {
    NotTransportStream,
    NoVideoParameterSets,
}

impl Suspect {
    pub(crate) fn slug(self) -> &'static str {
        match self {
            Suspect::NotTransportStream => "not-transport-stream",
            Suspect::NoVideoParameterSets => "undecodable-video",
        }
    }

    pub(crate) fn describe(self) -> &'static str {
        match self {
            Suspect::NotTransportStream => "segments are not an MPEG transport stream",
            Suspect::NoVideoParameterSets => "declares video but serves no decoder parameter sets",
        }
    }
}

const TS_SYNC_PROOF: usize = 5;

const TS_MIN_JUDGEABLE: usize = TS_SYNC_PROOF * PKT * 2;

fn looks_like_transport_stream(bytes: &[u8]) -> bool {
    find_sync(bytes).is_some_and(|start| proven_sync_at(bytes, start))
}

fn proven_sync_at(bytes: &[u8], at: usize) -> bool {
    (0..TS_SYNC_PROOF).all(|k| bytes.get(at + k * PKT) == Some(&SYNC))
}

pub(crate) fn inspect_segment(bytes: &[u8]) -> Option<Suspect> {
    if bytes.len() < TS_MIN_JUDGEABLE {
        return None;
    }
    if !looks_like_transport_stream(bytes) {
        return Some(Suspect::NotTransportStream);
    }
    let p = scan_profile(bytes)?;
    let declares_video = p.streams.iter().any(|&(_, t)| is_video_stream_type(t));
    (declares_video && p.video_params.is_none()).then_some(Suspect::NoVideoParameterSets)
}


const MAX_DISGUISE_PREFIX: usize = 4096;

const DISGUISE_HEAD_BYTES: usize = MAX_DISGUISE_PREFIX + TS_SYNC_PROOF * PKT;

pub(crate) fn disguise_prefix_len(bytes: &[u8]) -> Option<usize> {
    let head = &bytes[..bytes.len().min(DISGUISE_HEAD_BYTES)];
    if head.first().is_none_or(|&b| b == SYNC) {
        return None;
    }
    riff_exif_payload(head)
        .or_else(|| (1..=MAX_DISGUISE_PREFIX.min(head.len())).find(|&p| proven_sync_at(head, p)))
}

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

pub(crate) struct DisguiseStripper {
    held: Option<Vec<u8>>,
    stripped: usize,
}

impl DisguiseStripper {
    pub(crate) fn new() -> Self {
        Self { held: Some(Vec::new()), stripped: 0 }
    }

    pub(crate) fn push(&mut self, chunk: Bytes) -> Option<Bytes> {
        if chunk.is_empty() {
            return None;
        }
        let nothing_held = match &self.held {
            None => return Some(chunk),
            Some(h) => h.is_empty(),
        };
        if nothing_held {
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

    pub(crate) fn finish(&mut self) -> Option<Bytes> {
        let held = self.held.take()?;
        if held.is_empty() {
            return None;
        }
        self.decide(Bytes::from(held))
    }

    pub(crate) fn stripped(&self) -> usize {
        self.stripped
    }

    fn decide(&mut self, head: Bytes) -> Option<Bytes> {
        self.stripped = disguise_prefix_len(&head).unwrap_or(0);
        let rest = head.slice(self.stripped..);
        (!rest.is_empty()).then_some(rest)
    }
}

#[cfg(test)]
pub(crate) fn webp_disguise(ts: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(ts.len() + 42);
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&((ts.len() + 42 - 8) as u32).to_le_bytes());
    v.extend_from_slice(b"WEBP");
    v.extend_from_slice(b"VP8L");
    v.extend_from_slice(&13u32.to_le_bytes());
    v.extend_from_slice(&[0x2f, 0x00, 0x00, 0x00, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07]);
    v.push(0x00);
    v.extend_from_slice(b"EXIF");
    v.extend_from_slice(&(ts.len() as u32).to_le_bytes());
    v.extend_from_slice(ts);
    v
}

#[cfg(test)]
pub(crate) fn undecodable_segment() -> Vec<u8> {
    tests::undecodable()
}

#[cfg(test)]
pub(crate) fn mid_gop_segment() -> (Vec<u8>, usize) {
    tests::mid_gop()
}

#[cfg(test)]
pub(crate) fn tuner_ts(seconds: u64) -> Vec<u8> {
    tests::tuner(seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkt(pid: u16, pusi: bool, rai: bool, pcr: Option<u64>, payload: &[u8]) -> Vec<u8> {
        let mut p = vec![0xFFu8; PKT];
        p[0] = SYNC;
        p[1] = ((pid >> 8) as u8 & 0x1F) | if pusi { 0x40 } else { 0 };
        p[2] = (pid & 0xFF) as u8;
        let need_af = rai || pcr.is_some();
        if need_af {
            p[3] = 0x30;
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
            p[3] = 0x10;
            for (k, b) in payload.iter().enumerate() {
                if 4 + k < PKT {
                    p[4 + k] = *b;
                }
            }
        }
        p
    }

    fn pat(pmt_pid: u16) -> Vec<u8> {
        let mut sec = vec![
            0x00,
            0xB0, 0x0D,
            0x00, 0x01, 0xC1, 0x00, 0x00,
            0x00, 0x01,
            (0xE0 | (pmt_pid >> 8) as u8),
            (pmt_pid & 0xFF) as u8,
            0, 0, 0, 0,
        ];
        sec.insert(0, 0x00);
        pkt(0, true, false, None, &sec)
    }

    fn pmt(pmt_pid: u16, video_pid: u16) -> Vec<u8> {
        let mut sec = vec![
            0x02,
            0xB0, 0x12,
            0x00, 0x01, 0xC1, 0x00, 0x00,
            0xE0, 0x64,
            0xF0, 0x00,
            0x1B,
            (0xE0 | (video_pid >> 8) as u8),
            (video_pid & 0xFF) as u8,
            0xF0, 0x00,
            0, 0, 0, 0,
        ];
        sec.insert(0, 0x00);
        pkt(pmt_pid, true, false, None, &sec)
    }

    const VPID: u16 = 0x100;
    const PMTPID: u16 = 0x1000;
    const SEC: u64 = 90_000;

    pub(super) fn tuner(seconds: u64) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend(pat(PMTPID));
        v.extend(pmt(PMTPID, VPID));
        for s in 0..=seconds {
            v.extend(pkt(VPID, true, true, Some(s * SEC), &[0x11; 8]));
        }
        v
    }

    fn audio_only_pmt(pmt_pid: u16, apid: u16) -> Vec<u8> {
        let mut sec = vec![
            0x02, 0xB0, 0x12, 0x00, 0x01, 0xC1, 0x00, 0x00,
            (0xE0 | (apid >> 8) as u8), (apid & 0xFF) as u8,
            0xF0, 0x00,
            0x0F, (0xE0 | (apid >> 8) as u8), (apid & 0xFF) as u8, 0xF0, 0x00,
            0, 0, 0, 0,
        ];
        sec.insert(0, 0x00);
        pkt(pmt_pid, true, false, None, &sec)
    }

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

    #[test]
    fn a_declared_video_with_no_parameter_sets_is_the_undecodable_shape() {
        let mut s = Vec::new();
        s.extend(pat(PMTPID));
        s.extend(pmt(PMTPID, VPID));
        let mut payload = vec![0x00, 0x00, 0x01, 0xE0, 0x00, 0x00, 0x80, 0x00, 0x00];
        payload.extend_from_slice(&[0x00, 0x00, 0x01, 0x61, 0x9A, 0x21, 0x0C]);
        s.extend(pkt(VPID, true, true, None, &payload));
        let p = scan_profile(&s).expect("profile parses");
        assert!(p.video_params.is_none(), "no SPS/PPS anywhere in the video ES");
        assert!(
            p.streams.iter().any(|&(_, t)| is_video_stream_type(t)),
            "video IS declared — both halves true, so this is a genuine strike"
        );
    }

    #[test]
    fn a_healthy_segment_carries_parameter_sets_and_never_strikes() {
        let p = scan_profile(&segment_with(VPID, 0x1F)).expect("profile parses");
        assert!(p.video_params.is_some(), "SPS+PPS found ⇒ no strike regardless of the declaration");
    }


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

    #[test]
    fn an_audio_only_program_is_never_suspect() {
        let mut s = Vec::new();
        s.extend(pat(PMTPID));
        s.extend(audio_only_pmt(PMTPID, 0x101));
        assert_eq!(inspect_segment(&judgeable(s)), None, "no video declared ⇒ no verdict, ever");
    }

    pub(super) fn undecodable() -> Vec<u8> {
        let mut s = Vec::new();
        s.extend(pat(PMTPID));
        s.extend(pmt(PMTPID, VPID));
        let mut payload = vec![0x00, 0x00, 0x01, 0xE0, 0x00, 0x00, 0x80, 0x00, 0x00];
        payload.extend_from_slice(&[0x00, 0x00, 0x01, 0x61, 0x9A, 0x21, 0x0C]);
        s.extend(pkt(VPID, true, true, None, &payload));
        judgeable(s)
    }

    #[test]
    fn declared_video_with_no_parameter_sets_is_suspect() {
        assert_eq!(inspect_segment(&undecodable()), Some(Suspect::NoVideoParameterSets));
    }

    #[test]
    fn a_body_that_is_not_a_transport_stream_is_suspect() {
        let html = b"<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body>\
                     <h1>Forbidden</h1><p>Access denied.</p></body></html>";
        let mut body = Vec::new();
        while body.len() < TS_MIN_JUDGEABLE + 512 {
            body.extend_from_slice(html);
        }
        assert_eq!(inspect_segment(&body), Some(Suspect::NotTransportStream));
    }

    #[test]
    fn valid_ts_is_judged_by_sync_bytes_not_by_looking_like_media() {
        let s = judgeable(segment_with(VPID, 0x1F));
        assert!(looks_like_transport_stream(&s));
        assert_eq!(inspect_segment(&s), None, "content decides, and this content is a transport stream");
    }

    #[test]
    fn a_short_body_is_unverifiable_rather_than_broken() {
        assert_eq!(inspect_segment(b"\x47\x40\x00\x10short"), None);
        assert_eq!(inspect_segment(&[]), None);
    }

    #[test]
    fn a_stray_sync_byte_run_does_not_pass_for_a_transport_stream() {
        let mut body = vec![0u8; TS_MIN_JUDGEABLE + PKT];
        body[10] = SYNC;
        body[10 + PKT] = SYNC;
        assert!(find_sync(&body).is_some(), "…so the locator is satisfied");
        assert!(!looks_like_transport_stream(&body), "…but the verdict layer is not");
    }

    #[test]
    fn every_suspect_reason_has_a_distinct_slug_and_phrase() {
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


    fn video_pes(sps_tail: u8) -> Vec<u8> {
        let mut es = vec![0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x28, sps_tail];
        es.extend_from_slice(&[0x00, 0x00, 0x01, 0x68, 0xEE, 0x3C, 0xB0]);
        es.extend_from_slice(&[0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00]);
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
        assert_eq!(scan_profile(&video_pes(0x1F)), None);
        let mut no_params = Vec::new();
        no_params.extend(pat(PMTPID));
        no_params.extend(pmt(PMTPID, VPID));
        let p = scan_profile(&no_params).unwrap();
        assert_eq!(p.video_params, None);
        assert!(!p.compatible_with(&p), "an unverified profile is never declared compatible");
    }


    const APID: u16 = 0x101;
    const FRAME: u64 = 3600;
    const PES_HDR: usize = 14;

    fn pmt_of(pmt_pid: u16, streams: &[(u8, u16)]) -> Vec<u8> {
        let pcr = streams[0].1;
        let mut body = vec![0x00, 0x01, 0xC1, 0x00, 0x00, 0xE0 | (pcr >> 8) as u8, pcr as u8, 0xF0, 0x00];
        for &(t, pid) in streams {
            body.extend_from_slice(&[t, 0xE0 | (pid >> 8) as u8, pid as u8, 0xF0, 0x00]);
        }
        let len = body.len() + 4;
        let mut sec = vec![0x00, 0x02, 0xB0 | (len >> 8) as u8, len as u8];
        sec.extend(body);
        sec.extend([0, 0, 0, 0]);
        pkt(pmt_pid, true, false, None, &sec)
    }

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

    fn h264_p() -> Vec<u8> {
        [&[0, 0, 0, 1, 0x09, 0x30][..], &[0, 0, 0, 1, 0x41, 0x9A, 0x02, 0x03]].concat()
    }

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

    fn adts_with_a_decoy() -> Vec<u8> {
        vec![0xFF, 0xF1, 0x50, 0x80, 0x02, 0x1F, 0xFC, 0x00, 0x00, 0x01, 0x65, 0x21]
    }

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
        s.extend(pes_on(VPID, 0xE0, &[h264_idr(), vec![0x5A; 400]].concat(), true, t));
        s.extend(pes_on(APID, 0xC0, &adts_with_a_decoy(), false, t));
        s.extend(pes_on(VPID, 0xE0, &h264_p(), true, t + FRAME));
        (s, cut)
    }

    fn video_only(pictures: &[Vec<u8>]) -> Vec<u8> {
        let mut s = Vec::new();
        s.extend(pat(PMTPID));
        s.extend(pmt(PMTPID, VPID));
        for (k, p) in pictures.iter().enumerate() {
            s.extend(pes_on(VPID, 0xE0, p, true, 900_000 + k as u64 * FRAME));
        }
        s
    }

    #[test]
    fn a_mid_gop_segment_is_joined_at_its_first_keyframe_behind_its_program_tables() {
        let (seg, cut) = mid_gop();
        let out = trim_to_keyframe(&seg).expect("pictures in front of the keyframe ⇒ something to trim");
        assert_eq!(&out[..PKT], &pat(PMTPID)[..], "the PAT first");
        assert_eq!(&out[PKT..2 * PKT], &pmt_of(PMTPID, &[(0x1B, VPID), (0x0F, APID)])[..], "then the PMT");
        assert_eq!(&out[2 * PKT..], &seg[cut..], "then the segment from the keyframe's PES on, untouched");
        assert_eq!(first_keyframe(&out), Some((2 * PKT, PMTPID)), "…so what goes out opens on its keyframe");
    }

    #[test]
    fn a_random_access_flag_alone_is_never_taken_for_a_keyframe() {
        let (seg, cut) = mid_gop();
        assert!(adaptation_info(&seg[2 * PKT..3 * PKT]).0, "precondition: the opening P picture is flagged RAI");
        assert_eq!(first_keyframe(&seg).map(|(at, _)| at), Some(cut));
    }

    #[test]
    fn a_segment_that_already_opens_on_its_keyframe_is_left_whole() {
        let once = trim_to_keyframe(&mid_gop().0).unwrap();
        assert_eq!(trim_to_keyframe(&once), None);
        assert_eq!(trim_to_keyframe(&segment_with(VPID, 0x1F)), None, "PAT, PMT, then an IDR");
    }

    #[test]
    fn a_segment_without_a_keyframe_is_sent_whole_never_held_back() {
        assert_eq!(trim_to_keyframe(&video_only(&[h264_p(), h264_p(), h264_p()])), None);
    }

    #[test]
    fn a_start_code_split_across_two_packets_is_still_found() {
        let mut idr = vec![0x5A; PKT - 6 - PES_HDR - 2];
        idr.extend_from_slice(&[0x00, 0x00, 0x01, 0x65, 0x88, 0x84]);
        let s = video_only(&[h264_p(), idr]);
        let cut = 2 * PKT + pes_on(VPID, 0xE0, &h264_p(), true, 0).len();
        assert_eq!(&s[cut + PKT - 2..cut + PKT], &[0x00, 0x00], "precondition: the start code straddles");
        assert_eq!(s[cut + PKT + 4], 0x01, "…and completes in the next packet");
        assert_eq!(first_keyframe(&s).map(|(at, _)| at), Some(cut));
    }

    #[test]
    fn a_keyframe_whose_pes_head_was_cut_off_is_passed_over_for_the_next() {
        let mut s = Vec::new();
        s.extend(pat(PMTPID));
        s.extend(pmt(PMTPID, VPID));
        s.extend(pkt(VPID, false, false, None, &[0x00, 0x00, 0x01, 0x65, 0x88]));
        s.extend(pes_on(VPID, 0xE0, &h264_p(), true, 0));
        let cut = s.len();
        s.extend(pes_on(VPID, 0xE0, &h264_idr(), true, FRAME));
        assert_eq!(first_keyframe(&s).map(|(at, _)| at), Some(cut));
    }

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

    #[test]
    fn an_hevc_segment_is_joined_at_its_first_irap_picture() {
        let trail = [0, 0, 0, 1, 0x02, 0x01, 0xD0];
        let cra = [0, 0, 0, 1, 0x2A, 0x01, 0xAF];
        let mut s = Vec::new();
        s.extend(pat(PMTPID));
        s.extend(pmt_of(PMTPID, &[(0x24, VPID)]));
        s.extend(pes_on(VPID, 0xE0, &trail, true, 0));
        let cut = s.len();
        s.extend(pes_on(VPID, 0xE0, &cra, true, FRAME));
        assert_eq!(first_keyframe(&s).map(|(at, _)| at), Some(cut));
        assert!(!is_keyframe_nal(nal_type(0x2A, false), false));
    }

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
        assert_eq!(adaptation_info(&pkt(VPID, false, false, None, &[1, 2, 3])), (false, None));
    }

    #[test]
    fn cuts_at_a_random_access_point_after_the_target_duration() {
        let mut s = TsSegmenter::new(2.0);
        let mut stream = Vec::new();
        stream.extend(pat(PMTPID));
        stream.extend(pmt(PMTPID, VPID));
        for (t, rai) in [(0u64, true), (1, true), (2, true), (3, true)] {
            stream.extend(pkt(VPID, false, rai, Some(t * SEC), &[]));
        }
        let segs = s.push(&stream);
        assert_eq!(segs.len(), 1, "exactly one cut: the t=1 RAI is below target and must be skipped");
        assert!((segs[0].duration - 2.0).abs() < 0.01, "duration comes from PCR: {}", segs[0].duration);
    }

    #[test]
    fn falls_back_to_a_hard_cap_when_random_access_never_arrives() {
        let mut s = TsSegmenter::new(1.0);
        let mut stream = Vec::new();
        stream.extend(pat(PMTPID));
        stream.extend(pmt(PMTPID, VPID));
        for t in 0..6u64 {
            stream.extend(pkt(VPID, false, false, Some(t * SEC), &[]));
        }
        let segs = s.push(&stream);
        assert!(!segs.is_empty(), "the overlong cap must still produce segments");
        assert!(segs[0].duration >= 3.0);
    }

    #[test]
    fn never_cuts_before_the_video_pid_is_known() {
        let mut s = TsSegmenter::new(0.5);
        let mut stream = Vec::new();
        for t in 0..5u64 {
            stream.extend(pkt(VPID, false, true, Some(t * SEC), &[]));
        }
        assert!(s.push(&stream).is_empty(), "no PSI ⇒ no cuts");
    }

    #[test]
    fn carries_a_partial_packet_across_chunk_boundaries() {
        let mut whole = Vec::new();
        whole.extend(pat(PMTPID));
        whole.extend(pmt(PMTPID, VPID));
        for t in 0..4u64 {
            whole.extend(pkt(VPID, false, true, Some(t * SEC), &[]));
        }
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
        let mut stream = vec![0x11, 0x22, 0x33];
        stream.extend(pat(PMTPID));
        stream.extend(pmt(PMTPID, VPID));
        for t in 0..4u64 {
            stream.extend(pkt(VPID, false, true, Some(t * SEC), &[]));
        }
        let mut s = TsSegmenter::new(2.0);
        let segs = s.push(&stream);
        assert_eq!(segs.len(), 1, "leading junk must be skipped, not treated as packet data");
        assert_eq!(segs[0].bytes[0], SYNC);
        assert_eq!(segs[0].bytes.len() % PKT, 0, "segments are whole packets");
    }

    #[test]
    fn pcr_wraparound_does_not_produce_a_nonsense_duration() {
        let mut s = TsSegmenter::new(2.0);
        s.ready = true;
        s.video_pid = Some(VPID);
        s.seg_start_pcr = Some(PCR_WRAP - SEC);
        s.last_pcr = Some(SEC);
        let d = s.elapsed().expect("both PCRs known");
        assert!((d - 2.0).abs() < 0.01, "expected ~2s across the wrap, got {d}");
    }

    #[test]
    fn finish_flushes_the_trailing_partial_segment() {
        let mut s = TsSegmenter::new(10.0);
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


    fn clean_ts() -> Vec<u8> {
        judgeable(segment_with(VPID, 0x1F))
    }

    fn null_ts(n: usize) -> Vec<u8> {
        (0..n).flat_map(|_| pkt(0x1FFF, false, false, None, &[])).collect()
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

    #[test]
    fn a_body_that_already_starts_on_a_sync_byte_is_never_unwrapped() {
        assert_eq!(disguise_prefix_len(&clean_ts()), None);
        let mut damaged = clean_ts();
        damaged[PKT] = 0x00;
        assert_eq!(disguise_prefix_len(&damaged), None, "byte 0 decides, not the proof");
        assert_eq!(disguise_prefix_len(&[]), None);
    }

    #[test]
    fn a_sync_byte_inside_the_wrappers_size_fields_does_not_fool_the_unwrap() {
        let ts = null_ts(97);
        let body = webp_disguise(&ts);
        assert_eq!((body[5], body[39]), (SYNC, SYNC), "fixture sanity: a 0x47 in each size field");
        assert_eq!(disguise_prefix_len(&body), Some(42));
        assert_eq!(&body[42..], &ts[..]);
    }

    #[test]
    fn a_riff_disguise_is_read_from_its_declared_sizes_not_from_a_scan() {
        let mut ts = null_ts(10);
        ts[2 * PKT] = 0x00;
        assert_eq!(disguise_prefix_len(&webp_disguise(&ts)), Some(42), "not 42 + 3 packets, where a scan lands");
    }

    #[test]
    fn a_riff_exif_payload_that_is_not_a_transport_stream_is_not_taken() {
        let mut not_whole = vec![SYNC];
        not_whole.extend(noise(999, 7));
        assert_eq!(disguise_prefix_len(&webp_disguise(&not_whole)), None);
        let mut exif = b"Exif\0\0MM\0*".to_vec();
        exif.resize(PKT * 6, 0);
        assert_eq!(disguise_prefix_len(&webp_disguise(&exif)), None);
    }

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

    #[test]
    fn a_192_byte_m2ts_stream_is_not_mistaken_for_a_disguised_188_byte_one() {
        let mut m2ts = Vec::new();
        for i in 0..40u32 {
            m2ts.extend_from_slice(&(i * 1000 + 1).to_be_bytes());
            m2ts.extend(pkt(0x1FFF, false, false, None, &[]));
        }
        assert_ne!(m2ts[0], SYNC, "fixture sanity: the timestamp comes first");
        assert_eq!(disguise_prefix_len(&m2ts), None);
    }

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

    #[test]
    fn a_stray_sync_pair_in_an_opaque_prefix_is_skipped_for_the_real_proof() {
        let mut body = vec![0u8; 600];
        body[10] = SYNC;
        body[10 + PKT] = SYNC;
        body.extend_from_slice(&null_ts(8));
        assert_eq!(disguise_prefix_len(&body), Some(600));
    }

    #[test]
    fn too_few_packets_behind_an_opaque_prefix_are_left_alone() {
        let mut body = vec![0u8; 42];
        body.extend_from_slice(&null_ts(3));
        assert_eq!(disguise_prefix_len(&body), None);
    }

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

    #[test]
    fn a_large_first_chunk_is_unwrapped_without_a_copy() {
        let body = Bytes::from(webp_disguise(&null_ts(40)));
        let mut s = DisguiseStripper::new();
        let out = s.push(body.clone()).expect("one chunk spans the window");
        assert_eq!(out.as_ptr(), body[42..].as_ptr(), "a slice of the upstream buffer, not a copy");
        assert_eq!(out.len(), body.len() - 42);
    }

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

