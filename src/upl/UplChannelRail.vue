<script setup lang="ts">
// UplChannelRail — the non-obtrusive channel switcher: an overlay rail on the right edge, hidden until you
// want it (hover the edge, press C, or use the shell's Channels button), auto-hiding again once you stop
// interacting. It deliberately renders NO handle of its own: an absolutely-positioned tab against .upl-root
// lands inside the header band and collides with that Channels button.
//
// Virtualized with useVirtualList, which requires a FIXED row height — hence ROW_H here and the matching
// locked height in CSS. A playlist can hold thousands of channels, and only the rows actually on screen are
// rendered (and only those have their guide data fetched, via the `visibleKeys` emit).
//
// Each row carries a brief EPG summary — what's on now, how long is left, and an elapsed bar — so you can
// scan the list without leaving the picture. The row under the keyboard cursor expands to add what's next.
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import type { Channel, Program } from '../data';
import ChannelLogo from '../components/ChannelLogo.vue';
import Icon from '../components/Icon.vue';
import { useVirtualList } from '../composables/useVirtualList';
import { now, nowNext, progressOf, epgKey, fmtClock, fmtRemaining, sortKey } from './useUplData';

const ROW_H = 58; // MUST match .upl-rail-row height in CSS — useVirtualList is pure arithmetic on this

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
// Lift the computeds into top-level bindings so the template auto-unwraps them (a plain object's nested refs
// are NOT unwrapped in templates) — same pattern as MappingScreen.vue / EPGDetailScreen.vue.
const vStart = vl.start, vPad = vl.padTop, vTotal = vl.totalHeight;

// The keyboard cursor — separate from what's playing, so you can browse ahead without tuning.
const cursor = ref(0);

// One pass over the visible slice, with the guide summary baked in: the template would otherwise call a
// summary helper five or six times per row on every clock tick.
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

// Tell the parent which guide keys are on screen; it batches/debounces the actual fetch.
watch(sliceRows, (rows) => emit('visibleKeys', rows.map((r) => epgKey(r.ch))), { immediate: true });

// Reset the virtual window when the filter changes the list out from under it.
watch(shown, () => { void nextTick(() => vl.measure()); });
// A reorder moves every index, so the cursor must be re-pinned to what is actually playing. Deliberately NOT
// folded into the watcher above: that one also fires on every filter keystroke, where yanking the cursor back
// to the playing channel would fight the person typing.
watch(sortKey, () => { void nextTick(() => syncCursorToCurrent()); });

// --- keyboard cursor movement, driven by the parent's global keymap ------------------------------------
function move(delta: number): void {
  if (shown.value.length === 0) return;
  cursor.value = Math.min(shown.value.length - 1, Math.max(0, cursor.value + delta));
  // Keep the cursor in view. scrollToIndex puts a row at the TOP, so only nudge when the cursor has
  // actually left the rendered window — otherwise every keypress would jerk the list.
  const first = vl.topIndex();
  const rows = Math.max(1, Math.floor((scroller.value?.clientHeight ?? ROW_H) / ROW_H));
  if (cursor.value < first) vl.scrollToIndex(cursor.value);
  else if (cursor.value >= first + rows) vl.scrollToIndex(cursor.value - rows + 1);
}
function tuneCursor(): void {
  const c = shown.value[cursor.value];
  if (c) emit('tune', c);
}
// Sync the cursor onto whatever is playing whenever the rail opens, so ↑/↓ starts from "here".
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
  <!-- Edge hover target: a thin invisible strip that reveals the rail without any visible furniture. -->
  <div class="upl-rail-edge" @mouseenter="emit('update:open', true)" />

  <aside class="glass upl-rail" :class="{ open }" @mouseleave="emit('update:open', false)">
    <div class="upl-rail-hd">
      <Icon name="tv" :size="14" />
      <span class="upl-rail-count mono">{{ shown.length }}</span>
      <input v-model="filter" class="input upl-rail-search" placeholder="Filter channels…" />
      <!-- Sort toggle. A pressed-state text button rather than a Segmented, mirroring the Playlists screen's
           A-Z button: the rail is only 340px wide and the filter box owns flex:1. -->
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
            <!-- `||`, not `??`: a blank channelNo is unnumbered as far as this rail is concerned (the sort
                 treats it as such), so it reads '—' like a null one instead of leaving a gap in the column. -->
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
              <!-- The cursored row earns one extra line: what's on after this. -->
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
/* A standalone window has no app shell, so this overlay owns its own positioning. */
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
/* Same metrics as the close button, but text-width rather than square (the label is 'A-Z' or '#'). */
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

/* Height is load-bearing: it must equal ROW_H in the script for virtualization to line up. */
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
