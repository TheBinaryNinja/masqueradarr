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
    SegRef,
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
        }
    }

    /// Append a segment and evict from the front until the ring fits its byte cap.
    ///
    /// Returns how many segments were evicted. The `MIN_SEGMENTS` floor is enforced HERE rather than by the
    /// caller because it is a property of the window, not of any one push: dropping below it produces a
    /// manifest no player will start, which is worse than briefly exceeding the RAM cap.
    fn push(&self, seg: Segment) -> usize {
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
        ring.clear();
        self.ring_bytes.store(0, Ordering::Relaxed);
        self.generation.fetch_add(1, Ordering::Relaxed);
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
                let resolved = resolve_media(&ctx, &rid).await;
                // A fresh resolve may point at a different upstream; the previous window's bytes are from a
                // different timeline, so drop them rather than splice silently.
                if resolved.is_some() && ctx.origin.ring_depth() > 0 {
                    ctx.origin.reset_ring();
                    prev = PrevSeg::default();
                    next_upstream_seq = -1;
                    log::info("iop", &rid, || {
                        format!("ring reset on re-resolve (generation={})", ctx.origin.generation())
                    });
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

        let mut ingested_this_poll = 0u32;
        for (i, seg) in mp.segments.iter().enumerate() {
            if ctx.origin.stopping.load(Ordering::Relaxed) {
                break;
            }
            let upstream_seq = mp.media_sequence + i as i64;
            if upstream_seq < next_upstream_seq {
                continue; // already ingested
            }
            next_upstream_seq = upstream_seq + 1;

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

            let boundary = boundary_before(&prev, seg, upstream_seq);

            let plain = match fetch_segment(&ctx, &rid, &client, &policy, &media_url, seg, &seg_url, upstream_seq, read_timeout_ms, &mut key_cache).await {
                Some(b) => b,
                None => continue, // a gap: the NEXT ingested segment will see the sequence jump and splice
            };

            // Snapshot what the boundary was decided AGAINST, before `prev` is overwritten — a splice log
            // naming only the trigger cannot distinguish real churn from a detector bug (that is how the two
            // removed URL heuristics were caught).
            let was = prev.clone();
            prev = PrevSeg { upstream_seq: Some(upstream_seq) };

            let our_seq = ctx.origin.next_seq.fetch_add(1, Ordering::Relaxed);
            let evicted = ctx.origin.push(Segment {
                seq: our_seq,
                duration: if seg.duration > 0.0 { seg.duration } else { mp.target_duration },
                bytes: plain,
                discontinuity: boundary.is_some(),
                pdt: SystemTime::now(),
            });
            ingested_this_poll += 1;
            if let Some(b) = boundary {
                log::info("iop", &rid, || {
                    let detail = match b {
                        Boundary::SequenceGap => format!(
                            "upstream seq {} → {upstream_seq}",
                            was.upstream_seq.map(|s| s.to_string()).unwrap_or_else(|| "-".into())
                        ),
                        Boundary::Tag => "upstream #EXT-X-DISCONTINUITY".to_string(),
                    };
                    format!("discontinuity ({b:?}) at our seq={our_seq} — {detail}")
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

        if ingested_this_poll > 0 {
            empty_polls = 0;
            report_iop(&ctx, "ok");
        } else {
            empty_polls += 1;
            if empty_polls >= MAX_EMPTY_POLLS {
                log::warn("iop", &rid, || {
                    format!("{MAX_EMPTY_POLLS} empty polls — re-resolving {}/{}", ctx.source, crate::proxy::host_of(&ctx.entry))
                });
                report_iop(&ctx, "stalled");
                empty_polls = 0;
                media = None;
                continue;
            }
        }

        if mp.endlist {
            log::info("iop", &rid, || "upstream #EXT-X-ENDLIST — ingest complete".to_string());
            break;
        }

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
async fn resolve_media(ctx: &IngestCtx, rid: &str) -> Option<MediaSource> {
    let (policy, target) = ctx
        .state
        .resolve_fresh(&ctx.source, &ctx.entry, ctx.pl.as_deref())
        .await
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
/// continuous encode, and unlike HLS it carries no splice signal we could honestly propagate.
fn push_cut(ctx: &IngestCtx, cut: crate::tsseg::CutSegment) {
    let our_seq = ctx.origin.next_seq.fetch_add(1, Ordering::Relaxed);
    ctx.origin.push(Segment {
        seq: our_seq,
        duration: cut.duration,
        bytes: Bytes::from(cut.bytes),
        discontinuity: false,
        pdt: SystemTime::now(),
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
    if let Some(first) = window.first() {
        out.push_str(&format!("#EXT-X-PROGRAM-DATE-TIME:{}\n", fmt_rfc3339(first.pdt)));
    }
    let enc_entry = crate::manifest::enc(entry);
    for seg in window {
        // A splice inside the window is signalled, not hidden — that is L1 by decision: "clean" means no
        // visible origin/encryption/hops, not a single unbroken timeline. Players handle this tag correctly.
        if seg.discontinuity {
            out.push_str("#EXT-X-DISCONTINUITY\n");
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
            }
        }
        let mut sent_any = false;
        let from = next_seq; // snapshot: the filter closure borrows it, the body reassigns it
        for seg in window.iter().filter(|s| s.seq >= from) {
            next_seq = seg.seq + 1;
            pending_bytes += seg.bytes.len() as u64;
            sent_any = true;
            if tx.send(Ok(seg.bytes.clone())).await.is_err() {
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
        }
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
        assert_eq!(m.matches("#EXT-X-DISCONTINUITY").count(), 1);
        let lines: Vec<&str> = m.lines().collect();
        let i = lines.iter().position(|l| *l == "#EXT-X-DISCONTINUITY").unwrap();
        assert!(lines[i + 1].starts_with("#EXTINF:"));
        assert!(lines[i + 2].contains("/0-101.ts"));
    }

    #[test]
    fn target_duration_is_an_integer_ceiling_of_the_longest_segment() {
        // A playlist whose TARGETDURATION is below any #EXTINF is rejected by players.
        let mut w = window(2, &[]);
        w[1] = Arc::new(Segment { duration: 5.005, ..(*w[1]).clone() });
        let m = render_media_playlist(&w, 5.0, "/api/ext/v1", "s", "e", 0, None, None);
        assert!(m.contains("#EXT-X-TARGETDURATION:6"), "must ceil above the longest EXTINF");
    }

    #[test]
    fn generation_appears_in_segment_paths_so_stale_urls_can_404() {
        let m = render_media_playlist(&window(1, &[]), 5.0, "/api/ext/v1", "s", "e", 7, None, None);
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
