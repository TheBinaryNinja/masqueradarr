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
import { PLAYLISTS, reloadEpgSources, reloadPlaylists, setPlaylistPinned, reorderPlaylistPins, reorderPlaylistCategory, type Playlist, type Channel } from '../data';
import { bus } from '../composables/bus';
import { useToast } from '../composables/useToast';
import { usePlaylistActions, hasLiveUpstream, isGlobalScope, syncRequestUrl } from '../composables/usePlaylistActions';
import { isAdmin } from '../composables/useAuth';
import { playlistsAlphaSort } from '../composables/useSettings';

const emit = defineEmits<{ (e: 'add', k: 'playlist' | 'epg'): void }>();
const router = useRouter();
const { banner } = useToast();
const { syncingGlobal, composingGlobal, syncAllGlobal, composeAllGlobal } = usePlaylistActions();

// The list renders straight off the shared PLAYLISTS store — the single source of truth the Dashboard, nav
// count, and Users copyable URLs also read — so a sync/edit here or a scheduled sync elsewhere stays
// coherent everywhere with no local copy to drift. reloadPlaylists() re-pulls /api/playlists into the store.
const playlists = computed(() => PLAYLISTS.value);
onMounted(() => {
  void reloadPlaylists();
  // A sign-in/out on Settings flips a playlist's isAuthenticated — re-read so the badge updates live.
  bus.on('tvapp:auth-changed', reloadPlaylists);
});
onBeforeUnmount(() => bus.off('tvapp:auth-changed', reloadPlaylists));

// Per-row actions mirror the detail header (Sync / Compose / Edit). In-flight state is tracked per
// playlist id (Sets) so one row's request never disables or spins the others.
const syncingIds = ref(new Set<string>());
const composingIds = ref(new Set<string>());

// Returns { failed } (the playlist name when the sync errored) so the sync-mode PlaylistOpModal can settle
// this row red. The direct callers ignore the return; only the modal reads it.
async function syncRow(p: Playlist): Promise<OpRunResult> {
  const src = p.source;
  if (!src || syncingIds.value.has(p.id)) return { failed: [] };
  syncingIds.value = new Set(syncingIds.value).add(p.id);
  let ok = true;
  try {
    // Route by TYPE via the shared syncRequestUrl: a custom import with a live upstream ('url'/'hdhomerun'/
    // 'local') re-syncs via the custom-playlists route; a Default source playlist via its registry source
    // route. Endpoint-independent — a built-in stays syncable when set Custom, a 'url' when set Global.
    const res = await fetch(syncRequestUrl(p), { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    // Reload the shared playlist store AND the shared EPG store — a source sync's afterSync hook can
    // create/refresh EPG sources (dlhd/tubi self-EPG), which otherwise stay invisible until a page refresh.
    await Promise.all([reloadPlaylists(), reloadEpgSources().catch(() => {})]);
    // The custom-playlists sync returns { channels }; the source sync returns { count } — read either.
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

// Scope (endpoint) and upstream-capability (type) are the two orthogonal axes the row menu gates on; both
// predicates are imported from usePlaylistActions so the list, the detail header, and the Global cohort
// fan-out share ONE definition (hasLiveUpstream / isGlobalScope). "Sync Global" / "Compose Global" on a
// Global row fan out across EVERY Global playlist via the shared singleton (all Global buttons disable
// together and all Global rows show one bar).

// Op preview modal — clicking "Sync" / "Sync Global" / "Compose" / "Compose Global" no longer fires the op
// silently; it opens the shared PlaylistOpModal. In 'sync' mode it shows the scoped playlist list + each
// one's sync progress/status; in 'compose' mode it shows the users (grouped by access) + per-user compose
// progress. The modal OWNS running the op via the `run` thunk it's handed (the existing syncRow / composeRow
// / onSyncGlobal / onComposeGlobal handlers, unchanged), so the toast + reload behavior is preserved.
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

// Search filter — case-insensitive substring across name + source (type). Debounced via the shared
// SearchInput. The whole list (pinned + type groups) is filtered off this; an empty query passes through.
const search = ref('');
const visiblePlaylists = computed<Playlist[]>(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return playlists.value;
  return playlists.value.filter((p) => [p.name, p.source].some((v) => (v || '').toLowerCase().includes(q)));
});

// Rows grouped by source TYPE, headers shown alphabetically (built-in / clone / file / hdhomerun / url, plus
// legacy 'import' only if such rows exist). The group key mirrors PlaylistRow's source-type chip: a registry
// built-in (id === source) → "built-in", otherwise the stored `source` (a source-unset row falls into
// "other"). Only non-empty groups are emitted.
// Pinned rows render in a dedicated PINNED section (above the type groups), ordered by their drag-reorder
// ordinal. They're pulled OUT of the type grouping below while pinned (e.g. pinning a clone empties it from
// the CLONE group and surfaces it under PINNED). The PINNED section is inherently manual — the A-Z toggle
// never touches it.
const pinnedPlaylists = computed<Playlist[]>(() =>
  visiblePlaylists.value.filter((p) => p.pinned).sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0)),
);

// Order rows WITHIN one source-type category. A-Z toggle ON → alphabetical by name. OFF → the manual `order`
// ordinal (ascending); rows without an `order` (never dragged / freshly added) sink to the BOTTOM, tie-broken
// by name. The toggle (playlistsAlphaSort) is the shared, Settings-persisted preference.
function sortCategory(items: Playlist[]): Playlist[] {
  const byName = (a: Playlist, b: Playlist) => a.name.localeCompare(b.name);
  if (playlistsAlphaSort.value) return [...items].sort(byName);
  return [...items].sort((a, b) => {
    const ao = a.order;
    const bo = b.order;
    if (ao == null && bo == null) return byName(a, b);
    if (ao == null) return 1; // unordered rows sink to the bottom
    if (bo == null) return -1;
    return ao - bo || byName(a, b);
  });
}

const groupedPlaylists = computed<{ key: string; items: Playlist[] }[]>(() => {
  const m = new Map<string, Playlist[]>();
  for (const p of visiblePlaylists.value) {
    if (p.pinned) continue; // pinned rows live in the PINNED section, not their source-type group
    const key = p.builtin ? 'built-in' : p.source ?? 'other';
    let bucket = m.get(key);
    if (!bucket) m.set(key, (bucket = []));
    bucket.push(p);
  }
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, items]) => ({ key, items: sortCategory(items) }));
});

