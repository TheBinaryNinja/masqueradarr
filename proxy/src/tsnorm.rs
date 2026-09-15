
use std::collections::HashMap;

use crate::tsseg::{parse_pat, parse_pmt, PKT, SYNC};

pub(crate) const CLOCK_WRAP: u64 = 1 << 33;
pub(crate) const CLOCK_MASK: u64 = CLOCK_WRAP - 1;

const DEFAULT_FRAME_DUR: u64 = 3600;

const MIN_FRAME_DUR: u64 = 375;
const MAX_FRAME_DUR: u64 = 18_000;

struct Scan {
    first_dts: u64,
    last_dts: u64,
    max_pts: u64,
    frame_dur: u64,
}

#[derive(Default)]
pub(crate) struct Normalizer {
    cc: HashMap<u16, u8>,
    last_dts: Option<u64>,
    last_pts: u64,
    frame_dur: u64,
}

impl Normalizer {
    pub(crate) fn new() -> Self {
        Self { cc: HashMap::new(), last_dts: None, last_pts: 0, frame_dur: DEFAULT_FRAME_DUR }
    }

    pub(crate) fn reset(&mut self) {
        self.cc.clear();
        self.last_dts = None;
        self.last_pts = 0;
        self.frame_dur = DEFAULT_FRAME_DUR;
    }

    fn offset_for(&self, s: &Scan, repeat: bool) -> u64 {
        let start = match self.last_dts {
            Some(last) => {
                let base = match repeat {
                    true if forward_gap(last, self.last_pts) < CLOCK_WRAP / 2 => self.last_pts,
                    _ => last,
                };
                base.wrapping_add(self.frame_dur) & CLOCK_MASK
            }
            None => s.first_dts,
        };
        start.wrapping_sub(s.first_dts) & CLOCK_MASK
    }

    fn advance(&mut self, s: &Scan, offset: u64) {
        self.last_dts = Some(s.last_dts.wrapping_add(offset) & CLOCK_MASK);
        self.last_pts = s.max_pts.wrapping_add(offset) & CLOCK_MASK;
        self.frame_dur = s.frame_dur;
    }

    fn rewrite(&mut self, bytes: &[u8], remap: Option<&Remap>, repeat: bool) -> Option<Vec<u8>> {
        let s = scan(bytes)?;
        let offset = self.offset_for(&s, repeat);
        let mut out = bytes.to_vec();
        apply(&mut out, offset, &mut self.cc, remap)?;
        self.advance(&s, offset);
        Some(out)
    }
}

pub(crate) fn forward_gap(a: u64, b: u64) -> u64 {
    b.wrapping_sub(a) & CLOCK_MASK
}

fn scan(bytes: &[u8]) -> Option<Scan> {
    let mut pmt_pid: Option<u16> = None;
    let mut video_pid: Option<u16> = None;
    let mut first_dts: Option<u64> = None;
    let mut last_dts: u64 = 0;
    let mut max_pts: u64 = 0;
    let mut prev_dts: Option<u64> = None;
    let mut frame_dur: Option<u64> = None;

    for pkt in packets(bytes) {
        if pkt[1] & 0x80 != 0 {
            continue;
        }
        if pkt[3] & 0xC0 != 0 {
            return None;
        }
        let pid = pid_of(pkt);
        if pid == 0x1FFF {
            continue;
        }
        if pid == 0 {
            pmt_pid = pmt_pid.or_else(|| parse_pat(pkt));
        } else if Some(pid) == pmt_pid && video_pid.is_none() {
            if let Some(pmt) = parse_pmt(pkt) {
                video_pid = pmt.video_pid();
            }
        } else if Some(pid) == video_pid && pkt[1] & 0x40 != 0 {
            let (pts, dts) = pes_timestamps(pkt)?;
            let Some(dts) = dts.or(pts) else { continue };
            first_dts.get_or_insert(dts);
            last_dts = dts;
            if let Some(p) = pts {
                if forward_gap(max_pts, p) < CLOCK_WRAP / 2 || max_pts == 0 {
                    max_pts = p;
                }
            }
            if let Some(prev) = prev_dts {
                let gap = forward_gap(prev, dts);
                if (MIN_FRAME_DUR..=MAX_FRAME_DUR).contains(&gap) {
                    frame_dur = Some(gap);
                }
            }
            prev_dts = Some(dts);
        }
    }

    let first_dts = first_dts?;
    Some(Scan {
        first_dts,
        last_dts,
        max_pts: if max_pts == 0 { last_dts } else { max_pts },
        frame_dur: frame_dur.unwrap_or(DEFAULT_FRAME_DUR),
    })
}

fn apply(out: &mut [u8], offset: u64, cc: &mut HashMap<u16, u8>, remap: Option<&Remap>) -> Option<()> {
    let mut i = 0usize;
    while i + PKT <= out.len() {
        if out[i] != SYNC {
            i += 1;
            continue;
        }
        let pkt = &mut out[i..i + PKT];
        i += PKT;
        let pid = pid_of(pkt);
        if pid == 0x1FFF || pkt[1] & 0x80 != 0 {
            continue;
        }
        if let Some(r) = remap {
            if pid == 0 {
                write_section(pkt, 0, &r.layout.pat)?;
            } else if pid == r.in_pmt_pid {
                write_section(pkt, OUT_PMT_PID, &r.layout.pmt)?;
            } else if let Some(&out_pid) = r.pids.get(&pid) {
                set_pid(pkt, out_pid);
            } else {
                nullify(pkt);
                continue;
            }
        }
        let pid = pid_of(pkt);

        let afc = (pkt[3] >> 4) & 0b11;
        if afc == 0b10 || afc == 0b11 {
            let len = pkt[4] as usize;
            if len > 0 && 5 + len <= PKT {
                pkt[5] &= !0x80;
                let flags = pkt[5];
                if flags & 0x10 != 0 && len >= 7 {
                    shift_pcr(&mut pkt[6..12], offset);
                }
                if flags & 0x08 != 0 && len >= 13 {
                    shift_pcr(&mut pkt[12..18], offset);
                }
            }
        }

        if afc == 0b01 || afc == 0b11 {
            let next = cc.entry(pid).or_insert(pkt[3] & 0x0F);
            pkt[3] = (pkt[3] & 0xF0) | (*next & 0x0F);
            *next = (*next + 1) & 0x0F;
        }

        if pkt[1] & 0x40 != 0 {
            shift_pes(pkt, offset)?;
        }
    }
    Some(())
}

pub(crate) fn packets(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut i = 0usize;
    std::iter::from_fn(move || {
        while i + PKT <= bytes.len() {
            if bytes[i] != SYNC {
                i += 1;
                continue;
            }
            let p = &bytes[i..i + PKT];
            i += PKT;
            return Some(p);
        }
        None
    })
}

pub(crate) fn pid_of(pkt: &[u8]) -> u16 {
    (((pkt[1] & 0x1F) as u16) << 8) | pkt[2] as u16
}

fn payload_start(pkt: &[u8]) -> Option<usize> {
    let afc = (pkt[3] >> 4) & 0b11;
    let off = match afc {
        0b01 => 4,
        0b11 => 5 + pkt[4] as usize,
        _ => return None,
    };
    (off < PKT).then_some(off)
}

