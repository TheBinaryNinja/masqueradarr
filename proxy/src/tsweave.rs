
use crate::tsnorm::{
    build_pat, build_pmt, forward_gap, packets, pes_timestamps, pid_of, write_section, CLOCK_MASK, CLOCK_WRAP,
    OUT_AUDIO_BASE, OUT_PMT_PID, OUT_VIDEO_PID,
};
use crate::tsseg::{parse_pat, parse_pmt, PmtInfo, PKT, SYNC};

const NULL_PID: u16 = 0x1FFF;

const PSI_INTERVAL_PKTS: usize = 250;

const ANCHOR_BACKSTOP: u64 = 2 * 90_000;

const MAX_CARRY_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Src {
    Carry,
    Video,
    Audio,
}

#[derive(Clone, Copy, Debug)]
struct Unit {
    key: Option<u64>,
    pid: u16,
    src: Src,
    start: usize,
    len: usize,
}

struct CombinedPsi {
    pat_pkt: [u8; PKT],
    pmt_pkt: [u8; PKT],
    streams: Vec<(u8, u16)>,
    pids: Vec<u16>,
}

pub(crate) struct PairWeaver {
    pair: crate::tsnorm::PairSplicer,
    psi: Option<CombinedPsi>,
    pat_cc: u8,
    pmt_cc: u8,
    carry_buf: Vec<u8>,
    carry_units: Vec<Unit>,
    since_psi: usize,
    last_decline: String,
    last_slug: &'static str,
}

