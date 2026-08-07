//! Rebasing a segment onto a CONTINUOUS output timeline — the engine behind "Smooth ad transitions"
//! (`spliceNormalize`).
//!
//! An ad-stitched upstream does not hand us one stream. It hands us alternating encodes: the timestamps jump
//! at every pod edge, and — the part no HLS tag can express — the video PID itself moves (pluto ran
//! 258 → 256 → 258 across a single pod). A demuxer does not follow an elementary stream to a new PID; it keeps
//! rendering the one it latched and registers the new one as a stream nothing is displaying, so video freezes
//! until the PID happens to come back. `#EXT-X-DISCONTINUITY` describes a TIMELINE break; this is a stream
//! IDENTITY break, and the only fix is to stop the identity from changing.
//!
//! So every ingested segment is republished onto ONE timeline with canonical PIDs: the bytes are copied, the
//! PSI is rewritten to a locked layout, and every clock inside is shifted onto the timeline we publish. The
//! splice is then absorbed rather than announced, and the player never sees a seam to recover from.
//!
//! Deliberately never re-encodes. A client that froze on every PID move handled every SPS-only change on a
//! stable PID unaided, so identity — not parameters — is what has to be held still.
//!
//! THE CONTRACT
//!   · LENGTH-INVARIANT. Fields are overwritten in place — nothing is inserted, dropped or resized — so the
//!     ring's byte accounting, the `MIN_SEGMENTS` floor and every caller's length assumption are unchanged.
//!   · ONE offset per segment, applied identically to PTS, DTS, PCR and OPCR on EVERY pid. A per-PID offset
//!     would replace the stream's authored audio/video skew with an arbitrary one — i.e. manufacture a
//!     lip-sync error that did not exist in the source. A uniform translation is affine, so every intra-
//!     segment relationship (A/V skew, PTS−DTS reorder distance, PCR-to-DTS lead) survives bit-exactly.
//!   · The reference clock is the VIDEO pid's DTS (PTS when the stream carries no DTS, i.e. no B-frames).
//!     Not PCR (may be absent, lives on its own pid, carries an extension) and not PTS (non-monotonic with
//!     B-frames, so "the last one" is ambiguous).
//!   · BAIL ON DOUBT. Anything we cannot positively handle returns `None` and the caller publishes the
//!     segment verbatim, signalling the splice the old way. A visible decoder reset beats a stream we
//!     mis-rewrote.
//!
//! Pure and synchronous, like `tsseg` — the whole story is testable against synthetic packets with no network.

use std::collections::HashMap;

use crate::tsseg::{parse_pat, parse_pmt, PKT, SYNC};

/// The 33-bit PTS/DTS/PCR-base clock wraps roughly every 26.5 hours. Every arithmetic step below is masked to
/// it, so a wrap is a normal event rather than a special case.
const CLOCK_WRAP: u64 = 1 << 33;
const CLOCK_MASK: u64 = CLOCK_WRAP - 1;

/// Fallback inter-frame gap (90 kHz ticks) when a segment is too short to measure one — 1/25 s. Only used to
/// space one segment from the next, so being a frame out is inaudible and invisible.
const DEFAULT_FRAME_DUR: u64 = 3600;

/// Sanity bounds on a measured frame duration: ~1/240 s to ~1/5 s. Anything outside is a mis-parse, not a
/// real frame rate, and would otherwise poison the join spacing.
const MIN_FRAME_DUR: u64 = 375;
const MAX_FRAME_DUR: u64 = 18_000;

/// What one read-only pass learned about a segment's clocks.
struct Scan {
    first_dts: u64,
    last_dts: u64,
    /// Highest PTS seen on the video pid — with B-frames this leads `last_dts`, and the join has to clear it
    /// or presentation would run backwards across the splice.
    max_pts: u64,
    frame_dur: u64,
}

/// Carries the output timeline across segments: where it has reached, and each pid's next continuity counter.
///
/// Lives in the ingest task beside `prev`, so it is single-writer by construction and needs no lock. MUST be
/// reset whenever the ring is (a re-resolve onto a different upstream), or an old timeline's offset would be
/// applied to a new clock.
#[derive(Default)]
pub(crate) struct Normalizer {
    /// Next `continuity_counter` to write, per pid. Repeated segments would otherwise restart the counter
    /// mid-stream, which a strict demuxer reads as lost packets.
    cc: HashMap<u16, u8>,
    /// Both ends of the last segment written out. DECODE end governs where fresh media joins (matching the
    /// source's own contiguity); PRESENTATION end governs where a repeat may start (a copy must clear what
    /// the original already showed). Keeping both is what lets one timeline serve both without drifting.
    last_dts: Option<u64>,
    last_pts: u64,
    frame_dur: u64,
}

impl Normalizer {
    pub(crate) fn new() -> Self {
        Self { cc: HashMap::new(), last_dts: None, last_pts: 0, frame_dur: DEFAULT_FRAME_DUR }
    }

    /// Forget the output timeline. Called wherever the ring is dropped — the next segment then anchors a
    /// fresh timeline instead of being spaced against a clock that no longer exists.
    pub(crate) fn reset(&mut self) {
        self.cc.clear();
        self.last_dts = None;
        self.last_pts = 0;
        self.frame_dur = DEFAULT_FRAME_DUR;
    }

    /// The offset that lands `s` immediately after everything already published.
    ///
    /// `repeat` selects WHICH end of the previous segment is cleared. Every production path passes `false`
    /// (fresh upstream media); the `true` arm survives because it is the contract the spacing rule is written
    /// against, and the tests below pin both halves of that rule against each other.
    fn offset_for(&self, s: &Scan, repeat: bool) -> u64 {
        let start = match self.last_dts {
            Some(last) => {
                // A REPEAT — the same bytes emitted twice — must clear what the previous segment PRESENTED,
                // not merely where it stopped decoding: starting at the decode end would put the copy's first
                // frame before the original's last and run presentation backwards.
                // FRESH media must NOT do that — consecutive segments of one source are contiguous in decode
                // order, and clearing `max_pts` instead injects the reorder delay as phantom time on every
                // join (+0.50 % measured live on B-frame content).
                let base = match repeat {
                    true if forward_gap(last, self.last_pts) < CLOCK_WRAP / 2 => self.last_pts,
                    _ => last,
                };
                base.wrapping_add(self.frame_dur) & CLOCK_MASK
            }
            // First segment on a fresh timeline: leave it exactly where it is, so a stream that never needs
            // rewriting is never touched at all.
            None => s.first_dts,
        };
        start.wrapping_sub(s.first_dts) & CLOCK_MASK
    }

