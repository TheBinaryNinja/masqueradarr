<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';
import Pill from '../components/Pill.vue';
import StatusDot from '../components/StatusDot.vue';
import PlaylistRow from '../components/PlaylistRow.vue';
import ChannelLogo from '../components/ChannelLogo.vue';
import PublishedUrlGroups from '../components/PublishedUrlGroups.vue';
import LivelineChart from '../components/LivelineChart.vue';
import { PLAYLISTS, EPG_SOURCES, CHANNELS, ACTIVE_STREAMS, VIEW_SESSIONS, SYSTEM_STATS, EPG_PROGRAMS, fetchUserProgramsFor, epgMetaChips, formatSyncTime, reloadPlaylists, reloadViewSessions, playlistScheduleLabel, type Program } from '../data';
import { bus } from '../composables/bus';
import { currentUser, isAdmin, regenerateStreamToken } from '../composables/useAuth';
import { usePublishedUrls } from '../composables/usePublishedUrls';
import { useToast } from '../composables/useToast';
import { useStreamStats } from '../composables/useStreamStats';
import { useSystemStats } from '../composables/useSystemStats';
import { openUltimatePlayer } from '../composables/uplLaunch';

const emit = defineEmits<{ (e: 'add', k: 'playlist' | 'epg'): void }>();
const router = useRouter();
function go(p: string) { router.push(p); }

const barcode = (() => {
  const rects: { x: number; w: number }[] = [];
  let seed = 20240624, x = 0, ink = true;
  while (x < 408) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const w = 2 + (seed % 5);
    if (ink) rects.push({ x, w });
    x += w;
    ink = !ink;
  }
  return { rects, width: x };
})();

const totalChannels = computed(() => PLAYLISTS.value.reduce((s, p) => s + p.channels, 0));
const totalPrograms = computed(() => EPG_SOURCES.value.reduce((s, e) => s + e.programs, 0));
const sortedPlaylists = computed(() => [...PLAYLISTS.value].sort((a, b) => a.name.localeCompare(b.name)));
const sortedEpgSources = computed(() => [...EPG_SOURCES.value].sort((a, b) => a.name.localeCompare(b.name)));
const unmatched = computed(() => CHANNELS.value.filter((c) => c.epgState !== 'matched').length);
const channelsLive = computed(() => CHANNELS.value.filter((c) => c.stream.status === 'live').length);
const channelsDown = computed(() => CHANNELS.value.filter((c) => c.stream.status === 'failed').length);
const playlistSyncSplit = computed(() => {
  let manual = 0, auto = 0;
  for (const p of PLAYLISTS.value) {
    if (playlistScheduleLabel(p.id, 'playlist') === 'manual') manual++;
    else auto++;
  }
  return { manual, auto };
});
const channelsActive = computed(() => CHANNELS.value.filter((c) => c.status === 'Active').length);
const channelsDisabled = computed(() => CHANNELS.value.filter((c) => c.status === 'Disabled').length);

const { subscribe: subscribeStats, release: releaseStats } = useStreamStats();
function chOf(channelId: string) { return CHANNELS.value.find((c) => c.id === channelId); }
const activeSessions = computed(() => ACTIVE_STREAMS.value.filter((s) => chOf(s.channelId)));
const recentHistory = computed(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return VIEW_SESSIONS.value.filter((v) => v.startedAt >= cutoff && chOf(v.channelId)).slice(0, 12);
});

function timeAgo(ms: number) {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (min < 1) return 'now';
  if (min < 60) return min + 'm ago';
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return `${h}h ${m ? m + 'm' : ''}`.trim() + ' ago';
  return Math.floor(h / 24) + 'd ago';
}
function durLabel(ms: number) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return min + 'm';
  const h = Math.floor(min / 60), m = min % 60;
  return `${h}h ${m ? m + 'm' : ''}`.trim();
}