#[allow(clippy::type_complexity)]
pub(crate) fn pes_timestamps(pkt: &[u8]) -> Option<(Option<u64>, Option<u64>)> {
    let Some(off) = payload_start(pkt) else { return Some((None, None)) };
    let p = &pkt[off..];
    if p.len() < 9 || p[0..3] != [0x00, 0x00, 0x01] {
        return Some((None, None));
    }
    if !has_optional_header(p[3]) {
        return Some((None, None));
    }
    if p[6] & 0xC0 != 0x80 {
        return None;
    }
    if p[7] & 0x20 != 0 {
        return None;
    }
    let flags = p[7] >> 6;
    let hdr_len = p[8] as usize;
    match flags {
        0b00 => Some((None, None)),
        0b10 if hdr_len >= 5 && p.len() >= 14 => Some((Some(read_ts(&p[9..14])), None)),
        0b11 if hdr_len >= 10 && p.len() >= 19 => Some((Some(read_ts(&p[9..14])), Some(read_ts(&p[14..19])))),
        _ => None,
    }
}

fn shift_pes(pkt: &mut [u8], offset: u64) -> Option<()> {
    let Some(off) = payload_start(pkt) else { return Some(()) };
    let p = &mut pkt[off..];
    if p.len() < 9 || p[0..3] != [0x00, 0x00, 0x01] || !has_optional_header(p[3]) {
        return Some(());
    }
    if p[6] & 0xC0 != 0x80 || p[7] & 0x20 != 0 {
        return None;
    }
    let flags = p[7] >> 6;
    let hdr_len = p[8] as usize;
    match flags {
        0b00 => Some(()),
        0b10 if hdr_len >= 5 && p.len() >= 14 => {
            let v = read_ts(&p[9..14]).wrapping_add(offset) & CLOCK_MASK;
            write_ts(&mut p[9..14], v);
            Some(())
        }
        0b11 if hdr_len >= 10 && p.len() >= 19 => {
            let pts = read_ts(&p[9..14]).wrapping_add(offset) & CLOCK_MASK;
            let dts = read_ts(&p[14..19]).wrapping_add(offset) & CLOCK_MASK;
            write_ts(&mut p[9..14], pts);
            write_ts(&mut p[14..19], dts);
            Some(())
        }
        _ => None,
    }
}

fn has_optional_header(stream_id: u8) -> bool {
    !matches!(stream_id, 0xBC | 0xBE | 0xBF | 0xF0 | 0xF1 | 0xF2 | 0xF8 | 0xFF)
}

fn read_ts(b: &[u8]) -> u64 {
    (((b[0] & 0x0E) as u64) << 29)
        | ((b[1] as u64) << 22)
        | (((b[2] & 0xFE) as u64) << 14)
        | ((b[3] as u64) << 7)
        | ((b[4] as u64) >> 1)
}

fn write_ts(b: &mut [u8], v: u64) {
    b[0] = (b[0] & 0xF0) | ((((v >> 30) as u8) & 0x07) << 1) | 1;
    b[1] = (v >> 22) as u8;
    b[2] = ((((v >> 15) as u8) & 0x7F) << 1) | 1;
    b[3] = (v >> 7) as u8;
    b[4] = (((v as u8) & 0x7F) << 1) | 1;
}

fn shift_pcr(b: &mut [u8], offset: u64) {
    let base = ((b[0] as u64) << 25)
        | ((b[1] as u64) << 17)
        | ((b[2] as u64) << 9)
        | ((b[3] as u64) << 1)
        | ((b[4] as u64) >> 7);
    let v = base.wrapping_add(offset) & CLOCK_MASK;
    b[0] = (v >> 25) as u8;
    b[1] = (v >> 17) as u8;
    b[2] = (v >> 9) as u8;
    b[3] = (v >> 1) as u8;
    b[4] = (((v & 1) as u8) << 7) | (b[4] & 0x7F);
}


pub(crate) const OUT_PMT_PID: u16 = 0x1000;
pub(crate) const OUT_VIDEO_PID: u16 = 0x100;
pub(crate) const OUT_AUDIO_BASE: u16 = 0x101;
const OUT_PROGRAM: u16 = 1;
const MAX_AUDIO: usize = 4;
const NO_PCR: u16 = 0x1FFF;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum LayoutMode {
    Muxed,
    VideoOnly,
    AudioOnly,
}

fn is_self_describing_video(t: u8) -> bool {
    matches!(t, 0x1B | 0x24)
}

fn is_self_describing_audio(t: u8) -> bool {
    matches!(t, 0x03 | 0x04 | 0x0F | 0x11)
}

fn is_droppable(t: u8) -> bool {
    matches!(t, 0x05 | 0x15)
}

fn publishable(psi: &SegPsi) -> bool {
    psi.streams
        .iter()
        .all(|&(_, t)| is_self_describing_video(t) || is_self_describing_audio(t) || is_droppable(t))
}

struct SegPsi {
    pmt_pid: u16,
    pcr_pid: u16,
    streams: Vec<(u16, u8)>,
}

struct Layout {
    pat: Vec<u8>,
    pmt: Vec<u8>,
    streams: Vec<(u8, u16)>,
    pcr_out: u16,
    mode: LayoutMode,
}

impl Layout {
    fn lock(psi: &SegPsi, mode: LayoutMode) -> Option<Layout> {
        if !publishable(psi) {
            return None;
        }
        let videos: Vec<u8> =
            psi.streams.iter().filter(|(_, t)| is_self_describing_video(*t)).map(|(_, t)| *t).collect();
        let audios: Vec<u8> =
            psi.streams.iter().filter(|(_, t)| is_self_describing_audio(*t)).map(|(_, t)| *t).collect();
        match mode {
            LayoutMode::Muxed => {
                if videos.len() != 1 || audios.is_empty() || audios.len() > MAX_AUDIO {
                    return None;
                }
            }
            LayoutMode::VideoOnly => {
                if videos.len() != 1 {
                    return None;
                }
            }
            LayoutMode::AudioOnly => {
                if !videos.is_empty() || audios.is_empty() || audios.len() > MAX_AUDIO {
                    return None;
                }
            }
        }
        let mut streams: Vec<(u8, u16)> = videos.iter().map(|&t| (t, OUT_VIDEO_PID)).collect();
        if mode != LayoutMode::VideoOnly {
            for (i, t) in audios.into_iter().enumerate() {
                streams.push((t, OUT_AUDIO_BASE + i as u16));
            }
        }
        let pcr_out = match mode {
            LayoutMode::Muxed | LayoutMode::VideoOnly => OUT_VIDEO_PID,
            LayoutMode::AudioOnly if psi.pcr_pid == NO_PCR => NO_PCR,
            LayoutMode::AudioOnly => {
                let first_audio = psi.streams.iter().find(|(_, t)| is_self_describing_audio(*t))?.0;
                if psi.pcr_pid != first_audio {
                    return None;
                }
                OUT_AUDIO_BASE
            }
        };
        Some(Layout { pat: build_pat(), pmt: build_pmt(pcr_out, &streams), streams, pcr_out, mode })
    }

    fn map(&self, psi: &SegPsi) -> Option<HashMap<u16, u16>> {
        if !publishable(psi) {
            return None;
        }
        let mut out = HashMap::new();
        let mut used: Vec<u16> = Vec::new();
        for &(want_type, out_pid) in &self.streams {
            let (in_pid, _) = psi
                .streams
                .iter()
                .copied()
                .find(|(p, t)| *t == want_type && !used.contains(p))?;
            used.push(in_pid);
            out.insert(in_pid, out_pid);
        }
        if self.mode != LayoutMode::VideoOnly {
            let carried = psi.streams.iter().filter(|(_, t)| is_self_describing_audio(*t)).count();
            let published = self.streams.iter().filter(|(t, _)| is_self_describing_audio(*t)).count();
            if carried > published {
                return None;
            }
        }
        let carried_v = psi.streams.iter().filter(|(_, t)| is_self_describing_video(*t)).count();
        let published_v = self.streams.iter().filter(|(t, _)| is_self_describing_video(*t)).count();
        if carried_v > published_v {
            return None;
        }
        let pcr_ok = if self.pcr_out == NO_PCR {
            psi.pcr_pid == NO_PCR
        } else {
            out.get(&psi.pcr_pid) == Some(&self.pcr_out)
        };
        if !pcr_ok {
            return None;
        }
        Some(out)
    }
}