    /// Record BOTH ends of what was just published; `offset_for` decides which one the next segment clears.
    fn advance(&mut self, s: &Scan, offset: u64) {
        self.last_dts = Some(s.last_dts.wrapping_add(offset) & CLOCK_MASK);
        self.last_pts = s.max_pts.wrapping_add(offset) & CLOCK_MASK;
        self.frame_dur = s.frame_dur;
    }

    /// Shift `bytes` onto the output timeline, returning the rewritten copy. `None` = could not be done
    /// safely, and the caller must not publish the result.
    ///
    /// The clock layer, and the whole of it. `Splicer` wraps this with the pid/PSI layer; nothing outside
    /// this module calls it directly, which is why the layout half is the only public entry point.
    fn rewrite(&mut self, bytes: &[u8], remap: Option<&Remap>, repeat: bool) -> Option<Vec<u8>> {
        let s = scan(bytes)?;
        let offset = self.offset_for(&s, repeat);
        let mut out = bytes.to_vec();
        apply(&mut out, offset, &mut self.cc, remap)?;
        self.advance(&s, offset);
        Some(out)
    }
}

/// Distance from `a` forward to `b` on the 33-bit clock. Used instead of `<`/`>` so a comparison that
/// straddles the wrap reads as "a bit later" rather than as an enormous jump backwards.
fn forward_gap(a: u64, b: u64) -> u64 {
    b.wrapping_sub(a) & CLOCK_MASK
}

