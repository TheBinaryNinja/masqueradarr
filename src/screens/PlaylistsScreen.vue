<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import Btn from '../components/Btn.vue';
import SearchInput from '../components/SearchInput.vue';
import PlaylistRow from '../components/PlaylistRow.vue';
import PlaylistStatusDrawer from '../components/PlaylistStatusDrawer.vue';
import AssignAccessModal from '../components/AssignAccessModal.vue';
import GetAccessModal from '../components/GetAccessModal.vue';
import DeletePlaylistModal from '../components/DeletePlaylistModal.vue';
import RowActionsMenu, { type RowActionItem } from '../components/RowActionsMenu.vue';
import PlaylistOpModal, { type OpMode, type OpScope, type OpRunResult } from '../components/PlaylistOpModal.vue';
import { PLAYLISTS, reloadEpgSources, reloadPlaylists, setPlaylistPinned, reorderPlaylistPins, reorderPlaylistCategory, tagNames, type Playlist, type Channel } from '../data';
import { bus } from '../composables/bus';
import { useToast } from '../composables/useToast';
import { usePlaylistActions, hasLiveUpstream, isGlobalScope, syncRequestUrl } from '../composables/usePlaylistActions';
import { isAdmin } from '../composables/useAuth';
import { playlistsAlphaSort } from '../composables/useSettings';
import { openUltimatePlayer } from '../composables/uplLaunch';

const emit = defineEmits<{ (e: 'add', k: 'playlist' | 'epg'): void }>();
const router = useRouter();
const { banner } = useToast();
const { syncingGlobal, composingGlobal, syncAllGlobal, composeAllGlobal } = usePlaylistActions();

const playlists = computed(() => PLAYLISTS.value);
onMounted(() => {
  void reloadPlaylists();
  bus.on('tvapp:auth-changed', reloadPlaylists);
});
onBeforeUnmount(() => bus.off('tvapp:auth-changed', reloadPlaylists));

const syncingIds = ref(new Set<string>());
const composingIds = ref(new Set<string>());

async function syncRow(p: Playlist): Promise<OpRunResult> {
  const src = p.source;
  if (!src || syncingIds.value.has(p.id)) return { failed: [] };
  syncingIds.value = new Set(syncingIds.value).add(p.id);
  let ok = true;
  try {
    const res = await fetch(syncRequestUrl(p), { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    await Promise.all([reloadPlaylists(), reloadEpgSources().catch(() => {})]);
    const cnt = result.count ?? result.channels ?? '';
    banner({ text: `Synced ${cnt} channels${result.live === false ? ' (snapshot)' : ''}`.trim(), tone: 'good', icon: 'sync' });
  } catch (err) {
    ok = false;
    banner({ text: `Sync failed: ${(err as Error).message}`, tone: 'bad', icon: 'warn' });
  } finally {
    const n = new Set(syncingIds.value); n.delete(p.id); syncingIds.value = n;
  }
  return { failed: ok ? [] : [p.name] };
}

async function composeRow(p: Playlist): Promise<void> {
  if (!p.source || composingIds.value.has(p.id)) return;
  composingIds.value = new Set(composingIds.value).add(p.id);
  try {
    const res = await fetch(`/api/playlists/${encodeURIComponent(p.id)}/compose`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    const n = result.channels ?? 0;
    banner({ text: `Composed ${n} channel${n === 1 ? '' : 's'} → ${result.endpoint}`, tone: 'good', icon: 'file' });
  } catch (err) {
    banner({ text: `Compose failed: ${(err as Error).message}`, tone: 'bad', icon: 'warn' });
  } finally {
    const n = new Set(composingIds.value); n.delete(p.id); composingIds.value = n;
  }
}


const opOpen = ref(false);
const opMode = ref<OpMode>('compose');
const opScope = ref<OpScope | null>(null);
const opRun = ref<(() => Promise<OpRunResult | void> | void) | null>(null);
function openOpModal(mode: OpMode, scope: OpScope, run: () => Promise<OpRunResult | void> | void): void {
  opMode.value = mode;
  opScope.value = scope;
  opRun.value = run;
  opOpen.value = true;
}

const search = ref('');
const visiblePlaylists = computed<Playlist[]>(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return playlists.value;
  return playlists.value.filter((p) =>
    [p.name, p.source, ...tagNames(p.tags)].some((v) => (v || '').toLowerCase().includes(q)),
  );
});

const pinnedPlaylists = computed<Playlist[]>(() =>
  visiblePlaylists.value.filter((p) => p.pinned).sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0)),
);

function sortCategory(items: Playlist[]): Playlist[] {
  const byName = (a: Playlist, b: Playlist) => a.name.localeCompare(b.name);
  if (playlistsAlphaSort.value) return [...items].sort(byName);
  return [...items].sort((a, b) => {
    const ao = a.order;
    const bo = b.order;
    if (ao == null && bo == null) return byName(a, b);
    if (ao == null) return 1;
    if (bo == null) return -1;
    return ao - bo || byName(a, b);
  });
}

