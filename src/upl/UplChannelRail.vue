<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import type { Channel, Program } from '../data';
import ChannelLogo from '../components/ChannelLogo.vue';
import Icon from '../components/Icon.vue';
import { useVirtualList } from '../composables/useVirtualList';
import { now, nowNext, progressOf, epgKey, fmtClock, fmtRemaining, sortKey } from './useUplData';

const ROW_H = 58;

const props = defineProps<{
  channels: Channel[];
  programs: Record<string, Program[]>;
  currentId: string | null;
  open: boolean;
}>();
const emit = defineEmits<{
  (e: 'tune', ch: Channel): void;
  (e: 'update:open', v: boolean): void;
  (e: 'visibleKeys', keys: (string | null)[]): void;
}>();

const scroller = ref<HTMLElement | null>(null);
const filter = ref('');

const shown = computed<Channel[]>(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return props.channels;
  return props.channels.filter(
    (c) => c.tvg_name.toLowerCase().includes(q) || (c.channelNo ?? '').includes(q),
  );
});

const vl = useVirtualList(scroller, () => shown.value.length, ROW_H);
const vStart = vl.start, vPad = vl.padTop, vTotal = vl.totalHeight;

const cursor = ref(0);

const sliceRows = computed(() => {
  const at = now.value;
  return shown.value.slice(vStart.value, vl.end.value).map((ch, i) => {
    const k = epgKey(ch);
    const nn = nowNext(k ? props.programs[k] : undefined, at, 1);
    return {
      ch,
      index: vStart.value + i,
      hasKey: !!k,
      loaded: !!k && k in props.programs,
      live: nn.live,
      next: nn.upcoming[0] ?? null,
      pct: Math.round(progressOf(nn.live, at) * 100),
    };
  });
});

watch(sliceRows, (rows) => emit('visibleKeys', rows.map((r) => epgKey(r.ch))), { immediate: true });

watch(shown, () => { void nextTick(() => vl.measure()); });
watch(sortKey, () => { void nextTick(() => syncCursorToCurrent()); });

function move(delta: number): void {
  if (shown.value.length === 0) return;
  cursor.value = Math.min(shown.value.length - 1, Math.max(0, cursor.value + delta));
  const first = vl.topIndex();
  const rows = Math.max(1, Math.floor((scroller.value?.clientHeight ?? ROW_H) / ROW_H));
  if (cursor.value < first) vl.scrollToIndex(cursor.value);
  else if (cursor.value >= first + rows) vl.scrollToIndex(cursor.value - rows + 1);
}
function tuneCursor(): void {
  const c = shown.value[cursor.value];
  if (c) emit('tune', c);
}
function syncCursorToCurrent(): void {
  const i = shown.value.findIndex((c) => c.id === props.currentId);
  if (i >= 0) {
    cursor.value = i;
    void nextTick(() => vl.scrollToIndex(Math.max(0, i - 2)));
  }
}
watch(() => props.open, (o) => { if (o) syncCursorToCurrent(); });
onMounted(() => { vl.measure(); syncCursorToCurrent(); });

defineExpose({ move, tuneCursor });
</script>