/// One read-only pass: locate the video pid via the PSI, then collect its PES timestamps.
fn scan(bytes: &[u8]) -> Option<Scan> {
    let mut pmt_pid: Option<u16> = None;
    let mut video_pid: Option<u16> = None;
    let mut first_dts: Option<u64> = None;
    let mut last_dts: u64 = 0;
    let mut max_pts: u64 = 0;
    // The two most recent DISTINCT decode stamps — their difference is the inter-frame gap.
    let mut prev_dts: Option<u64> = None;
    let mut frame_dur: Option<u64> = None;

    for pkt in packets(bytes) {
        if pkt[1] & 0x80 != 0 {
            continue; // transport_error_indicator — never parse a packet the mux itself flagged as corrupt
        }
        if pkt[3] & 0xC0 != 0 {
            return None; // scrambled payload: the PES header underneath is not readable
        }
        let pid = pid_of(pkt);
        if pid == 0x1FFF {
            continue;
        }
        if pid == 0 {
            pmt_pid = pmt_pid.or_else(|| parse_pat(pkt));
        } else if Some(pid) == pmt_pid && video_pid.is_none() {
            // NOT `?`. A packet on the PMT pid that this cannot parse is usually just a section CONTINUATION
            // (no payload_unit_start_indicator), and real streams repeat the table every few hundred ms — so
            // bailing the whole segment on the first unparseable one declines every segment that happens to
            // start mid-table. Keep walking; `first_dts` below is what actually decides success.
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

    let first_dts = first_dts?; // no video timestamps ⇒ nothing to anchor a timeline on
    Some(Scan {
        first_dts,
        last_dts,
        max_pts: if max_pts == 0 { last_dts } else { max_pts },
        frame_dur: frame_dur.unwrap_or(DEFAULT_FRAME_DUR),
    })
}

/// Second pass: overwrite every clock by `offset`, renumber continuity counters, and clear the
/// discontinuity_indicator (a stale one tells the player to resync on a clock that no longer jumps, which
/// would defeat the whole point).
///
/// `remap` is the SPLICE half (see `Splicer`): when present, every packet is first moved onto the published
/// layout — PSI rebuilt, elementary pids translated, anything unmapped turned into padding — and only then
/// does the clock/continuity work below run, keyed by the OUTPUT pid. Order matters: two different upstream
/// video pids fold onto one published pid, and their continuity counters have to become ONE sequence.
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
            continue; // null padding and flagged-corrupt packets are passed through untouched
        }
        if let Some(r) = remap {
            if pid == 0 {
                write_section(pkt, 0, &r.layout.pat)?;
            } else if pid == r.in_pmt_pid {
                write_section(pkt, OUT_PMT_PID, &r.layout.pmt)?;
            } else if let Some(&out_pid) = r.pids.get(&pid) {
                set_pid(pkt, out_pid);
            } else {
                // Not part of the published program — pluto's timed-ID3 pid is here one segment and gone the
                // next, and a PMT that changes shape is the very thing this module exists to prevent. Padding
                // it out keeps the rewrite length-invariant; every demuxer discards pid 0x1FFF unread.
                nullify(pkt);
                continue;
            }
        }
        // RE-READ after the remap: two upstream video pids fold onto one published pid, and their continuity
        // counters have to leave here as ONE sequence. Keying the map on the pre-remap pid would restart the
        // count at every splice, which is exactly the "lost packets" a strict demuxer reports.
        let pid = pid_of(pkt);

        let afc = (pkt[3] >> 4) & 0b11;
        if afc == 0b10 || afc == 0b11 {
            let len = pkt[4] as usize;
            if len > 0 && 5 + len <= PKT {
                pkt[5] &= !0x80; // clear discontinuity_indicator
                let flags = pkt[5];
                if flags & 0x10 != 0 && len >= 7 {
                    shift_pcr(&mut pkt[6..12], offset);
                }
                if flags & 0x08 != 0 && len >= 13 {
                    shift_pcr(&mut pkt[12..18], offset);
                }
            }
        }

        // Continuity counters advance only on packets that carry payload.
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

fn packets(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut i = 0usize;
    std::iter::from_fn(move || {
        while i + PKT <= bytes.len() {
            if bytes[i] != SYNC {
                i += 1; // resync rather than trusting alignment, exactly as the segmenter does
                continue;
            }
            let p = &bytes[i..i + PKT];
            i += PKT;
            return Some(p);
        }
        None
    })
}

fn pid_of(pkt: &[u8]) -> u16 {
    (((pkt[1] & 0x1F) as u16) << 8) | pkt[2] as u16
}

/// Byte offset of a PUSI packet's payload, or None when it carries none.
fn payload_start(pkt: &[u8]) -> Option<usize> {
    let afc = (pkt[3] >> 4) & 0b11;
    let off = match afc {
        0b01 => 4,
        0b11 => 5 + pkt[4] as usize,
        _ => return None, // adaptation-only, or the reserved 00
    };
    (off < PKT).then_some(off)
}

/// `(pts, dts)` from the PES header at the head of a PUSI packet. `Ok(None, None)` for a payload that is not
/// a PES start we understand; `None` (the outer Option) for one we understand but must not touch.
#[allow(clippy::type_complexity)]
fn pes_timestamps(pkt: &[u8]) -> Option<(Option<u64>, Option<u64>)> {
    let Some(off) = payload_start(pkt) else { return Some((None, None)) };
    let p = &pkt[off..];
    if p.len() < 9 || p[0..3] != [0x00, 0x00, 0x01] {
        return Some((None, None)); // a continuation or a non-PES payload
    }
    if !has_optional_header(p[3]) {
        return Some((None, None)); // padding / stream_map / directory — no timestamps by definition
    }
    if p[6] & 0xC0 != 0x80 {
        return None; // not the '10' PES extension marker — we do not understand this header
    }
    if p[7] & 0x20 != 0 {
        return None; // ESCR present: a second 33-bit clock we have never seen in the wild — refuse to guess
    }
    let flags = p[7] >> 6;
    let hdr_len = p[8] as usize;
    match flags {
        0b00 => Some((None, None)),
        0b10 if hdr_len >= 5 && p.len() >= 14 => Some((Some(read_ts(&p[9..14])), None)),
        0b11 if hdr_len >= 10 && p.len() >= 19 => Some((Some(read_ts(&p[9..14])), Some(read_ts(&p[14..19])))),
        // A header split across packets, or the forbidden 0b01. Reassembling is not worth it: shifting some
        // stamps in a PES and not others is strictly worse than declining the whole segment.
        _ => None,
    }
}

/// Same walk as `pes_timestamps`, writing instead of reading.
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

/// Stream ids that carry the optional PES header (and therefore may carry timestamps). The excluded ones —
/// padding, private_2, ECM/EMM, stream directory and friends — have no header to parse at all.
fn has_optional_header(stream_id: u8) -> bool {
    !matches!(stream_id, 0xBC | 0xBE | 0xBF | 0xF0 | 0xF1 | 0xF2 | 0xF8 | 0xFF)
}

/// A 33-bit timestamp in its 5-byte marker-bit layout:
///   `b0: prefix(4) ts[32:30] m` `b1: ts[29:22]` `b2: ts[21:15] m` `b3: ts[14:7]` `b4: ts[6:0] m`
fn read_ts(b: &[u8]) -> u64 {
    (((b[0] & 0x0E) as u64) << 29)
        | ((b[1] as u64) << 22)
        | (((b[2] & 0xFE) as u64) << 14)
        | ((b[3] as u64) << 7)
        | ((b[4] as u64) >> 1)
}

/// The incoming high nibble is PRESERVED rather than re-derived, so this never has to know which of the
/// three prefixes (`0010` PTS-only, `0011` PTS-of-a-pair, `0001` DTS) it is looking at — and
/// `write_ts(b, read_ts(b))` is provably byte-identical.
fn write_ts(b: &mut [u8], v: u64) {
    b[0] = (b[0] & 0xF0) | ((((v >> 30) as u8) & 0x07) << 1) | 1;
    b[1] = (v >> 22) as u8;
    b[2] = ((((v >> 15) as u8) & 0x7F) << 1) | 1;
    b[3] = (v >> 7) as u8;
    b[4] = (((v as u8) & 0x7F) << 1) | 1;
}

/// Shift a 6-byte PCR/OPCR field by `offset` 90 kHz ticks.
///
/// Only the 33-bit BASE moves. Shifting the base by n shifts the 27 MHz value by exactly n × 300 and leaves
/// the remainder correct, which removes all 27 MHz arithmetic from this module. The 6 reserved bits and the
/// 9-bit extension are preserved byte-exactly — note `tsseg`'s test-only PCR writer zeroes them, which is
/// fine for a synthetic packet and would corrupt a real one.
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
    b[4] = (((v & 1) as u8) << 7) | (b[4] & 0x7F); // keep reserved(6) + ext[8]
                                                   // b[5] (ext[7:0]) untouched
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// SPLICE NORMALIZATION — one unbroken program out of a spliced upstream.
//
// WHY THIS EXISTS SEPARATELY FROM THE HLS RENDERER. A splice is expressible in HLS: `#EXT-X-DISCONTINUITY`
// tells the player "tear the decoder down and rebuild it", and `origin::render_media_playlist` emits one.
// Raw TS has no such sentence. It is a single socket with no manifest, so the ONLY in-band vocabulary is the
// adaptation field's `discontinuity_indicator` — and that word means "the clock is about to jump", which is
// not what actually breaks. Measured across a pluto splice, the upstream changes THREE things at once:
//
//   video pid  0x100 → 0x102      resolution 1280x720 → 1216x684      DTS −13.97 s (backwards)
//
// The pid move is the fatal one. libavformat (which is what most clients demux TS with) does not follow an
// elementary stream to a new pid — it registers a NEW stream mid-file, which a player already rendering the
// old one never switches to. Video stops; audio, whose pid did NOT move, keeps playing against a clock that
// jumped, so it drifts and then races. No `discontinuity_indicator` can express any of that.
//
// So the fix is not to SIGNAL the splice, it is to REMOVE it: republish every segment onto one published
// layout with one continuous clock, so that from the client's side no splice ever happened. Note what that
// means for the DI bit — it stays CLEARED. A stale indicator would tell the player to resync on a clock that
// no longer jumps.
//
// WHAT IS LEFT UNSIGNALLED, DELIBERATELY. The resolution/SPS change survives this pass untouched. That is
// correct: on a STABLE pid with CONTINUOUS timestamps, new parameter sets are an ordinary in-band decoder
// reconfigure that every decoder already handles — it is only a stream-identity change when the pid moves
// under it. This module makes the pid stop moving; it never re-encodes.
//
// RELATION TO `.claude/plans/origin-republish.md`. That plan recommends CLOSING a general "unified timeline"
// pass, because SUPPRESSING an upstream discontinuity is only sound when the codec parameters match on both
// sides. This is not that. We are not suppressing a signal on the HLS path (which still emits the tag, and
// must); we are supplying the only representation raw TS has, on a shape that otherwise cannot carry one.

/// The published layout. Fixed values rather than "whatever the first segment used", so the wire shape of a
/// masqueradarr raw-TS stream is a property of masqueradarr and not of whichever ad happened to play first.
const OUT_PMT_PID: u16 = 0x1000;
const OUT_VIDEO_PID: u16 = 0x100;
const OUT_AUDIO_BASE: u16 = 0x101;
const OUT_PROGRAM: u16 = 1;
/// Published audio tracks. Beyond this the segment is declined rather than silently losing a language.
const MAX_AUDIO: usize = 4;

/// Video types whose decoder configuration travels IN the elementary stream (parameter-set NALs), so a PMT
/// carrying no descriptors still fully describes them. Republishing anything else would mean copying
/// descriptors we do not interpret, so those are declined instead.
fn is_self_describing_video(t: u8) -> bool {
    matches!(t, 0x1B | 0x24)
}

/// Audio types that are likewise self-describing (ADTS/LATM carry their own configuration). Notably EXCLUDES
/// AC-3/E-AC-3 (0x81/0x87), whose identity in a DVB mux rides in a registration descriptor this pass drops.
fn is_self_describing_audio(t: u8) -> bool {
    matches!(t, 0x03 | 0x04 | 0x0F | 0x11)
}

/// Stream types that can be left OUT of the published program without a viewer losing anything: private
/// sections and PES-carried metadata. pluto's timed-ID3 (0x15) is the one that matters — present in a program
/// segment, absent from the ad that follows, which is exactly the PMT churn this pass exists to remove.
///
/// Deliberately does NOT include 0x06 (private PES). In a DVB mux that carries subtitles and teletext, but it
/// also carries AC-3 and DTS, and telling them apart needs the ES descriptors this pass does not read.
/// Declining costs one glitchy segment; guessing wrong costs the audio track.
fn is_droppable(t: u8) -> bool {
    matches!(t, 0x05 | 0x15)
}

/// Whether every stream in a segment is one we can either publish or safely discard. An unrecognised type is
/// a decline, never a drop: losing a track we merely failed to classify would be silent.
fn publishable(psi: &SegPsi) -> bool {
    psi.streams
        .iter()
        .all(|&(_, t)| is_self_describing_video(t) || is_self_describing_audio(t) || is_droppable(t))
}

/// What one segment's PSI says about itself.
struct SegPsi {
    pmt_pid: u16,
    pcr_pid: u16,
    streams: Vec<(u16, u8)>,
}

/// The program we publish, locked once per session and then re-emitted byte-identically on every segment.
///
/// Locking is what makes the output ONE program: a PMT that changes shape mid-socket is itself a
/// reconfiguration event, so the table is built once and never varies. A later segment that cannot be mapped
/// onto it is declined (the caller falls back) rather than quietly changing the published shape.
struct Layout {
    /// Complete PAT/PMT sections including CRC, ready to drop into a packet.
    pat: Vec<u8>,
    pmt: Vec<u8>,
    /// `(stream_type, published pid)` in published order — the template every later segment matches against.
    streams: Vec<(u8, u16)>,
}

impl Layout {
    /// Build the published program from the first segment that carries usable PSI.
    fn lock(psi: &SegPsi) -> Option<Layout> {
        if !publishable(psi) {
            return None;
        }
        // Exactly one video. Two would mean choosing which one the session publishes, and that choice belongs
        // to variant selection upstream of here, not to a byte rewriter.
        let videos: Vec<u8> =
            psi.streams.iter().filter(|(_, t)| is_self_describing_video(*t)).map(|(_, t)| *t).collect();
        if videos.len() != 1 {
            return None;
        }
        let audios: Vec<u8> =
            psi.streams.iter().filter(|(_, t)| is_self_describing_audio(*t)).map(|(_, t)| *t).collect();
        if audios.len() > MAX_AUDIO {
            return None;
        }
        let mut streams = vec![(videos[0], OUT_VIDEO_PID)];
        for (i, t) in audios.into_iter().enumerate() {
            streams.push((t, OUT_AUDIO_BASE + i as u16));
        }
        Some(Layout { pat: build_pat(), pmt: build_pmt(&streams), streams })
    }

    /// Translate one segment's pids onto the published ones. `None` ⇒ this segment does not fit the locked
    /// program and must not be published against it.
    fn map(&self, psi: &SegPsi) -> Option<HashMap<u16, u16>> {
        if !publishable(psi) {
            return None;
        }
        let mut out = HashMap::new();
        let mut used: Vec<u16> = Vec::new();
        for &(want_type, out_pid) in &self.streams {
            // Match by TYPE in published order. Matching by pid would defeat the entire point, and matching by
            // position would mis-pair a segment whose PMT lists its tracks in another order.
            let (in_pid, _) = psi
                .streams
                .iter()
                .copied()
                .find(|(p, t)| *t == want_type && !used.contains(p))?;
            used.push(in_pid);
            out.insert(in_pid, out_pid);
        }
        // The PCR must land on a pid we actually publish, or the output loses its clock reference entirely.
        // In practice pluto carries PCR on the video pid; anything else is declined rather than guessed at.
        if out.get(&psi.pcr_pid) != Some(&OUT_VIDEO_PID) {
            return None;
        }
        Some(out)
    }
}

/// The per-packet translation handed to `apply`.
struct Remap<'a> {
    layout: &'a Layout,
    pids: HashMap<u16, u16>,
    in_pmt_pid: u16,
}

