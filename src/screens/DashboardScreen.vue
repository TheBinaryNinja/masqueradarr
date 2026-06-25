<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';
import Pill from '../components/Pill.vue';
import StatusDot from '../components/StatusDot.vue';
import ChannelLogo from '../components/ChannelLogo.vue';
import HlsPlayer from '../components/HlsPlayer.vue';
import PublishedUrlGroups from '../components/PublishedUrlGroups.vue';
import LivelineChart from '../components/LivelineChart.vue';
import { PLAYLISTS, EPG_SOURCES, CHANNELS, ACTIVE_STREAMS, VIEW_SESSIONS, SYSTEM_STATS, epgMetaChips, formatSyncTime, reloadPlaylists, reloadViewSessions, appPlayerProxyPath, playlistScheduleLabel } from '../data';
import { bus } from '../composables/bus';
import { currentUser, isAdmin, regenerateStreamToken } from '../composables/useAuth';
import { usePublishedUrls } from '../composables/usePublishedUrls';
import { useToast } from '../composables/useToast';
import { useStreamStats } from '../composables/useStreamStats';
import { useSystemStats } from '../composables/useSystemStats';

const emit = defineEmits<{ (e: 'add', k: 'playlist' | 'epg'): void }>();
const router = useRouter();
function go(p: string) { router.push(p); }

// Deterministic Code128-style barcode strip — same seed, same bars (the masqueradarr brand idiom,
// mirroring LoginScreen/SetupScreen: seed 20240624, self-contained, no artwork fetch).
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
// "Unmatched" = anything not EPG-matched, including the null seed state (never EPG-evaluated) —
// not just epgState === 'unmatched'. epgState is the dedicated match-status indicator ('matched' | 'unmatched' | null).
const unmatched = computed(() => CHANNELS.value.filter((c) => c.epgState !== 'matched').length);
// Realtime phase governor (stream.status: 'live' | 'establishing' | 'buffer' | 'failed' | null) — the
// same field PlaylistDetailScreen labels "live"/"down". Distinct from the top-level Active/Disabled governor.
const channelsLive = computed(() => CHANNELS.value.filter((c) => c.stream.status === 'live').length);
const channelsDown = computed(() => CHANNELS.value.filter((c) => c.stream.status === 'failed').length);
// Manual vs. auto sync split for the Playlists card. "Manual" = no scheduled Sync cron job for the
// playlist's source (playlistScheduleLabel resolves to the lowercase 'manual'); "auto" = a scheduled
// interval exists. Branching on the same cron-derived label the per-row "Sync:" chip renders keeps the
// card count in agreement with the chips in the Playlists panel directly below.
const playlistSyncSplit = computed(() => {
  let manual = 0, auto = 0;
  for (const p of PLAYLISTS.value) {
    if (playlistScheduleLabel(p.id, 'playlist') === 'manual') manual++;
    else auto++;
  }
  return { manual, auto };
});
// Real active/disabled split for the Channels card — the top-level enable governor (status: 'Active' =
// included in the m3u, 'Disabled' = excluded). Mirrors the Playlists card's manual/auto side-by-side and
// is derived from the same CHANNELS feed the card's total reads (no per-channel created timestamp exists,
// so a "new this week" count cannot be computed).
const channelsActive = computed(() => CHANNELS.value.filter((c) => c.status === 'Active').length);
const channelsDisabled = computed(() => CHANNELS.value.filter((c) => c.status === 'Disabled').length);

