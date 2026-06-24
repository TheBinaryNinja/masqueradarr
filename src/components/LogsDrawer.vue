<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import SearchInput from './SearchInput.vue';
import Segmented from './Segmented.vue';
import { LOGS, LOG_CATEGORIES, reloadLogs, type Log } from '../data';
import { useLogStream } from '../composables/useLogStream';
import { pushToast } from '../composables/useToast';

const emit = defineEmits<{ (e: 'close'): void }>();

const paused = ref(false);
const filter = ref('all'); // 'all' | 'info' | 'issues' (issues = warn ∨ error)
const cat = ref('all'); // category filter (one of LOG_CATEGORIES, or 'all')
const search = ref('');
const autoscroll = ref(true);
const body = ref<HTMLDivElement | null>(null);

// Live tail: the shared LOGS store is fed by useLogStream (a module singleton). While paused we render a
// frozen snapshot so the view holds still even as new lines keep arriving into LOGS in the background.
const frozen = ref<Log[] | null>(null);
watch(paused, (p) => {
  frozen.value = p ? [...LOGS.value] : null;
});
const sourceLogs = computed<Log[]>(() => frozen.value ?? LOGS.value);

const stream = useLogStream();

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}

onMounted(() => {
  stream.subscribe();
  // Refresh the initial snapshot (the bootstrap already seeded LOGS, but re-pull on open so a long-lived
  // tab shows the latest persisted lines under the live tail).
  reloadLogs().catch(() => {
    /* best-effort — the live tail still works without the re-pull */
  });
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  stream.release();
  window.removeEventListener('keydown', onKey);
});

// LOGS is newest-first; render oldest→newest so the existing autoscroll-to-live (bottom) UX is preserved —
// a freshly prepended line lands at the end and the watcher scrolls to it.
const visible = computed(() =>
  [...sourceLogs.value].reverse().filter((l) =>
    (filter.value === 'all'
      || (filter.value === 'info' && l.level === 'info')
      || (filter.value === 'issues' && (l.level === 'warn' || l.level === 'error')))
    && (cat.value === 'all' || l.category === cat.value)
    && (search.value === ''
      || l.message.toLowerCase().includes(search.value.toLowerCase())
      || l.tag.toLowerCase().includes(search.value.toLowerCase())),
  ),
);

const counts = computed(() => ({
  total: sourceLogs.value.length,
  warn: sourceLogs.value.filter((l) => l.level === 'warn').length,
  error: sourceLogs.value.filter((l) => l.level === 'error').length,
}));

watch(visible, async () => {
  if (autoscroll.value && body.value) {
    await nextTick();
    body.value.scrollTop = body.value.scrollHeight;
  }
});

function onScroll(e: Event) {
  const el = e.target as HTMLElement;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  if (atBottom !== autoscroll.value) autoscroll.value = atBottom;
}

function jumpToLive() {
  autoscroll.value = true;
  if (body.value) body.value.scrollTop = body.value.scrollHeight;
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}
function levelColor(l: string) {
  if (l === 'error') return 'var(--bad)';
  if (l === 'warn') return 'var(--warn)';
  return 'var(--text-2)';
}

// Admin clear → DELETE /api/logs (the global fetch wrapper attaches the bearer token), then re-pull + toast.
async function clearLogs() {
  try {
    const res = await fetch('/api/logs', { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { deleted } = (await res.json()) as { deleted: number };
    paused.value = false;
    frozen.value = null;
    await reloadLogs();
    pushToast({ tone: 'good', title: 'Logs cleared', text: `Removed ${deleted} log line(s).` });
  } catch (err) {
    pushToast({ tone: 'bad', title: 'Clear failed', text: (err as Error).message });
  }
}

// Download the currently-visible lines as a plain-text log.
function exportLogs() {
  const text = visible.value
    .map((l) => `${fmtTime(l.ts)}  ${l.level.toUpperCase().padEnd(5)}  [${l.tag}] ${l.message}`)
    .join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tvapp2-logs.txt';
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="logs-drawer-wrap">
    <div class="glass-bg logs-drawer-backdrop" @click="emit('close')" />
    <div class="glass logs-drawer">
      <div class="logs-hd">
        <div class="row" style="gap: 8px;">
          <Icon name="file" :size="15" />
          <span style="font-weight: 600; font-size: 14px;">Realtime logs</span>
          <span v-if="!paused" class="live-pill"
                style="background: oklch(0.78 0.16 150 / 0.18); color: var(--good); border-color: oklch(0.78 0.16 150 / 0.4);">
            <span class="dot" style="background: var(--good); box-shadow: 0 0 8px var(--good);" />STREAMING
          </span>
          <Pill v-if="paused" tone="warn"><Icon name="pause" :size="11" />paused</Pill>
          <span class="muted mono" style="font-size: 11px; margin-left: 6px;">
            {{ counts.total }} lines · {{ counts.warn }} warn · {{ counts.error }} err
          </span>
        </div>
        <SearchInput :value="search" @change="(v) => search = v" placeholder="Filter logs" :width="220" />
        <div class="select" style="min-width: 130px;">
          <select v-model="cat">
            <option value="all">All categories</option>
            <option v-for="c in LOG_CATEGORIES" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
        <Segmented :value="filter" @change="(v) => filter = v" :options="[
          { value: 'all', label: 'All' },
          { value: 'info', label: 'Info' },
          { value: 'issues', label: 'Issues' },
        ]" />
        <span class="spacer" />
        <Btn variant="ghost" size="sm" :icon="paused ? 'play' : 'pause'" @click="paused = !paused">
          {{ paused ? 'Resume' : 'Pause' }}
        </Btn>
        <Btn variant="ghost" size="sm" icon="trash" @click="clearLogs" title="Clear">Clear</Btn>
        <Btn variant="ghost" size="sm" icon="upload" title="Download log" @click="exportLogs">Export</Btn>
        <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" title="Close (Esc)" />
      </div>
      <div class="logs-body" ref="body" @scroll="onScroll">
        <div v-if="visible.length === 0" class="empty" style="padding: 40px;">
          <h3>No log lines match</h3>
          <p>Adjust the search, category, or level filter.</p>
        </div>
        <template v-else>
          <div v-for="(l, i) in visible" :key="`${l.ts}-${i}`" :class="`log-line log-${l.level}`" :title="l.tag">
            <span class="log-ts mono">{{ fmtTime(l.ts) }}</span>
            <span class="log-lvl" :style="{ color: levelColor(l.level) }">{{ l.level.toUpperCase() }}</span>
            <span class="log-src">{{ l.category }}</span>
            <span class="log-msg">{{ l.message }}</span>
          </div>
        </template>
      </div>
      <button v-if="!autoscroll" class="logs-scroll-btn" @click="jumpToLive">
        <Icon name="chevron-d" :size="12" />Jump to live
      </button>
    </div>
  </div>
</template>
