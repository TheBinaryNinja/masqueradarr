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
import { useStreamStats, serverNow } from '../composables/useStreamStats';

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
function playerLabel(c: StreamClient): string {
  return c.playerType === 'externalPlayer' ? externalClientName(c.userAgent) : 'In-App';
}
function deliveryLabel(d: ActiveStream['delivery']): string {
  return d === 'ts' ? 'Raw TS' : d === 'mixed' ? 'Mixed (HLS + TS)' : 'HLS';
}

function failoverTitle(f: NonNullable<ActiveStream['failover']>): string {
  return f.attempt >= 1
    ? `This channel's upstream failed — ${f.candidateName} took over on attempt #${f.attempt}`
    : `This channel resolved through ${f.candidateName} rather than its default upstream`;
}

const selSeries = computed(() => {
  if (!sel.value) return [];
  return bitrateSeries(sel.value.id).filter(Number.isFinite);
});
const selTarget = computed(() => sel.value?.bitrate || 1);
const selAvg = computed(() => {
  const s = selSeries.value;
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : (sel.value?.bitrate || 0);
});
const selMin = computed(() => (selSeries.value.length ? Math.min(...selSeries.value) : (sel.value?.bitrate || 0)));
const selMax = computed(() => (selSeries.value.length ? Math.max(...selSeries.value) : (sel.value?.bitrate || 0)));

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
  const a = `${src.slice(0, 2)}-${100 + (h % 900)}`;
  const b = `${src.slice(-2) || 'HL'}-${10 + ((h >>> 8) % 90)}`;
  return [a, b];
});

const viewStream = computed(() => liveStreams.value.find((s) => s.id === viewing.value));

const clients = ref<StreamClient[]>([]);
const clientsOf = ref<string | null>(null);
let clientsReq = 0;
let clientsTimer: number | undefined;
async function loadClients(id: string | undefined) {
  const my = ++clientsReq;
  if (!id) { clients.value = []; clientsOf.value = null; return; }
  try {
    const res = await fetch(`/api/active-streams/${encodeURIComponent(id)}/clients`);
    if (my !== clientsReq) return;
    if (res.ok) { clients.value = (await res.json()) as StreamClient[]; clientsOf.value = id; }
    else clientsOf.value = null;
  } catch { clientsOf.value = null; }
}
const selClients = computed(() => (sel.value && clientsOf.value === sel.value.id ? clients.value : null));
watch(() => sel.value?.id, (id) => loadClients(id), { immediate: true });

function onView() { if (!sel.value) return; viewing.value = sel.value.id; playing.value = sel.value.status !== 'bad'; muted.value = false; }
function close() { viewing.value = null; }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && viewing.value) close(); }
onMounted(() => { subscribe(); window.addEventListener('keydown', onKey); clientsTimer = window.setInterval(() => loadClients(sel.value?.id), 4000); });
onBeforeUnmount(() => { release(); window.removeEventListener('keydown', onKey); if (clientsTimer) clearInterval(clientsTimer); });

