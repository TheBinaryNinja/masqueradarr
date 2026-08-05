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
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::Notify;
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
    /// Emit `#EXT-X-DISCONTINUITY` BEFORE this segment. Set from any of the three upstream signals — see
    /// `boundary_before`.
    pub discontinuity: bool,
    /// Ingest wall-clock → the renderer's `#EXT-X-PROGRAM-DATE-TIME`.
    pub pdt: SystemTime,
}

/// Why a segment is a splice point. Kept as a named enum rather than a bare bool so the `iop` log can say
/// WHICH signal fired — with pluto the answer is almost always `ClipChange`, and knowing that distinguishes
/// "ads rolling normally" from "upstream is renumbering under us".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Boundary {
    /// The upstream playlist carried an explicit `#EXT-X-DISCONTINUITY`.
    Tag,
    /// The media sequence skipped — we missed segments (a slow poll, or the window slid past us).
    SequenceGap,
    /// The segment's directory or its key changed: an ad/clip splice. The reliable pluto signal, since its
    /// stitcher swaps both the clip path and the keyfile at every boundary but does not always tag it.
    ClipChange,
}

/// What the previous ingested segment looked like, for boundary detection against the next one.
#[derive(Clone, Debug, Default)]
struct PrevSeg {
    upstream_seq: Option<i64>,
    dir: Option<String>,
    key_uri: Option<String>,
}

/// Decide whether `seg` (at upstream sequence `upstream_seq`) starts a new continuity region.
///
/// Pure so it can be tested without a network: the three triggers are exactly the ones that show up in real
/// playlists, and each is independently sufficient.
fn boundary_before(prev: &PrevSeg, seg: &SegRef, upstream_seq: i64, seg_url: Option<&Url>) -> Option<Boundary> {
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
    let dir = seg_url.map(dir_of);
    // First segment ever (prev.dir None) is not a boundary — the ring simply starts there.
    if let (Some(pd), Some(d)) = (prev.dir.as_deref(), dir.as_deref()) {
        if pd != d {
            return Some(Boundary::ClipChange);
        }
    }
    let key_uri = seg.key.as_ref().map(|k| k.uri.as_str());
    if prev.key_uri.as_deref() != key_uri && prev.key_uri.is_some() {
        return Some(Boundary::ClipChange);
    }
    None
}

/// The directory portion of a segment URL — everything up to the last '/'. Pluto swaps this per clip.
fn dir_of(u: &Url) -> String {
    let s = u.path();
    match s.rfind('/') {
        Some(i) => format!("{}{}", u.host_str().unwrap_or(""), &s[..i]),
        None => u.host_str().unwrap_or("").to_string(),
    }
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
                log::info("iop", &rid, || format!("ingest idle {}/{} — stopping", ctx.source, ctx.source));
                break;
            }
        }

        // (Re)resolve whenever we have no media playlist to follow — first pass, or after a persistent failure.
        let (media_url, media_body) = match media.take() {
            Some(m) => m,
            None => match resolve_media(&ctx, &rid).await {
                Some(m) => {
                    // A fresh resolve may point at a different upstream; the previous window's bytes are from a
                    // different timeline, so drop them rather than splice silently.
                    if ctx.origin.ring_depth() > 0 {
                        ctx.origin.reset_ring();
                        prev = PrevSeg::default();
                        next_upstream_seq = -1;
                        log::info("iop", &rid, || {
                            format!("ring reset on re-resolve (generation={})", ctx.origin.generation())
                        });
                    }
                    m
                }
                None => {
                    report_iop(&ctx, "resolve_failed");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            },
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

            let boundary = boundary_before(&prev, seg, upstream_seq, Some(&seg_url));

            let plain = match fetch_segment(&ctx, &rid, &client, &policy, &media_url, seg, &seg_url, upstream_seq, read_timeout_ms, &mut key_cache).await {
                Some(b) => b,
                None => continue, // a gap: the NEXT ingested segment will see the sequence jump and splice
            };

            prev = PrevSeg {
                upstream_seq: Some(upstream_seq),
                dir: Some(dir_of(&seg_url)),
                key_uri: seg.key.as_ref().map(|k| k.uri.clone()),
            };

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
                log::info("iop", &rid, || format!("discontinuity ({b:?}) at our seq={our_seq}"));
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
async fn resolve_media(ctx: &IngestCtx, rid: &str) -> Option<(Url, String)> {
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
    let body = resp.text().await.ok()?;

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
    Some((media_url, media_body))
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
        let prev = PrevSeg {
            upstream_seq: Some(9),
            dir: Some("h/a".to_string()),
            key_uri: None,
        };
        let u = Url::parse("https://h/a/s10.ts").unwrap();
        assert_eq!(
            boundary_before(&prev, &segref("s10.ts", None, true), 10, Some(&u)),
            Some(Boundary::Tag)
        );
    }

    #[test]
    fn boundary_detects_sequence_gap() {
        let prev = PrevSeg {
            upstream_seq: Some(9),
            dir: Some("h/a".to_string()),
            key_uri: None,
        };
        let u = Url::parse("https://h/a/s12.ts").unwrap();
        // 9 → 12 means we never ingested 10 and 11, so the bytes are not contiguous.
        assert_eq!(
            boundary_before(&prev, &segref("s12.ts", None, false), 12, Some(&u)),
            Some(Boundary::SequenceGap)
        );
    }

    #[test]
    fn boundary_detects_clip_change_by_path_or_key() {
        let prev = PrevSeg {
            upstream_seq: Some(9),
            dir: Some("h/clipA".to_string()),
            key_uri: Some("https://k/a.key".to_string()),
        };
        // Directory changed (pluto swaps the clip path at every ad boundary) — contiguous sequence, still a splice.
        let u = Url::parse("https://h/clipB/s10.ts").unwrap();
        assert_eq!(
            boundary_before(&prev, &segref("s10.ts", Some("https://k/a.key"), false), 10, Some(&u)),
            Some(Boundary::ClipChange)
        );
        // Same directory but a rotated keyfile is also a splice.
        let u2 = Url::parse("https://h/clipA/s10.ts").unwrap();
        assert_eq!(
            boundary_before(&prev, &segref("s10.ts", Some("https://k/b.key"), false), 10, Some(&u2)),
            Some(Boundary::ClipChange)
        );
    }

    #[test]
    fn contiguous_same_clip_is_not_a_boundary() {
        let prev = PrevSeg {
            upstream_seq: Some(9),
            dir: Some("h/clipA".to_string()),
            key_uri: Some("https://k/a.key".to_string()),
        };
        let u = Url::parse("https://h/clipA/s10.ts").unwrap();
        assert_eq!(
            boundary_before(&prev, &segref("s10.ts", Some("https://k/a.key"), false), 10, Some(&u)),
            None
        );
    }

    #[test]
    fn first_segment_ever_is_not_a_boundary() {
        // A cold ring has no previous segment — starting is not a splice.
        let u = Url::parse("https://h/clipA/s0.ts").unwrap();
        assert_eq!(
            boundary_before(&PrevSeg::default(), &segref("s0.ts", None, false), 0, Some(&u)),
            None
        );
    }
}
