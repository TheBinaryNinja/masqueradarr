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
const { subscribe: subscribeSys, release: releaseSys, cpuSeries, gpuSeries } = useSystemStats();
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
  <div v-if="isAdmin" class="col" style="gap: 18px;">
    <!-- System Performance + GPU Performance share one row. The grid only activates when gpuActive (some
         videoconfig has HW accel on); otherwise this wrapper is a plain block and System Performance is full-width. -->
    <div :style="gpuActive ? 'display: grid; grid-template-columns: minmax(0, 2.6fr) minmax(0, 1fr); gap: 18px; align-items: stretch;' : ''">
    <div class="card flush">
      <div class="card-hd">
        <Icon name="activity" :size="15" style="color: var(--accent);" />
        <h2>System Performance</h2>
        <span class="spacer" />
        <span class="muted" style="font-size: var(--fs-xs);">Live · {{ sysScope }}</span>
      </div>
      <div style="padding: 12px var(--pad-card) 0;">
        <LivelineChart :series="cpuSeries" :target="80" />
      </div>
      <!-- 16px spacer between the CPU liveline and the metric tiles -->
      <div style="height: 16px;" />
      <!-- Bottom row: the 5 live metric tiles (flex: 1) + the DB Health mini-card pinned to the right. -->
      <div style="display: flex; align-items: stretch; border-top: 1px solid var(--hairline);">
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

    <!-- GPU Performance — mirrors System Performance (liveline + 16px spacer + tiles); rendered only while
         gpuActive (a videoconfig has HW accel enabled). Unavailable per-vendor metrics render as '—'. -->
    <div v-if="gpuActive" class="card flush">
      <div class="card-hd">
        <Icon name="activity" :size="15" style="color: var(--accent);" />
        <h2>GPU Performance</h2>
        <span class="spacer" />
        <span class="muted" style="font-size: var(--fs-xs);">{{ gpuCaption }}</span>
      </div>
      <div style="padding: 12px var(--pad-card) 0;">
        <LivelineChart :series="gpuSeries" :target="80" />
      </div>
      <div style="height: 16px;" />
      <div class="stats" style="grid-template-columns: repeat(3, 1fr); margin: 0; border-top: 1px solid var(--hairline);">
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
          <span class="muted" style="font-size: var(--fs-xs);">Live · last 24h</span>
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
            <div v-if="recentHistory.length === 0" class="act">
              <div class="muted" style="font-size: var(--fs-sm); padding: 4px 0;">No viewer sessions recorded yet.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div v-else class="col" style="gap: 18px;">
    <!-- 1. Welcome Card -->
    <div class="card" style="padding: 20px; background: linear-gradient(135deg, rgba(var(--cyan-rgb), 0.1) 0%, rgba(var(--indigo-rgb), 0.1) 100%); border: 1px solid rgba(var(--cyan-rgb), 0.15); border-radius: 12px; display: flex; align-items: center; gap: 20px;">
      <div class="avatar" style="width: 50px; height: 50px; font-size: 20px; background: var(--cyan); color: var(--bg-1); display: flex; align-items: center; justify-content: center; border-radius: 50%; font-weight: 700;">{{ userInitials }}</div>
      <div style="flex: 1;">
        <h2 style="margin: 0; font-size: 20px; font-weight: 700; color: var(--text-0);">Welcome, {{ currentUser?.username }}!</h2>
        <p style="margin: 4px 0 0; font-size: 13px; color: var(--text-2);">Role: <span style="text-transform: capitalize; font-weight: 600; color: var(--cyan);">{{ currentUser?.role }}</span></p>
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
      <div style="font-weight: 600; font-size: 16px; color: var(--text-0);">Integration URLs</div>
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
        <div style="font-weight: 600; font-size: 15px; color: var(--text-0);">Available Channels</div>
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
          <div v-if="filteredChannels.length === 0" class="muted" style="text-align: center; padding: 20px;">
            No channels found or assigned.
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
        <div v-else class="card" style="height: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 40px; text-align: center; min-height: 280px;">
          <Icon name="tv" :size="48" style="color: var(--text-3); margin-bottom: 12px;" />
          <div style="font-weight: 600; font-size: 15px; color: var(--text-1);">No Channel Selected</div>
          <div class="muted" style="font-size: 12px; max-width: 280px; margin-top: 4px;">Select a channel from the list on the left to start streaming directly in your browser.</div>
        </div>
      </div>
    </div>
  </div>
</template>
