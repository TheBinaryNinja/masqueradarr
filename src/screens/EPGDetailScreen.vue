<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';
import Pill from '../components/Pill.vue';
import StatusDot from '../components/StatusDot.vue';
import SearchInput from '../components/SearchInput.vue';
import ChannelLogo from '../components/ChannelLogo.vue';
import Segmented from '../components/Segmented.vue';
import Stat from '../components/Stat.vue';
import RowActionsMenu, { type RowActionItem } from '../components/RowActionsMenu.vue';
import EditEpgSourceDrawer from '../components/EditEpgSourceDrawer.vue';
import DeleteEpgSourceModal from '../components/DeleteEpgSourceModal.vue';
import UploadXmlModal from '../components/UploadXmlModal.vue';
import {
  EPG_SOURCES, PLAYLISTS, CHANNELS, CRON_JOBS, EPG_PROGRAMS,
  epgMetaChips, formatSyncTime, reloadEpgSources, fetchProgramsFor, tagNames,
  type Channel, type Program, type CronJob,
} from '../data';
import { useTweaks } from '../composables/useTweaks';
import { useToast } from '../composables/useToast';
import { useEpgActions } from '../composables/useEpgActions';
import { summarizeFrequency } from '../composables/useSchedule';
import { useVirtualList } from '../composables/useVirtualList';

const props = defineProps<{ id: string }>();
const { tweaks } = useTweaks();
const router = useRouter();
const toast = useToast();
const { syncingIds, syncEpgSource } = useEpgActions();

const epg = computed(() => EPG_SOURCES.value.find((e) => e.id === props.id) || EPG_SOURCES.value[0]);

const isXmlFile = computed(() => epg.value?.source === 'xml file');
const isPlaylistBound = computed(() => !!epg.value?.playlistBinding);
const uploadOpen = ref(false);
function onUploaded() {
  void reloadEpgSources();
  refreshGuide();
}

