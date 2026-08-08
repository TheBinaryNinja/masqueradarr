<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';
import Pill from '../components/Pill.vue';
import StatusDot from '../components/StatusDot.vue';
import SearchInput from '../components/SearchInput.vue';
import Segmented from '../components/Segmented.vue';
import ChannelLogo from '../components/ChannelLogo.vue';
import LivelineChart from '../components/LivelineChart.vue';
import { ACTIVE_STREAMS, CHANNELS, EPG_PROGRAMS, fetchProgramsFor, flagEmoji, type ActiveStream, type Program, type StreamClient } from '../data';
import { useStreamStats } from '../composables/useStreamStats';

// Live snapshot over the /api/stream-stats WebSocket (updates ACTIVE_STREAMS in place). Only show streams
// whose channelId resolves to a real channel in the global list.
const { subscribe, release, bitrateSeries, ingestAge, ingestMbps } = useStreamStats();
const liveStreams = computed(() => ACTIVE_STREAMS.value.filter((s) => CHANNELS.value.some((c) => c.id === s.channelId)));

const selId = ref<string | null>(null);
const filter = ref<'all' | 'live' | 'issues'>('all');
const search = ref('');
const viewing = ref<string | null>(null);
const playing = ref(true);
const muted = ref(false);

function chOf(s: ActiveStream) { return CHANNELS.value.find((c) => c.id === s.channelId)!; }

const filtered = computed(() => liveStreams.value.filter((s) => {
  if (filter.value === 'issues' && s.status === 'good') return false;
  if (filter.value === 'live' && s.status !== 'good') return false;
  if (search.value && !chOf(s).tvg_name.toLowerCase().includes(search.value.toLowerCase())) return false;
  return true;
}));
const sel = computed(() => liveStreams.value.find((s) => s.id === selId.value) || liveStreams.value[0]);
const totals = computed(() => ({
  streams: liveStreams.value.filter((s) => s.status !== 'bad').length,
  viewers: liveStreams.value.reduce((a, s) => a + s.viewers, 0),
  peak: liveStreams.value.reduce((a, s) => a + s.peakViewers, 0),
  bandwidth: liveStreams.value.reduce((a, s) => a + s.bandwidth, 0),
  issues: liveStreams.value.filter((s) => s.status !== 'good').length,
}));

// Decode metadata for a stream — MANIFEST-DECLARED only.
//
// The deep ffprobe snapshot (`ActiveStream.probe`) is never rebuilt: the server hardcodes it null since the
// video-engine teardown. The rows that used to be gated on it (pixel format, time base) could therefore
// never render, and are gone rather than left as permanently dead branches.
//
// These fields are also null on EVERY origin-backed channel: `kind:"media"` is emitted only from the
// passthrough rewrite path, and origin mode returns before reaching it. That is a real telemetry gap
// (register #9), not a decode failure — which is why the SOURCE pane labels the gap instead of showing a
// bare em-dash that reads as "this stream has no video".
function techOf(s: ActiveStream) {
  return {
    video: s.codec ?? '—',
    audio: s.audio ?? '—',
    container: s.container ?? '—',
    resolution: s.resolution ?? '—',
    fps: s.fps,
  };
}
const selTech = computed(() => (sel.value ? techOf(sel.value) : null));
const viewTech = computed(() => (viewStream.value ? techOf(viewStream.value) : null));

// External-client name from the User-Agent — a SOFT label only, used to enrich the "Player" pill. The
// session's player kind (appPlayer vs externalPlayer) is decided server-side by the request mount, never the UA.
function externalClientName(ua: string): string {
  const u = (ua || '').toLowerCase();
  if (u.includes('tivimate')) return 'TiviMate';
  if (u.includes('kodi')) return 'Kodi';
  if (u.includes('vlc')) return 'VLC';
  if (u.includes('exoplayer')) return 'ExoPlayer';
  if (u.includes('lavf') || u.includes('ffmpeg')) return 'ffmpeg';
  if (u.includes('coremedia') || u.includes('apple')) return 'Apple';
  if (u.includes('okhttp') || u.includes('dalvik')) return 'Android';
  return 'External';
}
// "Player" pill text for a connected viewer: In-App for the slide-out player, else the external client name.
function playerLabel(c: StreamClient): string {
  return c.playerType === 'externalPlayer' ? externalClientName(c.userAgent) : 'In-App';
}
// EFFECTIVE delivery format the proxy is serving RIGHT NOW — the observable truth behind the HLS/Raw-TS switch,
// and deliberately NOT the same as the "Container" decode label (which is the upstream segments' format, MPEG-TS
// either way). 'ts' = one continuous raw MPEG-TS socket (tsmux engaged); 'hls' = segmented HLS, which ALSO covers
// a Raw-TS request the sidecar fell back on (encrypted / fMP4 / unreachable upstream); 'mixed' = both at once.
// So: set Raw-TS, still see "HLS" here ⇒ it fell back (e.g. Pluto's AES-encrypted feeds).
function deliveryLabel(d: ActiveStream['delivery']): string {
  return d === 'ts' ? 'Raw TS' : d === 'mixed' ? 'Mixed (HLS + TS)' : 'HLS';
}

// Why something other than this channel's own default upstream is carrying it. attempt >= 1 means the data
// plane actually walked to it after a failed establish; attempt 0 means the very first resolve already
// landed elsewhere — for DaddyLive that is the player walk settling on a provider that still carries the
// channel, which is normal and worth seeing rather than an incident.
function failoverTitle(f: NonNullable<ActiveStream['failover']>): string {
  return f.attempt >= 1
    ? `This channel's upstream failed — ${f.candidateName} took over on attempt #${f.attempt}`
    : `This channel resolved through ${f.candidateName} rather than its default upstream`;
}

// Real rolling bitrate series from the WS ticks — finite samples only, never a fabricated flat/zero
// series (a zero value-range freezes the liveline chart). LivelineChart shows a placeholder until ≥2
// real samples arrive, so an empty/short series here is fine.
const selSeries = computed(() => {
  if (!sel.value) return [];
  return bitrateSeries(sel.value.id).filter(Number.isFinite);
});
const selTarget = computed(() => sel.value?.bitrate || 1);
// Avg/min/max guard the empty series (fall back to the current bitrate) — Math.min(...[]) is Infinity.
const selAvg = computed(() => {
  const s = selSeries.value;
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : (sel.value?.bitrate || 0);
});
const selMin = computed(() => (selSeries.value.length ? Math.min(...selSeries.value) : (sel.value?.bitrate || 0)));
const selMax = computed(() => (selSeries.value.length ? Math.max(...selSeries.value) : (sel.value?.bitrate || 0)));

// HUD header chrome — DERIVED from the selected stream so each stream renders its own stable barcode +
// code tags (reads as real per-stream telemetry, never a fixed brand decoration). seedFrom() is the
// FNV-1a 32-bit hash of a string; the barcode reuses the Dashboard's deterministic LCG (seeded from the
// stream id) returning {rects,width}; the two code tags are 2-letter (source) + a stable id-hashed
// number. All aria-hidden (decorative). Keyed off `sel` so they re-derive on selection change.
const seedFrom = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const headerBarcode = computed(() => {
  const rects: { x: number; w: number }[] = [];
  let seed = seedFrom(sel.value?.id ?? 'masq') || 1, x = 0, ink = true;
  while (x < 240) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const w = 2 + (seed % 5);
    if (ink) rects.push({ x, w });
    x += w;
    ink = !ink;
  }
  return { rects, width: x };
});
const codeTags = computed(() => {
  const ch = sel.value ? CHANNELS.value.find((c) => c.id === sel.value!.channelId) : undefined;
  const src = (ch?.source || 'mq').toUpperCase();
  const h = seedFrom(sel.value?.id ?? '');
  const a = `${src.slice(0, 2)}-${100 + (h % 900)}`;        // e.g. DU-417
  const b = `${src.slice(-2) || 'HL'}-${10 + ((h >>> 8) % 90)}`; // e.g. LO-62
  return [a, b];
});

const viewStream = computed(() => liveStreams.value.find((s) => s.id === viewing.value));

// Connected viewers for the selected channel — re-fetched on selection change + a slow interval, NOT on
// every WS snapshot (that fires ~1/sec and would starve the token guard below / flicker the list). A
// monotonic token discards a stale response — rapid switching can leave an older channel's fetch in
// flight that resolves after the newer one, which would otherwise paint the wrong channel's sessions.
const clients = ref<StreamClient[]>([]);
// WHICH channel `clients` describes. The rows are NOT cleared on a selection change — doing that on every
// 4s poll would flicker the table — so between selecting a channel and its response landing, `clients` still
// holds the PREVIOUS channel's sessions. That was harmless while only the table read it; it stopped being
// harmless once the OUTPUT stage derives its tone from `clients` (an old channel's warmed viewers against a
// new channel's zero bandwidth paints a red FAULT the design promises cannot happen). Every derived reader
// must therefore check this stamp, not just the array.
const clientsOf = ref<string | null>(null);
let clientsReq = 0;
let clientsTimer: number | undefined;
async function loadClients(id: string | undefined) {
  const my = ++clientsReq;
  if (!id) { clients.value = []; clientsOf.value = null; return; }
  try {
    const res = await fetch(`/api/active-streams/${encodeURIComponent(id)}/clients`);
    if (my !== clientsReq) return; // superseded by a newer selection
    if (res.ok) { clients.value = (await res.json()) as StreamClient[]; clientsOf.value = id; }
    // A non-ok response leaves the rows in place but INVALIDATES them: stale data must not keep answering
    // for a channel we could not read.
    else clientsOf.value = null;
  } catch { clientsOf.value = null; }
}
/** The session list, but only when it is known to describe the CURRENT selection. */
const selClients = computed(() => (sel.value && clientsOf.value === sel.value.id ? clients.value : null));
watch(() => sel.value?.id, (id) => loadClients(id), { immediate: true });

function onView() { if (!sel.value) return; viewing.value = sel.value.id; playing.value = sel.value.status !== 'bad'; muted.value = false; }
function close() { viewing.value = null; }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && viewing.value) close(); }
onMounted(() => { subscribe(); window.addEventListener('keydown', onKey); clientsTimer = window.setInterval(() => loadClients(sel.value?.id), 4000); });
onBeforeUnmount(() => { release(); window.removeEventListener('keydown', onKey); if (clientsTimer) clearInterval(clientsTimer); });

