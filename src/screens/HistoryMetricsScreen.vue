<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';
import Pill from '../components/Pill.vue';
import SearchInput from '../components/SearchInput.vue';
import Segmented from '../components/Segmented.vue';
import ChannelLogo from '../components/ChannelLogo.vue';
import { CHANNELS, VIEW_SESSIONS, STREAM_SESSIONS, reloadViewSessions, flagEmoji, type StreamSession, type UserMetric, type PlayerType } from '../data';
import { useStreamStats } from '../composables/useStreamStats';

// Local presentation shape derived from the persisted ViewSession rows (real per-viewer watch sessions).
interface Session {
  id: string; channelId: string; ip: string; client: string;
  playerType: PlayerType;
  location: string; countryCode: string | null;
  username: string | null;
  startedAt: number; startedAgo: number; duration: number; // duration in minutes
  durationMs: number; bytes: number; // raw ms / raw bytes — for client-side rollups (range filter)
  buffers: number; rebuffMs: number;
  avgBitrate: number; resolution: string; codec: string; // avgBitrate in Mbps
  score: number; health: 'good' | 'warn' | 'bad'; ended: boolean;
  events: { atMin: number; dur: number; cause: string }[];
}

const VIEW_HISTORY = computed<Session[]>(() => {
  const now = Date.now();
  return VIEW_SESSIONS.value.map((v) => ({
    // Stable identity (channel + start + viewer) so selection survives live prepends — NOT the array index.
    id: `${v.channelId}|${v.startedAt}|${v.ip}`,
    channelId: v.channelId,
    ip: v.ip,
    client: v.userAgent || 'unknown',
    playerType: v.playerType ?? 'appPlayer', // older rows (pre-external-engine) default to the in-app player
    location: v.location ?? '—',
    countryCode: v.countryCode ?? null,
    username: v.username,
    startedAt: v.startedAt,
    startedAgo: Math.max(0, Math.round((now - v.startedAt) / 60000)),
    duration: Math.max(1, Math.round(v.durationMs / 60000)),
    durationMs: v.durationMs,
    bytes: v.bytesTotal,
    buffers: v.bufferCount,
    rebuffMs: v.rebufferMs,
    avgBitrate: +(v.avgBitrate / 1000).toFixed(1), // kbps → Mbps
    resolution: v.resolution ?? '—',
    codec: v.codec ?? '—',
    score: v.qoeScore,
    health: v.health,
    ended: v.endedAt !== null,
    events: (v.bufferEvents || [])
      .map((e) => ({
        atMin: Math.max(0, Math.round((e.at - v.startedAt) / 60000)),
        dur: e.ms,
        cause: e.phase === 'failed' ? 'stream failed' : 'rebuffering',
      }))
      .sort((a, b) => a.atMin - b.atMin),
  }));
});

function formatAgo(min: number) {
  if (min < 1) return 'now';
  if (min < 60) return min + 'm ago';
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return `${h}h ${m ? m + 'm' : ''}`.trim() + ' ago';
  const d = Math.floor(h / 24);
  return d + 'd ago';
}
function formatMs(ms: number) {
  if (ms < 1000) return ms + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return `${m}m ${sec}s`;
}
function formatDur(min: number) {
  if (min < 60) return min + 'm';
  const h = Math.floor(min / 60), m = min % 60;
  return `${h}h ${m ? m + 'm' : ''}`.trim();
}

const range = ref('24h');
const search = ref('');
const health = ref<'all' | 'good' | 'warn' | 'bad'>('all');
// Filter the sessions table by which player produced them — in-app slide-out player vs external IPTV clients.
const player = ref<'all' | 'appPlayer' | 'externalPlayer'>('all');
const selectedId = ref<string | null>(null);

// The time-range Segmented (1h/24h/7d/30d) gates BOTH view modes: the sessions table/aggregates and the
// User Metrics rollup are filtered to sessions whose startedAt is at or after this cutoff. The cutoff is a
// rolling window relative to now; an unknown value (defensive) falls back to "no cutoff".
const RANGE_MS: Record<string, number> = {
  '1h': 3600000,
  '24h': 86400000,
  '7d': 604800000,
  '30d': 2592000000,
};
const rangeCutoff = computed(() => {
  const span = RANGE_MS[range.value];
  return span ? Date.now() - span : 0;
});

