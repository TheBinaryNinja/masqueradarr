//! S3/RMX — the INTERLEAVING MUXER: a demuxed pair, woven into ONE transport stream.
//!
//! WHAT THIS IS FOR. A demuxed source (pluto on every device cohort) hands us video and audio as two separate
//! transport streams, and the origin rings them as a PAIR on one entry (`origin::Segment.audio`). HLS can
//! publish that pair directly — two media playlists under an authored master, which is what
//! `origin::render_master` does. Raw TS cannot: `outputFormat: 'ts'` is ONE socket, and two transport streams
//! are not concatenable. Until this module existed `origin::serve_ts` declined outright on a demuxed ring, so
//! the one source shape the origin was built for was exactly the shape raw TS could not serve.
//!
//! WHAT IT IS NOT. This is not a remux and not a transcode. No elementary stream is decoded, re-encoded or
//! even parsed beyond its PES header — the work is transport-layer only: drop each lane's PSI, author ONE
//! program over both, and emit the two lanes' PES units in timestamp order.
//!
//! WHY IT IS SMALL. Nearly every precondition a muxer needs was already established by
//! `tsnorm::PairSplicer`, which the demuxed HLS ingest already runs per channel:
//!   · ONE 33-bit offset, computed from the VIDEO lane's DTS and applied to BOTH lanes — so the two lanes are
//!     already on one clock and the source's authored A/V skew survives bit-exactly. (A per-lane offset would
//!     manufacture a lip-sync error that was not in the source; that decision is `PairSplicer`'s, not ours.)
//!   · Canonical, DISJOINT published pids — video on `OUT_VIDEO_PID`, audio on `OUT_AUDIO_BASE…`.
//!   · Per-pid continuity counters already correct, and a skew guard that declines a rendition on an
//!     independent timebase before it can reach us.
//!
//! Because the pids are disjoint and the clock is shared, the merge needs NO pid remap, NO clock rewrite and
//! NO continuity repair: all three are already right, and all three survive reordering untouched. A PES unit
//! is contiguous per pid, so emitting whole units preserves each pid's packet order by construction.
//!
//! PCR IS NOT GENERATED. The video lane's PCR fields were already shifted by the shared offset
//! (`tsnorm::shift_pcr`), and the merge preserves the video lane's relative order, so PCR stays monotonic and
//! its spacing IN STREAM TIME is unchanged. Only PCR-to-byte-position linearity changes, which matters for a
//! CBR broadcast mux, not for an HTTP-delivered TS. The published PMT names `OUT_VIDEO_PID` as the `PCR_PID`;
//! the audio lane's own PCR fields are legal on a non-PCR pid and are left untouched rather than mutated.
//!
//! Pure and synchronous, like `tsnorm` and `tsseg` — the whole story is testable against synthetic packets
//! with no network. Runs on the EGRESS side, one instance per client socket (`origin::ts_ring_pair_producer`),
//! never at ingest: weaving at ingest would put a THIRD copy of every segment in the ring for the benefit of
//! raw-TS viewers alone.

use crate::tsnorm::{
    build_pat, build_pmt, forward_gap, packets, pes_timestamps, pid_of, write_section, CLOCK_MASK, CLOCK_WRAP,
    OUT_AUDIO_BASE, OUT_PMT_PID, OUT_VIDEO_PID,
};
use crate::tsseg::{parse_pat, parse_pmt, PmtInfo, PKT, SYNC};

/// The null pid (ISO 13818-1). `tsnorm::apply` turns every unpublished pid into padding on this one, so the
/// weave drops it — that padding exists only to keep `apply` length-invariant, and nothing downstream wants it.
const NULL_PID: u16 = 0x1FFF;

/// How often the published PAT/PMT is re-emitted, in packets. 250 × 188 B ≈ 47 KiB ≈ 110 ms at 3.3 Mbps, so
/// this lands near the conventional 100 ms PSI cadence while costing under 1 % of the socket. The tables are
/// also forced at the head of every woven pair, so a client never waits a whole interval to find the program.
const PSI_INTERVAL_PKTS: usize = 250;

