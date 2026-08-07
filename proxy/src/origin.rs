//! S3/ORIGIN — masqueradarr as the ORIGIN rather than a rewriting proxy.
//!
//! The rest of the data plane PROXIES: `manifest::rewrite_manifest` rewrites the upstream playlist's URIs and
//! passes everything else through, so the client still sees the origin's timeline — its media sequence, its
//! `#EXT-X-KEY`, its vendor tags. This module inverts that. ONE refcounted INGEST per channel follows the
//! upstream, decrypts each segment, and pushes it into an in-memory RING; Phase 2's renderers then serve a
//! stream masqueradarr AUTHORED — our sequence numbers, our segment paths, no keys, no vendor tags, no hops.
//!
//! SIDE-1 (ingest) is everything in this module. SIDE-2 (the HLS + raw-TS renderers over the same ring) is
//! Phase 2; this phase deliberately ships NO client surface, which is why the `iop` telemetry below lands with
//! it rather than after — logs are the only way to see an ingest that nothing is watching yet.
//!
//! Two properties worth stating up front, because they are what make the ring worth having:
//!   · ONE ingest serves N viewers, so upstream load stops scaling with viewer count — and ingress and egress
//!     become independent quantities. That is the whole reason ingest logs/events are tagged `iop` and egress
//!     `oop`: a stuttering channel is now either a Side-1 or a Side-2 problem, and the tags say which.
//!   · The ring runs AHEAD of the client, so an upstream hiccup is absorbed once for everyone instead of
//!     surfacing as a stall in every viewer's socket (today a client stall IS an upstream stall).
//!
//! RAM: the ring is bounded by BYTES (`originRingMb`, default 25 MiB/channel), oldest evicted first, with a
//! hard `MIN_SEGMENTS` floor because an HLS window shorter than ~3 target durations is unplayable. When the
//! floor beats the cap (a high-bitrate source), that is logged as an `iop` WARN naming the effective window —
//! the operator is told to raise the dial rather than left chasing unexplained stalls. There is deliberately
//! NO global ceiling across channels yet; that is the postponed `LRU` item in the plan.
//!
//! NEVER written to disk. The ring holds DECRYPTED upstream media, so it stays in memory and dies with the
//! process.

use bytes::Bytes;
use percent_encoding::percent_decode_str;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::Notify;
use tokio_stream::StreamExt;
use url::Url;

use crate::log;
use crate::proxy::{build_headers, fetch_with_retry, is_private_host, MAX_UPSTREAM_RETRIES};
use crate::state::{AppState, SourcePolicy};
use crate::sync::{LockExt, RwExt};
use crate::tsmux::{
    decrypt_aes128_cbc, has_map, is_master, parse_media_playlist, pick_variant, poll_interval, unsupported_encryption,
    CueKind, SegRef,
};

/// Per-channel ring cap, MiB. Shipped default; the operator raises it per playlist via `originRingMb`.
/// ≈60 s at 3.3 Mbps — a comfortable live window for a typical source, and ~25 MiB of RAM for one channel.
pub const DEFAULT_RING_MB: u64 = 25;

/// The HLS live window must hold at least this many segments to be playable (the spec's guidance is ≥3 target
/// durations). This is a FLOOR that beats the byte cap: a 15 Mbps source fits only ~2.6 × 5 s segments in
/// 25 MiB, and silently serving a 2-segment window would look like a player bug, not a config problem.
const MIN_SEGMENTS: usize = 3;

/// How long an ingest keeps running after its LAST subscriber leaves. Channel-flipping back within the window
/// is then instant (the ring is still warm) instead of paying a fresh resolve + prebuffer.
const IDLE_GRACE: Duration = Duration::from_secs(30);

/// Cadence for the "still idle?" check. Cheap — it only wakes to compare two integers and a timestamp.
const IDLE_TICK: Duration = Duration::from_secs(5);

/// A media playlist that returns nothing usable this many polls in a row is treated as dead: the ingest
/// re-resolves (Node re-runs `resolveStream`, driving mirror rotation) rather than spinning on a dead target.
const MAX_EMPTY_POLLS: u32 = 5;

/// …but re-resolving the SAME candidate only recovers an expired token or a rotated mirror. After this many
/// consecutive failures to produce a playable window, the ingest advances the stream's failover cursor
/// instead (`AppState::resolve_advance`) so it reaches the source's alternate upstreams — dlhd's six player
/// providers are independent, and a channel dropped by one of them is carried by another — and then the
/// channel's configured backups. Without this an origin-mode stream can never fail over at all: it owns its
/// own retry loop and never passes through the handler's `failover_walk`.
const MEDIA_FAIL_ESCALATE: u32 = 2;

/// How many recently-ingested upstream segment URIs the ingest remembers, for recognising the window a
/// RENEWED provider session re-offers (see `dedupe_by_uri`). About one live window plus slack — small enough
/// that a source recycling segment names would have to wrap within it to cause a false skip.
const RECENT_URI_MEMORY: usize = 64;

/// How many trailing PROGRAM segments an ad break loops as filler — an upper bound, not a requirement:
/// `program_tail` returns whatever the ring actually holds, and `MIN_SEGMENTS` guarantees at least 3.
///
/// Sized for the LOOP, not the ring. A pluto pod runs ~2 min against 5 s segments, so a 3-segment pool would
/// repeat ~8 times where six repeats ~4 — the same material either way, but half as obviously a loop. Six is
/// ~30 s, still comfortably inside a default 25 MiB window (measured ~16 segments), and the pool is held by
/// `Arc` for the length of the break, so this is also its memory cost.
const FILLER_SEGMENTS: usize = 6;

/// One ingested segment, ready to serve verbatim. `bytes` is DECRYPTED — ciphertext never enters the ring, so
/// a renderer never has to know whether the upstream was encrypted.
// Phase 1 WRITES every field; Phase 2's renderers READ them (seq → #EXT-X-MEDIA-SEQUENCE, duration → #EXTINF,
// discontinuity → #EXT-X-DISCONTINUITY, pdt → #EXT-X-PROGRAM-DATE-TIME). Drop this allow when they land.
#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct Segment {
    /// OUR sequence, monotonic from ingest start. Deliberately unrelated to the upstream's media sequence:
    /// the client's timeline is ours, and an upstream that renumbers (or a failover onto a different origin)
    /// must not make our `#EXT-X-MEDIA-SEQUENCE` jump backwards.
    pub seq: u64,
    pub duration: f64,
    pub bytes: Bytes,
    /// Emit `#EXT-X-DISCONTINUITY` BEFORE this segment — see `boundary_before`.
    pub discontinuity: bool,
    /// Ingest wall-clock → the renderer's `#EXT-X-PROGRAM-DATE-TIME`.
    pub pdt: SystemTime,
    /// This segment is ad-break content (`ad_signal` fired). Phase 1 only WRITES this — nothing is served
    /// differently — so the operator can see breaks in `iop:cue` before anything acts on them.
    pub ad: bool,
    /// Which break, for grouping a pod's segments in logs/telemetry. 0 ⇒ not in a break.
    pub break_id: u64,
}

/// Why a segment is a splice point. Named rather than a bare bool so the `iop` log says WHICH signal fired.
///
/// Only the two signals the HLS spec actually defines a discontinuity by. A third — "the segment URL's
/// directory changed" — was tried and REMOVED after two independent false positives on live pluto:
///   · the keyfile rotates *within* a clip (`…keyfile_5 → _6 → _7`, same directory), and
///   · some CDN paths carry a PER-SEGMENT opaque token (`…/v1/UWJ5Mz0j0e…=/`), so the "directory" is never
///     stable even mid-clip.
/// It produced ~9 spurious splices per window and never a true positive the upstream tag missed — RFC 8216
/// requires the source to emit `#EXT-X-DISCONTINUITY` itself, and pluto does. Guessing from URL shape cannot
/// be made reliable across CDNs, and each false positive forces a needless client decoder reset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Boundary {
    /// The upstream playlist carried an explicit `#EXT-X-DISCONTINUITY`.
    Tag,
    /// The media sequence skipped — we missed segments (a slow poll, or the window slid past us).
    SequenceGap,
    /// Program resumed after an ad break we REPLACED with filler. The filler was rebased onto our timeline,
    /// so the returning upstream media does not continue it — that jump is real and is signalled. It is the
    /// one seam replacement cannot remove without normalising every segment forever, and unlike the ad
    /// boundary it replaces (720p ⇄ 1080p on pluto) both sides are the same encode, so a player resyncs its
    /// clock rather than reconfiguring its decoder.
    AdReturn,
    /// The provider ended OUR playlist (`#EXT-X-ENDLIST`) and we re-resolved onto a new session on the same
    /// channel. Whether the bytes either side are contiguous is unknowable from here — a new session may
    /// resume where the old one stopped or jump — so the join is SIGNALLED rather than assumed. This is the
    /// one boundary we introduce ourselves; the other two are read off the upstream.
    SessionRenewal,
}

/// What the previous ingested segment looked like, for boundary detection against the next one.
#[derive(Clone, Debug, Default)]
struct PrevSeg {
    upstream_seq: Option<i64>,
}

/// Decide whether `seg` (at upstream sequence `upstream_seq`) starts a new continuity region.
///
/// Pure so it can be tested without a network. Each trigger is independently sufficient.
fn boundary_before(prev: &PrevSeg, seg: &SegRef, upstream_seq: i64) -> Option<Boundary> {
    if seg.discontinuity {
        return Some(Boundary::Tag);
    }
    // A gap means we did NOT ingest the intervening segments, so the bytes on either side are not contiguous —
    // that is a splice whether or not the upstream tagged it. `prev + 1 == cur` is the only continuous case.
    if let Some(p) = prev.upstream_seq {
        if upstream_seq != p + 1 {
            return Some(Boundary::SequenceGap);
        }
    }
    None
}

/// Does an `#EXT-X-ENDLIST` mean the CHANNEL is finished, or only that the provider ended THIS session's
/// playlist?
///
/// The tag says "this playlist will not grow again" — which is not the same claim. A provider that expires
/// its stitcher session ends the playlist too: pluto does it roughly every 25 s (a freshly booted session's
/// playlist carries no ENDLIST at all, so the tag appears purely as a session-lifetime artifact), and
/// treating it as terminal tore the ingest down over and over on a channel that was still live.
///
/// So the ingest re-resolves instead, and the terminal condition is EVIDENCE rather than the tag: a genuinely
/// finished asset re-resolves to the very same segment list, while a renewed session hands back a different
/// one. Comparing the URI list (not a byte-compare of the body — session ids and tokens churn in the header
/// lines without meaning anything) is what separates them.
///
/// An EMPTY list is the case that has to be excluded by name. It looks "unchanged" against the previous empty
/// one, but it is not evidence of completion — it is evidence of NOTHING, and it is exactly what pluto serves
/// once it has ended our session. A finished asset always still lists its segments. Treating empty-equals-
/// empty as terminal reintroduced the original teardown at a slower cadence, which is how it was caught.
///
/// Deliberately has no attempt cap. A live channel behind a session-expiring provider renews indefinitely and
/// legitimately; capping it would kill a working stream after N sessions, which is the bug this replaces.
/// A source that only ever returns an empty playlist is caught by MAX_EMPTY_POLLS instead, which escalates
/// through failover rather than declaring success.
fn endlist_is_terminal(prev: Option<&Vec<String>>, cur: &[String]) -> bool {
    !cur.is_empty() && prev.is_some_and(|p| p.as_slice() == cur)
}

/// Which signal said a segment is ad-break content. Named for the same reason `Boundary` is: the `iop:cue`
/// log has to name the trigger, or a detector bug reads exactly like real ad-pod churn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdSignal {
    /// An `#EXT-X-CUE-OUT` was open over this segment.
    CueTag,
    /// …or an `#EXT-X-DATERANGE:…SCTE35-OUT=…`.
    DateRange,
    /// The manifest carried NO cue tag and the segment URI matched the adapter's declared ad signature.
    UriSignature,
}

/// Classify one segment as ad-break content.
///
/// Cue tags WIN when present — they are the source's own statement about its own timeline. The URI signature
/// is a strict fallback for sources that emit none (pluto), never a cross-check: a source that tags its
/// breaks is believed even when its segment URIs happen to look unusual.
///
/// The URI arm is why this is safe where the removed `ClipChange` heuristic was not. That one DIFFED
/// consecutive segment URIs and asked "did the directory change?", which pluto's in-clip keyfile rotation and
/// some CDNs' per-segment opaque path tokens both answer "yes" spuriously (~9 false splices per window). This
/// one tests a segment against a FIXED literal the adapter opted into, so an adapter that declares nothing
/// detects nothing, and no amount of upstream URL churn can manufacture a match.
fn ad_signal(seg: &SegRef, seg_url: &Url, ad_uri_contains: &[String]) -> Option<AdSignal> {
    if let Some(cue) = seg.cue {
        return Some(match cue.kind {
            CueKind::CueOut => AdSignal::CueTag,
            CueKind::DateRange => AdSignal::DateRange,
        });
    }
    if ad_uri_contains.is_empty() {
        return None; // fail closed — no adapter opted in
    }
    // The patterns are already lowercased by state.rs; percent-decode so a declared `0_ad/creative/` matches
    // the wire form `0_ad%2Fcreative%2F`.
    let decoded = percent_decode_str(seg_url.as_str()).decode_utf8_lossy().to_lowercase();
    ad_uri_contains
        .iter()
        .any(|p| decoded.contains(p))
        .then_some(AdSignal::UriSignature)
}

/// An ad break currently open on the ingest. Accumulates what the `iop:cue` close line + telemetry report.
#[derive(Clone, Debug)]
struct AdBreak {
    id: u64,
    signal: AdSignal,
    segments: u32,
    /// Observed duration — the sum of the `#EXTINF`s we actually ingested, NOT the announced total. Packagers
    /// routinely close a break early, and pluto announces nothing at all.
    seconds: f64,
    /// What the opening cue tag announced, when it announced anything (0.0 otherwise).
    announced: f64,
    /// Whether the decoder configuration actually changed at this edge. THE measurement Phase 2 is gated on:
    /// if breaks reliably change it, no timestamp rewrite can ever hide the seam and only substitution can.
    profile_changed: bool,
    /// How many of this break's segments were SUBSTITUTED rather than served. Less than `segments` means the
    /// rewriter declined some — filler is best-effort by design, and the gap between the two is what says so.
    replaced: u32,
}