/// Republishes a spliced upstream as one continuous program: stable pids, one clock, one PMT.
///
/// Lives in the raw-TS PRODUCER (one per client socket), not in the ingest. The ring is shared by both
/// renderers and by every viewer, so it must keep holding verbatim upstream bytes — the HLS renderer needs
/// the real splice in order to signal it, and two viewers who joined at different points sit at different
/// points on their own output timelines. Rewriting is a byte walk with no crypto and no decode; at a 5 s
/// segment cadence it is a few hundred KiB/s per viewer.
pub(crate) struct Splicer {
    clock: Normalizer,
    layout: Option<Layout>,
}

impl Splicer {
    pub(crate) fn new() -> Self {
        Self { clock: Normalizer::new(), layout: None }
    }

    /// Forget both the timeline and the published layout. MUST be called wherever the ring is dropped or the
    /// client skips, or a new upstream's segments would be spaced against a clock that no longer exists.
    pub(crate) fn reset(&mut self) {
        self.clock.reset();
        self.layout = None;
    }

    /// Whether a timeline is already running, i.e. the NEXT `normalize` will move its segment onto an
    /// existing clock rather than anchoring a fresh one.
    ///
    /// This is what tells a caller whether a splice was actually ABSORBED. Anchoring leaves the segment's
    /// clock exactly where upstream put it, so upstream's own discontinuity still governs; joining moves it,
    /// so the splice is gone and announcing it would tell the player to resync on a clock that no longer
    /// jumps. Must be read BEFORE `normalize`, which is what changes the answer.
    pub(crate) fn has_timeline(&self) -> bool {
        self.clock.last_dts.is_some()
    }