/// How far before the video lane's first timestamp the merge's sort origin sits AT MINIMUM, in 90 kHz ticks
/// (2 s).
///
/// The sort compares `forward_gap(anchor, key)`, which is wrap-safe but one-directional: a key that sits
/// *before* the anchor reads as almost a full wrap ahead and would sort last. Audio may legitimately lead
/// video (a negative skew) and carried-over audio may precede the next pair's first frame.
///
/// A FLOOR, not a bound — and it was written as a bound. The justification used to be that `PairSplicer`'s
/// `SKEW_TOLERANCE` caps the lead at 0.5 s, so 2 s was "four times the headroom". That reading is wrong:
/// `SKEW_TOLERANCE` bounds how far one pair's skew may DRIFT from the LOCKED skew, never the locked skew's
/// own magnitude, and the first pair latches whatever it finds unconditionally. Pairing on
/// `#EXT-X-PROGRAM-DATE-TIME` accepts a partner up to HALF A SEGMENT away (2.5 s on pluto's 5 s ladder), so a
/// locked lead past 2 s is reachable — and then EVERY audio key sat before the anchor, so every audio unit
/// sorted after every video unit and the socket stepped ~2.5 s backwards at each pair seam.
///
/// `weave` now widens the anchor to whatever actually leads within the block. This constant only keeps the
/// ordinary case byte-identical to what it was.
const ANCHOR_BACKSTOP: u64 = 2 * 90_000;

/// Ceiling on the audio held back for the next pair (see `weave` step 5). A trailing run is a few KiB on any
/// normally-shaped pair; anything approaching this cap means the lanes are not shaped like a pair at all, so
/// the carry is abandoned and that audio is emitted in place rather than growing without bound.
///
/// Deliberately NOT justified by `SKEW_TOLERANCE` — see `ANCHOR_BACKSTOP` for why that guard bounds drift
/// rather than lead, and why a bound derived from it would be a bound on nothing.
const MAX_CARRY_BYTES: usize = 256 * 1024;

/// Which buffer a `Unit`'s bytes live in. Indices, not references, so the emit step can hold `&mut self`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Src {
    /// Audio held back from the PREVIOUS pair — see the seam note in `weave`.
    Carry,
    Video,
    Audio,
}

/// One PES access unit: a run of consecutive same-pid packets starting at a `payload_unit_start_indicator`.
///
/// A packet that continues a pid interrupted by another pid's packet opens a FRAGMENT unit instead, keyed by
/// inheritance from its pid's previous unit. Since the merge sort is stable and equal keys keep their input
/// order, a fragment stays behind the unit it continues — which is what preserves per-pid order through the
/// merge without ever making a unit a non-contiguous byte range.
#[derive(Clone, Copy, Debug)]
struct Unit {
    /// DTS where the stream has one, else PTS. `None` until `resolve_keys` fills it by inheritance.
    key: Option<u64>,
    pid: u16,
    src: Src,
    start: usize,
    len: usize,
}

/// The ONE program the socket publishes, locked on the first woven pair and re-emitted byte-identically.
///
/// Locked for the same reason `tsnorm::Layout` is: a PMT that changes shape mid-socket is itself a
/// reconfiguration event, which is the class of bug the pid remap exists to remove. A later pair whose derived
/// stream set differs is declined rather than quietly republished under a new shape.
struct CombinedPsi {
    /// Complete 188-byte packets, ready to emit; only the continuity counter is written per emission.
    pat_pkt: [u8; PKT],
    pmt_pkt: [u8; PKT],
    /// `(stream_type, published pid)`, video lane first — the template every later pair must reproduce.
    streams: Vec<(u8, u16)>,
    /// The published pids, cached for the per-packet membership check in `lane_units`.
    pids: Vec<u16>,
}

/// Weaves one ring entry's two lanes into a single-program transport stream.
///
/// Owns a `PairSplicer` rather than extending it: the splicer's job (one clock, canonical pids, skew guard) is
/// exactly the same on the HLS path, and reusing it unchanged is what keeps this module additive.
pub(crate) struct PairWeaver {
    /// Reused verbatim — the shared clock and the canonical pids both come from here.
    pair: crate::tsnorm::PairSplicer,
    psi: Option<CombinedPsi>,
    pat_cc: u8,
    pmt_cc: u8,
    /// Audio units held past the video lane's last DTS, flattened into one buffer so the next `weave` can
    /// prepend them without borrowing a dead lane.
    carry_buf: Vec<u8>,
    carry_units: Vec<Unit>,
    since_psi: usize,
    /// WHY the last `weave` returned `None`, for the `oop` log. Every early return names itself, following
    /// `PairSplicer::last_decline` — a decline that only says "declined" cannot distinguish a shape this pass
    /// genuinely cannot carry from a bug in this pass.
    last_decline: String,
    /// The stable CAUSE of that decline — the format string, before its measurements are filled in. Callers
    /// latch their per-reason warning on this; see `PairSplicer::last_slug` for why the message itself cannot
    /// serve as the key.
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