const syncJob = computed<CronJob | null>(() =>
  CRON_JOBS.value.find((j) => j.targetType === 'epg-source' && j.targetId === props.id) || null,
);
function fmtRun(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
const nextSync = computed(() => fmtRun(syncJob.value?.nextRun));
const syncSuccess = computed(() => epg.value?.syncSuccessCount ?? 0);
const syncFail = computed(() => epg.value?.syncFailCount ?? 0);

const syncIsAuto = computed(() => !!syncJob.value || !!epg.value?.auto);

const menuOpen = ref(false);
const editOpen = ref(false);
const confirmDelete = ref(false);
const menuItems = computed<RowActionItem[]>(() => {
  const e = epg.value;
  const items: RowActionItem[] = [];
  if (!e) return items;
  const restricted = !!e.builtin || isPlaylistBound.value;
  if (!restricted) {
    if (isXmlFile.value) {
      items.push({ key: 'upload', icon: 'upload', label: 'Upload XML', run: () => { uploadOpen.value = true; } });
    } else {
      const syncing = syncingIds.value.has(e.id);
      items.push({ key: 'sync', icon: 'refresh', label: syncing ? 'Syncing…' : 'Sync', disabled: syncing, run: () => { void syncNow(); } });
    }
  }
  items.push({ key: 'edit', icon: 'edit', label: 'Edit', run: () => { editOpen.value = true; } });
  if (!restricted) {
    items.push({ key: 'delete', icon: 'trash', label: 'Delete', danger: true, run: () => { confirmDelete.value = true; } });
  }
  return items;
});
function onDeleted(): void {
  router.push('/epg-sources');
}

const linkedChannels = computed(() => CHANNELS.value.filter((c) => c.epg === props.id));

const statusFilter = ref<'Active' | 'Disabled'>('Active');
const activeCount = computed(() => linkedChannels.value.filter((c) => c.status === 'Active').length);
const disabledCount = computed(() => linkedChannels.value.filter((c) => c.status === 'Disabled').length);
const search = ref('');
const filteredChannels = computed(() => {
  const q = search.value.trim().toLowerCase();
  return linkedChannels.value.filter((c) => {
    if (c.status !== statusFilter.value) return false;
    if (!q) return true;
    return [c.tvg_name, c.tvg_id, c.group].some((v) => (v || '').toLowerCase().includes(q));
  });
});
watch(() => props.id, () => { statusFilter.value = 'Active'; search.value = ''; spanHours.value = WINDOW_HOURS; });
const linkedPlaylists = computed(() => {
  const byPlaylist = new Map<string, number>();
  for (const c of linkedChannels.value) byPlaylist.set(c.source, (byPlaylist.get(c.source) ?? 0) + 1);
  return [...byPlaylist.entries()].map(([source, count]) => ({
    source,
    count,
    name: PLAYLISTS.value.find((p) => p.id === source)?.name ?? source,
  }));
});

const HOUR_MS = 3_600_000;
const now = ref(Date.now());
function tick() { now.value = Date.now(); }
let id: number | null = null;
onMounted(() => {
  tick();
  id = window.setInterval(tick, 60000);
  void reloadEpgSources();
});
onBeforeUnmount(() => { if (id) clearInterval(id); });

const WINDOW_HOURS = 24;
const MAX_SPAN_HOURS = 24 * 7;
const SPAN_STEP_HOURS = 24;
const LEAD_HOURS = 1;
const spanHours = ref(WINDOW_HOURS);
const windowStart = computed(() => {
  const d = new Date(now.value);
  d.setMinutes(0, 0, 0);
  return d.getTime() - LEAD_HOURS * HOUR_MS;
});
const windowEnd = computed(() => windowStart.value + spanHours.value * HOUR_MS);
function dayHours(ms: number): number { return (ms - windowStart.value) / HOUR_MS; }
function clampDay(h: number): number { return Math.max(0, Math.min(spanHours.value, h)); }
function isLive(p: Program): boolean { return now.value >= p.start && now.value < p.end; }
const nowHHMM = computed(() => formatTime(now.value));

const viewing = ref<{ channel: Channel; prog: Program } | null>(null);
function open(channel: Channel, prog: Program) { viewing.value = { channel, prog }; }
function close() { viewing.value = null; }

async function syncNow() {
  const src = epg.value;
  if (!src) return;
  const { ok, offsetDefaulted } = await syncEpgSource(src.id);
  refreshGuide();
  if (ok && offsetDefaulted) {
    toast.lowerRight({
      tone: 'warn',
      title: 'Time zone offset not set',
      text: 'Stored guide times defaulted to UTC (+0000). Set a Time zone in Settings.',
    });
  }
}

function scheduleSummary(job: CronJob | null): string {
  return job ? summarizeFrequency(job.frequency, job.cron) : '—';
}

function formatTime(ms: number) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function humanizeDur(ms: number) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}
function humanizeDelta(ms: number) {
  if (ms < HOUR_MS) return Math.round(ms / 60000) + ' min';
  return humanizeDur(ms);
}

const HOUR_W = 140;
const totalW = computed(() => spanHours.value * HOUR_W);
const axisLabels = computed(() =>
  Array.from({ length: spanHours.value }, (_, i) => formatTime(windowStart.value + i * HOUR_MS)),
);
function progLeft(p: Program): number { return clampDay(dayHours(p.start)) * HOUR_W + 2; }
function progWidth(p: Program): number {
  return Math.max(2, (clampDay(dayHours(p.end)) - clampDay(dayHours(p.start))) * HOUR_W - 4);
}
function nowLeft(): number { return clampDay(dayHours(now.value)) * HOUR_W; }

const bodyRef = ref<HTMLElement | null>(null);
const headInnerRef = ref<HTMLElement | null>(null);
function syncHeadScroll() {
  if (headInnerRef.value) headInnerRef.value.style.transform = `translateX(${-(bodyRef.value?.scrollLeft ?? 0)}px)`;
}
function centerOnNow() {
  const el = bodyRef.value;
  if (!el) return;
  el.scrollLeft = Math.max(0, nowLeft() - HOUR_W);
  syncHeadScroll();
}
async function recenterTimeline() {
  if (tweaks.epgMode !== 'timeline' || !linkedChannels.value.length) return;
  await nextTick();
  centerOnNow();
}
onMounted(recenterTimeline);
watch(() => [props.id, tweaks.epgMode, linkedChannels.value.length], recenterTimeline);