impl PairWeaver {
    pub(crate) fn new() -> Self {
        Self {
            pair: crate::tsnorm::PairSplicer::new(),
            psi: None,
            pat_cc: 0,
            pmt_cc: 0,
            carry_buf: Vec::new(),
            carry_units: Vec::new(),
            since_psi: 0,
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
        self.pair.reset();
        self.carry_buf.clear();
        self.carry_units.clear();
    }

    pub(crate) fn weave(&mut self, video: &[u8], audio: &[u8]) -> Option<Vec<u8>> {
        macro_rules! decline {
            ($fmt:literal $(, $arg:expr)* $(,)?) => {{
                self.last_slug = $fmt;
                self.last_decline = format!($fmt $(, $arg)*);
                return None;
            }};
        }

        let (vout, aout) = match self.pair.normalize_pair(video, audio) {
            Some(p) => p,
            None => {
                self.last_slug = self.pair.last_decline_slug();
                self.last_decline = self.pair.last_decline().to_string();
                return None;
            }
        };

        let carry_buf = std::mem::take(&mut self.carry_buf);
        let carry_units = std::mem::take(&mut self.carry_units);

        let derived = match combined_psi(&vout, &aout) {
            Ok(p) => p,
            Err(why) => decline!("{why}"),
        };
        match &self.psi {
            None => self.psi = Some(derived),
            Some(locked) if locked.streams == derived.streams => {}
            Some(locked) => decline!(
                "the published program changed shape mid-socket ({} → {})",
                describe_streams(&locked.streams),
                describe_streams(&derived.streams)
            ),
        }
        let (pat_pkt, pmt_pkt, pids) = {
            let p = self.psi.as_ref()?;
            (p.pat_pkt, p.pmt_pkt, p.pids.clone())
        };

        let vunits = match lane_units(&vout, Src::Video, &pids) {
            Ok(u) => u,
            Err(why) => decline!("video lane: {why}"),
        };
        let aunits = match lane_units(&aout, Src::Audio, &pids) {
            Ok(u) => u,
            Err(why) => decline!("audio lane: {why}"),
        };
        let Some(vlast) = vunits.last().map(|u| u.key_or_zero()) else {
            decline!("video lane: no PES units to weave")
        };
        let vfirst = vunits[0].key_or_zero();

        let split = aunits.partition_point(|u| !is_forward(vlast, u.key_or_zero()));
        let carry_bytes: usize = aunits[split..].iter().map(|u| u.len).sum();
        let split = if carry_bytes > MAX_CARRY_BYTES { aunits.len() } else { split };

        let mut back = ANCHOR_BACKSTOP;
        for u in carry_units.iter().chain(vunits.iter()).chain(aunits[..split].iter()) {
            let Some(k) = u.key else { continue };
            let lead = forward_gap(k, vfirst);
            if lead < CLOCK_WRAP / 2 && lead > back {
                back = lead;
            }
        }
        let anchor = vfirst.wrapping_sub(back) & CLOCK_MASK;
        let mut all: Vec<Unit> = Vec::with_capacity(carry_units.len() + vunits.len() + aunits.len());
        all.extend_from_slice(&carry_units);
        all.extend_from_slice(&vunits);
        all.extend_from_slice(&aunits[..split]);
        all.sort_by_key(|u| forward_gap(anchor, u.key_or_zero()));

        let mut out: Vec<u8> = Vec::with_capacity(vout.len() + aout.len() + carry_buf.len() + 2 * PKT);
        self.since_psi = PSI_INTERVAL_PKTS;
        for u in &all {
            if self.since_psi >= PSI_INTERVAL_PKTS {
                let mut p = pat_pkt;
                p[3] = 0x10 | (self.pat_cc & 0x0F);
                self.pat_cc = (self.pat_cc + 1) & 0x0F;
                out.extend_from_slice(&p);
                let mut p = pmt_pkt;
                p[3] = 0x10 | (self.pmt_cc & 0x0F);
                self.pmt_cc = (self.pmt_cc + 1) & 0x0F;
                out.extend_from_slice(&p);
                self.since_psi = 0;
            }
            let buf = match u.src {
                Src::Carry => &carry_buf,
                Src::Video => &vout,
                Src::Audio => &aout,
            };
            out.extend_from_slice(&buf[u.start..u.start + u.len]);
            self.since_psi += u.len / PKT;
        }

        for u in &aunits[split..] {
            self.carry_units.push(Unit { src: Src::Carry, start: self.carry_buf.len(), ..*u });
            self.carry_buf.extend_from_slice(&aout[u.start..u.start + u.len]);
        }
        Some(out)
    }
}

impl Unit {
    fn key_or_zero(&self) -> u64 {
        self.key.unwrap_or(0)
    }
}

fn is_forward(a: u64, b: u64) -> bool {
    let g = forward_gap(a, b);
    g > 0 && g < CLOCK_WRAP / 2
}

fn describe_streams(streams: &[(u8, u16)]) -> String {
    let s: Vec<String> = streams.iter().map(|(t, p)| format!("{p:#x}:{t:#04x}")).collect();
    format!("[{}]", s.join(" "))
}

fn lane_units(lane: &[u8], src: Src, allowed: &[u16]) -> Result<Vec<Unit>, String> {
    let mut units: Vec<Unit> = Vec::new();
    let mut cur_pid: Option<u16> = None;
    let mut i = 0usize;
    while i + PKT <= lane.len() {
        if lane[i] != SYNC {
            i += 1;
            continue;
        }
        let pkt = &lane[i..i + PKT];
        let pid = pid_of(pkt);
        if pid == 0 || pid == OUT_PMT_PID || pid == NULL_PID {
            cur_pid = None;
            i += PKT;
            continue;
        }
        if !allowed.contains(&pid) {
            return Err(format!("packet on pid {pid:#x}, which the published program does not declare"));
        }
        let pusi = pkt[1] & 0x40 != 0;
        if pusi || cur_pid != Some(pid) {
            let key = if pusi { pes_timestamps(pkt).and_then(|(pts, dts)| dts.or(pts)) } else { None };
            units.push(Unit { key, pid, src, start: i, len: PKT });
            cur_pid = Some(pid);
        } else {
            units.last_mut().expect("cur_pid is Some, so a unit is open").len += PKT;
        }
        i += PKT;
    }
    resolve_keys(&mut units)?;
    Ok(units)
}

fn resolve_keys(units: &mut [Unit]) -> Result<(), String> {
    let mut last: Vec<(u16, u64)> = Vec::new();
    for u in units.iter_mut() {
        let (pid, key) = (u.pid, u.key);
        match key {
            Some(k) => match last.iter_mut().find(|(p, _)| *p == pid) {
                Some(e) => e.1 = k,
                None => last.push((pid, k)),
            },
            None => u.key = last.iter().find(|(p, _)| *p == pid).map(|(_, k)| *k),
        }
    }
    let mut next: Vec<(u16, u64)> = Vec::new();
    for u in units.iter_mut().rev() {
        let (pid, key) = (u.pid, u.key);
        match key {
            Some(k) => match next.iter_mut().find(|(p, _)| *p == pid) {
                Some(e) => e.1 = k,
                None => next.push((pid, k)),
            },
            None => match next.iter().find(|(p, _)| *p == pid) {
                Some((_, k)) => u.key = Some(*k),
                None => {
                    return Err(format!("pid {pid:#x} carries no PES timestamp anywhere in the segment"))
                }
            },
        }
    }
    Ok(())
}

fn combined_psi(vout: &[u8], aout: &[u8]) -> Result<CombinedPsi, String> {
    let v = lane_pmt(vout).ok_or("video lane: the rewritten lane carries no PAT/PMT")?;
    let a = lane_pmt(aout).ok_or("audio lane: the rewritten lane carries no PAT/PMT")?;
    if v.pcr_pid != OUT_VIDEO_PID {
        return Err(format!("video lane declares PCR on {:#x}, not the published video pid", v.pcr_pid));
    }
    let mut streams: Vec<(u8, u16)> = v.streams.iter().map(|&(pid, t)| (t, pid)).collect();
    if !streams.iter().any(|&(_, pid)| pid == OUT_VIDEO_PID) {
        return Err("video lane publishes no stream on the canonical video pid".to_string());
    }
    for &(pid, t) in &a.streams {
        if streams.iter().any(|&(_, p)| p == pid) {
            return Err(format!("the two lanes both publish pid {pid:#x}"));
        }
        streams.push((t, pid));
    }
    if !streams.iter().any(|&(_, pid)| pid == OUT_AUDIO_BASE) {
        return Err("audio lane publishes no stream on the canonical audio pid".to_string());
    }
    let mut pat_pkt = [0u8; PKT];
    write_section(&mut pat_pkt, 0, &build_pat()).ok_or("the authored PAT does not fit one packet")?;
    let mut pmt_pkt = [0u8; PKT];
    write_section(&mut pmt_pkt, OUT_PMT_PID, &build_pmt(OUT_VIDEO_PID, &streams))
        .ok_or("the authored PMT does not fit one packet")?;
    let pids = streams.iter().map(|&(_, pid)| pid).collect();
    Ok(CombinedPsi { pat_pkt, pmt_pkt, streams, pids })
}

fn lane_pmt(lane: &[u8]) -> Option<PmtInfo> {
    let mut pmt_pid: Option<u16> = None;
    for pkt in packets(lane) {
        let pid = pid_of(pkt);
        if pid == 0 {
            if pmt_pid.is_none() {
                pmt_pid = parse_pat(pkt);
            }
            continue;
        }
        if Some(pid) == pmt_pid {
            if let Some(m) = parse_pmt(pkt) {
                return Some(m);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const UP_VPID: u16 = 0x100;
    const UP_APID: u16 = 0x201;
    const UP_PMTPID: u16 = 0x1000;
    const HZ: u64 = 90_000;
    const F: u64 = HZ / 25;


    fn put_ts(b: &mut [u8], v: u64) {
        b[0] = (b[0] & 0xF0) | ((((v >> 30) as u8) & 0x07) << 1) | 1;
        b[1] = (v >> 22) as u8;
        b[2] = ((((v >> 15) as u8) & 0x7F) << 1) | 1;
        b[3] = (v >> 7) as u8;
        b[4] = (((v as u8) & 0x7F) << 1) | 1;
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut crc: u32 = 0xFFFF_FFFF;
        for &b in data {
            crc ^= (b as u32) << 24;
            for _ in 0..8 {
                crc = if crc & 0x8000_0000 != 0 { (crc << 1) ^ 0x04C1_1DB7 } else { crc << 1 };
            }
        }
        crc
    }

    fn finish(mut s: Vec<u8>) -> Vec<u8> {
        let len = s.len() - 3 + 4;
        s[1] = 0xB0 | ((len >> 8) as u8 & 0x0F);
        s[2] = (len & 0xFF) as u8;
        let crc = crc32(&s);
        s.extend_from_slice(&crc.to_be_bytes());
        s
    }

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
        put_ts(&mut ts, pts);
        v.extend_from_slice(&ts);
        if let Some(d) = dts {
            let mut t = [0u8; 5];
            t[0] = 0x10;
            put_ts(&mut t, d);
            v.extend_from_slice(&t);
        }
        v.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]);
        v
    }

    fn pat_for(pmt_pid: u16) -> Vec<u8> {
        let mut s = vec![0x00, 0x00, 0x00, 0x00, 0x01, 0xC1, 0x00, 0x00];
        s.extend_from_slice(&1u16.to_be_bytes());
        s.extend_from_slice(&(0xE000 | pmt_pid).to_be_bytes());
        let mut body = vec![0x00];
        body.extend_from_slice(&finish(s));
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
        body.extend_from_slice(&finish(s));
        pkt(pmt_pid, true, None, &body)
    }

    fn video_lane(base: u64, frames: u64) -> Vec<u8> {
        let mut s = Vec::new();
        s.extend(pat_for(UP_PMTPID));
        s.extend(pmt_for(UP_PMTPID, UP_VPID, &[(0x1B, UP_VPID)]));
        for i in 0..frames {
            let dts = base + i * F;
            s.extend(pkt(UP_VPID, true, Some(dts), &pes(0xE0, dts + F, Some(dts))));
        }
        s
    }

    fn audio_lane(base: u64, frames: u64) -> Vec<u8> {
        audio_lane_on(&[UP_APID], base, frames)
    }

    fn audio_lane_on(apids: &[u16], base: u64, frames: u64) -> Vec<u8> {
        let streams: Vec<(u8, u16)> = apids.iter().map(|&p| (0x0Fu8, p)).collect();
        let mut s = Vec::new();
        s.extend(pat_for(UP_PMTPID));
        s.extend(pmt_for(UP_PMTPID, apids[0], &streams));
        for i in 0..frames {
            let pts = base + i * F;
            for (n, &p) in apids.iter().enumerate() {
                s.extend(pkt(p, true, (n == 0).then_some(pts), &pes(0xC0, pts, None)));
            }
        }
        s
    }

    fn pair(base: u64, skew: u64, frames: u64) -> (Vec<u8>, Vec<u8>) {
        (video_lane(base, frames), audio_lane(base.wrapping_add(skew), frames))
    }


    fn packets_of(bytes: &[u8]) -> Vec<&[u8]> {
        packets(bytes).collect()
    }

    fn packets_on(bytes: &[u8], pid: u16) -> Vec<&[u8]> {
        packets(bytes).filter(|p| pid_of(p) == pid).collect()
    }

    fn keys_in_order(bytes: &[u8]) -> Vec<(u16, u64)> {
        packets(bytes)
            .filter(|p| p[1] & 0x40 != 0)
            .filter(|p| !matches!(pid_of(p), 0 | OUT_PMT_PID | NULL_PID))
            .filter_map(|p| pes_timestamps(p).and_then(|(pts, dts)| dts.or(pts)).map(|k| (pid_of(p), k)))
            .collect()
    }

    fn pcr_of(p: &[u8]) -> Option<u64> {
        let afc = (p[3] >> 4) & 0b11;
        if afc != 0b10 && afc != 0b11 {
            return None;
        }
        if p[4] == 0 || p[5] & 0x10 == 0 {
            return None;
        }
        Some(
            ((p[6] as u64) << 25)
                | ((p[7] as u64) << 17)
                | ((p[8] as u64) << 9)
                | ((p[9] as u64) << 1)
                | ((p[10] as u64) >> 7),
        )
    }

    fn es_packets(lane: &[u8]) -> Vec<Vec<u8>> {
        packets(lane)
            .filter(|p| !matches!(pid_of(p), 0 | OUT_PMT_PID | NULL_PID))
            .map(|p| p.to_vec())
            .collect()
    }

    fn split(pairs: &[(Vec<u8>, Vec<u8>)]) -> Vec<(Vec<u8>, Vec<u8>)> {
        let mut ps = crate::tsnorm::PairSplicer::new();
        pairs
            .iter()
            .map(|(v, a)| {
                let (vo, ao) = ps.normalize_pair(v, a).expect("the fixture pair normalises");
                (vo, ao)
            })
            .collect()
    }


    #[test]
    fn a_woven_pair_carries_one_authored_program() {
        let mut w = PairWeaver::new();
        let (v, a) = pair(0, 0, 3);
        let out = w.weave(&v, &a).expect("a clean pair weaves");

        let pats = packets_on(&out, 0);
        assert!(!pats.is_empty(), "the woven stream declares a PAT");
        for p in &pats {
            assert_eq!(parse_pat(p), Some(OUT_PMT_PID), "every PAT points at the published PMT pid");
        }
        let pmts = packets_on(&out, OUT_PMT_PID);
        assert_eq!(pmts.len(), pats.len(), "a PMT accompanies every PAT");
        let m = parse_pmt(pmts[0]).expect("the published PMT parses");
        assert_eq!(m.pcr_pid, OUT_VIDEO_PID, "the clock reference is the video pid");
        assert_eq!(
            m.streams,
            vec![(OUT_VIDEO_PID, 0x1Bu8), (OUT_AUDIO_BASE, 0x0Fu8)],
            "one program carrying BOTH elementary streams, video first"
        );
        for p in &pmts {
            let (a, b) = (&p[4..], &pmts[0][4..]);
            assert_eq!(a, b, "the published PMT is byte-identical on every emission");
        }
        assert!(packets_on(&out, NULL_PID).is_empty(), "the lanes' padding is dropped, not republished");
    }

    #[test]
    fn the_emitted_psi_packets_carry_a_valid_section_crc() {
        let mut w = PairWeaver::new();
        let (v, a) = pair(0, 0, 3);
        let out = w.weave(&v, &a).expect("a clean pair weaves");
        for pid in [0, OUT_PMT_PID] {
            let p = packets_on(&out, pid)[0];
            assert_eq!(p[3] >> 4, 0b01, "payload only, so the pointer_field is at byte 4");
            assert_eq!(p[4], 0, "pointer_field");
            let s = &p[5..];
            let declared = (((s[1] & 0x0F) as usize) << 8) | s[2] as usize;
            let section = &s[..3 + declared];
            let (body, crc) = section.split_at(section.len() - 4);
            assert_eq!(crc32(body).to_be_bytes(), crc, "CRC-32/MPEG-2 over the section body");
        }
    }


    #[test]
    fn both_elementary_streams_survive_the_weave() {
        let mut w = PairWeaver::new();
        let (v, a) = pair(0, 0, 3);
        let out = w.weave(&v, &a).expect("a clean pair weaves");
        let lanes = split(&[(v, a)]);

        assert_eq!(
            packets_on(&out, OUT_VIDEO_PID).len(),
            es_packets(&lanes[0].0).len(),
            "every video packet survives"
        );
        assert_eq!(
            packets_on(&out, OUT_AUDIO_BASE).len(),
            es_packets(&lanes[0].1).len(),
            "every audio packet survives"
        );
        let known = [0u16, OUT_PMT_PID, OUT_VIDEO_PID, OUT_AUDIO_BASE];
        for p in packets_of(&out) {
            assert!(known.contains(&pid_of(p)), "no pid outside the published program leaks out");
        }
    }

    #[test]
    fn per_pid_packet_order_is_preserved() {
        let mut w = PairWeaver::new();
        let (v, a) = pair(0, 0, 4);
        let out = w.weave(&v, &a).expect("a clean pair weaves");
        let lanes = split(&[(v, a)]);

        let vs: Vec<Vec<u8>> = packets_on(&out, OUT_VIDEO_PID).iter().map(|p| p.to_vec()).collect();
        assert_eq!(vs, es_packets(&lanes[0].0), "the video lane passes through untouched, in order");
        let as_: Vec<Vec<u8>> = packets_on(&out, OUT_AUDIO_BASE).iter().map(|p| p.to_vec()).collect();
        assert_eq!(as_, es_packets(&lanes[0].1), "the audio lane passes through untouched, in order");
    }

    #[test]
    fn units_leave_in_timestamp_order() {
        let mut w = PairWeaver::new();
        let (v, a) = pair(0, 1_000, 6);
        let out = w.weave(&v, &a).expect("a clean pair weaves");
        let keys = keys_in_order(&out);
        assert!(keys.len() >= 10, "both lanes are represented ({} units)", keys.len());
        for pair_ in keys.windows(2) {
            assert!(
                forward_gap(pair_[0].1, pair_[1].1) < CLOCK_WRAP / 2,
                "units never step backwards: {:?} then {:?}",
                pair_[0],
                pair_[1]
            );
        }
        let pids: Vec<u16> = keys.iter().map(|(p, _)| *p).collect();
        assert!(
            pids.windows(2).filter(|w| w[0] != w[1]).count() >= 8,
            "the lanes interleave rather than concatenate: {pids:?}"
        );
    }

    #[test]
    fn an_audio_lane_leading_past_the_backstop_still_leaves_in_timestamp_order() {
        const LEAD: u64 = 225_000;
        let vbase: u64 = 2_000_000;
        let v = video_lane(vbase, 6);
        let a = audio_lane(vbase.wrapping_sub(LEAD) & CLOCK_MASK, 70);
        let mut w = PairWeaver::new();
        let out = w.weave(&v, &a).expect("a leading audio lane is still a publishable pair");

        let keys = keys_in_order(&out);
        assert!(keys.len() >= 10, "both lanes are represented ({} units)", keys.len());
        for w2 in keys.windows(2) {
            assert!(
                forward_gap(w2[0].1, w2[1].1) < CLOCK_WRAP / 2,
                "units never step backwards: {:?} then {:?}",
                w2[0],
                w2[1]
            );
        }
        let pids: Vec<u16> = keys.iter().map(|(p, _)| *p).collect();
        assert!(
            pids.windows(2).filter(|w| w[0] != w[1]).count() >= 8,
            "the lanes interleave rather than concatenate: {pids:?}"
        );
    }

    #[test]
    fn the_authored_av_skew_survives_the_weave() {
        const SKEW: u64 = 1_000;
        let mut w = PairWeaver::new();
        let mut out = w.weave(&pair(0, SKEW, 3).0, &pair(0, SKEW, 3).1).expect("first pair");
        out.extend(w.weave(&pair(500_000, SKEW, 3).0, &pair(500_000, SKEW, 3).1).expect("second pair"));

        let keys = keys_in_order(&out);
        let vs: Vec<u64> = keys.iter().filter(|(p, _)| *p == OUT_VIDEO_PID).map(|(_, k)| *k).collect();
        let as_: Vec<u64> = keys.iter().filter(|(p, _)| *p == OUT_AUDIO_BASE).map(|(_, k)| *k).collect();
        assert!(!as_.is_empty() && vs.len() >= as_.len());
        for (i, (v, a)) in vs.iter().zip(as_.iter()).enumerate() {
            assert_eq!(a.wrapping_sub(*v) & CLOCK_MASK, SKEW, "unit {i}: the authored skew is preserved exactly");
        }
    }

    #[test]
    fn pcr_stays_monotonic_through_the_weave() {
        let mut w = PairWeaver::new();
        let mut out = w.weave(&pair(0, 1_000, 4).0, &pair(0, 1_000, 4).1).expect("first pair");
        out.extend(w.weave(&pair(900_000, 1_000, 4).0, &pair(900_000, 1_000, 4).1).expect("second pair"));

        let pcrs: Vec<u64> = packets_on(&out, OUT_VIDEO_PID).iter().filter_map(|p| pcr_of(p)).collect();
        assert!(pcrs.len() >= 8, "the published clock reference is present ({} samples)", pcrs.len());
        for w2 in pcrs.windows(2) {
            assert!(forward_gap(w2[0], w2[1]) < CLOCK_WRAP / 2, "PCR never steps backwards: {w2:?}");
        }
    }

    #[test]
    fn continuity_counters_are_continuous_on_both_pids_across_two_pairs() {
        let mut w = PairWeaver::new();
        let mut out = w.weave(&pair(0, 1_000, 4).0, &pair(0, 1_000, 4).1).expect("first pair");
        out.extend(w.weave(&pair(700_000, 1_000, 4).0, &pair(700_000, 1_000, 4).1).expect("second pair"));

        for pid in [0u16, OUT_PMT_PID, OUT_VIDEO_PID, OUT_AUDIO_BASE] {
            let ccs: Vec<u8> = packets_on(&out, pid)
                .iter()
                .filter(|p| matches!((p[3] >> 4) & 0b11, 0b01 | 0b11))
                .map(|p| p[3] & 0x0F)
                .collect();
            assert!(ccs.len() >= 2, "pid {pid:#x} is present");
            for (i, pair_) in ccs.windows(2).enumerate() {
                assert_eq!(
                    pair_[1],
                    (pair_[0] + 1) & 0x0F,
                    "pid {pid:#x}: continuity breaks at index {i} ({ccs:?})"
                );
            }
        }
    }


    #[test]
    fn the_seam_carry_over_keeps_the_output_monotonic_across_two_pairs() {
        const SKEW: u64 = 1_000;
        let mut w = PairWeaver::new();
        let first = w.weave(&pair(0, SKEW, 3).0, &pair(0, SKEW, 3).1).expect("first pair");
        let second = w.weave(&pair(400_000, SKEW, 3).0, &pair(400_000, SKEW, 3).1).expect("second pair");

        let a1 = packets_on(&first, OUT_AUDIO_BASE).len();
        let a2 = packets_on(&second, OUT_AUDIO_BASE).len();
        assert_eq!(a1, 2, "the trailing audio unit is held back rather than emitted early");
        assert_eq!(a2, 3, "…and leads the next block, ahead of that pair's own audio");

        let mut joined = first;
        joined.extend(second);
        let keys = keys_in_order(&joined);
        for pair_ in keys.windows(2) {
            assert!(
                forward_gap(pair_[0].1, pair_[1].1) < CLOCK_WRAP / 2,
                "the seam stays monotonic: {:?} then {:?}",
                pair_[0],
                pair_[1]
            );
        }
    }

    #[test]
    fn psi_is_re_emitted_at_the_configured_cadence() {
        let mut w = PairWeaver::new();
        let (v, a) = pair(0, 0, 400);
        let out = w.weave(&v, &a).expect("a long pair weaves");
        assert!(packets_on(&out, 0).len() >= 3, "the tables recur within one long block");

        let mut run = 0usize;
        let mut worst = 0usize;
        for p in packets_of(&out) {
            if pid_of(p) == 0 {
                worst = worst.max(run);
                run = 0;
            } else if pid_of(p) != OUT_PMT_PID {
                run += 1;
            }
        }
        worst = worst.max(run);
        assert!(worst <= PSI_INTERVAL_PKTS, "no more than {PSI_INTERVAL_PKTS} packets between tables (saw {worst})");
    }


    #[test]
    fn a_pair_whose_stream_set_differs_from_the_locked_table_is_declined() {
        let mut w = PairWeaver::new();
        let (v, a) = pair(0, 0, 3);
        let first = w.weave(&v, &a).expect("the first pair locks the table");

        let v2 = video_lane(300_000, 3);
        let a2 = audio_lane_on(&[UP_APID, UP_APID + 1], 300_000, 3);
        assert!(w.weave(&v2, &a2).is_none(), "the splicer's locked audio layout declines the extra track");

        w.reset();
        assert!(w.weave(&v2, &a2).is_none(), "a re-locked pair of a different shape is declined here");
        assert!(
            w.last_decline().contains("changed shape"),
            "the decline names itself: {}",
            w.last_decline()
        );

        w.reset();
        let (v3, a3) = pair(600_000, 0, 3);
        let third = w.weave(&v3, &a3).expect("an ordinary pair still weaves after a decline");
        assert_eq!(
            packets_on(&third, OUT_PMT_PID)[0][4..],
            packets_on(&first, OUT_PMT_PID)[0][4..],
            "the published PMT is unchanged by the decline"
        );
    }

    #[test]
    fn a_declined_pair_names_the_reason_and_leaves_the_locked_psi_intact() {
        let mut w = PairWeaver::new();
        let (v, a) = pair(0, 0, 3);
        let first = w.weave(&v, &a).expect("the first pair locks the table");

        let garbage = vec![0u8; PKT * 4];
        assert!(w.weave(&garbage, &a).is_none(), "an unanchorable lane is declined");
        assert!(!w.last_decline().is_empty(), "the splicer's own reason is carried through");

        w.reset();
        let (v2, a2) = pair(800_000, 0, 3);
        let again = w.weave(&v2, &a2).expect("the session recovers on the next good pair");
        assert_eq!(
            packets_on(&again, OUT_PMT_PID)[0][4..],
            packets_on(&first, OUT_PMT_PID)[0][4..],
            "reset re-anchors the clock but must NOT republish under a new table"
        );
    }

    #[test]
    fn reset_drops_the_seam_carry_over() {
        const SKEW: u64 = 1_000;
        let mut w = PairWeaver::new();
        let held = w.weave(&pair(0, SKEW, 3).0, &pair(0, SKEW, 3).1).expect("first pair");
        assert_eq!(packets_on(&held, OUT_AUDIO_BASE).len(), 2, "one unit is held back");

        w.reset();
        let after = w.weave(&pair(0, SKEW, 3).0, &pair(0, SKEW, 3).1).expect("a fresh pair after the skip");
        assert_eq!(
            packets_on(&after, OUT_AUDIO_BASE).len(),
            2,
            "the dropped carry does not reappear ahead of the re-anchored pair"
        );
    }
}