/// A channel's live ring plus its ingest bookkeeping. Shared as `Arc<Origin>`: the ingest task holds one and
/// every subscriber holds one, so the registry can drop its entry while a straggling reader still finishes.
pub struct Origin {
    /// The live window, oldest first.
    ring: RwLock<VecDeque<Arc<Segment>>>,
    /// Byte total of everything currently in `ring` — kept alongside so eviction never walks the deque.
    ring_bytes: AtomicU64,
    /// Next sequence to assign. Monotonic for the life of the Origin, across failovers and ring resets.
    next_seq: AtomicU64,
    /// Bumped whenever the ring is RESET (a failover onto a different upstream). A renderer includes it in
    /// segment paths so a client holding a stale URL gets a clean 404 rather than another channel's bytes.
    generation: AtomicU64,
    /// Live subscriber count — drives the idle shutdown.
    subscribers: AtomicU32,
    /// Last time a subscriber attached or the ring was read.
    last_access: Mutex<Instant>,
    /// Max `#EXT-X-TARGETDURATION` observed, ms. The renderer needs it; the poll loop uses it for cadence.
    target_duration_ms: AtomicU64,
    /// Ring cap in bytes, from the grant's `originRingMb`.
    ring_cap_bytes: AtomicU64,
    /// Set when the ingest should wind down. Checked at every loop head.
    stopping: AtomicBool,
    /// Woken when a segment lands, so a renderer can await new data instead of polling the ring.
    notify: Notify,
    /// Cumulative ingest counters — reported on the `iop` event.
    ingested_segments: AtomicU64,
    ingested_bytes: AtomicU64,
    evicted_segments: AtomicU64,
    /// RFC 8216 `EXT-X-DISCONTINUITY-SEQUENCE` — see `disc_seq()`.
    disc_seq: AtomicU64,
}

impl Origin {
    fn new(ring_cap_bytes: u64) -> Self {
        Self {
            ring: RwLock::new(VecDeque::new()),
            ring_bytes: AtomicU64::new(0),
            next_seq: AtomicU64::new(0),
            generation: AtomicU64::new(0),
            subscribers: AtomicU32::new(0),
            last_access: Mutex::new(Instant::now()),
            target_duration_ms: AtomicU64::new(0),
            ring_cap_bytes: AtomicU64::new(ring_cap_bytes),
            stopping: AtomicBool::new(false),
            notify: Notify::new(),
            ingested_segments: AtomicU64::new(0),
            ingested_bytes: AtomicU64::new(0),
            evicted_segments: AtomicU64::new(0),
            disc_seq: AtomicU64::new(0),
        }
    }

    /// Append a segment and evict from the front until the ring fits its byte cap.
    ///
    /// Returns how many segments were evicted. The `MIN_SEGMENTS` floor is enforced HERE rather than by the
    /// caller because it is a property of the window, not of any one push: dropping below it produces a
    /// manifest no player will start, which is worse than briefly exceeding the RAM cap.
    ///
    /// `from_upstream` says whether these bytes were actually PULLED. Substituted filler is built from the
    /// ring itself and costs no upstream traffic, so counting it would overstate the very number an operator
    /// reads to size `originRingMb` and to see the ring earning its keep (`ingest` vs `bandwidth` on the
    /// Active Streams row). The ring's own byte accounting still includes it — it really is occupying RAM.
    fn push(&self, seg: Segment, from_upstream: bool) -> usize {
        let bytes = seg.bytes.len() as u64;
        let cap = self.ring_cap_bytes.load(Ordering::Relaxed);
        let mut evicted = 0usize;
        {
            let mut ring = self.ring.write_ok();
            ring.push_back(Arc::new(seg));
            let mut total = self.ring_bytes.load(Ordering::Relaxed) + bytes;
            while total > cap && ring.len() > MIN_SEGMENTS {
                match ring.pop_front() {
                    Some(old) => {
                        total -= old.bytes.len() as u64;
                        // THE INVARIANT: `disc_seq` counts discontinuity tags that have LEFT the published
                        // playlist. A tag rides on the segment it precedes, so evicting that segment is
                        // exactly when its tag stops being visible — and every segment still held is by
                        // definition after it.
                        if old.discontinuity {
                            self.disc_seq.fetch_add(1, Ordering::Relaxed);
                        }
                        evicted += 1;
                    }
                    None => break,
                }
            }
            self.ring_bytes.store(total, Ordering::Relaxed);
        }
        if evicted > 0 {
            self.evicted_segments.fetch_add(evicted as u64, Ordering::Relaxed);
        }
        if from_upstream {
            self.ingested_segments.fetch_add(1, Ordering::Relaxed);
            self.ingested_bytes.fetch_add(bytes, Ordering::Relaxed);
        }
        self.notify.notify_waiters();
        evicted
    }

    /// True when the byte cap could not be honored because the `MIN_SEGMENTS` floor won — i.e. this channel's
    /// bitrate does not fit `originRingMb`. Surfaced as an `iop` WARN by the ingest (once per transition).
    fn floor_beat_cap(&self) -> bool {
        let ring = self.ring.read_ok();
        ring.len() <= MIN_SEGMENTS && self.ring_bytes.load(Ordering::Relaxed) > self.ring_cap_bytes.load(Ordering::Relaxed)
    }