// ── Activity panel — live Active Sessions + recent History ─────────────
// Live snapshot over the /api/stream-stats WebSocket: the same ref-counted singleton the Active
// Streams and History/Metrics screens use (no polling). Only sessions whose channelId resolves to a
// real channel are surfaced; recentHistory reads the shared newest-first VIEW_SESSIONS feed.
const { subscribe: subscribeStats, release: releaseStats } = useStreamStats();
function chOf(channelId: string) { return CHANNELS.value.find((c) => c.id === channelId); }
const activeSessions = computed(() => ACTIVE_STREAMS.value.filter((s) => chOf(s.channelId)));
const recentHistory = computed(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // last-24h window, matching the panel caption
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

// ── System Performance banner — live host/container metrics ────────────
// Live frame over the /api/system-stats WebSocket (ref-counted singleton, admin-only — operator data). The
// CPU% rolling series feeds the LivelineChart; the other four metrics are numeric tiles updated each tick.
const { subscribe: subscribeSys, release: releaseSys, cpuSeries, gpuSeries, cpuTimes, gpuTimes } = useSystemStats();
// LivelineChart inputs. cpuSeries/gpuSeries (+ their lockstep cpuTimes/gpuTimes arrival stamps) are refs
// mutated IN PLACE; hand the chart finite-only samples paired with their stamps — filtered as PAIRS so
// series and times stay index-aligned. The finite filter guards liveline's freeze-prone tick math (skill
// §7.3); the stable per-sample stamps let a full window glide instead of snapping each tick — the jitter
// seen on Dashboard re-entry (skill §7.1). liveline owns the 60fps glide.
function zipFinite(vals: number[], times: number[]): { series: number[]; times: number[] } {
  const series: number[] = [], ts: number[] = [];
  for (let i = 0; i < vals.length; i++) {
    if (Number.isFinite(vals[i])) { series.push(vals[i]); ts.push(times[i]); }
  }
  return { series, times: ts };
}
const cpuChart = computed(() => zipFinite(cpuSeries.value, cpuTimes.value));
const gpuChart = computed(() => zipFinite(gpuSeries.value, gpuTimes.value));
// Where CPU/Memory were measured: cgroup limits ('container') vs the whole machine ('host').
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

// GPU Performance card — visible only while SYSTEM_STATS.gpu is non-null (server-gated: a videoconfig has HW
// accel enabled). gpuSeries feeds its liveline; the tiles read the same live frame. Unavailable metrics → '—'.
const gpu = computed(() => SYSTEM_STATS.value?.gpu ?? null);
const gpuActive = computed(() => gpu.value != null);
const gpuVendorLabel = computed(() => {
  const v = gpu.value?.vendor;
  return v === 'nvidia' ? 'NVIDIA' : v === 'amd' ? 'AMD' : v === 'intel' ? 'Intel' : 'GPU';
});
const gpuCaption = computed(() => gpu.value?.name || gpuVendorLabel.value);
// The encode API behind the enabled encoder (e.g. 'h264_nvenc' → 'NVENC') — short enough for the tile value.
const gpuApi = computed(() => {
  const e = gpu.value?.encoder || '';
  if (e.includes('nvenc')) return 'NVENC';
  if (e.includes('qsv')) return 'QSV';
  if (e.includes('vaapi')) return 'VAAPI';
  if (e.includes('amf')) return 'AMF';
  if (e.includes('videotoolbox')) return 'VideoToolbox';
  return '—';
});
function fmtTemp(n: number | null | undefined) { return n == null ? '—' : `${Math.round(n)}°C`; }

// DB Health card — live MongoDB metrics from the same WS frame (mongo.health is null until the second
// serverStatus sample lets the server take a delta, so the rate values show '—' for the first ~5s).
const dbHealth = computed(() => SYSTEM_STATS.value?.mongo.health ?? null);
function fmtPerSec(n: number | null | undefined) { return n == null ? '—' : `${n < 10 ? n.toFixed(1) : Math.round(n)} /s`; }
function fmtMs(n: number | null | undefined) { return n == null ? '—' : `${n.toFixed(1)} ms`; }
function fmtRatio(n: number | null | undefined) { return n == null ? '—' : `${n.toFixed(1)} : 1`; }
function fmtCount(n: number | null | undefined) { return n == null ? '—' : `${n}`; }

// User-specific states & computed properties
const toast = useToast();
const channelSearch = ref('');
const selectedChannel = ref<any>(null);

const userInitials = computed(() => {
  const name = currentUser.value?.username || '';
  return name.slice(0, 2).toUpperCase();
});

// Per-user published playlist URLs — one grouped card per playlist the current user is allowed (Global
// first, then each allowed custom). The shared composable derives identical URLs to the admin Users
// screen from data the SPA already has (identity + allow-lists + PLAYLISTS + operator domain), so there
// is no new data-model field and no backend call. PublishedUrlGroups owns the copy + confirmation modal.
const publishedUrls = usePublishedUrls(() => currentUser.value);

const filteredChannels = computed(() => {
  return CHANNELS.value.filter((c) => {
    if (!channelSearch.value) return true;
    const q = channelSearch.value.toLowerCase();
    return (c.tvg_name || '').toLowerCase().includes(q) || (c.group || '').toLowerCase().includes(q);
  });
});

const selectedChannelProxyPath = computed(() => {
  if (!selectedChannel.value) return null;
  return appPlayerProxyPath(selectedChannel.value);
});

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

// A sign-in/out on Settings flips a playlist's isAuthenticated — re-read so the badge updates live.
// The admin-only Activity panel also subscribes to the live stream-stats WS (Active Sessions push +
// freshly-closed sessions prepended into VIEW_SESSIONS) and refreshes the history once on enter.
onMounted(() => {
  bus.on('tvapp:auth-changed', reloadPlaylists);
  if (isAdmin.value) {
    subscribeStats();
    subscribeSys();
    reloadViewSessions().catch(() => { /* best-effort history refresh on enter */ });
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
    <!-- masqueradarr HUD micro row — telemetry overline for the whole admin console -->
    <div class="mq-micro-row" aria-hidden="true">
      <span class="mq-micro-hi">MASQUERADARR // CONSOLE</span>
      <span>MK-SYS / DASH</span>
    </div>

    <!-- System Performance + GPU Performance share one row. The grid only activates when gpuActive (some
         videoconfig has HW accel on); otherwise this wrapper is a plain block and System Performance is full-width. -->
    <div :style="gpuActive ? 'display: grid; grid-template-columns: minmax(0, 2.6fr) minmax(0, 1fr); gap: 18px; align-items: stretch;' : ''">
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
      <!-- 32px spacer between the CPU liveline and the metric tiles (keeps the liveline's scrolling
           y-axis numbers from overlapping the row below) -->
      <div style="height: 32px;" />
      <!-- Bottom row: the 5 live metric tiles (flex: 1) + the DB Health mini-card pinned to the right.
           Wrapped in its own nested .card flush so it keeps a carded surface while the chart above
           blends into the page (.sys-flush on the outer card). -->
      <div class="card flush">
      <div style="display: flex; align-items: stretch;">
      <div class="stats" style="grid-template-columns: repeat(5, 1fr); margin: 0; flex: 1; min-width: 0;">
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
      <!-- DB Health — live MongoDB metrics (mono values) pinned to the right of the DB connections tile. -->
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

    <!-- GPU Performance — mirrors System Performance (liveline + 16px spacer + tiles); rendered only while
         gpuActive (a videoconfig has HW accel enabled). Unavailable per-vendor metrics render as '—'. -->
    <div v-if="gpuActive" class="card flush sys-flush">
      <div class="card-hd">
        <Icon name="activity" :size="15" style="color: var(--accent);" />
        <h2>GPU Performance</h2>
        <span class="spacer" />
        <span class="mq-cap">{{ gpuCaption }}</span>
      </div>
      <div style="padding: 12px var(--pad-card) 0;">
        <LivelineChart :series="gpuChart.series" :times="gpuChart.times" :target="80" />
      </div>
      <div style="height: 32px;" />
      <!-- Bottom row: GPU metric tiles in a nested .card flush so they keep a carded surface while the
           chart above blends into the page (.sys-flush on the outer card) — mirrors System Performance. -->
      <div class="card flush">
      <div class="stats" style="grid-template-columns: repeat(3, 1fr); margin: 0;">
        <div class="stat">
          <div class="lbl">Memory</div>
          <div class="val">{{ fmtPct(gpu?.memUsedPct) }}</div>
          <div class="delta">
            <template v-if="gpu?.memTotalBytes != null">{{ fmtBytes(gpu?.memUsedBytes) }} / {{ fmtBytes(gpu?.memTotalBytes) }}</template>
            <template v-else>shared memory</template>
          </div>
        </div>
        <div class="stat">
          <div class="lbl">Temperature</div>
          <div class="val">{{ fmtTemp(gpu?.temperatureC) }}</div>
          <div class="delta">{{ gpuVendorLabel }}</div>
        </div>
        <div class="stat">
          <div class="lbl">Encoder</div>
          <div class="val" style="font-size: 20px;">{{ gpuApi }}</div>
          <div class="delta">{{ gpu?.source || 'no live source' }}</div>
        </div>
      </div>
      </div>
    </div>
    </div>

    <!-- spec-sheet overline above the six stat tiles -->
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

    <!-- brand foot — deterministic barcode + mono spec strip; sits full-width above Playlists/Activity -->
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
          <div v-for="p in PLAYLISTS" :key="p.id" class="src-row" @click="go(`/playlists/${p.id}`)">
            <div :class="['src-ico', { builtin: p.builtin }]">
              <Icon :name="p.builtin ? 'tv' : 'playlist'" :size="18" />
            </div>
            <div>
              <div class="src-name">
                <StatusDot :status="p.status" :pulse="p.status === 'good'" />
                {{ p.name }}
                <Pill v-if="p.builtin" tone="system"><Icon name="check" :size="10" />built-in</Pill>
                <Pill tone="cyan"><Icon name="refresh" :size="10" />Sync: {{ playlistScheduleLabel(p.id, 'playlist') }}</Pill>
                <Pill tone="cyan"><Icon name="file" :size="10" />M3U: {{ playlistScheduleLabel(p.id, 'playlist-m3u') }}</Pill>
                <Pill v-if="p.authentication" :tone="p.isAuthenticated ? 'good' : 'warn'">
                  <Icon :name="p.isAuthenticated ? 'check' : 'lock'" :size="10" />
                  {{ p.isAuthenticated ? 'Authenticated' : 'Sign-in needed' }}
                </Pill>
              </div>
              <div class="src-url">{{ p.url }}</div>
            </div>
            <div class="stat-mini"><b>{{ p.channels }}</b>channels</div>
            <div class="stat-mini"><b>{{ p.groups }}</b>groups</div>
            <div class="stat-mini" style="min-width: 110px;">
              <b style="font-size: 12px; font-weight: 500; color: var(--text-1);">{{ p.lastSync }}</b>
              last sync
            </div>
            <Btn variant="ghost" size="sm" icon="chevron-r" />
          </div>
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
          <div v-for="p in EPG_SOURCES" :key="p.id" class="src-row" @click="go(`/epg-sources/${p.id}`)">
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
          <!-- Active Sessions — rendered only when there are live sessions (nothing shown otherwise) -->
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

          <!-- History — recent completed watch sessions (always shown) -->
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
              <!-- decorative SCAN FIELD micrographic plate (masqueradarr-micrographics MK-07.5) -->
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

  <div v-else class="col mq-dash" style="gap: 18px;">
    <!-- masqueradarr HUD micro row — telemetry overline for the end-user console -->
    <div class="mq-micro-row" aria-hidden="true">
      <span class="mq-micro-hi">MASQUERADARR // ACCOUNT</span>
      <span>MK-SYS / DASH</span>
    </div>

    <!-- 1. Welcome Card -->
    <div class="card mq-welcome" style="padding: 20px; display: flex; align-items: center; gap: 20px;">
      <!-- brand mark-in-circle avatar idiom (teal circle, obsidian glyph) — masqueradarr-logotype §3 -->
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

    <!-- 2. Integration URLs -->
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

    <!-- 3. Channel Stream & Preview -->
    <div style="display: grid; grid-template-columns: 1fr 1.5fr; gap: 18px;">
      <!-- Left Side: Channels List -->
      <div class="card flush" style="display: flex; flex-direction: column; padding: 16px; gap: 12px; min-height: 400px; max-height: 600px;">
        <div class="mq-h" style="font-size: 15px;">Available Channels</div>
        <div class="input">
          <input v-model="channelSearch" placeholder="Search channels or groups..." style="width: 100%;" />
        </div>
        <div style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding-right: 4px;">
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
            <!-- decorative UPLINK micrographic plate (masqueradarr-micrographics MK-07.2) -->
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
      </div>

      <!-- Right Side: Player Preview -->
      <div>
        <div v-if="selectedChannel" class="card flush" style="height: 100%; display: flex; flex-direction: column;">
          <div class="player chd-player" style="aspect-ratio: 16/9; background: #000; border-radius: 8px 8px 0 0; overflow: hidden; position: relative;">
            <HlsPlayer :src="selectedChannelProxyPath" />
          </div>
          <div style="padding: 16px; display: flex; flex-direction: column; gap: 10px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: var(--text-0);">{{ selectedChannel.tvg_name }}</h3>
                <div class="muted" style="font-size: 12px;">#{{ selectedChannel.channelNo || '—' }} · {{ selectedChannel.group }}</div>
              </div>
              <div class="row" style="gap: 8px;">
                <Pill tone="cyan">{{ selectedChannel.source }}</Pill>
                <Pill v-if="selectedChannel.stream.res" tone="good">{{ selectedChannel.stream.res }}</Pill>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="card mq-lockstate" style="height: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 40px; text-align: center; min-height: 280px;">
          <!-- decorative SIGNAL LOCK micrographic plate (masqueradarr-micrographics MK-07.3) — "waiting to lock onto a stream" -->
          <svg class="mq-plate" viewBox="0 0 360 230" aria-hidden="true">
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
          <div class="mq-lock-tag" aria-hidden="true">AWAITING SIGNAL LOCK</div>
          <div style="font-weight: 600; font-size: 15px; color: var(--text-1);">No Channel Selected</div>
          <div class="muted" style="font-size: 12px; max-width: 280px; margin-top: 4px;">Select a channel from the list on the left to start streaming directly in your browser.</div>
        </div>
      </div>
    </div>

    <!-- brand foot — deterministic barcode + mono spec strip -->
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
/* ── masqueradarr brand chrome (scoped exception, matching LoginScreen/HlsPlayer) ──────────
   Two colors only (teal signal via --accent/--mq-teal, red risk via --bad/--mq-risk); two
   fonts only (Space Grotesk display, JetBrains Mono telemetry). All hues flow through tokens. */

/* ── elevation over the .mq-stage field ───────────────────────────────────────────────────
   The dashboard sits on the lit-center / dark-edge brand stage (owned by .mq-stage in
   styles.css). A flat --bg-1 card would float against that gradient with no separation, so
   The base card elevation (lifted --bg-2 → --bg-1 gradient + stronger hairline + layered shadow)
   now lives globally on .card in styles.css, so the dashboard's own cards inherit it with no
   scoped copy here. The welcome card keeps its own teal-tint surface gradient (.mq-welcome) and
   only borrows the lift (border + shadow), so its override remains. */
.mq-dash .card.mq-welcome {
  box-shadow:
    inset 0 1px 0 var(--accent-soft),
    0 1px 2px rgba(0, 0, 0, 0.28),
    0 14px 34px rgba(0, 0, 0, 0.34),
    0 0 0 1px var(--accent-soft);
}
/* Light theme: the welcome card's teal-ring shadow needs the same softening the global .card
   light variant applies — soften the drop shadow and lift the top highlight toward white. */
[data-theme="light"] .mq-dash .card.mq-welcome {
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.7),
    0 1px 2px rgba(0, 0, 0, 0.06),
    0 12px 28px rgba(0, 0, 0, 0.10),
    0 0 0 1px var(--accent-soft);
}

/* System & GPU performance cards: the outer shell is a bare container so the liveline + header blend
   into the page (no surface / border / shadow), while the nested .card flush lower row keeps the carded
   treatment. The flat opt-out is now the global .card.sys-flush utility in styles.css (it strips the
   global card elevation in both themes); these shells carry the sys-flush class in the template. */

/* HUD micro row — console telemetry overline */
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

/* mono live caption (telemetry idiom) for card headers */
.mq-cap {
  font-family: var(--mq-font-mono);
  font-size: var(--fs-xs);
  letter-spacing: 0.12em;
  color: var(--text-3);
  white-space: nowrap;
}

/* spec-sheet overline with teal rule */
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

/* brand display heading (Space Grotesk, tight tracking) */
.mq-h {
  font-family: var(--mq-font-sans);
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--text-0);
}

/* end-user welcome card — brand teal tint surface (no second/third hue) */
.mq-welcome {
  background: linear-gradient(135deg, var(--accent-soft) 0%, var(--bg-1) 100%);
  border: 1px solid var(--accent-soft);
  border-radius: var(--radius-m);
}

/* brand mark-in-circle avatar idiom — teal circle, obsidian-ish glyph */
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

/* decorative micrographic emblem plates (aria-hidden; paired with real text labels) */
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

/* signal-lock player idle state */
.mq-lockstate .mq-plate { max-width: 300px; opacity: 0.7; margin-bottom: 8px; }
.mq-lock-tag {
  font-family: var(--mq-font-mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--accent);
  margin-bottom: 10px;
}

/* brand foot — deterministic barcode + mono spec strip */
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