// Render order: the PINNED section first (only when non-empty), then the alphabetical type groups. EVERY
// section is drag-reorderable now — a single PlaylistRow block (one #actions slot) serves them all; onRowDrop
// routes by the section key (pinned → reorder pins; a category → reorder its `order` + flip A-Z off).
const allGroups = computed<{ key: string; items: Playlist[] }[]>(() =>
  pinnedPlaylists.value.length
    ? [{ key: 'pinned', items: pinnedPlaylists.value }, ...groupedPlaylists.value]
    : groupedPlaylists.value,
);

// ── Pin toggle + drag-to-reorder (every section) ───────────────────────────
// Pin/unpin flips the shared store via setPlaylistPinned (PUT + reload). Reorder mirrors the EPG Sources
// native-HTML5 DnD, generalized to every section: `dragKey` is the section being dragged (a group key or
// 'pinned'), `dragIndex` the row within it, `overIndex` the drop target (drives the insertion-line styling),
// `dragMoved` suppresses the row's click→navigate after a drop. Reorder is disabled while a search filter is
// active — reordering a filtered subset is ambiguous against the persisted full-category ordinals.
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
    e.dataTransfer.setData('text/plain', String(i)); // a payload is required to start the drag in some browsers
  }
}

function onRowDragOver(key: string, i: number, e: DragEvent): void {
  if (dragIndex.value === null || dragKey.value !== key) return; // only react within the SAME section
  e.preventDefault(); // allow the drop
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  if (i !== overIndex.value) overIndex.value = i;
  if (i !== dragIndex.value) dragMoved.value = true;
}

