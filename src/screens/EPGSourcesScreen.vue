<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';
import Pill from '../components/Pill.vue';
import StatusDot from '../components/StatusDot.vue';
import SearchInput from '../components/SearchInput.vue';
import EpgSyncModal from '../components/EpgSyncModal.vue';
import RowActionsMenu, { type RowActionItem } from '../components/RowActionsMenu.vue';
import EditEpgSourceDrawer from '../components/EditEpgSourceDrawer.vue';
import DeleteEpgSourceModal from '../components/DeleteEpgSourceModal.vue';
import UploadXmlModal from '../components/UploadXmlModal.vue';
import { EPG_SOURCES, epgMetaChips, formatSyncTime, reorderEpgSources, reloadEpgSources, tagNames, type EpgSource } from '../data';
import { useToast } from '../composables/useToast';
import { useEpgActions } from '../composables/useEpgActions';

const emit = defineEmits<{ (e: 'add', k: 'playlist' | 'epg'): void }>();
const router = useRouter();
const toast = useToast();
const { syncingAllEpg, syncAllEpg, syncingIds, syncEpgSource } = useEpgActions();

// ── Per-row waffle menu ──────────────────────────────────────────────────────
// One anchored actions popup per row, one open at a time (tracked by source id). Item set is ROW-SCOPED:
// Sync + Delete only for a standalone, syncable source; 'xml file' swaps Sync → Upload XML; a playlist-bound
// or built-in row shows Edit only (its sync/delete are managed elsewhere / off-limits). Edit is always present.
const openMenuId = ref<string | null>(null);
function toggleMenu(id: string): void {
  openMenuId.value = openMenuId.value === id ? null : id;
}
// Row-scoped surfaces opened from a waffle item (null = closed). Rendered by the screen — the menu unmounts on
// select, so each item's `run` just flips one of these refs.
const editingSource = ref<EpgSource | null>(null);
const deletingSource = ref<EpgSource | null>(null);
const uploadingSource = ref<EpgSource | null>(null);

async function onSync(p: EpgSource): Promise<void> {
  const { ok, offsetDefaulted } = await syncEpgSource(p.id);
  if (ok && offsetDefaulted) {
    toast.lowerRight({
      tone: 'warn',
      title: 'Time zone offset not set',
      text: 'Stored guide times defaulted to UTC (+0000). Set a Time zone in Settings.',
    });
  } else if (!ok) {
    toast.lowerRight({ tone: 'bad', title: 'Sync failed', text: `Could not sync "${p.name}". Please try again.` });
  }
}

function menuItems(p: EpgSource): RowActionItem[] {
  const items: RowActionItem[] = [];
  // Sync + Delete are hidden for playlist-bound (playlist owns the cadence) and built-in (ships preconfigured)
  // rows — they get Edit only. Everyone else gets Sync (or Upload XML for a one-shot 'xml file') + Delete.
  const restricted = !!p.builtin || !!p.playlistBinding;
  if (!restricted) {
    if (p.source === 'xml file') {
      items.push({ key: 'upload', icon: 'upload', label: 'Upload XML', run: () => { uploadingSource.value = p; } });
    } else {
      const syncing = syncingIds.value.has(p.id);
      items.push({ key: 'sync', icon: 'refresh', label: syncing ? 'Syncing…' : 'Sync', disabled: syncing, run: () => { void onSync(p); } });
    }
  }
  items.push({ key: 'edit', icon: 'edit', label: 'Edit', run: () => { editingSource.value = p; } });
  if (!restricted) {
    items.push({ key: 'delete', icon: 'trash', label: 'Delete', danger: true, run: () => { deletingSource.value = p; } });
  }
  return items;
}

function onUploaded(): void {
  void reloadEpgSources();
}

// The list renders straight off the shared EPG_SOURCES store (no local copy), so a scheduled sync or an
// edit made elsewhere only surfaces if we re-pull on entry. Refetch on mount — the screen mounts fresh on
// every nav-in (no <keep-alive>), matching the Playlists screen so moving between them always shows truth.
onMounted(() => { void reloadEpgSources(); });