    /// Rewrite FRESH upstream media onto the published program. `None` ⇒ could not be done safely; the
    /// caller serves the segment verbatim (a visible glitch beats a corrupted socket).
    pub(crate) fn normalize(&mut self, bytes: &[u8]) -> Option<Vec<u8>> {
        self.publish(bytes)
    }

    fn publish(&mut self, bytes: &[u8]) -> Option<Vec<u8>> {
        let psi = read_psi(bytes)?;
        if self.layout.is_none() {
            self.layout = Some(Layout::lock(&psi)?);
        }
        let layout = self.layout.as_ref()?;
        let pids = layout.map(&psi)?;
        let remap = Remap { layout, pids, in_pmt_pid: psi.pmt_pid };
        // Borrow dance: `remap` holds &self.layout while `rewrite` needs &mut self.clock. They are disjoint
        // fields, so split the borrow explicitly rather than cloning the layout on every segment.
        let clock = &mut self.clock;
        clock.rewrite(bytes, Some(&remap), false)
    }
}

/// Read a segment's PAT + PMT. `None` when either is absent — parameters are then unverifiable, which is a
/// reason to decline, never to assume.
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
            // Not `?` — an unparseable packet on the PMT pid is usually a section CONTINUATION, and the table
            // repeats. Same reasoning as `scan`.
            pmt = parse_pmt(pkt);
        }
    }
    let pmt_pid = pmt_pid?;
    let pmt = pmt?;
    Some(SegPsi { pmt_pid, pcr_pid: pmt.pcr_pid, streams: pmt.streams })
}

/// CRC-32/MPEG-2 (ISO 13818-1 Annex B): poly 0x04C11DB7, init all-ones, MSB-first, no reflection, no final
/// inversion. Every PSI section this module writes is rejected outright by a demuxer without it.
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
    // section_length counts everything after its own 12 bits, CRC included.
    let len = s.len() - 3 + 4;
    s[1] = 0xB0 | ((len >> 8) as u8 & 0x0F); // syntax_indicator + reserved
    s[2] = (len & 0xFF) as u8;
    let crc = crc32_mpeg(&s);
    s.extend_from_slice(&crc.to_be_bytes());
    s
}

/// A single-program PAT pointing at `OUT_PMT_PID`.
fn build_pat() -> Vec<u8> {
    let mut s = vec![
        0x00, 0x00, 0x00, // table_id, section_length (patched)
        0x00, 0x01, // transport_stream_id
        0xC1, // reserved + version 0 + current_next
        0x00, 0x00, // section_number, last_section_number
    ];
    s.extend_from_slice(&OUT_PROGRAM.to_be_bytes());
    s.extend_from_slice(&(0xE000 | OUT_PMT_PID).to_be_bytes()); // reserved(3) + pid(13)
    finish_section(s)
}

/// The published PMT. No ES descriptors are emitted: every accepted stream type carries its own
/// configuration in-band (see `is_self_describing_*`), and copying descriptors forward from ONE segment
/// would attach the first ad's metadata to the whole session.
fn build_pmt(streams: &[(u8, u16)]) -> Vec<u8> {
    let mut s = vec![0x02, 0x00, 0x00];
    s.extend_from_slice(&OUT_PROGRAM.to_be_bytes());
    s.extend_from_slice(&[0xC1, 0x00, 0x00]); // version 0 + current_next, section 0 of 0
    s.extend_from_slice(&(0xE000 | OUT_VIDEO_PID).to_be_bytes()); // PCR_PID
    s.extend_from_slice(&[0xF0, 0x00]); // program_info_length = 0
    for &(stream_type, pid) in streams {
        s.push(stream_type);
        s.extend_from_slice(&(0xE000 | pid).to_be_bytes());
        s.extend_from_slice(&[0xF0, 0x00]); // ES_info_length = 0
    }
    finish_section(s)
}