    /// Why the last pair was declined — the splicer's reason, or this module's own.
    pub(crate) fn last_decline(&self) -> &str {
        &self.last_decline
    }

    /// The stable cause behind it, for a per-reason log latch. Forwarded unchanged when the decline came from
    /// the splicer, so one key names one cause across both layers.
    pub(crate) fn last_decline_slug(&self) -> &'static str {
        self.last_slug
    }

    /// Forget the timeline and the seam carry-over. Same contract as `PairSplicer::reset`, and it MUST be
    /// called wherever the client skips or a pair declines, or the next pair would be spaced against a clock
    /// whose media nobody received.
    ///
    /// Deliberately KEEPS the locked `psi`: the published program must not change shape mid-socket, and a ring
    /// skip is not a reason to republish under a different table. A pair that no longer fits it is declined.
    pub(crate) fn reset(&mut self) {
        self.pair.reset();
        self.carry_buf.clear();
        self.carry_units.clear();
    }

    /// One ring entry in, one interleaved `video/mp2t` block out. `None` ⇒ the pair could not be published;
    /// the caller must `reset()` and skip it. There is deliberately no "serve verbatim" fallback here — the
    /// muxed path has one because a single transport stream concatenates, and two do not.
    pub(crate) fn weave(&mut self, video: &[u8], audio: &[u8]) -> Option<Vec<u8>> {
        // The format string is the cause key; the interpolated values are the measurement. See the twin macro
        // in `PairSplicer::normalize_pair`.
        macro_rules! decline {
            ($fmt:literal $(, $arg:expr)* $(,)?) => {{
                self.last_slug = $fmt;
                self.last_decline = format!($fmt $(, $arg)*);
                return None;
            }};
        }

        // 1. One clock, canonical pids, skew-guarded — all of it `PairSplicer`'s, none of it ours.
        let (vout, aout) = match self.pair.normalize_pair(video, audio) {
            Some(p) => p,
            // Forwarded by hand rather than through `decline!`: the reason is already formatted, and its slug
            // belongs to the splicer. Passing it through the macro would key the latch on "{}".
            None => {
                self.last_slug = self.pair.last_decline_slug();
                self.last_decline = self.pair.last_decline().to_string();
                return None;
            }
        };

        // The carry belongs to the PREVIOUS pair's buffers, so take it now: from here on `self` must be free
        // for `&mut` access, and any decline below correctly drops it (a decline re-anchors the timeline, and
        // audio spaced against the old one must not survive that).
        let carry_buf = std::mem::take(&mut self.carry_buf);
        let carry_units = std::mem::take(&mut self.carry_units);

        // 2. Lock — or re-verify — the published program.
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
        // Copied out so the emit loop below can hold `&mut self` for the continuity counters. Two 188-byte
        // arrays and a handful of pids — cheaper than the borrow gymnastics that would avoid it.
        let (pat_pkt, pmt_pkt, pids) = {
            let p = self.psi.as_ref()?;
            (p.pat_pkt, p.pmt_pkt, p.pids.clone())
        };

        // 3. Split both lanes into PES units.
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

        // 4. The seam. Within a pair the two lanes cover the same window, offset by the locked skew, so a
        //    per-pair merge is near-perfect — but the pair's trailing audio can sit past the NEXT pair's first
        //    video frame, which would publish a backwards step at every segment boundary. Hold those units
        //    back instead. Audio keys ascend, so the boundary is a partition point rather than a search.
        let split = aunits.partition_point(|u| !is_forward(vlast, u.key_or_zero()));
        let carry_bytes: usize = aunits[split..].iter().map(|u| u.len).sum();
        let split = if carry_bytes > MAX_CARRY_BYTES { aunits.len() } else { split };

        // 5. Merge. `forward_gap` from an anchor placed safely before the video lane's first stamp, so the
        //    comparison is wrap-safe; the sort is STABLE, which is what keeps each pid's packets in order when
        //    a fragment unit inherits its predecessor's key.
        //    The origin is placed before the EARLIEST key actually present, not before a fixed guess: the
        //    locked A/V skew has no bounded magnitude (see `ANCHOR_BACKSTOP`), so a lead past the backstop
        //    used to put every audio key behind the origin, where `forward_gap` reads it as nearly a full
        //    wrap and sorts it last. Keyless units are skipped deliberately — `key_or_zero` gives them 0,
        //    which is not a timestamp, and they keep sorting last exactly as before.
        let mut back = ANCHOR_BACKSTOP;
        for u in carry_units.iter().chain(vunits.iter()).chain(aunits[..split].iter()) {
            let Some(k) = u.key else { continue };
            let lead = forward_gap(k, vfirst); // how far this key sits BEFORE the video lane's first
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

        // 6. Emit. The tables lead every woven block, then recur on the packet cadence.
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

        // 7. Re-arm the carry from THIS pair's audio tail.
        for u in &aunits[split..] {
            self.carry_units.push(Unit { src: Src::Carry, start: self.carry_buf.len(), ..*u });
            self.carry_buf.extend_from_slice(&aout[u.start..u.start + u.len]);
        }
        Some(out)
    }
}