const { subscribe: subscribeSys, release: releaseSys, cpuSeries, cpuTimes } = useSystemStats();
function zipFinite(vals: number[], times: number[]): { series: number[]; times: number[] } {
  const series: number[] = [], ts: number[] = [];
  for (let i = 0; i < vals.length; i++) {
    if (Number.isFinite(vals[i])) { series.push(vals[i]); ts.push(times[i]); }
  }
  return { series, times: ts };
}
const cpuChart = computed(() => zipFinite(cpuSeries.value, cpuTimes.value));
const sysScope = computed(() => {
  const sc = SYSTEM_STATS.value?.scope;
  return sc === 'cgroup-v2' || sc === 'cgroup-v1' ? 'container' : 'host';
});
function fmtPct(n: number | null | undefined) { return n == null ? '—' : `${Math.round(n)}%`; }
function fmtBytes(n: number | null | undefined) {
  if (n == null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}
function fmtRate(n: number | null | undefined, unit: string) { return n == null ? 'n/a' : `${n.toFixed(1)} ${unit}`; }

const ring = computed(() => SYSTEM_STATS.value?.ring ?? null);
const ringTone = computed(() => (ring.value == null ? null : ring.value.pressurePct >= 30 ? 'bad' : ring.value.pressurePct >= 15 ? 'warn' : 'good'));


const dbHealth = computed(() => SYSTEM_STATS.value?.mongo.health ?? null);
function fmtPerSec(n: number | null | undefined) { return n == null ? '—' : `${n < 10 ? n.toFixed(1) : Math.round(n)} /s`; }
function fmtMs(n: number | null | undefined) { return n == null ? '—' : `${n.toFixed(1)} ms`; }
function fmtRatio(n: number | null | undefined) { return n == null ? '—' : `${n.toFixed(1)} : 1`; }
function fmtCount(n: number | null | undefined) { return n == null ? '—' : `${n}`; }

const toast = useToast();
const channelSearch = ref('');
const selectedChannel = ref<any>(null);

const userInitials = computed(() => {
  const name = currentUser.value?.username || '';
  return name.slice(0, 2).toUpperCase();
});

const publishedUrls = usePublishedUrls(() => currentUser.value);

const grantedSources = computed(() => new Set([
  ...(currentUser.value?.allowedPlaylists || []),
  ...(currentUser.value?.allowedCustomPlaylists || []),
]));

const filteredChannels = computed(() => {
  return CHANNELS.value.filter((c) => {
    if (!grantedSources.value.has(c.source)) return false;
    if (!channelSearch.value) return true;
    const q = channelSearch.value.toLowerCase();
    return (c.tvg_name || '').toLowerCase().includes(q) || (c.group || '').toLowerCase().includes(q);
  });
});

const epgKey = computed<string | null>(() => {
  const c = selectedChannel.value;
  return c && c.epg && c.tvg_id ? `${c.epg}:${c.tvg_id}` : null;
});
const epgLoading = ref(false);

watch(selectedChannel, async (c) => {
  const key = epgKey.value;
  if (!c || !key) return;
  if (EPG_PROGRAMS[key]?.length) return;
  epgLoading.value = true;
  try {
    const now = Date.now();
    await fetchUserProgramsFor(c.source, [key], now - 60 * 60 * 1000, now + 3 * 60 * 60 * 1000);
  } catch {   }
  finally { epgLoading.value = false; }
});

const epgPrograms = computed<Program[]>(() => (epgKey.value ? EPG_PROGRAMS[epgKey.value] || [] : []));
const nowPlaying = computed<Program | null>(() => {
  const now = Date.now();
  return epgPrograms.value.find((p) => now >= p.start && now < p.end) || null;
});
const upcoming = computed<Program[]>(() => {
  const now = Date.now();
  const floor = nowPlaying.value ? nowPlaying.value.end : now;
  return epgPrograms.value.filter((p) => p.start >= floor);
});

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function handleRegenerateToken() {
  if (confirm('Are you sure you want to regenerate your stream token? Any configured players will need to be updated with the new URL.')) {
    const success = await regenerateStreamToken();
    if (success) {
      toast.lowerRight({
        tone: 'good',
        title: 'Token Regenerated',
        text: 'Your streaming token has been updated successfully.'
      });
    } else {
      toast.lowerRight({
        tone: 'bad',
        title: 'Error',
        text: 'Failed to regenerate stream token.'
      });
    }
  }
}

onMounted(() => {
  bus.on('tvapp:auth-changed', reloadPlaylists);
  if (isAdmin.value) {
    subscribeStats();
    subscribeSys();
    reloadViewSessions().catch(() => {   });
  }
});
onBeforeUnmount(() => {
  bus.off('tvapp:auth-changed', reloadPlaylists);
  if (isAdmin.value) {
    releaseStats();
    releaseSys();
  }
});
</script>

<template>
  <div v-if="isAdmin" class="col mq-dash" style="gap: 18px;">
    <div class="mq-micro-row" aria-hidden="true">
      <span class="mq-micro-hi">MASQUERADARR // CONSOLE</span>
      <span>MK-SYS / DASH</span>
    </div>

    <div>
    <div class="card flush sys-flush">
      <div class="card-hd">
        <Icon name="activity" :size="15" style="color: var(--accent);" />
        <h2>System Performance</h2>
        <span class="spacer" />
        <span class="mq-cap">SYS // {{ sysScope.toUpperCase() }} · LIVE</span>
      </div>
      <div style="padding: 12px var(--pad-card) 0;">
        <LivelineChart :series="cpuChart.series" :times="cpuChart.times" :target="80" />
      </div>
      <div class="card flush">
      <div style="display: flex; align-items: stretch;">
      <div class="stats" style="grid-template-columns: repeat(6, 1fr); margin: 0; flex: 1; min-width: 0;">
        <div class="stat">
          <div class="lbl">CPU</div>
          <div class="val">{{ fmtPct(SYSTEM_STATS?.cpu.usagePct) }}</div>
          <div class="delta">
            {{ SYSTEM_STATS?.cpu.cores ?? '—' }} cores<template v-if="SYSTEM_STATS"> · load {{ SYSTEM_STATS.cpu.loadAvg[0].toFixed(2) }}</template>
          </div>
        </div>
        <div class="stat">
          <div class="lbl">Memory</div>
          <div class="val">{{ fmtPct(SYSTEM_STATS?.memory.usedPct) }}</div>
          <div class="delta">
            {{ fmtBytes(SYSTEM_STATS?.memory.usedBytes) }} / {{ fmtBytes(SYSTEM_STATS?.memory.totalBytes) }} · rss {{ fmtBytes(SYSTEM_STATS?.memory.rssBytes) }}
          </div>
        </div>
        <div class="stat">
          <div class="lbl">Memory pressure</div>
          <div class="val" :class="ringTone ? ringTone : 'val-muted'">{{ ring ? fmtBytes(ring.bytes) : '—' }}</div>
          <div class="delta" :class="{ warn: ringTone === 'warn', bad: ringTone === 'bad' }">
            <template v-if="!ring">not available</template>
            <template v-else-if="ring.origins === 0">no active origins</template>
            <template v-else>
              {{ ring.origins }} origin{{ ring.origins === 1 ? '' : 's' }} · {{ fmtPct(ring.pressurePct) }} of
              {{ fmtBytes(SYSTEM_STATS?.memory.totalBytes) }}
            </template>
          </div>
        </div>
        <div class="stat">
          <div class="lbl">Disk I/O</div>
          <div class="val">{{ SYSTEM_STATS?.diskIo ? fmtRate(SYSTEM_STATS.diskIo.readMbPerSec + SYSTEM_STATS.diskIo.writeMbPerSec, 'MB/s') : 'n/a' }}</div>
          <div class="delta">
            <template v-if="SYSTEM_STATS?.diskIo">r {{ SYSTEM_STATS.diskIo.readMbPerSec.toFixed(1) }} · w {{ SYSTEM_STATS.diskIo.writeMbPerSec.toFixed(1) }} MB/s</template>
            <template v-else>not available</template>
          </div>
        </div>
        <div class="stat">
          <div class="lbl">Network</div>
          <div class="val">{{ SYSTEM_STATS?.network ? fmtRate(SYSTEM_STATS.network.rxMbitPerSec + SYSTEM_STATS.network.txMbitPerSec, 'Mb/s') : 'n/a' }}</div>
          <div class="delta">
            <template v-if="SYSTEM_STATS?.network">↓ {{ SYSTEM_STATS.network.rxMbitPerSec.toFixed(1) }} · ↑ {{ SYSTEM_STATS.network.txMbitPerSec.toFixed(1) }} Mb/s</template>
            <template v-else>not available</template>
          </div>
        </div>
        <div class="stat">
          <div class="lbl">DB connections</div>
          <div class="val">{{ SYSTEM_STATS?.mongo.connections.current ?? '—' }}</div>
          <div class="delta" :class="{ bad: !!SYSTEM_STATS && SYSTEM_STATS.mongo.readyState !== 1 }">
            <template v-if="SYSTEM_STATS && SYSTEM_STATS.mongo.readyState === 1">
              {{ SYSTEM_STATS.mongo.connections.available != null ? SYSTEM_STATS.mongo.connections.available + ' available' : 'connected' }}
            </template>
            <template v-else>disconnected</template>
          </div>
        </div>
      </div>
      <div class="db-health">
        <div class="db-health-hd">DB Health</div>
        <div class="db-health-grid">
          <div class="db-health-item"><span class="db-health-k">OpCounters</span><span class="mono">{{ fmtPerSec(dbHealth?.opsPerSec) }}</span></div>
          <div class="db-health-item"><span class="db-health-k">Queues</span><span class="mono">{{ fmtCount(dbHealth?.queueDepth) }}</span></div>
          <div class="db-health-item"><span class="db-health-k">OpExecution</span><span class="mono">{{ fmtMs(dbHealth?.avgLatencyMs) }}</span></div>
          <div class="db-health-item"><span class="db-health-k">Scan/Order</span><span class="mono">{{ fmtPerSec(dbHealth?.scanAndOrderPerSec) }}</span></div>
          <div class="db-health-item"><span class="db-health-k">QueryTarget</span><span class="mono">{{ fmtRatio(dbHealth?.queryTargeting) }}</span></div>
        </div>
      </div>
      </div>
      </div>
    </div>

    </div>

    <div class="mq-overline" aria-hidden="true">
      <span class="mq-ov-tag">SYS</span>
      <span class="mq-ov-rule" />
      <span class="mq-ov-dim">FLEET STATUS</span>
    </div>

    <div class="stats" style="grid-template-columns: repeat(6, 1fr);">
      <div class="card stat">
        <div class="lbl">Playlists</div>
        <div class="val">{{ PLAYLISTS.length }}</div>
        <div class="delta" style="gap: 10px;">
          <span><b style="color: var(--text-1);">{{ playlistSyncSplit.manual }}</b> : manual</span>
          <span><b style="color: var(--text-1);">{{ playlistSyncSplit.auto }}</b> : auto</span>
        </div>
      </div>
      <div class="card stat">
        <div class="lbl">Channels</div>
        <div class="val">{{ totalChannels }}</div>
        <div class="delta" style="gap: 10px;">
          <span><b style="color: var(--text-1);">{{ channelsActive }}</b> : active</span>
          <span><b style="color: var(--text-1);">{{ channelsDisabled }}</b> : disabled</span>
        </div>
      </div>
      <div class="card stat">
        <div class="lbl">Channels live</div>
        <div class="val">{{ channelsLive }}</div>
        <div class="delta"><Icon name="check" :size="12" />live</div>
      </div>
      <div class="card stat">
        <div class="lbl">Channels down</div>
        <div class="val">{{ channelsDown }}</div>
        <div class="delta bad"><Icon name="warn" :size="12" />down</div>
      </div>
      <div class="card stat">
        <div class="lbl">EPG sources</div>
        <div class="val">{{ EPG_SOURCES.length }}</div>
        <div class="delta">{{ totalPrograms.toLocaleString() }} programs</div>
      </div>
      <div class="card stat">
        <div class="lbl">Unmatched</div>
        <div class="val">{{ unmatched }}</div>
        <div class="delta bad"><Icon name="warn" :size="12" />needs mapping</div>
      </div>
    </div>

    <div class="mq-foot" aria-hidden="true">
      <svg class="mq-barcode" :viewBox="`0 0 ${barcode.width} 26`" preserveAspectRatio="none">
        <rect v-for="(r, i) in barcode.rects" :key="i" :x="r.x" y="0" :width="r.w" height="26" />
      </svg>
      <div class="mq-spec-strip">
        <span><span class="mq-sp-key">PLAYLISTS</span> {{ PLAYLISTS.length }}</span>
        <span><span class="mq-sp-key">CHANNELS</span> {{ totalChannels }}</span>
        <span><span class="mq-sp-key">EPG</span> {{ EPG_SOURCES.length }}</span>
        <span><span class="mq-sp-key">SYS</span> {{ sysScope.toUpperCase() }}</span>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: 1.4fr 1fr; gap: 18px;">
      <div class="col" style="min-width: 0;">
        <div class="card flush">
          <div class="card-hd">
            <Icon name="playlist" :size="15" />
            <h2>Playlists</h2>
            <Pill tone="cyan">{{ PLAYLISTS.length }}</Pill>
            <span class="spacer" />
            <Btn variant="ghost" size="sm" @click="go('/playlists')">View all</Btn>
            <Btn variant="ghost" size="sm" icon="plus" @click="emit('add', 'playlist')">Add playlist</Btn>
          </div>
          <PlaylistRow v-for="p in sortedPlaylists" :key="p.id" :playlist="p" compact @open="go(`/playlists/${p.id}`)">
            <template #actions>
              <Btn
                size="sm"
                variant="ghost"
                icon="play"
                class="upl-btn"
                :disabled="!p.channels"
                title="Open in the Ultimate Video Player"
                aria-label="Open in the Ultimate Video Player"
                @click="openUltimatePlayer(p.id)"
              />
              <Btn variant="ghost" size="sm" icon="chevron-r" @click="go(`/playlists/${p.id}`)" />
            </template>
          </PlaylistRow>
        </div>

        <div class="card flush">
          <div class="card-hd">
            <Icon name="epg" :size="15" style="color: var(--good);" />
            <h2>EPG Sources</h2>
            <Pill tone="good">{{ EPG_SOURCES.length }}</Pill>
            <span class="spacer" />
            <Btn variant="ghost" size="sm" @click="go('/epg-sources')">View all</Btn>
            <Btn variant="ghost" size="sm" icon="plus" @click="emit('add', 'epg')">Add EPG source</Btn>
          </div>
          <div v-for="p in sortedEpgSources" :key="p.id" class="src-row" @click="go(`/epg-sources/${p.id}`)">
            <div :class="['src-ico', { builtin: p.builtin, 'epg-builtin': p.builtin }]" style="color: var(--good);">
              <Icon :name="p.builtin ? 'tv' : 'epg'" :size="18" />
            </div>
            <div>
              <div class="src-name">
                <StatusDot :status="p.status" :pulse="p.status === 'good'" />
                {{ p.name }}
                <Pill v-if="p.builtin" tone="system"><Icon name="check" :size="10" />built-in</Pill>
                <Pill tone="cyan">{{ (p.interval || '').toLowerCase() }}</Pill>
              </div>
              <div class="epg-meta">
                <span v-for="c in epgMetaChips(p, ['source', 'lineupId'])" :key="c.label"
                      class="meta-item" :title="`${c.label}: ${c.value}`">
                  <span class="meta-k">{{ c.label }}:</span>
                  <span class="meta-chip">{{ c.value }}</span>
                </span>
              </div>
            </div>
            <div class="stat-mini"><b>{{ p.channels }}</b>channels</div>
            <div class="stat-mini"><b>{{ p.programs.toLocaleString() }}</b>programs</div>
            <div class="stat-mini" style="min-width: 110px;">
              <b style="font-size: 12px; font-weight: 500; color: var(--text-1);">{{ formatSyncTime(p.lastSync) }}</b>
              last sync
            </div>
            <Btn variant="ghost" size="sm" icon="chevron-r" />
          </div>
        </div>
      </div>

      <div class="card flush activity-card">
        <div class="card-hd">
          <h2>Activity</h2>
          <span class="spacer" />
          <span class="mq-cap">LIVE // LAST 24H</span>
        </div>
        <div class="activity-body">
          <div v-if="activeSessions.length" class="activity-sec">
            <div class="activity-sec-hd">
              <span class="dot good pulse" style="width: 7px; height: 7px;" />
              <h3>Active Sessions</h3>
              <Pill tone="good">{{ activeSessions.length }}</Pill>
              <span class="spacer" />
              <Btn variant="ghost" size="sm" @click="go('/active')">View all</Btn>
            </div>
            <div v-for="s in activeSessions" :key="s.id" class="act" style="cursor: pointer;" @click="go('/active')">
              <ChannelLogo v-if="chOf(s.channelId)" :ch="chOf(s.channelId)!" />
              <div v-else class="ico-w"><Icon name="tv" :size="14" /></div>
              <div style="flex: 1; min-width: 0;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ chOf(s.channelId)?.tvg_name }}</span>
                  <StatusDot :status="s.status" :pulse="s.status === 'good'" />
                </div>
                <div class="when">{{ s.bitrate.toFixed(1) }} Mbps · {{ s.uptime }}<template v-if="s.watchers.length"> · {{ s.watchers[0] }}</template></div>
              </div>
              <div style="text-align: right; min-width: 48px;">
                <b style="font-size: 14px; color: var(--text-0);">{{ s.viewers }}</b>
                <div class="muted" style="font-size: 10px;">viewer{{ s.viewers === 1 ? '' : 's' }}</div>
              </div>
            </div>
          </div>

          <div class="activity-sec">
            <div class="activity-sec-hd">
              <Icon name="file" :size="13" />
              <h3>History</h3>
              <Pill tone="cyan">{{ recentHistory.length }}</Pill>
              <span class="spacer" />
              <Btn variant="ghost" size="sm" @click="go('/history')">View all</Btn>
            </div>
            <div v-for="v in recentHistory" :key="`${v.channelId}|${v.startedAt}|${v.ip}`" class="act" style="cursor: pointer;" @click="go('/history')">
              <ChannelLogo v-if="chOf(v.channelId)" :ch="chOf(v.channelId)!" />
              <div v-else class="ico-w"><Icon name="tv" :size="14" /></div>
              <div style="flex: 1; min-width: 0;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ chOf(v.channelId)?.tvg_name }}</span>
                  <Pill tone="cyan">{{ v.username || 'unknown' }}</Pill>
                </div>
                <div class="when">{{ timeAgo(v.startedAt) }} · {{ durLabel(v.durationMs) }}</div>
              </div>
              <div class="qoe-pill" :data-health="v.health"><span class="dot" />{{ v.qoeScore }}</div>
            </div>
            <div v-if="recentHistory.length === 0" class="mq-empty">
              <svg class="mq-plate mq-plate-sm" viewBox="0 0 360 230" aria-hidden="true">
                <g stroke="var(--bracket)" stroke-width="1.5" fill="none">
                  <path d="M14 28 V14 H28" /><path d="M346 28 V14 H332" />
                  <path d="M14 202 V216 H28" /><path d="M346 202 V216 H332" />
                </g>
                <g stroke="var(--mq-teal)" stroke-width="1" opacity="0.13">
                  <line x1="20" y1="56" x2="340" y2="56" /><line x1="20" y1="84" x2="340" y2="84" />
                  <line x1="20" y1="112" x2="340" y2="112" /><line x1="20" y1="140" x2="340" y2="140" />
                  <line x1="20" y1="168" x2="340" y2="168" />
                </g>
                <line x1="20" y1="98" x2="340" y2="98" stroke="var(--mq-teal)" stroke-width="1.5" opacity="0.85" />
                <g stroke="var(--mq-teal)" stroke-width="1.6" fill="none">
                  <path d="M138 86 V72 H152" /><path d="M222 86 V72 H208" />
                  <path d="M138 158 V172 H152" /><path d="M222 158 V172 H208" />
                </g>
                <g transform="translate(153,96) scale(0.45)">
                  <path d="M26 94 L26 30 L60 64 L94 30 L94 94" fill="none" stroke="var(--mq-teal)"
                        stroke-width="14" stroke-linejoin="round" stroke-linecap="round" />
                </g>
                <line x1="40" y1="200" x2="320" y2="200" stroke="var(--mq-steel)" stroke-width="1" />
                <line x1="40" y1="200" x2="120" y2="200" stroke="var(--mq-teal)" stroke-width="2" />
              </svg>
              <div class="mq-empty-title">No viewer sessions recorded yet.</div>
              <div class="mq-empty-sub">Live watch activity will appear here as clients connect.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div v-else class="col mq-dash mq-dash-user" style="gap: 18px;">
    <div class="mq-micro-row" aria-hidden="true">
      <span class="mq-micro-hi">MASQUERADARR // ACCOUNT</span>
      <span>MK-SYS / DASH</span>
    </div>

    <div class="card mq-welcome" style="padding: 20px; display: flex; align-items: center; gap: 20px;">
      <div class="mq-avatar">{{ userInitials }}</div>
      <div style="flex: 1;">
        <h2 style="margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; color: var(--text-0);">Welcome, {{ currentUser?.username }}!</h2>
        <p style="margin: 4px 0 0; font-size: 13px; color: var(--text-2);">Role: <span style="text-transform: capitalize; font-weight: 600; color: var(--accent);">{{ currentUser?.role }}</span></p>
      </div>
      <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 8px;">
        <div class="row" style="gap: 8px;">
          <span class="muted" style="font-size: 13px;">Stream Token Status:</span>
          <Pill :tone="currentUser?.streamTokenEnabled ? 'good' : 'bad'">
            <StatusDot :status="currentUser?.streamTokenEnabled ? 'good' : 'bad'" :pulse="currentUser?.streamTokenEnabled" />
            {{ currentUser?.streamTokenEnabled ? 'Enabled' : 'Disabled' }}
          </Pill>
        </div>
        <Btn size="sm" variant="ghost" icon="refresh" @click="handleRegenerateToken">Regenerate Token</Btn>
      </div>
    </div>

    <div class="card" style="padding: 20px; display: flex; flex-direction: column; gap: 16px;">
      <div class="mq-overline" aria-hidden="true">
        <span class="mq-ov-tag">LINK</span>
        <span class="mq-ov-rule" />
        <span class="mq-ov-dim">SECURE ENDPOINTS</span>
      </div>
      <div class="mq-h" style="font-size: 16px; margin-top: -8px;">Integration URLs</div>
      <div class="muted" style="font-size: 13px; margin-top: -10px;">
        Use these URLs to configure your IPTV client or media center. Keep them private as they are linked to your account.
      </div>

      <PublishedUrlGroups v-if="publishedUrls.length" :groups="publishedUrls" layout="grid" />
      <div v-else class="muted" style="font-size: 13px; padding: 4px 0;">
        No playlists are assigned to your account yet — contact your administrator.
      </div>
    </div>

    <div class="mq-dash-cols">
      <div class="card flush mq-dash-channels">
        <div class="mq-h" style="font-size: 15px;">Available Channels</div>
        <div class="input">
          <input v-model="channelSearch" placeholder="Search channels or groups..." style="width: 100%;" />
        </div>
        <div class="mq-chan-list">
          <div v-for="c in filteredChannels" :key="c.id"
               :class="['src-row', { selected: selectedChannel?.id === c.id }]"
               style="padding: 8px 12px; margin: 0; border-radius: 8px; cursor: pointer; transition: all 0.2s;"
               @click="selectedChannel = c">
            <ChannelLogo :ch="c" />
            <div style="flex: 1; min-width: 0; margin-left: 10px;">
              <div style="font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-1);">
                {{ c.tvg_name }}
              </div>
              <div class="muted" style="font-size: 11px;">
                {{ c.group }} · {{ c.source }}
              </div>
            </div>
            <StatusDot :status="c.stream.status" :pulse="c.stream.status === 'live'" />
          </div>
          <div v-if="filteredChannels.length === 0" class="mq-empty">
            <svg class="mq-plate mq-plate-sm" viewBox="0 0 360 230" aria-hidden="true">
              <g stroke="var(--bracket)" stroke-width="1.5" fill="none">
                <path d="M14 28 V14 H28" /><path d="M346 28 V14 H332" />
                <path d="M14 202 V216 H28" /><path d="M346 202 V216 H332" />
              </g>
              <ellipse cx="180" cy="128" rx="96" ry="40" transform="rotate(-18 180 128)"
                       fill="none" stroke="var(--mq-teal)" stroke-width="2"
                       stroke-dasharray="1 8" stroke-linecap="round" opacity="0.7" />
              <ellipse cx="180" cy="128" rx="96" ry="40" transform="rotate(-18 180 128)"
                       fill="none" stroke="var(--mq-steel)" stroke-width="1" />
              <g stroke="var(--mq-teal)" stroke-width="1" opacity="0.55">
                <line x1="180" y1="128" x2="92" y2="106" />
                <line x1="180" y1="128" x2="270" y2="150" />
                <line x1="180" y1="128" x2="206" y2="68" />
              </g>
              <g fill="var(--mq-teal)">
                <circle cx="92" cy="106" r="4" /><circle cx="270" cy="150" r="4" /><circle cx="206" cy="68" r="3" />
              </g>
              <g transform="translate(155,103) scale(0.41667)">
                <path d="M26 94 L26 30 L60 64 L94 30 L94 94" fill="none" stroke="var(--mq-teal)"
                      stroke-width="14" stroke-linejoin="round" stroke-linecap="round" />
              </g>
            </svg>
            <div class="mq-empty-title">No channels found or assigned.</div>
            <div class="mq-empty-sub">Adjust your search or contact your administrator for access.</div>
          </div>
        </div>

        <div class="mq-chan-info">
          <template v-if="selectedChannel">
            <div style="min-width: 0;">
              <div class="mq-chan-info-title">{{ selectedChannel.tvg_name }}</div>
              <div class="muted" style="font-size: 11px;">#{{ selectedChannel.channelNo || '—' }} · {{ selectedChannel.group }}</div>
            </div>
            <div class="row" style="gap: 6px; flex: none;">
              <Pill tone="cyan">{{ selectedChannel.source }}</Pill>
              <Pill v-if="selectedChannel.stream.res" tone="good">{{ selectedChannel.stream.res }}</Pill>
            </div>
          </template>
          <div v-else class="muted mq-chan-info-empty">Select a channel to view its details.</div>
        </div>
      </div>

      <div class="card flush mq-dash-epg">
        <div class="mq-epg-hd">
          <div class="mq-h" style="font-size: 15px;">Program Guide</div>
          <span v-if="selectedChannel" class="mq-cap">{{ selectedChannel.tvg_name }}</span>
        </div>

        <template v-if="selectedChannel && (nowPlaying || upcoming.length)">
          <div v-if="nowPlaying" class="mq-epg-now">
            <div class="mq-epg-now-tag">NOW</div>
            <div class="mq-epg-now-title">{{ nowPlaying.title }}</div>
            <div class="mq-epg-now-time">
              {{ fmtClock(nowPlaying.start) }}–{{ fmtClock(nowPlaying.end) }}<span v-if="nowPlaying.cat"> · {{ nowPlaying.cat }}</span>
            </div>
          </div>
          <div class="mq-epg-next-rule" aria-hidden="true">UP NEXT</div>
          <div class="mq-epg-list">
            <div v-for="(p, i) in upcoming" :key="i" class="mq-epg-row">
              <span class="mq-epg-row-time">{{ fmtClock(p.start) }}</span>
              <span class="mq-epg-row-title">{{ p.title }}</span>
              <span v-if="p.cat" class="mq-epg-row-cat">{{ p.cat }}</span>
            </div>
            <div v-if="upcoming.length === 0" class="muted mq-epg-empty-inline">No upcoming programs in the guide window.</div>
          </div>
        </template>

        <div v-else class="mq-epg-state">
          <svg class="mq-plate mq-plate-sm" viewBox="0 0 360 230" aria-hidden="true">
            <g stroke="var(--bracket)" stroke-width="1.5" fill="none">
              <path d="M14 28 V14 H28" /><path d="M346 28 V14 H332" />
              <path d="M14 202 V216 H28" /><path d="M346 202 V216 H332" />
            </g>
            <circle cx="180" cy="119" r="78" fill="none" stroke="var(--mq-teal)" stroke-width="1"
                    stroke-dasharray="1 8" stroke-linecap="round" opacity="0.55" />
            <circle cx="180" cy="119" r="56" fill="none" stroke="var(--mq-teal)" stroke-width="1.4"
                    stroke-dasharray="1 8" stroke-linecap="round" opacity="0.75" />
            <g stroke="var(--mq-teal)" stroke-width="1" opacity="0.4">
              <line x1="180" y1="19" x2="180" y2="219" />
              <line x1="80" y1="119" x2="280" y2="119" />
            </g>
            <g stroke="var(--mq-teal)" stroke-width="1.6" fill="none">
              <path d="M138 86 V72 H152" /><path d="M222 86 V72 H208" />
              <path d="M138 158 V172 H152" /><path d="M222 158 V172 H208" />
            </g>
            <g transform="translate(153,92) scale(0.45)">
              <path d="M26 94 L26 30 L60 64 L94 30 L94 94" fill="none" stroke="var(--mq-teal)"
                    stroke-width="14" stroke-linejoin="round" stroke-linecap="round" />
            </g>
            <line x1="40" y1="200" x2="320" y2="200" stroke="var(--mq-steel)" stroke-width="1" />
            <line x1="40" y1="200" x2="180" y2="200" stroke="var(--mq-teal)" stroke-width="2" />
          </svg>
          <div class="mq-lock-tag" aria-hidden="true">{{ selectedChannel ? 'NO GUIDE SIGNAL' : 'AWAITING SIGNAL LOCK' }}</div>
          <div style="font-weight: 600; font-size: 15px; color: var(--text-1);">
            {{ !selectedChannel ? 'No Channel Selected' : (epgLoading ? 'Loading guide…' : 'No Guide Data') }}
          </div>
          <div class="muted" style="font-size: 12px; max-width: 300px; margin-top: 4px;">
            {{ !selectedChannel ? 'Select a channel from the list to view its program guide.' : (epgLoading ? 'Fetching the program guide…' : 'This channel has no EPG guide data available.') }}
          </div>
        </div>
      </div>
    </div>

    <div class="mq-foot" aria-hidden="true">
      <svg class="mq-barcode" :viewBox="`0 0 ${barcode.width} 26`" preserveAspectRatio="none">
        <rect v-for="(r, i) in barcode.rects" :key="i" :x="r.x" y="0" :width="r.w" height="26" />
      </svg>
      <div class="mq-spec-strip">
        <span><span class="mq-sp-key">USER</span> {{ currentUser?.username }}</span>
        <span><span class="mq-sp-key">ROLE</span> {{ (currentUser?.role || '').toUpperCase() }}</span>
        <span><span class="mq-sp-key">STREAM</span> {{ currentUser?.streamTokenEnabled ? 'ENABLED' : 'DISABLED' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>

.mq-dash .card.mq-welcome {
  box-shadow:
    inset 0 1px 0 var(--accent-soft),
    0 1px 2px rgba(0, 0, 0, 0.28),
    0 14px 34px rgba(0, 0, 0, 0.34),
    0 0 0 1px var(--accent-soft);
}
[data-theme="light"] .mq-dash .card.mq-welcome {
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.7),
    0 1px 2px rgba(0, 0, 0, 0.06),
    0 12px 28px rgba(0, 0, 0, 0.10),
    0 0 0 1px var(--accent-soft);
}


.mq-micro-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-family: var(--mq-font-mono);
  font-size: 9.5px;
  letter-spacing: 0.16em;
  color: var(--text-3);
}
.mq-micro-hi { color: var(--text-2); }

.mq-cap {
  font-family: var(--mq-font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.12em;
  color: var(--text-3);
  white-space: nowrap;
}

.mq-overline {
  display: flex;
  align-items: center;
  gap: 9px;
}
.mq-ov-tag {
  font-family: var(--mq-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.16em;
  color: var(--accent);
}
.mq-ov-rule { height: 1px; width: 42px; background: var(--accent); opacity: 0.5; }
.mq-ov-dim {
  font-family: var(--mq-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.16em;
  color: var(--text-3);
}

.mq-h {
  font-family: var(--mq-font-sans);
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text-0);
}

.mq-welcome {
  background: linear-gradient(135deg, var(--accent-soft) 0%, var(--bg-1) 100%);
  border: 1px solid var(--accent-soft);
  border-radius: var(--radius-m);
}

.mq-avatar {
  width: 50px;
  height: 50px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--mq-teal);
  color: var(--mq-obsidian);
  font-family: var(--mq-font-sans);
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.02em;
  box-shadow: 0 0 18px var(--accent-glow);
  flex: none;
}

.mq-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 18px 16px 24px;
  gap: 4px;
}
.mq-plate {
  display: block;
  width: 100%;
  max-width: 340px;
  opacity: 0.6;
  pointer-events: none;
}
.mq-plate-sm { max-width: 240px; opacity: 0.5; margin-bottom: 6px; }
.mq-empty-title {
  font-family: var(--mq-font-sans);
  font-weight: 600;
  font-size: var(--fs-sm);
  color: var(--text-1);
}
.mq-empty-sub {
  font-size: var(--fs-xs);
  color: var(--text-3);
  max-width: 260px;
}

.mq-lockstate .mq-plate { max-width: 300px; opacity: 0.7; margin-bottom: 8px; }
.mq-lock-tag {
  font-family: var(--mq-font-mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--accent);
  margin-bottom: 10px;
}

.mq-dash-user {
  height: calc(100vh - var(--topbar-h) - 2 * var(--pad-x));
  min-height: 0;
  overflow: hidden;
}
.mq-dash-user > * { flex: 0 0 auto; }
.mq-dash-user > .mq-dash-cols { flex: 1 1 auto; min-height: 0; }

.mq-dash-cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr);
  gap: 18px;
  min-height: 0;
}
.mq-dash-cols > * { min-width: 0; min-height: 0; }

