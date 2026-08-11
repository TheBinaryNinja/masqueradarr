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
    decrypt_aes128_cbc, encryption_method, has_map, is_master, parse_media_playlist, pick_variant, poll_interval,
    unsupported_encryption, CueKind, SegRef,
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

/// How long a STRUCTURAL decline is remembered after the ingest that discovered it died.
///
/// The verdict is expensive — a Node resolve round-trip plus an upstream entry fetch — and it is stable by
/// definition ("this shape can never be ringed"), so re-deriving it on every manifest poll is pure waste.
/// It still has to EXPIRE: a provider that starts publishing fMP4 can stop again, and the memo outlives the
/// task that could otherwise re-test it. Aged from when the decline was recorded, not from last access, so a
/// channel under continuous polling is still retried on this cadence rather than staying declined for as
/// long as someone keeps watching it.
const INELIGIBLE_MEMO_TTL: Duration = Duration::from_secs(60);

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

/// S3/UND — how many consecutive segments must carry the SAME structural fault before the upstream is
/// retired. The faults themselves are named and judged by `tsseg::inspect_segment`.
///
/// The failure this exists for is invisible to every other health signal. A dlhd player provider can serve
/// HTTP 200 for every playlist and every segment — ring filling, manifests rendering, no timeouts — while its
/// H.264 carries no SPS/PPS at all, so the DECODER produces nothing and the viewer sees a black screen. Serve
/// counts measure fetching, not rendering, so "all segments served" cannot tell the two apart. Measured live
/// on dlhd channel 648 (Boomerang) via Player 4: `non-existing PPS 0 referenced` / `no frame!`, reproduced
/// identically against the provider DIRECT, with masqueradarr entirely out of the path.
///
/// THREE consecutive, not one: a single segment may legitimately lack parameter sets (a mid-GOP cut, a
/// provider that repeats them only every few seconds). Hopping off a working provider is worse than the
/// disease, so the bar is deliberately high.
const UNDECODABLE_STRIKES: u32 = 3;

/// …and only within this many segments of a fresh resolve. A provider that has been serving decodable video
/// for minutes and then stutters is a different problem from one that never had parameter sets at all; this
/// check answers only the second question, at the moment a new upstream is adopted.
const UNDECODABLE_PROBE_SEGMENTS: u32 = 6;

/// How many consecutive pairs the INTERLEAVED raw-TS producer may decline before it ends the socket.
///
/// One decline is a shape `tsweave` could not carry — skip the pair, warn, carry on. Three in a row means the
/// stream shape has genuinely moved out from under the published program, and a socket that stays open while
/// emitting nothing looks like working playback rather than a fault. Ending it lets the client reconnect,
/// which re-dispatches: an origin that has actually become muxed then lands on `ts_ring_producer`.
const MAX_PAIR_DECLINES: u32 = 3;

/// How many recently-ingested upstream segment URIs the ingest remembers, for recognising the window a
/// RENEWED provider session re-offers (see `dedupe_by_uri`). About one live window plus slack — small enough
/// that a source recycling segment names would have to wrap within it to cause a false skip.
const RECENT_URI_MEMORY: usize = 64;

/// One ingested segment, ready to serve verbatim. `bytes` is DECRYPTED — ciphertext never enters the ring, so
/// a renderer never has to know whether the upstream was encrypted.
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
    /// The paired audio-rendition segment, on a DEMUXED origin only. `None` on a muxed one (the audio is
    /// already inside `bytes`) and on every raw-TS cut.
    ///
    /// Held on the SAME ring entry rather than in a second deque on purpose: it makes the two published
    /// windows identical by construction (same `#EXT-X-MEDIA-SEQUENCE`, same `#EXT-X-DISCONTINUITY-SEQUENCE`,
    /// same PDT anchor), makes eviction inherently paired, and means a renderer can never serve half a pair.
    ///
    /// `duration` above is published for BOTH lanes. The rendition's own `#EXTINF` differs slightly — AAC
    /// quantises to ~21.3 ms (1024 samples @ 48 kHz), so pluto states `5.013 / 4.992` against a flat video
    /// `5` — but the difference OSCILLATES rather than accumulating (~2 ms over 25 s). Publishing one ladder
    /// keeps the two playlists' computed timelines identical on paper; the media's own PTS, held together by
    /// the shared offset, is what actually governs sync.
    pub audio: Option<Bytes>,
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
    /// Whether the decoder configuration actually changed at this edge — i.e. whether the break really did
    /// force the decoder to reconfigure, or the seam was only a timeline one. This is the measurement that
    /// justifies splice normalisation (`tsnorm::Splicer`); it is reported, never acted on.
    profile_changed: bool,
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
    /// Why this upstream can NEVER be ringed, if so — a shape mismatch (fMP4, undecryptable segments, audio
    /// the ring cannot carry), not a transient failure.
    ///
    /// Load-bearing for the FALLBACK, not just for logging. Without it a structural mismatch was
    /// indistinguishable from "still warming up", so the renderers burned `READY_TIMEOUT` and then answered
    /// 503 — a dead channel — while the ingest retried an upstream that was never going to fit. Set once by
    /// `resolve_media`; read by `wait_ready`, which is what lets `serve_entry`/`serve_ts` decline and hand the
    /// request back to the ordinary rewrite path.
    ineligible: RwLock<Option<String>>,
    /// When `ineligible` was recorded — the memo's OWN age, which is what `INELIGIBLE_MEMO_TTL` is measured
    /// against. Deliberately not `last_access`: polling the channel must not keep a stale decline alive.
    ineligible_at: Mutex<Option<Instant>>,
    /// Set once the ingest learns this upstream is DEMUXED — the audio rendition it rings beside the video.
    ///
    /// Read by Side-2 to pick the renderer: the HLS one authors an `#EXT-X-MEDIA` from it (so the client still
    /// sees the track labelled as upstream labelled it), and `serve_ts` routes to the INTERLEAVING producer
    /// (`ts_ring_pair_producer` → `tsweave`), which folds the pair into one program on the way out.
    demuxed_audio: RwLock<Option<DemuxedMaster>>,
    /// Which KIND of playlist the entry was last answered with — `true` master, `false` media playlist.
    ///
    /// Diagnostic only, and deliberately so. `serve_entry` re-decides the kind from `demuxed_audio` on every
    /// poll, so a mid-session flip changes what one URL *is*, and RFC 8216 gives a client no reload semantics
    /// for a media playlist that has become a master — players fail the load. There is no in-session repair
    /// (after the flip, EITHER shape describes a ring the client's session cannot use), and pinning the kind
    /// would only trade a failed reload for silent video. So the transition is recorded and named instead:
    /// without it, "the stream just stopped" is indistinguishable from a stall in every log we keep.
    last_entry_master: RwLock<Option<bool>>,
    /// S3/UND — the last structural fault that retired an upstream on this channel, and how many upstreams
    /// have been retired for one. Reported on the `iop` health frame so a channel quietly hopping providers
    /// is visible in Active Streams, not only in the log. That invisibility is what let a false positive run
    /// unnoticed until a viewer reported the symptom.
    last_suspect: RwLock<Option<String>>,
    suspect_retires: AtomicU32,
    /// What this upstream turned out to BE — `"ts"` (a bare transport-stream socket we segment ourselves),
    /// `"hls-master"` (a master playlist we picked a variant from) or `"hls-media"` (a media playlist we
    /// follow directly). Written by `resolve_media`, which is the only place that knows.
    ///
    /// It has to live on `Origin` rather than ride the return value: `MediaSource` is consumed by the ingest
    /// loop's `match` and never stored, while `report_iop` can see nothing but `ctx.origin`. Re-written on
    /// every resolve, so a failover onto a differently-shaped upstream corrects it rather than going stale.
    upstream_shape: RwLock<Option<String>>,
    /// The encryption METHOD this upstream declares — `"NONE"`, `"AES-128"`, or whatever else it names.
    ///
    /// Reported for DISPLAY, which is why it comes from `encryption_method` and not `unsupported_encryption`:
    /// the latter cannot tell cleartext from AES-128, and AES-128 is what most of these sources use. Set on
    /// every resolve BEFORE the eligibility guards, so a channel the origin declines still reports what it
    /// found rather than reporting nothing.
    encryption: RwLock<Option<String>>,
}

/// What a DEMUXED origin needs in order to author its own master over the pair.
#[derive(Clone)]
pub struct DemuxedMaster {
    pub audio: crate::tsmux::AudioRendition,
    /// The picked variant's `BANDWIDTH` — RFC 8216 makes it the one required `#EXT-X-STREAM-INF` attribute.
    pub bandwidth: i64,
}

/// Which rendition of a demuxed origin a request addresses. `Video` is also the whole of a muxed origin, so
/// it is the shape every existing URL keeps.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lane {
    Video,
    Audio,
}

/// Seeds `Origin::generation` so that no two origins — including two incarnations of the SAME channel — ever
/// share one.
///
/// `reset_ring` bumps the generation, which is what makes a stale segment URL fail cleanly after a failover.
/// That guard only ever compared a URL against the CURRENT registry entry, so it held within one origin and
/// not across them: a respawned origin used to start at generation 0 with `next_seq` back at 0, re-issuing
/// the exact `<gen>-<seq>.ts` names its predecessor had already handed out. A client holding a stale manifest
/// then got a 200 and DIFFERENT media, which is precisely what the generation exists to prevent. Process-wide
/// and monotonic, because the value only ever has to differ — nothing reads meaning into it.
static GENERATION_SEED: AtomicU64 = AtomicU64::new(1);

impl Origin {
    fn new(ring_cap_bytes: u64) -> Self {
        Self {
            ring: RwLock::new(VecDeque::new()),
            ring_bytes: AtomicU64::new(0),
            next_seq: AtomicU64::new(0),
            generation: AtomicU64::new(GENERATION_SEED.fetch_add(1, Ordering::Relaxed)),
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
            ineligible: RwLock::new(None),
            ineligible_at: Mutex::new(None),
            demuxed_audio: RwLock::new(None),
            last_entry_master: RwLock::new(None),
            last_suspect: RwLock::new(None),
            suspect_retires: AtomicU32::new(0),
            upstream_shape: RwLock::new(None),
            encryption: RwLock::new(None),
        }
    }

    /// The audio rendition this origin rings beside the video, if it is a demuxed one.
    fn demuxed_audio(&self) -> Option<DemuxedMaster> {
        self.demuxed_audio.read_ok().clone()
    }

    /// Refresh the idle clock without reading the ring. The authored MASTER is fetched once and carries no
    /// segments, so it has no window to snapshot — but it is still a live client saying "I am here", and the
    /// idle check is half `last_access`.
    fn touch(&self) {
        *self.last_access.lock_ok() = Instant::now();
    }

    /// Why this upstream can never be ringed, if it cannot be. `None` ⇒ still viable (or still warming up).
    fn ineligible(&self) -> Option<String> {
        self.ineligible.read_ok().clone()
    }

    /// Record a STRUCTURAL mismatch and wake anyone waiting on a window that is never coming.
    fn mark_ineligible(&self, reason: String) {
        *self.ineligible.write_ok() = Some(reason);
        *self.ineligible_at.lock_ok() = Some(Instant::now());
        self.notify.notify_waiters();
    }

    /// Whether this origin carries a decline still worth trusting — the whole reason a dead ingest's registry
    /// entry is kept rather than removed. `subscribe` reads it to answer from the memo instead of paying for
    /// a resolve; anything older than `INELIGIBLE_MEMO_TTL` reads as "re-test it".
    fn declined_recently(&self) -> bool {
        self.ineligible.read_ok().is_some()
            && self.ineligible_at.lock_ok().is_some_and(|t| t.elapsed() < INELIGIBLE_MEMO_TTL)
    }