    /// Reset the window after a failover onto a different upstream: the old bytes belong to a different
    /// timeline. `next_seq` is deliberately NOT reset — see its doc comment.
    fn reset_ring(&self) {
        let mut ring = self.ring.write_ok();
        // Same invariant as eviction: every tag in the discarded window leaves the playlist at once. Counting
        // them here (rather than resetting to 0) is what keeps `#EXT-X-DISCONTINUITY-SEQUENCE` monotonic
        // across a failover, which RFC 8216 requires of it just as it does of the media sequence.
        let leaving = ring.iter().filter(|s| s.discontinuity).count() as u64;
        self.disc_seq.fetch_add(leaving, Ordering::Relaxed);
        ring.clear();
        self.ring_bytes.store(0, Ordering::Relaxed);
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    /// Discontinuity tags that have left the published window — RFC 8216's `EXT-X-DISCONTINUITY-SEQUENCE`,
    /// i.e. the discontinuity sequence number of the window's FIRST segment. Monotonic by construction: it
    /// only ever counts tags on their way out.
    fn disc_seq(&self) -> u64 {
        self.disc_seq.load(Ordering::Relaxed)
    }

    /// A snapshot of the live window, oldest first. Phase 2's renderers build both output shapes from this.
    #[allow(dead_code)] // consumed by the Phase 2 renderers
    pub fn window(&self) -> Vec<Arc<Segment>> {
        *self.last_access.lock_ok() = Instant::now();
        self.ring.read_ok().iter().cloned().collect()
    }

    /// The last `n` PROGRAM segments in the ring, oldest first.
    ///
    /// Replacement material for an ad break. Returned as `Arc` clones so eviction cannot pull the bytes out
    /// from under a break that is still running — a 2-minute pod outlives the window it was drawn from.
    /// Filtering on `!ad` matters once a previous break's filler is still in the window: filler is itself
    /// marked as break content, and looping a loop would compound the repetition.
    ///
    /// Deliberately does NOT touch `last_access`: this is the ingest reading its own ring, not a viewer.
    pub fn program_tail(&self, n: usize) -> Vec<Arc<Segment>> {
        let ring = self.ring.read_ok();
        let mut out: Vec<Arc<Segment>> = ring.iter().rev().filter(|s| !s.ad).take(n).cloned().collect();
        out.reverse();
        out
    }

    /// The current generation — part of a renderer's segment paths.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    /// Max observed target duration, seconds (0.0 until the first poll).
    pub fn target_duration(&self) -> f64 {
        self.target_duration_ms.load(Ordering::Relaxed) as f64 / 1000.0
    }

    /// Wait until the next segment lands (or return immediately if one already has since the caller looked).
    #[allow(dead_code)] // consumed by the Phase 2 renderers (a client awaits new data instead of polling)
    pub async fn wait_for_segment(&self) {
        self.notify.notified().await;
    }

    fn ring_depth(&self) -> usize {
        self.ring.read_ok().len()
    }
}

/// An RAII subscription. Holding one keeps the ingest alive; dropping it releases the channel to the idle
/// grace window. Phase 2's renderers hold one for the life of a client session.
pub struct OriginLease {
    origin: Arc<Origin>,
}

impl OriginLease {
    #[allow(dead_code)] // the Phase 2 renderers read the ring through their lease
    pub fn origin(&self) -> &Arc<Origin> {
        &self.origin
    }
}

impl Drop for OriginLease {
    fn drop(&mut self) {
        self.origin.subscribers.fetch_sub(1, Ordering::Relaxed);
        *self.origin.last_access.lock_ok() = Instant::now();
    }
}

/// Subscribe to a channel's origin, starting the ingest if this is the first subscriber.
///
/// Idempotent per `(source, entry)`: concurrent callers share one ingest, which is the entire point — upstream
/// load is per CHANNEL, not per viewer.
pub fn subscribe(state: &AppState, source: &str, entry: &str, pl: Option<&str>, policy: &Arc<SourcePolicy>) -> OriginLease {
    let key = crate::state::target_key(source, entry);
    let cap = policy.origin_ring_mb.load(Ordering::Relaxed).saturating_mul(1024 * 1024);
    let (origin, start) = {
        let mut map = state.origins().lock_ok();
        match map.get(&key) {
            Some(o) => {
                // A re-resolve may have changed the cap; apply it to the live ring so raising the dial takes
                // effect without a restart (it shrinks lazily, as new pushes evict against the new cap).
                o.ring_cap_bytes.store(cap, Ordering::Relaxed);
                (o.clone(), false)
            }
            None => {
                let o = Arc::new(Origin::new(cap));
                map.insert(key.clone(), o.clone());
                (o, true)
            }
        }
    };
    origin.subscribers.fetch_add(1, Ordering::Relaxed);
    *origin.last_access.lock_ok() = Instant::now();
    if start {
        let ctx = IngestCtx {
            state: state.clone(),
            origin: origin.clone(),
            source: source.to_string(),
            entry: entry.to_string(),
            pl: pl.map(|s| s.to_string()),
            key,
        };
        tokio::spawn(ingest(ctx));
    }
    OriginLease { origin }
}

struct IngestCtx {
    state: AppState,
    origin: Arc<Origin>,
    source: String,
    entry: String,
    pl: Option<String>,
    key: String,
}

/// The Side-1 loop: resolve → follow the media playlist → fetch + decrypt each new segment → push to the ring.
///
/// Structured as one task per channel so backpressure, failover and shutdown are all local to it. Every line
/// logs under `iop`; the periodic `kind:"iop"` event carries the counters Node needs to show ingest health
/// beside egress.
async fn ingest(ctx: IngestCtx) {
    let rid = format!("iop{}", ctx.state.next_stream_id());
    log::info("iop", &rid, || {
        format!("ingest start {}/{}", ctx.source, crate::proxy::host_of(&ctx.entry))
    });

    let mut prev = PrevSeg::default();
    let mut next_upstream_seq: i64 = -1;
    let mut empty_polls: u32 = 0;
    let mut key_cache: Option<(String, [u8; 16])> = None;
    let mut warned_floor = false;
    let mut media: Option<(Url, String)> = None;
    // S3/CUE: the ad break open right now (None = program), and the label counter for the next one. Per-ingest
    // like `prev` — a break id is a session-local grouping label, not a stable identity.
    let mut ad_break: Option<AdBreak> = None;
    let mut next_break_id: u64 = 0;
    // The decoder-configuration fingerprint as of the last EDGE we looked at. Only sampled at splices and
    // ad-state changes — that is where the answer matters, and it keeps the packet walk off the steady path.
    let mut last_profile: Option<crate::tsseg::StreamProfile> = None;
    // Segment URIs of the last playlist that carried #EXT-X-ENDLIST — the baseline `endlist_is_terminal`
    // judges the next one against. See there for why the tag alone cannot end the ingest.
    let mut last_endlist: Option<Vec<String>> = None;
    // Set while the pending re-resolve is a SESSION RENEWAL rather than a failure, so the resolve branch
    // knows to keep the ring; `force_boundary` then carries the splice onto the first segment of the new
    // session (consumed by the push, so a failed fetch cannot lose it).
    let mut renewing_session = false;
    // A splice WE introduce, pending until a segment lands to carry it (a failed fetch must not lose it).
    let mut forced: Option<Boundary> = None;
    // Upstream URIs of the most recently ingested segments, for ONE job: a renewed session re-offers the
    // same live window it already gave us (pluto ends its playlist after every ~5-segment window, so ~4 of
    // those 5 are content we hold). Within a session `next_upstream_seq` dedupes; across one it is
    // meaningless, because the new session renumbers. Consulted ONLY on the first poll after a renewal —
    // a source that RECYCLES segment names would otherwise have real content skipped — and bounded to about
    // one window's worth so a recycling source would have to wrap inside 64 segments to collide.
    let mut recent_uris: VecDeque<String> = VecDeque::new();
    let mut dedupe_by_uri = false;
    // S3/CUE Phase 2. LATCHED once rather than re-read per poll: `SourcePolicy` is shared and an unrelated
    // playlist's resolve can mutate it, and flipping mid-break would either strand a rebased timeline or
    // splice filler into a stream that never asked for it.
    //
    // Latched on FIRST USE, not here. The ingest task is spawned by `subscribe()` and does its own resolve
    // inside the loop below, so at this point no grant has landed and the policy is still at its shipped
    // defaults — reading it here pins every channel to `passthrough` no matter what the operator set.
    let mut replace_ads: Option<bool> = None;
    let mut splicer = crate::tsnorm::Splicer::new();
    let mut warned_splice = false;
    // Program captured at the OPENING edge of the current break, looped for its duration.
    let mut filler: Vec<Arc<Segment>> = Vec::new();
    let mut filler_idx: usize = 0;
    // One decline message per break, re-armed on each opening edge — the reason is a property of the stream,
    // so repeating it every 5 s would bury the rest of the ingest log (the `warned_floor` posture).
    let mut warned_filler = false;
    // Consecutive failures to produce a playable window from the pinned candidate — drives MEDIA_FAIL_ESCALATE.
    let mut media_failures: u32 = 0;
    let mut last_idle_check = Instant::now();

    loop {
        if ctx.origin.stopping.load(Ordering::Relaxed) {
            break;
        }
        // Idle shutdown: no subscribers for IDLE_GRACE. Checked on a tick rather than every poll so a channel
        // with a long target duration still releases promptly.
        if last_idle_check.elapsed() >= IDLE_TICK {
            last_idle_check = Instant::now();
            if ctx.origin.subscribers.load(Ordering::Relaxed) == 0
                && ctx.origin.last_access.lock_ok().elapsed() >= IDLE_GRACE
            {
                log::info("iop", &rid, || {
                    format!("ingest idle {}/{} — stopping", ctx.source, crate::proxy::host_of(&ctx.entry))
                });
                break;
            }
        }

        // (Re)resolve whenever we have no media playlist to follow — first pass, or after a persistent failure.
        let (media_url, media_body) = match media.take() {
            Some(m) => m,
            None => {
                // Escalate once the pinned candidate has failed to produce a playable window MEDIA_FAIL_ESCALATE
                // times running (~a few seconds at the 2 s retry cadence). Below that we re-resolve the same
                // candidate, which is what recovers an expired token or a rotated dlhd mirror.
                let escalate = media_failures >= MEDIA_FAIL_ESCALATE;
                if escalate {
                    log::warn("iop", &rid, || {
                        format!("{media_failures} consecutive resolve/ingest failures — advancing to the next candidate")
                    });
                    // The counter means "failures since the LAST escalation", not "failures ever": without
                    // this reset a channel that is dead everywhere would advance on every single pass,
                    // turning the 2 s retry loop into a hot walk over every candidate (and, for dlhd, a full
                    // provider re-walk per step). Each candidate now gets its own MEDIA_FAIL_ESCALATE tries.
                    media_failures = 0;
                }
                // A renewal that had to ESCALATE is no longer a renewal: the failover walk may hand back a
                // different provider, or a different channel, so the ring must not survive it.
                if escalate {
                    renewing_session = false;
                }
                let resolved = resolve_media(&ctx, &rid, escalate).await;
                // A fresh resolve may point at a different upstream, so the previous window's bytes cannot be
                // ASSUMED contiguous with the next ones. There are two honest ways to say that, and which one
                // is right depends on why we re-resolved:
                //
                //  · A SESSION RENEWAL — the provider ended our playlist but the channel is still live —
                //    KEEPS the ring. Dropping it would blank the published window (and bump `generation`,
                //    invalidating every segment URL the client already holds) on every renewal, and pluto
                //    renews every ~25 s: the cure would be worse than the disease. The join is marked as a
                //    splice instead, which is exactly what `#EXT-X-DISCONTINUITY` exists to say.
                //  · Anything ELSE (a stalled candidate, a failover) still DROPS the window. That resolve may
                //    land on a different provider or a different channel entirely, and a discontinuity tag
                //    would not make serving the old bytes honest.
                if resolved.is_some() {
                    if ctx.origin.ring_depth() > 0 {
                        if renewing_session {
                            forced = Some(Boundary::SessionRenewal);
                            dedupe_by_uri = true;
                            log::info("iop", &rid, || {
                                format!(
                                    "session renewed — ring kept ({} seg), join marked as a splice",
                                    ctx.origin.ring_depth()
                                )
                            });
                        } else {
                            ctx.origin.reset_ring();
                            log::info("iop", &rid, || {
                                format!("ring reset on re-resolve (generation={})", ctx.origin.generation())
                            });
                            // ONLY on a real reset. A renewal is the same channel continuing, so an ad pod
                            // spans it: clearing here fragmented one 2-minute break into a fresh break per
                            // renewal (a new id every ~2.5 s), which reset the filler pool each time and left
                            // "no program held to loop" as the visible symptom. A reset is different — that
                            // upstream may be another channel entirely, so its break, its rebased timeline
                            // and the program captured from its ring are all meaningless now.
                            ad_break = None;
                            splicer.reset();
                            filler.clear();
                        }
                        // The new session renumbers regardless, so sequence-gap detection must re-anchor.
                        prev = PrevSeg::default();
                        next_upstream_seq = -1;
                    }
                    // Consumed only on a SUCCESSFUL resolve. A transient resolve failure mid-renewal keeps
                    // the flag armed, so the retry that succeeds still keeps the ring instead of paying for
                    // a blip with a rebuffer.
                    renewing_session = false;
                }
                match resolved {
                    Some(MediaSource::Hls(u, b)) => (u, b),
                    // A bare TS socket has nothing to poll: hand off to the local segmenter for the whole
                    // session, then fall back into this loop (which re-checks stop/idle and re-resolves).
                    Some(MediaSource::RawTs(stream, first)) => {
                        ingest_raw_ts(&ctx, &rid, stream, first).await;
                        next_upstream_seq = -1;
                        continue;
                    }
                    None => {
                        media_failures = media_failures.saturating_add(1);
                        report_iop(&ctx, "resolve_failed");
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        continue;
                    }
                }
            }
        };

        let mp = parse_media_playlist(&media_body);
        if mp.target_duration > 0.0 {
            let ms = (mp.target_duration * 1000.0) as u64;
            ctx.origin.target_duration_ms.fetch_max(ms, Ordering::Relaxed);
        }
        if next_upstream_seq < 0 {
            next_upstream_seq = mp.media_sequence; // first poll: start at the head of the live window
        }

        let policy = match ctx.state.get(&ctx.source) {
            Some(p) => p,
            None => {
                log::warn("iop", &rid, || "policy evicted mid-ingest — re-resolving".to_string());
                media = None;
                continue;
            }
        };
        let client = ctx.state.client_for(
            policy.connect_timeout_ms.load(Ordering::Relaxed),
            policy.max_redirects.load(Ordering::Relaxed),
        );
        let read_timeout_ms = policy.read_timeout_ms.load(Ordering::Relaxed);

        // First poll after a grant has landed: latch the ad policy and say so once, so an operator who turned
        // replacement on can confirm the data plane actually received it.
        let replace_ads = *replace_ads.get_or_insert_with(|| {
            let on = policy.ad_policy.read_ok().as_str() == "replace";
            log::info("iop:cue", &rid, || {
                format!("ad policy: {}", if on { "replace breaks with looped program" } else { "passthrough" })
            });
            on
        });

        let mut ingested_this_poll = 0u32;
        // Segments the renewal check recognised as already-held. Tracked separately from `ingested_this_poll`
        // because a poll that ingests nothing NEW but recognised a whole window is healthy, not stalled —
        // counting it as an empty poll would walk the failover cursor off a perfectly good channel.
        let mut duplicates_this_poll = 0u32;
        for (i, seg) in mp.segments.iter().enumerate() {
            if ctx.origin.stopping.load(Ordering::Relaxed) {
                break;
            }
            let upstream_seq = mp.media_sequence + i as i64;
            if upstream_seq < next_upstream_seq {
                continue; // already ingested
            }
            next_upstream_seq = upstream_seq + 1;

            // The renewed session re-offers the window we were already holding. Skipping by URI keeps the
            // ring's timeline moving forward instead of replaying ~4 of every 5 segments to the viewer.
            if dedupe_by_uri && recent_uris.iter().any(|u| u == &seg.uri) {
                duplicates_this_poll += 1;
                continue;
            }

            let seg_url = match media_url.join(&seg.uri) {
                Ok(u) => u,
                Err(_) => continue,
            };
            if let Some(h) = seg_url.host_str() {
                if !policy.allow_private.load(Ordering::Relaxed) && is_private_host(h) {
                    log::warn("iop", &rid, || format!("segment host {h} private/blocked — skipping"));
                    continue;
                }
                policy.hosts.write_ok().insert(h.to_lowercase());
            }

            // S3/CUE: classify BEFORE the fetch. Phase 1 only needed this before the PUSH, but a replaced ad
            // must never be pulled from upstream at all — not fetching it is most of the point.
            let signal = ad_signal(seg, &seg_url, &policy.ad_uri_contains.read_ok());

            // THIS segment is the first program after a break we filled, so the return seam belongs to it,
            // not to the next one. Knowable before the fetch: it depends only on the signal and the open
            // break, never on the bytes. A break we merely passed through needs nothing here — the upstream's
            // own `#EXT-X-DISCONTINUITY` already landed on this segment.
            let ad_return = (signal.is_none() && ad_break.as_ref().is_some_and(|b| b.replaced > 0))
                .then_some(Boundary::AdReturn);

            // An upstream signal wins the naming when several apply — it says something more specific than
            // "we reconnected" or "we substituted". `forced` survives a failed fetch (it is cleared only
            // after a push) so a join whose first segment 404s still splices the one that does land.
            //
            // The SessionRenewal arm has an extra out. Recognising part of the new session's window as
            // content we already hold PROVES the two are contiguous — the overlap IS the join — so the
            // segment after it continues the timeline and needs no splice. Overlapping segments sort first,
            // so by the time the first genuinely new one is reached the count already says which case this
            // is. Only a renewal that landed on a DISJOINT window is a real jump.
            let pending = match forced {
                Some(Boundary::SessionRenewal) if duplicates_this_poll > 0 => None,
                other => other,
            };
            let upstream_boundary = boundary_before(&prev, seg, upstream_seq);
            let candidate = upstream_boundary.or(ad_return).or(pending);

            // On the OPENING edge of a break, capture replacement material while the ring tail is still
            // program, and tell the normalizer where that program's clock ends so the first filler lands
            // after it rather than on top of it.
            if replace_ads && signal.is_some() && ad_break.is_none() {
                filler = ctx.origin.program_tail(FILLER_SEGMENTS);
                // Only when normalisation is OFF. With it ON the splicer's clock already tracks every segment
                // it published, so there is nothing left to adopt.
                if !policy.splice_normalize.load(Ordering::Relaxed) {
                    if let Some(last) = filler.last() {
                        splicer.observe(&last.bytes);
                    }
                }
                filler_idx = 0;
                warned_filler = false;
            }

            // Substitute, or fetch. Substitution declines rather than guesses: with no filler held, or a
            // segment the rewriter will not touch, the ad is served as before — a visible ad beats a
            // corrupted stream.
            let mut substituted: Option<f64> = None; // Some(the filler's own duration) once one is built
            let mut replacement: Option<Bytes> = None;
            if replace_ads && signal.is_some() {
                match filler.get(filler_idx % filler.len().max(1)) {
                    // REPEAT contract either way: these bytes are already in the ring, so the copy has to
                    // clear the original's presentation rather than merely its decode end. Which REWRITE
                    // applies depends on the switch — clock-only when the ring around it is un-normalised,
                    // or the filler would be the one segment on canonical pids.
                    Some(src) => match if policy.splice_normalize.load(Ordering::Relaxed) {
                        splicer.normalize_repeat(&src.bytes)
                    } else {
                        splicer.rebase_only(&src.bytes)
                    } {
                        Some(bytes) => {
                            substituted = Some(src.duration);
                            filler_idx += 1;
                            replacement = Some(Bytes::from(bytes));
                        }
                        // Declining is a designed outcome, not a failure — but a silent one would look
                        // identical to "the operator never turned it on", so say it once per break.
                        None => {
                            if !warned_filler {
                                warned_filler = true;
                                log::warn("iop:cue", &rid, || {
                                    "ad replacement declined: the rewriter would not touch this stream (no PSI, \
                                     no video timestamps, or an encoding it cannot safely rebase) — serving the \
                                     break as-is"
                                        .to_string()
                                });
                            }
                        }
                    },
                    None => {
                        if !warned_filler {
                            warned_filler = true;
                            log::warn("iop:cue", &rid, || {
                                "ad replacement declined: no program held to loop (the break began before the \
                                 ring had any) — serving the break as-is"
                                    .to_string()
                            });
                        }
                    }
                }
            }
            let plain = match replacement {
                Some(b) => b,
                None => match fetch_segment(&ctx, &rid, &client, &policy, &media_url, seg, &seg_url, upstream_seq, read_timeout_ms, &mut key_cache).await {
                    Some(b) => b,
                    None => continue, // a gap: the NEXT ingested segment will see the sequence jump and splice
                },
            };

            // A SUBSTITUTED segment is contiguous with the program before it BY CONSTRUCTION — the rewriter
            // placed it there. Any upstream splice that fired here describes the AD we did not serve (pluto
            // tags every pod edge), so propagating it would announce a break in a timeline that does not have
            // one, and would undo most of what replacement buys. A pending splice is NOT consumed here: it
            // still belongs on the next piece of real media.
            let boundary = if substituted.is_some() { None } else { candidate };

            // Snapshot what the boundary was decided AGAINST, before `prev` is overwritten — a splice log
            // naming only the trigger cannot distinguish real churn from a detector bug (that is how the two
            // removed URL heuristics were caught).
            let was = prev.clone();
            prev = PrevSeg { upstream_seq: Some(upstream_seq) };

            // A substituted segment publishes the FILLER's real length, not the ad's: the ring's timeline is
            // ours, so `#EXTINF` has to describe the bytes we actually serve.
            let duration = match substituted {
                Some(d) if d > 0.0 => d,
                _ if seg.duration > 0.0 => seg.duration,
                _ => mp.target_duration,
            };
            let our_seq = ctx.origin.next_seq.fetch_add(1, Ordering::Relaxed);

            // Fingerprint the stream at edges only. `profile_changed` is what says whether the splice is
            // load-bearing (the decoder MUST reconfigure) or merely cosmetic — the measurement that decides
            // whether filler could ever be codec-matched here. Unverifiable reads as CHANGED, never as a match.
            //
            // Note what it measures once `adPolicy=replace` is on: OUR OUTPUT, not the upstream. A substituted
            // segment is filler, so the comparison is program-vs-program and correctly reports no change —
            // the ad whose profile differed was never fetched, so nothing here can see it. Reading a source's
            // true break behaviour therefore means reading it in passthrough, which is why Phase 1 shipped
            // first and why this stays honest about what it is describing.
            let ad_edge = signal.is_some() != ad_break.is_some();
            let scan_now = boundary.is_some() || ad_edge || last_profile.is_none();
            let profile = if scan_now { crate::tsseg::scan_profile(&plain) } else { None };
            let profile_changed = match (&last_profile, &profile) {
                (None, _) => false, // seeding the first sample — nothing to compare against yet
                (Some(prev), Some(cur)) => !prev.compatible_with(cur),
                (Some(_), None) => scan_now, // we looked and could not verify ⇒ conservatively changed
            };
            if profile.is_some() {
                last_profile = profile;
            }

            match (signal, &mut ad_break) {
                (Some(sig), None) => {
                    next_break_id += 1;
                    let announced = seg.cue.map(|c| c.duration).unwrap_or(0.0);
                    let open = AdBreak {
                        id: next_break_id,
                        signal: sig,
                        segments: 1,
                        seconds: duration,
                        announced,
                        profile_changed,
                        replaced: u32::from(substituted.is_some()),
                    };
                    log::info("iop:cue", &rid, || {
                        let ann = if open.announced > 0.0 {
                            format!(", announced {:.0}s", open.announced)
                        } else {
                            String::new()
                        };
                        let prof = if profile_changed { "profile CHANGED" } else { "profile same" };
                        format!("ad break #{} OPEN via {:?} at seq {our_seq}{ann} — {prof}", open.id, open.signal)
                    });
                    report_cue(&ctx, "open", &open);
                    ad_break = Some(open);
                }
                (Some(_), Some(b)) => {
                    b.segments += 1;
                    b.seconds += duration;
                    b.replaced += u32::from(substituted.is_some());
                }
                (None, Some(b)) => {
                    // The RETURN to program is its own parameter change — report the one measured here, not
                    // the one measured when the break opened.
                    let done = AdBreak { profile_changed, ..b.clone() };
                    ad_break = None;
                    // The pool was captured for THIS break; the next one re-captures against whatever
                    // program is current then. (`ad_return` above already carried the resume seam.)
                    filler.clear();
                    log::info("iop:cue", &rid, || {
                        let prof = if profile_changed { "profile CHANGED" } else { "profile same" };
                        format!(
                            "ad break #{} CLOSE at seq {our_seq} after {} segments / {:.1}s (via {:?}) — {prof}, {} replaced",
                            done.id, done.segments, done.seconds, done.signal, done.replaced
                        )
                    });
                    report_cue(&ctx, "close", &done);
                }
                (None, None) => {}
            }

            // ── SPLICE ABSORPTION ────────────────────────────────────────────────────────────────────────
            // Republish onto ONE timeline with STABLE pids. Upstream moves the video pid between ads — pluto
            // ran 258 → 256 → 258 across a single pod — and a demuxer does not follow an elementary stream to
            // a new pid: it keeps rendering the one it latched and registers the new one as a stream nothing
            // is displaying. Measured against a real client, video froze exactly when the pid moved away and
            // came back exactly when it returned. `#EXT-X-DISCONTINUITY` cannot express that. The tag
            // describes a TIMELINE break; this is a stream-IDENTITY break, and the only fix is to stop the
            // identity from changing. (The same client handled every sps-only change on a stable pid
            // unaided, which is why this never re-encodes.)
            //
            // Runs at INGEST, once per segment, so one rewrite serves every viewer and both renderers — and
            // so `program_tail` hands the filler path material already on this timeline.
            //
            // A substituted segment came from that same filler path and is already normalised; re-running it
            // would space it against itself.
            // The kill switch. OFF republishes upstream bytes untouched — the pre-fix behaviour, pid churn and
            // all — so an operator can rule this pass in or out of a playback complaint without a redeploy.
            // Read per segment, not once per ingest, so a re-resolve flips it live like every other knob.
            let normalize = policy.splice_normalize.load(Ordering::Relaxed);
            if !normalize && splicer.has_timeline() {
                splicer.reset(); // switched off mid-stream: the timeline it was keeping no longer applies
            }
            let joined = normalize && splicer.has_timeline();
            let (plain, absorbed) = if substituted.is_some() {
                (plain, true)
            } else if !normalize {
                (plain, false)
            } else {
                match splicer.normalize(&plain) {
                    Some(b) => (Bytes::from(b), true),
                    None => {
                        // Declining is designed, not a failure: publish the bytes untouched and drop the
                        // timeline so the next segment re-anchors on its own clock rather than being spaced
                        // against one whose media nobody received. Upstream's splice is then signalled the
                        // old way — a visible decoder reset beats a stream we mis-rewrote.
                        if !warned_splice {
                            warned_splice = true;
                            log::warn("iop", &rid, || {
                                "splice normalisation declined (no PSI, or a program shape the published \
                                 layout cannot carry) — publishing verbatim and signalling the splice"
                                    .to_string()
                            });
                        }
                        splicer.reset();
                        (plain, false)
                    }
                }
            };
            // Drop the tag ONLY when the splice was genuinely absorbed — the segment was moved onto a clock
            // that already existed. A FRESH anchor leaves the timestamps exactly where upstream put them, so
            // upstream's own signal still governs and must still be published.
            let discontinuity = if absorbed && joined { false } else { boundary.is_some() };

            let evicted = ctx.origin.push(
                Segment {
                    seq: our_seq,
                    duration,
                    bytes: plain,
                    discontinuity,
                    pdt: SystemTime::now(),
                    ad: signal.is_some(),
                    break_id: ad_break.as_ref().map(|b| b.id).unwrap_or(0),
                },
                // Filler is built from the ring, so it cost no upstream traffic — counting it would
                // overstate "upstream pulled" by exactly the length of every ad break.
                substituted.is_none(),
            );
            ingested_this_poll += 1;
            if pending.is_some() {
                forced = None; // consumed — the splice is now recorded on a segment in the ring
            }
            recent_uris.push_back(seg.uri.clone());
            if recent_uris.len() > RECENT_URI_MEMORY {
                recent_uris.pop_front();
            }
            if let Some(b) = boundary {
                log::info("iop", &rid, || {
                    let detail = match b {
                        Boundary::SequenceGap => format!(
                            "upstream seq {} → {upstream_seq}",
                            was.upstream_seq.map(|s| s.to_string()).unwrap_or_else(|| "-".into())
                        ),
                        Boundary::Tag => "upstream #EXT-X-DISCONTINUITY".to_string(),
                        Boundary::SessionRenewal => "first segment of a renewed provider session".to_string(),
                        Boundary::AdReturn => "program resumed after replaced ad break".to_string(),
                    };
                    // Say which of the two happened. An ABSORBED splice publishes no tag, so a log line that
                    // read the same either way would make the normaliser silently un-diagnosable — exactly
                    // the failure mode the `iop:cue` naming exists to prevent.
                    if discontinuity {
                        format!("discontinuity ({b:?}) at our seq={our_seq} — {detail}")
                    } else {
                        format!("splice ABSORBED ({b:?}) at our seq={our_seq} — {detail}; rebased onto one timeline, no tag published")
                    }
                });
            }
            if evicted > 0 {
                log::trace("iop", &rid, || {
                    format!("evicted {evicted} segment(s) — ring {} seg / {} KiB", ctx.origin.ring_depth(), ctx.origin.ring_bytes.load(Ordering::Relaxed) / 1024)
                });
            }
            // The floor-beats-cap warn fires ONCE per transition, not per segment: it is an operator action
            // item ("raise originRingMb"), and repeating it every 5 s would bury the rest of the ingest log.
            let beat = ctx.origin.floor_beat_cap();
            if beat && !warned_floor {
                warned_floor = true;
                let cap_mb = ctx.origin.ring_cap_bytes.load(Ordering::Relaxed) / (1024 * 1024);
                let held = ctx.origin.ring_bytes.load(Ordering::Relaxed) / (1024 * 1024);
                log::warn("iop", &rid, || {
                    format!(
                        "{}/{}: ring cap {cap_mb} MiB is too small for this bitrate — holding {} segment(s) / {held} MiB to keep a playable window. Raise originRingMb.",
                        ctx.source,
                        crate::proxy::host_of(&ctx.entry),
                        ctx.origin.ring_depth()
                    )
                });
            } else if !beat {
                warned_floor = false;
            }
        }

        // The URI memory is a RENEWAL tool only — leaving it armed would let it skip real content on a
        // source that recycles segment names.
        if dedupe_by_uri {
            log::trace("iop", &rid, || {
                format!("renewal poll: {ingested_this_poll} new, {duplicates_this_poll} already held")
            });
            dedupe_by_uri = false;
            // Overlap proved the join is contiguous, so retire the pending splice even if this poll had no
            // new segment to hang it on — otherwise it would fire spuriously on a LATER poll, once
            // `duplicates_this_poll` has been reset and can no longer vouch for the join.
            if duplicates_this_poll > 0 && forced == Some(Boundary::SessionRenewal) {
                forced = None;
            }
        }

        if ingested_this_poll > 0 || duplicates_this_poll > 0 {
            empty_polls = 0;
            media_failures = 0; // this candidate is producing media — it has earned the cursor back
            report_iop(&ctx, "ok");
        } else {
            empty_polls += 1;
            if empty_polls >= MAX_EMPTY_POLLS {
                log::warn("iop", &rid, || {
                    format!("{MAX_EMPTY_POLLS} empty polls — re-resolving {}/{}", ctx.source, crate::proxy::host_of(&ctx.entry))
                });
                report_iop(&ctx, "stalled");
                empty_polls = 0;
                media_failures = media_failures.saturating_add(1);
                media = None;
                continue;
            }
        }

        if mp.endlist {
            let uris: Vec<String> = mp.segments.iter().map(|s| s.uri.clone()).collect();
            if endlist_is_terminal(last_endlist.as_ref(), &uris) {
                log::info("iop", &rid, || {
                    "upstream #EXT-X-ENDLIST unchanged across a re-resolve — ingest complete".to_string()
                });
                break;
            }
            log::info("iop", &rid, || {
                format!(
                    "upstream #EXT-X-ENDLIST after {} segment(s) — re-resolving (provider ended the session, not the channel)",
                    uris.len()
                )
            });
            last_endlist = Some(uris);
            // Sleep on the normal cadence FIRST: a source that ends every playlist immediately must not turn
            // this into a hot resolve loop. The ring keeps serving from what it holds meanwhile.
            tokio::time::sleep(poll_interval(mp.target_duration)).await;
            renewing_session = true;
            media = None; // re-resolve at the SAME candidate — this is not a failure, so no cursor escalation
            continue;
        }
        // A poll that did NOT end the playlist clears the comparison baseline: the next ENDLIST starts a
        // fresh "is it really over?" question rather than being judged against an older session.
        last_endlist = None;

        tokio::time::sleep(poll_interval(mp.target_duration)).await;

        // Refresh the playlist for the next pass. A failed refresh clears `media` so the loop head re-resolves.
        match fetch_with_retry(&client, media_url.as_str(), &build_headers(&policy), read_timeout_ms, &rid, "iop-playlist", MAX_UPSTREAM_RETRIES).await {
            Ok(resp) if resp.status().is_success() => {
                let url = resp.url().clone();
                match resp.text().await {
                    Ok(body) => media = Some((url, body)),
                    Err(_) => media = None,
                }
            }
            _ => {
                log::warn("iop", &rid, || "media playlist refresh failed — re-resolving".to_string());
                media_failures = media_failures.saturating_add(1);
                media = None;
            }
        }
    }

    // Mark the ingest dead BEFORE dropping the registry entry, and wake every reader. Without this a raw-TS
    // producer parked on `wait_for_segment` would keep re-waiting forever against a ring nothing refills.
    ctx.origin.stopping.store(true, Ordering::Relaxed);
    ctx.origin.notify.notify_waiters();
    ctx.state.origins().lock_ok().remove(&ctx.key);
    report_iop(&ctx, "closed");
    log::info("iop", &rid, || {
        format!(
            "ingest stop {}/{} — {} segment(s), {} MiB ingested",
            ctx.source,
            crate::proxy::host_of(&ctx.entry),
            ctx.origin.ingested_segments.load(Ordering::Relaxed),
            ctx.origin.ingested_bytes.load(Ordering::Relaxed) / (1024 * 1024)
        )
    });
}

/// Resolve the entry and walk to the MEDIA playlist to follow (peeking the top variant when the entry is a
/// master). `None` when nothing usable is reachable — the caller backs off and retries.
async fn resolve_media(ctx: &IngestCtx, rid: &str, escalate: bool) -> Option<MediaSource> {
    // `escalate` = the pinned candidate has failed us repeatedly, so advance the failover cursor instead of
    // re-resolving the same one. The ingest loop drives its own retries and never enters the handler's
    // failover_walk, so this is the ONLY way an origin-mode stream reaches the source's alternate upstreams
    // (dlhd's other player providers) or the channel's configured backups.
    let resolved = if escalate {
        ctx.state.resolve_advance(&ctx.source, &ctx.entry, ctx.pl.as_deref()).await
    } else {
        ctx.state.resolve_fresh(&ctx.source, &ctx.entry, ctx.pl.as_deref()).await
    };
    let (policy, target) = resolved
        .map_err(|e| {
            log::warn("iop", rid, || format!("resolve failed: {e}"));
        })
        .ok()?;
    let client = ctx.state.client_for(
        policy.connect_timeout_ms.load(Ordering::Relaxed),
        policy.max_redirects.load(Ordering::Relaxed),
    );
    let read_timeout_ms = policy.read_timeout_ms.load(Ordering::Relaxed);
    let resp = fetch_with_retry(&client, &target, &build_headers(&policy), read_timeout_ms, rid, "iop-entry", MAX_UPSTREAM_RETRIES)
        .await
        .ok()?;
    if !resp.status().is_success() {
        log::warn("iop", rid, || format!("entry fetch {} — not usable", resp.status().as_u16()));
        return None;
    }
    let url = resp.url().clone();

    // PEEK before buffering. `resp.text()` would read to EOF, which is fine for a manifest and fatal for a
    // bare TS socket — that never ends. So take the first chunk and decide from it: a playlist starts with
    // `#EXTM3U`, a transport stream with the 0x47 sync byte.
    let mut stream = resp.bytes_stream();
    let first = match stream.next().await {
        Some(Ok(b)) => b,
        _ => {
            log::warn("iop", rid, || "entry produced no bytes".to_string());
            return None;
        }
    };
    if !looks_like_manifest(&first) {
        log::info("iop", rid, || {
            format!("{}: upstream is a bare TS socket — segmenting locally", ctx.source)
        });
        return Some(MediaSource::RawTs(Box::pin(stream), first));
    }
    // A manifest: drain the (small) remainder into text.
    let mut body = String::from_utf8_lossy(&first).into_owned();
    while let Some(Ok(b)) = stream.next().await {
        body.push_str(&String::from_utf8_lossy(&b));
    }

    let (media_url, media_body) = if is_master(&body) {
        let vurl = pick_variant(&body, &url)?;
        let vresp = fetch_with_retry(&client, vurl.as_str(), &build_headers(&policy), read_timeout_ms, rid, "iop-variant", MAX_UPSTREAM_RETRIES)
            .await
            .ok()?;
        if !vresp.status().is_success() {
            return None;
        }
        (vresp.url().clone(), vresp.text().await.ok()?)
    } else {
        (url, body)
    };

    // The same eligibility guards the raw-TS producer applies. fMP4 is not concatenable and SAMPLE-AES is not
    // decryptable, so an origin over either would publish bytes no renderer can honestly serve.
    if has_map(&media_body) {
        log::warn("iop", rid, || format!("{}: fMP4 (#EXT-X-MAP) — origin ingest not eligible", ctx.source));
        return None;
    }
    if let Some(method) = unsupported_encryption(&media_body) {
        log::warn("iop", rid, || format!("{}: unsupported encryption METHOD={method} — origin ingest not eligible", ctx.source));
        return None;
    }
    Some(MediaSource::Hls(media_url, media_body))
}

/// What an upstream turned out to BE. Both shapes feed the same ring; only the way boundaries are discovered
/// differs — an HLS playlist states them, a bare socket has to be segmented locally (tsseg.rs).
enum MediaSource {
    Hls(Url, String),
    /// The live byte stream plus the chunk already consumed to identify it.
    RawTs(std::pin::Pin<Box<dyn tokio_stream::Stream<Item = reqwest::Result<Bytes>> + Send>>, Bytes),
}

/// A playlist starts `#EXTM3U`; anything else from these sources is transport-stream bytes.
fn looks_like_manifest(b: &[u8]) -> bool {
    let s = b.iter().take(16).copied().collect::<Vec<u8>>();
    let t = String::from_utf8_lossy(&s);
    t.trim_start_matches('\u{feff}').trim_start().starts_with("#EXTM3U")
}

/// Ingest a BARE TS socket: cut it into segments locally and push them into the same ring the HLS path fills.
///
/// Runs until the socket ends or the ingest is stopping — unlike the HLS path there is nothing to poll, so
/// this is one long read rather than a loop over playlist refreshes.
async fn ingest_raw_ts(
    ctx: &IngestCtx,
    rid: &str,
    mut stream: std::pin::Pin<Box<dyn tokio_stream::Stream<Item = reqwest::Result<Bytes>> + Send>>,
    first: Bytes,
) {
    // Segment length: reuse whatever target the channel already reported, else a 5 s default that matches
    // typical HLS practice. This also seeds the renderer's #EXT-X-TARGETDURATION.
    let target = {
        let t = ctx.origin.target_duration();
        if t > 0.0 { t } else { 5.0 }
    };
    ctx.origin.target_duration_ms.fetch_max((target * 1000.0) as u64, Ordering::Relaxed);
    let mut seg = crate::tsseg::TsSegmenter::new(target);
    let mut produced = 0u64;

    for cut in seg.push(&first) {
        push_cut(ctx, cut);
        produced += 1;
    }
    while let Some(item) = stream.next().await {
        if ctx.origin.stopping.load(Ordering::Relaxed) {
            break;
        }
        match item {
            Ok(b) => {
                for cut in seg.push(&b) {
                    push_cut(ctx, cut);
                    produced += 1;
                }
            }
            Err(e) => {
                log::warn("iop", rid, || format!("raw-TS read failed after {produced} segment(s): {e}"));
                break;
            }
        }
    }
    // Flush the tail so the last partial segment is not silently lost on a clean end.
    if let Some(tail) = seg.finish() {
        push_cut(ctx, tail);
        produced += 1;
    }
    log::info("iop", rid, || format!("raw-TS session ended — {produced} segment(s) cut"));
    report_iop(ctx, "closed");
}

/// Push a locally-cut segment into the ring. `discontinuity` is always false: a bare TS socket is one
/// continuous encode, and unlike HLS it carries no splice signal we could honestly propagate. `ad` is false
/// for the same reason — there is no manifest to carry a cue tag and no segment URI to match a signature
/// against, so a raw socket is program by construction, not by assumption.
fn push_cut(ctx: &IngestCtx, cut: crate::tsseg::CutSegment) {
    let our_seq = ctx.origin.next_seq.fetch_add(1, Ordering::Relaxed);
    ctx.origin.push(
        Segment {
            seq: our_seq,
            duration: cut.duration,
            bytes: Bytes::from(cut.bytes),
            discontinuity: false,
            pdt: SystemTime::now(),
            ad: false,
            break_id: 0,
        },
        true, // every byte of a cut segment came off the upstream socket
    );
}

/// Fetch ONE segment and return its plaintext bytes, decrypting AES-128 when keyed.
///
/// `None` drops just this segment (leaving a gap the next boundary check will splice) rather than failing the
/// whole ingest — one bad segment must not end a channel that is otherwise healthy.
#[allow(clippy::too_many_arguments)]
async fn fetch_segment(
    ctx: &IngestCtx,
    rid: &str,
    client: &reqwest::Client,
    policy: &Arc<SourcePolicy>,
    media_url: &Url,
    seg: &SegRef,
    seg_url: &Url,
    upstream_seq: i64,
    read_timeout_ms: u64,
    key_cache: &mut Option<(String, [u8; 16])>,
) -> Option<Bytes> {
    let resp = match fetch_with_retry(client, seg_url.as_str(), &build_headers(policy), read_timeout_ms, rid, "iop-segment", MAX_UPSTREAM_RETRIES).await {
        Ok(r) if r.status().is_success() => r,
        _ => {
            log::warn("iop", rid, || format!("segment fetch failed at upstream seq={upstream_seq} — gap"));
            ctx.state.report(serde_json::json!({
                "kind": "upstream", "ok": false, "status": 0, "source": ctx.source, "entryUrl": ctx.entry,
            }));
            return None;
        }
    };
    let body = resp.bytes().await.ok()?;

    let key = match seg.key.as_ref() {
        None => return Some(body), // cleartext
        Some(k) if k.method == "AES-128" => k,
        Some(k) => {
            log::warn("iop", rid, || format!("unsupported mid-stream METHOD={} — dropping seq={upstream_seq}", k.method));
            return None;
        }
    };

    let key_url = media_url.join(&key.uri).ok()?;
    if let Some(h) = key_url.host_str() {
        if !policy.allow_private.load(Ordering::Relaxed) && is_private_host(h) {
            log::warn("iop", rid, || format!("AES key host {h} private/blocked — dropping seq={upstream_seq}"));
            return None;
        }
        policy.hosts.write_ok().insert(h.to_lowercase());
    }
    // Keys are stable across a clip (pluto reuses one keyfile with a per-segment IV), so this is one fetch per
    // rotation rather than per segment.
    let key_bytes = match key_cache {
        Some((uri, k)) if uri == key_url.as_str() => *k,
        _ => {
            let kresp = fetch_with_retry(client, key_url.as_str(), &build_headers(policy), read_timeout_ms, rid, "iop-key", MAX_UPSTREAM_RETRIES)
                .await
                .ok()?;
            if !kresp.status().is_success() {
                log::warn("iop", rid, || format!("AES key fetch {} — dropping seq={upstream_seq}", kresp.status().as_u16()));
                return None;
            }
            let b = kresp.bytes().await.ok()?;
            if b.len() != 16 {
                log::warn("iop", rid, || format!("AES key wrong size {} (want 16) — dropping seq={upstream_seq}", b.len()));
                return None;
            }
            let mut kb = [0u8; 16];
            kb.copy_from_slice(&b);
            *key_cache = Some((key_url.as_str().to_string(), kb));
            kb
        }
    };
    // RFC 8216 §5.2: an absent IV means the segment's media sequence number, as a 128-bit big-endian value.
    let iv = key.iv.unwrap_or_else(|| {
        let mut iv = [0u8; 16];
        iv[8..].copy_from_slice(&(upstream_seq as u64).to_be_bytes());
        iv
    });
    match decrypt_aes128_cbc(&key_bytes, &iv, &body) {
        Some(p) => Some(Bytes::from(p)),
        None => {
            log::warn("iop", rid, || format!("AES-128 decrypt failed at seq={upstream_seq} ({} bytes) — gap", body.len()));
            None
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// SIDE-2 — the renderers. Everything below reads the ring and writes to a client; nothing here touches the
// upstream. Logged under `oop` so an egress problem is never confused with an ingest one.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/// How long an entry request waits for a cold ring to reach `MIN_SEGMENTS` before giving up.
/// ~3 target durations is the unavoidable cost of starting an HLS window from nothing; beyond this the
/// upstream is presumed unhealthy and the client gets an honest 503 rather than an unplayable manifest.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// Format a SystemTime as RFC3339 UTC (`2026-08-05T12:36:41.433Z`) for `#EXT-X-PROGRAM-DATE-TIME`.
///
/// Hand-rolled rather than pulling in a date crate for one call site: this is the only place the data plane
/// formats a timestamp. Uses Howard Hinnant's civil-from-days algorithm, which is exact for all proleptic
/// Gregorian dates and needs no tables.
fn fmt_rfc3339(t: SystemTime) -> String {
    let d = t.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let millis = d.subsec_millis();
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (h, mi, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    // civil_from_days: shift the epoch to 0000-03-01 so leap days land at the end of the era.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
}

/// Render the AUTHORED media playlist for a window — the whole point of S3.
///
/// Pure so the "clean" contract is testable without a network: the output must contain NO upstream host,
/// path, session id or query; NO `#EXT-X-KEY`; NO vendor tags; and NO `/h/` hop URIs. Only our own sequence,
/// our own segment paths, and the structural HLS tags that describe OUR timeline.
#[allow(clippy::too_many_arguments)]
fn render_media_playlist(
    window: &[Arc<Segment>],
    target_duration: f64,
    mount_path: &str,
    source: &str,
    entry: &str,
    generation: u64,
    token: Option<&str>,
    pl: Option<&str>,
    disc_seq: u64,
) -> String {
    // TARGETDURATION must be an integer >= the longest #EXTINF, or players reject the playlist.
    let longest = window.iter().fold(target_duration, |m, s| if s.duration > m { s.duration } else { m });
    let td = longest.ceil().max(1.0) as u64;
    let mut out = String::with_capacity(256 + window.len() * 160);
    out.push_str("#EXTM3U\n#EXT-X-VERSION:3\n");
    out.push_str(&format!("#EXT-X-TARGETDURATION:{td}\n"));
    // OUR sequence — the ring base. Never the upstream's.
    let base = window.first().map(|s| s.seq).unwrap_or(0);
    out.push_str(&format!("#EXT-X-MEDIA-SEQUENCE:{base}\n"));
    // RFC 8216 §6.2.2: a server that removes a segment preceded by #EXT-X-DISCONTINUITY from a sliding
    // window MUST increment this. Omitting the tag is not "0 by default" — it pins the value at 0 forever
    // while the true count climbs, so a client tracking which timeline it is on loses its reference every
    // time the window slides. `Origin` counts the tags that have LEFT the playlist; see `Origin::disc_seq`.
    out.push_str(&format!("#EXT-X-DISCONTINUITY-SEQUENCE:{disc_seq}\n"));
    let enc_entry = crate::manifest::enc(entry);
    for (i, seg) in window.iter().enumerate() {
        // A splice inside the window is signalled, not hidden — that is L1 by decision: "clean" means no
        // visible origin/encryption/hops, not a single unbroken timeline. Players handle this tag correctly.
        if seg.discontinuity {
            out.push_str("#EXT-X-DISCONTINUITY\n");
        }
        // RFC 8216 §6.2.1: apply a PROGRAM-DATE-TIME to the first segment after EVERY discontinuity, not
        // just to the head of the window. A date-time is only interpolatable along ONE continuous media
        // timeline, so with a single anchor a client has no valid mapping for any range past the first
        // splice — measured live at 5 discontinuities behind one anchor, with jumps up to 16 minutes.
        if i == 0 || seg.discontinuity {
            out.push_str(&format!("#EXT-X-PROGRAM-DATE-TIME:{}\n", fmt_rfc3339(seg.pdt)));
        }
        out.push_str(&format!("#EXTINF:{:.3},\n", seg.duration));
        out.push_str(&format!("{mount_path}/{source}/o/{enc_entry}/{generation}-{}.ts", seg.seq));
        // The token MUST ride on every segment URI: our paths are guessable by construction, so this is what
        // keeps per-account governance (streamGate) meaningful. `pl` rides along for config resolution.
        if let Some(t) = token {
            out.push_str(&format!("?token={t}"));
            if let Some(p) = pl {
                out.push_str(&format!("&pl={p}"));
            }
        } else if let Some(p) = pl {
            out.push_str(&format!("?pl={p}"));
        }
        out.push('\n');
    }
    out
}

/// Wait for a cold ring to become playable. Returns false on timeout.
async fn wait_ready(origin: &Arc<Origin>, rid: &str) -> bool {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if origin.ring_depth() >= MIN_SEGMENTS {
            return true;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            log::warn("oop", rid, || {
                format!("ring still short ({}/{MIN_SEGMENTS}) after {READY_TIMEOUT:?} — refusing to serve an unplayable window", origin.ring_depth())
            });
            return false;
        }
        // Woken by the ingest on every push; the timeout bounds a channel that never produces one.
        let _ = tokio::time::timeout(left.min(Duration::from_secs(1)), origin.wait_for_segment()).await;
    }
}

/// SIDE-2 ENTRY: subscribe, wait for a playable window, and serve OUR manifest.
///
/// The lease is dropped when this returns — a polling client renews it on every poll, and the ingest's idle
/// grace covers the gaps. That keeps lifetime management in one place (the grace window) rather than
/// splitting it between the request path and a teardown hook.
#[allow(clippy::too_many_arguments)]
pub async fn serve_entry(
    state: &AppState,
    policy: &Arc<SourcePolicy>,
    mount_path: &str,
    source: &str,
    entry: &str,
    token: Option<&str>,
    pl: Option<&str>,
    id: &crate::proxy::Identity,
    rid: &str,
) -> axum::response::Response {
    let lease = subscribe(state, source, entry, pl, policy);
    let origin = lease.origin().clone();
    if !wait_ready(&origin, rid).await {
        return crate::proxy::text(503, "stream warming up: no playable window yet");
    }
    // Read the counter BEFORE snapshotting the window. The two are separate atomics, so an eviction landing
    // between them leaves a one-poll skew either way — but this order makes it an UNDER-count, where the tag
    // is still in the window and the client counts it itself. The other order double-counts it. (Monotonicity
    // holds regardless: the counter only ever rises.)
    let disc_seq = origin.disc_seq();
    let window = origin.window();
    let body = render_media_playlist(
        &window,
        origin.target_duration(),
        mount_path,
        source,
        entry,
        origin.generation(),
        token,
        pl,
        disc_seq,
    );
    log::info("oop", rid, || {
        format!("origin manifest served ({} segment(s), {} bytes)", window.len(), body.len())
    });
    // A manifest poll is the viewer heartbeat, exactly as on the proxy path — the difference is that these
    // bytes came from RAM, so no upstream fetch was involved and none is reported.
    state.report(serde_json::json!({
        "kind": "viewer", "source": source, "entryUrl": entry,
        "ip": id.ip, "ua": id.ua, "username": id.username,
        "playerType": if mount_path == "/api/ext/v1" { "externalPlayer" } else { "appPlayer" },
        "bytes": body.len() as u64,
    }));
    crate::proxy::raw(200, "application/vnd.apple.mpegurl", body.into_bytes())
}

/// SIDE-2 SEGMENT: serve one ring segment from RAM.
///
/// `file` is `<generation>-<seq>.ts`. The generation guard is what makes a stale client URL fail cleanly
/// after a failover reset instead of being answered with a different timeline's bytes.
pub async fn serve_segment(
    state: &AppState,
    source: &str,
    entry: &str,
    file: &str,
    id: &crate::proxy::Identity,
    rid: &str,
) -> axum::response::Response {
    let stem = file.strip_suffix(".ts").unwrap_or(file);
    let (gen_s, seq_s) = match stem.split_once('-') {
        Some(p) => p,
        None => return crate::proxy::text(400, "bad request: malformed segment name"),
    };
    let (want_gen, want_seq) = match (gen_s.parse::<u64>(), seq_s.parse::<u64>()) {
        (Ok(g), Ok(s)) => (g, s),
        _ => return crate::proxy::text(400, "bad request: malformed segment name"),
    };
    let key = crate::state::target_key(source, entry);
    let origin = match state.origins().lock_ok().get(&key) {
        Some(o) => o.clone(),
        None => {
            log::warn("oop", rid, || format!("segment {file}: no live ingest for {source}"));
            return crate::proxy::text(404, "not found: no live ingest");
        }
    };
    if want_gen != origin.generation() {
        log::trace("oop", rid, || {
            format!("segment {file}: stale generation (now {}) — 404", origin.generation())
        });
        return crate::proxy::text(404, "not found: stale segment");
    }
    let seg = origin.window().into_iter().find(|s| s.seq == want_seq);
    let seg = match seg {
        Some(s) => s,
        None => {
            log::trace("oop", rid, || format!("segment {file}: evicted from the ring — 404"));
            return crate::proxy::text(404, "not found: segment evicted");
        }
    };
    let n = seg.bytes.len() as u64;
    log::trace("oop", rid, || format!("segment seq={want_seq} served from ring ({n} bytes)"));
    // Egress accounting. Ingest bytes are reported separately under kind:"iop" and must never be folded in
    // here — one upstream byte can serve N viewers, so conflating them would over-count by a factor of N.
    state.report(serde_json::json!({
        "kind": "bytes", "source": source, "entryUrl": entry,
        "ip": id.ip, "ua": id.ua, "username": id.username, "bytes": n,
    }));
    crate::proxy::raw(200, "video/mp2t", seg.bytes.to_vec())
}

/// SIDE-2 RAW TS: one continuous `video/mp2t` socket concatenated from the ring.
///
/// Same cache, second shape — this is what makes `outputFormat` a rendering choice rather than a second
/// pipeline. Where the passthrough concatenator (tsmux.rs) fetches upstream per viewer, this reads segments
/// N viewers already share, so a second viewer costs zero upstream bandwidth.
///
/// KEYFRAME ALIGNMENT comes free: every HLS segment begins at a random-access point, so starting on a segment
/// boundary IS starting on a keyframe. No TS parsing is needed to splice in.
#[allow(clippy::too_many_arguments)]
pub async fn serve_ts(
    state: &AppState,
    policy: &Arc<SourcePolicy>,
    source: &str,
    entry: &str,
    pl: Option<&str>,
    id: &crate::proxy::Identity,
    rid: &str,
) -> axum::response::Response {
    let lease = subscribe(state, source, entry, pl, policy);
    if !wait_ready(lease.origin(), rid).await {
        return crate::proxy::text(503, "stream warming up: no playable window yet");
    }
    let buffer_size_kb = policy.buffer_size_kb.load(Ordering::Relaxed);
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(crate::stream::channel_capacity(buffer_size_kb));
    let ctx = TsRingCtx {
        state: state.clone(),
        source: source.to_string(),
        entry: entry.to_string(),
        rid: rid.to_string(),
        ip: id.ip.clone(),
        ua: id.ua.clone(),
        username: id.username.clone(),
    };
    // The LEASE moves into the producer: a continuous stream has no polling to renew it, so the ingest must be
    // held open for the whole session and released exactly when the socket ends.
    tokio::spawn(ts_ring_producer(lease, ctx, tx));
    axum::response::Response::builder()
        .status(axum::http::StatusCode::OK)
        .header("content-type", "video/mp2t")
        .header("cache-control", "no-store")
        .body(axum::body::Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)))
        .unwrap()
}

struct TsRingCtx {
    state: AppState,
    source: String,
    entry: String,
    rid: String,
    ip: String,
    ua: String,
    username: Option<String>,
}

/// Follow the ring, writing each new segment into the client socket until it disconnects.
async fn ts_ring_producer(
    lease: OriginLease,
    ctx: TsRingCtx,
    tx: tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>,
) {
    let origin = lease.origin().clone();
    let stream_id = ctx.state.next_stream_id();
    log::info("oop", &ctx.rid, || format!("origin raw-TS session open ({stream_id})"));
    ctx.state.report(serde_json::json!({
        "kind": "open", "streamId": stream_id, "source": ctx.source, "entryUrl": ctx.entry,
        "ip": ctx.ip, "ua": ctx.ua, "username": ctx.username, "playerType": "externalPlayer",
    }));

    // Start at the OLDEST segment held: the ring doubles as the client's initial buffer, so a new viewer gets
    // the whole window up front rather than waiting on the live edge.
    let mut next_seq = origin.window().first().map(|s| s.seq).unwrap_or(0);
    let mut pending_bytes: u64 = 0;
    let mut last_flush = Instant::now();
    // A bare TS socket has no `#EXT-X-DISCONTINUITY` to splice with, so the splice is removed instead: every
    // segment is republished onto one published layout with one continuous clock. Per-SESSION, because each
    // viewer joins the ring at a different point and therefore sits on its own timeline.
    let mut splicer = crate::tsnorm::Splicer::new();
    let mut warned_splice = false;

    loop {
        let window = origin.window();
        // Fell off the back of the ring — the client reads slower than the ingest writes, or the ring is too
        // small for this bitrate. Skipping forward drops video, so say so plainly rather than silently gapping.
        if let Some(front) = window.first() {
            if next_seq < front.seq {
                log::warn("oop", &ctx.rid, || {
                    format!("client fell behind the ring (wanted seq={next_seq}, oldest held={}) — skipping ahead; raise originRingMb if this repeats", front.seq)
                });
                next_seq = front.seq;
                // The skipped media is gone; anchoring the next segment against the clock it would have ended
                // on would publish a gap. Re-anchor instead.
                splicer.reset();
            }
        }
        let mut sent_any = false;
        let from = next_seq; // snapshot: the filter closure borrows it, the body reassigns it
        for seg in window.iter().filter(|s| s.seq >= from) {
            next_seq = seg.seq + 1;
            // Declining is a designed outcome: a segment carrying no PSI, or a program shape the published
            // layout cannot express, is served verbatim. That reinstates the upstream splice for that one
            // segment — a visible glitch — which still beats emitting a stream we mis-rewrote.
            let body = match splicer.normalize(&seg.bytes) {
                Some(bytes) => Bytes::from(bytes),
                None => {
                    if !warned_splice {
                        warned_splice = true;
                        log::warn("oop", &ctx.rid, || {
                            "splice normalisation declined (no PSI, or a program shape the published layout \
                             cannot carry) — serving upstream timestamps as-is"
                                .to_string()
                        });
                    }
                    seg.bytes.clone()
                }
            };
            pending_bytes += body.len() as u64;
            sent_any = true;
            if tx.send(Ok(body)).await.is_err() {
                // Client disconnected — the receiver dropped. Close out and release the lease.
                log::info("oop", &ctx.rid, || format!("origin raw-TS client disconnected ({stream_id})"));
                if pending_bytes > 0 {
                    ctx.state.report(serde_json::json!({ "kind": "sbytes", "streamId": stream_id, "bytes": pending_bytes }));
                }
                ctx.state.report(serde_json::json!({ "kind": "close", "streamId": stream_id }));
                return;
            }
        }
        if pending_bytes > 0 && last_flush.elapsed() >= Duration::from_secs(1) {
            ctx.state.report(serde_json::json!({ "kind": "sbytes", "streamId": stream_id, "bytes": pending_bytes }));
            pending_bytes = 0;
            last_flush = Instant::now();
        }
        if !sent_any {
            // Nothing new yet — wait for the ingest to push rather than spinning on the ring.
            let _ = tokio::time::timeout(Duration::from_secs(30), origin.wait_for_segment()).await;
            // The ingest died (idle-stopped or the upstream ended) and drained: end the socket cleanly.
            if origin.stopping.load(Ordering::Relaxed) {
                break;
            }
        }
    }

    if pending_bytes > 0 {
        ctx.state.report(serde_json::json!({ "kind": "sbytes", "streamId": stream_id, "bytes": pending_bytes }));
    }
    ctx.state.report(serde_json::json!({ "kind": "close", "streamId": stream_id }));
    log::info("oop", &ctx.rid, || format!("origin raw-TS session close ({stream_id})"));
}

/// Emit the Side-1 telemetry event. Distinct `kind` from every egress event so Node can attribute ingest
/// health separately — ingest bytes must NEVER be folded into the egress byte counters, or one upstream byte
/// serving N viewers would be counted N+1 times.
fn report_iop(ctx: &IngestCtx, status: &str) {
    ctx.state.report(serde_json::json!({
        "kind": "iop",
        "source": ctx.source,
        "entryUrl": ctx.entry,
        "status": status,
        "subscribers": ctx.origin.subscribers.load(Ordering::Relaxed),
        "ringSegments": ctx.origin.ring_depth(),
        "ringBytes": ctx.origin.ring_bytes.load(Ordering::Relaxed),
        "headSeq": ctx.origin.next_seq.load(Ordering::Relaxed),
        "generation": ctx.origin.generation(),
        "ingestedSegments": ctx.origin.ingested_segments.load(Ordering::Relaxed),
        "ingestedBytes": ctx.origin.ingested_bytes.load(Ordering::Relaxed),
        "evictedSegments": ctx.origin.evicted_segments.load(Ordering::Relaxed),
        "targetDuration": ctx.origin.target_duration(),
    }));
}

/// S3/CUE: an ad-break edge, for the Active Streams row and the operator's break history.
///
/// Separate from `report_iop` (which is a periodic HEALTH frame) because this is an EVENT — it fires exactly
/// twice per break and must not be conflated with a poll tick. Carries no byte counts by construction: an
/// ingest-side event can never feed an egress sink (`noteBytes`), which is the whole point of the iop/oop
/// split.
fn report_cue(ctx: &IngestCtx, state: &str, b: &AdBreak) {
    ctx.state.report(serde_json::json!({
        "kind": "cue",
        "source": ctx.source,
        "entryUrl": ctx.entry,
        "state": state,
        "breakId": b.id,
        "signal": format!("{:?}", b.signal),
        "segments": b.segments,
        // Observed on close; on open this is just the first segment, which is the honest number to show while
        // a break is still running.
        "durationSec": b.seconds,
        "announcedSec": b.announced,
        "profileChanged": b.profile_changed,
        "replaced": b.replaced,
    }));
}

/// A process-wide view of what every live ring is holding.
///
/// `originRingMb` bounds ONE channel; nothing bounds the box (the postponed `LRU` item). `report_iop` above
/// carries a single channel and only while that channel polls, so neither it nor the active-stream list can
/// answer "how much RAM is the ring costing us" — an origin inside its `IDLE_GRACE` window still holds its
/// bytes with no viewer to hang them off. This is that answer, and it is the measured number the later `LRU`
/// budget should be sized against rather than guessed at.
pub(crate) struct RingFootprint {
    pub origins: usize,
    /// Origins with at least one viewer; the remainder are in their idle grace, still costing RAM.
    pub subscribed: usize,
    pub bytes: u64,
    /// Σ of those origins' per-channel caps — headroom before eviction, NOT a global ceiling.
    pub cap_bytes: u64,
}

/// Sum the registry. Reads ONLY atomics and never touches `Origin.ring`: staying off that `RwLock` means this
/// introduces no lock-order pairing with the registry `Mutex` to reason about. Adding segment depth later
/// would mean cloning the `Arc`s out and DROPPING the registry guard before any `ring.read_ok()`.
pub(crate) fn ring_footprint(origins: &Mutex<HashMap<String, Arc<Origin>>>) -> RingFootprint {
    let map = origins.lock_ok();
    let mut f = RingFootprint { origins: map.len(), subscribed: 0, bytes: 0, cap_bytes: 0 };
    for o in map.values() {
        if o.subscribers.load(Ordering::Relaxed) > 0 {
            f.subscribed += 1;
        }
        f.bytes = f.bytes.saturating_add(o.ring_bytes.load(Ordering::Relaxed));
        f.cap_bytes = f.cap_bytes.saturating_add(o.ring_cap_bytes.load(Ordering::Relaxed));
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tsmux::SegKey;

    fn seg(n: usize, bytes: usize) -> Segment {
        Segment {
            seq: n as u64,
            duration: 5.0,
            bytes: Bytes::from(vec![0x47u8; bytes]),
            discontinuity: false,
            pdt: SystemTime::UNIX_EPOCH,
            ad: false,
            break_id: 0,
        }
    }

    fn segref(uri: &str, key: Option<&str>, disc: bool) -> SegRef {
        SegRef {
            uri: uri.to_string(),
            key: key.map(|u| SegKey {
                method: "AES-128".to_string(),
                uri: u.to_string(),
                iv: None,
            }),
            duration: 5.0,
            discontinuity: disc,
            cue: None,
        }
    }

    #[test]
    fn ring_evicts_oldest_to_stay_under_the_byte_cap() {
        let o = Origin::new(1000); // 1000-byte cap
        for i in 0..10 {
            o.push(seg(i, 200), true);
        }
        let ring = o.ring.read_ok();
        assert!(o.ring_bytes.load(Ordering::Relaxed) <= 1000, "ring must respect the cap");
        assert_eq!(ring.len(), 5, "1000/200 = 5 segments fit");
        // Oldest evicted first — the window is the TAIL of what was ingested.
        assert_eq!(ring.front().unwrap().seq, 5);
        assert_eq!(ring.back().unwrap().seq, 9);
    }

    #[test]
    fn min_segments_floor_beats_the_byte_cap() {
        // Each segment alone blows the cap — without the floor the ring would hold 1 and be unplayable.
        let o = Origin::new(100);
        for i in 0..6 {
            o.push(seg(i, 10_000), true);
        }
        assert_eq!(o.ring_depth(), MIN_SEGMENTS, "floor holds a playable window");
        assert!(o.floor_beat_cap(), "and reports that the cap could not be honored");
        assert!(o.ring_bytes.load(Ordering::Relaxed) > 100);
    }

    #[test]
    fn cap_is_honored_when_bitrate_fits_so_no_floor_warning() {
        let o = Origin::new(10_000);
        for i in 0..20 {
            o.push(seg(i, 500), true);
        }
        assert!(o.ring_depth() > MIN_SEGMENTS);
        assert!(!o.floor_beat_cap(), "a fitting bitrate must not warn");
    }

    #[test]
    fn ring_footprint_sums_the_registry_and_counts_only_subscribed_origins() {
        let watched = Arc::new(Origin::new(10_000));
        let idle = Arc::new(Origin::new(4_000));
        for i in 0..3 {
            watched.push(seg(i, 500), true); // 1500 bytes, under its cap
            idle.push(seg(i, 200), true); // 600 bytes, under its cap
        }
        watched.subscribers.store(2, Ordering::Relaxed);
        // `idle` keeps zero subscribers: it is inside its IDLE_GRACE window, still holding RAM. Counting it in
        // `bytes` but not in `subscribed` is the whole point — a footprint that only saw watched channels
        // would under-report exactly when a burst of just-closed channels is what filled memory.
        let map: HashMap<String, Arc<Origin>> =
            [("a".to_string(), watched), ("b".to_string(), idle)].into_iter().collect();
        let f = ring_footprint(&Mutex::new(map));

        assert_eq!(f.origins, 2);
        assert_eq!(f.subscribed, 1, "the idle origin still costs RAM but has no viewer");
        assert_eq!(f.bytes, 2_100, "1500 + 600 — every ring, watched or not");
        assert_eq!(f.cap_bytes, 14_000, "Σ per-channel caps: headroom, not a global ceiling");
    }

    #[test]
    fn ring_footprint_of_an_empty_registry_is_all_zero() {
        // The reporter's trailing frame after the last ingest closes: zeros, not a stale carry-over.
        let f = ring_footprint(&Mutex::new(HashMap::new()));
        assert_eq!((f.origins, f.subscribed, f.bytes, f.cap_bytes), (0, 0, 0, 0));
    }

    #[test]
    fn our_sequence_is_monotonic_across_a_ring_reset() {
        let o = Origin::new(10_000);
        for i in 0..4 {
            let s = o.next_seq.fetch_add(1, Ordering::Relaxed);
            o.push(seg(s as usize, 100), true);
            assert_eq!(s, i);
        }
        let gen_before = o.generation();
        o.reset_ring();
        assert_eq!(o.generation(), gen_before + 1, "generation bumps so stale URLs 404");
        assert_eq!(o.ring_depth(), 0);
        assert_eq!(o.ring_bytes.load(Ordering::Relaxed), 0);
        // The client's timeline must NOT rewind — a player seeing MEDIA-SEQUENCE go backwards stalls.
        let after = o.next_seq.fetch_add(1, Ordering::Relaxed);
        assert_eq!(after, 4, "sequence continues across the reset");
    }

    #[test]
    fn boundary_detects_explicit_tag() {
        let prev = PrevSeg { upstream_seq: Some(9) };
        assert_eq!(boundary_before(&prev, &segref("s10.ts", None, true), 10), Some(Boundary::Tag));
    }

    #[test]
    fn boundary_detects_sequence_gap() {
        let prev = PrevSeg { upstream_seq: Some(9) };
        // 9 → 12 means we never ingested 10 and 11, so the bytes are not contiguous.
        assert_eq!(
            boundary_before(&prev, &segref("s12.ts", None, false), 12),
            Some(Boundary::SequenceGap)
        );
    }

    /// REGRESSION 1 (observed live 2026-08-05): pluto rotates the AES keyfile periodically WITHIN one clip
    /// (`…keyfile_5` → `_6` → `_7`, directory unchanged). That is a re-key of a continuous encode, not a
    /// splice — treating it as one emitted ~2.5× too many `#EXT-X-DISCONTINUITY` tags.
    #[test]
    fn key_rotation_within_a_clip_is_not_a_boundary() {
        let prev = PrevSeg { upstream_seq: Some(1) };
        assert_eq!(
            boundary_before(
                &prev,
                &segref("seg2.ts", Some("https://siloh/24776-596347/hls_2400_keyfile_6.key"), false),
                2
            ),
            None,
            "a re-key inside one clip must not splice the timeline"
        );
    }

    /// REGRESSION 2 (observed live 2026-08-05): some CDN paths carry a PER-SEGMENT opaque token, so the
    /// segment "directory" changes on every single segment mid-clip. A URL-shape heuristic fires on all of
    /// them; the upstream tag does not. This is why boundary detection no longer looks at the URL at all.
    #[test]
    fn per_segment_tokenized_paths_are_not_boundaries() {
        let prev = PrevSeg { upstream_seq: Some(2) };
        // Real path shape from the ingest log: /v1/<base64-ish token>/seg.ts, a new token each segment.
        assert_eq!(
            boundary_before(&prev, &segref("/v1/dVTv3Ar0rx6v2y392Yb0SwWZvdmz4CwffW1GGajNk50=/s.ts", None, false), 3),
            None,
            "an opaque per-segment path token is not a splice"
        );
    }

    /// The corollary that keeps the simplification honest: the upstream's own tag still splices, so removing
    /// the URL heuristics costs no true positives.
    #[test]
    fn upstream_tag_still_splices_a_contiguous_sequence() {
        let prev = PrevSeg { upstream_seq: Some(9) };
        assert_eq!(
            boundary_before(&prev, &segref("s10.ts", None, true), 10),
            Some(Boundary::Tag),
            "a tagged splice on a contiguous sequence must still fire"
        );
    }

    // ── #EXT-X-ENDLIST: session expiry vs. a finished channel ────────────────────────────────────────────

    fn uris(n: &[&str]) -> Vec<String> {
        n.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_first_endlist_is_never_terminal() {
        // Nothing to compare against yet, so the only honest move is to re-resolve and find out. This is the
        // case that used to kill a live pluto ingest every ~25s.
        assert!(!endlist_is_terminal(None, &uris(&["a.ts", "b.ts"])));
    }

    #[test]
    fn an_unchanged_endlist_playlist_is_terminal() {
        // The asset really is complete: a fresh resolve handed back the identical segment list.
        let prev = uris(&["a.ts", "b.ts", "c.ts"]);
        assert!(endlist_is_terminal(Some(&prev), &uris(&["a.ts", "b.ts", "c.ts"])));
    }

    #[test]
    fn a_renewed_session_keeps_the_ingest_alive() {
        // A provider that expired the session hands back a DIFFERENT window — the channel is still live.
        let prev = uris(&["clip/1/00027.ts", "clip/1/00028.ts"]);
        assert!(!endlist_is_terminal(Some(&prev), &uris(&["clip/1/00029.ts", "clip/1/00030.ts"])));
        // Same URIs but a different count is still a change (the window shrank/grew, so it is not static).
        assert!(!endlist_is_terminal(Some(&prev), &uris(&["clip/1/00027.ts"])));
        // …and an empty playlist is not "the same" as a populated one.
        assert!(!endlist_is_terminal(Some(&prev), &[]));
    }

    /// The regression that matters. An expired pluto session serves an EMPTY playlist + ENDLIST every time,
    /// so "unchanged" alone declared the channel finished and reintroduced the teardown this fix exists to
    /// remove — just at a slower cadence. Emptiness is the absence of evidence, not evidence of completion.
    #[test]
    fn repeated_empty_endlist_playlists_are_not_terminal() {
        assert!(!endlist_is_terminal(Some(&Vec::new()), &[]));
        assert!(!endlist_is_terminal(Some(&uris(&["a.ts"])), &[]));
        // …and the runaway is bounded elsewhere: a source that only ever returns empty trips MAX_EMPTY_POLLS,
        // which escalates through failover instead of quietly declaring the stream complete.
    }

    // ── S3/CUE Phase 2: the filler pool ──────────────────────────────────────────────────────────────────

    fn ad_seg(n: usize) -> Segment {
        Segment { ad: true, break_id: 1, ..seg(n, 100) }
    }

    #[test]
    fn program_tail_takes_the_newest_program_segments_oldest_first() {
        let o = Origin::new(1_000_000);
        for i in 0..6 {
            o.push(seg(i, 100), true);
        }
        let tail = o.program_tail(3);
        assert_eq!(tail.iter().map(|s| s.seq).collect::<Vec<_>>(), vec![3, 4, 5], "newest three, in play order");
    }

    /// The pool must skip a PREVIOUS break's filler, which is itself marked as break content. Looping a loop
    /// would compound the repetition — the viewer would see the same few seconds twice over.
    #[test]
    fn program_tail_skips_break_content() {
        let o = Origin::new(1_000_000);
        for i in 0..3 {
            o.push(seg(i, 100), true); // program
        }
        for i in 3..8 {
            o.push(ad_seg(i), true); // a break (or the filler that replaced it)
        }
        let tail = o.program_tail(3);
        assert_eq!(tail.iter().map(|s| s.seq).collect::<Vec<_>>(), vec![0, 1, 2], "reaches past the break");
        assert!(tail.iter().all(|s| !s.ad));
    }

    #[test]
    fn program_tail_is_empty_when_the_ring_holds_no_program() {
        // Nothing to loop ⇒ the caller must decline to substitute and serve the ad instead.
        let o = Origin::new(1_000_000);
        for i in 0..4 {
            o.push(ad_seg(i), true);
        }
        assert!(o.program_tail(3).is_empty());
    }

    // ── S3/CUE: ad classification ────────────────────────────────────────────────────────────────────────
    // All URIs below are VERBATIM from a live pluto capture (2026-08-06) that caught a full ~2 min pod of 5
    // creatives. The signature list is what the pluto adapter declares, already lowercased by state.rs.

    const PLUTO_SIG: &str = "0_ad/creative/";
    const PGM_URI: &str = "https://siloh-ns1.plutotv.net/865_pluto/clip/616872f90b4e8f001a96043e_Titanic/1080pDRM/20250821_205403/hls/6281158-6741367/hls_300-00027.ts";
    const AD_URI: &str = "https://siloh-ns1.plutotv.net/v1/mp4/c(ts)/h(default)/max(6)/rev(1)/p(0_ad%2Fcreative%2F6a6d6f417efe0af5316f0411_ad%2F720p%2F20260801_040001_248657053_x_a53f810a%2Fvideo_600.mp4)/id3(p=clik,id=6a6d6f417efe0af5316f0411)/head(0-984)/frag(984-382846)/sign/v1/1Z7FXa8QkGTviYcMUGdk2tAY3YaVaSOrvZVOw0MQACE=/0.ts";

    fn ad_of(uri: &str, sigs: &[&str]) -> Option<AdSignal> {
        let list: Vec<String> = sigs.iter().map(|s| s.to_string()).collect();
        ad_signal(&segref(uri, None, false), &Url::parse(uri).unwrap(), &list)
    }

    #[test]
    fn a_pluto_ad_creative_is_detected_and_a_program_clip_is_not() {
        // The signature is declared percent-DECODED; the wire form is `0_ad%2Fcreative%2F`.
        assert_eq!(ad_of(AD_URI, &[PLUTO_SIG]), Some(AdSignal::UriSignature));
        assert_eq!(ad_of(PGM_URI, &[PLUTO_SIG]), None, "a /clip/ path can never contain the ad marker");
    }

    /// The load-bearing test. A generic "did the segment URL's directory change?" detector was tried on this
    /// exact source and REMOVED (see `Boundary`) because these two shapes both answer yes ~9 times per window.
    /// A declared literal must be immune to both — it never compares two URIs to each other.
    #[test]
    fn the_removed_url_heuristics_false_positives_are_not_ads() {
        // 1. pluto rotates the keyfile WITHIN one clip — same media, different key directory.
        for k in ["keyfile_5", "keyfile_6", "keyfile_7"] {
            let u = format!("https://siloh-ns1.plutotv.net/865_pluto/clip/abc_Movie/1080pDRM/d/hls/1-2/{k}/s.ts");
            assert_eq!(ad_of(&u, &[PLUTO_SIG]), None, "in-clip key rotation is not an ad break");
        }
        // 2. some CDN paths carry a PER-SEGMENT opaque token, so the "directory" is never stable mid-clip.
        for t in ["UWJ5Mz0j0e=", "Xk91bQ2p7f=", "Zm9vYmFyYmF6="] {
            let u = format!("https://cdn.example.com/v1/{t}/hls_300-00031.ts");
            assert_eq!(ad_of(&u, &[PLUTO_SIG]), None, "an opaque per-segment token is not an ad break");
        }
    }

    #[test]
    fn a_source_that_declares_no_signature_detects_nothing() {
        // Fail closed: URI detection is opt-in per adapter, so a real ad URI on a source that never declared
        // one stays program. This is what keeps the mechanism safe to ship enabled for every source.
        assert_eq!(ad_of(AD_URI, &[]), None);
    }

    #[test]
    fn a_cue_tag_wins_over_the_uri_signature() {
        // The source's own statement about its timeline beats our pattern match — including the case where a
        // PROGRAM-looking URI sits inside a tagged break (SSAI that rewrites ad paths to look like content).
        let cued = SegRef {
            uri: PGM_URI.to_string(),
            key: None,
            duration: 5.0,
            discontinuity: false,
            cue: Some(crate::tsmux::CueState { kind: CueKind::CueOut, duration: 30.0 }),
        };
        let url = Url::parse(PGM_URI).unwrap();
        assert_eq!(ad_signal(&cued, &url, &[]), Some(AdSignal::CueTag), "believed even with no signature");
        assert_eq!(
            ad_signal(&cued, &url, &[PLUTO_SIG.to_string()]),
            Some(AdSignal::CueTag),
            "the tag names the signal, not the fallback"
        );
    }

    #[test]
    fn a_daterange_break_reports_its_own_signal() {
        let seg = SegRef {
            uri: PGM_URI.to_string(),
            key: None,
            duration: 5.0,
            discontinuity: false,
            cue: Some(crate::tsmux::CueState { kind: CueKind::DateRange, duration: 120.0 }),
        };
        assert_eq!(ad_signal(&seg, &Url::parse(PGM_URI).unwrap(), &[]), Some(AdSignal::DateRange));
    }

    #[test]
    fn contiguous_same_clip_is_not_a_boundary() {
        let prev = PrevSeg { upstream_seq: Some(9) };
        assert_eq!(boundary_before(&prev, &segref("s10.ts", Some("https://k/a.key"), false), 10), None);
    }

    // ── SIDE-2 renderer ──────────────────────────────────────────────────────────────────────────────────
    // Checked against the REAL upstream shape observed live: an AES-128 key line per segment, clip paths
    // under siloh-ns1.plutotv.net, and #PLUTO-* trailer tags.

    fn window(n: usize, disc_at: &[usize]) -> Vec<Arc<Segment>> {
        (0..n)
            .map(|i| {
                Arc::new(Segment {
                    seq: 100 + i as u64,
                    duration: 5.0,
                    bytes: Bytes::from(vec![0x47u8; 10]),
                    discontinuity: disc_at.contains(&i),
                    pdt: SystemTime::UNIX_EPOCH + Duration::from_millis(1_785_931_853_433),
                    ad: false,
                    break_id: 0,
                })
            })
            .collect()
    }

    fn render(w: &[Arc<Segment>]) -> String {
        render_media_playlist(
            w,
            5.0,
            "/api/ext/v1",
            "pluto",
            "pluto://us_east/5b4e96a0423e067bd6df6901",
            0,
            Some("tok123"),
            Some("testplaylist"),
            0,
        )
    }

    /// The DECIDED definition of "clean": no visible origin, encryption, or hops.
    #[test]
    fn authored_manifest_meets_the_clean_checklist() {
        let m = render(&window(3, &[]));
        assert!(!m.contains("plutotv.net"), "1. no upstream host");
        assert!(!m.contains("siloh"), "1. no upstream path");
        assert!(!m.contains("jwt=") && !m.contains("sid="), "1. no upstream session/query");
        assert!(!m.contains("EXT-X-KEY"), "2. segments are delivered decrypted");
        assert!(!m.contains("PLUTO-"), "3. no vendor tags");
        assert!(!m.contains("/h/"), "4. no hop URIs — every path is ours");
        assert!(m.contains("#EXT-X-MEDIA-SEQUENCE:100"), "5. our sequence, not upstream's");
    }

    #[test]
    fn authored_manifest_has_the_expected_structure() {
        let m = render(&window(3, &[]));
        assert!(m.starts_with("#EXTM3U\n#EXT-X-VERSION:3\n"));
        assert!(m.contains("#EXT-X-TARGETDURATION:5"));
        assert!(m.contains("#EXT-X-PROGRAM-DATE-TIME:2026-08-05T"));
        assert_eq!(m.matches("#EXTINF:5.000,").count(), 3);
        assert!(m.contains("/api/ext/v1/pluto/o/"));
        assert!(m.contains("/0-100.ts?token=tok123&pl=testplaylist"));
        assert!(m.contains("/0-102.ts?token=tok123&pl=testplaylist"));
    }

    /// The token on every segment URI is what keeps per-account governance meaningful, since our paths are
    /// guessable by construction. Losing it would silently turn the ring into an open endpoint.
    #[test]
    fn every_segment_uri_carries_the_token() {
        let m = render(&window(4, &[]));
        let uris: Vec<&str> = m.lines().filter(|l| l.contains("/o/")).collect();
        assert_eq!(uris.len(), 4);
        assert!(uris.iter().all(|u| u.contains("token=tok123")), "no segment may be servable without the token");
    }

    #[test]
    fn discontinuity_is_emitted_before_its_segment_only() {
        let m = render(&window(3, &[1]));
        let lines: Vec<&str> = m.lines().collect();
        // EXACT match, not `contains`: `#EXT-X-DISCONTINUITY-SEQUENCE` shares the prefix.
        assert_eq!(lines.iter().filter(|l| **l == "#EXT-X-DISCONTINUITY").count(), 1);
        let i = lines.iter().position(|l| *l == "#EXT-X-DISCONTINUITY").unwrap();
        // RFC 8216 §6.2.1 — the splice re-anchors the clock before the segment it precedes.
        assert!(lines[i + 1].starts_with("#EXT-X-PROGRAM-DATE-TIME:"));
        assert!(lines[i + 2].starts_with("#EXTINF:"));
        assert!(lines[i + 3].contains("/0-101.ts"));
    }

    /// A date-time is only interpolatable along ONE continuous media timeline, so every discontinuity needs
    /// its own anchor. Measured live at 5 splices behind a single anchor, with jumps up to 16 minutes — the
    /// deeper the ring, the worse a single anchor gets.
    #[test]
    fn every_timeline_in_the_window_gets_its_own_program_date_time() {
        let m = render(&window(9, &[3, 6, 7]));
        let pdts = m.lines().filter(|l| l.starts_with("#EXT-X-PROGRAM-DATE-TIME:")).count();
        assert_eq!(pdts, 4, "the window head plus one per discontinuity");
        // …and none of them is orphaned: each must be immediately followed by its segment's #EXTINF.
        let lines: Vec<&str> = m.lines().collect();
        for (i, l) in lines.iter().enumerate() {
            if l.starts_with("#EXT-X-PROGRAM-DATE-TIME:") {
                assert!(lines[i + 1].starts_with("#EXTINF:"), "a PDT must anchor a segment");
            }
        }
    }

    /// The head anchor and a splice anchor can be the SAME segment, once the window has slid far enough to
    /// open exactly on a discontinuity. Emitting for both reasons would put two consecutive PDT lines on one
    /// segment; the `i == 0 ||` short-circuit collapses them. Observed live at `#EXT-X-MEDIA-SEQUENCE:69`.
    #[test]
    fn a_window_opening_on_a_discontinuity_gets_exactly_one_date_time() {
        let m = render(&window(6, &[0, 3]));
        let lines: Vec<&str> = m.lines().collect();
        let pdts = lines.iter().filter(|l| l.starts_with("#EXT-X-PROGRAM-DATE-TIME:")).count();
        assert_eq!(pdts, 2, "one per timeline RANGE, not one per reason to anchor");
        for (i, l) in lines.iter().enumerate() {
            if l.starts_with("#EXT-X-PROGRAM-DATE-TIME:") {
                assert!(lines[i + 1].starts_with("#EXTINF:"), "no PDT may be orphaned by another PDT");
            }
        }
    }

    #[test]
    fn discontinuity_sequence_counts_tags_that_left_the_window() {
        // RFC 8216 §6.2.2. The cap forces eviction; only the evicted segments that CARRIED a tag count.
        let o = Origin::new(2_000);
        assert_eq!(o.disc_seq(), 0, "nothing has left yet");
        for i in 0..12 {
            let mut s = seg(i, 500);
            s.discontinuity = i == 1 || i == 2; // two tags, both destined to be evicted
            o.push(s, true);
        }
        assert!(o.ring_depth() < 12, "the cap must have evicted something for this to test anything");
        assert_eq!(o.disc_seq(), 2, "both evicted tags counted, the surviving segments' tags not");
    }

    #[test]
    fn discontinuity_sequence_never_decreases_across_a_ring_reset() {
        // A reset discards the whole window at once; counting what leaves is what keeps the tag monotonic,
        // which RFC 8216 requires of it exactly as it does of the media sequence.
        let o = Origin::new(1_000_000); // large: nothing evicts, so the reset is the only thing that counts
        for i in 0..5 {
            let mut s = seg(i, 100);
            s.discontinuity = i >= 3;
            o.push(s, true);
        }
        assert_eq!(o.disc_seq(), 0, "nothing evicted while the ring had room");
        let before = o.disc_seq();
        o.reset_ring();
        assert_eq!(o.disc_seq(), before + 2, "the two tags in the discarded window left the playlist");
        o.reset_ring();
        assert_eq!(o.disc_seq(), before + 2, "an empty reset adds nothing, and never goes backwards");
    }

    #[test]
    fn the_discontinuity_sequence_tag_is_always_present() {
        // Omitting it is not "0 by default": it pins the published value at 0 while the true count climbs.
        assert!(render(&window(3, &[])).contains("#EXT-X-DISCONTINUITY-SEQUENCE:0"));
        let m = render_media_playlist(&window(2, &[]), 5.0, "/api/ext/v1", "s", "e", 0, None, None, 42);
        assert!(m.contains("#EXT-X-DISCONTINUITY-SEQUENCE:42"));
    }

    #[test]
    fn target_duration_is_an_integer_ceiling_of_the_longest_segment() {
        // A playlist whose TARGETDURATION is below any #EXTINF is rejected by players.
        let mut w = window(2, &[]);
        w[1] = Arc::new(Segment { duration: 5.005, ..(*w[1]).clone() });
        let m = render_media_playlist(&w, 5.0, "/api/ext/v1", "s", "e", 0, None, None, 0);
        assert!(m.contains("#EXT-X-TARGETDURATION:6"), "must ceil above the longest EXTINF");
    }

    #[test]
    fn generation_appears_in_segment_paths_so_stale_urls_can_404() {
        let m = render_media_playlist(&window(1, &[]), 5.0, "/api/ext/v1", "s", "e", 7, None, None, 0);
        assert!(m.contains("/7-100.ts"), "generation is part of the path");
    }

    #[test]
    fn rfc3339_formats_a_known_instant() {
        // Expected values cross-checked against `date -u` AND python — not just against this implementation.
        let t = SystemTime::UNIX_EPOCH + Duration::from_millis(1_785_931_853_433);
        assert_eq!(fmt_rfc3339(t), "2026-08-05T12:10:53.433Z");
        assert_eq!(fmt_rfc3339(SystemTime::UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        // A leap day — the case naive day/month arithmetic gets wrong.
        let leap = SystemTime::UNIX_EPOCH + Duration::from_secs(1_709_164_800);
        assert_eq!(fmt_rfc3339(leap), "2024-02-29T00:00:00.000Z");
    }

    #[test]
    fn first_segment_ever_is_not_a_boundary() {
        // A cold ring has no previous segment — starting is not a splice.
        assert_eq!(boundary_before(&PrevSeg::default(), &segref("s0.ts", None, false), 0), None);
    }
}