// User Metrics tab state. The per-user rollup is derived CLIENT-side from VIEW_HISTORY (see
// rangedUserMetrics) so it can honor the shared time-range filter — the server's full-history
// /user-metrics aggregate takes no range parameter and can't be windowed. VIEW_SESSIONS is kept
// live by the shared WS + the on-enter baseline reload, so the rollup updates without a separate fetch.
const viewMode = ref<'sessions' | 'users'>('sessions');
const loadingMetrics = ref(false);
const selectedUsername = ref<string | null>(null);

const selectedUserMetric = computed<UserMetric | null>(() => {
  if (!rangedUserMetrics.value.length) return null;
  if (selectedUsername.value) {
    const match = rangedUserMetrics.value.find((m) => m.username === selectedUsername.value);
    if (match) return match;
  }
  return rangedUserMetrics.value[0];
});

const selectedUserSessions = computed(() => {
  if (!selectedUserMetric.value) return [];
  const uname = selectedUserMetric.value.username;
  const cutoff = rangeCutoff.value;
  return VIEW_HISTORY.value.filter((s) => (s.username || 'unknown') === uname && s.startedAt >= cutoff);
});

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Per-user rollup honoring the time-range filter. The server's /user-metrics aggregate covers the FULL
// history with no range parameter, so when a range is active we re-derive the rollup CLIENT-side from the
// (range-filtered) VIEW_HISTORY rows instead — same UserMetric shape, sorted by watch time descending so
// the table/detail render identically. With no cutoff (defensive fallback) the server aggregate would
// otherwise be richer, but the in-window derivation keeps both view modes consistent under one control.
const rangedUserMetrics = computed<UserMetric[]>(() => {
  const cutoff = rangeCutoff.value;
  const acc: Record<string, UserMetric> = {};
  for (const s of VIEW_HISTORY.value) {
    if (s.startedAt < cutoff) continue;
    const uname = s.username || 'unknown';
    const m = acc[uname] ?? (acc[uname] = {
      username: uname,
      totalSessions: 0, totalDurationMs: 0, totalBytes: 0,
      avgQoe: 0, goodSessions: 0, warnSessions: 0, badSessions: 0,
    });
    m.totalSessions += 1;
    m.totalDurationMs += s.durationMs;
    m.totalBytes += s.bytes;
    m.avgQoe += s.score; // running sum; averaged below
    if (s.health === 'good') m.goodSessions += 1;
    else if (s.health === 'warn') m.warnSessions += 1;
    else m.badSessions += 1;
  }
  return Object.values(acc)
    .map((m) => ({ ...m, avgQoe: m.totalSessions ? +(m.avgQoe / m.totalSessions).toFixed(1) : 0 }))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs);
});

const sessions = computed(() => VIEW_HISTORY.value.filter((s) => {
  const ch = CHANNELS.value.find((c) => c.id === s.channelId);
  if (!ch) return false;
  if (s.startedAt < rangeCutoff.value) return false;
  if (search.value) {
    const q = search.value.toLowerCase();
    const matches = ch.tvg_name.toLowerCase().includes(q)
      || s.ip.includes(search.value)
      || (s.username?.toLowerCase().includes(q) ?? false);
    if (!matches) return false;
  }
  if (health.value !== 'all' && s.health !== health.value) return false;
  if (player.value !== 'all' && s.playerType !== player.value) return false;
  return true;
}));

const totalMinutes = computed(() => sessions.value.reduce((a, s) => a + s.duration, 0));
const totalBuffers = computed(() => sessions.value.reduce((a, s) => a + s.buffers, 0));
const totalRebuffMs = computed(() => sessions.value.reduce((a, s) => a + s.rebuffMs, 0));
const rebuffRatio = computed(() => totalMinutes.value ? (totalRebuffMs.value / 1000) / (totalMinutes.value * 60) * 100 : 0);
const uniqueIps = computed(() => new Set(sessions.value.map((s) => s.ip)).size);
const uniqueChannels = computed(() => new Set(sessions.value.map((s) => s.channelId)).size);
const avgScore = computed(() => sessions.value.length ? Math.round(sessions.value.reduce((a, s) => a + s.score, 0) / sessions.value.length) : 0);