<template>
  <div class="upl-rail-edge" @mouseenter="emit('update:open', true)" />

  <aside class="glass upl-rail" :class="{ open }" @mouseleave="emit('update:open', false)">
    <div class="upl-rail-hd">
      <Icon name="tv" :size="14" />
      <span class="upl-rail-count mono">{{ shown.length }}</span>
      <input v-model="filter" class="input upl-rail-search" placeholder="Filter channels…" />
      <button
        type="button"
        class="upl-rail-sort"
        :class="{ 'is-active': sortKey === 'name' }"
        :aria-pressed="sortKey === 'name' ? 'true' : 'false'"
        :title="sortKey === 'name'
          ? 'Sorted by channel name — switch to channel number order'
          : 'Sorted by channel number — switch to A–Z'"
        @click="sortKey = sortKey === 'name' ? 'channelNo' : 'name'"
      >{{ sortKey === 'name' ? 'A–Z' : '#' }}</button>
      <button type="button" class="upl-rail-close" aria-label="Hide channels" @click="emit('update:open', false)">
        <Icon name="x" :size="14" />
      </button>
    </div>

    <div class="upl-rail-list" ref="scroller" @scroll="vl.onScroll">
      <div :style="{ height: vTotal + 'px', position: 'relative' }">
        <div :style="{ transform: `translateY(${vPad}px)` }">
          <button
            v-for="row in sliceRows"
            :key="row.ch.id"
            type="button"
            class="upl-rail-row"
            :class="{ playing: row.ch.id === currentId, cursored: row.index === cursor }"
            @click="emit('tune', row.ch)"
          >
            <ChannelLogo :ch="row.ch" />
            <span class="upl-rail-no mono">{{ row.ch.channelNo || '—' }}</span>
            <span class="upl-rail-body">
              <span class="upl-rail-name">{{ row.ch.tvg_name }}</span>
              <span class="upl-rail-epg mono">
                <template v-if="row.live">
                  {{ row.live.title }}<span class="muted"> · {{ fmtRemaining(row.live, now) }}</span>
                </template>
                <span v-else-if="!row.hasKey" class="muted">no guide link</span>
                <span v-else-if="row.loaded" class="muted">no guide data</span>
                <span v-else class="muted">…</span>
              </span>
              <span v-if="row.live" class="upl-rail-bar">
                <span class="upl-rail-fill" :style="{ width: row.pct + '%' }" />
              </span>
              <span v-if="row.index === cursor && row.next" class="upl-rail-then mono muted">
                then {{ fmtClock(row.next.start) }} {{ row.next.title }}
              </span>
            </span>
            <Icon v-if="row.ch.id === currentId" name="activity" :size="13" />
          </button>
        </div>
      </div>
      <div v-if="shown.length === 0" class="empty">No channels match “{{ filter }}”.</div>
    </div>
  </aside>
</template>

<style scoped>
.upl-rail-edge {
  position: absolute;
  inset: 0 0 0 auto;
  width: 14px;
  z-index: 4;
}
.upl-rail {
  position: absolute;
  inset: 0 0 0 auto;
  z-index: 5;
  width: 340px;
  max-width: 84vw;
  display: flex;
  flex-direction: column;
  transform: translateX(100%);
  transition: transform 0.18s ease;
}
.upl-rail.open { transform: none; }

.upl-rail-hd {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 8px;
  border-bottom: 1px solid var(--hairline);
}
.upl-rail-count { font-size: var(--fs-xs); color: var(--text-3); }
.upl-rail-search { flex: 1; height: 28px; font-size: var(--fs-xs); }
.upl-rail-close {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}
.upl-rail-close:hover { color: var(--text-0); background: oklch(1 0 0 / 0.06); }
.upl-rail-sort {
  display: grid;
  place-items: center;
  height: 24px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.upl-rail-sort:hover { color: var(--text-0); background: oklch(1 0 0 / 0.06); }
.upl-rail-sort.is-active { color: var(--accent); }

.upl-rail-list { flex: 1; min-height: 0; overflow-y: auto; }

.upl-rail-row {
  box-sizing: border-box;
  height: 58px;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 10px;
  border: 0;
  border-left: 2px solid transparent;
  background: transparent;
  color: var(--text-1);
  text-align: left;
  cursor: pointer;
}
.upl-rail-row:hover { background: oklch(1 0 0 / 0.04); }
.upl-rail-row.cursored { background: oklch(1 0 0 / 0.07); }
.upl-rail-row.playing { border-left-color: var(--accent); color: var(--accent-hi); }
.upl-rail-no { flex: 0 0 30px; font-size: var(--fs-xs); color: var(--text-3); }
.upl-rail-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.upl-rail-name {
  font-size: var(--fs-sm);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.upl-rail-epg {
  font-size: 10px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.upl-rail-bar {
  height: 2px;
  border-radius: 2px;
  background: oklch(1 0 0 / 0.1);
  overflow: hidden;
  margin-top: 2px;
}
.upl-rail-fill { display: block; height: 100%; background: var(--accent); }
.upl-rail-then { font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