async function onRowDrop(key: string, items: Playlist[], i: number): Promise<void> {
  const from = dragIndex.value;
  const sameSection = dragKey.value === key; // a cross-section drop is a no-op (can't move between categories)
  resetDrag();
  if (from === null || !sameSection || from === i) return;
  // Move `from` to `i` within this section's id sequence (as rendered — equals the full category because drag
  // is disabled during search), then persist. Route by section: the PINNED section reorders pins; a type
  // category reorders its `order` AND flips the A-Z toggle off (a manual move can't coexist with auto-sort).
  const ids = items.map((p) => p.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(i, 0, moved);
  try {
    if (key === 'pinned') {
      await reorderPlaylistPins(ids);
    } else {
      playlistsAlphaSort.value = false; // set BEFORE persist so the optimistic snap shows the new manual order
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

// Navigate on a row click — but swallow the synthetic click HTML5 DnD fires on the source after a drop.
function onRowOpen(id: string): void {
  if (dragMoved.value) {
    dragMoved.value = false;
    return;
  }
  router.push(`/playlists/${id}`);
}

// Returns { failed } (the names of global playlists whose sync errored) so the sync-mode PlaylistOpModal can
// settle those rows red while marking the rest done.
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

// Edit opens the same PlaylistStatusDrawer the detail screen uses. The list doesn't carry per-row
// channels, so fetch them on demand for the drawer's EPG/category summaries.
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

// Per-row "waffle" popup: the old inline Sync/Compose/Edit cluster collapsed into one anchored menu, one
// open at a time (tracked by playlist id). The item set is ROW-SCOPED but the handlers are UNCHANGED — a
// global row shows the cohort-wide "Sync Global"/"Compose Global" (still fanning out across every Global
// playlist via the shared singleton), a clone shows Compose only (no source to sync), other custom rows
// show per-id Sync + Compose; Edit is always last. Live inflight/disabled state mirrors the old buttons.
const openMenuId = ref<string | null>(null);
function toggleMenu(id: string): void {
  openMenuId.value = openMenuId.value === id ? null : id;
}

function rowMenuItems(p: Playlist): RowActionItem[] {
  const items: RowActionItem[] = [];
  if (p.source) {
    // Two orthogonal axes. Sync availability follows TYPE (a live upstream), independent of scope — its key is
    // 'sync-one' so it never collides with the 'sync' (Sync Global) item on a Global row.
    if (hasLiveUpstream(p)) {
      items.push({ key: 'sync-one', icon: 'refresh', label: syncingIds.value.has(p.id) ? 'Syncing…' : 'Sync', disabled: syncingIds.value.has(p.id), run: () => { openOpModal('sync', { kind: 'custom', id: p.id, name: p.name }, () => syncRow(p)); } });
    }
    // Scope follows ENDPOINT. Global → the cohort-wide Sync Global / Compose Global (fan out across every
    // Global playlist via the shared singleton). Custom → this playlist's standalone Compose.
    if (isGlobalScope(p)) {
      items.push({ key: 'sync', icon: 'refresh', label: syncingGlobal.value ? 'Syncing…' : 'Sync Global', disabled: syncingGlobal.value, run: () => { openOpModal('sync', { kind: 'global' }, () => onSyncGlobal()); } });
      items.push({ key: 'compose', icon: 'file', label: composingGlobal.value ? 'Composing…' : 'Compose Global', disabled: composingGlobal.value, run: () => { openOpModal('compose', { kind: 'global' }, () => onComposeGlobal()); } });
    } else {
      items.push({ key: 'compose', icon: 'file', label: composingIds.value.has(p.id) ? 'Composing…' : 'Compose', disabled: composingIds.value.has(p.id), run: () => { openOpModal('compose', { kind: 'custom', id: p.id, name: p.name }, () => composeRow(p)); } });
    }
  }
  // Admin-only per-playlist access surfaces, scoped to THIS playlist. `run` only sets a screen-level ref — the
  // modals are rendered by the screen (the menu unmounts on select). A Global row's Assign/Get shows the shared
  // Global-union access/URLs; a Custom row shows its own.
  if (isAdmin.value) {
    items.push({ key: 'assign', icon: 'lock', label: 'Assign access', run: () => { assignAccessPlaylist.value = p; } });
    items.push({ key: 'getaccess', icon: 'link', label: 'Get access', run: () => { getAccessPlaylist.value = p; } });
  }
  items.push({ key: 'edit', icon: 'edit', label: 'Edit', run: () => { void editRow(p); } });
  // Delete — impact-aware confirm (a built-in shows an affected-areas report before the cascade). Same
  // DELETE /api/playlists/:id path the detail uses; the row disappears when the shared PLAYLISTS store reloads.
  items.push({ key: 'delete', icon: 'trash', label: 'Delete', danger: true, run: () => { deletePlaylistRow.value = p; } });
  return items;
}

// Admin-only per-playlist access surfaces, opened from a row's waffle menu and scoped to THAT playlist
// (null = closed). Owned/rendered by the screen — NOT the menu, which unmounts on select. Both reuse the
// shared USERS singleton, so changes here and on the Users screen stay in lockstep.
const assignAccessPlaylist = ref<Playlist | null>(null);
const getAccessPlaylist = ref<Playlist | null>(null);
// Impact-aware delete confirm, scoped to the row whose waffle opened it (null = closed). Rendered by the
// screen (the menu unmounts on select); the shared DeletePlaylistModal owns the DELETE + store reloads, so
// the row drops out on success with no extra work here.
const deletePlaylistRow = ref<Playlist | null>(null);

// Keep the drawer's own bound row in step with each optimistic edit; the list rows and every other screen
// update via the shared PLAYLISTS store, which the drawer's save() re-pulls (canonical) after the PUT.
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