// 24 hourly buckets of buffer events, counted at each event's actual time (last 24h).
const bufBins = computed(() => {
  const b = Array(24).fill(0);
  const now = Date.now();
  sessions.value.forEach((s) => {
    s.events.forEach((e) => {
      const at = s.startedAt + e.atMin * 60000;
      const hourAgo = Math.floor((now - at) / 3600000);
      if (hourAgo >= 0 && hourAgo <= 23) b[23 - hourAgo] += 1;
    });
  });
  return b;
});

const problemChannels = computed(() => {
  const byChannel: Record<string, { ch: any; sessions: number; buffers: number; scores: number[] }> = {};
  sessions.value.forEach((s) => {
    const k = s.channelId;
    if (!byChannel[k]) byChannel[k] = { ch: CHANNELS.value.find((c) => c.id === k), sessions: 0, buffers: 0, scores: [] };
    byChannel[k].sessions++;
    byChannel[k].buffers += s.buffers;
    byChannel[k].scores.push(s.score);
  });
  return Object.values(byChannel)
    .filter((c) => c.ch)
    .map((c) => ({ ...c, avgScore: Math.round(c.scores.reduce((a, b) => a + b, 0) / c.scores.length) }))
    .sort((a, b) => a.avgScore - b.avgScore)
    .slice(0, 5);
});

const sel = computed(() => sessions.value.find((s) => s.id === selectedId.value) || sessions.value[0]);

function chOf(s: Session) { return CHANNELS.value.find((c) => c.id === s.channelId)!; }

// The selected session's matching ffprobe technical details (streamsessions time-series). No per-session
// foreign key exists, so match by channel + nearest capture time to the watch window (0 if during it).
const selProbe = computed<StreamSession | null>(() => {
  const s = sel.value;
  if (!s) return null;
  const probes = STREAM_SESSIONS.value.filter((p) => p.channelId === s.channelId);
  if (!probes.length) return null;
  const start = s.startedAt, end = s.startedAt + s.duration * 60000;
  let best = probes[0], bestDist = Infinity;
  for (const p of probes) {
    const dist = p.capturedAt < start ? start - p.capturedAt
               : p.capturedAt > end ? p.capturedAt - end : 0;
    if (dist < bestDist) { bestDist = dist; best = p; }
  }
  return best;
});

// Compact one-line presenters for the ffprobe technical details (null → row shows '—'). Mirrors ChannelDrawer.
const videoLine = computed(() => {
  const v = selProbe.value?.video;
  if (!v || !v.codec) return null;
  const parts = [v.codec, v.profile, v.resolution, v.pixFmt].filter(Boolean) as string[];
  if (v.bitrate) parts.push(`${Math.round(v.bitrate / 1000)}k`);
  return parts.join(' · ');
});
const audioLine = computed(() => {
  const a = selProbe.value?.audio;
  if (!a || !a.codec) return null;
  const parts: string[] = [a.codec];
  if (a.channelLayout) parts.push(a.channelLayout);
  else if (a.channels) parts.push(`${a.channels}ch`);
  if (a.sampleRate) parts.push(`${a.sampleRate} Hz`);
  if (a.format) parts.push(a.format);
  if (a.bitrate) parts.push(`${Math.round(a.bitrate / 1000)}k`);
  return parts.join(' · ');
});
const timingLine = computed(() => {
  const v = selProbe.value?.video;
  if (!v) return null;
  const parts: string[] = [];
  if (v.fps != null) parts.push(`${v.fps} fps`);
  if (v.tbr != null) parts.push(`${v.tbr} tbr`);
  if (v.tbn != null) parts.push(`${v.tbn} tbn`);
  return parts.length ? parts.join(' · ') : null;
});

