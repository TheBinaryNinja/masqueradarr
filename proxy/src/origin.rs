
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
use crate::state::{AppState, ResolveErr, SourcePolicy};
use crate::sync::{LockExt, RwExt};
use crate::tsmux::{
    decrypt_aes128_cbc, encryption_method, has_map, is_master, parse_media_playlist, pick_variant, poll_interval,
    unsupported_encryption, CueKind, SegRef,
};

pub const DEFAULT_RING_MB: u64 = 25;

const MIN_SEGMENTS: usize = 3;

const IDLE_GRACE: Duration = Duration::from_secs(30);

const INELIGIBLE_MEMO_TTL: Duration = Duration::from_secs(60);

const IDLE_TICK: Duration = Duration::from_secs(5);

const MAX_EMPTY_POLLS: u32 = 5;

const MEDIA_FAIL_ESCALATE: u32 = 2;

const FAILURE_BACKOFF_BASE: Duration = Duration::from_secs(2);
const FAILURE_BACKOFF_CAP: Duration = Duration::from_secs(60);

const PROACTIVE_REFRESH_LEAD: Duration = Duration::from_secs(60);

#[cfg(not(test))]
const MIN_PROACTIVE_REFRESH: Duration = Duration::from_secs(30);
#[cfg(test)]
const MIN_PROACTIVE_REFRESH: Duration = Duration::from_millis(400);

#[cfg(not(test))]
const PROACTIVE_RETRY: Duration = Duration::from_secs(15);
#[cfg(test)]
const PROACTIVE_RETRY: Duration = Duration::from_millis(400);

const MAX_CONTINUITY_GAP: i64 = 30;

const MIN_INGEST_IO: Duration = Duration::from_secs(10);

const MAX_INGEST_IO_TD_SECS: f64 = 120.0;

const UNDECODABLE_STRIKES: u32 = 3;

const UNDECODABLE_PROBE_SEGMENTS: u32 = 6;

const MAX_PAIR_DECLINES: u32 = 3;

const RECENT_URI_MEMORY: usize = 64;