struct Remap<'a> {
    layout: &'a Layout,
    pids: HashMap<u16, u16>,
    in_pmt_pid: u16,
}

pub(crate) struct Splicer {
    clock: Normalizer,
    layout: Option<Layout>,
}

impl Splicer {
    pub(crate) fn new() -> Self {
        Self { clock: Normalizer::new(), layout: None }
    }

    pub(crate) fn reset(&mut self) {
        self.clock.reset();
        self.layout = None;
    }

    pub(crate) fn has_timeline(&self) -> bool {
        self.clock.last_dts.is_some()
    }

    pub(crate) fn normalize(&mut self, bytes: &[u8]) -> Option<Vec<u8>> {
        self.publish(bytes)
    }

    fn publish(&mut self, bytes: &[u8]) -> Option<Vec<u8>> {
        let psi = read_psi(bytes)?;
        if self.layout.is_none() {
            self.layout = Some(Layout::lock(&psi, LayoutMode::Muxed)?);
        }
        let layout = self.layout.as_ref()?;
        let pids = layout.map(&psi)?;
        let remap = Remap { layout, pids, in_pmt_pid: psi.pmt_pid };
        let clock = &mut self.clock;
        clock.rewrite(bytes, Some(&remap), false)
    }
}

const SKEW_TOLERANCE: u64 = 45_000;

pub(crate) struct PairSplicer {
    clock: Normalizer,
    video: Option<Layout>,
    audio: Option<Layout>,
    audio_cc: HashMap<u16, u8>,
    locked_skew: Option<u64>,
    last_decline: String,
    last_slug: &'static str,
}

fn signed_ms(ticks: u64) -> f64 {
    let t = ticks & CLOCK_MASK;
    let signed = if t > CLOCK_WRAP / 2 { t as i64 - CLOCK_WRAP as i64 } else { t as i64 };
    signed as f64 / 90.0
}

fn describe_psi(psi: &SegPsi) -> String {
    let streams: Vec<String> = psi.streams.iter().map(|(p, t)| format!("{p:#x}:{t:#04x}")).collect();
    format!("pcr={:#x} streams=[{}]", psi.pcr_pid, streams.join(" "))
}

impl PairSplicer {
    pub(crate) fn new() -> Self {
        Self {
            clock: Normalizer::new(),
            video: None,
            audio: None,
            audio_cc: HashMap::new(),
            locked_skew: None,
            last_decline: String::new(),
            last_slug: "",
        }
    }

    pub(crate) fn last_decline(&self) -> &str {
        &self.last_decline
    }

    pub(crate) fn last_decline_slug(&self) -> &'static str {
        self.last_slug
    }

    pub(crate) fn reset(&mut self) {
        self.clock.reset();
        self.video = None;
        self.audio = None;
        self.audio_cc.clear();
        self.locked_skew = None;
    }

    pub(crate) fn has_timeline(&self) -> bool {
        self.clock.last_dts.is_some()
    }

    pub(crate) fn normalize_pair(&mut self, video: &[u8], audio: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
        macro_rules! decline {
            ($fmt:literal $(, $arg:expr)* $(,)?) => {{
                self.last_slug = $fmt;
                self.last_decline = format!($fmt $(, $arg)*);
                return None;
            }};
        }
        macro_rules! need {
            ($e:expr, $fmt:literal $(, $arg:expr)* $(,)?) => {
                match $e {
                    Some(v) => v,
                    None => decline!($fmt $(, $arg)*),
                }
            };
        }

        let s = need!(scan(video), "video lane: no anchorable timestamps");
        let offset = self.clock.offset_for(&s, false);

        let vpsi = need!(read_psi(video), "video lane: no PSI");
        if self.video.is_none() {
            self.video = Some(need!(
                Layout::lock(&vpsi, LayoutMode::VideoOnly),
                "video lane: not a lockable video-only program ({})",
                describe_psi(&vpsi)
            ));
        }
        let vlayout = self.video.as_ref()?;
        let vpids = need!(
            vlayout.map(&vpsi),
            "video lane: segment does not fit the published layout ({})",
            describe_psi(&vpsi)
        );

        let apsi = need!(read_psi(audio), "audio lane: no PSI");
        if self.audio.is_none() {
            self.audio = Some(need!(
                Layout::lock(&apsi, LayoutMode::AudioOnly),
                "audio lane: not a lockable audio-only program ({})",
                describe_psi(&apsi)
            ));
        }
        let alayout = self.audio.as_ref()?;
        let apids = need!(
            alayout.map(&apsi),
            "audio lane: segment does not fit the published layout ({})",
            describe_psi(&apsi)
        );

        let afirst = need!(first_audio_pts(audio, &apsi), "audio lane: no PES timestamps");
        let skew = afirst.wrapping_sub(s.first_dts) & CLOCK_MASK;
        if let Some(locked) = self.locked_skew {
            let drift = forward_gap(locked, skew).min(forward_gap(skew, locked));
            if drift > SKEW_TOLERANCE {
                decline!(
                    "the two renditions' clocks drifted apart by {:.0} ms (locked skew {:.0} ms, this pair {:.0} ms)",
                    drift as f64 / 90.0,
                    signed_ms(locked),
                    signed_ms(skew)
                );
            }
        }

        let mut vcc = self.clock.cc.clone();
        let mut vout = video.to_vec();
        let vremap = Remap { layout: vlayout, pids: vpids, in_pmt_pid: vpsi.pmt_pid };
        need!(apply(&mut vout, offset, &mut vcc, Some(&vremap)), "video lane: rewrite failed");

        let mut acc = self.audio_cc.clone();
        let mut aout = audio.to_vec();
        let aremap = Remap { layout: alayout, pids: apids, in_pmt_pid: apsi.pmt_pid };
        need!(apply(&mut aout, offset, &mut acc, Some(&aremap)), "audio lane: rewrite failed");

        self.clock.cc = vcc;
        self.audio_cc = acc;
        self.clock.advance(&s, offset);
        self.locked_skew.get_or_insert(skew);
        Some((vout, aout))
    }
}

fn first_audio_pts(bytes: &[u8], psi: &SegPsi) -> Option<u64> {
    let want = psi.streams.iter().find(|(_, t)| is_self_describing_audio(*t))?.0;
    for pkt in packets(bytes) {
        if pkt[1] & 0x80 != 0 || pkt[3] & 0xC0 != 0 {
            continue;
        }
        if pid_of(pkt) != want || pkt[1] & 0x40 == 0 {
            continue;
        }
        let (pts, dts) = pes_timestamps(pkt)?;
        if let Some(t) = dts.or(pts) {
            return Some(t);
        }
    }
    None
}

