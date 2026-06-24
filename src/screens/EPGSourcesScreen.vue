<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';
import Pill from '../components/Pill.vue';
import StatusDot from '../components/StatusDot.vue';
import SearchInput from '../components/SearchInput.vue';
import { EPG_SOURCES, epgMetaChips, formatSyncTime, reorderEpgSources } from '../data';
import { useToast } from '../composables/useToast';

const emit = defineEmits<{ (e: 'add', k: 'playlist' | 'epg'): void }>();
const router = useRouter();
const toast = useToast();

// Search filter — case-insensitive substring across name + kind (source) + lineupId. Debounced via the
// shared SearchInput so a large source list doesn't re-filter on every keystroke.
const search = ref('');
const filteredSources = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return EPG_SOURCES.value;
  return EPG_SOURCES.value.filter((p) =>
    [p.name, p.source, p.lineupId].some((v) => (v || '').toLowerCase().includes(q)),
  );
});

// ── Drag-to-reorder (native HTML5 DnD) ─────────────────────────────────────
// Rows are reorderable only when no search filter is active — reordering a filtered subset would be
// ambiguous against the persisted full-list ordinals. `dragIndex` is the row being dragged; `overIndex`
// is the current drop target (drives the snap insertion-line styling). `dragMoved` suppresses the row's
// click→navigate when a drag just finished (HTML5 DnD fires a click on the source element on drop).
const canReorder = computed(() => !search.value.trim());
const dragIndex = ref<number | null>(null);
const overIndex = ref<number | null>(null);
const dragMoved = ref(false);

function onDragStart(i: number, e: DragEvent) {
  if (!canReorder.value) return;
  dragIndex.value = i;
  dragMoved.value = false;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    // A payload is required for the drag to initiate in some browsers (Firefox).
    e.dataTransfer.setData('text/plain', String(i));
  }
}

function onDragOver(i: number, e: DragEvent) {
  if (dragIndex.value === null) return;
  e.preventDefault(); // allow the drop
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  if (i !== overIndex.value) overIndex.value = i;
  if (i !== dragIndex.value) dragMoved.value = true;
}

async function onDrop(i: number) {
  const from = dragIndex.value;
  reset();
  if (from === null || from === i) return;
  // Build the new id sequence by moving `from` to `i` within the full (unfiltered) list, then persist.
  const ids = EPG_SOURCES.value.map((s) => s.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(i, 0, moved);
  try {
    await reorderEpgSources(ids); // optimistic snap + persist + reconcile (see data.ts)
  } catch {
    toast.lowerRight({ tone: 'bad', title: 'Reorder failed', text: 'Could not save the new order. Please try again.' });
  }
}

function reset() {
  dragIndex.value = null;
  overIndex.value = null;
}

// Navigate on row click — but swallow the synthetic click that follows a drag.
function openSource(id: string) {
  if (dragMoved.value) {
    dragMoved.value = false;
    return;
  }
  router.push(`/epg-sources/${id}`);
}
</script>

<template>
  <div class="col">
    <div class="card flush">
      <div class="toolbar">
        <SearchInput :value="search" @change="(v) => search = v" :debounce="200" placeholder="Search EPG sources" />
        <span class="spacer" />
        <Btn variant="ghost" icon="refresh">Sync all</Btn>
        <Btn variant="primary" icon="plus" @click="emit('add', 'epg')">Add EPG source</Btn>
      </div>
      <div
        v-for="(p, i) in filteredSources"
        :key="p.id"
        class="src-row"
        :class="{ 'drag-source': dragIndex === i, 'drag-over': overIndex === i && dragIndex !== i }"
        :draggable="canReorder"
        @dragstart="onDragStart(i, $event)"
        @dragover="onDragOver(i, $event)"
        @drop="onDrop(i)"
        @dragend="reset"
        @click="openSource(p.id)"
      >
        <span
          v-if="canReorder"
          class="drag-grip"
          title="Drag to reorder"
          @click.stop
        >
          <Icon name="grip" :size="16" />
        </span>
        <div :class="['src-ico', 'epg-glow', { builtin: p.builtin, 'epg-builtin': p.builtin }]" style="color: var(--good);">
          <Icon :name="p.builtin ? 'tv' : 'epg'" :size="18" />
        </div>
        <div>
          <div class="src-name">
            <StatusDot :status="p.status" :pulse="p.status === 'good'" />
            {{ p.name }}
            <Pill v-if="p.builtin" tone="system"><Icon name="check" :size="10" />built-in</Pill>
            <Pill tone="cyan">{{ (p.interval || '').toLowerCase() }}</Pill>
            <Pill v-if="p.playlistBinding" tone="good">Playlist-bound</Pill>
          </div>
          <div class="epg-meta">
            <span v-for="c in epgMetaChips(p, ['source', 'lineupId'])" :key="c.label" class="meta-item" :title="`${c.label}: ${c.value}`">
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
      </div>
    </div>
  </div>
</template>