.card.mq-dash-channels,
.card.mq-dash-epg {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 16px;
  gap: 12px;
}
.mq-chan-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-right: 4px;
}
.mq-chan-info {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--hairline);
}
.mq-chan-info-title {
  font-family: var(--mq-font-sans);
  font-weight: 600;
  font-size: 14px;
  color: var(--text-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mq-chan-info-empty { font-size: 12px; }

.mq-epg-hd {
  flex: 0 0 auto;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.mq-epg-hd .mq-cap { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mq-epg-now {
  flex: 0 0 auto;
  background: linear-gradient(135deg, var(--accent-soft) 0%, var(--bg-1) 100%);
  border: 1px solid var(--accent-soft);
  border-radius: var(--radius-m);
  padding: 12px 14px;
}
.mq-epg-now-tag {
  font-family: var(--mq-font-mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--accent);
  margin-bottom: 4px;
}
.mq-epg-now-title {
  font-family: var(--mq-font-sans);
  font-weight: 600;
  font-size: 16px;
  letter-spacing: -0.01em;
  color: var(--text-0);
}
.mq-epg-now-time {
  font-family: var(--mq-font-mono);
  font-size: 11px;
  color: var(--text-2);
  margin-top: 3px;
}
.mq-epg-next-rule {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 9px;
  font-family: var(--mq-font-mono);
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--text-3);
}
.mq-epg-next-rule::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--hairline);
}
.mq-epg-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding-right: 4px;
}
.mq-epg-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 8px 4px;
  border-bottom: 1px solid var(--hairline);
}
.mq-epg-row-time {
  flex: none;
  width: 52px;
  font-family: var(--mq-font-mono);
  font-size: 12px;
  color: var(--accent);
}
.mq-epg-row-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mq-epg-row-cat {
  flex: none;
  font-family: var(--mq-font-mono);
  font-size: 10px;
  letter-spacing: 0.05em;
  color: var(--text-3);
}
.mq-epg-empty-inline { font-size: 12px; padding: 10px 4px; }

.mq-epg-state {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
  padding: 20px;
}
.mq-epg-state .mq-plate { max-width: 240px; opacity: 0.6; margin-bottom: 8px; }

.mq-foot { margin-top: 4px; }
.mq-barcode {
  display: block;
  width: 100%;
  height: 22px;
  opacity: 0.5;
}
.mq-barcode rect { fill: var(--text-2); }
.mq-spec-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 22px;
  margin-top: 12px;
  font-family: var(--mq-font-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--text-2);
}
.mq-spec-strip .mq-sp-key { color: var(--text-3); margin-right: 5px; }
</style>