const ROW_H = 76;
const vt = useVirtualList(bodyRef, () => filteredChannels.value.length, ROW_H);
const vStart = vt.start, vEnd = vt.end, vPad = vt.padTop, vTotal = vt.totalHeight;

function neededKeys(): string[] {
  const chans = tweaks.epgMode === 'timeline'
    ? filteredChannels.value.slice(vStart.value, vEnd.value)
    : filteredChannels.value;
  return chans.map(chKey).filter((k): k is string => !!k);
}
let lastFetchSig = '';
let fetchTimer: number | null = null;
function ensureProgramsLoaded(): void {
  const keys = neededKeys();
  if (!keys.length) return;
  const sig = windowEnd.value + '|' + keys.join(',');
  if (sig === lastFetchSig) return;
  lastFetchSig = sig;
  fetchProgramsFor(keys, windowStart.value, windowEnd.value)
    .catch((err) => console.error('[epg-detail] programs load failed:', err));
}
function scheduleEnsure(): void {
  if (fetchTimer) clearTimeout(fetchTimer);
  fetchTimer = window.setTimeout(ensureProgramsLoaded, 150);
}
function refreshGuide(): void { lastFetchSig = ''; scheduleEnsure(); }

function maybeGrowSpan(): void {
  const el = bodyRef.value;
  if (!el || spanHours.value >= MAX_SPAN_HOURS) return;
  if (el.scrollLeft + el.clientWidth >= totalW.value - HOUR_W * 2) {
    spanHours.value = Math.min(MAX_SPAN_HOURS, spanHours.value + SPAN_STEP_HOURS);
  }
}
function onBodyScroll(): void {
  syncHeadScroll();
  vt.measure();
  maybeGrowSpan();
  scheduleEnsure();
}
watch(
  () => [props.id, tweaks.epgMode, filteredChannels.value.length, spanHours.value, windowEnd.value],
  () => nextTick(() => { vt.measure(); scheduleEnsure(); }),
  { immediate: true },
);
onBeforeUnmount(() => { if (fetchTimer) clearTimeout(fetchTimer); });

const dayLabel = computed(() =>
  'Today, ' +
  new Date(now.value).toLocaleDateString(undefined, {
    weekday: 'long', month: 'short', day: 'numeric',
  }),
);

function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && viewing.value) close(); }
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

function progState(p: Program) {
  if (now.value >= p.start && now.value < p.end) return 'live';
  if (now.value >= p.end) return 'past';
  return 'upcoming';
}

const blurbs: Record<string, string> = {
  'Live': "Live coverage with breaking updates, analysis and reports from correspondents on the ground.",
  'News': "The latest national and international stories, plus business, sport, and a look at tomorrow's papers.",
  'Documentary': "An in-depth feature on the world's most fascinating places, people, and events.",
  'Lifestyle': "Fresh ideas for home, food, and travel — practical inspiration for everyday living.",
  'Film': "A feature-length presentation. Cinematic storytelling with subtitles and audio description available.",
  'Football': "Full match coverage with pre-match build-up, expert punditry, and post-match analysis.",
  'Highlights': "The best moments and key plays condensed into a fast-paced roundup.",
  'Comedy': "An evening of stand-up, sketches, and satire from familiar faces and rising stars.",
  'Series': "The next instalment in our ongoing drama series. Contains scenes some viewers may find intense.",
  'Music': "Back-to-back hits, exclusive sessions, and the latest releases from across the charts.",
  'Kids': "Bright, friendly programming made just for younger viewers — learning through play.",
  'Technology': "What's new in tech, gadgets, and software — reviews, deep-dives, and hands-on demos.",
  'Discussion': "Panel conversation with guests dissecting the day's biggest stories.",
  'Business': "Markets, deals, and the people moving them. Plus analysis from the trading floor.",
  'Weather': "A full national outlook plus regional forecasts for the next 48 hours.",
  'Game show': "Quick-fire rounds and big prizes — armchair contestants welcome.",
  'Feature': "A standalone feature presentation tonight. Tune in for an unmissable story.",
};