const groupedPlaylists = computed<{ key: string; items: Playlist[] }[]>(() => {
  const m = new Map<string, Playlist[]>();
  for (const p of visiblePlaylists.value) {
    if (p.pinned) continue;
    const key = p.builtin ? 'built-in' : p.source ?? 'other';
    let bucket = m.get(key);
    if (!bucket) m.set(key, (bucket = []));
    bucket.push(p);
  }
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, items]) => ({ key, items: sortCategory(items) }));
});

const allGroups = computed<{ key: string; items: Playlist[] }[]>(() =>
  pinnedPlaylists.value.length
    ? [{ key: 'pinned', items: pinnedPlaylists.value }, ...groupedPlaylists.value]
    : groupedPlaylists.value,
);

const canReorder = computed(() => !search.value.trim());
const dragKey = ref<string | null>(null);
const dragIndex = ref<number | null>(null);
const overIndex = ref<number | null>(null);
const dragMoved = ref(false);

async function togglePin(p: Playlist): Promise<void> {
  try {
    await setPlaylistPinned(p.id, !p.pinned);
  } catch {
    banner({ text: 'Could not update pin', tone: 'bad', icon: 'warn' });
  }
}

function onRowDragStart(key: string, i: number, e: DragEvent): void {
  if (!canReorder.value) return;
  dragKey.value = key;
  dragIndex.value = i;
  dragMoved.value = false;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i));
  }
}

function onRowDragOver(key: string, i: number, e: DragEvent): void {
  if (dragIndex.value === null || dragKey.value !== key) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  if (i !== overIndex.value) overIndex.value = i;
  if (i !== dragIndex.value) dragMoved.value = true;
}