fn read_psi(bytes: &[u8]) -> Option<SegPsi> {
    let mut pmt_pid: Option<u16> = None;
    let mut pmt: Option<crate::tsseg::PmtInfo> = None;
    for pkt in packets(bytes) {
        if pkt[1] & 0x80 != 0 {
            continue;
        }
        let pid = pid_of(pkt);
        if pid == 0 {
            pmt_pid = pmt_pid.or_else(|| parse_pat(pkt));
        } else if Some(pid) == pmt_pid && pmt.is_none() {
            pmt = parse_pmt(pkt);
        }
    }
    let pmt_pid = pmt_pid?;
    let pmt = pmt?;
    Some(SegPsi { pmt_pid, pcr_pid: pmt.pcr_pid, streams: pmt.streams })
}

fn crc32_mpeg(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in data {
        crc ^= (b as u32) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 { (crc << 1) ^ 0x04C1_1DB7 } else { crc << 1 };
        }
    }
    crc
}

fn finish_section(mut s: Vec<u8>) -> Vec<u8> {
    let len = s.len() - 3 + 4;
    s[1] = 0xB0 | ((len >> 8) as u8 & 0x0F);
    s[2] = (len & 0xFF) as u8;
    let crc = crc32_mpeg(&s);
    s.extend_from_slice(&crc.to_be_bytes());
    s
}

pub(crate) fn build_pat() -> Vec<u8> {
    let mut s = vec![
        0x00, 0x00, 0x00,
        0x00, 0x01,
        0xC1,
        0x00, 0x00,
    ];
    s.extend_from_slice(&OUT_PROGRAM.to_be_bytes());
    s.extend_from_slice(&(0xE000 | OUT_PMT_PID).to_be_bytes());
    finish_section(s)
}

pub(crate) fn build_pmt(pcr_pid: u16, streams: &[(u8, u16)]) -> Vec<u8> {
    let mut s = vec![0x02, 0x00, 0x00];
    s.extend_from_slice(&OUT_PROGRAM.to_be_bytes());
    s.extend_from_slice(&[0xC1, 0x00, 0x00]);
    s.extend_from_slice(&(0xE000 | pcr_pid).to_be_bytes());
    s.extend_from_slice(&[0xF0, 0x00]);
    for &(stream_type, pid) in streams {
        s.push(stream_type);
        s.extend_from_slice(&(0xE000 | pid).to_be_bytes());
        s.extend_from_slice(&[0xF0, 0x00]);
    }
    finish_section(s)
}

pub(crate) fn write_section(pkt: &mut [u8], pid: u16, section: &[u8]) -> Option<()> {
    if 5 + section.len() > PKT {
        return None;
    }
    pkt[0] = SYNC;
    pkt[1] = 0x40 | ((pid >> 8) as u8 & 0x1F);
    pkt[2] = (pid & 0xFF) as u8;
    pkt[3] = 0x10;
    pkt[4] = 0x00;
    pkt[5..5 + section.len()].copy_from_slice(section);
    for b in &mut pkt[5 + section.len()..] {
        *b = 0xFF;
    }
    Some(())
}

fn set_pid(pkt: &mut [u8], pid: u16) {
    pkt[1] = (pkt[1] & 0xE0) | ((pid >> 8) as u8 & 0x1F);
    pkt[2] = (pid & 0xFF) as u8;
}