function chKey(c: Channel): string | null {
  return c.epg && c.tvg_id ? `${c.epg}:${c.tvg_id}` : null;
}
function progs(c: Channel) {
  const k = chKey(c);
  return k ? (EPG_PROGRAMS[k] || []) : [];
}
function listProgs(c: Channel) {
  return progs(c).filter((p) => p.end >= now.value - HOUR_MS).slice(0, 6);
}
function livePr(c: Channel) {
  return listProgs(c).find((p) => isLive(p));
}
</script>

<template>
  <div v-if="epg" class="col">
    <div class="card" style="display: flex; align-items: center; gap: 16px;">
      <div :class="['src-ico', 'epg-glow', { builtin: epg.builtin, 'epg-builtin': epg.builtin }]"
           style="width: 52px; height: 52px; border-radius: 12px; color: var(--good);">
        <Icon :name="epg.builtin ? 'tv' : 'epg'" :size="22" />
      </div>
      <div style="flex: 1;">
        <div class="row" style="gap: 10px;">
          <StatusDot :status="epg.status" :pulse="epg.status === 'good'" />
          <h2 style="margin: 0; font-size: 18px; font-weight: 600;">{{ epg.name }}</h2>
          <Pill v-if="epg.builtin" tone="system"><Icon name="check" :size="10" />built-in</Pill>
          <Pill tone="cyan">{{ (epg.interval || '').toLowerCase() }}</Pill>
          <Pill v-if="isPlaylistBound" tone="good">Playlist-bound</Pill>
          <Pill v-for="n in tagNames(epg.tags)" :key="n" tone="magenta">{{ n }}</Pill>
        </div>
        <div class="epg-meta">
          <span v-for="c in epgMetaChips(epg, ['source', 'lineupId'])" :key="c.label" class="meta-item" :title="`${c.label}: ${c.value}`">
            <span class="meta-k">{{ c.label }}:</span>
            <span class="meta-chip">{{ c.value }}</span>
          </span>
        </div>
        <div v-if="epg.builtin" class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
          Ships with TVApp2 · guide data is preconfigured and auto-updated with the app.
        </div>
      </div>
      <div class="row" style="gap: 18px;">
        <Stat label="Channels" :value="epg.channels" />
        <Stat label="Programs" :value="epg.programs.toLocaleString()" />
        <Stat label="Synced" :value="formatSyncTime(epg.lastSync)" small />
      </div>
      <div style="position: relative;" @click.stop>
        <Btn
          variant="cyan"
          icon="waffle"
          title="Actions"
          aria-label="Actions"
          aria-haspopup="menu"
          :aria-expanded="menuOpen"
          @click="menuOpen = !menuOpen"
        />
        <RowActionsMenu v-if="menuOpen" :items="menuItems" @close="menuOpen = false" />
      </div>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom: 14px;">
        <Icon name="dashboard" :size="15" style="color: var(--accent);" />
        <span style="font-weight: 600; font-size: var(--fs-base); margin-left: 8px;">Overview</span>
        <template v-if="!isXmlFile && !isPlaylistBound">
          <span class="spacer" />
          <Pill v-if="syncIsAuto" tone="cyan"><Icon name="refresh" :size="10" />{{ scheduleSummary(syncJob) }}</Pill>
          <Pill v-else><Icon name="pause" :size="10" />manual</Pill>
        </template>
      </div>
      <div class="epg-summary-grid">
        <div class="summary-cell">
          <div class="summary-lbl">Channels</div>
          <div class="summary-val">{{ epg.channels.toLocaleString() }}</div>
        </div>
        <div class="summary-cell">
          <div class="summary-lbl">Programs</div>
          <div class="summary-val">{{ epg.programs.toLocaleString() }}</div>
        </div>
        <div class="summary-cell">
          <div class="summary-lbl">Last sync</div>
          <div class="summary-val sm">{{ formatSyncTime(epg.lastSync) }}</div>
        </div>
        <div class="summary-cell">
          <div class="summary-lbl">Next sync</div>
          <div class="summary-val sm">{{ nextSync }}</div>
        </div>
        <div class="summary-cell">
          <div class="summary-lbl">Successful syncs</div>
          <div class="summary-val" style="color: var(--good);">{{ syncSuccess.toLocaleString() }}</div>
        </div>
        <div class="summary-cell">
          <div class="summary-lbl">Failed syncs</div>
          <div class="summary-val" :style="{ color: syncFail > 0 ? 'var(--bad)' : undefined }">{{ syncFail.toLocaleString() }}</div>
        </div>
        <div class="summary-cell">
          <div class="summary-lbl" title="Last time this source's data was emitted into a composed playlist guide">Last guide build</div>
          <div class="summary-val sm">{{ epg.lastXmlAt ? formatSyncTime(epg.lastXmlAt) : '—' }}</div>
        </div>
        <div class="summary-cell">
          <div class="summary-lbl" title="Number of composed playlist guides this source has contributed channels to">Guide contributions</div>
          <div class="summary-val">{{ (epg.xmlGeneratedCount ?? 0).toLocaleString() }}</div>
        </div>
        <div class="summary-cell">
          <div class="summary-lbl">Guide failures</div>
          <div class="summary-val" :style="{ color: (epg.xmlFailCount ?? 0) > 0 ? 'var(--bad)' : undefined }">{{ (epg.xmlFailCount ?? 0).toLocaleString() }}</div>
        </div>
      </div>
    </div>

    <div class="epg-schedules-row">
      <div class="card">
        <div class="row" style="margin-bottom: 12px;">
          <Icon name="playlist" :size="15" style="color: var(--accent);" />
          <span style="font-weight: 600; font-size: var(--fs-base); margin-left: 8px;">Playlists linked to this EPG</span>
          <span class="spacer" />
          <Pill tone="cyan">{{ linkedPlaylists.length }}</Pill>
        </div>
        <div v-if="linkedPlaylists.length" style="display: grid; gap: 6px;">
          <div v-for="pl in linkedPlaylists" :key="pl.source" class="linked-row"
               @click="router.push(`/playlists/${pl.source}`)" :title="`Open ${pl.name}`">
            <span class="linked-ico"><Icon name="playlist" :size="14" /></span>
            <span style="flex: 1; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ pl.name }}</span>
            <Pill>{{ pl.count }} linked</Pill>
          </div>
        </div>
        <div v-else class="muted" style="font-size: var(--fs-sm);">
          No playlist channels are linked to this EPG source yet. Map channels on the
          <strong>Channel Mapping</strong> screen.
        </div>
      </div>

      <div class="card">
        <div class="row" style="margin-bottom: 12px;">
          <Icon name="tv" :size="15" style="color: var(--accent);" />
          <span style="font-weight: 600; font-size: var(--fs-base); margin-left: 8px;">Playlist channels linked to this EPG</span>
          <span class="spacer" />
          <Pill tone="cyan">{{ linkedChannels.length }}</Pill>
        </div>
        <div v-if="linkedChannels.length" style="display: grid; gap: 6px; max-height: 320px; overflow-y: auto;">
          <div v-for="c in linkedChannels" :key="c.id" class="linked-row">
            <ChannelLogo :ch="c" />
            <div style="flex: 1; min-width: 0;">
              <div style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ c.tvg_name }}</div>
              <div class="mono muted" style="font-size: var(--fs-xs);">
                <span v-if="c.tvg_id">{{ c.tvg_id }}</span><span v-else>—</span> · {{ c.group || 'Ungrouped' }}
              </div>
            </div>
            <Pill :tone="c.status === 'Active' ? 'active' : 'disabled'">{{ c.status }}</Pill>
            <Pill v-if="c.epgState === 'matched'" tone="good"><Icon name="check" :size="11" />matched</Pill>
            <Pill v-else tone="warn">{{ c.epgState || 'unmatched' }}</Pill>
          </div>
        </div>
        <div v-else class="muted" style="font-size: var(--fs-sm);">
          No channels are linked to this EPG source yet.
        </div>
      </div>
    </div>

    <div class="card flush epg-grid-card" style="display: flex; flex-direction: column;">
      <div class="toolbar">
        <Pill tone="cyan">
          <Icon name="epg" :size="11" />
          {{ dayLabel }}
        </Pill>
        <SearchInput :value="search" @change="(v) => search = v" :debounce="200" placeholder="Filter channels" :width="220" />
        <Pill tone="system" :title="`${linkedChannels.length} playlist channel(s) linked to this EPG source`">
          {{ linkedChannels.length }} linked
        </Pill>
        <div class="segmented" style="padding: 2px;">
          <button :class="['seg-cyan', statusFilter === 'Active' ? 'active' : '']" @click="statusFilter = 'Active'"
                  style="font-size: 10.5px; padding: 3px 8px;">{{ activeCount }} Active</button>
          <button :class="['seg-amber', statusFilter === 'Disabled' ? 'active' : '']" @click="statusFilter = 'Disabled'"
                  style="font-size: 10.5px; padding: 3px 8px;">{{ disabledCount }} Disabled</button>
        </div>
        <span class="spacer" />
        <span class="muted" style="font-size: var(--fs-xs);">
          Now: <span class="mono" style="color: var(--accent-hi);">{{ nowHHMM }}</span>
        </span>
        <Segmented :value="tweaks.epgMode" @change="() => {}" :options="[
          { value: 'timeline', label: 'Timeline', icon: 'grid' },
          { value: 'list', label: 'List', icon: 'list' },
        ]" />
      </div>

      <div v-if="!linkedChannels.length" class="muted" style="flex: 1; display: grid; place-items: center; text-align: center; padding: 40px;">
        <div>
          <Icon name="epg" :size="32" />
          <div style="margin-top: 12px; font-weight: 600; color: var(--text-1); font-size: 15px;">No channels linked yet</div>
          <div style="margin-top: 6px; font-size: var(--fs-sm);">Map playlist channels to this EPG source on the Channel Mapping screen to see their guide here.</div>
        </div>
      </div>

      <div v-else-if="tweaks.epgMode === 'timeline'" class="epg" style="flex: 1; overflow: hidden;">
        <div class="epg-head">
          <div class="head-l">Channel</div>
          <div ref="headInnerRef" class="head-r" :style="{ width: totalW + 'px' }">
            <div v-for="(label, i) in axisLabels" :key="i" class="epg-time" :style="{ width: HOUR_W + 'px' }">
              {{ label }}
            </div>
          </div>
        </div>
        <div ref="bodyRef" class="epg-body" @scroll="onBodyScroll">
          <div :style="{ width: (200 + totalW) + 'px', height: vTotal + 'px', position: 'relative' }">
            <div :style="{ transform: `translateY(${vPad}px)` }">
              <div v-for="c in filteredChannels.slice(vStart, vEnd)" :key="c.id" class="epg-row">
                <div class="ch">
                  <ChannelLogo :ch="c" />
                  <div style="min-width: 0;">
                    <div class="nm" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ c.tvg_name }}</div>
                    <div class="num mono">#{{ c.channelNo ?? '—' }}</div>
                  </div>
                </div>
                <div class="epg-progs" :style="{ width: totalW + 'px' }">
                  <div v-for="(p, i) in progs(c)" :key="i"
                       :class="['epg-prog', { live: isLive(p) }]"
                       :style="{ left: progLeft(p) + 'px', width: progWidth(p) + 'px' }"
                       @click="open(c, p)"
                       :title="`${p.title} · ${formatTime(p.start)}–${formatTime(p.end)}`">
                    <div class="t">{{ p.title }}</div>
                    <div class="sub">{{ formatTime(p.start) }}–{{ formatTime(p.end) }} · {{ p.cat }}</div>
                  </div>
                  <div class="now-line" :style="{ left: nowLeft() + 'px' }" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-else style="overflow-y: auto; flex: 1;">
        <div v-for="c in filteredChannels" :key="c.id" style="border-bottom: 1px solid var(--hairline); padding: 14px var(--pad-card);">
          <div class="row" style="gap: 10px; margin-bottom: 10px;">
            <ChannelLogo :ch="c" />
            <div>
              <div style="font-weight: 600;">{{ c.tvg_name }}</div>
              <div class="mono muted" style="font-size: var(--fs-xs);">#{{ c.channelNo ?? '—' }} · {{ c.group }}</div>
            </div>
            <span class="spacer" />
            <Pill v-if="livePr(c)" tone="cyan">
              <span class="dot good" style="width: 6px; height: 6px;" />on now: {{ livePr(c)!.title }}
            </Pill>
          </div>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px;">
            <div v-for="(p, i) in listProgs(c)" :key="i"
                 :style="{
                   padding: '10px 12px',
                   background: (isLive(p)) ? 'var(--accent-soft)' : 'var(--bg-2)',
                   border: '1px solid ' + ((isLive(p)) ? 'oklch(0.82 0.13 220 / 0.4)' : 'var(--hairline)'),
                   borderRadius: '8px',
                   cursor: 'default'
                 }"
                 @click="open(c, p)">
              <div class="mono" :style="{ fontSize: 'var(--fs-xs)', color: (isLive(p)) ? 'var(--accent-hi)' : 'var(--text-2)' }">
                {{ formatTime(p.start) }}–{{ formatTime(p.end) }}
              </div>
              <div :style="{ fontWeight: 500, fontSize: 'var(--fs-sm)', marginTop: '2px', color: (isLive(p)) ? 'var(--accent-hi)' : 'var(--text-0)' }">
                {{ p.title }}
              </div>
              <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px;">{{ p.cat }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="viewing" class="stream-view-bg" @click="close">
      <div class="glass stream-view" @click.stop>
        <div class="stream-view-hd">
          <ChannelLogo :ch="viewing.channel" />
          <div style="min-width: 0; flex: 1;">
            <div class="row" style="gap: 8px;">
              <span style="font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ viewing.channel.tvg_name }}</span>
              <span v-if="progState(viewing.prog) === 'live'" class="live-pill"><span class="dot" />LIVE</span>
              <Pill v-else-if="progState(viewing.prog) === 'upcoming'" tone="cyan"><Icon name="epg" :size="11" />upcoming</Pill>
              <Pill v-else>aired</Pill>
            </div>
            <div class="mono muted" style="font-size: var(--fs-xs); margin-top: 3px;">
              #{{ viewing.channel.channelNo ?? '—' }} · {{ viewing.channel.group }} · {{ viewing.channel.stream.res }}
            </div>
          </div>
          <Btn variant="ghost" size="sm" icon="x" @click="close" title="Close (Esc)" />
        </div>

        <div class="stream-view-body">
          <div class="player">
            <template v-if="progState(viewing.prog) === 'past'">
              <div style="position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-2); font-size: 13px;">
                <div style="text-align: center;">
                  <Icon name="epg" :size="32" />
                  <div style="margin-top: 12px; font-weight: 600; color: var(--text-1); font-size: 15px;">Programme has ended</div>
                  <div class="mono" style="font-size: 11px; margin-top: 6px;">aired {{ formatTime(viewing.prog.start) }}–{{ formatTime(viewing.prog.end) }}</div>
                  <div style="margin-top: 16px;"><Btn variant="ghost" size="sm" icon="refresh">Check on-demand</Btn></div>
                </div>
              </div>
            </template>
            <template v-else-if="progState(viewing.prog) === 'upcoming'">
              <div style="position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-2); font-size: 13px;">
                <div style="text-align: center;">
                  <Icon name="epg" :size="32" />
                  <div style="margin-top: 12px; font-weight: 600; color: var(--text-1); font-size: 15px;">Starts at {{ formatTime(viewing.prog.start) }}</div>
                  <div class="mono" style="font-size: 11px; margin-top: 6px;">in {{ humanizeDelta(viewing.prog.start - now) }}</div>
                  <div style="margin-top: 16px;"><Btn variant="primary" size="sm" icon="add">Set reminder</Btn></div>
                </div>
              </div>
            </template>
            <template v-else>
              <div class="stripes" />
              <div class="label mono">{{ viewing.channel.stream.res }} · LIVE</div>
              <div class="play"><div class="play-btn"><Icon name="play" :size="28" /></div></div>
              <div class="controls">
                <Icon name="pause" :size="14" />
                <span class="mono" style="font-size: 11px;">{{ formatTime(now) }}</span>
                <div class="track" />
                <span class="mono" style="font-size: 11px;">{{ formatTime(viewing.prog.end) }}</span>
              </div>
            </template>
          </div>

          <div>
            <div class="muted mono"
                 :style="{ fontSize: '10.5px', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, color: progState(viewing.prog) === 'live' ? 'var(--accent-hi)' : 'var(--text-2)' }">
              {{ progState(viewing.prog) === 'live' ? 'ON NOW' : progState(viewing.prog) === 'upcoming' ? 'UP NEXT' : 'EARLIER TODAY' }} · {{ viewing.prog.cat }}
            </div>
            <h2 style="margin: 6px 0 8px; font-size: 22px; font-weight: 600; letter-spacing: -0.015em;">{{ viewing.prog.title }}</h2>
            <div class="row" style="gap: 6px;">
              <Pill tone="cyan"><Icon name="epg" :size="11" />{{ formatTime(viewing.prog.start) }}–{{ formatTime(viewing.prog.end) }}</Pill>
              <Pill>{{ humanizeDur(viewing.prog.end - viewing.prog.start) }}</Pill>
              <Pill>{{ viewing.prog.cat }}</Pill>
              <span class="spacer" />
              <span v-if="progState(viewing.prog) === 'live'" class="mono muted" style="font-size: 11px;">
                {{ Math.round(Math.min(1, Math.max(0, (now - viewing.prog.start) / (viewing.prog.end - viewing.prog.start))) * 100) }}% elapsed · {{ humanizeDelta(viewing.prog.end - now) }} left
              </span>
            </div>
            <div v-if="progState(viewing.prog) === 'live'" style="margin-top: 10px; height: 4px; border-radius: 999px; background: var(--bg-3); overflow: hidden;">
              <div :style="{ height: '100%', width: (Math.min(1, Math.max(0, (now - viewing.prog.start) / (viewing.prog.end - viewing.prog.start))) * 100) + '%', background: 'var(--accent)', boxShadow: '0 0 12px var(--accent)' }" />
            </div>
          </div>

          <div class="card" style="background: var(--bg-2); padding: 16px;">
            <div style="font-size: var(--fs-sm); line-height: 1.55; color: var(--text-1);">
              {{ blurbs[viewing.prog.cat] || 'A scheduled programme on this channel.' }}
            </div>
          </div>

          <div class="card" style="background: var(--bg-2); padding: 16px;">
            <div style="font-size: var(--fs-sm); font-weight: 600; margin-bottom: 12px;">Programme details</div>
            <div class="kv-list">
              <div class="k">Channel</div>
              <div class="v">{{ viewing.channel.tvg_name }} <span class="mono muted">· #{{ viewing.channel.channelNo ?? '—' }}</span></div>
              <div class="k">Group</div><div class="v">{{ viewing.channel.group }}</div>
              <div class="k">Time</div><div class="v mono">{{ formatTime(viewing.prog.start) }} – {{ formatTime(viewing.prog.end) }}</div>
              <div class="k">Duration</div><div class="v mono">{{ humanizeDur(viewing.prog.end - viewing.prog.start) }}</div>
              <div class="k">Category</div><div class="v">{{ viewing.prog.cat }}</div>
              <div class="k">Resolution</div><div class="v mono">{{ viewing.channel.stream.res }}</div>
              <div class="k">TVG-ID</div>
              <div class="v mono">
                <template v-if="viewing.channel.tvg_id">{{ viewing.channel.tvg_id }}</template>
                <span v-else style="color: var(--text-3);">—</span>
              </div>
              <div class="k">Source</div>
              <div class="v"><Pill tone="cyan">{{ viewing.channel.source }}</Pill></div>
              <div class="k">EPG match</div>
              <div class="v">
                <Pill v-if="viewing.channel.epgState === 'matched'" tone="good"><Icon name="check" :size="11" />matched</Pill>
                <Pill v-else tone="warn">unmatched</Pill>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <DeleteEpgSourceModal
      v-if="confirmDelete"
      :source="epg"
      @close="confirmDelete = false"
      @deleted="onDeleted"
    />

    <EditEpgSourceDrawer
      v-if="editOpen"
      :source="epg"
      @close="editOpen = false"
    />

    <UploadXmlModal
      v-if="uploadOpen"
      :source-id="epg.id"
      :source-name="epg.name"
      @close="uploadOpen = false"
      @uploaded="onUploaded"
    />
  </div>
</template>