const { subscribe, release } = useStreamStats();
const ready = ref(false);
onMounted(() => {
  requestAnimationFrame(() => ready.value = true);
  // Baseline refresh on enter; loadingMetrics tracks it so the User Metrics toolbar can show "Loading…"
  // while the history (which the client-side rollup is derived from) is still being fetched.
  loadingMetrics.value = true;
  reloadViewSessions()
    .catch(() => { /* best-effort refresh on enter */ })
    .finally(() => { loadingMetrics.value = false; });
  subscribe(); // live: newly-closed sessions are pushed over /api/stream-stats and prepended into VIEW_SESSIONS
});
onBeforeUnmount(() => release());

function barStyle(v: number, i: number) {
  const max = Math.max(1, ...bufBins.value);
  const ratio = v / max;
  const h = ratio * 100;
  const L = (0.88 - ratio * 0.33).toFixed(3);
  const C = (0.10 + ratio * 0.07).toFixed(3);
  const tone = `oklch(${L} ${C} 220)`;
  const total = 1500, perBar = 520;
  const stagger = (total - perBar) / Math.max(1, bufBins.value.length - 1);
  const delay = i * stagger;
  return {
    height: ready.value ? h + '%' : '0%',
    background: tone,
    boxShadow: v > 0 && ready.value ? `0 0 8px ${tone}` : 'none',
    transition: `height ${perBar}ms cubic-bezier(.2,.8,.2,1) ${delay}ms, box-shadow 240ms ease ${delay + perBar - 100}ms`,
  };
}

const events = computed(() => sel.value?.events ?? []);

function metricColor(tone?: string) {
  return tone === 'good' ? 'var(--good)' : tone === 'warn' ? 'var(--warn)' : tone === 'bad' ? 'var(--bad)' : 'var(--text-0)';
}
</script>