// ── Sync all ───────────────────────────────────────────────────────────────
// Open the progress modal, which kicks this thunk: a linear (one-at-a-time) sync of every non-playlist-bound
// EPG source via useEpgActions. Returns the failed names so the modal can flag those rows red; a summary toast
// reports the outcome (lowerRight — the EPG screen's toast convention).
const opOpen = ref(false);
async function onSyncAll(): Promise<{ failed: string[] }> {
  if (syncingAllEpg.value) return { failed: [] };
  const { total, failed } = await syncAllEpg();
  if (failed.length) {
    toast.lowerRight({ tone: 'warn', icon: 'warn', title: 'EPG sync', text: `Synced ${total - failed.length}/${total} · failed: ${failed.join(', ')}` });
  } else {
    toast.lowerRight({ tone: 'good', icon: 'sync', title: 'EPG sync', text: `Synced ${total} EPG source${total === 1 ? '' : 's'}` });
  }
  return { failed };
}

// Search filter — case-insensitive substring across name + kind (source) + lineupId + assigned custom tag
// names. Debounced via the shared SearchInput so a large source list doesn't re-filter on every keystroke.
const search = ref('');
const filteredSources = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return EPG_SOURCES.value;
  return EPG_SOURCES.value.filter((p) =>
    [p.name, p.source, p.lineupId, ...tagNames(p.tags)].some((v) => (v || '').toLowerCase().includes(q)),
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
        <Btn variant="ghost" icon="refresh" :disabled="syncingAllEpg" @click="opOpen = true">{{ syncingAllEpg ? 'Syncing…' : 'Sync all' }}</Btn>
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
          </div>
          <div class="epg-meta">
            <span v-for="c in epgMetaChips(p, ['source', 'lineupId'])" :key="c.label" class="meta-item" :title="`${c.label}: ${c.value}`">
              <span class="meta-k">{{ c.label }}:</span>
              <span class="meta-chip">{{ c.value }}</span>
            </span>
            <Pill tone="cyan">{{ (p.interval || '').toLowerCase() }}</Pill>
            <Pill v-if="p.playlistBinding" tone="good">Playlist-bound</Pill>
            <Pill v-for="n in tagNames(p.tags)" :key="n" tone="magenta">{{ n }}</Pill>
          </div>
        </div>
        <div class="stat-mini"><b>{{ p.channels }}</b>channels</div>
        <div class="stat-mini"><b>{{ p.programs.toLocaleString() }}</b>programs</div>
        <div class="stat-mini" style="min-width: 110px;">
          <b style="font-size: 12px; font-weight: 500; color: var(--text-1);">{{ formatSyncTime(p.lastSync) }}</b>
          last sync
        </div>
        <!-- Row actions — the waffle drops into the .src-row grid's spare 6th column (no template change).
             @click.stop keeps the trigger from navigating the row AND satisfies RowActionsMenu's outside-click
             toggle contract. -->
        <div style="position: relative; justify-self: end;" @click.stop>
          <Btn
            variant="cyan"
            size="sm"
            icon="waffle"
            title="Row actions"
            aria-label="Row actions"
            aria-haspopup="menu"
            :aria-expanded="openMenuId === p.id"
            @click="toggleMenu(p.id)"
          />
          <RowActionsMenu
            v-if="openMenuId === p.id"
            :items="menuItems(p)"
            @close="openMenuId = null"
          />
        </div>
      </div>
    </div>
    <EpgSyncModal v-if="opOpen" :run="() => onSyncAll()" @close="opOpen = false" />

    <EditEpgSourceDrawer v-if="editingSource" :source="editingSource" @close="editingSource = null" />
    <DeleteEpgSourceModal
      v-if="deletingSource"
      :source="deletingSource"
      @close="deletingSource = null"
      @deleted="deletingSource = null"
    />
    <UploadXmlModal
      v-if="uploadingSource"
      :source-id="uploadingSource.id"
      :source-name="uploadingSource.name"
      @close="uploadingSource = null"
      @uploaded="onUploaded"
    />
  </div>
</template>