    /// Append a segment and evict from the front until the ring fits its byte cap.
    ///
    /// Returns how many segments were evicted. The `MIN_SEGMENTS` floor is enforced HERE rather than by the
    /// caller because it is a property of the window, not of any one push: dropping below it produces a
    /// manifest no player will start, which is worse than briefly exceeding the RAM cap.
    ///
    /// Every segment reaching here was PULLED from upstream, so the ingest counters advance unconditionally —
    /// they are the number an operator reads to size `originRingMb` and to see the ring earning its keep
    /// (`ingest` vs `bandwidth` on the Active Streams row).
    fn push(&self, seg: Segment) -> usize {
        // Both lanes count. The cap is a RAM budget and the pair is what occupies the RAM; on pluto the audio
        // rendition is ~3 % of the video's bitrate, so a given `originRingMb` holds a marginally shorter
        // window than it did — the honest reading, and the one `floor_beat_cap` should be judging.
        let bytes = seg.bytes.len() as u64 + seg.audio.as_ref().map_or(0, |a| a.len() as u64);
        let cap = self.ring_cap_bytes.load(Ordering::Relaxed);
        let mut evicted = 0usize;
        {
            let mut ring = self.ring.write_ok();
            ring.push_back(Arc::new(seg));
            let mut total = self.ring_bytes.load(Ordering::Relaxed) + bytes;
            while total > cap && ring.len() > MIN_SEGMENTS {
                match ring.pop_front() {
                    Some(old) => {
                        total -= old.bytes.len() as u64 + old.audio.as_ref().map_or(0, |a| a.len() as u64);
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
        self.ingested_segments.fetch_add(1, Ordering::Relaxed);
        self.ingested_bytes.fetch_add(bytes, Ordering::Relaxed);
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

    /// Everything the telemetry frame needs from the window, under exactly ONE read guard.
    ///
    /// The predicates are INLINED rather than delegated to `ring_depth` / `floor_beat_cap` on purpose: each of
    /// those takes its own `self.ring.read_ok()`, and these are `std::sync::RwLock`s, which give no
    /// re-entrancy guarantee — a second read acquired while the first guard is live can deadlock against a
    /// writer that queued between them. A per-poll reporter is the last place to introduce that.
    ///
    /// Deliberately NOT built on `window()`: that stamps `last_access`, and the idle shutdown fires on
    /// `subscribers == 0 && last_access.elapsed() >= IDLE_GRACE`. `report_iop("ok")` runs on every productive
    /// poll — always faster than `IDLE_GRACE` — so reporting through `window()` would let the ingest
    /// heartbeat its own idle clock and a viewerless origin would pin its ring in RAM forever. (It also
    /// clones every `Arc` into a fresh `Vec`, which is pure waste for an observational read.)
    fn ring_stats(&self) -> RingStats {
        let ring = self.ring.read_ok();
        let bytes = self.ring_bytes.load(Ordering::Relaxed);
        RingStats {
            segments: ring.len(),
            seconds: ring.iter().map(|s| s.duration).sum::<f64>(),
            disc_in_window: ring.iter().filter(|s| s.discontinuity).count(),
            floor_beat_cap: ring.len() <= MIN_SEGMENTS
                && bytes > self.ring_cap_bytes.load(Ordering::Relaxed),
        }
    }
}

/// An observational snapshot of one live window — see `Origin::ring_stats`, which is its only producer.
///
/// Kept off `ring_footprint` by design: that function holds the registry `Mutex` across its whole loop and
/// documents why it must never touch `Origin.ring`.
struct RingStats {
    segments: usize,
    /// Σ of the held segments' own durations. The honest "how much time is on air", as opposed to
    /// `segments × target_duration`, which over-reads by the gap between each segment and the window's max.
    seconds: f64,
    /// Discontinuity tags still INSIDE the window. Disjoint by construction from `disc_seq`, which counts
    /// only the tags that have already left it.
    disc_in_window: usize,
    /// The byte cap could not be honored because the `MIN_SEGMENTS` floor won — i.e. we are over cap on
    /// purpose. Same predicate as `floor_beat_cap`, inlined here to stay on one guard.
    floor_beat_cap: bool,
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
            // A LIVE ingest — share it. `stopping` is the whole test: the teardown sets it before it drops
            // the registry entry, so between those two moments the key is still present while the task that
            // serves it has already left its loop. Reusing that origin hands the caller a lease on a ring
            // nothing will refill, and (worse) reports `start = false`, so no replacement is ever spawned.
            Some(o) if !o.stopping.load(Ordering::Relaxed) => {
                // A re-resolve may have changed the cap; apply it to the live ring so raising the dial takes
                // effect without a restart (it shrinks lazily, as new pushes evict against the new cap).
                o.ring_cap_bytes.store(cap, Ordering::Relaxed);
                (o.clone(), false)
            }
            // A DEAD ingest that recorded a structural decline. Keep answering from the memo: `wait_ready`
            // short-circuits on `ineligible`, so the caller falls back to the manifest rewrite immediately —
            // no resolve, no spawn, no telemetry — which is the whole point of not re-deriving a verdict that
            // cost a Node round-trip and an upstream fetch. Nothing is spawned, so nothing sweeps this entry:
            // the TTL inside `declined_recently` is what eventually retires it, via the arm below.
            Some(o) if o.declined_recently() => (o.clone(), false),
            // Either no entry, a dead one, or a decline that has aged out. Insert REPLACES the stale entry,
            // which is why the ingest guard removes only an origin it still owns.
            _ => {
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

/// One poll's worth of playlists: the media playlist being followed, plus the paired audio rendition's on a
/// DEMUXED source. Both are refreshed together — a stale audio window against a fresh video one would stop
/// pairing, which is a re-resolve, not something to serve around.
struct PollPlaylists {
    url: Url,
    body: String,
    audio: Option<(Url, String)>,
}

#[derive(Clone)]
struct IngestCtx {
    state: AppState,
    origin: Arc<Origin>,
    source: String,
    entry: String,
    pl: Option<String>,
    key: String,
}

/// Runs the ingest teardown on EVERY exit — including a panic.
///
/// It used to be a tail of `ingest`'s body, which covered every `break` and nothing else. A panic in the
/// segment or PSI parsers unwound straight past it and left the registry holding an entry with
/// `stopping == false`: `subscribe` then saw a live ingest that did not exist, returned `start = false`
/// forever, and the channel could never be respawned — not even by an entry poll, which is the one path that
/// recovers every other kind of ingest death. The raw-TS producers, meanwhile, sat on `wait_for_segment`
/// waking every 30 s to re-read a flag that was never going to flip.
struct IngestGuard {
    ctx: IngestCtx,
    rid: String,
}

impl Drop for IngestGuard {
    fn drop(&mut self) {
        // Mark the ingest dead BEFORE dropping the registry entry, and wake every reader. Without this a
        // raw-TS producer parked on `wait_for_segment` would keep re-waiting forever against a ring nothing
        // refills.
        self.ctx.origin.stopping.store(true, Ordering::Relaxed);
        self.ctx.origin.notify.notify_waiters();
        // A STRUCTURAL decline is KEPT: the entry is the memo, and `subscribe` answers from it until the TTL
        // retires it. Everything else is removed — but only if the key still holds THIS origin. `subscribe`
        // replaces a stopping entry, so a slow teardown could otherwise delete a healthy successor that has
        // already taken the key.
        if self.ctx.origin.ineligible().is_some() {
            // The memo is the VERDICT, never the media. A decline can land on a re-resolve long after the
            // ring filled (an upstream that turns fMP4 mid-session), and a retained ring is served, not just
            // held: `wait_ready` tests `ring_depth` BEFORE `ineligible`, so a full window answers `Ready::Yes`
            // and the channel plays a frozen loop until the memo ages out — while the ring's RAM is pinned for
            // as long as the entry survives, which is unbounded because nothing sweeps it. Dropping the window
            // frees the bytes AND lets `wait_ready` fall through to the decline, which is the whole point.
            self.ctx.origin.reset_ring();
        } else {
            let mut map = self.ctx.state.origins().lock_ok();
            if map.get(&self.ctx.key).is_some_and(|o| Arc::ptr_eq(o, &self.ctx.origin)) {
                map.remove(&self.ctx.key);
            }
        }
        report_iop(&self.ctx, "closed");
        log::info("iop", &self.rid, || {
            format!(
                "ingest stop {}/{} — {} segment(s), {} MiB ingested",
                self.ctx.source,
                crate::proxy::host_of(&self.ctx.entry),
                self.ctx.origin.ingested_segments.load(Ordering::Relaxed),
                self.ctx.origin.ingested_bytes.load(Ordering::Relaxed) / (1024 * 1024)
            )
        });
    }
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
    // Armed FIRST, so every exit below — `break`, or a panic out of a parser — is a clean teardown. It holds
    // its own handle on the context because the loop keeps using `ctx` by value throughout.
    let _guard = IngestGuard { ctx: ctx.clone(), rid: rid.clone() };

    let mut prev = PrevSeg::default();
    let mut next_upstream_seq: i64 = -1;
    let mut empty_polls: u32 = 0;
    let mut key_cache: Option<(String, [u8; 16])> = None;
    // The audio rendition rotates its OWN keyfile on its own schedule, so it needs its own cache slot —
    // sharing one would refetch on every alternation between the two lanes.
    let mut audio_key_cache: Option<(String, [u8; 16])> = None;
    let mut warned_floor = false;
    let mut media: Option<PollPlaylists> = None;
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
    let mut splicer = crate::tsnorm::Splicer::new();
    // The demuxed counterpart. Only one of the two ever runs for a given session — which one is decided by
    // whether `resolve_media` found an audio rendition — but both are held so a re-resolve can change shape
    // without rebuilding the task.
    let mut pair_splicer = crate::tsnorm::PairSplicer::new();
    let mut warned_splice: std::collections::HashSet<&'static str> = std::collections::HashSet::new();
    let mut warned_pairing = false;
    // Latch for the one-shot line naming which key is pairing this source's two renditions.
    let mut pairing_logged = false;
    let mut probe_segments: u32 = 0;
    // The fault currently repeating, and how many segments in a row have shown it.
    let mut suspect_run: Option<(crate::tsseg::Suspect, u32)> = None;
    let mut undecodable_bail = false;
    // Set for exactly one resolve: the NEXT one carries this reason, so the adapter records WHICH fault
    // retired the provider rather than a generic "it failed".
    let mut pending_reason: Option<&'static str> = None;
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
        let (media_url, media_body, audio_pl) = match media.take() {
            Some(m) => (m.url, m.body, m.audio),
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
                // S3/UND: name the cause on the resolve that retires the provider, then disarm — a later
                // ordinary re-resolve must not keep blaming it.
                let reason = pending_reason.take();
                let resolved = resolve_media(&ctx, &rid, escalate, reason).await;
                // A fresh upstream gets a fresh verdict: the probe window re-opens so the NEW provider is
                // judged on its own segments, not on the corpse of the last one.
                if resolved.is_some() {
                    probe_segments = 0;
                    suspect_run = None;
                }
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
                            // renewal — a new id every ~2.5 s in the `iop:cue` log. A reset is different: that
                            // upstream may be another channel entirely, so its break AND its rebased timeline
                            // are both meaningless now. `splicer.reset()` is the load-bearing half — it is what
                            // stops the new upstream's first segment being spaced against the dead one's clock.
                            ad_break = None;
                            splicer.reset();
                            pair_splicer.reset();
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
                    Some(MediaSource::Hls(u, b, a)) => (u, b, a),
                    // A bare TS socket has nothing to poll: hand off to the local segmenter for the whole
                    // session, then fall back into this loop (which re-checks stop/idle and re-resolves).
                    Some(MediaSource::RawTs(stream, first)) => {
                        ingest_raw_ts(&ctx, &rid, stream, first).await;
                        next_upstream_seq = -1;
                        continue;
                    }
                    // A STRUCTURAL decline is not a failure to retry: the shape will not change on the next
                    // poll, and the renderer has already been told to fall back. Retrying would pull the entry
                    // every 2 s forever for a channel nobody is being served from the ring.
                    None if ctx.origin.ineligible().is_some() => break,
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
        // The paired audio window for this poll — parsed once here, indexed per segment below.
        let ap = audio_pl.as_ref().map(|(u, b)| (u.clone(), parse_media_playlist(b)));
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
        // S3/UND — the undecodable-upstream detector. Scoped to sources that HAVE alternates to walk to:
        // retiring an upstream is only useful where another one can take over, and on a single-upstream
        // source the retirement would just re-resolve the same dead provider on a 2 s loop. It used to be
        // `ctx.source == "dlhd"`, the crate's only hardcoded provider id.
        //
        // Read per poll off the MOUNT source's policy, exactly like this loop's other knobs (headers,
        // timeouts, allow_private) — not off the serving candidate's. The two differ only after a failover
        // onto another provider, whose grant files its policy under its own `policySource`; for attempt 0
        // they are the same object. Worth knowing when reading this: a child's capability does not flip the
        // parent's watch, which is the existing behaviour of every knob here rather than a rule of this one.
        let undecodable_watch = policy.player_selectable.load(Ordering::Relaxed);
        let client = ctx.state.client_for(
            policy.connect_timeout_ms.load(Ordering::Relaxed),
            policy.max_redirects.load(Ordering::Relaxed),
        );
        let read_timeout_ms = policy.read_timeout_ms.load(Ordering::Relaxed);

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

            // ── PAIRING ──────────────────────────────────────────────────────────────────────────────────
            // On a demuxed source the ring holds only COMPLETE pairs, so a video segment is not consumed
            // until its audio partner exists. The key is `#EXT-X-PROGRAM-DATE-TIME` — the wall clock of the
            // media itself — falling back to the media-sequence index only where a lane publishes no PDT.
            //
            // The media sequence was the original key and is NOT a cross-rendition identity: pluto renumbers
            // the two renditions independently across a session renewal, so the same media is sequence 10 on
            // one lane and 11 on the other. See `pair_audio` for the live trace.
            let audio_seg = match &ap {
                None => None,
                Some((aurl, apl)) => match pair_audio(seg, upstream_seq, apl) {
                    PairPick::Found(a, aseq) => Some((aurl.clone(), a.clone(), aseq)),
                    // The audio partner is already gone, so this pair can never be completed. Drop the video
                    // segment too: publishing it unpaired would put the two playlists on different windows,
                    // and the next segment's sequence check reports the gap honestly.
                    PairPick::RolledPast => {
                        if !warned_pairing {
                            warned_pairing = true;
                            log::warn("iop", &rid, || {
                                format!(
                                    "audio rendition is ahead of the video at upstream seq={upstream_seq} (audio media-sequence {}) — dropping the pair to keep both playlists aligned",
                                    apl.media_sequence
                                )
                            });
                        }
                        next_upstream_seq = upstream_seq + 1;
                        continue;
                    }
                    // HOLD the video segment — `next_upstream_seq` is deliberately NOT advanced — and retry
                    // on the next poll. A lane that never catches up is caught by MAX_EMPTY_POLLS.
                    PairPick::NotYet => break,
                },
            };
            // One line per ingest naming WHICH key is pairing this source, so a mispairing complaint can be
            // told apart from a source that never had a PDT to pair on.
            if let (Some((_, apl)), Some(_)) = (&ap, &audio_seg) {
                if !pairing_logged {
                    pairing_logged = true;
                    let by_pdt = seg.pdt_ms.is_some() && apl.segments.iter().any(|a| a.pdt_ms.is_some());
                    log::info("iop", &rid, || {
                        if by_pdt {
                            "pairing the two renditions on #EXT-X-PROGRAM-DATE-TIME (survives a session renewal renumbering either lane)".to_string()
                        } else {
                            "pairing the two renditions on the media-sequence index — no #EXT-X-PROGRAM-DATE-TIME on one or both lanes".to_string()
                        }
                    });
                }
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

            // S3/CUE: classify the segment. Read-only — every break is served exactly as the provider sent it;
            // this drives the `iop:cue` log and the ad-break telemetry, nothing else.
            let signal = ad_signal(seg, &seg_url, &policy.ad_uri_contains.read_ok());

            // An upstream signal wins the naming when several apply — it says something more specific than
            // "we reconnected". `forced` survives a failed fetch (it is cleared only after a push) so a join
            // whose first segment 404s still splices the one that does land.
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
            let boundary = boundary_before(&prev, seg, upstream_seq).or(pending);

            let plain = match fetch_segment(&ctx, &rid, &client, &policy, &media_url, seg, &seg_url, upstream_seq, read_timeout_ms, &mut key_cache).await {
                Some(b) => b,
                None => continue, // a gap: the NEXT ingested segment will see the sequence jump and splice
            };

            // The audio half, against the RENDITION's own base url, own key cache and — the part PDT pairing
            // changed — its OWN media sequence. RFC 8216 §5.2 derives an absent IV from the segment's media
            // sequence, and pairing on the wall clock exists precisely because the two lanes' sequences
            // diverge: handing the video's number to a renumbered audio lane decrypts its first CBC block
            // (the leading TS packet, usually the PAT) against the wrong IV.
            let audio_plain = match &audio_seg {
                None => None,
                Some((aurl, aseg, aseq)) => {
                    let aseg_url = match aurl.join(&aseg.uri) {
                        Ok(u) => u,
                        Err(_) => continue,
                    };
                    if let Some(h) = aseg_url.host_str() {
                        if !policy.allow_private.load(Ordering::Relaxed) && is_private_host(h) {
                            log::warn("iop", &rid, || format!("audio segment host {h} private/blocked — skipping"));
                            continue;
                        }
                        policy.hosts.write_ok().insert(h.to_lowercase());
                    }
                    match fetch_segment(&ctx, &rid, &client, &policy, aurl, aseg, &aseg_url, *aseq, read_timeout_ms, &mut audio_key_cache).await {
                        Some(b) => Some(b),
                        // No partner bytes ⇒ no pair. Dropping BOTH keeps the two published windows aligned;
                        // the next segment's sequence check turns the hole into an honest splice.
                        None => continue,
                    }
                }
            };

            // Snapshot what the boundary was decided AGAINST, before `prev` is overwritten — a splice log
            // naming only the trigger cannot distinguish real churn from a detector bug (that is how the two
            // removed URL heuristics were caught).
            let was = prev.clone();
            prev = PrevSeg { upstream_seq: Some(upstream_seq) };

            let duration = if seg.duration > 0.0 { seg.duration } else { mp.target_duration };
            let our_seq = ctx.origin.next_seq.fetch_add(1, Ordering::Relaxed);

            // Fingerprint the stream at edges only. `profile_changed` is what says whether the splice is
            // load-bearing (the decoder MUST reconfigure) or merely cosmetic — it is the measurement that
            // justifies normalising the splice at all. Unverifiable reads as CHANGED, never as a match.
            //
            // It measures the UPSTREAM: the scan runs on the fetched plaintext, before the splicer rewrites
            // it, so what it reports is the provider's own break behaviour rather than our output's.
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
                }
                (None, Some(b)) => {
                    // The RETURN to program is its own parameter change — report the one measured here, not
                    // the one measured when the break opened.
                    let done = AdBreak { profile_changed, ..b.clone() };
                    ad_break = None;
                    log::info("iop:cue", &rid, || {
                        let prof = if profile_changed { "profile CHANGED" } else { "profile same" };
                        format!(
                            "ad break #{} CLOSE at seq {our_seq} after {} segments / {:.1}s (via {:?}) — {prof}",
                            done.id, done.segments, done.seconds, done.signal
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
            // Runs at INGEST, once per segment, so one rewrite serves every viewer and both renderers.
            //
            // `spliceNormalize` is the kill switch. OFF republishes upstream bytes untouched — the pre-fix
            // behaviour, pid churn and all — so an operator can rule this pass in or out of a playback
            // complaint without a redeploy. Read per segment, not once per ingest, so a re-resolve flips it
            // live like every other knob.
            // A DEMUXED source runs `PairSplicer` instead: same contract, but ONE offset computed from the
            // video lane's DTS is applied to both renditions, so upstream's authored A/V skew survives
            // bit-exactly. A per-lane offset would manufacture a lip-sync error that was not in the source.
            // ── S3/UND: is this upstream structurally DECODABLE? ─────────────────────────────────────────
            // Every other health signal answers "are bytes arriving?", and a provider can serve perfect
            // HTTP 200s whose H.264 carries no parameter sets — decodes to nothing, looks healthy here.
            // `scan_profile` already extracts SPS/PPS for the pod-edge fingerprint; this reads the same
            // field as a liveness signal. `None` (no PSI at all) is UNVERIFIABLE, not undecodable — samsung's
            // first segment is legitimately PSI-less — so only a parsed profile missing its parameter sets
            // counts as a strike.
            if undecodable_watch && probe_segments < UNDECODABLE_PROBE_SEGMENTS {
                probe_segments += 1;
                // The run must be of the SAME fault. A segment that is not a transport stream followed by one
                // missing its parameter sets is two different problems, and counting them together would
                // retire a provider on evidence that never actually repeated.
                suspect_run = match (crate::tsseg::inspect_segment(&plain), suspect_run) {
                    (Some(s), Some((prev, n))) if prev == s => Some((s, n + 1)),
                    (Some(s), _) => Some((s, 1)),
                    (None, _) => None,
                };
                if let Some((s, n)) = suspect_run {
                    log::trace("iop", &rid, || format!("upstream {} ({n}/{UNDECODABLE_STRIKES})", s.describe()));
                    if n >= UNDECODABLE_STRIKES {
                        // RETIRE AND RE-RESOLVE — deliberately not a write-off. The escalating resolve burns
                        // this provider and walks the alternates; the adapter's own burn TTL is what stops a
                        // hot walk. An earlier cut marked the whole channel ineligible after two passes, but
                        // that state lived on the ingest, which dies 30 s after the last viewer — so a client
                        // with auto-reconnect never reached it anyway, while the one time it DID fire it
                        // wrote off a working channel. The harshest available action is the wrong response to
                        // a heuristic; hopping providers is the right one.
                        log::warn("iop", &rid, || {
                            format!(
                                "upstream {} ({UNDECODABLE_STRIKES} consecutive segments) — retiring this provider and walking the alternates",
                                s.describe()
                            )
                        });
                        suspect_run = None;
                        probe_segments = 0;
                        pending_reason = Some(s.slug());
                        *ctx.origin.last_suspect.write_ok() = Some(s.slug().to_string());
                        ctx.origin.suspect_retires.fetch_add(1, Ordering::Relaxed);
                        undecodable_bail = true;
                        break;
                    }
                }
            }

            let normalize = policy.splice_normalize.load(Ordering::Relaxed);
            let demuxed = audio_plain.is_some();
            if !normalize {
                // switched off mid-stream: the timeline being kept no longer applies
                if splicer.has_timeline() {
                    splicer.reset();
                }
                if pair_splicer.has_timeline() {
                    pair_splicer.reset();
                }
            }
            let joined = normalize && if demuxed { pair_splicer.has_timeline() } else { splicer.has_timeline() };
            // Declining is designed, not a failure: publish the bytes untouched and drop the timeline so the
            // next segment re-anchors on its own clock rather than being spaced against one whose media
            // nobody received. Upstream's splice is then signalled the old way — a visible decoder reset
            // beats a stream we mis-rewrote. On the paired path it is all-or-nothing: both lanes go verbatim
            // together, so they stay in sync with each other.
            // The stable cause travels WITH the message: the latch below keys on the former, the log prints
            // the latter. Keying on the message is what defeated the latch — every one of these reasons
            // interpolates a live measurement.
            let mut declined: Option<(&'static str, String)> = None;
            let (plain, audio_out, absorbed) = match (normalize, audio_plain) {
                (false, a) => (plain, a, false),
                (true, Some(araw)) => match pair_splicer.normalize_pair(&plain, &araw) {
                    Some((v, a)) => (Bytes::from(v), Some(Bytes::from(a)), true),
                    None => {
                        declined = Some((pair_splicer.last_decline_slug(), pair_splicer.last_decline().to_string()));
                        pair_splicer.reset();
                        (plain, Some(araw), false)
                    }
                },
                (true, None) => match splicer.normalize(&plain) {
                    Some(b) => (Bytes::from(b), None, true),
                    None => {
                        // One fixed sentence, so it is already its own key.
                        declined = Some((
                            "muxed-no-psi",
                            "no PSI, or a program shape the published layout cannot carry".to_string(),
                        ));
                        splicer.reset();
                        (plain, None, false)
                    }
                },
            };
            // Latched per DISTINCT reason rather than once per ingest. One latch hid the thing that matters —
            // whether a pod edge declines for the same cause every time (a shape to handle) or for a
            // different one each time (a bug in this pass).
            if let Some((cause, why)) = declined {
                if warned_splice.insert(cause) {
                    log::warn("iop", &rid, || {
                        format!("splice normalisation declined — {why}; publishing verbatim and signalling the splice")
                    });
                }
            }
            // Drop the tag ONLY when the splice was genuinely absorbed — the segment was moved onto a clock
            // that already existed. A FRESH anchor leaves the timestamps exactly where upstream put them, so
            // upstream's own signal still governs and must still be published.
            let discontinuity = if absorbed && joined { false } else { boundary.is_some() };

            let evicted = ctx.origin.push(Segment {
                seq: our_seq,
                duration,
                bytes: plain,
                discontinuity,
                pdt: SystemTime::now(),
                audio: audio_out,
            });
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

        // S3/UND: the upstream was retired (or the channel written off) mid-poll. Drop straight back to the
        // top so the next pass re-resolves — carrying the reason, so the adapter burns the RIGHT provider
        // for the RIGHT cause. `mark_ineligible` (the give-up case) is picked up by the resolve arm there.
        if undecodable_bail {
            undecodable_bail = false;
            media = None;
            media_failures = MEDIA_FAIL_ESCALATE; // force the ESCALATING resolve, not a re-resolve in place
            continue;
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

        // Refresh the playlist(s) for the next pass. A failed refresh clears `media` so the loop head
        // re-resolves. On a demuxed source BOTH lanes are refreshed together and a failure on either clears
        // `media`: a stale audio window against a fresh video one would stop pairing, and re-resolving is
        // the recovery that already exists.
        let audio_url = audio_pl.as_ref().map(|(u, _)| u.clone());
        let refreshed = async {
            let vresp = fetch_with_retry(&client, media_url.as_str(), &build_headers(&policy), read_timeout_ms, &rid, "iop-playlist", MAX_UPSTREAM_RETRIES).await.ok()?;
            if !vresp.status().is_success() {
                return None;
            }
            let vurl = vresp.url().clone();
            let vbody = vresp.text().await.ok()?;
            let audio = match &audio_url {
                None => None,
                Some(u) => {
                    let aresp = fetch_with_retry(&client, u.as_str(), &build_headers(&policy), read_timeout_ms, &rid, "iop-audio", MAX_UPSTREAM_RETRIES).await.ok()?;
                    if !aresp.status().is_success() {
                        return None;
                    }
                    Some((aresp.url().clone(), aresp.text().await.ok()?))
                }
            };
            Some((vurl, vbody, audio))
        }
        .await;
        match refreshed {
            Some((url, body, audio)) => media = Some(PollPlaylists { url, body, audio }),
            None => {
                log::warn("iop", &rid, || "media playlist refresh failed — re-resolving".to_string());
                media_failures = media_failures.saturating_add(1);
                media = None;
            }
        }
    }

    // The teardown itself is `IngestGuard::drop`, which runs here and on every other way out of this task.
}

/// Which audio segment partners a video one — the outcome of the pairing lookup.
enum PairPick<'a> {
    /// The partner segment, plus **its own** absolute media sequence.
    ///
    /// The sequence has to travel with the pick because the whole point of PDT pairing is that the two lanes
    /// renumber independently — so the video lane's number is not a stand-in for the audio lane's, and RFC
    /// 8216 §5.2 derives an absent `#EXT-X-KEY` IV from the segment's OWN media sequence. On the index
    /// fallback the two are equal by construction, which is why passing the video's was correct until PDT
    /// pairing existed.
    Found(&'a SegRef, i64),
    /// The audio window has already rolled past this video segment; the pair can never complete.
    RolledPast,
    /// The audio lane has not published this far yet — HOLD the video segment and retry next poll.
    NotYet,
}

/// How far two lanes' `#EXT-X-PROGRAM-DATE-TIME` values may differ and still describe the same media, in ms.
///
/// HALF a segment. Measured on live pluto, a correctly-paired demuxed segment agrees to **~20 ms** across the
/// two renditions, while a mispairing is a WHOLE segment out (~5000 ms) — so half a segment sits two orders of
/// magnitude clear of both. It also absorbs AAC's ~21.3 ms `#EXTINF` quantisation (1024 samples @ 48 kHz),
/// which oscillates rather than accumulating, so it can never walk a correct pair out of tolerance.
fn pair_tolerance_ms(video_duration: f64, target_duration: f64) -> i64 {
    let d = if video_duration > 0.1 {
        video_duration
    } else if target_duration > 0.1 {
        target_duration
    } else {
        6.0 // no ladder at all: assume a generous segment rather than a tolerance of zero
    };
    ((d * 1000.0) / 2.0).round() as i64
}

/// Find the audio segment that partners `video`.
///
/// PAIRS ON WALL CLOCK, not on the media sequence. The sequence *looks* like a cross-rendition identity and is
/// not: pluto renumbers the two renditions independently across a session renewal (its stitcher ENDLISTs every
/// ~25 s), so a fresh video playlist can open at sequence 10 against the audio's 11 **for the same media**.
/// Index pairing then puts every pair of that session ~one segment out, which `PairSplicer`'s skew guard
/// correctly refuses — costing the HLS lane its splice absorption and the raw-TS lane the segment outright.
/// Live trace behind this:
///
/// ```text
/// session renewed — ring kept (63 seg), join marked as a splice
/// audio rendition is ahead of the video (upstream seq=10 < audio media-sequence 11)
/// splice normalisation declined — the two renditions' clocks drifted apart by 9997 ms
/// ```
///
/// `#EXT-X-PROGRAM-DATE-TIME` is the identity the sequence pretends to be — RFC 8216 dates the media itself,
/// so it survives any renumbering. Both pluto renditions carry it and agree to ~11 ms.
///
/// The sequence index remains the FALLBACK for a source that publishes no PDT, so nothing that pairs correctly
/// today changes behaviour: an aligned pair resolves to the same segment either way.
fn pair_audio<'a>(video: &SegRef, upstream_seq: i64, apl: &'a crate::tsmux::MediaPlaylist) -> PairPick<'a> {
    if let Some(vt) = video.pdt_ms {
        // The INDEX rides along with the pick: the audio lane's own sequence is `media_sequence + index`, and
        // this is the only path that can land on an index the video's sequence does not name.
        let mut best: Option<(&SegRef, i64, usize)> = None;
        for (i, a) in apl.segments.iter().enumerate() {
            let Some(at) = a.pdt_ms else { continue };
            let d = (at - vt).abs();
            if best.is_none_or(|(_, bd, _)| d < bd) {
                best = Some((a, d, i));
            }
        }
        // Only trust this path when the audio lane actually dates itself; a lane with no PDT at all falls
        // through to the index rather than being declared "rolled past".
        if let Some((a, d, i)) = best {
            if d <= pair_tolerance_ms(video.duration, apl.target_duration) {
                return PairPick::Found(a, apl.media_sequence + i as i64);
            }
            // Out of tolerance: which SIDE decides hold-vs-drop. Before the window ⇒ the partner is already
            // gone; after it ⇒ it has not been published yet.
            let first = apl.segments.iter().find_map(|s| s.pdt_ms).unwrap_or(vt);
            return if vt < first { PairPick::RolledPast } else { PairPick::NotYet };
        }
    }
    // FALLBACK — the pre-existing sequence-index lookup, byte-for-byte the old behaviour.
    let idx = upstream_seq - apl.media_sequence;
    if idx < 0 {
        return PairPick::RolledPast;
    }
    match apl.segments.get(idx as usize) {
        // `media_sequence + idx` IS `upstream_seq` here, by the line above — written out rather than reusing
        // the video's number so the two arms state the same rule.
        Some(a) => PairPick::Found(a, apl.media_sequence + idx),
        None => PairPick::NotYet,
    }
}

/// Resolve the entry and walk to the MEDIA playlist to follow (peeking the top variant when the entry is a
/// master). `None` when nothing usable is reachable — the caller backs off and retries.
async fn resolve_media(ctx: &IngestCtx, rid: &str, escalate: bool, reason: Option<&str>) -> Option<MediaSource> {
    // `escalate` = the pinned candidate has failed us repeatedly, so advance the failover cursor instead of
    // re-resolving the same one. The ingest loop drives its own retries and never enters the handler's
    // failover_walk, so this is the ONLY way an origin-mode stream reaches the source's alternate upstreams
    // (dlhd's other player providers) or the channel's configured backups.
    let resolved = if escalate {
        ctx.state.resolve_advance(&ctx.source, &ctx.entry, ctx.pl.as_deref(), reason).await
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
        // Its own write site: this arm returns before the manifest handling below ever runs.
        *ctx.origin.upstream_shape.write_ok() = Some("ts".to_string());
        // …and so does the `demuxed_audio` write, which is why it has to be repeated here. A bare TS socket
        // is ONE muxed stream (`push_cut` pushes `audio: None`), so leaving a previous demuxed resolve's
        // rendition in place outlives the upstream that justified it — and every reader of the flag then
        // describes a ring that no longer exists: `serve_entry` keeps authoring a master, `serve_playlist`
        // keeps listing an audio lane whose segments 404, and `serve_ts` keeps dispatching to the pair
        // producer, which declines to its cap and ends the socket on a flag the reconnect re-reads unchanged.
        *ctx.origin.demuxed_audio.write_ok() = None;
        return Some(MediaSource::RawTs(Box::pin(stream), first));
    }
    // A manifest: drain the (small) remainder into text.
    let mut body = String::from_utf8_lossy(&first).into_owned();
    while let Some(Ok(b)) = stream.next().await {
        body.push_str(&String::from_utf8_lossy(&b));
    }

    let mut variant_bandwidth = 0i64;
    // The PICKED variant's own decode attributes (resolution, codecs, frame rate), carried out of the arm
    // below for the telemetry frame. They must travel WITH `variant_bandwidth` off the same STREAM-INF line —
    // see the `VariantPick` doc for why reading them back off the master instead would describe a different
    // rendition than the one this origin rings.
    let mut variant_attrs: (Option<String>, Option<String>, Option<String>) = (None, None, None);
    let entry_is_master = is_master(&body);
    // Extracted HERE, not later: on the master arm `body` merely stays borrowed, but on the media arm below
    // it is MOVED into the tuple, so a deferred read would not compile.
    let master_media = if entry_is_master { Some(crate::manifest::extract_media(&body)) } else { None };
    // One write covers both HLS arms — `entry_is_master` already made the distinction.
    *ctx.origin.upstream_shape.write_ok() =
        Some(if entry_is_master { "hls-master" } else { "hls-media" }.to_string());
    let (media_url, media_body, rendition) = if entry_is_master {
        let pick = pick_variant(&body, &url)?;
        variant_bandwidth = pick.bandwidth;
        variant_attrs = (pick.resolution.clone(), pick.codecs.clone(), pick.frame_rate.clone());
        // A variant whose audio lives in a separate #EXT-X-MEDIA rendition is followed as a PAIR: the ring
        // holds one entry per (video, audio) segment pair and the HLS renderer authors a master over both.
        // `pick_variant` still prefers a muxed variant when the master offers one — pairing is the fallback
        // for a source that offers nothing muxed, never the preferred shape.
        //
        // Before this, reaching here declined the whole origin, which is what put pluto — the one source with
        // ad pods, and so the whole reason `tsnorm` exists — permanently on the un-normalised rewrite path.
        let rendition = if pick.external_audio {
            match pick.audio.clone() {
                Some(a) => Some(a),
                // The master said every variant defers its audio but named no rendition we can follow. There
                // is nothing to pair with, so this is still a structural decline.
                None => {
                    let why = "audio is deferred to an #EXT-X-MEDIA group that names no playable rendition";
                    log::warn("iop", rid, || format!("{}: {why} — origin ingest not eligible", ctx.source));
                    ctx.origin.mark_ineligible(why.to_string());
                    return None;
                }
            }
        } else {
            None
        };
        let vresp = fetch_with_retry(&client, pick.url.as_str(), &build_headers(&policy), read_timeout_ms, rid, "iop-variant", MAX_UPSTREAM_RETRIES)
            .await
            .ok()?;
        if !vresp.status().is_success() {
            return None;
        }
        (vresp.url().clone(), vresp.text().await.ok()?, rendition)
    } else {
        (url, body, None)
    };

    // Recorded BEFORE the guards below, deliberately: the unsupported-method guard `return`s, and a channel
    // that got declined FOR its encryption is exactly the one whose encryption an operator wants named.
    *ctx.origin.encryption.write_ok() = Some(encryption_method(&media_body));

    // The same eligibility guards the raw-TS producer applies. fMP4 is not concatenable and SAMPLE-AES is not
    // decryptable, so an origin over either would publish bytes no renderer can honestly serve.
    if has_map(&media_body) {
        log::warn("iop", rid, || format!("{}: fMP4 (#EXT-X-MAP) — origin ingest not eligible", ctx.source));
        ctx.origin.mark_ineligible("fMP4 (#EXT-X-MAP) is not concatenable".to_string());
        return None;
    }
    if let Some(method) = unsupported_encryption(&media_body) {
        log::warn("iop", rid, || format!("{}: unsupported encryption METHOD={method} — origin ingest not eligible", ctx.source));
        ctx.origin.mark_ineligible(format!("unsupported encryption METHOD={method}"));
        return None;
    }

    // The audio lane, when there is one. Fetched here so the SAME guards run over it — a rendition that is
    // fMP4 or SAMPLE-AES is exactly as unringable as a variant that is.
    let audio = match &rendition {
        None => None,
        Some(r) => {
            let aresp = fetch_with_retry(&client, r.url.as_str(), &build_headers(&policy), read_timeout_ms, rid, "iop-audio", MAX_UPSTREAM_RETRIES)
                .await
                .ok()?;
            if !aresp.status().is_success() {
                return None;
            }
            let aurl = aresp.url().clone();
            let abody = aresp.text().await.ok()?;
            if has_map(&abody) {
                log::warn("iop", rid, || format!("{}: audio rendition is fMP4 (#EXT-X-MAP) — origin ingest not eligible", ctx.source));
                ctx.origin.mark_ineligible("audio rendition is fMP4 (#EXT-X-MAP)".to_string());
                return None;
            }
            if let Some(method) = unsupported_encryption(&abody) {
                log::warn("iop", rid, || format!("{}: audio rendition METHOD={method} — origin ingest not eligible", ctx.source));
                ctx.origin.mark_ineligible(format!("audio rendition unsupported encryption METHOD={method}"));
                return None;
            }
            log::info("iop", rid, || {
                format!(
                    "{}: demuxed master — ringing the video variant plus audio rendition \"{}\"{} as pairs",
                    ctx.source,
                    r.name,
                    if r.language.is_empty() { String::new() } else { format!(" ({})", r.language) }
                )
            });
            Some((aurl, abody))
        }
    };
    // DEC: manifest-declared decode metadata for an ORIGIN-backed channel. The passthrough rewrite path is
    // otherwise the ONLY producer of `kind:"media"`, and origin mode returns long before reaching it — so
    // codec / audio / container / resolution / fps read null on every channel actually served from a ring,
    // which is precisely the set an operator most wants to inspect.
    //
    // TWO extractions, because neither playlist carries the whole picture: a MASTER declares
    // resolution/codecs/frame-rate/bandwidth and no `#EXTINF`; a MEDIA playlist declares the container hint
    // and no `#EXT-X-STREAM-INF`. Reporting off the master alone would leave `container` null here forever.
    //
    // Placed after EVERY eligibility guard above — including the audio lane's — so a channel about to be
    // DECLINED never advertises ring-backed decode metadata for output the ring will not author.
    {
        let mut dec = master_media.unwrap_or_default();
        // The PICKED line's attributes OVERRIDE the master extraction. `extract_media` keeps the
        // highest-BANDWIDTH variant; `pick_variant` deliberately prefers a lower-bandwidth MUXED one when the
        // top variant would cost the audio track. On such a ladder they are different renditions, and a frame
        // that took resolution/codecs from one and bandwidth from the other would be self-contradictory —
        // advertising a stream this origin never carries.
        let (v_res, v_codecs, v_fps) = variant_attrs;
        if v_res.is_some() {
            dec.resolution = v_res;
        }
        if v_codecs.is_some() {
            dec.codecs = v_codecs;
        }
        if v_fps.is_some() {
            dec.frame_rate = v_fps;
        }
        let from_media = crate::manifest::extract_media(&media_body);
        if dec.resolution.is_none() {
            dec.resolution = from_media.resolution;
        }
        if dec.codecs.is_none() {
            dec.codecs = from_media.codecs;
        }
        if dec.frame_rate.is_none() {
            dec.frame_rate = from_media.frame_rate;
        }
        if dec.container.is_none() {
            dec.container = from_media.container;
        }
        // The declared rate of the variant we ACTUALLY ring. `pick_variant` prefers a muxed variant while
        // `extract_media` keeps the highest-bandwidth one, so on a demuxed master those are different
        // variants — reporting the latter would describe a rendition this origin never touches.
        if variant_bandwidth > 0 {
            dec.bandwidth = Some(variant_bandwidth);
        }
        // Same `any()` gate as the passthrough emit: a playlist that declared nothing must not spam an empty
        // frame, because Node merges these per channel and only overwrites on non-null.
        if dec.any() {
            ctx.state.report(serde_json::json!({
                "kind": "media",
                "source": ctx.source,
                "entryUrl": ctx.entry,
                "resolution": dec.resolution,
                "codecs": dec.codecs,
                "frameRate": dec.frame_rate,
                "container": dec.container,
                "bandwidth": dec.bandwidth,
                // Unlike the passthrough producer's partial polls, this frame is a COMPLETE snapshot of the
                // upstream just resolved — both playlists were read in this one pass. Without the flag Node
                // merges on non-null, so an escalation onto a leaner upstream (or one whose entry is a bare
                // media playlist) would keep the RETIRED provider's resolution and declared bitrate forever.
                "replace": true,
            }));
        }
    }

    // Re-recorded on every resolve, so a session renewal that re-mints the master picks up a moved rendition
    // URL without any renewal-specific code.
    *ctx.origin.demuxed_audio.write_ok() =
        rendition.map(|audio| DemuxedMaster { audio, bandwidth: variant_bandwidth });
    Some(MediaSource::Hls(media_url, media_body, audio))
}

/// What an upstream turned out to BE. Both shapes feed the same ring; only the way boundaries are discovered
/// differs — an HLS playlist states them, a bare socket has to be segmented locally (tsseg.rs).
enum MediaSource {
    /// The media playlist to follow, plus the paired audio rendition's playlist on a DEMUXED source.
    Hls(Url, String, Option<(Url, String)>),
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
/// continuous encode, and unlike HLS it carries no splice signal we could honestly propagate.
fn push_cut(ctx: &IngestCtx, cut: crate::tsseg::CutSegment) {
    let our_seq = ctx.origin.next_seq.fetch_add(1, Ordering::Relaxed);
    // A bare TS socket is one muxed stream, so there is never a second lane to pair with.
    ctx.origin.push(Segment {
        seq: our_seq,
        duration: cut.duration,
        bytes: Bytes::from(cut.bytes),
        discontinuity: false,
        pdt: SystemTime::now(),
        audio: None,
    });
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
    lane: Lane,
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
        // ONE `#EXTINF` ladder for both lanes. The audio rendition states its own, marginally different
        // durations upstream (AAC quantises to ~21.3 ms), but that difference oscillates rather than
        // accumulating — so publishing one ladder keeps the two playlists' computed timelines identical,
        // while the media's own PTS, held together by the shared offset, is what governs sync.
        out.push_str(&format!("#EXTINF:{:.3},\n", seg.duration));
        // Only the segment URI differs between lanes. The video shape is unchanged, so a muxed origin's
        // output is byte-identical to what it was before pairing existed.
        let l = match lane {
            Lane::Video => "",
            Lane::Audio => "a",
        };
        out.push_str(&format!("{mount_path}/{source}/o/{enc_entry}/{generation}-{l}{}.ts", seg.seq));
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

/// Render the AUTHORED MASTER a demuxed origin publishes at its entry: one variant plus one audio rendition,
/// both pointing back into our own `o/` namespace.
///
/// The two media-playlist URIs deliberately carry NO generation. A client fetches this master ONCE and then
/// polls the media playlists for the rest of the session, so a generation in those paths would make a
/// failover ring reset 404 the live session permanently. Segments keep it — that guard is what makes a stale
/// SEGMENT url fail cleanly — and each playlist poll re-renders under the current generation.
///
/// `streamInfRedux` does not apply here: it is a post-transform over a PROXIED master (proxy.rs), and this
/// one is authored, under 1 KiB, with the `#EXT-X-STREAM-INF` already inside any player's manifest peek.
fn render_master(
    mount_path: &str,
    source: &str,
    entry: &str,
    m: &DemuxedMaster,
    token: Option<&str>,
    pl: Option<&str>,
) -> String {
    let enc_entry = crate::manifest::enc(entry);
    let q = match (token, pl) {
        (Some(t), Some(p)) => format!("?token={t}&pl={p}"),
        (Some(t), None) => format!("?token={t}"),
        (None, Some(p)) => format!("?pl={p}"),
        (None, None) => String::new(),
    };
    let base = format!("{mount_path}/{source}/o/{enc_entry}");
    // VERSION 4: `#EXT-X-MEDIA` is a version-4 tag. The media playlists stay at 3.
    let mut out = String::from("#EXTM3U\n#EXT-X-VERSION:4\n");
    out.push_str("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\"");
    // Carry upstream's own labelling so a client still names the track the way it did before.
    if !m.audio.name.is_empty() {
        out.push_str(&format!(",NAME=\"{}\"", m.audio.name.replace('"', "")));
    } else {
        out.push_str(",NAME=\"Audio\"");
    }
    if !m.audio.language.is_empty() {
        out.push_str(&format!(",LANGUAGE=\"{}\"", m.audio.language.replace('"', "")));
    }
    out.push_str(&format!(",DEFAULT=YES,AUTOSELECT=YES,URI=\"{base}/a.m3u8{q}\"\n"));
    let bw = if m.bandwidth > 0 { m.bandwidth } else { 1_000_000 };
    out.push_str(&format!("#EXT-X-STREAM-INF:BANDWIDTH={bw},AUDIO=\"audio\"\n"));
    out.push_str(&format!("{base}/v.m3u8{q}\n"));
    out
}

/// The three ways waiting for a playable window can end. `TimedOut` and `Ineligible` are deliberately
/// distinct: one is "not yet, and the client should retry" (503), the other is "not ever, on this shape" —
/// and only the latter may fall back to the ordinary rewrite path. Collapsing them to a bool is what made a
/// shape mismatch answer 503 instead of falling back.
enum Ready {
    Yes,
    TimedOut,
    Ineligible,
}

/// Wait for a cold ring to become playable.
async fn wait_ready(origin: &Arc<Origin>, rid: &str) -> Ready {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if origin.ring_depth() >= MIN_SEGMENTS {
            return Ready::Yes;
        }
        // Answer the moment the shape is known to be unringable, rather than waiting out READY_TIMEOUT for a
        // window that is never coming. This is what turns a structural mismatch from a 503 into a fallback.
        if let Some(why) = origin.ineligible() {
            log::info("oop", rid, || format!("origin declined ({why}) — falling back to the manifest rewrite"));
            return Ready::Ineligible;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            log::warn("oop", rid, || {
                format!("ring still short ({}/{MIN_SEGMENTS}) after {READY_TIMEOUT:?} — refusing to serve an unplayable window", origin.ring_depth())
            });
            return Ready::TimedOut;
        }
        // Woken by the ingest on every push; the timeout bounds a channel that never produces one.
        let _ = tokio::time::timeout(left.min(Duration::from_secs(1)), origin.wait_for_segment()).await;
    }
}

/// Name the moment the entry's playlist KIND changes, once per change.
///
/// A client that fetched a media playlist reloads that same URL for the rest of its session; getting a master
/// back is not a shape it has any handling for. The flip itself is unavoidable — a NEW client must be told the
/// truth about the ring it is joining — so what this buys is the ability to read a session that died at
/// exactly this instant as what it was, rather than as an unexplained stall. See `Origin::last_entry_master`.
fn note_entry_shape(origin: &Origin, is_master: bool, rid: &str) {
    // ONE lock acquisition: swap the current shape in and judge what was there. `Some(!is_master)` is the
    // whole "it changed" test — the field is a bool, so the only other populated value IS the other shape.
    if origin.last_entry_master.write_ok().replace(is_master) == Some(!is_master) {
        let name = |m: bool| if m { "master" } else { "media playlist" };
        log::warn("oop", rid, || {
            format!(
                "entry shape changed {} → {} mid-session (the upstream re-resolved to the other lane shape) — \
                 clients already polling this URL will fail their next reload and have to start a new session",
                name(!is_master),
                name(is_master)
            )
        });
    }
}

/// SIDE-2 ENTRY: subscribe, wait for a playable window, and serve OUR manifest.
///
/// The lease is dropped when this returns — a polling client renews it on every poll, and the ingest's idle
/// grace covers the gaps. That keeps lifetime management in one place (the grace window) rather than
/// splitting it between the request path and a teardown hook.
///
/// `None` ⇒ this upstream's SHAPE cannot be ringed (see `Origin::ineligible`) and the caller must fall
/// through to the ordinary manifest rewrite. That is a real playback path, not an error: the rewrite passes
/// `#EXT-X-MEDIA` renditions through, so a channel whose audio is demuxed still plays — with sound — where
/// the ring could only have served it silent.
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
) -> Option<axum::response::Response> {
    let lease = subscribe(state, source, entry, pl, policy);
    let origin = lease.origin().clone();
    match wait_ready(&origin, rid).await {
        Ready::Yes => {}
        Ready::Ineligible => return None,
        Ready::TimedOut => return Some(crate::proxy::text(503, "stream warming up: no playable window yet")),
    }
    // Read the counter BEFORE snapshotting the window. The two are separate atomics, so an eviction landing
    // between them leaves a one-poll skew either way — but this order makes it an UNDER-count, where the tag
    // is still in the window and the client counts it itself. The other order double-counts it. (Monotonicity
    // holds regardless: the counter only ever rises.)
    // A DEMUXED origin answers the entry with an authored MASTER over the two lanes; a muxed one answers
    // with the single media playlist, byte-identically to before pairing existed.
    let demuxed = origin.demuxed_audio();
    note_entry_shape(&origin, demuxed.is_some(), rid);
    if let Some(m) = demuxed {
        origin.touch(); // the master itself carries no segments, but it is still a live client
        let body = render_master(mount_path, source, entry, &m, token, pl);
        log::info("oop", rid, || {
            format!("origin master served (1 variant + audio rendition \"{}\", {} bytes)", m.audio.name, body.len())
        });
        state.report(serde_json::json!({
            "kind": "viewer", "source": source, "entryUrl": entry,
            "ip": id.ip, "ua": id.ua, "username": id.username,
            "playerType": if mount_path == "/api/ext/v1" { "externalPlayer" } else { "appPlayer" },
            "bytes": body.len() as u64,
        }));
        return Some(crate::proxy::raw(200, "application/vnd.apple.mpegurl", body.into_bytes()));
    }
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
        Lane::Video,
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
    Some(crate::proxy::raw(200, "application/vnd.apple.mpegurl", body.into_bytes()))
}

/// SIDE-2 PLAYLIST: one lane's authored media playlist, for a demuxed origin's authored master.
///
/// SUBSCRIBES, exactly as `serve_entry` does — and that is the whole difference between a demuxed session
/// that survives an ingest death and one that does not. `window()` refreshing `last_access` keeps a polling
/// client's origin alive, which is why the idle sweep never reaps one out from under a watcher; but it cannot
/// bring an ingest BACK. Every other kind of ingest exit — upstream ENDLIST, a structural decline, empty-poll
/// exhaustion, a panic — removes the registry entry, and a demuxed client fetches its master exactly ONCE, so
/// it has no reason ever to touch a subscribing endpoint again: it would poll a 404 forever while a muxed
/// client, whose player re-reads the entry, is respawned transparently.
///
/// The policy comes from the cache rather than a resolve, so this stays a RAM-only path: no Node round-trip,
/// no upstream fetch, nothing `buildGrant`'s stored-entry gate has to see.
#[allow(clippy::too_many_arguments)]
pub async fn serve_playlist(
    state: &AppState,
    mount_path: &str,
    source: &str,
    entry: &str,
    lane: Lane,
    token: Option<&str>,
    pl: Option<&str>,
    id: &crate::proxy::Identity,
    rid: &str,
) -> axum::response::Response {
    // No cached policy means nothing in this process has ever resolved this source, so there is nothing to
    // start an ingest FROM — and no origin either, since creating one requires the same policy. Answering 404
    // is what this did in every case before it could respawn.
    let Some(policy) = state.hop_policy(source, entry) else {
        log::warn("oop", rid, || format!("playlist {lane:?}: no cached policy for {source} — cannot start an ingest"));
        return crate::proxy::text(404, "not found: no live ingest");
    };
    let lease = subscribe(state, source, entry, pl, &policy);
    let origin = lease.origin().clone();
    match wait_ready(&origin, rid).await {
        Ready::Yes => {}
        // A lane URL has no rewrite fallback to hand back to — the client is already inside our authored
        // master — so the honest answer is the same 404 a lane that carries no media gets.
        Ready::Ineligible => {
            log::warn("oop", rid, || format!("playlist {lane:?}: this upstream cannot be ringed"));
            return crate::proxy::text(404, "not found: no live ingest");
        }
        Ready::TimedOut => return crate::proxy::text(503, "stream warming up: no playable window yet"),
    }
    // Same ordering rule as `serve_entry`: read the counter BEFORE the window so a concurrent eviction
    // under-counts rather than double-counts.
    let disc_seq = origin.disc_seq();
    let window = origin.window();
    // The audio lane is rendered off the SAME ladder as the video one, so nothing downstream checks that the
    // entries actually carry a second lane — a ring holding muxed segments would publish a full ladder of
    // `-a` URIs and 404 every one of them at `serve_segment`. Fail the playlist instead: one honest 404 the
    // client can act on beats a valid-looking rendition whose every segment misses. (A non-empty window is
    // required so a ring caught mid-reset reads as "not yet", which is what the empty ladder already says.)
    if matches!(lane, Lane::Audio) && !window.is_empty() && window.iter().all(|s| s.audio.is_none()) {
        log::warn("oop", rid, || {
            format!("playlist {lane:?}: the ring holds no audio lane ({} segment(s)) — 404", window.len())
        });
        return crate::proxy::text(404, "not found: lane not carried");
    }
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
        lane,
    );
    log::info("oop", rid, || {
        format!("origin manifest served ({lane:?} lane, {} segment(s), {} bytes)", window.len(), body.len())
    });
    // The viewer heartbeat. `noteViewer` keys on (ip, ua, username, channel), so the two lanes' polls
    // collapse to ONE viewer rather than double-counting the client.
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
    // `<gen>-<seq>.ts` is the video/primary lane (unchanged); `<gen>-a<seq>.ts` is the demuxed audio lane.
    let (lane, seq_s) = match seq_s.strip_prefix('a') {
        Some(rest) => (Lane::Audio, rest),
        None => (Lane::Video, seq_s),
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
    let bytes = match lane {
        Lane::Video => seg.bytes.clone(),
        Lane::Audio => match seg.audio.clone() {
            Some(b) => b,
            // A muxed origin carries no second lane. Only a stale URL from a previous, demuxed session can
            // ask for one, so this is the same class of miss as a stale generation.
            None => {
                log::trace("oop", rid, || format!("segment {file}: this origin carries no audio lane — 404"));
                return crate::proxy::text(404, "not found: lane not carried");
            }
        },
    };
    let n = bytes.len() as u64;
    log::trace("oop", rid, || format!("segment seq={want_seq} lane={lane:?} served from ring ({n} bytes)"));
    // Egress accounting. Ingest bytes are reported separately under kind:"iop" and must never be folded in
    // here — one upstream byte can serve N viewers, so conflating them would over-count by a factor of N.
    state.report(serde_json::json!({
        "kind": "bytes", "source": source, "entryUrl": entry,
        "ip": id.ip, "ua": id.ua, "username": id.username, "bytes": n,
    }));
    crate::proxy::raw(200, "video/mp2t", bytes.to_vec())
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
) -> Option<axum::response::Response> {
    let lease = subscribe(state, source, entry, pl, policy);
    match wait_ready(lease.origin(), rid).await {
        Ready::Yes => {}
        Ready::Ineligible => return None,
        Ready::TimedOut => return Some(crate::proxy::text(503, "stream warming up: no playable window yet")),
    }
    // A demuxed ring holds two elementary streams as two separate transport streams, which do not concatenate
    // — for a long time that made `outputFormat=ts` decline here and fall back to the manifest rewrite, on
    // exactly the source shape the origin exists for. RMX (`tsweave`) closes that: the pair is woven into ONE
    // authored program on the way out, off the same ring the HLS lanes are rendered from.
    let demuxed = lease.origin().demuxed_audio().is_some();
    let buffer_size_kb = policy.buffer_size_kb.load(Ordering::Relaxed);
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(crate::stream::channel_capacity(buffer_size_kb));
    let ctx = TsRingCtx {
        state: state.clone(),
        policy: policy.clone(),
        source: source.to_string(),
        entry: entry.to_string(),
        rid: rid.to_string(),
        ip: id.ip.clone(),
        ua: id.ua.clone(),
        username: id.username.clone(),
    };
    // The LEASE moves into the producer: a continuous stream has no polling to renew it, so the ingest must be
    // held open for the whole session and released exactly when the socket ends.
    //
    // TWO producers rather than one loop with a branch inside it. The muxed one is proven and must keep
    // emitting byte-identical output, so the paired shape gets its own copy — the same posture `LayoutMode`
    // took when the demuxed arms were added, where the muxed predicates were reproduced unchanged rather than
    // relaxed to cover both.
    if demuxed {
        log::info("oop", rid, || {
            "demuxed ring — interleaving both renditions into one raw-TS socket".to_string()
        });
        tokio::spawn(ts_ring_pair_producer(lease, ctx, tx));
    } else {
        tokio::spawn(ts_ring_producer(lease, ctx, tx));
    }
    Some(
        axum::response::Response::builder()
            .status(axum::http::StatusCode::OK)
            .header("content-type", "video/mp2t")
            .header("cache-control", "no-store")
            .body(axum::body::Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)))
            .unwrap(),
    )
}

struct TsRingCtx {
    state: AppState,
    /// Carried so the producer can read `spliceNormalize` per segment, exactly as the ingest does. Without it
    /// the kill switch covered only half its surface — a `outputFormat=ts` viewer kept getting rewritten
    /// segments after the operator turned normalisation off, which is precisely when the switch is being used
    /// to rule the pass in or out of a playback complaint.
    policy: Arc<SourcePolicy>,
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
    // Two paths reach the close emit now — the ingest-stopping `break` and the lane-changed `break 'outer`
    // — so the reason has to be threaded, exactly as the pair producer threads its own.
    let mut close_reason = "ingest_stopped";

    'outer: loop {
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
        // The kill switch, read per segment so a re-resolve flips it live — same contract as the ingest's.
        // OFF serves the ring verbatim, which is the whole point of the switch: it is the operator's way to
        // rule this pass in or out of a playback complaint without a redeploy.
        let normalize = ctx.policy.splice_normalize.load(Ordering::Relaxed);
        if !normalize && splicer.has_timeline() {
            splicer.reset(); // switched off mid-stream: the timeline it was keeping no longer applies
        }
        let mut sent_any = false;
        let from = next_seq; // snapshot: the filter closure borrows it, the body reassigns it
        for seg in window.iter().filter(|s| s.seq >= from) {
            next_seq = seg.seq + 1;
            // THE RING TURNED DEMUXED under this socket. `demuxed` was sampled once, at open (`serve_ts`), so
            // a re-resolve onto a master with a separate audio rendition leaves this producer emitting
            // `seg.bytes` — which is now the VIDEO lane alone. Silent video, for the rest of the session.
            //
            // End the socket, which is the same recovery the pair producer takes on the opposite flip: the
            // client reconnects, `serve_ts` re-reads the flag, and dispatches to `ts_ring_pair_producer`.
            // Unlike a weave decline this needs no cap — an entry carrying an audio lane is not a transient
            // shape, it is the ingest having changed what the ring holds.
            if seg.audio.is_some() {
                log::warn("oop", &ctx.rid, || {
                    format!("ring turned demuxed at seq={} — ending the muxed socket so the client reconnects into the interleaving producer", seg.seq)
                });
                close_reason = "lane_changed";
                break 'outer;
            }
            // Declining is a designed outcome: a segment carrying no PSI, or a program shape the published
            // layout cannot express, is served verbatim. That reinstates the upstream splice for that one
            // segment — a visible glitch — which still beats emitting a stream we mis-rewrote.
            let body = match normalize.then(|| splicer.normalize(&seg.bytes)).flatten() {
                Some(bytes) => Bytes::from(bytes),
                None => {
                    // Only a genuine DECLINE is worth acting on. With the switch off there is nothing to
                    // decline — serving verbatim is the requested behaviour, the guard above already dropped
                    // the timeline once, and warning would send an operator hunting a stream shape that was
                    // never the problem.
                    if normalize {
                        // DROP THE TIMELINE, same as the ingest's identical arm and this producer's own
                        // ring-skip path. The client is about to receive this segment on UPSTREAM timestamps,
                        // so anchoring the NEXT one against the published clock would stamp it behind media
                        // the client already holds — a backwards jump, on a bare TS socket that has no
                        // `#EXT-X-DISCONTINUITY` to explain it. Re-anchoring instead keeps the output
                        // contiguous with what actually went out.
                        splicer.reset();
                        if !warned_splice {
                            warned_splice = true;
                            log::warn("oop", &ctx.rid, || {
                                "splice normalisation declined (no PSI, or a program shape the published \
                                 layout cannot carry) — serving upstream timestamps as-is"
                                    .to_string()
                            });
                        }
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
                ctx.state.report(serde_json::json!({ "kind": "close", "streamId": stream_id, "reason": "client_gone" }));
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
    ctx.state.report(serde_json::json!({ "kind": "close", "streamId": stream_id, "reason": close_reason }));
    log::info("oop", &ctx.rid, || format!("origin raw-TS session close ({stream_id}, {close_reason})"));
}

/// SIDE-2 RAW TS, DEMUXED (S3/RMX): follow the ring, weaving each PAIR into one socket.
///
/// A deliberate sibling of `ts_ring_producer` rather than a branch inside it — the muxed path is proven and
/// must keep emitting byte-identical output. Everything around the per-segment step is the same by design:
/// same lease-held-for-the-session contract, same open/sbytes/close telemetry, same start-at-the-oldest-held
/// join, same fell-behind-the-ring handling, same 30 s park on `wait_for_segment`.
///
/// The step itself is what differs. `tsweave::PairWeaver` is per-SESSION for the same reason the muxed
/// producer's `Splicer` is: a bare TS socket has no `#EXT-X-DISCONTINUITY` to splice with, and two viewers who
/// joined the ring at different points sit at different points on their own output timelines.
async fn ts_ring_pair_producer(
    lease: OriginLease,
    ctx: TsRingCtx,
    tx: tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>,
) {
    let origin = lease.origin().clone();
    let stream_id = ctx.state.next_stream_id();
    log::info("oop", &ctx.rid, || format!("origin raw-TS interleaved session open ({stream_id})"));
    ctx.state.report(serde_json::json!({
        "kind": "open", "streamId": stream_id, "source": ctx.source, "entryUrl": ctx.entry,
        "ip": ctx.ip, "ua": ctx.ua, "username": ctx.username, "playerType": "externalPlayer",
    }));

    // Start at the OLDEST segment held — the ring doubles as the client's initial buffer, exactly as on the
    // muxed path.
    let mut next_seq = origin.window().first().map(|s| s.seq).unwrap_or(0);
    let mut pending_bytes: u64 = 0;
    let mut last_flush = Instant::now();
    let mut weaver = crate::tsweave::PairWeaver::new();
    // Latched per DISTINCT reason, like the ingest's — one latch would hide whether a pod edge declines for
    // the same cause every time (a shape to handle) or a different one each time (a bug in the pass).
    let mut warned_declines: std::collections::HashSet<&'static str> = std::collections::HashSet::new();
    let mut consecutive_declines: u32 = 0;
    let mut warned_switch = false;
    // Two paths reach this producer's close emit — the ingest-stopping `break` and the declines `break 'outer`
    // — so unlike the muxed producer's single-predecessor epilogue, the reason has to be threaded.
    let mut close_reason = "ingest_stopped";

    'outer: loop {
        let window = origin.window();
        // Fell off the back of the ring — same diagnosis and same remedy as the muxed producer.
        if let Some(front) = window.first() {
            if next_seq < front.seq {
                log::warn("oop", &ctx.rid, || {
                    format!("client fell behind the ring (wanted seq={next_seq}, oldest held={}) — skipping ahead; raise originRingMb if this repeats", front.seq)
                });
                next_seq = front.seq;
                // The skipped media is gone, so re-anchor rather than spacing the next pair against a clock
                // whose media the client never received. This also drops the seam carry-over.
                weaver.reset();
            }
        }
        // `spliceNormalize` deliberately does NOT gate this path, and saying so once is the honest thing: it
        // is the kill switch for splice ABSORPTION, but folding two renditions into one program requires
        // authored PSI and a shared clock to exist at all. Turning the weave off means asking for HLS.
        if !ctx.policy.splice_normalize.load(Ordering::Relaxed) && !warned_switch {
            warned_switch = true;
            log::info("oop", &ctx.rid, || {
                "spliceNormalize is off, but interleaving still applies the pid remap and the shared clock — \
                 a single program cannot be authored without them; set outputFormat=hls to publish the two \
                 renditions untouched"
                    .to_string()
            });
        }
        let mut sent_any = false;
        let from = next_seq; // snapshot: the filter closure borrows it, the body reassigns it
        for seg in window.iter().filter(|s| s.seq >= from) {
            next_seq = seg.seq + 1;
            // Unlike the muxed path there is NO serve-verbatim fallback: one transport stream concatenates,
            // two do not. A pair we cannot publish is skipped, which costs one segment of media and keeps the
            // published program stable — the alternative is emitting a stream we mis-authored.
            let woven = seg.audio.as_ref().and_then(|a| weaver.weave(&seg.bytes, a));
            let body = match woven {
                Some(b) => {
                    consecutive_declines = 0;
                    Bytes::from(b)
                }
                None => {
                    // Cause first, message second: the latch keys on the cause, the log prints the message.
                    // The weave's reasons interpolate live measurements, so latching on the text meant every
                    // declined pair minted a new key — a warn per segment, and a set that only grew.
                    let (cause, why) = match seg.audio.as_ref() {
                        Some(_) => (weaver.last_decline_slug(), weaver.last_decline().to_string()),
                        // The origin re-resolved onto a muxed upstream mid-session. Ending on the decline cap
                        // is the recovery: the client reconnects and dispatches to `ts_ring_producer`.
                        None => ("no-audio-lane", "the ring entry carries no audio lane".to_string()),
                    };
                    weaver.reset();
                    consecutive_declines += 1;
                    if warned_declines.insert(cause) {
                        log::warn("oop", &ctx.rid, || {
                            format!("interleave declined — {why}; skipping the pair")
                        });
                    }
                    if consecutive_declines >= MAX_PAIR_DECLINES {
                        log::error("oop", &ctx.rid, || {
                            format!("{consecutive_declines} consecutive pairs declined ({why}) — ending the socket rather than holding it open with no media")
                        });
                        close_reason = "pair_declines";
                        break 'outer;
                    }
                    continue;
                }
            };
            pending_bytes += body.len() as u64;
            sent_any = true;
            if tx.send(Ok(body)).await.is_err() {
                // Client disconnected — the receiver dropped. Close out and release the lease.
                log::info("oop", &ctx.rid, || format!("origin raw-TS interleaved client disconnected ({stream_id})"));
                if pending_bytes > 0 {
                    ctx.state.report(serde_json::json!({ "kind": "sbytes", "streamId": stream_id, "bytes": pending_bytes }));
                }
                ctx.state.report(serde_json::json!({ "kind": "close", "streamId": stream_id, "reason": "client_gone" }));
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
    ctx.state.report(serde_json::json!({ "kind": "close", "streamId": stream_id, "reason": close_reason }));
    log::info("oop", &ctx.rid, || format!("origin raw-TS interleaved session close ({stream_id})"));
}

/// Emit the Side-1 telemetry event. Distinct `kind` from every egress event so Node can attribute ingest
/// health separately — ingest bytes must NEVER be folded into the egress byte counters, or one upstream byte
/// serving N viewers would be counted N+1 times.
fn report_iop(ctx: &IngestCtx, status: &str) {
    // Bound BEFORE the macro: one ring read guard for the four window-derived numbers, and `json!` cannot
    // destructure. Everything else on the frame is a plain atomic load.
    let rs = ctx.origin.ring_stats();
    ctx.state.report(serde_json::json!({
        "kind": "iop",
        "source": ctx.source,
        "entryUrl": ctx.entry,
        "status": status,
        "subscribers": ctx.origin.subscribers.load(Ordering::Relaxed),
        "ringSegments": rs.segments,
        "ringBytes": ctx.origin.ring_bytes.load(Ordering::Relaxed),
        // This channel's LIVE applied cap — the denominator `ringBytes` never had. Deliberately not named
        // `ringCapBytes`: that key is already taken by the process-wide `ring` frame, where it means the Σ of
        // every origin's cap. On a flat, untagged event interface one key must mean one thing.
        "channelRingCapBytes": ctx.origin.ring_cap_bytes.load(Ordering::Relaxed),
        // Σ of the held segments' real durations, not `segments × targetDuration`.
        "ringSeconds": rs.seconds,
        // We are over cap on purpose: the `MIN_SEGMENTS` floor won, i.e. this channel's bitrate does not fit
        // its `originRingMb`. Fill% legitimately exceeds 100 while this is true.
        "floorBeatsCap": rs.floor_beat_cap,
        "headSeq": ctx.origin.next_seq.load(Ordering::Relaxed),
        "generation": ctx.origin.generation(),
        // The two discontinuity counts are DISJOINT: `discSeq` is RFC 8216's
        // `EXT-X-DISCONTINUITY-SEQUENCE` — tags that have already aged out of the window — while
        // `discInWindow` counts the ones still in it. Neither is a lifetime total on its own.
        "discSeq": ctx.origin.disc_seq(),
        "discInWindow": rs.disc_in_window,
        "ingestedSegments": ctx.origin.ingested_segments.load(Ordering::Relaxed),
        "ingestedBytes": ctx.origin.ingested_bytes.load(Ordering::Relaxed),
        "evictedSegments": ctx.origin.evicted_segments.load(Ordering::Relaxed),
        "targetDuration": ctx.origin.target_duration(),
        // The two structural facts that decide whether this origin is authoring output at all. `ineligible`
        // is the reason string set when the origin DECLINED the upstream (fMP4 / SAMPLE-AES / unpairable
        // audio) and the rewrite path took over serving — from Node's side that is indistinguishable from a
        // healthy origin, because the ingest keeps a live `iop` frame either way.
        "demuxed": ctx.origin.demuxed_audio.read_ok().is_some(),
        "ineligible": ctx.origin.ineligible(),
        // What the upstream actually IS, as opposed to what we serve. Null until the first resolve completes.
        "upstreamShape": ctx.origin.upstream_shape.read_ok().clone(),
        "encryption": ctx.origin.encryption.read_ok().clone(),
        // S3/UND: null until an upstream is retired for a structural fault. Present ⇒ this channel has been
        // hopping providers, which every byte-level metric here would otherwise show as perfectly healthy.
        "suspect": ctx.origin.last_suspect.read_ok().clone(),
        "suspectRetires": ctx.origin.suspect_retires.load(Ordering::Relaxed),
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
            audio: None,
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
            pdt_ms: None,
        }
    }

    /// The stale-segment guard has to hold ACROSS incarnations, not just within one.
    ///
    /// A respawned origin used to start at generation 0 with `next_seq` back at 0, so it re-issued the exact
    /// `<gen>-<seq>.ts` names its predecessor had handed out and `serve_segment` answered a stale URL with a
    /// 200 and different media.
    #[test]
    fn two_incarnations_of_a_channel_never_share_a_generation() {
        let first = Origin::new(1000);
        let second = Origin::new(1000);
        assert_ne!(
            first.generation(),
            second.generation(),
            "a respawned origin must not reuse its predecessor's segment-URL namespace"
        );
        // And a reset inside one incarnation still moves it on, which is the guard's original job.
        let before = first.generation();
        first.reset_ring();
        assert!(first.generation() > before, "reset_ring must still advance the generation");
    }

    /// The decline memo is what stops an unringable shape re-resolving on every poll — and the TTL is what
    /// stops it outliving a provider that fixed itself. Nothing sweeps a retained entry (the task that would
    /// have is the one that died), so the age check IS the expiry.
    #[test]
    fn a_decline_memo_expires_so_the_channel_is_retried() {
        let o = Origin::new(1000);
        assert!(!o.declined_recently(), "an origin with no verdict must never read as declined");

        o.mark_ineligible("fMP4 (#EXT-X-MAP) is not concatenable".to_string());
        assert!(o.declined_recently(), "a fresh decline is answered from the memo");

        // Backdate past the TTL: the next subscribe must re-test the upstream rather than trust this.
        *o.ineligible_at.lock_ok() = Some(Instant::now() - INELIGIBLE_MEMO_TTL - Duration::from_secs(1));
        assert!(!o.declined_recently(), "a stale decline must expire so the shape is re-tested");
        assert!(o.ineligible().is_some(), "expiry is about the memo's AGE, not about forgetting the reason");
    }

    #[test]
    fn ring_evicts_oldest_to_stay_under_the_byte_cap() {
        let o = Origin::new(1000); // 1000-byte cap
        for i in 0..10 {
            o.push(seg(i, 200));
        }
        let ring = o.ring.read_ok();
        assert!(o.ring_bytes.load(Ordering::Relaxed) <= 1000, "ring must respect the cap");
        assert_eq!(ring.len(), 5, "1000/200 = 5 segments fit");
        // Oldest evicted first — the window is the TAIL of what was ingested.
        assert_eq!(ring.front().unwrap().seq, 5);
        assert_eq!(ring.back().unwrap().seq, 9);
    }

    // ── demuxed pairing (PDT vs the media-sequence index) ────────────────────────────────────────────────

    /// A media playlist whose segments are dated from `base_ms`, at `media_sequence`.
    fn lane(media_sequence: i64, base_ms: i64, n: usize, dur: f64, dated: bool) -> crate::tsmux::MediaPlaylist {
        let mut body = format!("#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:{media_sequence}\n");
        if dated {
            // Only the head is dated; the rest derive by #EXTINF, exactly as pluto publishes it.
            body.push_str(&format!("#EXT-X-PROGRAM-DATE-TIME:{}\n", fmt_rfc3339(
                SystemTime::UNIX_EPOCH + Duration::from_millis(base_ms as u64),
            )));
        }
        for i in 0..n {
            body.push_str(&format!("#EXTINF:{dur},\nseg{}.ts\n", media_sequence + i as i64));
        }
        crate::tsmux::parse_media_playlist(&body)
    }

    /// THE REGRESSION, reproduced from the live trace: after a pluto session renewal the fresh video playlist
    /// opens at media-sequence 10 while the audio opens at 11 **for the same media**. Index pairing then puts
    /// every pair one segment out; PDT pairing is immune because it dates the media, not the numbering.
    #[test]
    fn a_renumbered_audio_lane_still_pairs_on_program_date_time() {
        const BASE: i64 = 1_786_183_180_000;
        let v = lane(10, BASE, 5, 5.0, true);
        // Same media, same wall clock — but numbered from 11, and the audio ladder is AAC-quantised.
        let a = lane(11, BASE, 5, 4.992, true);

        for (i, vs) in v.segments.iter().enumerate() {
            let useq = v.media_sequence + i as i64;
            match pair_audio(vs, useq, &a) {
                PairPick::Found(p, aseq) => {
                    let d = (p.pdt_ms.unwrap() - vs.pdt_ms.unwrap()).abs();
                    assert!(d < 100, "seq {useq} paired to media {d} ms away — that is a different segment");
                    // The pick must carry the AUDIO lane's own number, not the video's. This is the number
                    // RFC 8216 §5.2 turns into an absent-IV, so borrowing the video's here decrypts the
                    // partner's first CBC block against the wrong IV on exactly the renewal this test models.
                    assert_eq!(
                        aseq,
                        a.media_sequence + i as i64,
                        "seq {useq} paired correctly but reported the wrong media sequence for the partner"
                    );
                    assert_eq!(aseq, useq + 1, "the renumbering must be visible in the reported sequence");
                }
                _ => panic!("seq {useq} failed to pair despite the audio being present"),
            }
        }

        // …and the old key really would have mispaired: index 0 of the audio lane is one segment out.
        let idx = v.media_sequence - a.media_sequence; // -1 → the old code's "audio is ahead" drop
        assert_eq!(idx, -1, "the renumbering is exactly the off-by-one the live trace showed");
    }

    #[test]
    fn an_aligned_pair_picks_the_same_segment_as_the_index_did() {
        // The no-regression case: where the two lanes agree on numbering, PDT pairing must be a no-op.
        const BASE: i64 = 1_786_183_180_000;
        let v = lane(40, BASE, 5, 5.0, true);
        let a = lane(40, BASE, 5, 4.992, true);
        for (i, vs) in v.segments.iter().enumerate() {
            let useq = v.media_sequence + i as i64;
            let by_pdt = match pair_audio(vs, useq, &a) {
                PairPick::Found(p, aseq) => {
                    // Aligned lanes: the reported sequence must be the video's, which is what makes passing
                    // `upstream_seq` to the audio fetch correct on every source that pairs by index.
                    assert_eq!(aseq, useq, "an aligned lane must report the same sequence");
                    p.uri.clone()
                }
                _ => panic!("aligned pair must resolve"),
            };
            let by_index = a.segments[(useq - a.media_sequence) as usize].uri.clone();
            assert_eq!(by_pdt, by_index, "seq {useq}: PDT and index must agree on an aligned source");
        }
    }

    #[test]
    fn a_lane_without_program_date_time_falls_back_to_the_index() {
        // A source that publishes no PDT must behave exactly as before this change.
        let v = lane(10, 0, 3, 5.0, false);
        let a = lane(10, 0, 3, 5.0, false);
        match pair_audio(&v.segments[1], 11, &a) {
            PairPick::Found(p, aseq) => {
                assert_eq!(p.uri, "seg11.ts", "index pairing still selects positionally");
                assert_eq!(aseq, 11, "the fallback reports the index it selected on");
            }
            _ => panic!("the fallback must still pair"),
        }
        // …including its rolled-past arm.
        assert!(matches!(pair_audio(&v.segments[0], 9, &a), PairPick::RolledPast));
    }

    #[test]
    fn an_audio_lane_that_has_not_caught_up_holds_rather_than_mispairs() {
        // The video is ahead of everything the audio has published: HOLD, so the pair completes next poll.
        const BASE: i64 = 1_786_183_180_000;
        let v = lane(10, BASE + 60_000, 2, 5.0, true);
        let a = lane(10, BASE, 3, 5.0, true);
        assert!(matches!(pair_audio(&v.segments[0], 10, &a), PairPick::NotYet));

        // …and the mirror image: the audio window has rolled past, so the pair can never complete.
        let v2 = lane(10, BASE, 2, 5.0, true);
        let a2 = lane(10, BASE + 60_000, 3, 5.0, true);
        assert!(matches!(pair_audio(&v2.segments[0], 10, &a2), PairPick::RolledPast));
    }

    #[test]
    fn the_tolerance_separates_aac_jitter_from_a_whole_segment_out() {
        // Measured live: a healthy pluto pair agrees to ~20 ms, a mispair is ~5000 ms. The tolerance has to
        // sit well clear of both.
        let tol = pair_tolerance_ms(5.0, 5.0);
        assert_eq!(tol, 2_500);
        assert!(tol > 20 * 10, "AAC's ~21 ms quantisation is far inside tolerance");
        assert!(tol < 5_000 / 2 + 1, "a whole segment out is far outside it");
        // No ladder at all still yields a usable tolerance rather than zero.
        assert!(pair_tolerance_ms(0.0, 0.0) > 0);
    }

    #[test]
    fn min_segments_floor_beats_the_byte_cap() {
        // Each segment alone blows the cap — without the floor the ring would hold 1 and be unplayable.
        let o = Origin::new(100);
        for i in 0..6 {
            o.push(seg(i, 10_000));
        }
        assert_eq!(o.ring_depth(), MIN_SEGMENTS, "floor holds a playable window");
        assert!(o.floor_beat_cap(), "and reports that the cap could not be honored");
        assert!(o.ring_bytes.load(Ordering::Relaxed) > 100);
    }

    #[test]
    fn cap_is_honored_when_bitrate_fits_so_no_floor_warning() {
        let o = Origin::new(10_000);
        for i in 0..20 {
            o.push(seg(i, 500));
        }
        assert!(o.ring_depth() > MIN_SEGMENTS);
        assert!(!o.floor_beat_cap(), "a fitting bitrate must not warn");
    }

    #[test]
    fn ring_footprint_sums_the_registry_and_counts_only_subscribed_origins() {
        let watched = Arc::new(Origin::new(10_000));
        let idle = Arc::new(Origin::new(4_000));
        for i in 0..3 {
            watched.push(seg(i, 500)); // 1500 bytes, under its cap
            idle.push(seg(i, 200)); // 600 bytes, under its cap
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
            o.push(seg(s as usize, 100));
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
            pdt_ms: None,
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
            pdt_ms: None,
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
                    audio: None,
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
            Lane::Video,
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

    // ── demuxed rendering ────────────────────────────────────────────────────────────────────────────────

    fn render_lane(w: &[Arc<Segment>], lane: Lane) -> String {
        render_media_playlist(w, 5.0, "/api/ext/v1", "pluto", "pluto://us_east/abc", 3, Some("tok123"), Some("pl1"), 9, lane)
    }

    /// THE rendering invariant: one window, two renderings. hls.js aligns renditions by (media sequence,
    /// discontinuity sequence) and interpolates within a PDT anchor, so any disagreement between the two
    /// documents would place the audio on a different timeline from the video.
    #[test]
    fn both_lanes_render_identically_apart_from_the_segment_uris() {
        let w = window(4, &[2]);
        let strip = |m: String| {
            m.lines().filter(|l| !l.contains("/o/")).map(|l| l.to_string()).collect::<Vec<_>>().join("\n")
        };
        assert_eq!(
            strip(render_lane(&w, Lane::Video)),
            strip(render_lane(&w, Lane::Audio)),
            "sequence, discontinuity positions, PDT anchors and #EXTINF must be identical"
        );
        let v: Vec<String> = render_lane(&w, Lane::Video).lines().filter(|l| l.contains("/o/")).map(String::from).collect();
        let a: Vec<String> = render_lane(&w, Lane::Audio).lines().filter(|l| l.contains("/o/")).map(String::from).collect();
        assert_eq!(v.len(), a.len());
        assert!(v[0].contains("/o/") && v[0].contains("/3-100.ts"), "the video lane's shape is unchanged: {}", v[0]);
        assert!(a[0].contains("/3-a100.ts"), "the audio lane carries the `a` marker: {}", a[0]);
    }

    #[test]
    fn the_authored_master_points_only_at_our_own_playlists() {
        let m = render_master(
            "/api/ext/v1",
            "pluto",
            "pluto://us_east/abc",
            &DemuxedMaster {
                audio: crate::tsmux::AudioRendition {
                    group: "audio".into(),
                    url: Url::parse("https://siloh-ns1.plutotv.net/live/audio/audio.m3u8").unwrap(),
                    name: "English [Original]".into(),
                    language: "en".into(),
                    default: true,
                    autoselect: true,
                    describes_video: false,
                },
                bandwidth: 3_321_280,
            },
            Some("tok123"),
            Some("pl1"),
        );
        // The same "clean" contract the media playlists are held to: no upstream host, no vendor tag, no hop.
        assert!(!m.contains("plutotv.net"), "no upstream host may leak into the authored master:\n{m}");
        assert!(!m.contains("/h/"), "no hop URIs");
        assert!(m.contains("#EXT-X-VERSION:4"), "#EXT-X-MEDIA is a version-4 tag");
        assert!(m.contains("BANDWIDTH=3321280"), "RFC 8216 makes BANDWIDTH required");
        assert!(m.contains("LANGUAGE=\"en\""), "upstream's own labelling is carried through");
        assert!(m.contains("/o/") && m.contains("/a.m3u8?token=tok123&pl=pl1"), "audio rendition is ours:\n{m}");
        assert!(m.contains("/v.m3u8?token=tok123&pl=pl1"), "so is the variant:\n{m}");
        // The generation must NOT appear: the master is fetched once and the playlists polled forever, so a
        // ring reset would otherwise 404 the live session permanently.
        assert!(!m.contains("/3-"), "no generation in a playlist path:\n{m}");
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
            o.push(s);
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
            o.push(s);
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
        let m = render_media_playlist(&window(2, &[]), 5.0, "/api/ext/v1", "s", "e", 0, None, None, 42, Lane::Video);
        assert!(m.contains("#EXT-X-DISCONTINUITY-SEQUENCE:42"));
    }

    #[test]
    fn target_duration_is_an_integer_ceiling_of_the_longest_segment() {
        // A playlist whose TARGETDURATION is below any #EXTINF is rejected by players.
        let mut w = window(2, &[]);
        w[1] = Arc::new(Segment { duration: 5.005, ..(*w[1]).clone() });
        let m = render_media_playlist(&w, 5.0, "/api/ext/v1", "s", "e", 0, None, None, 0, Lane::Video);
        assert!(m.contains("#EXT-X-TARGETDURATION:6"), "must ceil above the longest EXTINF");
    }

    #[test]
    fn generation_appears_in_segment_paths_so_stale_urls_can_404() {
        let m = render_media_playlist(&window(1, &[]), 5.0, "/api/ext/v1", "s", "e", 7, None, None, 0, Lane::Video);
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