impl Unit {
    /// Keys are resolved by `resolve_keys` before a unit ever leaves `lane_units`, so this is total in
    /// practice; the zero is a defensive floor rather than a real case.
    fn key_or_zero(&self) -> u64 {
        self.key.unwrap_or(0)
    }
}

/// Strictly forward on the 33-bit clock — `b` is later than `a`, not equal and not a wrapped-around earlier.
fn is_forward(a: u64, b: u64) -> bool {
    let g = forward_gap(a, b);
    g > 0 && g < CLOCK_WRAP / 2
}

fn describe_streams(streams: &[(u8, u16)]) -> String {
    let s: Vec<String> = streams.iter().map(|(t, p)| format!("{p:#x}:{t:#04x}")).collect();
    format!("[{}]", s.join(" "))
}

/// Split one rewritten lane into PES units, dropping the lane's own PSI and its padding.
///
/// `allowed` is the published pid set: a packet outside it means `PairSplicer` published something the derived
/// PMT does not describe, which is a bug in this pass rather than a shape to tolerate. Declining says so.
fn lane_units(lane: &[u8], src: Src, allowed: &[u16]) -> Result<Vec<Unit>, String> {
    let mut units: Vec<Unit> = Vec::new();
    let mut cur_pid: Option<u16> = None;
    let mut i = 0usize;
    while i + PKT <= lane.len() {
        if lane[i] != SYNC {
            i += 1; // resync rather than trusting alignment, exactly as the segmenter and `tsnorm` do
            continue;
        }
        let pkt = &lane[i..i + PKT];
        let pid = pid_of(pkt);
        // The lane's OWN tables and padding: the woven stream authors its own program, and `apply`'s padding
        // exists only to keep that pass length-invariant.
        if pid == 0 || pid == OUT_PMT_PID || pid == NULL_PID {
            cur_pid = None; // a table between two packets of one PES ends the contiguous run
            i += PKT;
            continue;
        }
        if !allowed.contains(&pid) {
            return Err(format!("packet on pid {pid:#x}, which the published program does not declare"));
        }
        let pusi = pkt[1] & 0x40 != 0;
        if pusi || cur_pid != Some(pid) {
            // Either a genuine access-unit start, or a continuation whose run was interrupted. Both open a
            // unit; only the former can carry a timestamp.
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

/// Give every unit a key by inheritance along its own pid: forward from the previous unit, and — for units
/// that precede their pid's first timestamp — backward from the next one.
///
/// Inheriting rather than dropping is what preserves per-pid order: an unkeyed fragment sorts equal to the
/// unit it continues, and a stable sort keeps it behind it.
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
    // Anything still unkeyed sits before its pid's first stamp — walk back from the far end to fill it.
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

/// Author the ONE program over both lanes: the video lane's streams then the audio lane's, with the clock
/// reference on the video pid.
fn combined_psi(vout: &[u8], aout: &[u8]) -> Result<CombinedPsi, String> {
    let v = lane_pmt(vout).ok_or("video lane: the rewritten lane carries no PAT/PMT")?;
    let a = lane_pmt(aout).ok_or("audio lane: the rewritten lane carries no PAT/PMT")?;
    // `Layout::lock` puts the video lane's clock reference on the published video pid. If that is not what we
    // were handed, the assumption this whole module rests on has moved and guessing would be worse.
    if v.pcr_pid != OUT_VIDEO_PID {
        return Err(format!("video lane declares PCR on {:#x}, not the published video pid", v.pcr_pid));
    }
    let mut streams: Vec<(u8, u16)> = v.streams.iter().map(|&(pid, t)| (t, pid)).collect();
    if !streams.iter().any(|&(_, pid)| pid == OUT_VIDEO_PID) {
        return Err("video lane publishes no stream on the canonical video pid".to_string());
    }
    for &(pid, t) in &a.streams {
        // Disjoint by construction (`VideoOnly` publishes no audio, `AudioOnly` no video) — but a collision
        // would silently fold two elementary streams onto one pid, so prove it rather than assume it.
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

/// Read one lane's own PMT, following its PAT. Both sit at the head of a rewritten lane.
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
    const UP_APID: u16 = 0x201; // deliberately NOT the published pid, so the remap is exercised
    const UP_PMTPID: u16 = 0x1000;
    const HZ: u64 = 90_000;
    const F: u64 = HZ / 25; // 3600 ticks — one frame at 25 fps

    // ── synthetic stream builders ────────────────────────────────────────────────────────────────────────
    //
    // `tsnorm`'s equivalents live inside its own `mod tests` and so cannot be shared. These are deliberate
    // copies rather than a refactor of that module: this pass must be provable without touching the HLS
    // path's own regression harness.

    /// A 33-bit timestamp in its 5-byte marker-bit layout. Independent of `tsnorm`'s writer on purpose — a
    /// shared bug in the codec would otherwise be invisible to both suites.
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
            p[3] = 0x30; // adaptation + payload
            p[4] = 7;
            p[5] = 0x90; // discontinuity_indicator + PCR_flag
            p[6] = (v >> 25) as u8;
            p[7] = (v >> 17) as u8;
            p[8] = (v >> 9) as u8;
            p[9] = (v >> 1) as u8;
            p[10] = (((v & 1) as u8) << 7) | 0x7E;
            p[11] = 0xA5;
            12
        } else {
            p[3] = 0x10; // payload only
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
        let mut body = vec![0x00]; // pointer_field
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

    /// The video half of a demuxed pair: video only, PCR on the video pid, `frames` access units from `base`.
    fn video_lane(base: u64, frames: u64) -> Vec<u8> {
        let mut s = Vec::new();
        s.extend(pat_for(UP_PMTPID));
        s.extend(pmt_for(UP_PMTPID, UP_VPID, &[(0x1B, UP_VPID)]));
        for i in 0..frames {
            let dts = base + i * F;
            // PTS leads DTS by a frame — real reorder lead, so DTS-vs-PTS keying is actually under test.
            s.extend(pkt(UP_VPID, true, Some(dts), &pes(0xE0, dts + F, Some(dts))));
        }
        s
    }

    /// The audio half: audio only, PCR on the audio pid, no DTS (AAC has no reorder).
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

    /// One ring entry: `frames` frames from `base`, with the audio lane offset by the source's authored skew.
    fn pair(base: u64, skew: u64, frames: u64) -> (Vec<u8>, Vec<u8>) {
        (video_lane(base, frames), audio_lane(base.wrapping_add(skew), frames))
    }

    // ── output readers ───────────────────────────────────────────────────────────────────────────────────

    fn packets_of(bytes: &[u8]) -> Vec<&[u8]> {
        packets(bytes).collect()
    }

    fn packets_on(bytes: &[u8], pid: u16) -> Vec<&[u8]> {
        packets(bytes).filter(|p| pid_of(p) == pid).collect()
    }

    /// Every PES access unit's ordering key in emission order, as `(pid, DTS-else-PTS)` — the same key the
    /// merge sorts on, read back off the wire.
    fn keys_in_order(bytes: &[u8]) -> Vec<(u16, u64)> {
        packets(bytes)
            .filter(|p| p[1] & 0x40 != 0) // access-unit starts only
            .filter(|p| !matches!(pid_of(p), 0 | OUT_PMT_PID | NULL_PID))
            .filter_map(|p| pes_timestamps(p).and_then(|(pts, dts)| dts.or(pts)).map(|k| (pid_of(p), k)))
            .collect()
    }

    /// The PCR base carried on a packet's adaptation field, if it has one.
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

    /// The elementary-stream packets of one rewritten lane — what the weave must reproduce verbatim.
    fn es_packets(lane: &[u8]) -> Vec<Vec<u8>> {
        packets(lane)
            .filter(|p| !matches!(pid_of(p), 0 | OUT_PMT_PID | NULL_PID))
            .map(|p| p.to_vec())
            .collect()
    }

    /// Run a second, independent `PairSplicer` over the same input to get the two lanes the weave was handed.
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

    // ── the published program ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_woven_pair_carries_one_authored_program() {
        // The whole claim: two transport streams in, ONE program out. Both elementary streams must be
        // declared by a single PMT, on the canonical pids, with the clock reference on the video.
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
        // Every PMT is byte-identical apart from the continuity counter — a table that changes shape
        // mid-socket is itself a reconfiguration event, which is what this pass exists to remove.
        for p in &pmts {
            let (a, b) = (&p[4..], &pmts[0][4..]);
            assert_eq!(a, b, "the published PMT is byte-identical on every emission");
        }
        assert!(packets_on(&out, NULL_PID).is_empty(), "the lanes' padding is dropped, not republished");
    }

    #[test]
    fn the_emitted_psi_packets_carry_a_valid_section_crc() {
        // A section with a bad CRC is discarded outright by a conforming demuxer, which would leave the
        // socket with no program at all. This checks the PACKETISED form — pointer_field, offset, and the
        // continuity counter written over byte 3 without disturbing the section.
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

    // ── the media ────────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn both_elementary_streams_survive_the_weave() {
        // The failure this feature fixes is a silent stream, so the load-bearing assertion is that the audio
        // is actually there — and that nothing but PSI and padding was dropped on the way.
        let mut w = PairWeaver::new();
        let (v, a) = pair(0, 0, 3); // zero skew ⇒ nothing is held back at the seam
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
        // Reordering is only safe because a PES unit is contiguous per pid. Prove it the strong way: each
        // pid's subsequence of the woven output must be byte-for-byte the lane it came from — which also
        // proves the weave rewrites no timestamp and repairs no continuity counter (both already correct).
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
        // A muxer orders by DECODE time. Video is keyed on DTS (it has a reorder lead), audio on PTS, which
        // for AAC is the same thing — see the module header.
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
        // …and the two lanes really do alternate rather than one lane being emitted after the other.
        let pids: Vec<u16> = keys.iter().map(|(p, _)| *p).collect();
        assert!(
            pids.windows(2).filter(|w| w[0] != w[1]).count() >= 8,
            "the lanes interleave rather than concatenate: {pids:?}"
        );
    }

    /// THE REGRESSION the fixed anchor caused: an audio lane leading video by more than `ANCHOR_BACKSTOP`.
    ///
    /// Reachable because `SKEW_TOLERANCE` bounds DRIFT from the locked skew, not the locked skew itself, and
    /// PDT pairing accepts a partner up to half a segment away. With a fixed origin every audio key landed
    /// before it, read as almost a full wrap, and sorted after ALL video — the socket stepped backwards at
    /// every seam while HLS off the same ring played fine.
    #[test]
    fn an_audio_lane_leading_past_the_backstop_still_leaves_in_timestamp_order() {
        const LEAD: u64 = 225_000; // 2.5 s at 90 kHz — beyond the 2 s backstop
        let vbase: u64 = 2_000_000;
        // The audio lane is LONGER as well as earlier, so its run actually spans the video's — a lane that
        // both starts and ends before the video would be segregated by any correct merge, and would test
        // nothing about the anchor.
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
        // The failure mode was total segregation — every audio unit after every video unit — so assert the
        // lanes actually interleave rather than merely being monotonic.
        let pids: Vec<u16> = keys.iter().map(|(p, _)| *p).collect();
        assert!(
            pids.windows(2).filter(|w| w[0] != w[1]).count() >= 8,
            "the lanes interleave rather than concatenate: {pids:?}"
        );
    }

    #[test]
    fn the_authored_av_skew_survives_the_weave() {
        // The one property a muxer must not break. `PairSplicer` applies ONE offset derived from the video
        // lane so the source's own A/V relationship is translated rather than replaced; the weave reorders
        // packets and must therefore change nothing about it.
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
        // No PCR is generated: the video lane's own references are shifted by `PairSplicer` and carried
        // through in relative order, so the published clock only ever moves forward.
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
        // A demuxer reports lost packets on a counter gap, so the seam between two woven pairs — where a
        // carried-over audio unit is emitted after its lane's buffer is gone — must not break the sequence.
        let mut w = PairWeaver::new();
        let mut out = w.weave(&pair(0, 1_000, 4).0, &pair(0, 1_000, 4).1).expect("first pair");
        out.extend(w.weave(&pair(700_000, 1_000, 4).0, &pair(700_000, 1_000, 4).1).expect("second pair"));

        for pid in [0u16, OUT_PMT_PID, OUT_VIDEO_PID, OUT_AUDIO_BASE] {
            let ccs: Vec<u8> = packets_on(&out, pid)
                .iter()
                .filter(|p| matches!((p[3] >> 4) & 0b11, 0b01 | 0b11)) // payload-bearing only
                .map(|p| p[3] & 0x0F)
                .collect();
            // The tables are emitted once per woven block here, so two pairs give two of each — enough for
            // the windowed check, and the elementary pids carry many more.
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

    // ── the seam ─────────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_seam_carry_over_keeps_the_output_monotonic_across_two_pairs() {
        // Audio trailing the video by the authored skew runs past the video lane's last frame, so without the
        // carry-over the next pair's first video unit would land BEFORE it — a backwards step at every
        // segment boundary. The held-back units must move to the next block instead.
        const SKEW: u64 = 1_000;
        let mut w = PairWeaver::new();
        let first = w.weave(&pair(0, SKEW, 3).0, &pair(0, SKEW, 3).1).expect("first pair");
        let second = w.weave(&pair(400_000, SKEW, 3).0, &pair(400_000, SKEW, 3).1).expect("second pair");

        // Three audio units per pair. The first block emits two and holds the one that runs past its video
        // lane's last frame; the second emits that carried unit plus two of its own, holding one in turn —
        // so the count is 3, not 4, and the deficit is a steady one-unit lag rather than an accumulating one.
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
        // A client that joins the socket late — or a demuxer that resyncs — must find the program again
        // quickly, and it can only do that if the tables recur.
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

    // ── declines ─────────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_pair_whose_stream_set_differs_from_the_locked_table_is_declined() {
        // The published table is LOCKED. A later pair carrying a second audio track cannot be published
        // against it — republishing under a changed shape is a reconfiguration event, and silently dropping
        // the extra track would lose a language for the rest of the session.
        let mut w = PairWeaver::new();
        let (v, a) = pair(0, 0, 3);
        let first = w.weave(&v, &a).expect("the first pair locks the table");

        let v2 = video_lane(300_000, 3);
        let a2 = audio_lane_on(&[UP_APID, UP_APID + 1], 300_000, 3);
        // While the splicer still holds its own single-track audio layout, ITS lock catches this first.
        assert!(w.weave(&v2, &a2).is_none(), "the splicer's locked audio layout declines the extra track");

        // The interesting case is after a reset — the splicer re-locks happily on two tracks, which is
        // exactly where this module has to hold the line: the PUBLISHED program cannot grow a stream
        // mid-socket, because a client that already read the PMT would never see the new one.
        w.reset();
        assert!(w.weave(&v2, &a2).is_none(), "a re-locked pair of a different shape is declined here");
        assert!(
            w.last_decline().contains("changed shape"),
            "the decline names itself: {}",
            w.last_decline()
        );

        // …and the locked table survives both declines, so the session keeps publishing one program.
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
        // A decline that only says "declined" cannot distinguish a shape this pass genuinely cannot carry
        // from a bug in this pass — the same lesson that got the URL-shape splice heuristics removed.
        let mut w = PairWeaver::new();
        let (v, a) = pair(0, 0, 3);
        let first = w.weave(&v, &a).expect("the first pair locks the table");

        // A lane with no anchorable timestamps: `PairSplicer` refuses it before the weave ever runs, and its
        // reason must be the one surfaced to the operator.
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
        // The carry is audio spaced against a timeline the client is about to leave (a ring skip). Emitting
        // it after the re-anchor would splice it onto a clock that no longer exists.
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