function formatTime(ms: number) { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
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

function rateKB(bps: number) { return (bps / 1024).toFixed(0); }
function sinceLabel(ts: number) { const m = Math.floor((serverNow() - ts) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; }
function suspectLabel(slug: string): string {
  return {
    'undecodable-video': 'upstream video has no decoder parameter sets',
    'not-transport-stream': 'upstream segments are not MPEG-TS',
  }[slug] ?? slug;
}

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

const TONE_META: Record<Tone, { glyph: string; word: string }> = {
  ok: { glyph: 'check', word: 'OK' },
  warn: { glyph: 'activity', word: 'DEGRADED' },
  bad: { glyph: 'warn', word: 'FAULT' },
  unknown: { glyph: 'info', word: 'NOT MEASURED' },
  na: { glyph: '', word: 'N/A' },
};

function staleMs(ing: ActiveStream['ingest']): number {
  return Math.min(Math.max(4 * (ing?.targetDuration || 6) * 1000, 30_000), 90_000);
}
function ageLabel(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}
function mib(bytes: number): string { return (bytes / 1048576).toFixed(1); }
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
function shapeLabel(shape: string): string {
  return {
    'ts': 'bare MPEG-TS socket — we segment it ourselves',
    'hls-master': 'HLS master — we pick a variant',
    'hls-media': 'HLS media playlist — followed directly',
  }[shape] ?? shape;
}

const DWELL_MS = 7500;
const SOURCE_DWELL_MS = 18_000;
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

const lastFault: Record<string, Tone> = {};

const breakSeen: Record<string, { at: number; recvAt: number }> = {};
function breakAge(s: ActiveStream): number {
  const b = s.adBreak;
  if (!b) return 0;
  const cur = breakSeen[s.channelId];
  if (!cur || cur.at !== b.at) {
    const age = Math.max(0, serverNow() - b.at);
    breakSeen[s.channelId] = { at: b.at, recvAt: Date.now() - age };
    return age;
  }
  return Date.now() - cur.recvAt;
}

watch(liveStreams, (streams) => {
  const live = new Set(streams.map((s) => s.channelId));
  for (const id of Object.keys(lastFault)) if (!live.has(id)) delete lastFault[id];
  for (const id of Object.keys(breakSeen)) if (!live.has(id)) delete breakSeen[id];
  for (const k of Object.keys(dwell)) if (!live.has(k.slice(0, k.lastIndexOf('|')))) delete dwell[k];
});

function stateSource(): StageState {
  const s = sel.value;
  if (!s) return { tone: 'na', text: '—', title: 'No stream selected.' };
  const ing = s.ingest;
  const originish = !!ing && ing.status !== 'closed';
  const age = ingestAge(s.channelId);
  const silent = originish && age > Math.max(45_000, staleMs(ing));
  const who = s.source || '—';
  const fo = s.failover;
  const attribution = fo ? `${who} · alt${fo.attempt >= 1 ? ` #${fo.attempt}` : ''}` : who;
  const retired = ing?.suspectRetires || 0;

  let tone: Tone;
  let text: string;
  if (originish ? ing!.status === 'resolve_failed' : s.status === 'bad') { tone = 'bad'; text = 'no upstream'; }
  else if (silent) { tone = 'unknown'; text = `silent ${ageLabel(age)}`; }
  else if (!ing && s.phase === 'establishing') { tone = 'unknown'; text = 'establishing'; }
  else if (originish ? ing!.status === 'stalled' : s.status === 'warn') { tone = 'warn'; text = 'stalled'; }
  else if (originish ? ing!.status === 'ok' : s.status === 'good') { tone = 'ok'; text = attribution; }
  else { tone = 'unknown'; text = 'no reading'; }

  if (tone === 'ok' && retired > 0) text = `${attribution} · retired ×${retired}`;
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

function stateIngest(): StageState {
  const s = sel.value;
  if (!s) return { tone: 'na', text: '—', title: 'No stream selected.' };
  const ing = s.ingest;
  if (!ing) {
    return {
      tone: 'na',
      text: 'no ring',
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
  else if (ing.ineligible) { tone = 'na'; text = 'rewrite'; }
  else if (ing.ineligible === undefined && ing.status === 'closed' && !holding) { tone = 'na'; text = 'rewrite'; }
  else if (ing.status === 'stalled') { tone = 'warn'; text = 'stalled'; }
  else if (age >= 3 * st && lastFault[s.channelId]) {
    tone = lastFault[s.channelId];
    text = tone === 'bad' ? 'resolve ×' : 'stalled';
  } else if (age >= 3 * st) { tone = 'unknown'; text = 'no reading'; }
  else if (ing.status === 'closed') { tone = 'ok'; text = 'ended'; }
  else if (age >= st) { tone = 'warn'; text = `silent ${ageLabel(age)}`; }
  else if (ing.status === 'ok') { tone = 'ok'; text = `${ing.ringSegments} seg`; }
  else { tone = 'unknown'; text = 'no reading'; }

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

function stateManifest(): StageState {
  const s = sel.value;
  if (!s) return { tone: 'na', text: '—', title: 'No stream selected.' };
  const i = s.ingest;
  if (!i || i.status === 'closed') {
    return {
      tone: 'na',
      text: 'not authored',
      title: 'No authored manifest measured for this channel.',
    };
  }
  const age = ingestAge(s.channelId);
  const isFresh = age < staleMs(i);
  const b = s.adBreak;
  const stuck = !!b && b.inBreak && i.status === 'ok' && isFresh
    && breakAge(s) > Math.max(3000 * b.announcedSec, 600_000);
  let tone: Tone;
  let text: string;
  if (stuck) { tone = 'warn'; text = 'break stuck'; }
  else if (i.status === 'stalled') { tone = 'warn'; text = 'frozen'; }
  else if (i.status === 'resolve_failed') { tone = 'warn'; text = 'no upstream'; }
  else if (!isFresh) { tone = 'warn'; text = `silent ${ageLabel(age)}`; }
  else if (i.ringSegments === 0 || i.targetDuration === 0) { tone = 'unknown'; text = 'no reading'; }
  else if (b?.inBreak) {
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

function stateOutput(): StageState {
  const s = sel.value;
  if (!s) return { tone: 'na', text: '—', title: 'No stream selected.' };
  const now = serverNow();
  const rows = selClients.value;
  if (!rows) return { tone: 'unknown', text: 'no reading', title: 'Session list not loaded for this channel yet.' };
  const live = rows.filter((c) => now - c.lastSeen < 10_000);
  const warmed = live.some((c) => now - c.connectedAt >= 15_000);
  const head = `${s.viewers} · ${s.bandwidth.toFixed(1)}M`;
  const title = `${s.viewers} viewer${s.viewers === 1 ? '' : 's'}`
    + ` (${s.viewersByPlayer.appPlayer} in-app / ${s.viewersByPlayer.externalPlayer} external)`
    + ` · ${s.bandwidth.toFixed(1)} Mbps out · ${mib(s.bytesTotal)} MiB to current viewers`;
  if (live.length === 0) return { tone: 'unknown', text: 'draining', title: `${title} · no viewer polled in the last 10s` };
  if (!warmed && s.bandwidth === 0) return { tone: 'unknown', text: 'warming', title: `${title} · rate window not warmed yet` };
  if (warmed && s.bandwidth === 0) return { tone: 'bad', text: 'no egress', title: `${title} · viewers connected but nothing is flowing` };
  return { tone: 'ok', text: head, title };
}

const stageStates = computed<Record<StageKey, StageState>>(() => ({
  source: stateSource(),
  ingest: stateIngest(),
  manifest: stateManifest(),
  output: stateOutput(),
}));
const paneState = computed(() => stageStates.value[stage.value]);
const paneMeta = computed(() => STAGES.find((x) => x.key === stage.value)!);

const selIngestMbps = computed(() => (sel.value ? ingestMbps(sel.value.channelId) : null));

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

const OPEN_RANK: Record<Tone, number> = { bad: 3, warn: 2, unknown: 1, na: 0, ok: 0 };
watch(() => sel.value?.id, () => {
  const st = stageStates.value;
  const ranked = STAGES.map((x, i) => ({ key: x.key, sev: OPEN_RANK[st[x.key].tone], i }))
    .sort((a, b) => b.sev - a.sev || a.i - b.i);
  stage.value = ranked[0].sev > 0 ? ranked[0].key : 'output';
}, { immediate: true });

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
        <span class="corner tl" aria-hidden="true" /><span class="corner tr" aria-hidden="true" />
        <span class="corner bl" aria-hidden="true" /><span class="corner br" aria-hidden="true" />
        <div class="stream-detail-body" :style="{ padding: 'var(--pad-card)', display: 'flex', flexDirection: 'column', gap: '16px' }">
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
                <span class="status-badge-slot">
                  <span v-if="sel.status === 'good'" class="live-pill"><span class="dot" />LIVE</span>
                  <Pill v-else-if="sel.status === 'bad'" tone="bad"><Icon name="warn" :size="11" />offline</Pill>
                  <Pill v-else tone="warn"><Icon name="warn" :size="11" />{{ sel.phase }}</Pill>
                </span>
                <Pill :tone="sel.delivery === 'ts' ? 'cyan' : sel.delivery === 'mixed' ? 'warn' : 'system'"
                  :title="`Wire format served now: ${deliveryLabel(sel.delivery)} — distinct from the Container decode label`">
                  {{ deliveryLabel(sel.delivery) }}
                </Pill>
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

            <div v-if="stage === 'source'" class="kv-list">
              <div class="k">Feed state</div>
              <div class="v mono">
                {{ stageStates.source.text }} <span class="asd-sub">· {{ sel.phase }}</span>
                <span v-if="sel.retry" class="asd-sub" style="color: var(--warn);">· retry {{ sel.retry }}</span>
                <span v-else-if="sel.everStreamed === false" class="asd-sub">· never streamed yet</span>
              </div>
              <div class="k">Source</div>
              <div class="v"><Pill tone="cyan">{{ sel.source }}</Pill></div>
              <div class="k">Stream entry</div>
              <div class="v mono asd-url" :title="chOf(sel).streamEntryUrl">
                <span class="asd-url-1">{{ chOf(sel).streamEntryUrl }}</span>
                <span v-if="sel.upstreamHost" class="asd-sub">· resolves to {{ sel.upstreamHost }} (entry hop)</span>
              </div>
              <div class="k">Protocol</div>
              <div class="v mono">
                <template v-if="sel.upstreamShape || sel.encryption">
                  <template v-if="sel.upstreamShape">{{ shapeLabel(sel.upstreamShape) }}</template>
                  <template v-if="sel.encryption">
                    <span :style="sel.encryption !== 'NONE' ? 'color: var(--accent-hi);' : ''">· {{ sel.encryption === 'NONE' ? 'cleartext' : sel.encryption === 'UNKNOWN' ? 'encrypted (method unreadable)' : sel.encryption }}</span>
                  </template>
                  <span class="asd-sub">· serving {{ deliveryLabel(sel.delivery) }}</span>
                  <span v-if="sel.encryption && sel.encryption !== 'NONE' && sel.requested?.outputFormat === 'ts' && sel.delivery === 'hls'"
                        class="asd-sub" style="color: var(--warn);">· this is why Raw-TS fell back — the passthrough muxer cannot decrypt</span>
                </template>
                <span v-else class="asd-nm">not reported yet — set on the first upstream resolve</span>
              </div>
              <div class="k">Video / Audio</div>
              <div class="v mono">
                <template v-if="sel.codec || sel.audio">{{ selTech?.video }} · {{ selTech?.audio }}</template>
                <span v-else class="asd-nm">not measured (register #9)</span>
              </div>
              <div class="k">Resolution</div>
              <div class="v mono">
                <template v-if="sel.resolution">{{ selTech?.resolution }}<template v-if="selTech?.fps"> @ {{ selTech?.fps }}fps</template></template>
                <span v-else class="asd-nm">not measured (register #9)</span>
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

            <div v-else-if="stage === 'ingest'" class="kv-list">
              <template v-if="sel.ingest">
                <div class="k">Ingest</div>
                <div class="v mono" :style="sel.ingest.status === 'ok' || sel.ingest.status === 'closed' ? '' : 'color: var(--warn);'">
                  {{ sel.ingest.status }} <span class="asd-sub">· 1 ingest → {{ sel.viewers }} viewer{{ sel.viewers === 1 ? '' : 's' }}</span>
                </div>
                <div class="k">Ring</div>
                <div class="v mono">
                  {{ sel.ingest.ringSegments }} seg · {{ mib(sel.ingest.ringBytes) }}<template v-if="sel.ingest.channelRingCapBytes"> / {{ mib(sel.ingest.channelRingCapBytes) }}</template> MiB
                  <span v-if="sel.ingest.floorBeatsCap" class="asd-sub" style="color: var(--warn);">· over cap — the 3-segment floor won, this bitrate does not fit the ring budget</span>
                  <span v-else-if="!sel.ingest.channelRingCapBytes" class="asd-sub">· cap not reported by this sidecar</span>
                </div>
                <div class="k">Held</div>
                <div class="v mono">
                  <template v-if="sel.ingest.ringSeconds">
                    {{ sel.ingest.ringSeconds.toFixed(1) }} s
                    <span class="asd-sub">· Σ of the held segments' own durations</span>
                  </template>
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

            <div v-else-if="stage === 'manifest'" class="kv-list">
              <template v-if="sel.ingest">
                <div class="k">Rendering</div>
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
                <div class="v mono">
                  <template v-if="sel.requested">
                    {{ sel.requested.outputFormat }} requested
                    <span v-if="sel.requested.outputFormat === 'ts' && sel.delivery === 'hls'" class="asd-sub" style="color: var(--warn);">
                      · fell back to HLS —
                      <template v-if="sel.encryption === 'UNKNOWN'">the upstream declares a key we could not read</template>
                      <template v-else-if="sel.encryption && sel.encryption !== 'NONE'">the upstream is {{ sel.encryption }} encrypted</template>
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
                  <span class="asd-sub">· Σ over {{ (selClients ?? []).length }} session{{ (selClients ?? []).length === 1 ? '' : 's' }} — an in-progress stall is counted, its duration is not yet</span>
                </template>
                <span v-else class="asd-nm">no connected session reports it yet</span>
              </div>
              <div class="k">Session end</div>
              <div class="v mono">
                <template v-if="sel.lastClose">
                  {{ closeReasonLabel(sel.lastClose.reason) }}
                  <span class="asd-sub">· {{ ageLabel(serverNow() - sel.lastClose.at) }} ago</span>
                  <span v-if="!sel.lastClose.socketBound" class="asd-sub">· HLS sessions never announce a departure, so this is how we noticed, not why it ended</span>
                </template>
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
            <div v-else class="asd-sess-scroll">
              <table class="tbl">
                <thead>
                  <tr><th>User</th><th>Client IP</th><th>Location</th><th>Player</th><th>Connected</th><th>Rate</th><th>Stalls</th></tr>
                </thead>
                <tbody>
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

    <Teleport to="body">
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
    </Teleport>
  </div>
</template>

<style scoped>
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

.stream-detail .asd-hdr-strip {
  display: flex;
  align-items: stretch;
  gap: 16px;
}
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

.stream-detail .asd-label {
  background: transparent;
  border: none;
  border-radius: 0;
  box-shadow: none;
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
.stream-detail .asd-label .kv-list .k { font-family: var(--mq-font-mono); font-size: 11px; letter-spacing: 0.04em; color: var(--text-2); }

.stream-detail .stream-detail-split { grid-template-rows: minmax(0, 1fr); }
.stream-detail .stream-detail-main { overflow-y: auto; container: asdflow / inline-size; }
.stream-detail .stream-sessions { flex: none; }

.stream-detail .stream-sessions .tbl th {
  font-family: var(--mq-font-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  color: var(--text-2);
}
.stream-detail .stream-sessions .card-hd.asd-label-hd { padding: 12px 14px 8px; }
.stream-detail .stream-sessions .asd-sess-scroll {
  max-height: calc(var(--row-h) * 3 + 34px);
  overflow-y: auto;
}
.stream-detail .stream-sessions .asd-sess-scroll .tbl thead th {
  top: 0;
  padding-top: 4px;
  background: var(--bg-1);
  z-index: 1;
}

.stream-detail .asd-railhd .spacer { flex: 1; }
.stream-detail .asd-railhd .asd-cap { color: var(--accent); }

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
.stream-detail .asd-fl-tile:focus-visible { box-shadow: inset 0 0 0 1px var(--accent-hi); }
.stream-detail .asd-fl-tile.t-ok { --fl: var(--good); }
.stream-detail .asd-fl-tile.t-warn { --fl: var(--warn); }
.stream-detail .asd-fl-tile.t-bad { --fl: var(--bad); }
.stream-detail .asd-fl-tile.t-unknown { --fl: var(--text-3); border-left-style: dashed; }
.stream-detail .asd-fl-tile.t-na { --fl: var(--text-3); border-left-style: dashed; }
.stream-detail .asd-fl-tile.t-unknown .asd-fl-val,
.stream-detail .asd-fl-tile.t-na .asd-fl-val { color: var(--text-3); }
.stream-detail .asd-fl-top { display: flex; align-items: center; gap: 4px; min-width: 0; color: var(--fl); }
.stream-detail .asd-fl-dash { font-family: var(--mq-font-mono); font-size: 11px; line-height: 1; }
.stream-detail .asd-fl-val {
  min-width: 0;
  font-family: var(--mq-font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stream-detail .asd-fl-mk {
  display: none;
  font-family: var(--mq-font-mono);
  font-size: 9px;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
.stream-detail .asd-sr {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.stream-detail .asd-stage { padding-top: 0; }
.stream-detail .asd-nm { color: var(--text-3); font-style: italic; font-size: var(--fs-xs); }
.stream-detail .asd-sub { color: var(--text-3); font-size: var(--fs-xs); }
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
@media (prefers-reduced-motion: reduce) {
  .stream-detail .asd-fl-tile { transition: none; }
}
</style>