// Programs are stored epoch-ms — format an absolute epoch-ms time as local HH:MM.
function formatTime(ms: number) { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
// Resolve an active stream's channel to its guide key: the 2-factor EPG composite `${epg}:${tvg_id}`
// (= the Program.channelId) when linked, else the raw channel id as a fallback. Programs are no longer
// preloaded at boot, so this set is fetched lazily (see loadNowNext) — bounded to the live channels.
function npKey(channelId: string): string {
  const ch = CHANNELS.value.find((c) => c.id === channelId);
  return ch?.epg && ch.tvg_id ? `${ch.epg}:${ch.tvg_id}` : channelId;
}
function npData(channelId: string): { live?: Program; next?: Program } {
  const progs = EPG_PROGRAMS[npKey(channelId)] || [];
  const now = Date.now();
  const live = progs.find((p) => now >= p.start && now < p.end);
  const next = progs.find((p) => p.start >= (live ? live.end : now));
  return { live, next };
}

// Lazily load now/next guide for the (bounded) set of live channels — deduped by the channel-key set
// so a per-frame stats push doesn't refetch. Window: a little past → a few hours ahead (covers live + next).
const NP_HOUR_MS = 3_600_000;
let lastNpSig = '';
function loadNowNext(): void {
  const keys = [...new Set(liveStreams.value.map((s) => npKey(s.channelId)))];
  const sig = keys.slice().sort().join(',');
  if (!keys.length || sig === lastNpSig) return;
  lastNpSig = sig;
  const t = Date.now();
  void fetchProgramsFor(keys, t - NP_HOUR_MS, t + 3 * NP_HOUR_MS)
    .catch((err) => console.error('[active] now/next load failed:', err));
}
watch(liveStreams, loadNowNext, { immediate: true });

// Per-client display helpers.
function rateKB(bps: number) { return (bps / 1024).toFixed(0); }
function sinceLabel(ts: number) { const m = Math.floor((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; }
// S3/UND: the data plane sends a stable slug (so it can also be recorded against the burnt provider); this
// is the operator-facing wording. An unknown slug is shown verbatim rather than hidden — a newer sidecar
// reporting a fault this SPA has not learned yet must not silently disappear from the row.
function suspectLabel(slug: string): string {
  return {
    'undecodable-video': 'upstream video has no decoder parameter sets',
    'not-transport-stream': 'upstream segments are not MPEG-TS',
  }[slug] ?? slug;
}

// ── The four-stage byte path (MK-07.10 → MK-07.13) ────────────────────────────────────────────────────
// SOURCE // FEED → INGEST // RING → PLAYLIST // MANIFEST → OUTPUT // FEED: what we PULL, how we HOLD it,
// how we REPACKAGE it, what we SEND. The rail is a tablist rather than four collapsibles, so exclusive
// expand is STRUCTURAL — there is no open/closed state machine to desync and no all-closed state.
// Full design + the verification that corrected it: .claude/plans/active-streams-4stage-telemetry.md §7.
type StageKey = 'source' | 'ingest' | 'manifest' | 'output';
type Tone = 'ok' | 'warn' | 'bad' | 'unknown' | 'na';
interface StageState { tone: Tone; text: string; title: string }

const stage = ref<StageKey>('output');
const STAGES: { key: StageKey; cap: string; pane: string; spec: string; mk: string }[] = [
  { key: 'source', cap: 'SOURCE', pane: 'SOURCE // FEED', spec: 'FEED SPEC', mk: 'MK-07.10' },
  { key: 'ingest', cap: 'INGEST', pane: 'INGEST // RING', spec: 'RING SPEC', mk: 'MK-07.11' },
  { key: 'manifest', cap: 'MANIFEST', pane: 'PLAYLIST // MANIFEST', spec: 'MANIFEST SPEC', mk: 'MK-07.12' },
  { key: 'output', cap: 'OUTPUT', pane: 'OUTPUT // FEED', spec: 'EGRESS SPEC', mk: 'MK-07.13' },
];

// Hue is the FOURTH signal, after glyph, state word and headline text, so a colour-blind operator and a
// greyscale screenshot both still read correctly. The two grey tones are deliberately NOT interchangeable:
// `na` = "this stage does not exist on this channel", `unknown` = "it exists and we have no reading". A
// panel that renders the second as healthy manufactures exactly the false all-clear this design exists to
// prevent. `na` uses a literal em-dash instead of an icon (see the template).
const TONE_META: Record<Tone, { glyph: string; word: string }> = {
  ok: { glyph: 'check', word: 'OK' },
  warn: { glyph: 'activity', word: 'DEGRADED' },
  bad: { glyph: 'warn', word: 'FAULT' },
  unknown: { glyph: 'info', word: 'NOT MEASURED' },
  na: { glyph: '', word: 'N/A' },
};

// How long an origin may stay silent before its last frame stops being trustworthy. `report_iop` is NOT a
// heartbeat — it fires from five sites and only one is steady-state — so silence is normal for a while.
// 30s floor, not 20: the bare-TS ingest path fabricates a 5s target duration and then emits NOTHING until
// the socket ends, so a tighter window would mark a perfectly healthy raw-TS origin stale forever.
function staleMs(ing: ActiveStream['ingest']): number {
  return Math.min(Math.max(4 * (ing?.targetDuration || 6) * 1000, 30_000), 90_000);
}
function ageLabel(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}
function mib(bytes: number): string { return (bytes / 1048576).toFixed(1); }
// Session-end reason → operator English. The first four are real CAUSES reported by the data plane; the last
// three describe only how the ending was NOTICED. Kept in one map but worded so the difference survives —
// "the polls stopped" must never read like a diagnosis. Unknown slugs pass through verbatim.
function closeReasonLabel(reason: string): string {
  return {
    endlist: 'upstream ended the playlist (#EXT-X-ENDLIST)',
    failover_exhausted: 'failover chain exhausted — nothing reachable',
    pair_declines: 'audio/video pairs kept being declined',
    ingest_stopped: 'the ingest stopped and the ring drained',
    client_gone: 'the viewer disconnected',
    socket_close: 'the socket closed',
    socket_idle_backstop: 'socket went half-open — reaped after 60s with no bytes',
    poll_timeout: 'the polls stopped',
  }[reason] ?? reason;
}
// Upstream shape → operator English. Unknown slugs pass through verbatim rather than being mapped to a
// friendly default: a shape we do not recognise is worth seeing raw, not worth disguising as a known one.
function shapeLabel(shape: string): string {
  return {
    'ts': 'bare MPEG-TS socket — we segment it ourselves',
    'hls-master': 'HLS master — we pick a variant',
    'hls-media': 'HLS media playlist — followed directly',
  }[shape] ?? shape;
}

// Asymmetric min-dwell. `ingest.status === 'stalled'` is a ONE-FRAME event — the sidecar clears its
// empty-poll counter and the next productive poll reports 'ok' — so undamped it is a 2.5s amber blink,
// which is worse than no colour at all. Escalation is immediate; de-escalation requires the healthier
// reading to hold continuously. Transitions into or out of unknown/na BYPASS the dwell entirely: those are
// structural rather than health, and holding a stale green while the structure changes is the dangerous
// failure. Evaluated at READ time and never decremented on a tick, so a WS reconnect cannot freeze a latch.
const DWELL_MS = 7500; // 3 × the server's broadcast interval
const SOURCE_DWELL_MS = 18_000; // passthrough only — see stateSource()
const SEVERITY: Record<Tone, number> = { ok: 0, na: 0, unknown: 0, warn: 1, bad: 2 };
const dwell: Record<string, { shown: Tone; cand: Tone; candSince: number }> = {};
function damp(key: string, next: Tone, ms = DWELL_MS): Tone {
  const now = Date.now();
  const cur = dwell[key];
  if (!cur) { dwell[key] = { shown: next, cand: next, candSince: now }; return next; }
  if (next !== cur.cand) { cur.cand = next; cur.candSince = now; }
  const structural = next === 'unknown' || next === 'na' || cur.shown === 'unknown' || cur.shown === 'na';
  if (structural || SEVERITY[next] >= SEVERITY[cur.shown] || now - cur.candSince >= ms) cur.shown = next;
  return cur.shown;
}

// A confirmed fault is sticky against decay into `unknown`. A dying ingest and a dead sidecar both look
// exactly like silence, and Node keeps serving the last snapshot while viewers remain — so degrading amber
// into grey at the moment a fault becomes PERMANENT would lose the fault entirely. Cleared by any fresh
// healthy frame, and keyed by channelId because `sel` silently falls back to liveStreams[0].
const lastFault: Record<string, Tone> = {};

// Arrival time of the current ad break, on the browser clock. `adBreak.durationSec` is frozen at roughly
// the first segment (Rust accumulates internally and only re-reports on close), so elapsed time can only be
// measured from when the open frame reached us.
const breakSeen: Record<string, { at: number; recvAt: number }> = {};
function breakAge(s: ActiveStream): number {
  const b = s.adBreak;
  if (!b) return 0;
  const cur = breakSeen[s.channelId];
  if (!cur || cur.at !== b.at) { breakSeen[s.channelId] = { at: b.at, recvAt: Date.now() }; return 0; }
  return Date.now() - cur.recvAt;
}

// All three maps above are per-channel latches, so all three must be pruned against the live channel set —
// the composable's own prune covers only its series. Growth is not the reason (these die with the component):
// a channel that reported `stalled`, went cold and came back healthy would otherwise still carry its old
// `lastFault`, and its first silent window would resurrect a fault from a previous session instead of
// reporting `no reading`. That is exactly the permanent-latch failure the tone design exists to avoid.
// `dwell` is keyed `<channelId>|<stage>`, so it is pruned on the prefix.
watch(liveStreams, (streams) => {
  const live = new Set(streams.map((s) => s.channelId));
  for (const id of Object.keys(lastFault)) if (!live.has(id)) delete lastFault[id];
  for (const id of Object.keys(breakSeen)) if (!live.has(id)) delete breakSeen[id];
  for (const k of Object.keys(dwell)) if (!live.has(k.slice(0, k.lastIndexOf('|')))) delete dwell[k];
});

// ── Stage 1 · SOURCE ──────────────────────────────────────────────────────────────────────────────────
// TONE IS NOT `sel.status` ON AN ORIGIN CHANNEL. `sel.status`'s success signal is EGRESS, and an origin
// serves bytes FROM THE RING — so it resets the failure count faster than the sole upstream-failure emit
// can accumulate, and eviction stops at 3 segments so the ring never empties. Bound naively, this stage
// would paint solid green with a check glyph while the source is dead and the ring replays frozen
// segments: ingress≠egress violated at the tone level, on the one panel built to show that split.
function stateSource(): StageState {
  const s = sel.value;
  if (!s) return { tone: 'na', text: '—', title: 'No stream selected.' };
  const ing = s.ingest;
  // Interim origin gate. `ingest !== null` alone conflates origin-off, first-frame-not-landed, and an
  // INELIGIBLE origin whose ring is bypassed while the rewrite path actually serves the client.
  const originish = !!ing && ing.status !== 'closed';
  const age = ingestAge(s.channelId);
  const silent = originish && age > Math.max(45_000, staleMs(ing));
  const who = s.source || '—';
  const fo = s.failover;
  // Attribution, never a health claim: attempt 0 means the first resolve already landed on another
  // provider (normal for a multi-provider source); attempt ≥1 means it took over after a real failure.
  const attribution = fo ? `${who} · alt${fo.attempt >= 1 ? ` #${fo.attempt}` : ''}` : who;
  const retired = ing?.suspectRetires || 0;

  let tone: Tone;
  let text: string;
  if (originish ? ing!.status === 'resolve_failed' : s.status === 'bad') { tone = 'bad'; text = 'no upstream'; }
  else if (silent) { tone = 'unknown'; text = `silent ${ageLabel(age)}`; }
  else if (!ing && s.phase === 'establishing') { tone = 'unknown'; text = 'establishing'; }
  else if (originish ? ing!.status === 'stalled' : s.status === 'warn') { tone = 'warn'; text = 'stalled'; }
  else if (originish ? ing!.status === 'ok' : s.status === 'good') { tone = 'ok'; text = attribution; }
  else { tone = 'unknown'; text = 'no reading'; } // never fall through to ok

  // `suspect` is a write-once latch the sidecar never clears, so it rides the TEXT and is excluded from
  // tone — otherwise one retired provider paints the channel amber for the rest of the ingest's life.
  if (tone === 'ok' && retired > 0) text = `${attribution} · retired ×${retired}`;
  // Passthrough only: `sel.status` square-waves red↔green on a ~15s period on a persistently dead upstream
  // (the cooldown clears the failure streak and the debouncer then reports a green frame). Undamped the
  // rail strobes. The origin branch needs no dwell — `ing.status` is already a per-frame latch.
  const shown = originish ? tone : damp(`${s.channelId}|source`, tone, SOURCE_DWELL_MS);
  if (shown !== tone && shown === 'bad') text = 'no upstream';
  return { tone: shown, text, title: titleSource(s, shown, attribution, retired, age, originish) };
}
function titleSource(s: ActiveStream, tone: Tone, attribution: string, retired: number, age: number, originish: boolean): string {
  const bits = [`Upstream attribution: ${attribution}`];
  if (s.failover) bits.push(failoverTitle(s.failover));
  if (s.ingest?.suspect) bits.push(`${suspectLabel(s.ingest.suspect)}${retired > 1 ? ` · ${retired} providers retired` : ''}`);
  if (originish) bits.push(`Ingest reported "${s.ingest!.status}" ${ageLabel(age)} ago`);
  else bits.push('Passthrough channel — health comes from the request phase machine, not an ingest.');
  if (tone === 'unknown') bits.push('No current reading — this is NOT a healthy verdict.');
  return bits.join(' · ');
}

// ── Stage 2 · INGEST ──────────────────────────────────────────────────────────────────────────────────
// Structure is decided by RING CONTENTS, not by status: `closed` is the STEADY STATE of a healthy raw-TS
// origin (that path emits nothing all session, then reports `closed`), and the ENDLIST-terminal exit does
// the same with a full window still on air. Treating `closed` as absence prints "no ring" while
// ringSegments on the same object says 14.
function stateIngest(): StageState {
  const s = sel.value;
  if (!s) return { tone: 'na', text: '—', title: 'No stream selected.' };
  const ing = s.ingest;
  if (!ing) {
    return {
      tone: 'na',
      text: 'no ring',
      // Deliberately does NOT assert "passthrough": a null ingest also covers origin-enabled-but-not-yet-
      // reporting. `ineligible` cannot disambiguate THIS case the way it does the one below — there is no
      // ingest frame at all here to carry it.
      title: 'No local ring for this channel — origin is off, or has not reported yet.',
    };
  }
  const holding = ing.ringSegments > 0 || ing.ringBytes > 0;
  const age = ingestAge(s.channelId);
  const st = staleMs(ing);
  const key = `${s.channelId}|ingest`;
  let tone: Tone;
  let text: string;
  if (ing.status === 'resolve_failed') { tone = 'bad'; text = 'resolve ×'; }
  // The sidecar SAYING it declined this upstream, so the rewrite path is serving and the ring is bypassed.
  // This retires the inferred rung below, which a frame captured mid-transition could false-positive — that
  // heuristic now runs only for a sidecar old enough not to report the flag (hence `=== undefined`, not a
  // falsy check: `null` is an authoritative "eligible" and must NOT fall back to guessing).
  else if (ing.ineligible) { tone = 'na'; text = 'rewrite'; }
  else if (ing.ineligible === undefined && ing.status === 'closed' && !holding) { tone = 'na'; text = 'rewrite'; }
  else if (ing.status === 'stalled') { tone = 'warn'; text = 'stalled'; }
  else if (age >= 3 * st && lastFault[s.channelId]) {
    // Held fault: the ingest confirmed a fault and then went silent, which is what dying looks like.
    tone = lastFault[s.channelId];
    text = tone === 'bad' ? 'resolve ×' : 'stalled';
  } else if (age >= 3 * st) { tone = 'unknown'; text = 'no reading'; }
  else if (ing.status === 'closed') { tone = 'ok'; text = 'ended'; }
  else if (age >= st) { tone = 'warn'; text = `silent ${ageLabel(age)}`; }
  else if (ing.status === 'ok') { tone = 'ok'; text = `${ing.ringSegments} seg`; }
  else { tone = 'unknown'; text = 'no reading'; } // `status` is a free-form string — never default to ok

  if (tone === 'bad' || (tone === 'warn' && ing.status === 'stalled')) lastFault[s.channelId] = tone;
  else if (tone === 'ok' && age < st) delete lastFault[s.channelId];

  const shown = damp(key, tone);
  const title = [
    `${ing.status} · ${ing.ringSegments} seg · ${mib(ing.ringBytes)} MiB held`,
    ...(ing.ineligible ? [`origin declined this upstream: ${ing.ineligible}`] : []),
    ...(ing.floorBeatsCap ? ['over cap — the 3-segment floor won'] : []),
    `1 ingest → ${s.viewers} viewer${s.viewers === 1 ? '' : 's'}`,
    `reported ${ageLabel(age)} ago`,
  ].join(' · ');
  return { tone: shown, text, title };
}

// ── Stage 3 · MANIFEST ────────────────────────────────────────────────────────────────────────────────
// The one state only this stage can show: the ingest is FAILING while the ring keeps publishing a stale
// window. `stalled` and `resolve_failed` both leave the ring intact and re-stamp `at`, so without explicit
// arms for them such a frame matches nothing.
function stateManifest(): StageState {
  const s = sel.value;
  if (!s) return { tone: 'na', text: '—', title: 'No stream selected.' };
  const i = s.ingest;
  if (!i || i.status === 'closed') {
    return {
      tone: 'na',
      text: 'not authored',
      // NOT "we relay, we do not author" — that is false for a raw-TS-upstream origin, which authors 100%
      // of its output while reporting no ingest at all.
      title: 'No authored manifest measured for this channel.',
    };
  }
  const age = ingestAge(s.channelId);
  const isFresh = age < staleMs(i);
  const b = s.adBreak;
  // Liveness-gated: there is no close cue on ingest teardown, and the break state is only cleared when the
  // channel goes cold — so a restarted ingest inherits inBreak:true with a ten-minute-old timestamp.
  const stuck = !!b && b.inBreak && i.status === 'ok' && isFresh
    && breakAge(s) > Math.max(3000 * b.announcedSec, 600_000);
  let tone: Tone;
  let text: string;
  if (stuck) { tone = 'warn'; text = 'break stuck'; }
  // "frozen", not "window frozen": 13 chars overflows the tile at every width an operator actually runs,
  // and under a caption that already reads MANIFEST the shorter word loses nothing. Full text on the title.
  else if (i.status === 'stalled') { tone = 'warn'; text = 'frozen'; }
  else if (i.status === 'resolve_failed') { tone = 'warn'; text = 'no upstream'; }
  else if (!isFresh) { tone = 'warn'; text = `silent ${ageLabel(age)}`; }
  else if (i.ringSegments === 0 || i.targetDuration === 0) { tone = 'unknown'; text = 'no reading'; }
  else if (b?.inBreak) {
    // An ad break is NOT a fault. pluto/tubi/xumo are in a break a meaningful fraction of every hour, and
    // amber-on-inBreak would make amber mean "this channel has ads".
    tone = 'ok';
    const secs = Math.floor(breakAge(s) / 1000);
    text = `AD ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  } else if (s.delivery === 'ts') { tone = 'ok'; text = `${i.ringSegments} seg woven`; }
  else { tone = 'ok'; text = `~#${Math.max(0, i.headSeq - i.ringSegments)}`; }
  return {
    tone: damp(`${s.channelId}|manifest`, tone),
    text,
    title: `Publishing ${i.ringSegments} segments · media-sequence base ≈ ${Math.max(0, i.headSeq - i.ringSegments)}`
      + (i.generation ? ` · ring reset ×${i.generation}` : ''),
  };
}

// ── Stage 4 · OUTPUT ──────────────────────────────────────────────────────────────────────────────────
// Reads the per-client list, NOT the channel aggregate. A poll client that simply stops keeps its row for
// 30s while its smoothed rate reaches zero after ~15s, so an aggregate-only rule paints ~14s of solid red
// at the tail of EVERY routine viewer departure — including one this screen's own player produces.
function stateOutput(): StageState {
  const s = sel.value;
  if (!s) return { tone: 'na', text: '—', title: 'No stream selected.' };
  const now = Date.now();
  // Only a list KNOWN to describe this channel may drive a verdict — see `clientsOf`.
  const rows = selClients.value;
  if (!rows) return { tone: 'unknown', text: 'no reading', title: 'Session list not loaded for this channel yet.' };
  const live = rows.filter((c) => now - c.lastSeen < 10_000);
  const warmed = live.some((c) => now - c.connectedAt >= 15_000);
  const head = `${s.viewers} · ${s.bandwidth.toFixed(1)}M`;
  const title = `${s.viewers} viewer${s.viewers === 1 ? '' : 's'}`
    + ` (${s.viewersByPlayer.appPlayer} in-app / ${s.viewersByPlayer.externalPlayer} external)`
    + ` · ${s.bandwidth.toFixed(1)} Mbps out · ${mib(s.bytesTotal)} MiB to current viewers`;
  // All viewers stopped polling. Grey, never red — the safe direction, and it is also what a slow clients
  // fetch looks like.
  if (live.length === 0) return { tone: 'unknown', text: 'draining', title: `${title} · no viewer polled in the last 10s` };
  if (!warmed && s.bandwidth === 0) return { tone: 'unknown', text: 'warming', title: `${title} · rate window not warmed yet` };
  if (warmed && s.bandwidth === 0) return { tone: 'bad', text: 'no egress', title: `${title} · viewers connected but nothing is flowing` };
  return { tone: 'ok', text: head, title };
}

// ONE truth function per stage, read by BOTH the rail tile and the pane header so they can never disagree.
// A single computed also means the dwell latches above are evaluated exactly once per frame.
const stageStates = computed<Record<StageKey, StageState>>(() => ({
  source: stateSource(),
  ingest: stateIngest(),
  manifest: stateManifest(),
  output: stateOutput(),
}));
const paneState = computed(() => stageStates.value[stage.value]);
const paneMeta = computed(() => STAGES.find((x) => x.key === stage.value)!);

// Derived ingress rate + amplification. Both operands already ride every WS frame, so this needs no backend
// change at all. The composable returns `null` when it could not measure (a repeated iop frame gives no
// interval; a counter restart gives a negative delta) and a real number otherwise — including a measured 0,
// which amplification must still refuse to divide by.
const selIngestMbps = computed(() => (sel.value ? ingestMbps(sel.value.channelId) : null));

// Per-viewer QoE, summed across the channel's connected sessions. Null when NO session reports it (an older
// server), which is not the same as zero stalls — rendered as "not reported", never as a clean bill of health.
// Rides the 4s clients fetch, not the 2.5s WS: these are per-CLIENT numbers and the WS frame is per-channel.
const selQoe = computed(() => {
  const rows = (selClients.value ?? []).filter((c) => typeof c.rebufferMs === 'number');
  if (!rows.length) return null;
  return {
    stalls: rows.reduce((a, c) => a + (c.bufferCount ?? 0), 0),
    ms: rows.reduce((a, c) => a + (c.rebufferMs ?? 0), 0),
  };
});
const selAmplification = computed(() => {
  const s = sel.value;
  if (!s) return null;
  if (!s.ingest) return '1.0× (no ring)';
  const inMbps = selIngestMbps.value;
  if (!inMbps || !s.bandwidth) return '—';
  return `${(s.bandwidth / inMbps).toFixed(1)}× — one ${inMbps.toFixed(2)} Mbps ingest serving ${s.bandwidth.toFixed(1)} Mbps out`;
});

// Bytes flow left to right, so when several stages are degraded the EARLIEST one is the cause and the rest
// are consequences: rank by severity, break ties by lowest stage index. Re-evaluated ONLY on selection
// change — a pane that swaps itself out mid-read while the operator is looking at it is worse than a
// flickering colour, so a live escalation is surfaced by the persistently-visible rail tile instead.
const OPEN_RANK: Record<Tone, number> = { bad: 3, warn: 2, unknown: 1, na: 0, ok: 0 };
watch(() => sel.value?.id, () => {
  const st = stageStates.value;
  const ranked = STAGES.map((x, i) => ({ key: x.key, sev: OPEN_RANK[st[x.key].tone], i }))
    .sort((a, b) => b.sev - a.sev || a.i - b.i);
  // Nothing degraded → OUTPUT: the only stage guaranteed to have a real reading on every channel, so the
  // pane is never an empty state on first render.
  stage.value = ranked[0].sev > 0 ? ranked[0].key : 'output';
}, { immediate: true });

// Arrow-key traversal on the rail. Deliberately NOT a spec-strict tablist: a roving tabindex would collapse
// four free tab stops into one and be the most complex keyboard widget in the codebase. Focus is not moved
// on click, so arrow traversal keeps working from wherever the operator is.
function onRailKey(e: KeyboardEvent): void {
  const i = STAGES.findIndex((x) => x.key === stage.value);
  let n = i;
  if (e.key === 'ArrowRight') n = (i + 1) % STAGES.length;
  else if (e.key === 'ArrowLeft') n = (i - 1 + STAGES.length) % STAGES.length;
  else if (e.key === 'Home') n = 0;
  else if (e.key === 'End') n = STAGES.length - 1;
  else return;
  e.preventDefault();
  stage.value = STAGES[n].key;
  const el = document.getElementById(`asd-tab-${STAGES[n].key}`);
  el?.focus();
}
</script>

<template>
  <div class="col mq-active" style="height: 100%; min-height: 0;">
    <div class="stats">
      <div class="card stat">
        <div class="lbl">Live now</div>
        <div class="val">{{ totals.streams }}<span style="color: var(--text-3); font-size: 16px; font-weight: 500;"> / {{ liveStreams.length }}</span></div>
        <div class="delta"><span class="dot good pulse" style="width: 6px; height: 6px;" />relaying</div>
      </div>
      <div class="card stat">
        <div class="lbl">Viewers</div>
        <div class="val">{{ totals.viewers }}</div>
        <div class="delta"><Icon name="check" :size="12" />peak {{ totals.peak }} this session</div>
      </div>
      <div class="card stat">
        <div class="lbl">Egress</div>
        <div class="val">{{ totals.bandwidth.toFixed(1) }}<span style="font-size: 14px; color: var(--text-2); font-weight: 500;"> Mbps</span></div>
        <div class="delta">live across all viewers</div>
      </div>
      <div class="card stat">
        <div class="lbl">Issues</div>
        <div class="val">{{ totals.issues }}</div>
        <div :class="['delta', { bad: totals.issues }]">
          <template v-if="totals.issues"><Icon name="warn" :size="12" />needs attention</template>
          <template v-else><Icon name="check" :size="12" />all healthy</template>
        </div>
      </div>
    </div>

    <div v-if="sel && chOf(sel)" class="streams-grid">
      <div class="streams-list">
        <div class="toolbar">
          <SearchInput :value="search" @change="(v) => search = v" placeholder="Search streams" :width="180" />
          <span class="spacer" />
          <Segmented :value="filter" @change="(v) => filter = v as any" :options="[
            { value: 'all', label: 'All' },
            { value: 'live', label: 'Live' },
            { value: 'issues', label: 'Issues' },
          ]" />
        </div>
        <div class="body">
          <div v-for="s in filtered" :key="s.id"
               :class="['stream-item', { selected: selId === s.id }]" @click="selId = s.id"
               :title="s.watchers.length ? 'Watching: ' + s.watchers.join(', ') : undefined">
            <ChannelLogo :ch="chOf(s)" />
            <div style="min-width: 0;">
              <div class="nm">
                <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ chOf(s).tvg_name }}</span>
                <span v-if="s.status === 'good'" class="dot good pulse" style="width: 6px; height: 6px;" />
                <span v-else-if="s.status === 'warn'" class="dot warn" style="width: 6px; height: 6px;" />
                <span v-else class="dot bad" style="width: 6px; height: 6px;" />
              </div>
              <div class="meta">
                <span class="mono">{{ s.status === 'bad' ? 'offline' : (s.resolution ?? '—') }}</span>
                <span>·</span>
                <span class="mono">{{ s.status === 'bad' ? '—' : s.bitrate.toFixed(1) + ' Mbps' }}</span>
                <span>·</span>
                <span>{{ s.uptime }}</span>
                <template v-if="s.watchers.length === 1">
                  <span>·</span>
                  <span class="mono" style="color: var(--accent-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ s.watchers[0] }}</span>
                </template>
              </div>
            </div>
            <div class="viewer">
              <b>{{ s.viewers }}</b>
              <span>viewers</span>
            </div>
          </div>
          <div v-if="filtered.length === 0" class="empty" style="padding: 40px;">
            <div class="muted">No active streams — start playing a channel to see it here.</div>
          </div>
        </div>
      </div>

      <div class="stream-detail">
        <!-- HUD corner brackets framing the now-borderless instrument cluster -->
        <span class="corner tl" aria-hidden="true" /><span class="corner tr" aria-hidden="true" />
        <span class="corner bl" aria-hidden="true" /><span class="corner br" aria-hidden="true" />
        <div class="stream-detail-body" :style="{ padding: 'var(--pad-card)', display: 'flex', flexDirection: 'column', gap: '16px' }">
          <!-- brand telemetry header → 3-column strip: stacked mono lines · per-stream barcode · derived code tags -->
          <div class="asd-hdr-strip" aria-hidden="true">
            <div class="asd-hdr-text">
              <span class="mq-micro-hi">MASQUERADARR // STREAM</span>
              <div class="mq-overline">
                <span class="mq-ov-tag">SYS</span>
                <span class="mq-ov-rule" />
                <span class="mq-ov-dim">ACTIVE SESSION</span>
              </div>
            </div>
            <div class="asd-hdr-bars">
              <svg class="mq-barcode" :viewBox="`0 0 ${headerBarcode.width} 26`" preserveAspectRatio="none">
                <rect v-for="(r, i) in headerBarcode.rects" :key="i" :x="r.x" y="0" :width="r.w" height="26" />
              </svg>
            </div>
            <div class="asd-hdr-tags">
              <span>{{ codeTags[0] }}</span>
              <span>{{ codeTags[1] }}</span>
            </div>
          </div>
          <div class="row" style="gap: 14px;">
            <ChannelLogo :ch="chOf(sel)" size="lg" />
            <div style="flex: 1;">
              <div class="row" style="gap: 10px;">
                <h2 style="margin: 0; font-size: 17px; font-weight: 600;">{{ chOf(sel).tvg_name }}</h2>
                <!-- Status badge in a fixed-geometry slot so live/buffer/establishing/offline never
                     reflow the title row (each variant keeps its own color, the slot keeps the box). -->
                <span class="status-badge-slot">
                  <span v-if="sel.status === 'good'" class="live-pill"><span class="dot" />LIVE</span>
                  <Pill v-else-if="sel.status === 'bad'" tone="bad"><Icon name="warn" :size="11" />offline</Pill>
                  <Pill v-else tone="warn"><Icon name="warn" :size="11" />{{ sel.phase }}</Pill>
                </span>
                <!-- Effective wire format being served now (Raw-TS socket vs segmented HLS) — the observable
                     side of the outputFormat switch; a Raw-TS request that fell back reads "HLS". -->
                <Pill :tone="sel.delivery === 'ts' ? 'cyan' : sel.delivery === 'mixed' ? 'warn' : 'system'"
                  :title="`Wire format served now: ${deliveryLabel(sel.delivery)} — distinct from the Container decode label`">
                  {{ deliveryLabel(sel.delivery) }}
                </Pill>
                <!-- Failover attribution: this channel is NOT being carried by its own default upstream —
                     either a configured backup channel, or (for sources with several interchangeable
                     providers per channel, e.g. DaddyLive's players) a different one of those. -->
                <Pill v-if="sel.failover" tone="parent" :title="failoverTitle(sel.failover)">
                  <Icon name="refresh" :size="11" />failover → {{ sel.failover.candidateName }}
                </Pill>
              </div>
              <div class="mono muted" style="font-size: var(--fs-xs); margin-top: 4px;">
                #{{ chOf(sel).channelNo ?? '—' }} · {{ chOf(sel).group }} · stream-id <span style="color: var(--text-1);">{{ sel.id }}</span>
              </div>
              <div class="row" style="gap: 6px; margin-top: 8px; flex-wrap: wrap;">
                <span class="muted" style="font-size: var(--fs-xs);">Watching</span>
                <Pill v-for="u in sel.watchers.slice(0, 3)" :key="u" tone="cyan"><Icon name="check" :size="11" />{{ u }}</Pill>
                <Pill v-if="sel.watchers.length > 3">+{{ sel.watchers.length - 3 }} more</Pill>
                <span v-if="!sel.watchers.length" class="muted" style="font-size: var(--fs-xs);">{{ sel.viewers }} viewer{{ sel.viewers === 1 ? '' : 's' }} · no account</span>
              </div>
            </div>
            <button class="asd-globe" @click="onView" title="View channel" aria-label="View channel">
              <Icon name="orbit" :size="18" />
            </button>
          </div>

          <div class="stream-detail-split">
            <div class="stream-detail-main">
          <div class="card asd-label">
            <div class="asd-label-hd">
              <span class="asd-cap">BITRATE // LIVE</span>
              <span class="spacer" />
              <Pill tone="cyan">avg {{ selAvg.toFixed(1) }} Mbps</Pill>
              <Pill>min {{ selMin.toFixed(1) }}</Pill>
              <Pill>max {{ selMax.toFixed(1) }}</Pill>
            </div>
            <LivelineChart :series="selSeries" :target="selTarget" />
          </div>

          <!-- The byte path, drawn literally: SOURCE › INGEST › MANIFEST › OUTPUT. Four tiles feed ONE
               full-width pane, so the rows that could never fit four-across each get the whole panel width.
               This is a tablist, not four collapsibles — exclusive expand is structural, there is no
               all-closed state, and the rail keeps all four verdicts on screen while one is being read. -->
          <div class="asd-flow" role="tablist" aria-label="Stream pipeline stages" @keydown="onRailKey">
            <template v-for="(st, i) in STAGES" :key="st.key">
              <span v-if="i" class="asd-fl-arrow" aria-hidden="true"><Icon name="chevron-r" :size="12" /></span>
              <button
                :id="`asd-tab-${st.key}`"
                class="asd-fl-tile"
                :class="[`t-${stageStates[st.key].tone}`, { active: stage === st.key }]"
                role="tab"
                :aria-selected="stage === st.key"
                :aria-controls="`asd-pane-${st.key}`"
                :title="`${st.pane} — ${TONE_META[stageStates[st.key].tone].word}. ${stageStates[st.key].title}`"
                @click="stage = st.key">
                <span class="asd-fl-top">
                  <Icon v-if="TONE_META[stageStates[st.key].tone].glyph" :name="TONE_META[stageStates[st.key].tone].glyph" :size="11" />
                  <span v-else class="asd-fl-dash" aria-hidden="true">—</span>
                  <span class="asd-cap">{{ st.cap }}</span>
                </span>
                <span class="asd-fl-val">{{ stageStates[st.key].text }}</span>
                <span class="asd-fl-mk" aria-hidden="true">{{ st.mk }}</span>
                <span class="asd-sr">{{ TONE_META[stageStates[st.key].tone].word }}</span>
              </button>
            </template>
          </div>

          <!-- One pane, always EXACTLY 8 rows per stage. The fixed row count is what keeps all four panes
               the same height, which is what stops the sessions card below from moving on every toggle. -->
          <div class="card asd-label asd-stage" role="tabpanel" tabindex="-1"
               :id="`asd-pane-${stage}`" :aria-labelledby="`asd-tab-${stage}`">
            <div class="asd-label-hd">
              <span class="asd-cap">{{ paneMeta.pane }}</span>
              <span class="spacer" />
              <Pill :tone="paneState.tone === 'ok' ? 'good' : paneState.tone === 'warn' ? 'warn' : paneState.tone === 'bad' ? 'bad' : 'system'">
                <Icon v-if="TONE_META[paneState.tone].glyph" :name="TONE_META[paneState.tone].glyph" :size="11" />
                {{ TONE_META[paneState.tone].word }}
              </Pill>
            </div>

            <!-- 1 · SOURCE // FEED — where the bytes are pulled FROM. The only card that can exonerate the
                 rest of the pipeline: is the provider itself serving usable video, and is it even the
                 upstream we think it is? -->
            <div v-if="stage === 'source'" class="kv-list">
              <div class="k">Feed state</div>
              <div class="v mono">
                {{ stageStates.source.text }} <span class="asd-sub">· {{ sel.phase }}</span>
                <!-- `retry` alone is ambiguous — it reads 0 for a channel that has never faltered AND for one
                     whose failed-cooldown just expired. `everStreamed` is what separates them. -->
                <span v-if="sel.retry" class="asd-sub" style="color: var(--warn);">· retry {{ sel.retry }}</span>
                <span v-else-if="sel.everStreamed === false" class="asd-sub">· never streamed yet</span>
              </div>
              <div class="k">Source</div>
              <div class="v"><Pill tone="cyan">{{ sel.source }}</Pill></div>
              <div class="k">Stream entry</div>
              <div class="v mono asd-url" :title="chOf(sel).streamEntryUrl">
                <span class="asd-url-1">{{ chOf(sel).streamEntryUrl }}</span>
                <!-- The ENTRY hop's host, not "the host serving this channel": the data plane grows its
                     allow-set from each manifest it rewrites, so segments routinely come from a different CDN
                     host than the master. Calling it the serving host would be a lie on any multi-CDN
                     provider — which is most of them. -->
                <span v-if="sel.upstreamHost" class="asd-sub">· resolves to {{ sel.upstreamHost }} (entry hop)</span>
              </div>
              <div class="k">Protocol</div>
              <!-- What we PULL. Deliberately adjacent to, and worded apart from, the two neighbours it is
                   always confused with: `delivery` is what we SERVE (the pill in the header) and `container`
                   is what the SEGMENTS are. All three can legitimately disagree — a bare TS socket served as
                   HLS, or an HLS master woven into raw TS. -->
              <div class="v mono">
                <template v-if="sel.upstreamShape || sel.encryption">
                  <template v-if="sel.upstreamShape">{{ shapeLabel(sel.upstreamShape) }}</template>
                  <!-- 'NONE' is a measured reading, so it renders as "cleartext" rather than vanishing —
                       an absent row and a channel proven unencrypted are different facts. -->
                  <template v-if="sel.encryption">
                    <span :style="sel.encryption !== 'NONE' ? 'color: var(--accent-hi);' : ''">· {{ sel.encryption === 'NONE' ? 'cleartext' : sel.encryption }}</span>
                  </template>
                  <span class="asd-sub">· serving {{ deliveryLabel(sel.delivery) }}</span>
                  <!-- The row's payoff: it names WHICH of the three possible causes made a Raw-TS request come
                       back as HLS. The passthrough muxer cannot decrypt, so an encrypted upstream forces the
                       fallback — while an origin ring decrypts into the ring and would not have. -->
                  <span v-if="sel.encryption && sel.encryption !== 'NONE' && sel.requested?.outputFormat === 'ts' && sel.delivery === 'hls'"
                        class="asd-sub" style="color: var(--warn);">· this is why Raw-TS fell back — the passthrough muxer cannot decrypt</span>
                </template>
                <span v-else class="asd-nm">not reported yet — set on the first upstream resolve</span>
              </div>
              <div class="k">Video / Audio</div>
              <div class="v mono">
                <template v-if="sel.codec || sel.audio">{{ selTech?.video }} · {{ selTech?.audio }}</template>
                <!-- Deliberately states NO cause. Null here has two of them: an origin-backed channel (which
                     never emits `kind:"media"` at all), and a passthrough whose upstream served a MEDIA
                     playlist rather than a master — the emit is gated on `media.any()`, so a playlist with no
                     `#EXT-X-STREAM-INF` sends nothing. Naming either one would be a false cause half the time,
                     and `sel.ingest` cannot tell them apart (§5d: it has four states, not two). -->
                <span v-else class="asd-nm">not measured (register #9)</span>
              </div>
              <div class="k">Resolution</div>
              <div class="v mono">
                <template v-if="sel.resolution">{{ selTech?.resolution }}<template v-if="selTech?.fps"> @ {{ selTech?.fps }}fps</template></template>
                <span v-else class="asd-nm">not measured (register #9)</span>
                <!-- "up to", not "declares": which variant this figure describes depends on the path. An
                     origin reports the variant it actually rings, but the passthrough rewriter reports the
                     master's HIGHEST-bandwidth variant while the client may legitimately be on a lower rung
                     of the ladder. Stated as a ceiling it is true either way; stated as "declares X, serving
                     Y" it invites an under-delivery conclusion that ordinary ABR would produce. -->
                <span v-if="sel.declaredBps" class="asd-sub">· master declares up to {{ (sel.declaredBps / 1e6).toFixed(2) }} Mbps · serving {{ sel.bitrate.toFixed(2) }}</span>
              </div>
              <div class="k">Provider</div>
              <div class="v mono">
                <template v-if="sel.failover">{{ sel.failover.candidateName }}<span class="asd-sub"> · {{ sel.failover.attempt >= 1 ? `took over on attempt #${sel.failover.attempt}` : 'chosen at first resolve' }}</span></template>
                <template v-else>default upstream</template>
              </div>
              <div class="k">Upstream verdict</div>
              <div class="v mono">
                <template v-if="sel.ingest?.suspect">
                  <span style="color: var(--warn);">{{ suspectLabel(sel.ingest.suspect) }}</span>
                  <span v-if="(sel.ingest.suspectRetires || 0) > 1" class="asd-sub"> · {{ sel.ingest.suspectRetires }} providers retired</span>
                </template>
                <template v-else-if="sel.ingest">no structural fault reported</template>
                <span v-else class="asd-nm">not measured — origin-backed channels only</span>
              </div>
            </div>

            <!-- 2 · INGEST // RING — how the feed is HELD. The only place originRingMb becomes an
                 observable rather than a guess, and the only card that shows the ingest is SHARED. -->
            <div v-else-if="stage === 'ingest'" class="kv-list">
              <template v-if="sel.ingest">
                <div class="k">Ingest</div>
                <div class="v mono" :style="sel.ingest.status === 'ok' || sel.ingest.status === 'closed' ? '' : 'color: var(--warn);'">
                  {{ sel.ingest.status }} <span class="asd-sub">· 1 ingest → {{ sel.viewers }} viewer{{ sel.viewers === 1 ? '' : 's' }}</span>
                </div>
                <div class="k">Ring</div>
                <div class="v mono">
                  {{ sel.ingest.ringSegments }} seg · {{ mib(sel.ingest.ringBytes) }}<template v-if="sel.ingest.channelRingCapBytes"> / {{ mib(sel.ingest.channelRingCapBytes) }}</template> MiB
                  <!-- Over 100% is a legitimate reading, not a bug: eviction stops at the 3-segment floor, so
                       a channel whose bitrate does not fit its budget sits over cap on purpose. -->
                  <span v-if="sel.ingest.floorBeatsCap" class="asd-sub" style="color: var(--warn);">· over cap — the 3-segment floor won, this bitrate does not fit the ring budget</span>
                  <span v-else-if="!sel.ingest.channelRingCapBytes" class="asd-sub">· cap not reported by this sidecar</span>
                </div>
                <div class="k">Held</div>
                <div class="v mono">
                  <template v-if="sel.ingest.ringSeconds">
                    {{ sel.ingest.ringSeconds.toFixed(1) }} s
                    <span class="asd-sub">· Σ of the held segments' own durations</span>
                  </template>
                  <!-- Fallback for a sidecar predating the measurement. Over-reads by each segment's gap below
                       the window max, which is why it stays flagged as approximate. -->
                  <template v-else>
                    ~{{ (sel.ingest.ringSegments * sel.ingest.targetDuration).toFixed(0) }} s
                    <span class="asd-sub">· approximate — segments × target duration</span>
                  </template>
                </div>
                <div class="k">Pulled (ingress)</div>
                <div class="v mono">
                  {{ sel.ingest.ingestedSegments }} seg · {{ mib(sel.ingest.ingestedBytes) }} MiB
                  <span class="asd-sub">· one shared ingest, not per viewer</span>
                </div>
                <div class="k">Ingest rate</div>
                <div class="v mono">
                  <!-- A measured 0 and an unmeasurable one are opposite statements: the first says the ingest
                       pulled nothing between two real frames, the second says we have not had two frames to
                       compare. `v-if="selIngestMbps"` would have collapsed them. -->
                  <template v-if="selIngestMbps !== null">
                    {{ selIngestMbps.toFixed(2) }} Mbps in
                    <span v-if="selIngestMbps === 0" class="asd-sub">· no new upstream bytes since the last frame</span>
                  </template>
                  <span v-else class="asd-nm">no reading yet — needs two distinct ingest frames</span>
                </div>
                <div class="k">Evicted</div>
                <div class="v mono">{{ sel.ingest.evictedSegments }} seg<span v-if="!sel.ingest.evictedSegments" class="asd-sub"> · ring has never overflowed</span></div>
                <div class="k">Head</div>
                <div class="v mono">
                  seq {{ sel.ingest.headSeq }}<template v-if="sel.ingest.generation"> · gen {{ sel.ingest.generation }}</template>
                  <span class="asd-sub">· reported {{ ageLabel(ingestAge(sel.channelId)) }} ago</span>
                </div>
                <div class="k">Leases</div>
                <div class="v mono">
                  {{ sel.ingest.subscribers }}
                  <span class="asd-sub">· held manifest/socket leases, NOT a viewer count (reads 0 for HLS viewers)</span>
                </div>
              </template>
              <template v-else>
                <div class="k">Ingest</div><div class="v asd-nm">passthrough — no local ring</div>
                <div class="k">Ring</div><div class="v asd-nm">not measured</div>
                <div class="k">Held</div><div class="v asd-nm">not measured</div>
                <div class="k">Pulled (ingress)</div><div class="v asd-nm">not measured</div>
                <div class="k">Ingest rate</div><div class="v asd-nm">not measured</div>
                <div class="k">Evicted</div><div class="v asd-nm">not measured</div>
                <div class="k">Head</div><div class="v asd-nm">not measured</div>
                <div class="k">Leases</div><div class="v asd-nm">not measured</div>
              </template>
            </div>

            <!-- 3 · PLAYLIST // MANIFEST — how ring data is REPACKAGED. The only card that can answer
                 "I set Raw-TS and still see HLS, why?" — which needs register #12 before it truly can. -->
            <div v-else-if="stage === 'manifest'" class="kv-list">
              <template v-if="sel.ingest">
                <div class="k">Rendering</div>
                <!-- The one row that can say whether the ring is authoring this channel's output AT ALL. An
                     origin that DECLINED its upstream keeps a live `ingest` while the rewrite path serves the
                     client — so before `ineligible` was reported, "authored manifest from the ring" was a
                     claim the panel could not back, on exactly the channel an operator is diagnosing. -->
                <div class="v mono">
                  <template v-if="sel.ingest.ineligible">
                    <span style="color: var(--warn);">declined — {{ sel.ingest.ineligible }}</span>
                    <span class="asd-sub">· the rewrite path is serving this channel, not the ring</span>
                  </template>
                  <template v-else-if="sel.ingest.demuxed !== undefined">
                    {{ sel.delivery === 'ts' ? 'raw TS woven from the ring' : 'authored manifest from the ring' }}
                    <span class="asd-sub">· {{ sel.ingest.demuxed ? 'demuxed upstream — a separate audio rendition is paired into every segment' : 'muxed upstream' }}</span>
                  </template>
                  <template v-else>
                    serving {{ sel.delivery === 'ts' ? 'raw TS' : 'HLS' }}
                    <span class="asd-nm">· authored-from-ring not reported by this sidecar</span>
                  </template>
                </div>
                <div class="k">Published window</div>
                <div class="v mono">
                  {{ sel.ingest.ringSegments }} seg · media-seq ~#{{ Math.max(0, sel.ingest.headSeq - sel.ingest.ringSegments) }}
                  <span class="asd-sub">· the whole window is published</span>
                </div>
                <div class="k">Target duration</div>
                <div class="v mono">{{ sel.ingest.targetDuration }} s <span class="asd-sub">· upstream observed max (never decays)</span></div>
                <div class="k">Discontinuity</div>
                <div class="v mono">
                  <!-- Two DISJOINT counts, never a sum: a tag is either still in the published window or it
                       has aged out of it. The second is what RFC 8216 calls EXT-X-DISCONTINUITY-SEQUENCE, and
                       it stays monotonic across a failover because a ring reset folds the discarded window
                       into it rather than zeroing. -->
                  <template v-if="sel.ingest.discSeq !== undefined">
                    {{ sel.ingest.discInWindow }} in window · {{ sel.ingest.discSeq }} aged out
                    <span class="asd-sub">· the second is #EXT-X-DISCONTINUITY-SEQUENCE</span>
                  </template>
                  <span v-else class="asd-nm">not reported by this sidecar</span>
                </div>
                <div class="k">Ad break</div>
                <div class="v mono">
                  <template v-if="sel.adBreak">
                    <template v-if="sel.adBreak.inBreak">in break · {{ (breakAge(sel) / 1000).toFixed(0) }}s<template v-if="sel.adBreak.announcedSec > 0"> / ~{{ sel.adBreak.announcedSec.toFixed(0) }}s announced</template></template>
                    <template v-else>programming</template>
                    <span class="asd-sub">· via {{ sel.adBreak.signal }}</span>
                  </template>
                  <span v-else class="asd-nm">no break ever detected on this channel</span>
                </div>
                <div class="k">Breaks seen</div>
                <div class="v mono">
                  <template v-if="sel.adBreak">
                    {{ sel.adBreak.breaksSeen }}<template v-if="sel.adBreak.totalBreakSec > 0"> · {{ (sel.adBreak.totalBreakSec / 60).toFixed(1) }} min total</template>
                    <span class="asd-sub">· {{ sel.adBreak.profileChanged ? 'profile changes across the splice' : 'profile stable' }}</span>
                  </template>
                  <span v-else class="asd-nm">not measured</span>
                </div>
                <div class="k">Requested format</div>
                <!-- The row this whole card exists for: "I set Raw-TS and I am still being served HLS, why?"
                     `requested` is what the GRANT was built from, `delivery` is what is on the wire — so the
                     two disagreeing IS the fallback, stated rather than inferred. Note an in-app play carries
                     no `?pl`, so it legitimately resolves the DEFAULT config even for a Custom playlist. -->
                <div class="v mono">
                  <template v-if="sel.requested">
                    {{ sel.requested.outputFormat }} requested
                    <!-- Names the cause once it is known, and only enumerates candidates while it is not.
                         Before register #11 this row could only ever list all three possibilities. -->
                    <span v-if="sel.requested.outputFormat === 'ts' && sel.delivery === 'hls'" class="asd-sub" style="color: var(--warn);">
                      · fell back to HLS —
                      <template v-if="sel.encryption && sel.encryption !== 'NONE'">the upstream is {{ sel.encryption }} encrypted</template>
                      <template v-else-if="sel.container === 'fMP4'">the upstream is fMP4</template>
                      <template v-else>the upstream is AES/fMP4 or unreachable as raw TS</template>
                    </span>
                    <span v-else class="asd-sub">· serving {{ deliveryLabel(sel.delivery) }}</span>
                    <span class="asd-sub">· ring {{ sel.requested.originEnabled ? `on, ${sel.requested.originRingMb} MB` : 'off' }}<template v-if="sel.requested.spliceNormalize">, splice-normalized</template></span>
                  </template>
                  <span v-else class="asd-nm">not reported for this stream yet</span>
                </div>
                <div class="k">Cover</div>
                <div class="v mono">0 s <span class="asd-sub">· structurally zero — the whole ring is published, nothing is held back (register #26)</span></div>
              </template>
              <template v-else>
                <div class="k">Rendering</div><div class="v asd-nm">not authored — no manifest measured for this channel</div>
                <div class="k">Published window</div><div class="v asd-nm">not measured</div>
                <div class="k">Target duration</div><div class="v asd-nm">not measured</div>
                <div class="k">Discontinuity</div><div class="v asd-nm">not measured</div>
                <div class="k">Ad break</div><div class="v asd-nm">not measured</div>
                <div class="k">Breaks seen</div><div class="v asd-nm">not measured</div>
                <!-- The ONE row in this branch that is not about the (absent) manifest: `requested` describes
                     the GRANT, which every channel has. It is also at its most diagnostic here — a channel
                     showing "ring on" in this column while the rest of the pane reads "not authored" is
                     precisely an origin that was asked for and did not happen. -->
                <div class="k">Requested format</div>
                <div class="v mono">
                  <template v-if="sel.requested">
                    {{ sel.requested.outputFormat }} requested
                    <span v-if="sel.requested.outputFormat === 'ts' && sel.delivery === 'hls'" class="asd-sub" style="color: var(--warn);">· fell back to HLS</span>
                    <span v-else class="asd-sub">· serving {{ deliveryLabel(sel.delivery) }}</span>
                    <span class="asd-sub" :style="sel.requested.originEnabled ? 'color: var(--warn);' : ''">· ring {{ sel.requested.originEnabled ? `requested (${sel.requested.originRingMb} MB) but none is running` : 'off' }}</span>
                  </template>
                  <span v-else class="asd-nm">not reported for this stream yet</span>
                </div>
                <div class="k">Cover</div><div class="v asd-nm">not measured</div>
              </template>
            </div>

            <!-- 4 · OUTPUT // FEED — what the IPTV clients actually receive. The only demand-side card, and
                 where the ring's payoff is finally stated as a number. -->
            <div v-else class="kv-list">
              <div class="k">Wire format</div>
              <div class="v mono">{{ deliveryLabel(sel.delivery) }}</div>
              <div class="k">Viewers</div>
              <div class="v mono">
                {{ sel.viewers }} now · peak {{ sel.peakViewers }}
                <span class="asd-sub">· {{ sel.viewersByPlayer.appPlayer }} in-app / {{ sel.viewersByPlayer.externalPlayer }} external</span>
              </div>
              <div class="k">Egress</div>
              <div class="v mono">{{ sel.bandwidth.toFixed(1) }} Mbps out <span class="asd-sub">· summed across all viewers</span></div>
              <div class="k">Delivered</div>
              <div class="v mono">{{ mib(sel.bytesTotal) }} MiB <span class="asd-sub">· to CURRENT viewers (falls when one leaves)</span></div>
              <div class="k">Per-viewer</div>
              <div class="v mono">{{ sel.bitrate.toFixed(2) }} Mbps</div>
              <div class="k">Amplification</div>
              <div class="v mono">{{ selAmplification }}</div>
              <div class="k">Per-viewer QoE</div>
              <div class="v mono">
                <template v-if="selQoe">
                  {{ selQoe.stalls }} stall{{ selQoe.stalls === 1 ? '' : 's' }} · {{ (selQoe.ms / 1000).toFixed(1) }}s stalled
                  <!-- The count rises when a stall BEGINS, the duration only when it ENDS — so "1 stall ·
                       0.0s" means one is in progress. Saying "completed intervals" here would describe the
                       data backwards. -->
                  <span class="asd-sub">· Σ over {{ (selClients ?? []).length }} session{{ (selClients ?? []).length === 1 ? '' : 's' }} — an in-progress stall is counted, its duration is not yet</span>
                </template>
                <span v-else class="asd-nm">no connected session reports it yet</span>
              </div>
              <div class="k">Session end</div>
              <!-- Deliberately ASYMMETRIC copy. A raw-TS socket reports a real cause; an HLS session reports
                   only how we noticed it had gone. Rendering both through one sentence would let "poll
                   timeout" read as a diagnosis, and would make HLS channels look healthier than raw-TS ones
                   purely because their endings are less legible. -->
              <div class="v mono">
                <template v-if="sel.lastClose">
                  {{ closeReasonLabel(sel.lastClose.reason) }}
                  <span class="asd-sub">· {{ ageLabel(Date.now() - sel.lastClose.at) }} ago</span>
                  <span v-if="!sel.lastClose.socketBound" class="asd-sub">· HLS sessions never announce a departure, so this is how we noticed, not why it ended</span>
                </template>
                <!-- Not "not measured": nothing has ended yet, which is a real state. -->
                <span v-else class="asd-nm">no session has ended on this channel yet</span>
              </div>
            </div>

            <div class="asd-label-ft" aria-hidden="true">
              <span class="asd-cap-dim">{{ paneMeta.spec }}</span><span class="asd-mk">{{ paneMeta.mk }}</span>
            </div>
          </div>

          <div class="card flush stream-sessions asd-label asd-label-flush">
            <div class="card-hd asd-label-hd">
              <span class="asd-cap">SESSIONS // CONNECTED</span>
              <Pill tone="cyan">{{ clients.length }}</Pill>
              <span class="spacer" />
            </div>
            <div v-if="clients.length === 0" class="empty" style="padding: 28px;">
              <div class="muted">{{ sel.status === 'bad' ? 'No viewers — stream is offline.' : 'No connected viewers right now.' }}</div>
            </div>
            <!-- The ONLY scroller in the panel: capped to ~2 data rows, header pinned (sticky thead). -->
            <div v-else class="asd-sess-scroll">
              <table class="tbl">
                <thead>
                  <tr><th>User</th><th>Client IP</th><th>Location</th><th>Player</th><th>Connected</th><th>Rate</th><th>Stalls</th></tr>
                </thead>
                <tbody>
                  <!-- `connectedAt` is part of the key because ip|ua|user is NOT unique: a raw-TS viewer gets
                       one connection PER SOCKET, so two sockets from the same client would otherwise collapse
                       into one duplicate Vue key. -->
                  <tr v-for="c in clients" :key="c.ip + c.userAgent + (c.username ?? '') + c.connectedAt">
                    <td><Pill tone="cyan"><Icon name="check" :size="11" />{{ c.username || 'unknown' }}</Pill></td>
                    <td class="mono">{{ c.ip }}</td>
                    <td class="mono" style="max-width: 160px;"><div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ flagEmoji(c.countryCode) }} {{ c.location || '—' }}</div></td>
                    <td style="max-width: 240px;">
                      <div class="row" style="gap: 6px; align-items: center; white-space: nowrap; overflow: hidden;">
                        <Pill :tone="c.playerType === 'externalPlayer' ? 'system' : 'cyan'">{{ playerLabel(c) }}</Pill>
                        <span class="mono muted" style="overflow: hidden; text-overflow: ellipsis;" :title="c.userAgent">{{ c.userAgent || 'unknown' }}</span>
                      </div>
                    </td>
                    <td class="mono muted">{{ sinceLabel(c.connectedAt) }}</td>
                    <td class="mono">{{ rateKB(c.currentRate) }} KB/s</td>
                    <!-- Em-dash ONLY when the server does not report it. A reporting server with zero stalls
                         shows `0`, which is a measurement; an em-dash would read as the same thing. -->
                    <td class="mono" :style="c.bufferCount ? 'color: var(--warn);' : ''"
                        :title="typeof c.rebufferMs === 'number' ? `${c.bufferCount ?? 0} stall(s) begun · ${(c.rebufferMs / 1000).toFixed(1)}s of them finished${c.socketBound ? ' · raw-TS socket' : ''}` : undefined">
                      <template v-if="typeof c.bufferCount === 'number'">{{ c.bufferCount }}</template>
                      <span v-else style="color: var(--text-3);">—</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="card empty" style="flex: 1; display: grid; place-items: center;">
      <div style="text-align: center;">
        <Icon name="tv" :size="32" />
        <h3 style="margin-top: 12px;">No active streams</h3>
        <div class="muted" style="font-size: var(--fs-sm);">Play a channel through the proxy and it appears here in real time.</div>
      </div>
    </div>

    <!-- Stream viewer slide-over -->
    <div v-if="viewStream" class="stream-view-bg" @click="close">
      <div class="stream-view" @click.stop>
        <div class="stream-view-hd">
          <ChannelLogo :ch="chOf(viewStream)" />
          <div style="min-width: 0; flex: 1;">
            <div class="row" style="gap: 8px;">
              <span style="font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ chOf(viewStream).tvg_name }}</span>
              <span v-if="viewStream.status !== 'bad'" class="live-pill"><span class="dot" />LIVE</span>
              <Pill v-else tone="bad"><Icon name="warn" :size="11" />offline</Pill>
            </div>
            <div class="mono muted" style="font-size: var(--fs-xs); margin-top: 3px;">
              #{{ chOf(viewStream).channelNo ?? '—' }} · {{ chOf(viewStream).group }} ·
              {{ viewStream.status === 'bad' ? 'no signal' : (viewStream.resolution ?? '—') + ' · ' + viewStream.bitrate.toFixed(1) + ' Mbps' }}
            </div>
          </div>
          <Btn variant="ghost" size="sm" icon="x" @click="close" title="Close (Esc)" />
        </div>

        <div class="stream-view-body">
          <div class="player" style="border-radius: 12px;">
            <template v-if="viewStream.status === 'bad'">
              <div style="position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-2); font-size: 13px;">
                <div style="text-align: center;">
                  <Icon name="warn" :size="32" />
                  <div style="margin-top: 12px; font-weight: 600; color: var(--text-1); font-size: 15px;">Stream offline</div>
                  <div class="mono" style="font-size: 11px; margin-top: 6px;">upstream unreachable</div>
                </div>
              </div>
            </template>
            <template v-else>
              <div class="stripes" />
              <div class="label mono">{{ viewTech?.resolution }} · {{ viewTech?.fps ?? '—' }}fps · {{ viewStream.bitrate.toFixed(1) }} Mbps</div>
              <div v-if="!playing" class="play" @click="playing = true">
                <div class="play-btn"><Icon name="play" :size="28" /></div>
              </div>
              <div class="controls">
                <button class="player-ctrl" @click="playing = !playing">
                  <Icon :name="playing ? 'pause' : 'play'" :size="14" />
                </button>
                <div class="track" />
                <button class="player-ctrl" @click="muted = !muted">
                  <Icon :name="muted ? 'x' : 'check'" :size="13" />
                </button>
                <span class="mono" style="font-size: 11px;">LIVE</span>
                <button class="player-ctrl" title="Fullscreen"><Icon name="grid" :size="13" /></button>
              </div>
            </template>
          </div>

          <div v-if="viewStream.status !== 'bad'" class="card flush" style="background: var(--bg-2);">
            <div class="card-hd" style="padding: 12px 14px;">
              <h2 style="font-size: 13px;">From the guide</h2>
              <span class="spacer" />
              <span class="muted" style="font-size: var(--fs-xs);">EPG-matched</span>
            </div>
            <div :style="{ padding: '14px', display: 'grid', gridTemplateColumns: npData(viewStream.channelId).live && npData(viewStream.channelId).next ? '1fr 1fr' : '1fr', gap: '12px' }">
              <div v-if="npData(viewStream.channelId).live"
                   style="padding: 10px 12px; border-radius: 8px; background: var(--accent-soft); border: 1px solid oklch(0.82 0.13 220 / 0.4);">
                <div class="mono" style="font-size: 10px; letter-spacing: 0.08em; color: var(--accent-hi); font-weight: 600;">ON NOW</div>
                <div style="font-weight: 600; font-size: 14px; margin-top: 4px; color: var(--accent-hi);">{{ npData(viewStream.channelId).live!.title }}</div>
                <div class="mono muted" style="font-size: 11px; margin-top: 4px;">
                  {{ formatTime(npData(viewStream.channelId).live!.start) }}–{{ formatTime(npData(viewStream.channelId).live!.end) }} · {{ npData(viewStream.channelId).live!.cat }}
                </div>
              </div>
              <div v-if="npData(viewStream.channelId).next"
                   style="padding: 10px 12px; border-radius: 8px; background: var(--bg-3); border: 1px solid var(--hairline);">
                <div class="mono" style="font-size: 10px; letter-spacing: 0.08em; color: var(--text-2); font-weight: 600;">UP NEXT</div>
                <div style="font-weight: 600; font-size: 14px; margin-top: 4px; color: var(--text-0);">{{ npData(viewStream.channelId).next!.title }}</div>
                <div class="mono muted" style="font-size: 11px; margin-top: 4px;">
                  {{ formatTime(npData(viewStream.channelId).next!.start) }}–{{ formatTime(npData(viewStream.channelId).next!.end) }} · {{ npData(viewStream.channelId).next!.cat }}
                </div>
              </div>
            </div>
          </div>

          <div class="metric-grid" style="grid-template-columns: repeat(4, 1fr);">
            <div class="metric"><div class="lbl">Viewers</div><div class="val" style="font-size: 17px;">{{ viewStream.viewers }}</div></div>
            <div class="metric"><div class="lbl">Bitrate</div><div class="val" style="font-size: 17px;">{{ viewStream.status === 'bad' ? '—' : viewStream.bitrate.toFixed(1) + ' Mbps' }}</div></div>
            <div class="metric"><div class="lbl">Bandwidth</div><div class="val" style="font-size: 17px;">{{ viewStream.bandwidth }} Mbps</div></div>
            <div class="metric"><div class="lbl">Uptime</div><div class="val" style="font-size: 17px;">{{ viewStream.uptime }}</div></div>
          </div>

          <div class="card flush" style="background: var(--bg-2);">
            <div class="card-hd" style="padding: 12px 14px;">
              <h2 style="font-size: 13px;">Stream details</h2>
              <span class="spacer" />
              <Pill :tone="viewStream.status === 'bad' ? 'bad' : viewStream.status === 'warn' ? 'warn' : 'good'">
                <StatusDot :status="viewStream.status" :pulse="viewStream.status !== 'bad'" />
                {{ viewStream.status === 'bad' ? 'offline' : viewStream.status === 'warn' ? viewStream.phase : 'healthy' }}
              </Pill>
            </div>
            <div style="padding: 14px;">
              <div class="kv-list">
                <div class="k">Video</div><div class="v mono">{{ viewTech?.video }}</div>
                <div class="k">Audio</div><div class="v mono">{{ viewTech?.audio }}</div>
                <div class="k">Container</div><div class="v mono">{{ viewTech?.container }}</div>
                <div class="k">Delivery</div><div class="v mono">{{ deliveryLabel(viewStream.delivery) }}</div>
                <div class="k">Resolution</div><div class="v mono">{{ viewTech?.resolution }}<template v-if="viewTech?.fps"> @ {{ viewTech?.fps }}fps</template></div>
                <div class="k">Bandwidth</div><div class="v mono">{{ viewStream.bandwidth }} Mbps egress</div>
                <div class="k">TVG-ID</div>
                <div class="v mono">
                  <template v-if="chOf(viewStream).tvg_id">{{ chOf(viewStream).tvg_id }}</template>
                  <span v-else style="color: var(--text-3);">—</span>
                </div>
                <div class="k">Source</div>
                <div class="v"><Pill tone="cyan">{{ chOf(viewStream).source }}</Pill></div>
              </div>
            </div>
          </div>

          <div class="row" style="gap: 8px;">
            <Btn variant="ghost" icon="edit">Edit channel</Btn>
            <span class="spacer" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* masqueradarr stage depth — lift the top-level surfaces off the brand gradient field. The 4 stat
   cards + the empty state now inherit the elevation from the global .card recipe (which carries the
   same gradient + sheen + multi-layer shadow), so their scoped copies were removed as pure duplicates.
   The streams LIST panel is NOT a .card, so the global rule never reaches it — it keeps its explicit
   lift here (own bg retained, elevation only). The stream-DETAIL panel is a borderless HUD instrument
   cluster (no surface, no lift — defined by corner brackets, a brand header, and flat spec-label inner
   cards), so it is intentionally NOT lifted here. The slide-over viewer modal is also not matched, and
   the liveline's container is never touched. */
.mq-active .streams-list {
  border-color: var(--hairline-strong);
  box-shadow:
    inset 0 1px 0 var(--hairline-strong),
    0 1px 2px rgba(0, 0, 0, 0.28),
    0 14px 34px rgba(0, 0, 0, 0.34);
}
[data-theme="light"] .mq-active .streams-list {
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.8),
    0 1px 2px rgba(0, 0, 0, 0.06),
    0 12px 28px rgba(0, 0, 0, 0.10);
}

/* ───────────────────────── stream-detail → HUD instrument cluster ─────────────────────────
   Everything below is SCOPED under .stream-detail so the globally-shared .card / .metric / .kv-list
   rules are never altered for other screens. Definition comes from corner brackets, a brand header,
   hairlines, teal mono captions, the metric emblems, and accent underbars — not fills/borders.
   Theme-aware tokens only (no reference HEX), so light mode stays legible. */

/* Corner brackets framing the borderless panel (the LoginScreen/SetupScreen idiom). */
.stream-detail .corner {
  position: absolute;
  width: 14px;
  height: 14px;
  pointer-events: none;
  z-index: 1;
}
.stream-detail .corner.tl { top: 9px; left: 9px; border-top: 1.5px solid var(--bracket); border-left: 1.5px solid var(--bracket); }
.stream-detail .corner.tr { top: 9px; right: 9px; border-top: 1.5px solid var(--bracket); border-right: 1.5px solid var(--bracket); }
.stream-detail .corner.bl { bottom: 9px; left: 9px; border-bottom: 1.5px solid var(--bracket); border-left: 1.5px solid var(--bracket); }
.stream-detail .corner.br { bottom: 9px; right: 9px; border-bottom: 1.5px solid var(--bracket); border-right: 1.5px solid var(--bracket); }

/* Brand telemetry header (mirrors the Dashboard .mq-* header chrome — those classes are scoped to the
   Dashboard, so the equivalents are redeclared here scoped to this panel). */
.stream-detail .asd-hdr-strip {
  display: flex;
  align-items: stretch;
  gap: 16px;
}
/* Left: the two stacked mono lines (brand line over the SYS / ACTIVE SESSION overline). */
.stream-detail .asd-hdr-text {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 5px;
  flex: none;
}
.stream-detail .mq-micro-hi {
  font-family: var(--mq-font-mono);
  font-size: 9.5px;
  letter-spacing: 0.16em;
  color: var(--text-2);
}
.stream-detail .mq-overline { display: flex; align-items: center; gap: 9px; }
.stream-detail .mq-ov-tag { font-family: var(--mq-font-mono); font-size: 10.5px; letter-spacing: 0.16em; color: var(--accent); }
.stream-detail .mq-ov-rule { height: 1px; width: 42px; background: var(--accent); opacity: 0.5; }
.stream-detail .mq-ov-dim { font-family: var(--mq-font-mono); font-size: 10.5px; letter-spacing: 0.16em; color: var(--text-3); }
/* Middle: a per-stream deterministic barcode (fills), height = the two-line text block, faint band behind. */
.stream-detail .asd-hdr-bars {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in oklab, var(--text-3) 6%, transparent);
}
.stream-detail .asd-hdr-bars .mq-barcode {
  display: block;
  width: 100%;
  height: 22px;
  opacity: 0.45;
}
.stream-detail .asd-hdr-bars .mq-barcode rect { fill: var(--text-2); }
/* Right: two stacked dim mono code tags, right-aligned. */
.stream-detail .asd-hdr-tags {
  flex: none;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: flex-end;
  gap: 5px;
  font-family: var(--mq-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.12em;
  color: var(--text-3);
}

/* Header action: "View channel" is now an icon-only HUD control (bracketed, teal glyph) — the
   masqueradarr orbit-globe / UPLINK radar motif (MK-07.10) — instead of the heavy primary fill, to
   suit the stripped panel. (Class kept as .asd-globe: it's a CSS hook, not the glyph name.) */
.stream-detail .asd-globe {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: var(--accent-soft);
  border: 1px solid oklch(0.82 0.13 220 / 0.35);
  color: var(--accent-hi);
  cursor: default;
  transition: background .12s, border-color .12s, box-shadow .12s;
}
.stream-detail .asd-globe:hover {
  background: color-mix(in oklab, var(--accent) 22%, transparent);
  border-color: oklch(0.82 0.13 220 / 0.55);
  box-shadow: 0 0 12px var(--accent-glow);
}

/* Spec-sheet "label" instruments (the MK-07.10 UPLINK SPEC idiom): flat surface, a teal mono caption
   over a hairline, and an optional footer code-tag bar. Shared by the bitrate/technical/source cards;
   the sessions card reuses the caption styles via .asd-label-hd on its existing .card-hd. */
.stream-detail .asd-label {
  background: transparent;
  border: none;
  border-radius: 0;
  box-shadow: none; /* zero the global .card elevation — these HUD labels are flat by design */
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
}
.stream-detail .asd-label-flush { padding: 0; }
.stream-detail .asd-label-hd {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 9px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--hairline);
}
.stream-detail .asd-label-hd .spacer { flex: 1; }
.stream-detail .card-hd.asd-label-hd { margin-bottom: 0; }
.stream-detail .asd-cap {
  font-family: var(--mq-font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--accent);
  white-space: nowrap;
}
.stream-detail .asd-cap-dim {
  font-family: var(--mq-font-mono);
  font-size: 9.5px;
  letter-spacing: 0.12em;
  color: var(--text-2);
}
/* Footer code-tag bar (the muse's "UPLINK SPEC · MK-07.10" footer). */
.stream-detail .asd-label-ft {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--hairline);
}
.stream-detail .asd-mk {
  font-family: var(--mq-font-mono);
  font-size: 9.5px;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
/* kv-list rows recast to the mono spec idiom inside the label cards. */
.stream-detail .asd-label .kv-list .k { font-family: var(--mq-font-mono); font-size: 11px; letter-spacing: 0.04em; color: var(--text-2); }

/* Short-window fit: bound the content column to the fixed (overflow:hidden) panel height and let ONLY the
   instrument cards scroll when they can't all fit — the brand header + stream title stay pinned above.
   Without this, a column taller than the panel pushes the sessions card past the bottom edge and its rows
   get clipped (the reported "sessions header shows, no rows"). The sessions card is pinned (flex:none) so
   the column scrolls TO it rather than collapsing it; the sessions table keeps its own internal scroll. */
.stream-detail .stream-detail-split { grid-template-rows: minmax(0, 1fr); }
/* Also the QUERY CONTAINER for the stage rail below. Named, so it can never bind to `.docs-panel`'s
   anonymous container. Viewport @media would be the wrong axis entirely: this column's width is driven by
   the fixed 380px list column and the density tokens, not by the viewport. */
.stream-detail .stream-detail-main { overflow-y: auto; container: asdflow / inline-size; }
.stream-detail .stream-sessions { flex: none; }

/* Connected-sessions table → mono + hairline idiom (table semantics unchanged). */
.stream-detail .stream-sessions .tbl th {
  font-family: var(--mq-font-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  color: var(--text-2);
}
/* Flush card owns its caption padding; tighten the bottom so the caption groups with the header row. */
.stream-detail .stream-sessions .card-hd.asd-label-hd { padding: 12px 14px 8px; }
.stream-detail .stream-sessions .asd-sess-scroll {
  max-height: calc(var(--row-h) * 3 + 34px);
  overflow-y: auto;
}
/* Sticky header pins to the SCROLL BOX top (top:0) — NOT the shared .tbl default top:var(--topbar-h),
   which is for tables scrolling inside .screen. Opaque bg so scrolled rows don't bleed through the
   borderless (transparent) panel. Density-aware via --row-h. */
.stream-detail .stream-sessions .asd-sess-scroll .tbl thead th {
  top: 0;
  padding-top: 4px;
  background: var(--bg-1);
  z-index: 1;
}

/* Engine rail header caption (the teal spec-label cue trails the existing title). */
.stream-detail .asd-railhd .spacer { flex: 1; }
.stream-detail .asd-railhd .asd-cap { color: var(--accent); }

/* ── Four-stage byte-path rail + pane (MK-07.10 → MK-07.13) ───────────────────────────────────────────
   Three layout decisions here are load-bearing, not taste:
   1. A FIXED four-column grid with literal 12px connector tracks. `auto-fit`/`auto-fill` are wrong: at the
      column's ~404px floor they wrap to a 2×2 block, destroying the left-to-right byte-path metaphor at
      exactly the width where the panel is most cramped.
   2. `minmax(0, 1fr)`, never bare `1fr` — without the zero floor a long headline widens its own track and
      the ellipsis never engages.
   3. Sticky with `padding-top` cancelled by an equal negative `margin-top`: at rest the visual spacing is
      unchanged, but once pinned the opaque box also covers .stream-detail-main's 16px flex gap, so rows
      cannot bleed through the borderless panel. */
.stream-detail .asd-flow {
  position: sticky;
  top: 0;
  z-index: 2;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 12px minmax(0, 1fr) 12px minmax(0, 1fr) 12px minmax(0, 1fr);
  align-items: stretch;
  background: var(--bg-1);
  padding-top: 16px;
  margin-top: -16px;
}
.stream-detail .asd-fl-arrow {
  display: grid;
  place-items: center;
  color: var(--text-3);
}
.stream-detail .asd-fl-tile {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  /* 7px sides, not 9: at the narrowest real container (388px — spacious density at the app's 1100px
     minimum) the extra 4px is exactly what keeps the 12-char headlines off the ellipsis. It is a BASE
     value rather than a narrow-band override on purpose — a breakpoint anywhere in the 380-440px band
     would flip back and forth as the column's 10px scrollbar appears and disappears. */
  padding: 7px 7px;
  text-align: left;
  background: transparent;
  border: none;
  border-left: 2px solid var(--fl, var(--text-3));
  border-radius: 0;
  cursor: pointer;
  color: var(--text-1);
  font: inherit;
  transition: background .12s, color .12s;
}
.stream-detail .asd-fl-tile:hover { background: var(--bg-2); }
.stream-detail .asd-fl-tile.active { background: var(--accent-soft); }
.stream-detail .asd-fl-tile.active .asd-cap { color: var(--accent-hi); }
/* styles.css kills `outline` app-wide and defines no :focus-visible anywhere, so without this the rail is
   keyboard-operable but completely invisible to a keyboard user. Scoped — the global rule stays untouched. */
.stream-detail .asd-fl-tile:focus-visible { box-shadow: inset 0 0 0 1px var(--accent-hi); }
/* Tone → hue. This is the FOURTH signal: glyph, state word and headline text all carry it first. Solid vs
   dashed encodes measured-vs-not in pure greyscale, which is the distinction that must never be lost. */
.stream-detail .asd-fl-tile.t-ok { --fl: var(--good); }
.stream-detail .asd-fl-tile.t-warn { --fl: var(--warn); }
.stream-detail .asd-fl-tile.t-bad { --fl: var(--bad); }
.stream-detail .asd-fl-tile.t-unknown { --fl: var(--text-3); border-left-style: dashed; }
.stream-detail .asd-fl-tile.t-na { --fl: var(--text-3); border-left-style: dashed; }
.stream-detail .asd-fl-tile.t-unknown .asd-fl-val,
.stream-detail .asd-fl-tile.t-na .asd-fl-val { color: var(--text-3); }
.stream-detail .asd-fl-top { display: flex; align-items: center; gap: 4px; min-width: 0; color: var(--fl); }
.stream-detail .asd-fl-dash { font-family: var(--mq-font-mono); font-size: 11px; line-height: 1; }
/* 10px is the BASE, stepping up with the container — not the other way round. Measured: at the panel's
   404px floor a tile gives 72px of text, which is ~10.9 chars at 11px but ~12 at 10px. Six real headline
   strings ("no upstream", "establishing", "14 seg woven", "break stuck", "not authored", "12 · 138.4M")
   land in that gap and would ellipsize on the widths operators actually run. The full string is always on
   the tile's title, but a truncated verdict is a verdict you have to hover to trust. */
.stream-detail .asd-fl-val {
  min-width: 0; /* without this the ellipsis never engages */
  font-family: var(--mq-font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stream-detail .asd-fl-mk {
  display: none; /* re-enabled by the container query below once there is room for a third line */
  font-family: var(--mq-font-mono);
  font-size: 9px;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
/* Visually hidden, still announced — the state WORD must reach a screen reader even though the tile shows
   it as a glyph + colour. */
.stream-detail .asd-sr {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.stream-detail .asd-stage { padding-top: 0; }
/* "Not measured" is a first-class rendered state, never a bare em-dash: an empty cell reads as "this
   stream has nothing", which is the false all-clear the whole design exists to prevent. */
.stream-detail .asd-nm { color: var(--text-3); font-style: italic; font-size: var(--fs-xs); }
.stream-detail .asd-sub { color: var(--text-3); font-size: var(--fs-xs); }
/* Single-line, ellipsised, full value on the title. A wrapping URL was the one thing defeating the fixed
   8-row count's actual purpose: `word-break: break-all` let stage 1 grow by a line or two, so switching
   stages still nudged the sessions card below. Height is stage-independent only if every row is too. */
.stream-detail .asd-url { font-size: 11px; }
.stream-detail .asd-url-1 {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@container asdflow (min-width: 520px) {
  .stream-detail .asd-fl-mk { display: block; }
  .stream-detail .asd-fl-tile { padding: 9px 11px; }
  .stream-detail .asd-fl-val { font-size: 11px; }
}
@container asdflow (min-width: 720px) {
  .stream-detail .asd-fl-val { font-size: 12px; }
}
/* The tile transition is the only motion added here — there is no expand/collapse animation at all (the
   pane swap is an instant v-if). Kill it outright rather than slowing it: at this size a colour fade
   carries no information. */
@media (prefers-reduced-motion: reduce) {
  .stream-detail .asd-fl-tile { transition: none; }
}
</style>