<template>
  <div class="col" style="gap: 18px;">
    <div class="card" style="display: flex; align-items: center; gap: 12px; padding: 14px;">
      <Icon name="file" :size="18" />
      <div>
        <div style="font-weight: 600; font-size: 15px;">Streaming history &amp; metrics</div>
        <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px;">
          Past viewer sessions across all channels — identify channels with frequent rebuffering or playback issues.
        </div>
      </div>
      <span class="spacer" />
      <Segmented :value="viewMode" @change="(v) => viewMode = v as any" :options="[
        { value: 'sessions', label: 'Sessions' },
        { value: 'users', label: 'User Metrics' },
      ]" />
      <span style="color: var(--text-3); margin: 0 4px;">|</span>
      <Segmented :value="range" @change="(v) => range = v" :options="[
        { value: '1h', label: '1h' },
        { value: '24h', label: '24h' },
        { value: '7d', label: '7d' },
        { value: '30d', label: '30d' },
      ]" />
      <Btn variant="ghost" icon="upload">Export</Btn>
    </div>

    <div v-if="viewMode === 'sessions'" class="stats">
      <div class="card stat">
        <div class="lbl">Sessions</div>
        <div class="val">{{ sessions.length }}</div>
        <div class="delta">{{ uniqueChannels }} channels · {{ uniqueIps }} unique IPs</div>
      </div>
      <div class="card stat">
        <div class="lbl">Watch time</div>
        <div class="val">{{ formatDur(totalMinutes) }}</div>
        <div class="delta">avg {{ sessions.length ? Math.round(totalMinutes / sessions.length) : 0 }}m / session</div>
      </div>
      <div class="card stat">
        <div class="lbl">Rebuffer ratio</div>
        <div class="val" :style="rebuffRatio > 1.5 ? { color: 'var(--warn)' } : undefined">
          {{ rebuffRatio.toFixed(2) }}<span style="font-size: 14px; color: var(--text-2); font-weight: 500;">%</span>
        </div>
        <div :class="['delta', { bad: rebuffRatio > 1.5 }]">
          {{ totalBuffers }} buffer events · {{ formatMs(totalRebuffMs) }} total
        </div>
      </div>
      <div class="card stat">
        <div class="lbl">QoE score</div>
        <div class="val" :style="{ color: avgScore < 70 ? 'var(--warn)' : 'var(--good)' }">
          {{ avgScore }}<span style="font-size: 14px; color: var(--text-2); font-weight: 500;"> / 100</span>
        </div>
        <div class="delta">{{ sessions.filter((s) => s.health === 'bad').length }} problem sessions</div>
      </div>
    </div>

    <div v-if="viewMode === 'sessions'" style="display: grid; grid-template-columns: 1.5fr 1fr; gap: 14px;">
      <div class="card">
        <div class="row" style="margin-bottom: 10px;">
          <div style="font-weight: 600; font-size: 14px;">Buffer events · last 24h</div>
          <span class="spacer" />
          <Pill tone="warn">{{ totalBuffers }} total</Pill>
          <Pill>{{ Math.max(...bufBins) }} peak / hour</Pill>
        </div>
        <div>
          <div class="buf-bars">
            <div v-for="(v, i) in bufBins" :key="i" class="buf-bar-wrap" :title="`${23 - i}h ago: ${v} buffer events`">
              <div class="buf-bar" :style="barStyle(v, i)" />
            </div>
          </div>
          <div class="row" style="justify-content: space-between; margin-top: 6px; font-size: 10px; color: var(--text-3);">
            <span class="mono">−24h</span><span class="mono">−18h</span><span class="mono">−12h</span><span class="mono">−6h</span><span class="mono">now</span>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="row" style="margin-bottom: 10px;">
          <div style="font-weight: 600; font-size: 14px;">Problem channels</div>
          <span class="spacer" />
          <span class="muted" style="font-size: var(--fs-xs);">by QoE score</span>
        </div>
        <div class="col" style="gap: 10px;">
          <div v-for="c in problemChannels" :key="c.ch.id" class="row" style="gap: 10px;">
            <ChannelLogo :ch="c.ch" />
            <div style="flex: 1; min-width: 0;">
              <div style="font-size: var(--fs-sm); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ c.ch.tvg_name }}</div>
              <div class="muted" style="font-size: var(--fs-xs);">{{ c.sessions }} sessions · {{ c.buffers }} buffers</div>
            </div>
            <div style="min-width: 50px; text-align: right;">
              <span class="mono" :style="{ fontWeight: 600, fontSize: '14px', color: c.avgScore < 60 ? 'var(--bad)' : c.avgScore < 80 ? 'var(--warn)' : 'var(--good)' }">{{ c.avgScore }}</span>
            </div>
          </div>
          <div v-if="problemChannels.length === 0" class="muted" style="font-size: var(--fs-sm); padding: 8px 0;">No sessions recorded yet.</div>
        </div>
      </div>
    </div>

    <div v-if="viewMode === 'sessions'" class="hm-grid">
      <div class="card flush hm-list">
        <div class="toolbar">
          <SearchInput :value="search" @change="(v) => search = v" placeholder="Channel, IP, or user" :width="200" />
          <span class="spacer" />
          <Segmented :value="player" @change="(v) => player = v as any" :options="[
            { value: 'all', label: 'All' },
            { value: 'appPlayer', label: 'In-App' },
            { value: 'externalPlayer', label: 'External' },
          ]" />
          <Segmented :value="health" @change="(v) => health = v as any" :options="[
            { value: 'all', label: 'All' },
            { value: 'good', label: 'Good' },
            { value: 'warn', label: 'Warn' },
            { value: 'bad', label: 'Bad' },
          ]" />
        </div>
        <table class="tbl">
          <thead>
            <tr>
              <th>Channel</th><th>User</th><th>Client</th><th>Location</th><th>Started</th>
              <th>Duration</th><th>Buffers</th><th>QoE</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in sessions" :key="s.id"
                :class="{ selected: selectedId === s.id }" @click="selectedId = s.id">
              <td>
                <div class="row" style="gap: 8px;">
                  <ChannelLogo :ch="chOf(s)" />
                  <div style="min-width: 0;">
                    <div style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px;">{{ chOf(s).tvg_name }}</div>
                    <div class="mono muted" style="font-size: 10px;">#{{ chOf(s).channelNo ?? '—' }}</div>
                  </div>
                </div>
              </td>
              <td><Pill tone="cyan">{{ s.username || 'unknown' }}</Pill></td>
              <td>
                <div class="row" style="gap: 5px; align-items: center;">
                  <span class="mono" style="font-size: 11px;">{{ s.ip }}</span>
                  <Pill :tone="s.playerType === 'externalPlayer' ? 'system' : 'cyan'">{{ s.playerType === 'externalPlayer' ? 'External' : 'In-App' }}</Pill>
                </div>
                <div class="muted" style="font-size: 10px; margin-top: 2px; max-width: 150px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ s.client }}</div>
              </td>
              <td class="mono" style="font-size: 11px; max-width: 150px;">
                <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ flagEmoji(s.countryCode) }} {{ s.location }}</div>
              </td>
              <td class="muted mono">{{ formatAgo(s.startedAgo) }}</td>
              <td class="mono">
                {{ formatDur(s.duration) }}
                <Pill v-if="!s.ended" tone="cyan" style="margin-left: 6px;">live</Pill>
              </td>
              <td>
                <div class="row" style="gap: 4px;">
                  <span class="mono" :style="{ fontWeight: 600, color: s.buffers > 6 ? 'var(--warn)' : 'var(--text-1)' }">{{ s.buffers }}</span>
                  <span class="muted mono" style="font-size: 10px;">· {{ formatMs(s.rebuffMs) }}</span>
                </div>
              </td>
              <td>
                <div class="qoe-pill" :data-health="s.health">
                  <span class="dot" />{{ s.score }}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="sessions.length === 0" class="empty" style="padding: 40px;">
          <div class="muted">No viewer sessions recorded yet — they appear here after channels are watched through the proxy.</div>
        </div>
      </div>

      <div class="card flush hm-detail">
        <template v-if="sel">
          <div class="card-hd" style="padding: 14px var(--pad-card);">
            <ChannelLogo :ch="chOf(sel)" />
            <div style="min-width: 0; flex: 1;">
              <div style="font-weight: 600; font-size: 14px;">{{ chOf(sel).tvg_name }}</div>
              <div class="mono muted" style="font-size: 11px; margin-top: 2px;">#{{ chOf(sel).channelNo ?? '—' }} · {{ sel.ip }}</div>
            </div>
            <div class="qoe-pill" :data-health="sel.health" style="font-size: 13px; padding: 4px 12px;">
              <span class="dot" />QoE {{ sel.score }}
            </div>
          </div>

          <div style="padding: 16px var(--pad-card) 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;">
            <div class="metric" style="background: var(--bg-2);">
              <div class="lbl">Duration</div>
              <div class="val" :style="{ fontSize: '17px' }">{{ formatDur(sel.duration) }}</div>
              <div class="sub">started {{ formatAgo(sel.startedAgo) }}</div>
            </div>
            <div class="metric" style="background: var(--bg-2);">
              <div class="lbl">Avg bitrate</div>
              <div class="val" :style="{ fontSize: '17px' }">{{ sel.avgBitrate }} Mbps</div>
              <div class="sub">{{ sel.resolution }} · {{ sel.codec }}</div>
            </div>
            <div class="metric" style="background: var(--bg-2);">
              <div class="lbl">Rebuffer</div>
              <div class="val" :style="{ color: metricColor(sel.buffers > 6 ? 'warn' : 'good'), fontSize: '17px' }">{{ formatMs(sel.rebuffMs) }}</div>
              <div class="sub">{{ sel.buffers }} events</div>
            </div>
          </div>

          <div style="padding: 16px var(--pad-card);">
            <div class="kv-list" style="grid-template-columns: 120px 1fr;">
              <div class="k">User</div><div class="v"><Pill tone="cyan">{{ sel.username || 'unknown' }}</Pill></div>
              <div class="k">Client IP</div><div class="v mono">{{ sel.ip }}</div>
              <div class="k">Location</div><div class="v">{{ flagEmoji(sel.countryCode) }} {{ sel.location }}</div>
              <div class="k">Player</div><div class="v" style="word-break: break-all;">{{ sel.client }}</div>
              <div class="k">Resolution</div><div class="v mono">{{ sel.resolution }} · {{ sel.codec }}</div>
              <div class="k">Channel #</div><div class="v mono">#{{ chOf(sel).channelNo ?? '—' }}</div>
              <div class="k">Group</div><div class="v">{{ chOf(sel).group }}</div>
              <div class="k">TVG-ID</div>
              <div class="v mono">
                <template v-if="chOf(sel).tvg_id">{{ chOf(sel).tvg_id }}</template>
                <span v-else style="color: var(--text-3);">—</span>
              </div>
              <div class="k">Source</div>
              <div class="v"><Pill tone="cyan">{{ chOf(sel).source }}</Pill></div>
            </div>
          </div>

          <div style="padding: 0 var(--pad-card) 16px;">
            <div class="row" style="margin-bottom: 8px;">
              <div style="font-size: var(--fs-sm); font-weight: 600;">Technical details</div>
            </div>
            <div v-if="selProbe" class="kv-list" style="grid-template-columns: 120px 1fr;">
              <div class="k">Video</div><div class="v"><span class="mono" style="font-size: 11px;">{{ videoLine ?? '—' }}</span></div>
              <div class="k">Audio</div><div class="v"><span class="mono" style="font-size: 11px;">{{ audioLine ?? '—' }}</span></div>
              <div class="k">Frame rate</div><div class="v"><span class="mono" style="font-size: 11px;">{{ timingLine ?? '—' }}</span></div>
              <div class="k">Container</div><div class="v"><span class="mono" style="font-size: 11px;">{{ selProbe.container ?? '—' }}</span></div>
            </div>
            <div v-else class="muted" style="font-size: var(--fs-xs);">No stream probe captured for this session</div>
          </div>

          <div style="padding: 0 var(--pad-card) 16px;">
            <div class="row" style="margin-bottom: 8px;">
              <div style="font-size: var(--fs-sm); font-weight: 600;">Buffering timeline</div>
              <span class="spacer" />
              <span class="muted mono" style="font-size: 11px;">0 → {{ formatDur(sel.duration) }}</span>
            </div>
            <div class="buf-timeline">
              <div v-if="events.length === 0" class="buf-timeline-empty">
                <Icon name="check" :size="12" />
                No buffer events
              </div>
              <template v-else>
                <div v-for="(e, i) in events" :key="i" class="buf-event"
                     :style="{ left: (e.atMin / sel.duration * 100) + '%', width: Math.max(2, (e.dur / 60000 / sel.duration * 100)) + '%' }"
                     :title="`${formatMs(e.dur)} ${e.cause} at +${e.atMin}m`" />
              </template>
            </div>
            <div v-if="events.length > 0" class="col" style="gap: 6px; margin-top: 12px;">
              <div v-for="(e, i) in events.slice(0, 6)" :key="i" class="row" style="font-size: var(--fs-xs); color: var(--text-2);">
                <span class="mono" style="width: 50px; color: var(--text-1);">+{{ e.atMin }}m</span>
                <span class="mono" :style="{ width: '70px', color: e.dur > 1000 ? 'var(--warn)' : 'var(--text-1)' }">{{ formatMs(e.dur) }}</span>
                <span>{{ e.cause }}</span>
              </div>
              <span v-if="events.length > 6" class="muted mono" style="font-size: 11px;">+ {{ events.length - 6 }} more</span>
            </div>
          </div>
        </template>
        <div v-else class="empty"><h3>No session</h3></div>
      </div>
    </div>

    <!-- User Metrics Grid -->
    <div v-else class="hm-grid">
      <!-- User List Column -->
      <div class="card flush hm-list">
        <div class="toolbar">
          <div style="font-weight: 600; font-size: 14px;">User Metrics Summary</div>
          <span class="spacer" />
          <div v-if="loadingMetrics" class="muted" style="font-size: var(--fs-xs);">Loading...</div>
        </div>
        <table class="tbl">
          <thead>
            <tr>
              <th>Username</th>
              <th>Sessions</th>
              <th>Watch Time</th>
              <th>Bandwidth</th>
              <th>Avg QoE</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in rangedUserMetrics" :key="m.username"
                :class="{ selected: selectedUsername === m.username || (!selectedUsername && rangedUserMetrics[0]?.username === m.username) }"
                @click="selectedUsername = m.username">
              <td>
                <div style="font-weight: 600; text-transform: capitalize; color: var(--text-0);">
                  {{ m.username }}
                </div>
              </td>
              <td class="mono">{{ m.totalSessions }}</td>
              <td class="mono">{{ formatDur(Math.round(m.totalDurationMs / 60000)) }}</td>
              <td class="mono">{{ formatBytes(m.totalBytes) }}</td>
              <td>
                <div class="qoe-pill" :data-health="m.avgQoe < 55 ? 'bad' : m.avgQoe < 80 ? 'warn' : 'good'">
                  <span class="dot" />{{ m.avgQoe }}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="rangedUserMetrics.length === 0" class="empty" style="padding: 40px;">
          <div class="muted">No user streaming activity recorded in this time range.</div>
        </div>
      </div>

      <!-- User Details Column -->
      <div class="card flush hm-detail">
        <template v-if="selectedUserMetric">
          <div class="card-hd" style="padding: 14px var(--pad-card);">
            <div style="flex: 1;">
              <div style="font-weight: 600; font-size: 15px; text-transform: capitalize; color: var(--text-0);">{{ selectedUserMetric.username }}</div>
              <div class="muted" style="font-size: 11px; margin-top: 2px;">Viewer Activity Rollup</div>
            </div>
            <div class="qoe-pill" :data-health="selectedUserMetric.avgQoe < 55 ? 'bad' : selectedUserMetric.avgQoe < 80 ? 'warn' : 'good'" style="font-size: 13px; padding: 4px 12px;">
              <span class="dot" />Avg QoE {{ selectedUserMetric.avgQoe }}
            </div>
          </div>

          <div style="padding: 16px var(--pad-card) 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;">
            <div class="metric" style="background: var(--bg-2);">
              <div class="lbl">Watch time</div>
              <div class="val" style="font-size: 16px;">{{ formatDur(Math.round(selectedUserMetric.totalDurationMs / 60000)) }}</div>
              <div class="sub">{{ selectedUserMetric.totalSessions }} sessions</div>
            </div>
            <div class="metric" style="background: var(--bg-2);">
              <div class="lbl">Bandwidth</div>
              <div class="val" style="font-size: 16px;">{{ formatBytes(selectedUserMetric.totalBytes) }}</div>
              <div class="sub">total data</div>
            </div>
            <div class="metric" style="background: var(--bg-2);">
              <div class="lbl">Quality status</div>
              <div class="row" style="gap: 4px; justify-content: center; margin-top: 4px;">
                <Pill v-if="selectedUserMetric.goodSessions" tone="good" style="padding: 1px 4px; font-size: 10px;">{{ selectedUserMetric.goodSessions }} G</Pill>
                <Pill v-if="selectedUserMetric.warnSessions" tone="warn" style="padding: 1px 4px; font-size: 10px;">{{ selectedUserMetric.warnSessions }} W</Pill>
                <Pill v-if="selectedUserMetric.badSessions" tone="bad" style="padding: 1px 4px; font-size: 10px;">{{ selectedUserMetric.badSessions }} B</Pill>
              </div>
            </div>
          </div>

          <div style="padding: 16px var(--pad-card);">
            <div style="font-size: 13px; font-weight: 600; margin-bottom: 8px;">Recent Sessions</div>
            <div style="display: flex; flex-direction: column; gap: 8px; max-height: 280px; overflow-y: auto; padding-right: 4px;">
              <div v-for="s in selectedUserSessions" :key="s.id" class="row" style="padding: 8px; background: var(--bg-2); border-radius: 6px; gap: 8px; justify-content: space-between;">
                <div class="row" style="gap: 8px; min-width: 0; flex: 1;">
                  <ChannelLogo v-if="chOf(s)" :ch="chOf(s)" />
                  <div style="min-width: 0; flex: 1;">
                    <div style="font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ chOf(s)?.tvg_name || 'Unknown' }}</div>
                    <div class="muted" style="font-size: 10px;">{{ formatAgo(s.startedAgo) }} · {{ formatDur(s.duration) }}</div>
                  </div>
                </div>
                <div class="qoe-pill" :data-health="s.health" style="font-size: 10px; padding: 2px 6px;">
                  {{ s.score }}
                </div>
              </div>
              <div v-if="selectedUserSessions.length === 0" class="muted" style="font-size: 11px; padding: 10px 0; text-align: center;">No individual session history found.</div>
            </div>
          </div>
        </template>
        <div v-else class="empty"><h3>No user selected</h3></div>
      </div>
    </div>
  </div>
</template>