fn nullify(pkt: &mut [u8]) {
    pkt[1] = 0x1F;
    pkt[2] = 0xFF;
    pkt[3] = 0x10;
    for b in &mut pkt[4..] {
        *b = 0xFF;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VPID: u16 = 0x100;
    const APID: u16 = 0x101;
    const PMTPID: u16 = 0x1000;
    const HZ: u64 = 90_000;


    fn pkt(pid: u16, pusi: bool, pcr: Option<u64>, payload: &[u8]) -> Vec<u8> {
        let mut p = vec![0xFFu8; PKT];
        p[0] = SYNC;
        p[1] = ((pid >> 8) as u8 & 0x1F) | if pusi { 0x40 } else { 0 };
        p[2] = (pid & 0xFF) as u8;
        let start = if let Some(v) = pcr {
            p[3] = 0x30;
            p[4] = 7;
            p[5] = 0x90;
            p[6] = (v >> 25) as u8;
            p[7] = (v >> 17) as u8;
            p[8] = (v >> 9) as u8;
            p[9] = (v >> 1) as u8;
            p[10] = (((v & 1) as u8) << 7) | 0x7E;
            p[11] = 0xA5;
            12
        } else {
            p[3] = 0x10;
            4
        };
        for (k, b) in payload.iter().enumerate() {
            if start + k < PKT {
                p[start + k] = *b;
            }
        }
        p
    }

    fn pes(stream_id: u8, pts: u64, dts: Option<u64>) -> Vec<u8> {
        let mut v = vec![0x00, 0x00, 0x01, stream_id, 0x00, 0x00, 0x80];
        v.push(if dts.is_some() { 0xC0 } else { 0x80 });
        v.push(if dts.is_some() { 10 } else { 5 });
        let mut ts = [0u8; 5];
        ts[0] = if dts.is_some() { 0x30 } else { 0x20 };
        write_ts(&mut ts, pts);
        v.extend_from_slice(&ts);
        if let Some(d) = dts {
            let mut t = [0u8; 5];
            t[0] = 0x10;
            write_ts(&mut t, d);
            v.extend_from_slice(&t);
        }
        v.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]);
        v
    }

    fn pat() -> Vec<u8> {
        let mut sec = vec![
            0x00, 0xB0, 0x0D, 0x00, 0x01, 0xC1, 0x00, 0x00, 0x00, 0x01,
            0xE0 | (PMTPID >> 8) as u8,
            (PMTPID & 0xFF) as u8,
            0, 0, 0, 0,
        ];
        sec.insert(0, 0x00);
        pkt(0, true, None, &sec)
    }

    fn pmt() -> Vec<u8> {
        let mut sec = vec![
            0x02, 0xB0, 0x17, 0x00, 0x01, 0xC1, 0x00, 0x00,
            0xE0 | (VPID >> 8) as u8, (VPID & 0xFF) as u8,
            0xF0, 0x00,
            0x1B, 0xE0 | (VPID >> 8) as u8, (VPID & 0xFF) as u8, 0xF0, 0x00,
            0x0F, 0xE0 | (APID >> 8) as u8, (APID & 0xFF) as u8, 0xF0, 0x00,
            0, 0, 0, 0,
        ];
        sec.insert(0, 0x00);
        pkt(PMTPID, true, None, &sec)
    }

    fn segment(base: u64, av_skew: u64) -> Vec<u8> {
        let f = HZ / 25;
        let mut s = Vec::new();
        s.extend(pat());
        s.extend(pmt());
        for i in 0..3u64 {
            let dts = base + i * f;
            s.extend(pkt(VPID, true, Some(dts), &pes(0xE0, dts + f, Some(dts))));
            s.extend(pkt(APID, true, None, &pes(0xC0, dts + av_skew, None)));
        }
        s
    }


    fn pat_for(pmt_pid: u16) -> Vec<u8> {
        let mut s = vec![0x00, 0x00, 0x00, 0x00, 0x01, 0xC1, 0x00, 0x00];
        s.extend_from_slice(&1u16.to_be_bytes());
        s.extend_from_slice(&(0xE000 | pmt_pid).to_be_bytes());
        let mut body = vec![0x00];
        body.extend_from_slice(&finish_section(s));
        pkt(0, true, None, &body)
    }

    fn pmt_for(pmt_pid: u16, pcr_pid: u16, streams: &[(u8, u16)]) -> Vec<u8> {
        let mut s = vec![0x02, 0x00, 0x00];
        s.extend_from_slice(&1u16.to_be_bytes());
        s.extend_from_slice(&[0xC1, 0x00, 0x00]);
        s.extend_from_slice(&(0xE000 | pcr_pid).to_be_bytes());
        s.extend_from_slice(&[0xF0, 0x00]);
        for &(t, p) in streams {
            s.push(t);
            s.extend_from_slice(&(0xE000 | p).to_be_bytes());
            s.extend_from_slice(&[0xF0, 0x00]);
        }
        let mut body = vec![0x00];
        body.extend_from_slice(&finish_section(s));
        pkt(pmt_pid, true, None, &body)
    }

    fn side(vpid: u16, apid: u16, id3: Option<u16>, base: u64) -> Vec<u8> {
        let f = HZ / 25;
        let mut streams = vec![(0x1Bu8, vpid), (0x0Fu8, apid)];
        if let Some(d) = id3 {
            streams.push((0x15u8, d));
        }
        let mut s = Vec::new();
        s.extend(pat_for(PMTPID));
        s.extend(pmt_for(PMTPID, vpid, &streams));
        for i in 0..3u64 {
            let dts = base + i * f;
            s.extend(pkt(vpid, true, Some(dts), &pes(0xE0, dts + f, Some(dts))));
            s.extend(pkt(apid, true, None, &pes(0xC0, dts, None)));
            if let Some(d) = id3 {
                s.extend(pkt(d, true, None, &[0x49, 0x44, 0x33]));
            }
        }
        s
    }

    fn published_video_pid(bytes: &[u8]) -> Option<u16> {
        let psi = read_psi(bytes)?;
        psi.streams.iter().find(|(_, t)| is_self_describing_video(*t)).map(|(p, _)| *p)
    }

    fn packets_on(bytes: &[u8], pid: u16) -> Vec<&[u8]> {
        packets(bytes).filter(|p| pid_of(p) == pid).collect()
    }


    #[test]
    fn a_pluto_shaped_splice_leaves_as_one_continuous_program() {
        let program = side(0x100, 0x101, Some(0x1F6), 10_000_000);
        let ad = side(0x102, 0x101, None, 90_000);

        let mut sp = Splicer::new();
        let a = sp.normalize(&program).expect("program normalises");
        let b = sp.normalize(&ad).expect("the ad normalises onto the SAME published program");

        assert_eq!(published_video_pid(&a), Some(OUT_VIDEO_PID));
        assert_eq!(published_video_pid(&b), Some(OUT_VIDEO_PID));
        assert!(packets_on(&b, 0x102).is_empty(), "the upstream ad pid is gone from the output");

        let (sa, sb) = (scan(&a).unwrap(), scan(&b).unwrap());
        let gap = forward_gap(sa.last_dts, sb.first_dts);
        assert!(gap > 0 && gap <= HZ / 10, "the ad starts just after the program, not before it: {gap}");
    }

    #[test]
    fn the_published_pmt_is_byte_identical_across_the_splice() {
        let mut sp = Splicer::new();
        let a = sp.normalize(&side(0x100, 0x101, Some(0x1F6), 10_000_000)).unwrap();
        let b = sp.normalize(&side(0x102, 0x101, None, 90_000)).unwrap();
        assert_eq!(packets_on(&a, OUT_PMT_PID)[0][4..], packets_on(&b, OUT_PMT_PID)[0][4..]);
        assert_eq!(packets_on(&a, 0)[0][4..], packets_on(&b, 0)[0][4..], "…and so is the PAT");
    }

    #[test]
    fn the_vanishing_id3_pid_becomes_padding_and_length_is_invariant() {
        let program = side(0x100, 0x101, Some(0x1F6), 10_000_000);
        let mut sp = Splicer::new();
        let a = sp.normalize(&program).unwrap();
        assert_eq!(a.len(), program.len(), "nothing inserted, nothing dropped");
        assert!(packets_on(&a, 0x1F6).is_empty(), "the ID3 pid is not published");
        assert_eq!(packets_on(&a, 0x1FFF).len(), 3, "…it became padding instead");
    }

    #[test]
    fn continuity_counters_are_one_sequence_across_the_splice() {
        let mut sp = Splicer::new();
        let a = sp.normalize(&side(0x100, 0x101, Some(0x1F6), 10_000_000)).unwrap();
        let b = sp.normalize(&side(0x102, 0x101, None, 90_000)).unwrap();
        let last = packets_on(&a, OUT_VIDEO_PID).last().unwrap()[3] & 0x0F;
        let first = packets_on(&b, OUT_VIDEO_PID)[0][3] & 0x0F;
        assert_eq!(first, (last + 1) & 0x0F, "the published counter continues through the join");
    }

    #[test]
    fn the_discontinuity_indicator_stays_cleared_through_a_splice() {
        let mut sp = Splicer::new();
        let a = sp.normalize(&side(0x100, 0x101, Some(0x1F6), 10_000_000)).unwrap();
        let b = sp.normalize(&side(0x102, 0x101, None, 90_000)).unwrap();
        for out in [&a, &b] {
            for p in packets(out) {
                let afc = (p[3] >> 4) & 0b11;
                if (afc == 0b10 || afc == 0b11) && p[4] > 0 {
                    assert_eq!(p[5] & 0x80, 0, "discontinuity_indicator must not survive");
                }
            }
        }
    }

    #[test]
    fn an_unpublishable_program_is_declined_rather_than_silently_stripped() {
        let f = HZ / 25;
        let mut s = Vec::new();
        s.extend(pat_for(PMTPID));
        s.extend(pmt_for(PMTPID, 0x100, &[(0x1B, 0x100), (0x81, 0x101)]));
        s.extend(pkt(0x100, true, Some(0), &pes(0xE0, f, Some(0))));
        assert!(Splicer::new().normalize(&s).is_none(), "declines rather than publishing without the audio");
    }

    fn seg_with(streams: &[(u8, u16)], base: u64) -> Vec<u8> {
        let f = HZ / 25;
        let vpid = streams.iter().find(|(t, _)| *t == 0x1B).map(|(_, p)| *p).expect("a video stream");
        let mut s = Vec::new();
        s.extend(pat_for(PMTPID));
        s.extend(pmt_for(PMTPID, vpid, streams));
        for i in 0..3u64 {
            let dts = base + i * f;
            s.extend(pkt(vpid, true, Some(dts), &pes(0xE0, dts + f, Some(dts))));
            for (_, p) in streams.iter().filter(|(t, _)| *t != 0x1B) {
                s.extend(pkt(*p, true, None, &pes(0xC0, dts, None)));
            }
        }
        s
    }

    #[test]
    fn a_video_only_program_is_never_locked_as_the_published_layout() {
        let s = seg_with(&[(0x1B, 0x100)], 0);
        assert!(Splicer::new().normalize(&s).is_none(), "declines rather than locking audio out of the session");
    }

    #[test]
    fn audio_survives_a_session_that_opened_on_a_video_only_segment() {
        let mut sp = Splicer::new();
        assert!(sp.normalize(&seg_with(&[(0x1B, 0x100)], 0)).is_none());

        let a = sp.normalize(&side(0x200, 0x201, None, 10_000_000)).expect("a normal segment still normalises");
        assert!(!packets_on(&a, OUT_AUDIO_BASE).is_empty(), "audio is published on the canonical pid…");
        assert!(packets_on(&a, 0x201).is_empty(), "…and no longer on the upstream one");
    }

    #[test]
    fn a_segment_carrying_more_audio_than_the_layout_is_declined_not_stripped() {
        let mut sp = Splicer::new();
        sp.normalize(&seg_with(&[(0x1B, 0x100), (0x0F, 0x101)], 0)).expect("locks on one audio track");

        let two = seg_with(&[(0x1B, 0x100), (0x0F, 0x101), (0x0F, 0x102)], 10_000_000);
        assert!(sp.normalize(&two).is_none(), "declines rather than dropping the second track");
    }

    #[test]
    fn a_multi_track_layout_still_publishes_every_track() {
        let mut sp = Splicer::new();
        let a = sp
            .normalize(&seg_with(&[(0x1B, 0x200), (0x0F, 0x201), (0x0F, 0x202)], 0))
            .expect("two audio tracks are publishable");
        assert!(!packets_on(&a, OUT_AUDIO_BASE).is_empty(), "first track published");
        assert!(!packets_on(&a, OUT_AUDIO_BASE + 1).is_empty(), "second track published");
    }

    #[test]
    fn a_segment_whose_pcr_is_not_on_a_published_pid_is_declined() {
        let f = HZ / 25;
        let mut s = Vec::new();
        s.extend(pat_for(PMTPID));
        s.extend(pmt_for(PMTPID, 0x1F6, &[(0x1B, 0x100), (0x0F, 0x101), (0x15, 0x1F6)]));
        s.extend(pkt(0x100, true, Some(0), &pes(0xE0, f, Some(0))));
        assert!(Splicer::new().normalize(&s).is_none());
    }


    fn video_lane(vpid: u16, base: u64) -> Vec<u8> {
        let f = HZ / 25;
        let mut s = Vec::new();
        s.extend(pat_for(PMTPID));
        s.extend(pmt_for(PMTPID, vpid, &[(0x1B, vpid)]));
        for i in 0..3u64 {
            let dts = base + i * f;
            s.extend(pkt(vpid, true, Some(dts), &pes(0xE0, dts + f, Some(dts))));
        }
        s
    }

    fn audio_lane(apid: u16, base: u64) -> Vec<u8> {
        let f = HZ / 25;
        let mut s = Vec::new();
        s.extend(pat_for(PMTPID));
        s.extend(pmt_for(PMTPID, apid, &[(0x0F, apid)]));
        for i in 0..3u64 {
            let pts = base + i * f;
            s.extend(pkt(apid, true, Some(pts), &pes(0xC0, pts, None)));
        }
        s
    }

    fn first_stamp(bytes: &[u8], pid: u16) -> (Option<u64>, Option<u64>) {
        packets_on(bytes, pid)
            .into_iter()
            .find(|p| p[1] & 0x40 != 0)
            .and_then(pes_timestamps)
            .expect("a PES header on that pid")
    }

    #[test]
    fn a_demuxed_pair_republishes_both_lanes_on_the_canonical_pids() {
        let mut ps = PairSplicer::new();
        ps.normalize_pair(&video_lane(0x100, 0), &audio_lane(0x201, 0)).expect("program pair");
        let (v, a) = ps
            .normalize_pair(&video_lane(0x102, 5_000_000), &audio_lane(0x333, 5_000_000))
            .expect("ad pair with both pids moved");
        assert!(!packets_on(&v, OUT_VIDEO_PID).is_empty(), "video on the canonical pid…");
        assert!(packets_on(&v, 0x102).is_empty(), "…and not on the ad's own");
        assert!(!packets_on(&a, OUT_AUDIO_BASE).is_empty(), "audio on the canonical pid…");
        assert!(packets_on(&a, 0x333).is_empty(), "…and not on the ad's own");
    }

    #[test]
    fn a_demuxed_pair_shares_one_offset_so_the_av_skew_survives_bit_exactly() {
        const SKEW: u64 = 3_000;
        let mut ps = PairSplicer::new();
        ps.normalize_pair(&video_lane(0x100, 1_000_000), &audio_lane(0x201, 1_000_000 + SKEW)).expect("anchor");
        let (v, a) = ps
            .normalize_pair(&video_lane(0x102, 9_000_000), &audio_lane(0x203, 9_000_000 + SKEW))
            .expect("joins the running timeline");
        let vdts = first_stamp(&v, OUT_VIDEO_PID).1.expect("video DTS");
        let apts = first_stamp(&a, OUT_AUDIO_BASE).0.expect("audio PTS");
        assert_eq!(apts.wrapping_sub(vdts) & CLOCK_MASK, SKEW, "the authored skew is preserved exactly");
    }

    #[test]
    fn a_declined_pair_leaves_the_timeline_and_both_counter_spaces_untouched() {
        let mut ps = PairSplicer::new();
        ps.normalize_pair(&video_lane(0x100, 1_000_000), &audio_lane(0x201, 1_000_000)).expect("anchor");
        let before_dts = ps.clock.last_dts;
        let before_vcc = ps.clock.cc.clone();
        let before_acc = ps.audio_cc.clone();
        let bad = seg_with(&[(0x1B, 0x400), (0x0F, 0x401)], 5_000_000);
        assert!(ps.normalize_pair(&video_lane(0x100, 5_000_000), &bad).is_none(), "all-or-nothing");
        assert_eq!(ps.clock.last_dts, before_dts, "the clock must not advance on a declined pair");
        assert_eq!(ps.clock.cc, before_vcc, "nor may the video lane's continuity counters");
        assert_eq!(ps.audio_cc, before_acc, "nor the audio lane's");
    }

    #[test]
    fn a_rendition_on_an_independent_timebase_is_declined_rather_than_desynced() {
        let mut ps = PairSplicer::new();
        ps.normalize_pair(&video_lane(0x100, 1_000_000), &audio_lane(0x201, 1_003_000)).expect("latches skew");
        assert!(
            ps.normalize_pair(&video_lane(0x100, 2_000_000), &audio_lane(0x201, 2_004_920)).is_some(),
            "frame-grid jitter is not drift"
        );
        assert!(
            ps.normalize_pair(&video_lane(0x100, 3_000_000), &audio_lane(0x201, 3_093_000)).is_none(),
            "declines rather than publishing a pair it cannot hold together"
        );
    }

    #[test]
    fn the_muxed_predicates_keep_their_original_blast_radius() {
        let vpsi = read_psi(&video_lane(0x100, 0)).unwrap();
        assert!(Layout::lock(&vpsi, LayoutMode::Muxed).is_none(), "video-only is still not a muxed program");
        assert!(Layout::lock(&vpsi, LayoutMode::AudioOnly).is_none());
        assert!(Layout::lock(&vpsi, LayoutMode::VideoOnly).is_some());

        let apsi = read_psi(&audio_lane(0x201, 0)).unwrap();
        assert!(Layout::lock(&apsi, LayoutMode::Muxed).is_none(), "audio-only is not a muxed program either");
        assert!(Layout::lock(&apsi, LayoutMode::VideoOnly).is_none());
        assert!(Layout::lock(&apsi, LayoutMode::AudioOnly).is_some());

        let mpsi = read_psi(&seg_with(&[(0x1B, 0x100), (0x0F, 0x101)], 0)).unwrap();
        assert!(Layout::lock(&mpsi, LayoutMode::Muxed).is_some());
        assert!(Layout::lock(&mpsi, LayoutMode::AudioOnly).is_none());
    }

    #[test]
    fn the_video_lane_drops_audio_a_muxed_ad_brought_with_it() {
        let mut ps = PairSplicer::new();
        ps.normalize_pair(&video_lane(0x100, 0), &audio_lane(0x201, 0)).expect("program pair");

        let muxed_ad = seg_with(&[(0x1B, 0x140), (0x0F, 0x141)], 5_000_000);
        let (v, a) = ps
            .normalize_pair(&muxed_ad, &audio_lane(0x333, 5_000_000))
            .expect("a muxed ad on the video lane must not decline the pair");
        assert!(!packets_on(&v, OUT_VIDEO_PID).is_empty(), "the ad's video is republished");
        assert!(packets_on(&v, OUT_AUDIO_BASE).is_empty(), "…and its duplicate audio is NOT on the video lane");
        assert!(packets_on(&v, 0x141).is_empty(), "…nor left on the upstream pid");
        assert!(!packets_on(&a, OUT_AUDIO_BASE).is_empty(), "the audio lane still carries the sound");
        assert_eq!(v.len(), muxed_ad.len(), "dropping a track must not resize the segment");
    }

    #[test]
    fn an_audio_lane_that_declares_no_pcr_locks_and_keeps_declaring_none() {
        let f = HZ / 25;
        let no_pcr = |base: u64| {
            let mut s = Vec::new();
            s.extend(pat_for(PMTPID));
            s.extend(pmt_for(PMTPID, NO_PCR, &[(0x0F, 0x201)]));
            for i in 0..3u64 {
                let pts = base + i * f;
                s.extend(pkt(0x201, true, None, &pes(0xC0, pts, None)));
            }
            s
        };
        let psi = read_psi(&no_pcr(0)).unwrap();
        let layout = Layout::lock(&psi, LayoutMode::AudioOnly).expect("no PCR is a legal audio rendition");
        assert!(layout.map(&psi).is_some());
        let with_pcr = read_psi(&audio_lane(0x201, 0)).unwrap();
        assert!(layout.map(&with_pcr).is_none(), "the published table's clock reference cannot move");
    }

    #[test]
    fn reset_re_anchors_the_timeline_after_a_ring_skip() {
        let mut sp = Splicer::new();
        let a = sp.normalize(&side(0x100, 0x101, None, 10_000_000)).unwrap();
        sp.reset();
        let b = sp.normalize(&side(0x100, 0x101, None, 90_000)).unwrap();
        assert_eq!(scan(&b).unwrap().first_dts, 90_000);
        assert_ne!(scan(&a).unwrap().first_dts, scan(&b).unwrap().first_dts);
    }

    #[test]
    fn psi_sections_carry_a_valid_mpeg_crc() {
        for section in [build_pat(), build_pmt(OUT_VIDEO_PID, &[(0x1B, OUT_VIDEO_PID), (0x0F, OUT_AUDIO_BASE)])] {
            let (body, crc) = section.split_at(section.len() - 4);
            assert_eq!(crc32_mpeg(body).to_be_bytes(), crc, "CRC-32/MPEG-2 over the section body");
            let declared = (((section[1] & 0x0F) as usize) << 8) | section[2] as usize;
            assert_eq!(declared, section.len() - 3);
        }
    }

    #[test]
    fn a_run_of_fresh_segments_adds_no_phantom_time() {
        const N: u64 = 12;
        let f = HZ / 25;
        let mut sp = Splicer::new();
        let (mut first, mut last) = (None, 0u64);
        for i in 0..N {
            let out = sp.normalize(&side(0x100, 0x101, None, 1_000_000 + i * 3 * f)).unwrap();
            let s = scan(&out).unwrap();
            first.get_or_insert(s.first_dts);
            last = s.last_dts;
        }
        assert_eq!(forward_gap(first.unwrap(), last), (N * 3 - 1) * f, "no join may invent time");
    }

    #[test]
    fn a_repeat_still_clears_the_originals_presentation() {
        let seg = segment(1_000_000, 0);
        let mut n = Normalizer::new();
        let a = n.rewrite(&seg, None, true).unwrap();
        let b = n.rewrite(&seg, None, true).unwrap();
        let (sa, sb) = (scan(&a).unwrap(), scan(&b).unwrap());
        assert!(
            forward_gap(sa.max_pts, sb.first_dts) < CLOCK_WRAP / 2 && sb.first_dts != sa.max_pts,
            "the repeat must start strictly after everything the original presented"
        );
    }

    #[test]
    fn has_timeline_distinguishes_anchoring_from_joining() {
        let mut sp = Splicer::new();
        assert!(!sp.has_timeline(), "a fresh splicer anchors");
        sp.normalize(&side(0x100, 0x101, None, 10_000_000)).unwrap();
        assert!(sp.has_timeline(), "…and joins from then on");
        sp.reset();
        assert!(!sp.has_timeline(), "reset returns it to anchoring");
    }


    #[test]
    fn timestamp_codec_round_trips_byte_identically() {
        for prefix in [0x20u8, 0x30, 0x10] {
            for v in [0u64, 1, 90_000, 0x1_2345_6789, CLOCK_MASK] {
                let mut b = [prefix, 0, 0, 0, 0];
                write_ts(&mut b, v);
                assert_eq!(read_ts(&b), v, "value survives the marker-bit layout");
                let before = b;
                let decoded = read_ts(&b);
                write_ts(&mut b, decoded);
                assert_eq!(b, before, "re-encoding what we decoded changes nothing");
                assert_eq!(b[0] & 0xF0, prefix & 0xF0, "the prefix nibble is preserved, not re-derived");
                assert!(b[0] & 1 == 1 && b[2] & 1 == 1 && b[4] & 1 == 1, "all three markers set");
            }
        }
    }

    #[test]
    fn pcr_shift_preserves_the_reserved_bits_and_extension() {
        let mut b = [0u8; 6];
        b[4] = 0x7E;
        b[5] = 0xA5;
        shift_pcr(&mut b, 0);
        assert_eq!(b[4] & 0x7F, 0x7E, "6 reserved bits + ext[8] survive a zero shift");
        assert_eq!(b[5], 0xA5, "ext[7:0] is never touched");
        shift_pcr(&mut b, HZ);
        assert_eq!(b[4] & 0x7F, 0x7E, "…and survive a real shift too");
        assert_eq!(b[5], 0xA5);
    }


    #[test]
    fn a_repeated_segment_is_rebased_onto_a_forward_timeline() {
        let seg = segment(1_000_000, 0);
        let s0 = scan(&seg).unwrap();
        let mut n = Normalizer::new();
        let a = n.rewrite(&seg, None, true).expect("rebase");
        let sa = scan(&a).unwrap();
        assert_eq!(sa.first_dts, s0.first_dts, "a fresh timeline does not move the first segment");
        assert_eq!(sa.last_dts, s0.last_dts);

        let b = n.rewrite(&seg, None, true).expect("rebase");
        let sb = scan(&b).unwrap();
        assert_ne!(b, seg, "a repeat must be moved");
        assert_eq!(forward_gap(sa.max_pts, sb.first_dts), HZ / 25, "one frame past the original's last PTS");
        assert!(forward_gap(sa.last_dts, sb.first_dts) < CLOCK_WRAP / 2, "and strictly forward in decode order");
    }

    #[test]
    fn length_and_framing_are_invariant() {
        let seg = segment(500_000, 0);
        let mut n = Normalizer::new();
        n.rewrite(&seg, None, true).unwrap();
        let out = n.rewrite(&seg, None, true).unwrap();
        assert_eq!(out.len(), seg.len(), "no field may be inserted, dropped or resized");
        for i in (0..out.len()).step_by(PKT) {
            assert_eq!(out[i], SYNC, "every 188th byte is still a sync byte");
        }
    }

    #[test]
    fn audio_video_skew_survives_bit_exactly() {
        let skew = 1_234u64;
        let seg = segment(2_000_000, skew);
        let mut n = Normalizer::new();
        n.rewrite(&seg, None, true).unwrap();
        let out = n.rewrite(&seg, None, true).unwrap();

        let stamps = |b: &[u8], want: u16| -> Vec<u64> {
            packets(b)
                .filter(|p| pid_of(p) == want && p[1] & 0x40 != 0)
                .filter_map(|p| pes_timestamps(p).and_then(|(pts, _)| pts))
                .collect()
        };
        let (vin, ain) = (stamps(&seg, VPID), stamps(&seg, APID));
        let (vout, aout) = (stamps(&out, VPID), stamps(&out, APID));
        assert_eq!(vin.len(), 3);
        assert_eq!(vout.len(), 3);
        for i in 0..3 {
            assert_eq!(
                forward_gap(vin[i], ain[i]),
                forward_gap(vout[i], aout[i]),
                "frame {i}: audio/video skew must be unchanged"
            );
        }
    }

    #[test]
    fn continuity_counters_are_continuous_across_a_repeat() {
        let seg = segment(3_000_000, 0);
        let mut n = Normalizer::new();
        let a = n.rewrite(&seg, None, true).unwrap();
        let b = n.rewrite(&seg, None, true).unwrap();
        let mut joined = a.clone();
        joined.extend_from_slice(&b);
        let mut expect: HashMap<u16, u8> = HashMap::new();
        for p in packets(&joined) {
            let afc = (p[3] >> 4) & 0b11;
            if afc != 0b01 && afc != 0b11 {
                continue;
            }
            let pid = pid_of(p);
            let cc = p[3] & 0x0F;
            if let Some(want) = expect.get(&pid) {
                assert_eq!(cc, *want, "pid {pid:#x}: a repeat must not restart the counter");
            }
            expect.insert(pid, (cc + 1) & 0x0F);
        }
    }

    #[test]
    fn the_discontinuity_indicator_is_cleared() {
        let seg = segment(4_000_000, 0);
        assert!(packets(&seg).any(|p| (p[3] >> 4) & 0b11 == 0b11 && p[4] > 0 && p[5] & 0x80 != 0));
        let mut n = Normalizer::new();
        n.rewrite(&seg, None, true).unwrap();
        let out = n.rewrite(&seg, None, true).unwrap();
        assert!(
            !packets(&out).any(|p| (p[3] >> 4) & 0b11 == 0b11 && p[4] > 0 && p[5] & 0x80 != 0),
            "no rewritten packet may still assert a discontinuity"
        );
    }

    #[test]
    fn pcr_moves_with_the_pes_stamps() {
        let seg = segment(5_000_000, 0);
        let mut n = Normalizer::new();
        n.rewrite(&seg, None, true).unwrap();
        let out = n.rewrite(&seg, None, true).unwrap();
        let pcrs = |b: &[u8]| -> Vec<u64> {
            packets(b)
                .filter(|p| (p[3] >> 4) & 0b11 == 0b11 && p[4] >= 7 && p[5] & 0x10 != 0)
                .map(|p| {
                    ((p[6] as u64) << 25)
                        | ((p[7] as u64) << 17)
                        | ((p[8] as u64) << 9)
                        | ((p[9] as u64) << 1)
                        | ((p[10] as u64) >> 7)
                })
                .collect()
        };
        let (a, b) = (pcrs(&seg), pcrs(&out));
        assert_eq!(a.len(), 3);
        let delta = forward_gap(a[0], b[0]);
        assert!(delta > 0, "the PCR must have moved");
        for i in 0..a.len() {
            assert_eq!(forward_gap(a[i], b[i]), delta, "every clock shifts by the SAME offset");
        }
    }

    #[test]
    fn a_wrap_straddling_join_produces_a_small_forward_delta() {
        let seg = segment(CLOCK_MASK - 5_000, 0);
        let mut n = Normalizer::new();
        let a = n.rewrite(&seg, None, true).unwrap();
        let b = n.rewrite(&seg, None, true).unwrap();
        let (sa, sb) = (scan(&a).unwrap(), scan(&b).unwrap());
        assert_eq!(forward_gap(sa.max_pts, sb.first_dts), HZ / 25, "the join is one frame even across the wrap");
        assert!(sa.first_dts > sa.max_pts, "the fixture really does straddle the rollover");
    }

    #[test]
    fn two_different_segments_join_exactly_one_frame_apart() {
        let first = segment(7_000_000, 0);
        let mut n = Normalizer::new();
        let a = n.rewrite(&first, None, false).unwrap();
        let b = n.rewrite(&segment(1_000, 0), None, false).unwrap();
        let (sa, sb) = (scan(&a).unwrap(), scan(&b).unwrap());
        assert_eq!(forward_gap(sa.last_dts, sb.first_dts), HZ / 25);
    }


    #[test]
    fn declines_a_segment_with_no_psi() {
        let mut n = Normalizer::new();
        assert!(n.rewrite(&pkt(VPID, true, None, &pes(0xE0, 90_000, None)), None, true).is_none());
    }

    #[test]
    fn declines_scrambled_and_timestampless_segments() {
        let mut scrambled = segment(1_000, 0);
        for i in (0..scrambled.len()).step_by(PKT) {
            scrambled[i + 3] |= 0xC0;
        }
        let mut n = Normalizer::new();
        assert!(n.rewrite(&scrambled, None, true).is_none(), "a scrambled payload hides the PES header");

        let mut psi_only = Vec::new();
        psi_only.extend(pat());
        psi_only.extend(pmt());
        assert!(n.rewrite(&psi_only, None, true).is_none(), "no video stamps ⇒ nothing to anchor a timeline on");
    }

    #[test]
    fn declines_a_pes_carrying_an_escr() {
        let mut seg = segment(1_000, 0);
        for i in (0..seg.len()).step_by(PKT) {
            let p = &mut seg[i..i + PKT];
            if pid_of(p) == VPID && p[1] & 0x40 != 0 {
                let off = 5 + p[4] as usize;
                p[off + 7] |= 0x20;
                break;
            }
        }
        let mut n = Normalizer::new();
        assert!(n.rewrite(&seg, None, true).is_none());
    }

    #[test]
    fn reset_forgets_the_timeline() {
        let seg = segment(9_000_000, 0);
        let mut n = Normalizer::new();
        n.rewrite(&seg, None, true).unwrap();
        n.reset();
        let after = n.rewrite(&seg, None, true).unwrap();
        assert_eq!(scan(&after).unwrap().first_dts, scan(&seg).unwrap().first_dts, "offset is zero again");
    }


    fn segment_of_97_packets() -> Vec<u8> {
        let mut s = side(0x100, 0x101, None, 10_000_000);
        while s.len() < 97 * PKT {
            s.extend(pkt(0x1FFF, false, None, &[]));
        }
        s
    }

    #[test]
    fn a_disguised_segment_with_a_sync_byte_in_its_size_fields_declines() {
        let wrapped = crate::tsseg::webp_disguise(&segment_of_97_packets());
        assert_eq!((wrapped[5], wrapped[39]), (SYNC, SYNC), "fixture sanity: a 0x47 in each size field");
        assert!(Splicer::new().normalize(&wrapped).is_none(), "the PAT is swallowed by a packet that is not one");
    }

    #[test]
    fn the_same_segment_normalises_once_unwrapped() {
        let seg = segment_of_97_packets();
        let wrapped = crate::tsseg::webp_disguise(&seg);
        let n = crate::tsseg::disguise_prefix_len(&wrapped).expect("the disguise is seen through");
        let out = Splicer::new().normalize(&wrapped[n..]).expect("clean TS normalises");
        assert_eq!(out.len(), seg.len(), "length-invariant, as ever");
        assert_eq!(published_video_pid(&out), Some(OUT_VIDEO_PID));
    }
}