#[derive(Clone, Debug)]
pub struct Segment {
    pub seq: u64,
    pub duration: f64,
    pub bytes: Bytes,
    pub discontinuity: bool,
    pub pdt: SystemTime,
    pub audio: Option<Bytes>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Boundary {
    Tag,
    SequenceGap,
    SessionRenewal,
    Reset,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Rejoin {
    Anchor,
    Renewal,
    Continue,
    Reset,
}

fn rejoin(
    renewing: bool,
    retired: bool,
    same_timeline: bool,
    ring_depth: usize,
    next_upstream_seq: i64,
    window: Option<(i64, usize)>,
) -> Rejoin {
    if ring_depth == 0 {
        return Rejoin::Anchor;
    }
    if renewing {
        return Rejoin::Renewal;
    }
    match window {
        Some((ms, len)) if !retired && same_timeline && next_upstream_seq >= 0 && window_continues(next_upstream_seq, ms, len) => {
            Rejoin::Continue
        }
        _ => Rejoin::Reset,
    }
}

fn overlap_evidence(ingested: &VecDeque<(i64, String)>, base: &Url, window: &crate::tsmux::MediaPlaylist) -> Option<bool> {
    let mut agreed = None;
    for (i, seg) in window.segments.iter().enumerate() {
        let seq = window.media_sequence + i as i64;
        let Some((_, held)) = ingested.iter().find(|(s, _)| *s == seq) else { continue };
        let listed = base.join(&seg.uri).ok();
        if listed.as_ref().map(Url::path) != Some(held.as_str()) {
            return Some(false);
        }
        agreed = Some(true);
    }
    agreed
}

fn window_continues(next: i64, ms: i64, len: usize) -> bool {
    let end = ms.saturating_add(len as i64);
    if ms <= next {
        next <= end
    } else {
        ms - next <= MAX_CONTINUITY_GAP
    }
}

fn publishes_discontinuity(boundary: Option<Boundary>, absorbed: bool, joined: bool) -> bool {
    if absorbed && joined {
        false
    } else {
        boundary.is_some()
    }
}

#[derive(Debug, Default)]
struct Backoff {
    failures: u32,
}

impl Backoff {
    fn fail(&mut self) -> Duration {
        self.failures = self.failures.saturating_add(1);
        match self.failures {
            0 | 1 => Duration::ZERO,
            n => FAILURE_BACKOFF_BASE.saturating_mul(1u32 << (n - 2).min(16)).min(FAILURE_BACKOFF_CAP),
        }
    }

    fn succeed(&mut self) {
        self.failures = 0;
    }

    fn fail_walk(&mut self, walk_wrapped: bool) -> Duration {
        let wait = self.fail();
        if walk_wrapped {
            wait
        } else {
            wait.min(FAILURE_BACKOFF_BASE)
        }
    }
}

async fn back_off(rid: &str, wait: Duration, failures: u32) {
    if wait.is_zero() {
        return;
    }
    log::info("iop", rid, || format!("{failures} consecutive failure(s) — next attempt in {}s", wait.as_secs()));
    tokio::time::sleep(wait).await;
}

fn proactive_refresh_at(expires_at_ms: u64, now_ms: u64, now: Instant) -> Option<Instant> {
    let left = Duration::from_millis(expires_at_ms.saturating_sub(now_ms));
    now.checked_add(left.saturating_sub(PROACTIVE_REFRESH_LEAD).max(MIN_PROACTIVE_REFRESH))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct IngestIo {
    header_ms: u64,
    body: Duration,
}

fn ingest_io(read_timeout_ms: u64, target_duration: f64) -> IngestIo {
    let td = if target_duration.is_finite() && target_duration > 0.0 {
        (target_duration * 3.0).min(MAX_INGEST_IO_TD_SECS)
    } else {
        0.0
    };
    let body = Duration::from_millis(read_timeout_ms).max(Duration::from_secs_f64(td)).max(MIN_INGEST_IO);
    let header_ms = if read_timeout_ms > 0 { read_timeout_ms } else { body.as_millis() as u64 };
    IngestIo { header_ms, body }
}

async fn read_text(resp: reqwest::Response, within: Duration) -> Option<String> {
    tokio::time::timeout(within, resp.text()).await.ok()?.ok()
}

#[derive(Clone, Debug, Default)]
struct PrevSeg {
    upstream_seq: Option<i64>,
}

fn boundary_before(prev: &PrevSeg, seg: &SegRef, upstream_seq: i64) -> Option<Boundary> {
    if seg.discontinuity {
        return Some(Boundary::Tag);
    }
    if let Some(p) = prev.upstream_seq {
        if upstream_seq != p + 1 {
            return Some(Boundary::SequenceGap);
        }
    }
    None
}

fn endlist_is_terminal(prev: Option<&Vec<String>>, cur: &[String]) -> bool {
    !cur.is_empty() && prev.is_some_and(|p| p.as_slice() == cur)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdSignal {
    CueTag,
    DateRange,
    UriSignature,
}

fn ad_signal(seg: &SegRef, seg_url: &Url, ad_uri_contains: &[String]) -> Option<AdSignal> {
    if let Some(cue) = seg.cue {
        return Some(match cue.kind {
            CueKind::CueOut => AdSignal::CueTag,
            CueKind::DateRange => AdSignal::DateRange,
        });
    }
    if ad_uri_contains.is_empty() {
        return None;
    }
    let decoded = percent_decode_str(seg_url.as_str()).decode_utf8_lossy().to_lowercase();
    ad_uri_contains
        .iter()
        .any(|p| decoded.contains(p))
        .then_some(AdSignal::UriSignature)
}

#[derive(Clone, Debug)]
struct AdBreak {
    id: u64,
    signal: AdSignal,
    segments: u32,
    seconds: f64,
    announced: f64,
    profile_changed: bool,
}

pub struct Origin {
    ring: RwLock<VecDeque<Arc<Segment>>>,
    ring_bytes: AtomicU64,
    next_seq: AtomicU64,
    generation: AtomicU64,
    subscribers: AtomicU32,
    last_access: Mutex<Instant>,
    target_duration_ms: AtomicU64,
    ring_cap_bytes: AtomicU64,
    stopping: AtomicBool,
    notify: Notify,
    ingested_segments: AtomicU64,
    ingested_bytes: AtomicU64,
    evicted_segments: AtomicU64,
    disc_seq: AtomicU64,
    ineligible: RwLock<Option<String>>,
    ineligible_at: Mutex<Option<Instant>>,
    demuxed_audio: RwLock<Option<DemuxedMaster>>,
    last_entry_master: RwLock<Option<bool>>,
    last_suspect: RwLock<Option<String>>,
    suspect_retires: AtomicU32,
    upstream_shape: RwLock<Option<String>>,
    encryption: RwLock<Option<String>>,
    segment_wrapper: RwLock<Option<String>>,
    refused: RwLock<Option<String>>,
}

#[derive(Clone)]
pub struct DemuxedMaster {
    pub audio: crate::tsmux::AudioRendition,
    pub bandwidth: i64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lane {
    Video,
    Audio,
}

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
            segment_wrapper: RwLock::new(None),
            refused: RwLock::new(None),
        }
    }

    fn unwrap_disguise(&self, body: Bytes) -> (Bytes, Option<(&'static str, usize)>) {
        let Some(n) = crate::tsseg::disguise_prefix_len(&body) else {
            return (body, None);
        };
        let label = crate::tsseg::disguise_label(&body);
        let first = self.segment_wrapper.read_ok().as_deref() != Some(label);
        if first {
            *self.segment_wrapper.write_ok() = Some(label.to_string());
        }
        (body.slice(n..), first.then_some((label, n)))
    }

    fn demuxed_audio(&self) -> Option<DemuxedMaster> {
        self.demuxed_audio.read_ok().clone()
    }

    fn touch(&self) {
        *self.last_access.lock_ok() = Instant::now();
    }

    fn ineligible(&self) -> Option<String> {
        self.ineligible.read_ok().clone()
    }

    fn mark_ineligible(&self, reason: String) {
        *self.ineligible.write_ok() = Some(reason);
        *self.ineligible_at.lock_ok() = Some(Instant::now());
        self.notify.notify_waiters();
    }

    fn refused(&self) -> Option<String> {
        self.refused.read_ok().clone()
    }

    fn mark_refused(&self, why: String) {
        *self.refused.write_ok() = Some(why);
        self.notify.notify_waiters();
    }

    fn declined_recently(&self) -> bool {
        self.ineligible.read_ok().is_some()
            && self.ineligible_at.lock_ok().is_some_and(|t| t.elapsed() < INELIGIBLE_MEMO_TTL)
    }

    fn push(&self, seg: Segment) -> usize {
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

    fn floor_beat_cap(&self) -> bool {
        let ring = self.ring.read_ok();
        ring.len() <= MIN_SEGMENTS && self.ring_bytes.load(Ordering::Relaxed) > self.ring_cap_bytes.load(Ordering::Relaxed)
    }

    fn reset_ring(&self) {
        let mut ring = self.ring.write_ok();
        let leaving = ring.iter().filter(|s| s.discontinuity).count() as u64;
        self.disc_seq.fetch_add(leaving, Ordering::Relaxed);
        ring.clear();
        self.ring_bytes.store(0, Ordering::Relaxed);
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    fn disc_seq(&self) -> u64 {
        self.disc_seq.load(Ordering::Relaxed)
    }

    #[allow(dead_code)]
    pub fn window(&self) -> Vec<Arc<Segment>> {
        *self.last_access.lock_ok() = Instant::now();
        self.ring.read_ok().iter().cloned().collect()
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    pub fn target_duration(&self) -> f64 {
        self.target_duration_ms.load(Ordering::Relaxed) as f64 / 1000.0
    }

    #[allow(dead_code)]
    pub async fn wait_for_segment(&self) {
        self.notify.notified().await;
    }

    fn idle(&self) -> bool {
        self.subscribers.load(Ordering::Relaxed) == 0 && self.last_access.lock_ok().elapsed() >= IDLE_GRACE
    }

    fn ring_depth(&self) -> usize {
        self.ring.read_ok().len()
    }

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

struct RingStats {
    segments: usize,
    seconds: f64,
    disc_in_window: usize,
    floor_beat_cap: bool,
}

pub struct OriginLease {
    origin: Arc<Origin>,
}

impl OriginLease {
    #[allow(dead_code)]
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

pub fn subscribe(state: &AppState, source: &str, entry: &str, pl: Option<&str>, policy: &Arc<SourcePolicy>) -> OriginLease {
    let key = crate::state::target_key(source, entry);
    let cap = policy.origin_ring_mb.load(Ordering::Relaxed).saturating_mul(1024 * 1024);
    let (origin, start) = {
        let mut map = state.origins().lock_ok();
        match map.get(&key) {
            Some(o) if !o.stopping.load(Ordering::Relaxed) => {
                o.ring_cap_bytes.store(cap, Ordering::Relaxed);
                (o.clone(), false)
            }
            Some(o) if o.declined_recently() => (o.clone(), false),
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

struct IngestGuard {
    ctx: IngestCtx,
    rid: String,
}

impl Drop for IngestGuard {
    fn drop(&mut self) {
        self.ctx.origin.stopping.store(true, Ordering::Relaxed);
        self.ctx.origin.notify.notify_waiters();
        if self.ctx.origin.ineligible().is_some() {
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

async fn ingest(ctx: IngestCtx) {
    let rid = format!("iop{}", ctx.state.next_stream_id());
    log::info("iop", &rid, || {
        format!("ingest start {}/{}", ctx.source, crate::proxy::host_of(&ctx.entry))
    });
    let _guard = IngestGuard { ctx: ctx.clone(), rid: rid.clone() };

    let mut prev = PrevSeg::default();
    let mut next_upstream_seq: i64 = -1;
    let mut empty_polls: u32 = 0;
    let mut key_cache: Option<(String, [u8; 16])> = None;
    let mut audio_key_cache: Option<(String, [u8; 16])> = None;
    let mut warned_floor = false;
    let mut media: Option<PollPlaylists> = None;
    let mut ad_break: Option<AdBreak> = None;
    let mut next_break_id: u64 = 0;
    let mut last_profile: Option<crate::tsseg::StreamProfile> = None;
    let mut last_endlist: Option<Vec<String>> = None;
    let mut renewing_session = false;
    let mut forced: Option<Boundary> = None;
    let mut recent_uris: VecDeque<String> = VecDeque::new();
    let mut dedupe_by_uri = false;
    let mut recent_paths: VecDeque<(i64, String)> = VecDeque::new();
    let mut splicer = crate::tsnorm::Splicer::new();
    let mut pair_splicer = crate::tsnorm::PairSplicer::new();
    let mut warned_splice: std::collections::HashSet<&'static str> = std::collections::HashSet::new();
    let mut warned_pairing = false;
    let mut pairing_logged = false;
    let mut probe_segments: u32 = 0;
    let mut suspect_run: Option<(crate::tsseg::Suspect, u32)> = None;
    let mut undecodable_bail = false;
    let mut pending_reason: Option<&'static str> = None;
    let mut retire_hint: Option<&'static str> = None;
    let mut media_failures: u32 = 0;
    let mut backoff = Backoff::default();
    let mut walk_wrapped = false;
    let mut serving_attempt: Option<u32> = None;
    let mut serving_policy: Option<Arc<SourcePolicy>> = None;
    let mut refresh_at: Option<Instant> = None;
    let mut standby: Option<PollPlaylists> = None;
    let mut last_idle_check = Instant::now();

    loop {
        if ctx.origin.stopping.load(Ordering::Relaxed) {
            break;
        }
        if last_idle_check.elapsed() >= IDLE_TICK {
            last_idle_check = Instant::now();
            if ctx.origin.idle() {
                log::info("iop", &rid, || {
                    format!("ingest idle {}/{} — stopping", ctx.source, crate::proxy::host_of(&ctx.entry))
                });
                break;
            }
        }

        let (media_url, media_body, audio_pl) = match media.take() {
            Some(m) => (m.url, m.body, m.audio),
            None => {
                let standby_media = standby.take();
                let escalate = media_failures >= MEDIA_FAIL_ESCALATE && standby_media.is_none();
                if escalate {
                    log::warn("iop", &rid, || {
                        format!("{media_failures} consecutive resolve/ingest failures — advancing to the next candidate")
                    });
                    media_failures = 0;
                }
                if escalate {
                    renewing_session = false;
                }
                let retiring = pending_reason.take();
                let hint = retire_hint.take().filter(|_| standby_media.is_none());
                let mut target_rejected = false;
                let resolved = resolve_media(&ctx, &rid, escalate, retiring.or(hint), &mut target_rejected).await;
                if target_rejected {
                    retire_hint = Some(crate::state::RETIRE_TARGET_REJECTED);
                }
                if escalate && ctx.state.cursor_attempt(&ctx.source, &ctx.entry) == 0 {
                    walk_wrapped = true;
                }
                if let Some(r) = &resolved {
                    probe_segments = 0;
                    suspect_run = None;
                    let (window, evidence) = match &r.media {
                        MediaSource::Hls(url, body, _) => {
                            let w = parse_media_playlist(body);
                            (Some((w.media_sequence, w.segments.len())), overlap_evidence(&recent_paths, url, &w))
                        }
                        MediaSource::RawTs(..) => (None, None),
                    };
                    let same_candidate = r.attempt.is_some() && r.attempt == serving_attempt;
                    let same_timeline =
                        same_candidate && evidence.unwrap_or(r.expires_at_ms.is_some() || standby_media.is_some());
                    let retired = escalate && retiring.is_some();
                    match rejoin(renewing_session, retired, same_timeline, ctx.origin.ring_depth(), next_upstream_seq, window) {
                        Rejoin::Anchor => {
                            prev = PrevSeg::default();
                            next_upstream_seq = -1;
                            recent_paths.clear();
                        }
                        Rejoin::Renewal => {
                            forced = Some(Boundary::SessionRenewal);
                            dedupe_by_uri = true;
                            log::info("iop", &rid, || {
                                format!(
                                    "session renewed — ring kept ({} seg), join marked as a splice",
                                    ctx.origin.ring_depth()
                                )
                            });
                            prev = PrevSeg::default();
                            next_upstream_seq = -1;
                            recent_paths.clear();
                        }
                        Rejoin::Continue => {
                            let (ms, _) = window.unwrap_or_default();
                            log::info("iop", &rid, || {
                                let slide = if ms > next_upstream_seq {
                                    format!(" (the window slid {} segment(s) past us — marked as a gap)", ms - next_upstream_seq)
                                } else {
                                    String::new()
                                };
                                format!(
                                    "re-resolved onto the same timeline — ring kept ({} seg, generation={}), continuing at upstream seq {next_upstream_seq}{slide}",
                                    ctx.origin.ring_depth(),
                                    ctx.origin.generation()
                                )
                            });
                        }
                        Rejoin::Reset => {
                            ctx.origin.reset_ring();
                            log::info("iop", &rid, || {
                                let why = if retired {
                                    "the provider was retired".to_string()
                                } else if !same_candidate {
                                    if escalate { "a failover step" } else { "a different candidate" }.to_string()
                                } else if evidence == Some(false) {
                                    "the new window lists different media at the sequences we hold".to_string()
                                } else {
                                    match window {
                                        None => "a bare TS socket".to_string(),
                                        Some(_) if next_upstream_seq < 0 => "no upstream sequence to continue from".to_string(),
                                        Some((ms, len)) if !window_continues(next_upstream_seq, ms, len) => format!(
                                            "upstream seq {next_upstream_seq} is not in the new window [{ms}, {})",
                                            ms.saturating_add(len as i64)
                                        ),
                                        Some(_) => "nothing in the new window proves it continues ours".to_string(),
                                    }
                                };
                                format!(
                                    "ring reset on re-resolve ({why}; generation={}) — the next segment is marked as a discontinuity",
                                    ctx.origin.generation()
                                )
                            });
                            ad_break = None;
                            splicer.reset();
                            pair_splicer.reset();
                            forced = Some(Boundary::Reset);
                            prev = PrevSeg::default();
                            next_upstream_seq = -1;
                            recent_paths.clear();
                        }
                    }
                    renewing_session = false;
                    serving_attempt = r.attempt;
                    serving_policy = Some(r.policy.clone());
                    refresh_at = r.expires_at_ms.and_then(|exp| proactive_refresh_at(exp, crate::state::epoch_ms(), Instant::now()));
                }
                match resolved {
                    Some(Resolution { media: MediaSource::Hls(u, b, a), .. }) => (u, b, a),
                    Some(Resolution { media: MediaSource::RawTs(stream, first), .. }) => {
                        let read_timeout_ms = serving_policy.as_ref().map_or(0, |p| p.read_timeout_ms.load(Ordering::Relaxed));
                        let session = ingest_raw_ts(&ctx, &rid, stream, first, read_timeout_ms, forced.is_some()).await;
                        if session.idle {
                            log::info("iop", &rid, || {
                                format!("ingest idle {}/{} — stopping", ctx.source, crate::proxy::host_of(&ctx.entry))
                            });
                            break;
                        }
                        let produced = session.produced;
                        if produced > 0 {
                            forced = None;
                        }
                        next_upstream_seq = -1;
                        recent_paths.clear();
                        match raw_verdict(&session) {
                            RawVerdict::Reconnect => {
                                media_failures = 0;
                                backoff.succeed();
                                walk_wrapped = false;
                            }
                            RawVerdict::Short => {
                                media_failures = media_failures.saturating_add(1);
                                let wait = backoff.fail_walk(walk_wrapped).max(FAILURE_BACKOFF_BASE);
                                log::warn("iop", &rid, || {
                                    format!(
                                        "raw-TS session carried media for {}ms ({produced} segment(s)) — shorter than a live socket runs, counted as a failure",
                                        session.media_span.as_millis()
                                    )
                                });
                                back_off(&rid, wait, backoff.failures).await;
                            }
                            RawVerdict::NotMedia => {
                                media_failures = media_failures.saturating_add(1);
                                let wait = backoff.fail_walk(walk_wrapped).max(FAILURE_BACKOFF_BASE);
                                log::warn("iop", &rid, || {
                                    "the entry answered with neither a playlist nor a transport stream (0 segments cut) — counted as a failure".to_string()
                                });
                                back_off(&rid, wait, backoff.failures).await;
                            }
                        }
                        continue;
                    }
                    None if ctx.origin.ineligible().is_some() => break,
                    None if ctx.origin.refused().is_some() => break,
                    None if standby_media.is_some() => {
                        log::warn("iop", &rid, || {
                            format!(
                                "could not renew the target ahead of its expiry — still following the current one, retrying in {PROACTIVE_RETRY:?}"
                            )
                        });
                        refresh_at = Instant::now().checked_add(PROACTIVE_RETRY);
                        media = standby_media;
                        continue;
                    }
                    None => {
                        media_failures = media_failures.saturating_add(1);
                        report_iop(&ctx, "resolve_failed");
                        let wait = backoff.fail_walk(walk_wrapped);
                        back_off(&rid, wait, backoff.failures).await;
                        continue;
                    }
                }
            }
        };

        let mp = parse_media_playlist(&media_body);
        let ap = audio_pl.as_ref().map(|(u, b)| (u.clone(), parse_media_playlist(b)));
        if mp.target_duration > 0.0 {
            let ms = (mp.target_duration * 1000.0) as u64;
            ctx.origin.target_duration_ms.fetch_max(ms, Ordering::Relaxed);
        }
        if next_upstream_seq < 0 {
            next_upstream_seq = mp.media_sequence;
        }

        let Some(policy) = serving_policy.clone() else {
            log::warn("iop", &rid, || "no serving policy for the playlist being followed — re-resolving".to_string());
            media = None;
            media_failures = media_failures.saturating_add(1);
            let wait = backoff.fail_walk(walk_wrapped).max(FAILURE_BACKOFF_BASE);
            back_off(&rid, wait, backoff.failures).await;
            continue;
        };
        let undecodable_watch = policy.player_selectable.load(Ordering::Relaxed);
        let client = ctx.state.client_for(
            policy.connect_timeout_ms.load(Ordering::Relaxed),
            policy.max_redirects.load(Ordering::Relaxed),
        );
        let io = ingest_io(policy.read_timeout_ms.load(Ordering::Relaxed), mp.target_duration);

        let mut ingested_this_poll = 0u32;
        let mut duplicates_this_poll = 0u32;
        for (i, seg) in mp.segments.iter().enumerate() {
            if ctx.origin.stopping.load(Ordering::Relaxed) {
                break;
            }
            let upstream_seq = mp.media_sequence + i as i64;
            if upstream_seq < next_upstream_seq {
                continue;
            }

            let audio_seg = match &ap {
                None => None,
                Some((aurl, apl)) => match pair_audio(seg, upstream_seq, apl) {
                    PairPick::Found(a, aseq) => Some((aurl.clone(), a.clone(), aseq)),
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
                    PairPick::NotYet => break,
                },
            };
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

            let signal = ad_signal(seg, &seg_url, &policy.ad_uri_contains.read_ok());

            let pending = match forced {
                Some(Boundary::SessionRenewal) if duplicates_this_poll > 0 => None,
                other => other,
            };
            let boundary = boundary_before(&prev, seg, upstream_seq).or(pending);

            let plain = match fetch_segment(&ctx, &rid, &client, &policy, &media_url, seg, &seg_url, upstream_seq, io, &mut key_cache).await {
                Some(b) => b,
                None => continue,
            };

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
                    match fetch_segment(&ctx, &rid, &client, &policy, aurl, aseg, &aseg_url, *aseq, io, &mut audio_key_cache).await {
                        Some(b) => Some(b),
                        None => continue,
                    }
                }
            };

            let was = prev.clone();
            prev = PrevSeg { upstream_seq: Some(upstream_seq) };

            let duration = if seg.duration > 0.0 { seg.duration } else { mp.target_duration };
            let our_seq = ctx.origin.next_seq.fetch_add(1, Ordering::Relaxed);

            let ad_edge = signal.is_some() != ad_break.is_some();
            let scan_now = boundary.is_some() || ad_edge || last_profile.is_none();
            let profile = if scan_now { crate::tsseg::scan_profile(&plain) } else { None };
            let profile_changed = match (&last_profile, &profile) {
                (None, _) => false,
                (Some(prev), Some(cur)) => !prev.compatible_with(cur),
                (Some(_), None) => scan_now,
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

            if undecodable_watch && probe_segments < UNDECODABLE_PROBE_SEGMENTS {
                probe_segments += 1;
                suspect_run = match (crate::tsseg::inspect_segment(&plain), suspect_run) {
                    (Some(s), Some((prev, n))) if prev == s => Some((s, n + 1)),
                    (Some(s), _) => Some((s, 1)),
                    (None, _) => None,
                };
                if let Some((s, n)) = suspect_run {
                    log::trace("iop", &rid, || format!("upstream {} ({n}/{UNDECODABLE_STRIKES})", s.describe()));
                    if n >= UNDECODABLE_STRIKES {
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
                if splicer.has_timeline() {
                    splicer.reset();
                }
                if pair_splicer.has_timeline() {
                    pair_splicer.reset();
                }
            }
            let joined = normalize && if demuxed { pair_splicer.has_timeline() } else { splicer.has_timeline() };
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
                        declined = Some((
                            "muxed-no-psi",
                            "no PSI, or a program shape the published layout cannot carry".to_string(),
                        ));
                        splicer.reset();
                        (plain, None, false)
                    }
                },
            };
            if let Some((cause, why)) = declined {
                if warned_splice.insert(cause) {
                    log::warn("iop", &rid, || {
                        format!("splice normalisation declined — {why}; publishing verbatim and signalling the splice")
                    });
                }
            }
            let discontinuity = publishes_discontinuity(boundary, absorbed, joined);

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
                forced = None;
            }
            recent_uris.push_back(seg.uri.clone());
            if recent_uris.len() > RECENT_URI_MEMORY {
                recent_uris.pop_front();
            }
            recent_paths.push_back((upstream_seq, seg_url.path().to_string()));
            if recent_paths.len() > RECENT_URI_MEMORY {
                recent_paths.pop_front();
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
                        Boundary::Reset => "first segment after a ring reset".to_string(),
                    };
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

        if undecodable_bail {
            undecodable_bail = false;
            media = None;
            media_failures = MEDIA_FAIL_ESCALATE;
            continue;
        }

        if dedupe_by_uri {
            log::trace("iop", &rid, || {
                format!("renewal poll: {ingested_this_poll} new, {duplicates_this_poll} already held")
            });
            dedupe_by_uri = false;
            if duplicates_this_poll > 0 && forced == Some(Boundary::SessionRenewal) {
                forced = None;
            }
        }

        if ingested_this_poll > 0 || duplicates_this_poll > 0 {
            empty_polls = 0;
            media_failures = 0;
            backoff.succeed();
            walk_wrapped = false;
            ctx.state.touch_stream(&ctx.source, &ctx.entry);
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
                let wait = backoff.fail_walk(walk_wrapped);
                back_off(&rid, wait, backoff.failures).await;
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
            tokio::time::sleep(poll_interval(mp.target_duration)).await;
            renewing_session = true;
            media = None;
            continue;
        }
        last_endlist = None;

        tokio::time::sleep(poll_interval(mp.target_duration)).await;

        let audio_url = audio_pl.as_ref().map(|(u, _)| u.clone());
        let refreshed = async {
            let vresp = fetch_with_retry(&client, media_url.as_str(), &build_headers(&policy), io.header_ms, &rid, "iop-playlist", MAX_UPSTREAM_RETRIES).await.ok()?;
            if !vresp.status().is_success() {
                return None;
            }
            let vurl = vresp.url().clone();
            let vbody = read_text(vresp, io.body).await?;
            let audio = match &audio_url {
                None => None,
                Some(u) => {
                    let aresp = fetch_with_retry(&client, u.as_str(), &build_headers(&policy), io.header_ms, &rid, "iop-audio", MAX_UPSTREAM_RETRIES).await.ok()?;
                    if !aresp.status().is_success() {
                        return None;
                    }
                    let aurl = aresp.url().clone();
                    Some((aurl, read_text(aresp, io.body).await?))
                }
            };
            Some((vurl, vbody, audio))
        }
        .await;
        match refreshed {
            Some((url, body, audio)) if refresh_at.is_some_and(|t| Instant::now() >= t) => {
                refresh_at = None;
                log::info("iop", &rid, || {
                    format!("the resolved target expires within {}s — renewing it ahead of the lapse", PROACTIVE_REFRESH_LEAD.as_secs())
                });
                standby = Some(PollPlaylists { url, body, audio });
            }
            Some((url, body, audio)) => media = Some(PollPlaylists { url, body, audio }),
            None => {
                log::warn("iop", &rid, || "media playlist refresh failed — re-resolving".to_string());
                media_failures = media_failures.saturating_add(1);
                media = None;
                retire_hint = Some(crate::state::RETIRE_REFRESH_FAILED);
                let wait = backoff.fail_walk(walk_wrapped);
                back_off(&rid, wait, backoff.failures).await;
            }
        }
    }

}

enum PairPick<'a> {
    Found(&'a SegRef, i64),
    RolledPast,
    NotYet,
}

fn pair_tolerance_ms(video_duration: f64, target_duration: f64) -> i64 {
    let d = if video_duration > 0.1 {
        video_duration
    } else if target_duration > 0.1 {
        target_duration
    } else {
        6.0
    };
    ((d * 1000.0) / 2.0).round() as i64
}

fn pair_audio<'a>(video: &SegRef, upstream_seq: i64, apl: &'a crate::tsmux::MediaPlaylist) -> PairPick<'a> {
    if let Some(vt) = video.pdt_ms {
        let mut best: Option<(&SegRef, i64, usize)> = None;
        for (i, a) in apl.segments.iter().enumerate() {
            let Some(at) = a.pdt_ms else { continue };
            let d = (at - vt).abs();
            if best.is_none_or(|(_, bd, _)| d < bd) {
                best = Some((a, d, i));
            }
        }
        if let Some((a, d, i)) = best {
            if d <= pair_tolerance_ms(video.duration, apl.target_duration) {
                return PairPick::Found(a, apl.media_sequence + i as i64);
            }
            let first = apl.segments.iter().find_map(|s| s.pdt_ms).unwrap_or(vt);
            return if vt < first { PairPick::RolledPast } else { PairPick::NotYet };
        }
    }
    let idx = upstream_seq - apl.media_sequence;
    if idx < 0 {
        return PairPick::RolledPast;
    }
    match apl.segments.get(idx as usize) {
        Some(a) => PairPick::Found(a, apl.media_sequence + idx),
        None => PairPick::NotYet,
    }
}

struct Resolution {
    media: MediaSource,
    policy: Arc<SourcePolicy>,
    attempt: Option<u32>,
    expires_at_ms: Option<u64>,
}

async fn resolve_media(
    ctx: &IngestCtx,
    rid: &str,
    escalate: bool,
    reason: Option<&str>,
    target_rejected: &mut bool,
) -> Option<Resolution> {
    let resolved = if escalate {
        ctx.state.resolve_advance(&ctx.source, &ctx.entry, ctx.pl.as_deref(), reason).await
    } else {
        ctx.state.resolve_fresh(&ctx.source, &ctx.entry, ctx.pl.as_deref(), reason).await
    };
    let mut refused_by_upstream = |status: reqwest::StatusCode| {
        if matches!(status.as_u16(), 401 | 403 | 410) {
            *target_rejected = true;
        }
    };
    let (policy, target) = match resolved {
        Ok(v) => v,
        Err(ResolveErr::Refused(why)) => {
            log::info("iop", rid, || format!("resolve refused by the source's stream cap — ending the ingest ({why})"));
            ctx.origin.mark_refused(why);
            return None;
        }
        Err(e) => {
            log::warn("iop", rid, || format!("resolve failed: {e}"));
            return None;
        }
    };
    let meta = ctx.state.target_record(&ctx.source, &ctx.entry, &target);
    let resolution = |media: MediaSource| Resolution {
        media,
        policy: policy.clone(),
        attempt: meta.map(|m| m.attempt),
        expires_at_ms: meta.and_then(|m| m.expires_at_ms),
    };
    let client = ctx.state.client_for(
        policy.connect_timeout_ms.load(Ordering::Relaxed),
        policy.max_redirects.load(Ordering::Relaxed),
    );
    let io = ingest_io(policy.read_timeout_ms.load(Ordering::Relaxed), ctx.origin.target_duration());
    let resp = fetch_with_retry(&client, &target, &build_headers(&policy), io.header_ms, rid, "iop-entry", MAX_UPSTREAM_RETRIES)
        .await
        .ok()?;
    if !resp.status().is_success() {
        log::warn("iop", rid, || format!("entry fetch {} — not usable", resp.status().as_u16()));
        refused_by_upstream(resp.status());
        return None;
    }
    let url = resp.url().clone();

    let mut stream = resp.bytes_stream();
    let first = match tokio::time::timeout(io.body, stream.next()).await {
        Ok(Some(Ok(b))) => b,
        Ok(_) => {
            log::warn("iop", rid, || "entry produced no bytes".to_string());
            return None;
        }
        Err(_) => {
            log::warn("iop", rid, || format!("entry sent headers but no body within {}s", io.body.as_secs()));
            return None;
        }
    };
    if !looks_like_manifest(&first) {
        log::info("iop", rid, || {
            format!("{}: upstream is a bare TS socket — segmenting locally", ctx.source)
        });
        *ctx.origin.upstream_shape.write_ok() = Some("ts".to_string());
        *ctx.origin.demuxed_audio.write_ok() = None;
        return Some(resolution(MediaSource::RawTs(Box::pin(stream), first)));
    }
    let mut body = String::from_utf8_lossy(&first).into_owned();
    let drained = tokio::time::timeout(io.body, async {
        while let Some(Ok(b)) = stream.next().await {
            body.push_str(&String::from_utf8_lossy(&b));
        }
    })
    .await;
    if drained.is_err() {
        log::warn("iop", rid, || format!("entry playlist body stalled for {}s — not usable", io.body.as_secs()));
        return None;
    }

    let mut variant_bandwidth = 0i64;
    let mut variant_attrs: (Option<String>, Option<String>, Option<String>) = (None, None, None);
    let entry_is_master = is_master(&body);
    let master_media = if entry_is_master { Some(crate::manifest::extract_media(&body)) } else { None };
    *ctx.origin.upstream_shape.write_ok() =
        Some(if entry_is_master { "hls-master" } else { "hls-media" }.to_string());
    let (media_url, media_body, rendition) = if entry_is_master {
        let pick = pick_variant(&body, &url)?;
        variant_bandwidth = pick.bandwidth;
        variant_attrs = (pick.resolution.clone(), pick.codecs.clone(), pick.frame_rate.clone());
        let rendition = if pick.external_audio {
            match pick.audio.clone() {
                Some(a) => Some(a),
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
        let vresp = fetch_with_retry(&client, pick.url.as_str(), &build_headers(&policy), io.header_ms, rid, "iop-variant", MAX_UPSTREAM_RETRIES)
            .await
            .ok()?;
        if !vresp.status().is_success() {
            refused_by_upstream(vresp.status());
            return None;
        }
        let vurl = vresp.url().clone();
        (vurl, read_text(vresp, io.body).await?, rendition)
    } else {
        (url, body, None)
    };

    *ctx.origin.encryption.write_ok() = Some(encryption_method(&media_body));

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

    let audio = match &rendition {
        None => None,
        Some(r) => {
            let aresp = fetch_with_retry(&client, r.url.as_str(), &build_headers(&policy), io.header_ms, rid, "iop-audio", MAX_UPSTREAM_RETRIES)
                .await
                .ok()?;
            if !aresp.status().is_success() {
                refused_by_upstream(aresp.status());
                return None;
            }
            let aurl = aresp.url().clone();
            let abody = read_text(aresp, io.body).await?;
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
    {
        let mut dec = master_media.unwrap_or_default();
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
        if variant_bandwidth > 0 {
            dec.bandwidth = Some(variant_bandwidth);
        }
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
                "replace": true,
            }));
        }
    }

    *ctx.origin.demuxed_audio.write_ok() =
        rendition.map(|audio| DemuxedMaster { audio, bandwidth: variant_bandwidth });
    Some(resolution(MediaSource::Hls(media_url, media_body, audio)))
}

enum MediaSource {
    Hls(Url, String, Option<(Url, String)>),
    RawTs(std::pin::Pin<Box<dyn tokio_stream::Stream<Item = reqwest::Result<Bytes>> + Send>>, Bytes),
}

fn looks_like_manifest(b: &[u8]) -> bool {
    let s = b.iter().take(16).copied().collect::<Vec<u8>>();
    let t = String::from_utf8_lossy(&s);
    t.trim_start_matches('\u{feff}').trim_start().starts_with("#EXTM3U")
}

struct RawSession {
    produced: u64,
    media_span: Duration,
    min_session: Duration,
    idle: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum RawVerdict {
    Reconnect,
    Short,
    NotMedia,
}

fn raw_verdict(s: &RawSession) -> RawVerdict {
    if s.produced == 0 {
        RawVerdict::NotMedia
    } else if s.media_span >= s.min_session {
        RawVerdict::Reconnect
    } else {
        RawVerdict::Short
    }
}

async fn ingest_raw_ts(
    ctx: &IngestCtx,
    rid: &str,
    mut stream: std::pin::Pin<Box<dyn tokio_stream::Stream<Item = reqwest::Result<Bytes>> + Send>>,
    first: Bytes,
    read_timeout_ms: u64,
    mark_first: bool,
) -> RawSession {
    let target = {
        let t = ctx.origin.target_duration();
        if t > 0.0 { t } else { 5.0 }
    };
    ctx.origin.target_duration_ms.fetch_max((target * 1000.0) as u64, Ordering::Relaxed);
    let mut seg = crate::tsseg::TsSegmenter::new(target);
    let mut produced = 0u64;
    let silence = ingest_io(read_timeout_ms, target).body;
    let mut disc = mark_first;
    let opened = Instant::now();
    let mut last_bytes = opened;
    let mut idle = false;
    let mut last_idle_check = opened;

    for cut in seg.push(&first) {
        push_cut(ctx, cut, std::mem::take(&mut disc));
        produced += 1;
    }
    loop {
        let item = match tokio::time::timeout(silence, stream.next()).await {
            Ok(Some(item)) => item,
            Ok(None) => break,
            Err(_) => {
                log::warn("iop", rid, || {
                    format!("raw-TS socket silent for {}s after {produced} segment(s) — ending the session", silence.as_secs())
                });
                break;
            }
        };
        if ctx.origin.stopping.load(Ordering::Relaxed) {
            break;
        }
        if last_idle_check.elapsed() >= IDLE_TICK {
            last_idle_check = Instant::now();
            if ctx.origin.idle() {
                idle = true;
                break;
            }
        }
        match item {
            Ok(b) => {
                last_bytes = Instant::now();
                for cut in seg.push(&b) {
                    push_cut(ctx, cut, std::mem::take(&mut disc));
                    produced += 1;
                }
            }
            Err(e) => {
                log::warn("iop", rid, || format!("raw-TS read failed after {produced} segment(s): {e}"));
                break;
            }
        }
    }
    if let Some(tail) = seg.finish() {
        push_cut(ctx, tail, std::mem::take(&mut disc));
        produced += 1;
    }
    log::info("iop", rid, || format!("raw-TS session ended — {produced} segment(s) cut"));
    report_iop(ctx, "closed");
    RawSession { produced, media_span: last_bytes.duration_since(opened), min_session: silence, idle }
}

fn push_cut(ctx: &IngestCtx, cut: crate::tsseg::CutSegment, discontinuity: bool) {
    let our_seq = ctx.origin.next_seq.fetch_add(1, Ordering::Relaxed);
    ctx.origin.push(Segment {
        seq: our_seq,
        duration: cut.duration,
        bytes: Bytes::from(cut.bytes),
        discontinuity,
        pdt: SystemTime::now(),
        audio: None,
    });
}

fn unwrap_logged(ctx: &IngestCtx, rid: &str, body: Bytes) -> Bytes {
    let (clean, first) = ctx.origin.unwrap_disguise(body);
    if let Some((label, n)) = first {
        log::info("iop", rid, || {
            format!(
                "{}: segments arrive disguised ({label}, {n} B before the first TS packet) — unwrapping at ingest, so the ring and both renderers carry clean TS",
                ctx.source
            )
        });
    }
    clean
}

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
    io: IngestIo,
    key_cache: &mut Option<(String, [u8; 16])>,
) -> Option<Bytes> {
    let resp = match fetch_with_retry(client, seg_url.as_str(), &build_headers(policy), io.header_ms, rid, "iop-segment", MAX_UPSTREAM_RETRIES).await {
        Ok(r) if r.status().is_success() => r,
        _ => {
            log::warn("iop", rid, || format!("segment fetch failed at upstream seq={upstream_seq} — gap"));
            ctx.state.report(serde_json::json!({
                "kind": "upstream", "ok": false, "status": 0, "source": ctx.source, "entryUrl": ctx.entry,
            }));
            return None;
        }
    };
    let body = match tokio::time::timeout(io.body, resp.bytes()).await {
        Ok(Ok(b)) => b,
        Ok(Err(e)) => {
            log::warn("iop", rid, || format!("segment body read failed at upstream seq={upstream_seq} ({e}) — gap"));
            return None;
        }
        Err(_) => {
            log::warn("iop", rid, || {
                format!("segment body stalled for {}s at upstream seq={upstream_seq} — gap", io.body.as_secs())
            });
            ctx.state.report(serde_json::json!({
                "kind": "upstream", "ok": false, "status": 0, "source": ctx.source, "entryUrl": ctx.entry,
            }));
            return None;
        }
    };

    let key = match seg.key.as_ref() {
        None => return Some(unwrap_logged(ctx, rid, body)),
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
    let key_bytes = match key_cache {
        Some((uri, k)) if uri == key_url.as_str() => *k,
        _ => {
            let kresp = fetch_with_retry(client, key_url.as_str(), &build_headers(policy), io.header_ms, rid, "iop-key", MAX_UPSTREAM_RETRIES)
                .await
                .ok()?;
            if !kresp.status().is_success() {
                log::warn("iop", rid, || format!("AES key fetch {} — dropping seq={upstream_seq}", kresp.status().as_u16()));
                return None;
            }
            let Ok(Ok(b)) = tokio::time::timeout(io.body, kresp.bytes()).await else {
                log::warn("iop", rid, || format!("AES key body unreadable within {}s — dropping seq={upstream_seq}", io.body.as_secs()));
                return None;
            };
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
    let iv = key.iv.unwrap_or_else(|| {
        let mut iv = [0u8; 16];
        iv[8..].copy_from_slice(&(upstream_seq as u64).to_be_bytes());
        iv
    });
    match decrypt_aes128_cbc(&key_bytes, &iv, &body) {
        Some(p) => Some(unwrap_logged(ctx, rid, Bytes::from(p))),
        None => {
            log::warn("iop", rid, || format!("AES-128 decrypt failed at seq={upstream_seq} ({} bytes) — gap", body.len()));
            None
        }
    }
}


const READY_TIMEOUT: Duration = Duration::from_secs(20);

fn fmt_rfc3339(t: SystemTime) -> String {
    let d = t.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let millis = d.subsec_millis();
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (h, mi, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
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
    let longest = window.iter().fold(target_duration, |m, s| if s.duration > m { s.duration } else { m });
    let td = longest.ceil().max(1.0) as u64;
    let mut out = String::with_capacity(256 + window.len() * 160);
    out.push_str("#EXTM3U\n#EXT-X-VERSION:3\n");
    out.push_str(&format!("#EXT-X-TARGETDURATION:{td}\n"));
    let base = window.first().map(|s| s.seq).unwrap_or(0);
    out.push_str(&format!("#EXT-X-MEDIA-SEQUENCE:{base}\n"));
    out.push_str(&format!("#EXT-X-DISCONTINUITY-SEQUENCE:{disc_seq}\n"));
    let enc_entry = crate::manifest::enc(entry);
    for (i, seg) in window.iter().enumerate() {
        if seg.discontinuity {
            out.push_str("#EXT-X-DISCONTINUITY\n");
        }
        if i == 0 || seg.discontinuity {
            out.push_str(&format!("#EXT-X-PROGRAM-DATE-TIME:{}\n", fmt_rfc3339(seg.pdt)));
        }
        out.push_str(&format!("#EXTINF:{:.3},\n", seg.duration));
        let l = match lane {
            Lane::Video => "",
            Lane::Audio => "a",
        };
        out.push_str(&format!("{mount_path}/{source}/o/{enc_entry}/{generation}-{l}{}.ts", seg.seq));
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
    let mut out = String::from("#EXTM3U\n#EXT-X-VERSION:4\n");
    out.push_str("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\"");
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

enum Ready {
    Yes,
    TimedOut,
    Ineligible,
    Refused(String),
}

async fn wait_ready(origin: &Arc<Origin>, rid: &str) -> Ready {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if let Some(why) = origin.refused() {
            log::info("oop", rid, || format!("origin refused by the source's stream cap ({why}) — 429"));
            return Ready::Refused(why);
        }
        if origin.ring_depth() >= MIN_SEGMENTS {
            return Ready::Yes;
        }
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
        let _ = tokio::time::timeout(left.min(Duration::from_secs(1)), origin.wait_for_segment()).await;
    }
}

fn note_viewer(state: &AppState, mount_path: &str, source: &str, entry: &str, id: &crate::proxy::Identity, bytes: usize) {
    state.report(serde_json::json!({
        "kind": "viewer", "source": source, "entryUrl": entry,
        "ip": id.ip, "ua": id.ua, "username": id.username,
        "playerType": if mount_path == "/api/ext/v1" { "externalPlayer" } else { "appPlayer" },
        "bytes": bytes as u64,
    }));
}

fn window_snapshot(origin: &Origin) -> (u64, Vec<Arc<Segment>>) {
    let disc_seq = origin.disc_seq();
    (disc_seq, origin.window())
}

fn note_entry_shape(origin: &Origin, is_master: bool, rid: &str) {
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
        Ready::Refused(why) => return Some(crate::proxy::text(429, &why)),
    }
    let demuxed = origin.demuxed_audio();
    note_entry_shape(&origin, demuxed.is_some(), rid);
    if let Some(m) = demuxed {
        origin.touch();
        let body = render_master(mount_path, source, entry, &m, token, pl);
        log::info("oop", rid, || {
            format!("origin master served (1 variant + audio rendition \"{}\", {} bytes)", m.audio.name, body.len())
        });
        note_viewer(state, mount_path, source, entry, id, body.len());
        return Some(crate::proxy::raw(200, "application/vnd.apple.mpegurl", body.into_bytes()));
    }
    let (disc_seq, window) = window_snapshot(&origin);
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
    note_viewer(state, mount_path, source, entry, id, body.len());
    Some(crate::proxy::raw(200, "application/vnd.apple.mpegurl", body.into_bytes()))
}

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
    let Some(policy) = state.resolved_target_policy(source, entry) else {
        log::warn("oop", rid, || format!("playlist {lane:?}: {source} entry was never resolved here — not starting an ingest"));
        return crate::proxy::text(404, "not found: no live ingest");
    };
    let lease = subscribe(state, source, entry, pl, &policy);
    let origin = lease.origin().clone();
    match wait_ready(&origin, rid).await {
        Ready::Yes => {}
        Ready::Ineligible => {
            log::warn("oop", rid, || format!("playlist {lane:?}: this upstream cannot be ringed"));
            return crate::proxy::text(404, "not found: no live ingest");
        }
        Ready::TimedOut => return crate::proxy::text(503, "stream warming up: no playable window yet"),
        Ready::Refused(why) => return crate::proxy::text(429, &why),
    }
    let (disc_seq, window) = window_snapshot(&origin);
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
    note_viewer(state, mount_path, source, entry, id, body.len());
    crate::proxy::raw(200, "application/vnd.apple.mpegurl", body.into_bytes())
}

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
            None => {
                log::trace("oop", rid, || format!("segment {file}: this origin carries no audio lane — 404"));
                return crate::proxy::text(404, "not found: lane not carried");
            }
        },
    };
    let n = bytes.len() as u64;
    log::trace("oop", rid, || format!("segment seq={want_seq} lane={lane:?} served from ring ({n} bytes)"));
    state.report(serde_json::json!({
        "kind": "bytes", "source": source, "entryUrl": entry,
        "ip": id.ip, "ua": id.ua, "username": id.username, "bytes": n,
    }));
    crate::proxy::raw(200, "video/mp2t", bytes.to_vec())
}

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
        Ready::Refused(why) => return Some(crate::proxy::text(429, &why)),
    }
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
    policy: Arc<SourcePolicy>,
    source: String,
    entry: String,
    rid: String,
    ip: String,
    ua: String,
    username: Option<String>,
}

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

    let mut next_seq = origin.window().first().map(|s| s.seq).unwrap_or(0);
    let mut pending_bytes: u64 = 0;
    let mut last_flush = Instant::now();
    let mut splicer = crate::tsnorm::Splicer::new();
    let mut warned_splice = false;
    let mut joining = true;
    let mut close_reason = "ingest_stopped";

    'outer: loop {
        let window = origin.window();
        if let Some(front) = window.first() {
            if next_seq < front.seq {
                log::warn("oop", &ctx.rid, || {
                    format!("client fell behind the ring (wanted seq={next_seq}, oldest held={}) — skipping ahead; raise originRingMb if this repeats", front.seq)
                });
                next_seq = front.seq;
                splicer.reset();
                joining = true;
            }
        }
        let normalize = ctx.policy.splice_normalize.load(Ordering::Relaxed);
        if !normalize && splicer.has_timeline() {
            splicer.reset();
        }
        let mut sent_any = false;
        let from = next_seq;
        for seg in window.iter().filter(|s| s.seq >= from) {
            next_seq = seg.seq + 1;
            if seg.audio.is_some() {
                log::warn("oop", &ctx.rid, || {
                    format!("ring turned demuxed at seq={} — ending the muxed socket so the client reconnects into the interleaving producer", seg.seq)
                });
                close_reason = "lane_changed";
                break 'outer;
            }
            if seg.discontinuity {
                joining = true;
            }
            let src = if std::mem::take(&mut joining) {
                join_at_keyframe(&seg.bytes, seg.seq, &ctx.rid)
            } else {
                seg.bytes.clone()
            };
            let body = match normalize.then(|| splicer.normalize(&src)).flatten() {
                Some(bytes) => Bytes::from(bytes),
                None => {
                    if normalize {
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
                    src
                }
            };
            pending_bytes += body.len() as u64;
            sent_any = true;
            if tx.send(Ok(body)).await.is_err() {
                return client_gone(&ctx, &stream_id, pending_bytes, "origin raw-TS client disconnected");
            }
        }
        if pending_bytes > 0 && last_flush.elapsed() >= Duration::from_secs(1) {
            ctx.state.report(serde_json::json!({ "kind": "sbytes", "streamId": stream_id, "bytes": pending_bytes }));
            pending_bytes = 0;
            last_flush = Instant::now();
        }
        if !sent_any {
            if !await_segment_or_client_gone(&origin, &tx).await {
                return client_gone(&ctx, &stream_id, pending_bytes, "origin raw-TS client disconnected while idle");
            }
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

async fn await_segment_or_client_gone(
    origin: &Origin,
    tx: &tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>,
) -> bool {
    tokio::select! {
        _ = tx.closed() => false,
        _ = tokio::time::timeout(Duration::from_secs(30), origin.wait_for_segment()) => true,
    }
}

fn client_gone(ctx: &TsRingCtx, stream_id: &str, pending_bytes: u64, what: &str) {
    log::info("oop", &ctx.rid, || format!("{what} ({stream_id})"));
    if pending_bytes > 0 {
        ctx.state.report(serde_json::json!({ "kind": "sbytes", "streamId": stream_id, "bytes": pending_bytes }));
    }
    ctx.state.report(serde_json::json!({ "kind": "close", "streamId": stream_id, "reason": "client_gone" }));
}

fn join_at_keyframe(bytes: &Bytes, seq: u64, rid: &str) -> Bytes {
    match crate::tsseg::trim_to_keyframe(bytes) {
        Some(trimmed) => {
            log::info("oop", rid, || {
                format!(
                    "raw-TS join at seq={seq} opens on its first keyframe ({} KiB of pre-keyframe media skipped)",
                    (bytes.len() - trimmed.len()) / 1024
                )
            });
            Bytes::from(trimmed)
        }
        None => bytes.clone(),
    }
}

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

    let mut next_seq = origin.window().first().map(|s| s.seq).unwrap_or(0);
    let mut pending_bytes: u64 = 0;
    let mut last_flush = Instant::now();
    let mut weaver = crate::tsweave::PairWeaver::new();
    let mut warned_declines: std::collections::HashSet<&'static str> = std::collections::HashSet::new();
    let mut consecutive_declines: u32 = 0;
    let mut warned_switch = false;
    let mut close_reason = "ingest_stopped";

    'outer: loop {
        let window = origin.window();
        if let Some(front) = window.first() {
            if next_seq < front.seq {
                log::warn("oop", &ctx.rid, || {
                    format!("client fell behind the ring (wanted seq={next_seq}, oldest held={}) — skipping ahead; raise originRingMb if this repeats", front.seq)
                });
                next_seq = front.seq;
                weaver.reset();
            }
        }
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
        let from = next_seq;
        for seg in window.iter().filter(|s| s.seq >= from) {
            next_seq = seg.seq + 1;
            let woven = seg.audio.as_ref().and_then(|a| weaver.weave(&seg.bytes, a));
            let body = match woven {
                Some(b) => {
                    consecutive_declines = 0;
                    Bytes::from(b)
                }
                None => {
                    let (cause, why) = match seg.audio.as_ref() {
                        Some(_) => (weaver.last_decline_slug(), weaver.last_decline().to_string()),
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
                return client_gone(&ctx, &stream_id, pending_bytes, "origin raw-TS interleaved client disconnected");
            }
        }
        if pending_bytes > 0 && last_flush.elapsed() >= Duration::from_secs(1) {
            ctx.state.report(serde_json::json!({ "kind": "sbytes", "streamId": stream_id, "bytes": pending_bytes }));
            pending_bytes = 0;
            last_flush = Instant::now();
        }
        if !sent_any {
            if !await_segment_or_client_gone(&origin, &tx).await {
                return client_gone(&ctx, &stream_id, pending_bytes, "origin raw-TS interleaved client disconnected while idle");
            }
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

fn report_iop(ctx: &IngestCtx, status: &str) {
    let rs = ctx.origin.ring_stats();
    ctx.state.report(serde_json::json!({
        "kind": "iop",
        "source": ctx.source,
        "entryUrl": ctx.entry,
        "status": status,
        "subscribers": ctx.origin.subscribers.load(Ordering::Relaxed),
        "ringSegments": rs.segments,
        "ringBytes": ctx.origin.ring_bytes.load(Ordering::Relaxed),
        "channelRingCapBytes": ctx.origin.ring_cap_bytes.load(Ordering::Relaxed),
        "ringSeconds": rs.seconds,
        "floorBeatsCap": rs.floor_beat_cap,
        "headSeq": ctx.origin.next_seq.load(Ordering::Relaxed),
        "generation": ctx.origin.generation(),
        "discSeq": ctx.origin.disc_seq(),
        "discInWindow": rs.disc_in_window,
        "ingestedSegments": ctx.origin.ingested_segments.load(Ordering::Relaxed),
        "ingestedBytes": ctx.origin.ingested_bytes.load(Ordering::Relaxed),
        "evictedSegments": ctx.origin.evicted_segments.load(Ordering::Relaxed),
        "targetDuration": ctx.origin.target_duration(),
        "demuxed": ctx.origin.demuxed_audio.read_ok().is_some(),
        "ineligible": ctx.origin.ineligible(),
        "upstreamShape": ctx.origin.upstream_shape.read_ok().clone(),
        "encryption": ctx.origin.encryption.read_ok().clone(),
        "segmentWrapper": ctx.origin.segment_wrapper.read_ok().clone(),
        "suspect": ctx.origin.last_suspect.read_ok().clone(),
        "suspectRetires": ctx.origin.suspect_retires.load(Ordering::Relaxed),
    }));
}

fn report_cue(ctx: &IngestCtx, state: &str, b: &AdBreak) {
    ctx.state.report(serde_json::json!({
        "kind": "cue",
        "source": ctx.source,
        "entryUrl": ctx.entry,
        "state": state,
        "breakId": b.id,
        "signal": format!("{:?}", b.signal),
        "segments": b.segments,
        "durationSec": b.seconds,
        "announcedSec": b.announced,
        "profileChanged": b.profile_changed,
    }));
}

pub(crate) struct RingFootprint {
    pub origins: usize,
    pub subscribed: usize,
    pub bytes: u64,
    pub cap_bytes: u64,
}

pub(crate) fn ring_footprint(origins: &Mutex<HashMap<String, Arc<Origin>>>) -> RingFootprint {
    let map = origins.lock_ok();
    let mut f = RingFootprint { origins: 0, subscribed: 0, bytes: 0, cap_bytes: 0 };
    for o in map.values() {
        if o.stopping.load(Ordering::Relaxed) {
            continue;
        }
        f.origins += 1;
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

    #[test]
    fn two_incarnations_of_a_channel_never_share_a_generation() {
        let first = Origin::new(1000);
        let second = Origin::new(1000);
        assert_ne!(
            first.generation(),
            second.generation(),
            "a respawned origin must not reuse its predecessor's segment-URL namespace"
        );
        let before = first.generation();
        first.reset_ring();
        assert!(first.generation() > before, "reset_ring must still advance the generation");
    }

    fn null_ts(n: usize) -> Vec<u8> {
        (0..n)
            .flat_map(|_| {
                let mut p = vec![0xFFu8; crate::tsseg::PKT];
                p[0] = crate::tsseg::SYNC;
                p[1] = 0x1F;
                p[3] = 0x10;
                p
            })
            .collect()
    }

    #[test]
    fn a_disguised_segment_reaches_the_ring_as_clean_ts_without_a_copy() {
        let o = Origin::new(10_000);
        let ts = null_ts(12);
        let body = Bytes::from(crate::tsseg::webp_disguise(&ts));
        let (clean, first) = o.unwrap_disguise(body.clone());
        assert_eq!(&clean[..], &ts[..], "the ring gets the stream, byte for byte");
        assert_eq!(clean.as_ptr(), body[42..].as_ptr(), "…as a slice of the fetched buffer");
        assert_eq!(first, Some(("riff-webp", 42)), "the first sighting is announced");
        assert_eq!(o.segment_wrapper.read_ok().as_deref(), Some("riff-webp"));

        let (_, again) = o.unwrap_disguise(Bytes::from(crate::tsseg::webp_disguise(&ts)));
        assert_eq!(again, None, "the same wrapper on the next segment is not news — one log line, not one per segment");
    }

    #[test]
    fn a_clean_segment_passes_the_ingest_unwrap_untouched() {
        let o = Origin::new(10_000);
        let body = Bytes::from(null_ts(12));
        let (out, first) = o.unwrap_disguise(body.clone());
        assert_eq!(out.as_ptr(), body.as_ptr());
        assert_eq!(out.len(), body.len());
        assert_eq!(first, None);
        assert_eq!(o.segment_wrapper.read_ok().as_deref(), None, "nothing to report on the iop frame");
    }

    #[test]
    fn a_decline_memo_expires_so_the_channel_is_retried() {
        let o = Origin::new(1000);
        assert!(!o.declined_recently(), "an origin with no verdict must never read as declined");

        o.mark_ineligible("fMP4 (#EXT-X-MAP) is not concatenable".to_string());
        assert!(o.declined_recently(), "a fresh decline is answered from the memo");

        *o.ineligible_at.lock_ok() = Some(Instant::now() - INELIGIBLE_MEMO_TTL - Duration::from_secs(1));
        assert!(!o.declined_recently(), "a stale decline must expire so the shape is re-tested");
        assert!(o.ineligible().is_some(), "expiry is about the memo's AGE, not about forgetting the reason");
    }

    #[test]
    fn ring_evicts_oldest_to_stay_under_the_byte_cap() {
        let o = Origin::new(1000);
        for i in 0..10 {
            o.push(seg(i, 200));
        }
        let ring = o.ring.read_ok();
        assert!(o.ring_bytes.load(Ordering::Relaxed) <= 1000, "ring must respect the cap");
        assert_eq!(ring.len(), 5, "1000/200 = 5 segments fit");
        assert_eq!(ring.front().unwrap().seq, 5);
        assert_eq!(ring.back().unwrap().seq, 9);
    }


    fn lane(media_sequence: i64, base_ms: i64, n: usize, dur: f64, dated: bool) -> crate::tsmux::MediaPlaylist {
        let mut body = format!("#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:{media_sequence}\n");
        if dated {
            body.push_str(&format!("#EXT-X-PROGRAM-DATE-TIME:{}\n", fmt_rfc3339(
                SystemTime::UNIX_EPOCH + Duration::from_millis(base_ms as u64),
            )));
        }
        for i in 0..n {
            body.push_str(&format!("#EXTINF:{dur},\nseg{}.ts\n", media_sequence + i as i64));
        }
        crate::tsmux::parse_media_playlist(&body)
    }

    #[test]
    fn a_renumbered_audio_lane_still_pairs_on_program_date_time() {
        const BASE: i64 = 1_786_183_180_000;
        let v = lane(10, BASE, 5, 5.0, true);
        let a = lane(11, BASE, 5, 4.992, true);

        for (i, vs) in v.segments.iter().enumerate() {
            let useq = v.media_sequence + i as i64;
            match pair_audio(vs, useq, &a) {
                PairPick::Found(p, aseq) => {
                    let d = (p.pdt_ms.unwrap() - vs.pdt_ms.unwrap()).abs();
                    assert!(d < 100, "seq {useq} paired to media {d} ms away — that is a different segment");
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

        let idx = v.media_sequence - a.media_sequence;
        assert_eq!(idx, -1, "the renumbering is exactly the off-by-one the live trace showed");
    }

    #[test]
    fn an_aligned_pair_picks_the_same_segment_as_the_index_did() {
        const BASE: i64 = 1_786_183_180_000;
        let v = lane(40, BASE, 5, 5.0, true);
        let a = lane(40, BASE, 5, 4.992, true);
        for (i, vs) in v.segments.iter().enumerate() {
            let useq = v.media_sequence + i as i64;
            let by_pdt = match pair_audio(vs, useq, &a) {
                PairPick::Found(p, aseq) => {
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
        let v = lane(10, 0, 3, 5.0, false);
        let a = lane(10, 0, 3, 5.0, false);
        match pair_audio(&v.segments[1], 11, &a) {
            PairPick::Found(p, aseq) => {
                assert_eq!(p.uri, "seg11.ts", "index pairing still selects positionally");
                assert_eq!(aseq, 11, "the fallback reports the index it selected on");
            }
            _ => panic!("the fallback must still pair"),
        }
        assert!(matches!(pair_audio(&v.segments[0], 9, &a), PairPick::RolledPast));
    }

    #[test]
    fn an_audio_lane_that_has_not_caught_up_holds_rather_than_mispairs() {
        const BASE: i64 = 1_786_183_180_000;
        let v = lane(10, BASE + 60_000, 2, 5.0, true);
        let a = lane(10, BASE, 3, 5.0, true);
        assert!(matches!(pair_audio(&v.segments[0], 10, &a), PairPick::NotYet));

        let v2 = lane(10, BASE, 2, 5.0, true);
        let a2 = lane(10, BASE + 60_000, 3, 5.0, true);
        assert!(matches!(pair_audio(&v2.segments[0], 10, &a2), PairPick::RolledPast));
    }

    #[test]
    fn the_tolerance_separates_aac_jitter_from_a_whole_segment_out() {
        let tol = pair_tolerance_ms(5.0, 5.0);
        assert_eq!(tol, 2_500);
        assert!(tol > 20 * 10, "AAC's ~21 ms quantisation is far inside tolerance");
        assert!(tol < 5_000 / 2 + 1, "a whole segment out is far outside it");
        assert!(pair_tolerance_ms(0.0, 0.0) > 0);
    }

    #[test]
    fn min_segments_floor_beats_the_byte_cap() {
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
            watched.push(seg(i, 500));
            idle.push(seg(i, 200));
        }
        watched.subscribers.store(2, Ordering::Relaxed);
        let declined = Arc::new(Origin::new(7_000));
        declined.mark_ineligible("fMP4 (#EXT-X-MAP) is not concatenable".to_string());
        declined.stopping.store(true, Ordering::Relaxed);

        let map: HashMap<String, Arc<Origin>> =
            [("a".to_string(), watched), ("b".to_string(), idle), ("c".to_string(), declined)]
                .into_iter()
                .collect();
        let f = ring_footprint(&Mutex::new(map));

        assert_eq!(f.origins, 2, "the retained decline is not a live origin");
        assert_eq!(f.subscribed, 1, "the idle origin still costs RAM but has no viewer");
        assert_eq!(f.bytes, 2_100, "1500 + 600 — every ring, watched or not");
        assert_eq!(f.cap_bytes, 14_000, "Σ per-channel caps: headroom, not a global ceiling — and not the decline's 7000");
    }

    #[test]
    fn ring_footprint_of_an_empty_registry_is_all_zero() {
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
        assert_eq!(
            boundary_before(&prev, &segref("s12.ts", None, false), 12),
            Some(Boundary::SequenceGap)
        );
    }

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

    #[test]
    fn per_segment_tokenized_paths_are_not_boundaries() {
        let prev = PrevSeg { upstream_seq: Some(2) };
        assert_eq!(
            boundary_before(&prev, &segref("/v1/dVTv3Ar0rx6v2y392Yb0SwWZvdmz4CwffW1GGajNk50=/s.ts", None, false), 3),
            None,
            "an opaque per-segment path token is not a splice"
        );
    }

    #[test]
    fn upstream_tag_still_splices_a_contiguous_sequence() {
        let prev = PrevSeg { upstream_seq: Some(9) };
        assert_eq!(
            boundary_before(&prev, &segref("s10.ts", None, true), 10),
            Some(Boundary::Tag),
            "a tagged splice on a contiguous sequence must still fire"
        );
    }


    fn uris(n: &[&str]) -> Vec<String> {
        n.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_first_endlist_is_never_terminal() {
        assert!(!endlist_is_terminal(None, &uris(&["a.ts", "b.ts"])));
    }

    #[test]
    fn an_unchanged_endlist_playlist_is_terminal() {
        let prev = uris(&["a.ts", "b.ts", "c.ts"]);
        assert!(endlist_is_terminal(Some(&prev), &uris(&["a.ts", "b.ts", "c.ts"])));
    }

    #[test]
    fn a_renewed_session_keeps_the_ingest_alive() {
        let prev = uris(&["clip/1/00027.ts", "clip/1/00028.ts"]);
        assert!(!endlist_is_terminal(Some(&prev), &uris(&["clip/1/00029.ts", "clip/1/00030.ts"])));
        assert!(!endlist_is_terminal(Some(&prev), &uris(&["clip/1/00027.ts"])));
        assert!(!endlist_is_terminal(Some(&prev), &[]));
    }

    #[test]
    fn repeated_empty_endlist_playlists_are_not_terminal() {
        assert!(!endlist_is_terminal(Some(&Vec::new()), &[]));
        assert!(!endlist_is_terminal(Some(&uris(&["a.ts"])), &[]));
    }


    const PLUTO_SIG: &str = "0_ad/creative/";
    const PGM_URI: &str = "https://siloh-ns1.plutotv.net/865_pluto/clip/616872f90b4e8f001a96043e_Titanic/1080pDRM/20250821_205403/hls/6281158-6741367/hls_300-00027.ts";
    const AD_URI: &str = "https://siloh-ns1.plutotv.net/v1/mp4/c(ts)/h(default)/max(6)/rev(1)/p(0_ad%2Fcreative%2F6a6d6f417efe0af5316f0411_ad%2F720p%2F20260801_040001_248657053_x_a53f810a%2Fvideo_600.mp4)/id3(p=clik,id=6a6d6f417efe0af5316f0411)/head(0-984)/frag(984-382846)/sign/v1/1Z7FXa8QkGTviYcMUGdk2tAY3YaVaSOrvZVOw0MQACE=/0.ts";

    fn ad_of(uri: &str, sigs: &[&str]) -> Option<AdSignal> {
        let list: Vec<String> = sigs.iter().map(|s| s.to_string()).collect();
        ad_signal(&segref(uri, None, false), &Url::parse(uri).unwrap(), &list)
    }

    #[test]
    fn a_pluto_ad_creative_is_detected_and_a_program_clip_is_not() {
        assert_eq!(ad_of(AD_URI, &[PLUTO_SIG]), Some(AdSignal::UriSignature));
        assert_eq!(ad_of(PGM_URI, &[PLUTO_SIG]), None, "a /clip/ path can never contain the ad marker");
    }

    #[test]
    fn the_removed_url_heuristics_false_positives_are_not_ads() {
        for k in ["keyfile_5", "keyfile_6", "keyfile_7"] {
            let u = format!("https://siloh-ns1.plutotv.net/865_pluto/clip/abc_Movie/1080pDRM/d/hls/1-2/{k}/s.ts");
            assert_eq!(ad_of(&u, &[PLUTO_SIG]), None, "in-clip key rotation is not an ad break");
        }
        for t in ["UWJ5Mz0j0e=", "Xk91bQ2p7f=", "Zm9vYmFyYmF6="] {
            let u = format!("https://cdn.example.com/v1/{t}/hls_300-00031.ts");
            assert_eq!(ad_of(&u, &[PLUTO_SIG]), None, "an opaque per-segment token is not an ad break");
        }
    }

    #[test]
    fn a_source_that_declares_no_signature_detects_nothing() {
        assert_eq!(ad_of(AD_URI, &[]), None);
    }

    #[test]
    fn a_cue_tag_wins_over_the_uri_signature() {
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

    #[test]
    fn every_segment_uri_carries_the_token() {
        let m = render(&window(4, &[]));
        let uris: Vec<&str> = m.lines().filter(|l| l.contains("/o/")).collect();
        assert_eq!(uris.len(), 4);
        assert!(uris.iter().all(|u| u.contains("token=tok123")), "no segment may be servable without the token");
    }


    fn render_lane(w: &[Arc<Segment>], lane: Lane) -> String {
        render_media_playlist(w, 5.0, "/api/ext/v1", "pluto", "pluto://us_east/abc", 3, Some("tok123"), Some("pl1"), 9, lane)
    }

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
        assert!(!m.contains("plutotv.net"), "no upstream host may leak into the authored master:\n{m}");
        assert!(!m.contains("/h/"), "no hop URIs");
        assert!(m.contains("#EXT-X-VERSION:4"), "#EXT-X-MEDIA is a version-4 tag");
        assert!(m.contains("BANDWIDTH=3321280"), "RFC 8216 makes BANDWIDTH required");
        assert!(m.contains("LANGUAGE=\"en\""), "upstream's own labelling is carried through");
        assert!(m.contains("/o/") && m.contains("/a.m3u8?token=tok123&pl=pl1"), "audio rendition is ours:\n{m}");
        assert!(m.contains("/v.m3u8?token=tok123&pl=pl1"), "so is the variant:\n{m}");
        assert!(!m.contains("/3-"), "no generation in a playlist path:\n{m}");
    }

    #[test]
    fn discontinuity_is_emitted_before_its_segment_only() {
        let m = render(&window(3, &[1]));
        let lines: Vec<&str> = m.lines().collect();
        assert_eq!(lines.iter().filter(|l| **l == "#EXT-X-DISCONTINUITY").count(), 1);
        let i = lines.iter().position(|l| *l == "#EXT-X-DISCONTINUITY").unwrap();
        assert!(lines[i + 1].starts_with("#EXT-X-PROGRAM-DATE-TIME:"));
        assert!(lines[i + 2].starts_with("#EXTINF:"));
        assert!(lines[i + 3].contains("/0-101.ts"));
    }

    #[test]
    fn every_timeline_in_the_window_gets_its_own_program_date_time() {
        let m = render(&window(9, &[3, 6, 7]));
        let pdts = m.lines().filter(|l| l.starts_with("#EXT-X-PROGRAM-DATE-TIME:")).count();
        assert_eq!(pdts, 4, "the window head plus one per discontinuity");
        let lines: Vec<&str> = m.lines().collect();
        for (i, l) in lines.iter().enumerate() {
            if l.starts_with("#EXT-X-PROGRAM-DATE-TIME:") {
                assert!(lines[i + 1].starts_with("#EXTINF:"), "a PDT must anchor a segment");
            }
        }
    }

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
        let o = Origin::new(2_000);
        assert_eq!(o.disc_seq(), 0, "nothing has left yet");
        for i in 0..12 {
            let mut s = seg(i, 500);
            s.discontinuity = i == 1 || i == 2;
            o.push(s);
        }
        assert!(o.ring_depth() < 12, "the cap must have evicted something for this to test anything");
        assert_eq!(o.disc_seq(), 2, "both evicted tags counted, the surviving segments' tags not");
    }

    #[test]
    fn discontinuity_sequence_never_decreases_across_a_ring_reset() {
        let o = Origin::new(1_000_000);
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
        assert!(render(&window(3, &[])).contains("#EXT-X-DISCONTINUITY-SEQUENCE:0"));
        let m = render_media_playlist(&window(2, &[]), 5.0, "/api/ext/v1", "s", "e", 0, None, None, 42, Lane::Video);
        assert!(m.contains("#EXT-X-DISCONTINUITY-SEQUENCE:42"));
    }

    #[test]
    fn target_duration_is_an_integer_ceiling_of_the_longest_segment() {
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
        let t = SystemTime::UNIX_EPOCH + Duration::from_millis(1_785_931_853_433);
        assert_eq!(fmt_rfc3339(t), "2026-08-05T12:10:53.433Z");
        assert_eq!(fmt_rfc3339(SystemTime::UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let leap = SystemTime::UNIX_EPOCH + Duration::from_secs(1_709_164_800);
        assert_eq!(fmt_rfc3339(leap), "2024-02-29T00:00:00.000Z");
    }

    #[test]
    fn first_segment_ever_is_not_a_boundary() {
        assert_eq!(boundary_before(&PrevSeg::default(), &segref("s0.ts", None, false), 0), None);
    }


    #[test]
    fn a_re_signed_window_that_still_lists_our_next_segment_continues_the_ring() {
        assert_eq!(rejoin(false, false, true, 4, 104, Some((102, 4))), Rejoin::Continue);
        assert_eq!(rejoin(false, false, true, 4, 104, Some((104, 4))), Rejoin::Continue);
        assert_eq!(rejoin(false, false, true, 4, 104, Some((102, 2))), Rejoin::Continue);
    }

    #[test]
    fn a_window_that_slid_a_little_past_us_continues_and_the_hole_is_still_marked() {
        assert_eq!(rejoin(false, false, true, 6, 104, Some((110, 4))), Rejoin::Continue);
        let kept = PrevSeg { upstream_seq: Some(103) };
        assert_eq!(
            boundary_before(&kept, &segref("/seg/110", None, false), 110),
            Some(Boundary::SequenceGap),
            "the kept prev is what turns the slide into an honest gap"
        );
        assert_eq!(rejoin(false, false, true, 6, 104, Some((104 + MAX_CONTINUITY_GAP, 4))), Rejoin::Continue);
        assert_eq!(rejoin(false, false, true, 6, 104, Some((105 + MAX_CONTINUITY_GAP, 4))), Rejoin::Reset);
    }

    #[test]
    fn a_window_renumbered_below_us_resets_instead_of_being_skipped_as_held() {
        assert_eq!(rejoin(false, false, true, 4, 104, Some((10, 4))), Rejoin::Reset);
        assert_eq!(rejoin(false, false, true, 4, 104, Some((101, 2))), Rejoin::Reset);
    }

    #[test]
    fn a_retired_provider_or_an_unproven_timeline_never_continues_the_ring() {
        assert_eq!(rejoin(false, true, true, 4, 104, Some((102, 4))), Rejoin::Reset, "the provider was retired");
        assert_eq!(rejoin(false, false, false, 4, 104, Some((102, 4))), Rejoin::Reset, "not provably the same timeline");
        assert_eq!(rejoin(false, false, true, 4, -1, Some((102, 4))), Rejoin::Reset, "no sequence anchor to continue from");
        assert_eq!(rejoin(false, false, true, 4, 104, None), Rejoin::Reset, "a bare TS socket has no window to continue");
    }

    fn listing(ms: i64, uris: &[&str]) -> crate::tsmux::MediaPlaylist {
        let mut body = format!("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:{ms}\n");
        for u in uris {
            body.push_str(&format!("#EXTINF:4.0,\n{u}\n"));
        }
        parse_media_playlist(&body)
    }

    #[test]
    fn overlap_evidence_compares_what_both_windows_list_by_path_not_by_number() {
        let base = Url::parse("https://cdn.example.test/live/index.m3u8?token=fresh").unwrap();
        let held: VecDeque<(i64, String)> =
            [(102, "/live/s102.ts"), (103, "/live/s103.ts")].into_iter().map(|(s, p)| (s, p.to_string())).collect();
        let re_signed = listing(102, &["s102.ts?sig=b", "s103.ts?sig=b", "s104.ts?sig=b"]);
        assert_eq!(overlap_evidence(&held, &base, &re_signed), Some(true), "the query churns, the media does not");
        assert_eq!(overlap_evidence(&held, &base, &listing(102, &["x902.ts", "x903.ts"])), Some(false), "other media, same numbers");
        assert_eq!(overlap_evidence(&held, &base, &listing(102, &["s102.ts", "x903.ts"])), Some(false), "one disagreement is enough");
        assert_eq!(overlap_evidence(&held, &base, &listing(104, &["s104.ts"])), None, "nothing both know");
        let moved = Url::parse("https://cdn.example.test/session9/index.m3u8").unwrap();
        assert_eq!(
            overlap_evidence(&held, &moved, &listing(102, &["s102.ts", "s103.ts"])),
            Some(false),
            "the same relative names under another base are other media"
        );
    }

    #[test]
    fn a_walk_keeps_its_pace_until_it_wraps_and_only_then_backs_off_toward_the_cap() {
        let (zero, base) = (Duration::ZERO, FAILURE_BACKOFF_BASE);
        let mut walk = Backoff::default();
        let first_pass: Vec<Duration> = (0..6).map(|_| walk.fail_walk(false)).collect();
        assert_eq!(first_pass, vec![zero, base, base, base, base, base], "six failures across the candidates");
        assert_eq!(walk.fail_walk(true), FAILURE_BACKOFF_CAP, "wrapped: the streak's own doubling, which is past the cap by now");

        let mut single = Backoff::default();
        let waits: Vec<Duration> = [false, false, true, true, true].into_iter().map(|w| single.fail_walk(w)).collect();
        assert_eq!(waits, vec![zero, base, 2 * base, 4 * base, 8 * base], "one immediate retry, one step, then the doubling");
        single.succeed();
        assert_eq!(single.fail_walk(true), zero, "media resets it like any streak");
    }

    #[test]
    fn a_renewal_keeps_its_own_path_and_an_empty_ring_simply_re_anchors() {
        assert_eq!(rejoin(true, false, true, 4, 104, Some((102, 4))), Rejoin::Renewal);
        assert_eq!(rejoin(false, false, true, 0, 104, Some((102, 4))), Rejoin::Anchor);
        assert_eq!(rejoin(true, false, true, 0, 104, Some((10, 4))), Rejoin::Anchor);
        assert_eq!(rejoin(false, true, false, 0, -1, None), Rejoin::Anchor, "even a failover onto a bare socket");
    }

    #[test]
    fn a_forced_reset_boundary_is_always_published() {
        let fresh = crate::tsnorm::Splicer::new();
        assert!(!fresh.has_timeline(), "precondition: a reset splicer has no clock to join");
        assert!(publishes_discontinuity(Some(Boundary::Reset), true, fresh.has_timeline()), "normalised but not joined");
        assert!(publishes_discontinuity(Some(Boundary::Reset), false, false), "declined");
        assert!(!publishes_discontinuity(Some(Boundary::SequenceGap), true, true), "absorbed onto a live clock");
        assert!(!publishes_discontinuity(None, false, false), "no boundary, no tag");
    }

    #[test]
    fn the_window_after_a_reset_opens_on_a_discontinuity_with_exact_sequences() {
        let o = Origin::new(1_000_000);
        for i in 0..4 {
            let s = o.next_seq.fetch_add(1, Ordering::Relaxed);
            let mut seg = seg(s as usize, 100);
            seg.discontinuity = i == 2;
            o.push(seg);
        }
        o.reset_ring();
        for i in 0..3 {
            let s = o.next_seq.fetch_add(1, Ordering::Relaxed);
            let boundary = if i == 0 { Some(Boundary::Reset) } else { None };
            o.push(Segment { discontinuity: publishes_discontinuity(boundary, false, false), ..seg(s as usize, 100) });
        }
        let (disc_seq, w) = window_snapshot(&o);
        assert_eq!(disc_seq, 1, "the dropped window's one tag left the playlist with it");
        let m = render_media_playlist(&w, 5.0, "/api/v1", "zl", "zl://abc", o.generation(), None, None, disc_seq, Lane::Video);
        let lines: Vec<&str> = m.lines().collect();
        assert!(m.contains("#EXT-X-MEDIA-SEQUENCE:4"), "our sequence continues across the reset:\n{m}");
        assert!(m.contains("#EXT-X-DISCONTINUITY-SEQUENCE:1"), "and the discontinuity sequence is exact:\n{m}");
        let tag = lines.iter().position(|l| *l == "#EXT-X-DISCONTINUITY").expect("the join is tagged");
        let first_inf = lines.iter().position(|l| l.starts_with("#EXTINF:")).unwrap();
        assert!(tag < first_inf, "the tag precedes the FIRST segment of the new window:\n{m}");
        assert_eq!(lines.iter().filter(|l| **l == "#EXT-X-DISCONTINUITY").count(), 1, "and only that one");
        assert!(lines[tag + 1].starts_with("#EXT-X-PROGRAM-DATE-TIME:"), "re-anchored in wall-clock time too");
    }


    #[test]
    fn the_backoff_retries_once_at_once_then_doubles_to_its_cap_and_resets_on_media() {
        let mut b = Backoff::default();
        let waits: Vec<u64> = (0..9).map(|_| b.fail().as_secs()).collect();
        assert_eq!(waits, vec![0, 2, 4, 8, 16, 32, 60, 60, 60]);
        b.succeed();
        assert_eq!(b.fail(), Duration::ZERO, "a fresh streak starts with the immediate retry again");
        assert_eq!(b.fail(), FAILURE_BACKOFF_BASE);
        let mut long = Backoff { failures: u32::MAX - 1 };
        assert_eq!(long.fail(), FAILURE_BACKOFF_CAP);
        assert_eq!(long.fail(), FAILURE_BACKOFF_CAP);
    }

    #[test]
    fn a_target_with_an_expiry_is_renewed_a_lead_ahead_of_it_and_never_in_a_hot_loop() {
        let now = Instant::now();
        const NOW_MS: u64 = 1_786_000_000_000;
        let lead = PROACTIVE_REFRESH_LEAD.as_millis() as u64;
        let floor = MIN_PROACTIVE_REFRESH.as_millis() as u64;
        let at = |exp: u64| proactive_refresh_at(exp, NOW_MS, now).expect("representable").duration_since(now);
        assert_eq!(at(NOW_MS + 9_000_000), Duration::from_secs(9_000) - PROACTIVE_REFRESH_LEAD, "a fresh zlive token");
        assert_eq!(at(NOW_MS + lead + 2 * floor), 2 * MIN_PROACTIVE_REFRESH, "just past the floor: the lead governs");
        assert_eq!(at(NOW_MS + lead + floor / 2), MIN_PROACTIVE_REFRESH, "inside lead + floor: the floor wins");
        assert_eq!(at(NOW_MS + 1_000), MIN_PROACTIVE_REFRESH, "already inside the lead");
        assert_eq!(at(NOW_MS - 5_000), MIN_PROACTIVE_REFRESH, "already lapsed — the reactive path has it; still no hot loop");
    }

    #[test]
    fn every_ingest_read_is_bounded_even_with_no_read_timeout_configured() {
        let unset = ingest_io(0, 0.0);
        assert_eq!(unset.body, MIN_INGEST_IO);
        assert_eq!(unset.header_ms, MIN_INGEST_IO.as_millis() as u64, "unset used to mean forever");
        assert_eq!(ingest_io(0, 6.0).body, Duration::from_secs(18), "three target durations");
        let set = ingest_io(25_000, 4.0);
        assert_eq!(set.body, Duration::from_secs(25), "the operator's bound when it is the larger");
        assert_eq!(set.header_ms, 25_000, "and exactly the operator's for headers");
        assert_eq!(ingest_io(0, 1e12).body, Duration::from_secs_f64(MAX_INGEST_IO_TD_SECS));
        assert_eq!(ingest_io(0, f64::INFINITY).body, MIN_INGEST_IO);
        assert_eq!(ingest_io(0, f64::NAN).body, MIN_INGEST_IO);
        assert_eq!(ingest_io(0, -4.0).body, MIN_INGEST_IO);
    }


    #[tokio::test]
    async fn a_refused_origin_answers_its_waiters_at_once_rather_than_after_the_ready_timeout() {
        let o = Arc::new(Origin::new(10_000));
        let parked = {
            let o = o.clone();
            tokio::spawn(async move {
                let t = Instant::now();
                (wait_ready(&o, "t").await, t.elapsed())
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        o.mark_refused("ZLive already has 2 of 2 allowed concurrent stream(s) live".to_string());
        let (ready, took) = parked.await.unwrap();
        assert!(matches!(ready, Ready::Refused(ref m) if m.contains("2 of 2")), "the waiter is told why");
        assert!(took < Duration::from_secs(5), "answered at once, not after {READY_TIMEOUT:?} (took {took:?})");
        for i in 0..MIN_SEGMENTS {
            o.push(seg(i, 100));
        }
        assert!(matches!(wait_ready(&o, "t").await, Ready::Refused(_)));
    }


    use crate::testkit::{media_playlist, tag_of, tagged_ts, undecodable_playlist, until, Mock, Seam, Serve};

    fn viewer() -> crate::proxy::Identity {
        crate::proxy::Identity { ip: "127.0.0.1".into(), ua: "test".into(), username: None }
    }

    async fn ingesting(seam: Seam, first: &str, body: String) -> (Mock, AppState, OriginLease, Arc<Origin>) {
        let up = Mock::start(seam).await;
        up.script(|s| {
            s.paths.insert(first.to_string(), Serve::Body(body));
        });
        let state = up.state();
        let Ok((policy, _)) = state.resolve_entry("zl", "zl://abc", None).await else {
            panic!("the stand-in's seam grants");
        };
        let lease = subscribe(&state, "zl", "zl://abc", None, &policy);
        let origin = lease.origin().clone();
        (up, state, lease, origin)
    }

    #[tokio::test]
    async fn a_lapsed_token_rejoins_the_same_timeline_without_dropping_the_ring() {
        let (up, _state, _lease, o) = ingesting(Seam::grant("/pl/a.m3u8", true), "/pl/a.m3u8", media_playlist(100, 4, 1)).await;
        until(Duration::from_secs(10), "the first window rings", || o.ring_depth() >= 4).await;
        let generation = o.generation();

        up.script(|s| {
            s.paths.insert("/pl/a.m3u8".into(), Serve::Status(403));
            s.paths.insert("/pl/b.m3u8".into(), Serve::Body(media_playlist(102, 4, 1)));
            s.seam = Seam::grant("/pl/b.m3u8", true);
        });
        until(Duration::from_secs(10), "the re-signed window continues the ring", || o.ring_depth() >= 6).await;

        let w = o.window();
        assert_eq!(o.generation(), generation, "no reset: every segment URL a client holds stays valid");
        assert_eq!(
            w.iter().map(|s| tag_of(&s.bytes)).collect::<Vec<_>>(),
            (100..106).collect::<Vec<u64>>(),
            "the overlap (102, 103) is deduped by sequence, not replayed"
        );
        assert!(w.iter().all(|s| !s.discontinuity), "one continuous timeline carries no splice");
        assert_eq!(up.resolves(), 3, "the entry's resolve, the ingest's first, and exactly one renewal");
        let reasons: Vec<Option<String>> = up.calls().into_iter().map(|c| c.reason).collect();
        assert_eq!(reasons, vec![None, None, Some(crate::state::RETIRE_REFRESH_FAILED.to_string())]);
    }

    #[tokio::test]
    async fn an_overlapping_window_of_other_media_resets_rather_than_being_spliced_on_by_number() {
        let (up, _state, _lease, o) = ingesting(Seam::grant("/pl/a.m3u8", true), "/pl/a.m3u8", media_playlist(100, 4, 1)).await;
        until(Duration::from_secs(10), "the first window rings", || o.ring_depth() >= 4).await;
        let generation = o.generation();

        let mut other = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:102\n".to_string();
        for t in 902..906u64 {
            other.push_str(&format!("#EXTINF:1.000,\n/pl/x{t}.ts\n"));
        }
        up.script(|s| {
            s.paths.insert("/pl/a.m3u8".into(), Serve::Status(403));
            s.paths.insert("/pl/b.m3u8".into(), Serve::Body(other));
            for t in 902..906u64 {
                s.paths.insert(format!("/pl/x{t}.ts"), Serve::Media(tagged_ts(t)));
            }
            s.seam = Seam::grant("/pl/b.m3u8", true);
        });
        until(Duration::from_secs(10), "the other media lands on a reset ring", || {
            o.generation() != generation && o.ring_depth() >= 4
        })
        .await;

        let w = o.window();
        assert_eq!(w.iter().map(|s| tag_of(&s.bytes)).collect::<Vec<_>>(), vec![902, 903, 904, 905]);
        assert!(w[0].discontinuity, "the join is marked");
    }

    #[tokio::test]
    async fn an_escalation_that_wraps_back_to_the_same_candidate_keeps_the_ring() {
        let (up, _state, _lease, o) = ingesting(Seam::grant("/pl/a.m3u8", true), "/pl/a.m3u8", media_playlist(100, 4, 1)).await;
        up.script(|s| s.exhaust_advances = true);
        until(Duration::from_secs(10), "the first window rings", || o.ring_depth() >= 4).await;
        let generation = o.generation();
        let before = up.calls().len();

        up.script(|s| {
            s.paths.insert("/pl/a.m3u8".into(), Serve::Status(403));
            s.paths.insert("/pl/b.m3u8".into(), Serve::Status(403));
            s.seam = Seam::grant("/pl/b.m3u8", true);
        });
        until(Duration::from_secs(10), "the immediate re-resolve", || up.calls().len() > before).await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        up.script(|s| {
            s.paths.insert("/pl/b.m3u8".into(), Serve::Body(media_playlist(102, 4, 1)));
        });
        until(Duration::from_secs(10), "media flows again after the escalation", || {
            o.ring_depth() >= 6 || o.generation() != generation
        })
        .await;

        let w = o.window();
        assert_eq!(o.generation(), generation, "the ring survives the wrap");
        assert_eq!(w.iter().map(|s| tag_of(&s.bytes)).collect::<Vec<_>>(), (100..106).collect::<Vec<u64>>());
        assert!(w.iter().all(|s| !s.discontinuity), "one timeline throughout");
        let asked: Vec<(u32, Option<String>)> = up.calls()[before..].iter().map(|c| (c.attempt, c.reason.clone())).collect();
        let (refresh, rejected) = (crate::state::RETIRE_REFRESH_FAILED.to_string(), crate::state::RETIRE_TARGET_REJECTED.to_string());
        assert_eq!(
            asked,
            vec![(0, Some(refresh)), (1, Some(rejected.clone())), (0, Some(rejected))],
            "the refresh failure, then the refused target — carried through the escalation's fold-back"
        );
    }

    #[tokio::test]
    async fn a_failover_walk_reaches_later_candidates_at_its_old_pace() {
        let up = Mock::start(Seam::grant("/pl/a.m3u8", true)).await;
        let state = up.state();
        let Ok((policy, _)) = state.resolve_entry("zl", "zl://abc", None).await else {
            panic!("the stand-in's seam grants");
        };
        up.script(|s| s.seam = Seam::Reply(502, r#"{"error":"resolve_failed"}"#.into()));
        let started = Instant::now();
        let _lease = subscribe(&state, "zl", "zl://abc", None, &policy);
        until(Duration::from_secs(10), "the second backup is asked", || up.calls().iter().any(|c| c.attempt == 2)).await;
        assert!(started.elapsed() < Duration::from_secs(9), "asked after {:?}", started.elapsed());
    }

    #[tokio::test]
    async fn a_dead_single_candidate_channel_backs_off_once_its_walk_wraps() {
        let up = Mock::start(Seam::grant("/pl/a.m3u8", true)).await;
        let state = up.state();
        let Ok((policy, _)) = state.resolve_entry("zl", "zl://abc", None).await else {
            panic!("the stand-in's seam grants");
        };
        let before = up.calls().len();
        up.script(|s| {
            s.seam = Seam::Reply(502, r#"{"error":"resolve_failed"}"#.into());
            s.exhaust_advances = true;
        });
        let _lease = subscribe(&state, "zl", "zl://abc", None, &policy);
        until(Duration::from_secs(10), "five resolves", || up.calls().len() >= before + 5).await;
        let calls = up.calls()[before..before + 5].to_vec();
        assert_eq!(calls.iter().map(|c| c.attempt).collect::<Vec<_>>(), vec![0, 0, 1, 0, 0], "retry, step, 410, fold back, retry");
        let after_wrap = calls[4].at - calls[3].at;
        assert!(after_wrap >= Duration::from_millis(3500), "the wrapped walk backs off ({after_wrap:?}), not another 2 s");
    }

    #[tokio::test]
    async fn a_finite_ts_entry_is_paced_as_a_failure_not_reconnected_in_a_hot_loop() {
        let up = Mock::start(Seam::grant("/pl/clip.ts", true)).await;
        up.script(|s| {
            s.paths.insert("/pl/clip.ts".into(), Serve::Media(crate::tsseg::tuner_ts(20)));
        });
        let state = up.state();
        let Ok((policy, _)) = state.resolve_entry("zl", "zl://abc", None).await else {
            panic!("the stand-in's seam grants");
        };
        let before = up.resolves();
        let lease = subscribe(&state, "zl", "zl://abc", None, &policy);
        let o = lease.origin().clone();
        until(Duration::from_secs(5), "the clip is cut into the ring", || o.ring_depth() >= 3).await;
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(up.resolves() - before, 1, "one session, then a pause — not a resolve per spin");
    }

    #[test]
    fn a_raw_session_is_a_reconnect_only_when_its_media_ran_as_long_as_a_live_socket_does() {
        let s = |produced, span_ms, min_ms| RawSession {
            produced,
            media_span: Duration::from_millis(span_ms),
            min_session: Duration::from_millis(min_ms),
            idle: false,
        };
        assert_eq!(raw_verdict(&s(40, 3_600_000, 15_000)), RawVerdict::Reconnect, "an hour of media, then an end");
        assert_eq!(raw_verdict(&s(3, 15_000, 15_000)), RawVerdict::Reconnect, "exactly the bar");
        assert_eq!(raw_verdict(&s(4, 900, 15_000)), RawVerdict::Short, "a finite clip");
        assert_eq!(raw_verdict(&s(1, 20, 15_000)), RawVerdict::Short, "a few packets, then silence");
        assert_eq!(raw_verdict(&s(0, 0, 15_000)), RawVerdict::NotMedia, "nothing that cuts");
    }

    #[tokio::test]
    async fn a_socket_that_goes_silent_is_judged_by_the_media_it_carried_not_by_the_wait() {
        let up = Mock::start(Seam::grant("/pl/x.ts", true)).await;
        let ctx = raw_ctx(&up);
        ctx.origin.target_duration_ms.store(1000, Ordering::Relaxed);
        let ts = crate::tsseg::tuner_ts(3);
        let half = ts.len() / crate::tsseg::PKT / 2 * crate::tsseg::PKT;
        let rest: Vec<reqwest::Result<Bytes>> = vec![Ok(Bytes::copy_from_slice(&ts[half..]))];
        let stream: std::pin::Pin<Box<dyn tokio_stream::Stream<Item = reqwest::Result<Bytes>> + Send>> =
            Box::pin(tokio_stream::iter(rest).chain(tokio_stream::pending()));

        let opened = Instant::now();
        let s = ingest_raw_ts(&ctx, "t", stream, Bytes::copy_from_slice(&ts[..half]), 0, false).await;
        assert!(opened.elapsed() >= s.min_session, "it ended on the silence bound, after {:?}", opened.elapsed());
        assert!(s.produced >= 1, "what arrived was cut into the ring");
        assert!(s.media_span < Duration::from_secs(1), "media flowed for {:?}; the wait is not part of it", s.media_span);
        assert_eq!(raw_verdict(&s), RawVerdict::Short, "a failure, not a reconnect");
    }

    fn raw_ctx(up: &Mock) -> IngestCtx {
        IngestCtx {
            state: up.state(),
            origin: Arc::new(Origin::new(10_000)),
            source: "zl".into(),
            entry: "zl://abc".into(),
            pl: None,
            key: "zl|zl://abc".into(),
        }
    }

    #[tokio::test]
    async fn a_streaming_socket_with_nobody_subscribed_ends_on_the_idle_check() {
        let up = Mock::start(Seam::grant("/pl/x.ts", true)).await;
        let endless = || -> std::pin::Pin<Box<dyn tokio_stream::Stream<Item = reqwest::Result<Bytes>> + Send>> {
            let unit = Bytes::from(crate::tsseg::tuner_ts(1));
            Box::pin(tokio_stream::iter(std::iter::repeat_with(move || Ok(unit.clone()))).throttle(Duration::from_millis(20)))
        };
        let long_ago = Instant::now().checked_sub(IDLE_GRACE + Duration::from_secs(1)).expect("a monotonic clock that old");
        let first = || Bytes::from(crate::tsseg::tuner_ts(1));

        let watched = raw_ctx(&up);
        watched.origin.subscribers.store(1, Ordering::Relaxed);
        *watched.origin.last_access.lock_ok() = long_ago;
        let still = tokio::time::timeout(IDLE_TICK + Duration::from_secs(1), ingest_raw_ts(&watched, "t", endless(), first(), 0, false)).await;
        assert!(still.is_err(), "a watched socket keeps streaming");

        let left = raw_ctx(&up);
        *left.origin.last_access.lock_ok() = long_ago;
        let ended = tokio::time::timeout(IDLE_TICK * 2 + Duration::from_secs(1), ingest_raw_ts(&left, "t", endless(), first(), 0, false))
            .await
            .expect("the session ends once nobody is left to feed");
        assert!(ended.idle, "and says it went idle, so the ingest stops rather than reconnecting");
        assert!(ended.produced > 0, "it was carrying media right up to then");
    }

    #[tokio::test]
    async fn the_first_cut_after_a_raw_reconnect_is_marked_as_a_discontinuity() {
        let up = Mock::start(Seam::grant("/pl/tuner.ts", true)).await;
        up.script(|s| {
            s.paths.insert("/pl/tuner.ts".into(), Serve::Media(crate::tsseg::tuner_ts(20)));
        });
        let state = up.state();
        let Ok((policy, _)) = state.resolve_entry("zl", "zl://abc", None).await else {
            panic!("the stand-in's seam grants");
        };
        let lease = subscribe(&state, "zl", "zl://abc", None, &policy);
        let o = lease.origin().clone();
        until(Duration::from_secs(5), "the first session rings", || o.ring_depth() >= 3).await;
        let generation = o.generation();
        until(Duration::from_secs(10), "the reconnect's reset ring refills", || {
            o.generation() != generation && o.ring_depth() >= 3
        })
        .await;

        let (disc_seq, w) = window_snapshot(&o);
        assert!(w[0].discontinuity, "the reconnect's first cut carries the splice");
        assert!(w[1..].iter().all(|s| !s.discontinuity), "…and only that one");
        let m = render_media_playlist(&w, 5.0, "/api/v1", "zl", "zl://abc", o.generation(), None, None, disc_seq, Lane::Video);
        let first_inf = m.find("#EXTINF:").expect("segments");
        assert!(m[..first_inf].contains("#EXT-X-DISCONTINUITY\n"), "published ahead of the first segment:\n{m}");
    }

    #[tokio::test]
    async fn a_re_resolve_that_cannot_continue_resets_the_ring_and_marks_the_join() {
        let (up, _state, _lease, o) = ingesting(Seam::grant("/pl/a.m3u8", true), "/pl/a.m3u8", media_playlist(100, 4, 1)).await;
        until(Duration::from_secs(10), "the first window rings", || o.ring_depth() >= 4).await;
        let generation = o.generation();

        up.script(|s| {
            s.paths.insert("/pl/a.m3u8".into(), Serve::Status(403));
            s.paths.insert("/pl/c.m3u8".into(), Serve::Body(media_playlist(900, 4, 1)));
            s.seam = Seam::grant("/pl/c.m3u8", true);
        });
        until(Duration::from_secs(10), "a fresh window after the reset", || {
            o.generation() != generation && o.ring_depth() >= 4
        })
        .await;

        let w = o.window();
        assert_eq!(w.iter().map(|s| tag_of(&s.bytes)).collect::<Vec<_>>(), (900..904).collect::<Vec<u64>>());
        assert!(w[0].discontinuity, "the first segment after the reset carries the splice");
        assert!(w[1..].iter().all(|s| !s.discontinuity), "…and only that one");
        assert_eq!(w[0].seq, 4, "our own sequence carries straight on from the dropped window");
    }

    fn expiring_grant(path: &str) -> Seam {
        let soon = crate::state::epoch_ms() + PROACTIVE_REFRESH_LEAD.as_millis() as u64 + 600;
        Seam::Grant { path: path.to_string(), origin: true, expires_at_ms: Some(soon), extra: serde_json::Value::Null }
    }

    #[tokio::test]
    async fn a_target_is_renewed_ahead_of_its_expiry_and_the_ring_carries_on_across_it() {
        let (up, _state, _lease, o) =
            ingesting(expiring_grant("/pl/a.m3u8"), "/pl/a.m3u8", media_playlist(100, 4, 1)).await;
        until(Duration::from_secs(10), "the first window rings", || o.ring_depth() >= 4).await;
        let generation = o.generation();

        up.script(|s| {
            s.paths.insert("/pl/b.m3u8".into(), Serve::Body(media_playlist(102, 4, 1)));
            s.seam = Seam::grant("/pl/b.m3u8", true);
        });
        until(Duration::from_secs(10), "the renewed target continues the ring", || o.ring_depth() >= 6).await;

        let w = o.window();
        assert_eq!(o.generation(), generation, "a renewal is not a reset");
        assert_eq!(w.iter().map(|s| tag_of(&s.bytes)).collect::<Vec<_>>(), (100..106).collect::<Vec<u64>>());
        assert!(w.iter().all(|s| !s.discontinuity));
        assert_eq!(up.resolves(), 3, "the entry's resolve, the ingest's first, and the one renewal");
        assert!(
            up.calls().iter().all(|c| c.reason.is_none()),
            "a scheduled renewal asks for no fresh target — the current one is still good, and a cached answer is right"
        );
    }

    #[tokio::test]
    async fn a_renewal_that_cannot_resolve_keeps_following_the_target_it_would_replace() {
        let (up, _state, _lease, o) =
            ingesting(expiring_grant("/pl/a.m3u8"), "/pl/a.m3u8", media_playlist(100, 4, 1)).await;
        until(Duration::from_secs(10), "the first window rings", || o.ring_depth() >= 4).await;
        let generation = o.generation();

        up.script(|s| {
            s.seam = Seam::Reply(502, r#"{"error":"resolve_failed"}"#.into());
            s.paths.insert("/pl/a.m3u8".into(), Serve::Body(media_playlist(100, 6, 1)));
        });
        until(Duration::from_secs(10), "a failed renewal, and the current target's new segments", || {
            up.resolves() >= 3 && o.ring_depth() >= 6
        })
        .await;
        assert_eq!(o.generation(), generation, "a failed renewal costs the ring nothing");
        assert_eq!(o.window().iter().map(|s| tag_of(&s.bytes)).collect::<Vec<_>>(), (100..106).collect::<Vec<u64>>());

        up.script(|s| {
            s.paths.insert("/pl/b.m3u8".into(), Serve::Body(media_playlist(104, 4, 1)));
            s.seam = Seam::grant("/pl/b.m3u8", true);
        });
        until(Duration::from_secs(10), "the renewed target continues the ring", || o.ring_depth() >= 8).await;
        let w = o.window();
        assert_eq!(o.generation(), generation);
        assert_eq!(w.iter().map(|s| tag_of(&s.bytes)).collect::<Vec<_>>(), (100..108).collect::<Vec<u64>>());
        assert!(w.iter().all(|s| !s.discontinuity), "one timeline throughout");
    }

    #[tokio::test]
    async fn a_failover_child_is_judged_by_its_own_capability_not_its_parents() {
        let parent = serde_json::json!({ "playerSelectable": true });
        let up = Mock::start(Seam::grant_with("/pl/a.m3u8", parent)).await;
        let state = up.state();
        let Ok((policy, _)) = state.resolve_entry("zl", "zl://abc", None).await else {
            panic!("the stand-in's seam grants");
        };
        assert!(policy.player_selectable.load(Ordering::Relaxed), "precondition: the MOUNT policy watches");

        let child = serde_json::json!({ "playerSelectable": false, "policySource": "child" });
        up.script(|s| {
            s.seam = Seam::grant_with("/pl/a.m3u8", child);
            s.paths.insert("/pl/a.m3u8".into(), Serve::Body(undecodable_playlist(100, 4, 1)));
        });
        let lease = subscribe(&state, "zl", "zl://abc", None, &policy);
        let o = lease.origin().clone();
        until(Duration::from_secs(10), "every striking segment rings", || o.ring_depth() >= 4).await;
        assert_eq!(o.last_suspect.read_ok().as_deref(), None, "nothing was retired");
        assert_eq!(up.resolves(), 2, "no escalation: the entry's resolve and the ingest's first, nothing more");
    }

    #[tokio::test]
    async fn the_same_segments_retire_a_serving_candidate_that_is_player_selectable() {
        let (_up, _state, _lease, o) = ingesting(
            Seam::grant_with("/pl/a.m3u8", serde_json::json!({ "playerSelectable": true })),
            "/pl/a.m3u8",
            undecodable_playlist(100, 4, 1),
        )
        .await;
        until(Duration::from_secs(10), "the watch retires the upstream", || o.suspect_retires.load(Ordering::Relaxed) >= 1).await;
        assert_eq!(o.last_suspect.read_ok().as_deref(), Some(crate::tsseg::Suspect::NoVideoParameterSets.slug()));
    }

    #[tokio::test]
    async fn a_failover_child_under_a_mount_with_no_policy_is_followed_on_its_own() {
        let child = serde_json::json!({ "policySource": "child" });
        let up = Mock::start(Seam::grant_with("/pl/a.m3u8", child)).await;
        up.script(|s| {
            s.paths.insert("/pl/a.m3u8".into(), Serve::Body(media_playlist(100, 4, 1)));
        });
        let state = up.state();
        let Ok((policy, _)) = state.resolve_entry("zl", "zl://abc", None).await else {
            panic!("the stand-in's seam grants");
        };
        assert!(state.get("zl").is_none(), "precondition: the mount source has no policy cell");
        let lease = subscribe(&state, "zl", "zl://abc", None, &policy);
        let o = lease.origin().clone();
        until(Duration::from_secs(10), "the child's window rings", || o.ring_depth() >= 4).await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(up.resolves(), 2, "the entry's resolve and the ingest's first — no re-resolve loop");
    }

    #[tokio::test]
    async fn a_refused_ingest_ends_and_the_client_is_answered_429_at_once() {
        let up = Mock::start(Seam::grant("/pl/a.m3u8", true)).await;
        up.script(|s| {
            s.paths.insert("/pl/a.m3u8".into(), Serve::Body(media_playlist(100, 4, 1)));
        });
        let state = up.state();
        let Ok((policy, _)) = state.resolve_entry("zl", "zl://abc", None).await else {
            panic!("the stand-in's seam grants");
        };
        let refusal = r#"{"error":"source_stream_cap","message":"ZLive already has 2 of 2 allowed concurrent stream(s) live"}"#;
        up.script(|s| s.seam = Seam::Reply(429, refusal.to_string()));

        let started = Instant::now();
        let resp = serve_entry(&state, &policy, "/api/v1", "zl", "zl://abc", None, None, &viewer(), "t")
            .await
            .expect("a refusal is an answer, not a fall-back to the rewrite path");
        assert_eq!(resp.status().as_u16(), 429);
        assert!(started.elapsed() < Duration::from_secs(5), "answered at once, not after {READY_TIMEOUT:?}");
        let body = axum::body::to_bytes(resp.into_body(), 1 << 16).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("2 of 2"), "the viewer is told why");

        let before = up.resolves();
        assert!(
            matches!(state.resolve_entry("zl", "zl://abc", None).await, Err(ResolveErr::Refused(_))),
            "the cached target was retired with the refusal"
        );
        assert_eq!(up.resolves(), before + 1, "…so the next request asked Node itself");
    }

    #[tokio::test]
    async fn a_raw_ts_join_opens_on_the_first_keyframe_while_the_ring_keeps_every_segment_whole() {
        use crate::tsseg::PKT;
        let (seg, cut) = crate::tsseg::mid_gop_segment();
        let up = Mock::start(Seam::grant("/pl/a.m3u8", true)).await;
        let playlist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n\
                        #EXTINF:1.0,\n/pl/g0.ts\n#EXTINF:1.0,\n/pl/g1.ts\n#EXTINF:1.0,\n/pl/g2.ts\n";
        up.script(|s| {
            s.paths.insert("/pl/a.m3u8".into(), Serve::Body(playlist.into()));
            for g in ["/pl/g0.ts", "/pl/g1.ts", "/pl/g2.ts"] {
                s.paths.insert(g.into(), Serve::Media(seg.clone()));
            }
        });
        let state = up.state();
        let Ok((policy, _)) = state.resolve_entry("zl", "zl://abc", None).await else {
            panic!("the stand-in's seam grants");
        };
        let resp = serve_ts(&state, &policy, "zl", "zl://abc", None, &viewer(), "t").await.expect("a ringable shape");
        assert_eq!(resp.status().as_u16(), 200);
        let mut socket = resp.into_body().into_data_stream();
        let join = socket.next().await.expect("a first segment").expect("readable");
        let after = socket.next().await.expect("a second segment").expect("readable");

        assert_eq!(join.len(), 2 * PKT + (seg.len() - cut), "the tables, then everything from the keyframe on");
        assert_eq!(crate::tsseg::first_keyframe(&join).map(|(at, _)| at), Some(2 * PKT), "…opening on the keyframe");
        assert_eq!(after.len(), seg.len(), "the segment after the join goes out whole");
        let ring = subscribe(&state, "zl", "zl://abc", None, &policy);
        assert!(ring.origin().window().iter().all(|s| s.bytes.len() == seg.len()), "the shared ring is never trimmed");
    }

    #[tokio::test]
    async fn after_a_ring_reset_the_next_segment_is_a_join_again() {
        use crate::tsseg::PKT;
        let (seg, cut) = crate::tsseg::mid_gop_segment();
        let up = Mock::start(Seam::grant("/pl/a.m3u8", true)).await;
        let listing = |ms: u32, names: &[&str]| {
            let mut p = format!("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:{ms}\n");
            for n in names {
                p.push_str(&format!("#EXTINF:1.0,\n/pl/{n}\n"));
            }
            p
        };
        up.script(|s| {
            s.paths.insert("/pl/a.m3u8".into(), Serve::Body(listing(0, &["g0.ts", "g1.ts", "g2.ts"])));
            for g in ["g0.ts", "g1.ts", "g2.ts", "h0.ts", "h1.ts", "h2.ts"] {
                s.paths.insert(format!("/pl/{g}"), Serve::Media(seg.clone()));
            }
        });
        let state = up.state();
        let Ok((policy, _)) = state.resolve_entry("zl", "zl://abc", None).await else {
            panic!("the stand-in's seam grants");
        };
        let resp = serve_ts(&state, &policy, "zl", "zl://abc", None, &viewer(), "t").await.expect("a ringable shape");
        let mut socket = resp.into_body().into_data_stream();
        let joined = 2 * PKT + (seg.len() - cut);
        let mut got = Vec::new();
        for _ in 0..3 {
            got.push(socket.next().await.expect("a held segment").expect("readable").len());
        }
        assert_eq!(got, vec![joined, seg.len(), seg.len()], "precondition: the join, then the window whole");

        up.script(|s| {
            s.paths.insert("/pl/a.m3u8".into(), Serve::Status(403));
            s.paths.insert("/pl/c.m3u8".into(), Serve::Body(listing(900, &["h0.ts", "h1.ts", "h2.ts"])));
            s.seam = Seam::grant("/pl/c.m3u8", true);
        });
        let after_reset = tokio::time::timeout(Duration::from_secs(10), socket.next())
            .await
            .expect("the new upstream's first segment")
            .expect("a chunk")
            .expect("readable");
        let next = socket.next().await.expect("the segment after it").expect("readable");
        assert_eq!(after_reset.len(), joined, "the new upstream's first segment opens on its keyframe");
        assert_eq!(crate::tsseg::first_keyframe(&after_reset).map(|(at, _)| at), Some(2 * PKT));
        assert_eq!(next.len(), seg.len(), "and only that one is trimmed");
    }

    #[tokio::test]
    async fn a_raw_ts_viewer_who_leaves_while_the_ring_is_quiet_releases_the_channel_at_once() {
        let up = Mock::start(Seam::grant("/pl/a.m3u8", true)).await;
        up.script(|s| {
            s.paths.insert("/pl/a.m3u8".into(), Serve::Body(media_playlist(100, 4, 1)));
        });
        let state = up.state();
        let Ok((policy, _)) = state.resolve_entry("zl", "zl://abc", None).await else {
            panic!("the stand-in's seam grants");
        };
        let resp = serve_ts(&state, &policy, "zl", "zl://abc", None, &viewer(), "t").await.expect("a ringable shape");
        let mut socket = resp.into_body().into_data_stream();
        for _ in 0..4 {
            socket.next().await.expect("a held segment").expect("readable");
        }
        let origin = state.origins().lock_ok().get(&crate::state::target_key("zl", "zl://abc")).cloned().expect("a live origin");
        assert_eq!(origin.subscribers.load(Ordering::Relaxed), 1, "the socket's producer holds the only lease");

        tokio::time::sleep(Duration::from_millis(200)).await;
        drop(socket);
        until(Duration::from_secs(3), "the departed viewer's lease is released", || {
            origin.subscribers.load(Ordering::Relaxed) == 0
        })
        .await;
    }
}