/// Overwrite `pkt` with a complete PSI section on `pid`. Length-invariant: the section is padded out to the
/// full 188 bytes. `None` when the section would not fit one packet — this module never emits a table that
/// has to span packets, and would rather decline than write half of one.
fn write_section(pkt: &mut [u8], pid: u16, section: &[u8]) -> Option<()> {
    if 5 + section.len() > PKT {
        return None;
    }
    pkt[0] = SYNC;
    pkt[1] = 0x40 | ((pid >> 8) as u8 & 0x1F); // payload_unit_start_indicator
    pkt[2] = (pid & 0xFF) as u8;
    pkt[3] = 0x10; // payload only; the continuity counter is written by `apply`
    pkt[4] = 0x00; // pointer_field
    pkt[5..5 + section.len()].copy_from_slice(section);
    for b in &mut pkt[5 + section.len()..] {
        *b = 0xFF;
    }
    Some(())
}

/// Move a packet to `pid`, preserving the flags that share its two header bytes (TEI, PUSI, priority).
fn set_pid(pkt: &mut [u8], pid: u16) {
    pkt[1] = (pkt[1] & 0xE0) | ((pid >> 8) as u8 & 0x1F);
    pkt[2] = (pid & 0xFF) as u8;
}

/// Turn a packet into padding in place — pid 0x1FFF, no PUSI, payload-only, stuffed.
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

    // ── synthetic stream builders (the tsseg.rs fixture pattern) ─────────────────────────────────────────

    fn pkt(pid: u16, pusi: bool, pcr: Option<u64>, payload: &[u8]) -> Vec<u8> {
        let mut p = vec![0xFFu8; PKT];
        p[0] = SYNC;
        p[1] = ((pid >> 8) as u8 & 0x1F) | if pusi { 0x40 } else { 0 };
        p[2] = (pid & 0xFF) as u8;
        let start = if let Some(v) = pcr {
            p[3] = 0x30; // adaptation + payload
            p[4] = 7;
            p[5] = 0x90; // discontinuity_indicator + PCR_flag — the DI must come back out cleared
            p[6] = (v >> 25) as u8;
            p[7] = (v >> 17) as u8;
            p[8] = (v >> 9) as u8;
            p[9] = (v >> 1) as u8;
            p[10] = (((v & 1) as u8) << 7) | 0x7E; // reserved bits + ext[8] set, to prove they survive
            p[11] = 0xA5; // ext[7:0]
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

    /// A PES header carrying PTS (and optionally DTS), plus a little payload.
    fn pes(stream_id: u8, pts: u64, dts: Option<u64>) -> Vec<u8> {
        let mut v = vec![0x00, 0x00, 0x01, stream_id, 0x00, 0x00, 0x80];
        v.push(if dts.is_some() { 0xC0 } else { 0x80 }); // PTS_DTS_flags
        v.push(if dts.is_some() { 10 } else { 5 }); // PES_header_data_length
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

    /// PMT declaring H.264 video on VPID and AAC audio on APID.
    fn pmt() -> Vec<u8> {
        let mut sec = vec![
            0x02, 0xB0, 0x17, 0x00, 0x01, 0xC1, 0x00, 0x00,
            0xE0 | (VPID >> 8) as u8, (VPID & 0xFF) as u8, // PCR pid = video
            0xF0, 0x00,
            0x1B, 0xE0 | (VPID >> 8) as u8, (VPID & 0xFF) as u8, 0xF0, 0x00, // video
            0x0F, 0xE0 | (APID >> 8) as u8, (APID & 0xFF) as u8, 0xF0, 0x00, // audio
            0, 0, 0, 0,
        ];
        sec.insert(0, 0x00);
        pkt(PMTPID, true, None, &sec)
    }

    /// A 3-frame segment starting at `base`, with audio deliberately offset from video by `av_skew`.
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

    // ── splice fixtures: a segment with arbitrary pids, shaped like one side of a real pluto splice ──────

    fn pat_for(pmt_pid: u16) -> Vec<u8> {
        let mut s = vec![0x00, 0x00, 0x00, 0x00, 0x01, 0xC1, 0x00, 0x00];
        s.extend_from_slice(&1u16.to_be_bytes());
        s.extend_from_slice(&(0xE000 | pmt_pid).to_be_bytes());
        let mut body = vec![0x00]; // pointer_field
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

    /// 3 frames of H.264 + AAC on the given pids, optionally with a timed-ID3 stream alongside.
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

    // ── splice normalisation ─────────────────────────────────────────────────────────────────────────────

    /// The whole point, measured against the real thing: pluto moves the video pid, drops its timed-ID3
    /// stream and restarts the clock ~14 s in the past, all at once and with nothing signalling it.
    #[test]
    fn a_pluto_shaped_splice_leaves_as_one_continuous_program() {
        let program = side(0x100, 0x101, Some(0x1F6), 10_000_000);
        let ad = side(0x102, 0x101, None, 90_000); // new video pid, no ID3, clock far in the past

        let mut sp = Splicer::new();
        let a = sp.normalize(&program).expect("program normalises");
        let b = sp.normalize(&ad).expect("the ad normalises onto the SAME published program");

        // The fatal one: both sides leave on one published video pid, so a demuxer never sees the elementary
        // stream "move" and never registers a second one it will not render.
        assert_eq!(published_video_pid(&a), Some(OUT_VIDEO_PID));
        assert_eq!(published_video_pid(&b), Some(OUT_VIDEO_PID));
        assert!(packets_on(&b, 0x102).is_empty(), "the upstream ad pid is gone from the output");

        // …and the clock only ever moves forward, by one frame rather than 14 s backwards.
        let (sa, sb) = (scan(&a).unwrap(), scan(&b).unwrap());
        let gap = forward_gap(sa.last_dts, sb.first_dts);
        assert!(gap > 0 && gap <= HZ / 10, "the ad starts just after the program, not before it: {gap}");
    }

    #[test]
    fn the_published_pmt_is_byte_identical_across_the_splice() {
        // A PMT that changes shape mid-socket is itself a reconfiguration event, so the table must not vary
        // even though the two upstream sides declare different pids and a different stream count.
        let mut sp = Splicer::new();
        let a = sp.normalize(&side(0x100, 0x101, Some(0x1F6), 10_000_000)).unwrap();
        let b = sp.normalize(&side(0x102, 0x101, None, 90_000)).unwrap();
        // From byte 4: the SECTION. Byte 3's low nibble is the continuity counter, which must NOT match —
        // it is one advancing sequence across the join, which `continuity_counters_are_one_sequence…` pins.
        assert_eq!(packets_on(&a, OUT_PMT_PID)[0][4..], packets_on(&b, OUT_PMT_PID)[0][4..]);
        assert_eq!(packets_on(&a, 0)[0][4..], packets_on(&b, 0)[0][4..], "…and so is the PAT");
    }

    #[test]
    fn the_vanishing_id3_pid_becomes_padding_and_length_is_invariant() {
        // Length invariance is the ring's byte accounting: the rewrite must not insert or drop a packet.
        let program = side(0x100, 0x101, Some(0x1F6), 10_000_000);
        let mut sp = Splicer::new();
        let a = sp.normalize(&program).unwrap();
        assert_eq!(a.len(), program.len(), "nothing inserted, nothing dropped");
        assert!(packets_on(&a, 0x1F6).is_empty(), "the ID3 pid is not published");
        assert_eq!(packets_on(&a, 0x1FFF).len(), 3, "…it became padding instead");
    }

    #[test]
    fn continuity_counters_are_one_sequence_across_the_splice() {
        // Two upstream video pids fold onto one published pid; if the counter restarted at the join a strict
        // demuxer would report it as lost packets — the very thing the rewrite is meant to prevent.
        let mut sp = Splicer::new();
        let a = sp.normalize(&side(0x100, 0x101, Some(0x1F6), 10_000_000)).unwrap();
        let b = sp.normalize(&side(0x102, 0x101, None, 90_000)).unwrap();
        let last = packets_on(&a, OUT_VIDEO_PID).last().unwrap()[3] & 0x0F;
        let first = packets_on(&b, OUT_VIDEO_PID)[0][3] & 0x0F;
        assert_eq!(first, (last + 1) & 0x0F, "the published counter continues through the join");
    }

    #[test]
    fn the_discontinuity_indicator_stays_cleared_through_a_splice() {
        // A splice we have ERASED must not also be announced: a stale indicator tells the player to resync on
        // a clock that no longer jumps. (The fixture sets the bit on every PCR packet.)
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
        // AC-3 (0x81) is not self-describing — its identity lives in a registration descriptor this pass does
        // not carry. Dropping it would be SILENT audio loss, so the whole segment declines and the caller
        // falls back to serving upstream bytes.
        let f = HZ / 25;
        let mut s = Vec::new();
        s.extend(pat_for(PMTPID));
        s.extend(pmt_for(PMTPID, 0x100, &[(0x1B, 0x100), (0x81, 0x101)]));
        s.extend(pkt(0x100, true, Some(0), &pes(0xE0, f, Some(0))));
        assert!(Splicer::new().normalize(&s).is_none(), "declines rather than publishing without the audio");
    }

    #[test]
    fn a_segment_whose_pcr_is_not_on_a_published_pid_is_declined() {
        // Losing the PCR would leave the output with no clock reference at all.
        let f = HZ / 25;
        let mut s = Vec::new();
        s.extend(pat_for(PMTPID));
        s.extend(pmt_for(PMTPID, 0x1F6, &[(0x1B, 0x100), (0x0F, 0x101), (0x15, 0x1F6)])); // PCR on the ID3 pid
        s.extend(pkt(0x100, true, Some(0), &pes(0xE0, f, Some(0))));
        assert!(Splicer::new().normalize(&s).is_none());
    }

    #[test]
    fn reset_re_anchors_the_timeline_after_a_ring_skip() {
        let mut sp = Splicer::new();
        let a = sp.normalize(&side(0x100, 0x101, None, 10_000_000)).unwrap();
        sp.reset();
        // After a reset the next segment anchors where it already is, rather than being spaced against a
        // clock whose media the client never received.
        let b = sp.normalize(&side(0x100, 0x101, None, 90_000)).unwrap();
        assert_eq!(scan(&b).unwrap().first_dts, 90_000);
        assert_ne!(scan(&a).unwrap().first_dts, scan(&b).unwrap().first_dts);
    }

    #[test]
    fn psi_sections_carry_a_valid_mpeg_crc() {
        // A section with a bad CRC is discarded outright by a conforming demuxer, which would leave the
        // output with no program at all.
        for section in [build_pat(), build_pmt(&[(0x1B, OUT_VIDEO_PID), (0x0F, OUT_AUDIO_BASE)])] {
            let (body, crc) = section.split_at(section.len() - 4);
            assert_eq!(crc32_mpeg(body).to_be_bytes(), crc, "CRC-32/MPEG-2 over the section body");
            // section_length must describe exactly the bytes that follow it, CRC included.
            let declared = (((section[1] & 0x0F) as usize) << 8) | section[2] as usize;
            assert_eq!(declared, section.len() - 3);
        }
    }

    /// The bug measurement caught in production: published duration MUST equal real duration. Advancing past
    /// `max_pts` on fresh media inserted the reorder delay as phantom time on every join — +0.50 % live.
    #[test]
    fn a_run_of_fresh_segments_adds_no_phantom_time() {
        const N: u64 = 12;
        let f = HZ / 25;
        let mut sp = Splicer::new();
        let (mut first, mut last) = (None, 0u64);
        for i in 0..N {
            // Each segment is 3 frames of DIFFERENT media, contiguous in decode order at the source.
            let out = sp.normalize(&side(0x100, 0x101, None, 1_000_000 + i * 3 * f)).unwrap();
            let s = scan(&out).unwrap();
            first.get_or_insert(s.first_dts);
            last = s.last_dts;
        }
        // 12 segments × 3 frames, so the span from the first stamp to the last is 35 frame intervals.
        assert_eq!(forward_gap(first.unwrap(), last), (N * 3 - 1) * f, "no join may invent time");
    }

    /// …and the other half of the same decision, pinned at the clock layer: with `repeat` set, a segment must
    /// clear the previous one's PRESENTATION, or the copy's first frame lands before the original's last and
    /// playback runs backwards across the join. See `Normalizer::offset_for` for why both arms exist.
    #[test]
    fn a_repeat_still_clears_the_originals_presentation() {
        let seg = segment(1_000_000, 0); // `segment` builds PTS = DTS + one frame, i.e. real reorder lead
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
        // The caller uses this to decide whether a splice was ABSORBED. Anchoring leaves the clock alone, so
        // upstream's discontinuity still governs; joining moves it, so the splice is gone.
        let mut sp = Splicer::new();
        assert!(!sp.has_timeline(), "a fresh splicer anchors");
        sp.normalize(&side(0x100, 0x101, None, 10_000_000)).unwrap();
        assert!(sp.has_timeline(), "…and joins from then on");
        sp.reset();
        assert!(!sp.has_timeline(), "reset returns it to anchoring");
    }

    // ── codec-level invariants ───────────────────────────────────────────────────────────────────────────

    #[test]
    fn timestamp_codec_round_trips_byte_identically() {
        // The property that lets every other rewrite be trusted: decoding and re-encoding a stamp must not
        // disturb ANY bit — including the three marker bits and the prefix nibble.
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
        b[4] = 0x7E; // reserved(6) + ext[8]
        b[5] = 0xA5; // ext[7:0]
        shift_pcr(&mut b, 0);
        assert_eq!(b[4] & 0x7F, 0x7E, "6 reserved bits + ext[8] survive a zero shift");
        assert_eq!(b[5], 0xA5, "ext[7:0] is never touched");
        shift_pcr(&mut b, HZ);
        assert_eq!(b[4] & 0x7F, 0x7E, "…and survive a real shift too");
        assert_eq!(b[5], 0xA5);
    }

    // ── segment-level invariants ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_repeated_segment_is_rebased_onto_a_forward_timeline() {
        let seg = segment(1_000_000, 0);
        let s0 = scan(&seg).unwrap();
        let mut n = Normalizer::new();
        // First pass anchors where it already is: offset zero, so no clock moves. (The bytes are not
        // identical — the discontinuity_indicator is cleared and continuity counters are renumbered — but
        // nothing on the timeline shifts.)
        let a = n.rewrite(&seg, None, true).expect("rebase");
        let sa = scan(&a).unwrap();
        assert_eq!(sa.first_dts, s0.first_dts, "a fresh timeline does not move the first segment");
        assert_eq!(sa.last_dts, s0.last_dts);

        // Re-emitting the SAME bytes must come out later, which is the whole point.
        let b = n.rewrite(&seg, None, true).expect("rebase");
        let sb = scan(&b).unwrap();
        assert_ne!(b, seg, "a repeat must be moved");
        // Spaced one frame past everything the original PRESENTS, not merely past its last decode stamp —
        // otherwise a reordered stream's presentation would overlap across the join.
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

    /// THE A/V test. A per-PID offset would replace the stream's authored skew with an arbitrary one — a
    /// lip-sync error we invented. A single uniform offset is affine, so the skew must survive bit-exactly.
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
                continue; // CC only advances on payload-bearing packets
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
        // A stale DI tells the player to resync on a clock we have just made continuous.
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
        // 33 bits roll over about every 26.5 h; a wrap must read as "a bit later", never as a huge jump back.
        let seg = segment(CLOCK_MASK - 5_000, 0);
        let mut n = Normalizer::new();
        let a = n.rewrite(&seg, None, true).unwrap();
        let b = n.rewrite(&seg, None, true).unwrap();
        let (sa, sb) = (scan(&a).unwrap(), scan(&b).unwrap());
        assert_eq!(forward_gap(sa.max_pts, sb.first_dts), HZ / 25, "the join is one frame even across the wrap");
        // Fixture sanity: the first segment starts near the top of the 33-bit clock and its presentation has
        // already rolled past zero, so a naive `<` comparison anywhere in this module would read the join as
        // an ~26.5 h jump backwards instead of one frame forwards.
        assert!(sa.first_dts > sa.max_pts, "the fixture really does straddle the rollover");
    }

    #[test]
    fn two_different_segments_join_exactly_one_frame_apart() {
        // Every segment is rewritten now, so the join between two DIFFERENT ones has to land one frame after
        // the previous ended — not on top of it, and not with a gap. (This used to be covered via `observe`,
        // which existed only to adopt un-normalised ring bytes; the ring holds normalised media now, so the
        // scenario it described no longer occurs.)
        let first = segment(7_000_000, 0);
        let mut n = Normalizer::new();
        let a = n.rewrite(&first, None, false).unwrap();
        let b = n.rewrite(&segment(1_000, 0), None, false).unwrap();
        let (sa, sb) = (scan(&a).unwrap(), scan(&b).unwrap());
        // Decode-order contiguity, exactly as the source had it — anything larger is phantom time.
        assert_eq!(forward_gap(sa.last_dts, sb.first_dts), HZ / 25);
    }

    // ── bail-out paths: every one must decline rather than guess ─────────────────────────────────────────

    #[test]
    fn declines_a_segment_with_no_psi() {
        let mut n = Normalizer::new();
        assert!(n.rewrite(&pkt(VPID, true, None, &pes(0xE0, 90_000, None)), None, true).is_none());
    }

    #[test]
    fn declines_scrambled_and_timestampless_segments() {
        let mut scrambled = segment(1_000, 0);
        for i in (0..scrambled.len()).step_by(PKT) {
            scrambled[i + 3] |= 0xC0; // transport_scrambling_control
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
        // Set ESCR_flag on the first video PES — a second 33-bit clock we refuse to guess at.
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
        // After a reset the next segment anchors itself again rather than being spaced against a clock that
        // belongs to an upstream we are no longer following.
        let after = n.rewrite(&seg, None, true).unwrap();
        assert_eq!(scan(&after).unwrap().first_dts, scan(&seg).unwrap().first_dts, "offset is zero again");
    }
}