async function onRowDrop(key: string, items: Playlist[], i: number): Promise<void> {
  const from = dragIndex.value;
  const sameSection = dragKey.value === key;
  resetDrag();
  if (from === null || !sameSection || from === i) return;
  const ids = items.map((p) => p.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(i, 0, moved);
  try {
    if (key === 'pinned') {
      await reorderPlaylistPins(ids);
    } else {
      playlistsAlphaSort.value = false;
      await reorderPlaylistCategory(ids);
    }
  } catch {
    banner({ text: 'Could not save the new order. Please try again.', tone: 'bad', icon: 'warn' });
  }
}

function resetDrag(): void {
  dragKey.value = null;
  dragIndex.value = null;
  overIndex.value = null;
}

function onRowOpen(id: string): void {
  if (dragMoved.value) {
    dragMoved.value = false;
    return;
  }
  router.push(`/playlists/${id}`);
}

async function onSyncGlobal(): Promise<OpRunResult> {
  if (syncingGlobal.value) return { failed: [] };
  const { total, failed } = await syncAllGlobal();
  await reloadPlaylists();
  if (failed.length) banner({ text: `Synced ${total - failed.length}/${total} global playlists · failed: ${failed.join(', ')}`, tone: 'warn', icon: 'warn' });
  else banner({ text: `Synced ${total} global playlist${total === 1 ? '' : 's'}`, tone: 'good', icon: 'sync' });
  return { failed };
}

async function onComposeGlobal(): Promise<void> {
  if (composingGlobal.value) return;
  const { total, failed } = await composeAllGlobal();
  if (failed.length) banner({ text: `Composed ${total - failed.length}/${total} global playlists · failed: ${failed.join(', ')}`, tone: 'warn', icon: 'warn' });
  else banner({ text: `Composed ${total} global playlist${total === 1 ? '' : 's'}`, tone: 'good', icon: 'file' });
}

const statusOpen = ref(false);
const editPlaylist = ref<Playlist | null>(null);
const editChannels = ref<Channel[]>([]);

async function editRow(p: Playlist): Promise<void> {
  editPlaylist.value = p;
  editChannels.value = [];
  statusOpen.value = true;
  const res = await fetch(`/api/playlists/${encodeURIComponent(p.id)}/channels`);
  if (res.ok) editChannels.value = await res.json();
}

const openMenuId = ref<string | null>(null);
function toggleMenu(id: string): void {
  openMenuId.value = openMenuId.value === id ? null : id;
}

function rowMenuItems(p: Playlist): RowActionItem[] {
  const items: RowActionItem[] = [];
  if (p.source) {
    if (hasLiveUpstream(p)) {
      items.push({ key: 'sync-one', icon: 'refresh', label: syncingIds.value.has(p.id) ? 'Syncing…' : 'Sync', disabled: syncingIds.value.has(p.id), run: () => { openOpModal('sync', { kind: 'custom', id: p.id, name: p.name }, () => syncRow(p)); } });
    }
    if (isGlobalScope(p)) {
      items.push({ key: 'sync', icon: 'refresh', label: syncingGlobal.value ? 'Syncing…' : 'Sync Global', disabled: syncingGlobal.value, run: () => { openOpModal('sync', { kind: 'global' }, () => onSyncGlobal()); } });
      items.push({ key: 'compose', icon: 'file', label: composingGlobal.value ? 'Composing…' : 'Compose Global', disabled: composingGlobal.value, run: () => { openOpModal('compose', { kind: 'global' }, () => onComposeGlobal()); } });
    } else {
      items.push({ key: 'compose', icon: 'file', label: composingIds.value.has(p.id) ? 'Composing…' : 'Compose', disabled: composingIds.value.has(p.id), run: () => { openOpModal('compose', { kind: 'custom', id: p.id, name: p.name }, () => composeRow(p)); } });
    }
  }
  if (isAdmin.value) {
    items.push({ key: 'assign', icon: 'lock', label: 'Assign access', run: () => { assignAccessPlaylist.value = p; } });
    items.push({ key: 'getaccess', icon: 'link', label: 'Get access', run: () => { getAccessPlaylist.value = p; } });
  }
  items.push({ key: 'edit', icon: 'edit', label: 'Edit', run: () => { void editRow(p); } });
  items.push({ key: 'delete', icon: 'trash', label: 'Delete', danger: true, run: () => { deletePlaylistRow.value = p; } });
  return items;
}

const assignAccessPlaylist = ref<Playlist | null>(null);
const getAccessPlaylist = ref<Playlist | null>(null);
const deletePlaylistRow = ref<Playlist | null>(null);

function onPlaylistUpdated(patch: Partial<Playlist>): void {
  if (!editPlaylist.value) return;
  editPlaylist.value = { ...editPlaylist.value, ...patch };
}
</script>

<template>
  <div class="col">
    <div class="card flush">
      <div class="toolbar">
        <SearchInput :value="search" @change="(v) => (search = v)" :debounce="200" placeholder="Search playlists" />
        <Btn
          variant="ghost"
          :class="['az-btn', { 'is-active': playlistsAlphaSort }]"
          :aria-pressed="playlistsAlphaSort ? 'true' : 'false'"
          title="Sort A–Z within each category"
          @click="playlistsAlphaSort = !playlistsAlphaSort"
        >A–Z</Btn>
        <span class="spacer" />
        <Btn variant="primary" icon="plus" @click="emit('add', 'playlist')">Add playlist</Btn>
      </div>
      <template v-for="g in allGroups" :key="g.key">
        <div class="pl-group-hdr" :class="{ pinned: g.key === 'pinned' }">{{ g.key }}</div>
        <PlaylistRow
          v-for="(p, i) in g.items"
          :key="p.id"
          :playlist="p"
          grouped
          :reorderable="canReorder"
          :draggable="canReorder || undefined"
          :class="dragKey === g.key ? { 'drag-source': dragIndex === i, 'drag-over': overIndex === i && dragIndex !== i } : undefined"
          @dragstart="onRowDragStart(g.key, i, $event)"
          @dragover="onRowDragOver(g.key, i, $event)"
          @drop="onRowDrop(g.key, g.items, i)"
          @dragend="resetDrag"
          @open="onRowOpen(p.id)"
        >
          <template #actions>
            <Btn
              size="sm"
              variant="ghost"
              :icon="p.pinned ? 'pin-solid' : 'pin'"
              :title="p.pinned ? 'Unpin' : 'Pin'"
              :aria-label="p.pinned ? 'Unpin playlist' : 'Pin playlist'"
              :aria-pressed="p.pinned ? 'true' : 'false'"
              :class="['pin-btn', { 'is-pinned': p.pinned }]"
              @click="togglePin(p)"
            />
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
              :items="rowMenuItems(p)"
              @close="openMenuId = null"
            />
          </template>
        </PlaylistRow>
      </template>
    </div>

    <PlaylistStatusDrawer
      v-if="statusOpen && editPlaylist"
      :playlist="editPlaylist"
      :channels="editChannels"
      @updated="onPlaylistUpdated"
      @close="statusOpen = false"
    />

    <AssignAccessModal v-if="assignAccessPlaylist" :playlist="assignAccessPlaylist" @close="assignAccessPlaylist = null" />
    <GetAccessModal v-if="getAccessPlaylist" :playlist="getAccessPlaylist" @close="getAccessPlaylist = null" />
    <DeletePlaylistModal v-if="deletePlaylistRow" :playlist="deletePlaylistRow" @close="deletePlaylistRow = null" @deleted="deletePlaylistRow = null" />

    <PlaylistOpModal
      v-if="opOpen && opScope && opRun"
      :mode="opMode"
      :scope="opScope"
      :run="opRun"
      @close="opOpen = false"
    />
  </div>
</template>
