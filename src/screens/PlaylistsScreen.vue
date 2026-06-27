<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import Btn from '../components/Btn.vue';
import SearchInput from '../components/SearchInput.vue';
import PlaylistRow from '../components/PlaylistRow.vue';
import PlaylistStatusDrawer from '../components/PlaylistStatusDrawer.vue';
import AssignAccessModal from '../components/AssignAccessModal.vue';
import GetAccessModal from '../components/GetAccessModal.vue';
import RowActionsMenu, { type RowActionItem } from '../components/RowActionsMenu.vue';
import PlaylistOpModal, { type OpMode, type OpScope, type OpRunResult } from '../components/PlaylistOpModal.vue';
import { reloadEpgSources, type Playlist, type Channel } from '../data';
import { bus } from '../composables/bus';
import { useToast } from '../composables/useToast';
import { usePlaylistActions } from '../composables/usePlaylistActions';
import { isAdmin } from '../composables/useAuth';

const emit = defineEmits<{ (e: 'add', k: 'playlist' | 'epg'): void }>();
const router = useRouter();
const { banner } = useToast();
const { syncingGlobal, composingGlobal, syncAllGlobal, composeAllGlobal } = usePlaylistActions();

const playlists = ref<Playlist[]>([]);
async function reloadList(): Promise<void> {
  const res = await fetch('/api/playlists');
  if (res.ok) playlists.value = await res.json();
}
onMounted(() => {
  void reloadList();
  // A sign-in/out on Settings flips a playlist's isAuthenticated — re-read so the badge updates live.
  bus.on('tvapp:auth-changed', reloadList);
});
onBeforeUnmount(() => bus.off('tvapp:auth-changed', reloadList));

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
    // Custom-type playlists with a live upstream re-sync via the custom-playlists route: 'hdhomerun' re-fetches
    // the device lineup, 'url' re-fetches the stored remoteUrl m3u. A Default source playlist syncs via the
    // registry source route. (Mirrors PlaylistDetailScreen.syncNow so both entry points converge on one path.)
    const res =
      src === 'hdhomerun' || src === 'url' || src === 'local'
        ? await fetch(`/api/custom-playlists/${encodeURIComponent(p.id)}/sync`, { method: 'POST' })
        : await fetch(`/api/sources/${encodeURIComponent(src)}/sync`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    // Reload the local playlist list AND the shared EPG store — a source sync's afterSync hook can
    // create/refresh EPG sources (dlhd/tubi self-EPG), which otherwise stay invisible until a page refresh.
    await Promise.all([reloadList(), reloadEpgSources().catch(() => {})]);
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

// Global cohort: "Sync Global" / "Compose Global" on a Global row fan out across EVERY Global playlist
// (shared singleton state, so all Global buttons disable together and all Global rows show one bar).
// Custom rows keep the per-id behavior above. `isCustom` selects which busy source a row reads.
const isCustom = (p: Playlist): boolean => p.endpoint === 'custom';
// Only custom types with a LIVE upstream that "Sync" can re-fetch surface a Sync action: 'url' (the stored
// remoteUrl m3u), 'hdhomerun' (the device lineup), and 'local' (a Local Now market re-fetch). 'file'/legacy
// 'import'/'clone' have no upstream, so a Sync there would only ever 500 — they show Compose only.
const SYNCABLE_CUSTOM = new Set(['url', 'hdhomerun', 'local']);
const isSyncableCustom = (p: Playlist): boolean => !!p.source && SYNCABLE_CUSTOM.has(p.source);

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

// Rows grouped by source TYPE, headers shown alphabetically (built-in / clone / file / hdhomerun / url, plus
// legacy 'import' only if such rows exist). The group key mirrors PlaylistRow's source-type chip: a registry
// built-in (id === source) → "built-in", otherwise the stored `source` (a source-unset row falls into
// "other"). Only non-empty groups are emitted.
const groupedPlaylists = computed<{ key: string; items: Playlist[] }[]>(() => {
  const m = new Map<string, Playlist[]>();
  for (const p of playlists.value) {
    const key = p.builtin ? 'built-in' : p.source ?? 'other';
    let bucket = m.get(key);
    if (!bucket) m.set(key, (bucket = []));
    bucket.push(p);
  }
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, items]) => ({ key, items }));
});

// Returns { failed } (the names of global playlists whose sync errored) so the sync-mode PlaylistOpModal can
// settle those rows red while marking the rest done.
async function onSyncGlobal(): Promise<OpRunResult> {
  if (syncingGlobal.value) return { failed: [] };
  const { total, failed } = await syncAllGlobal();
  await reloadList();
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
  if (p.source && !isCustom(p)) {
    items.push({ key: 'sync', icon: 'refresh', label: syncingGlobal.value ? 'Syncing…' : 'Sync Global', disabled: syncingGlobal.value, run: () => { openOpModal('sync', { kind: 'global' }, () => onSyncGlobal()); } });
    items.push({ key: 'compose', icon: 'file', label: composingGlobal.value ? 'Composing…' : 'Compose Global', disabled: composingGlobal.value, run: () => { openOpModal('compose', { kind: 'global' }, () => onComposeGlobal()); } });
  } else if (p.source === 'clone') {
    items.push({ key: 'compose', icon: 'file', label: composingIds.value.has(p.id) ? 'Composing…' : 'Compose', disabled: composingIds.value.has(p.id), run: () => { openOpModal('compose', { kind: 'custom', id: p.id, name: p.name }, () => composeRow(p)); } });
  } else if (p.source) {
    // Other custom types (url/hdhomerun/file/legacy import). Only 'url'/'hdhomerun' have a live upstream to
    // sync; 'file'/'import' have none, so they show Compose only (like a clone) — a Sync would only ever 500.
    if (isSyncableCustom(p)) {
      items.push({ key: 'sync', icon: 'refresh', label: syncingIds.value.has(p.id) ? 'Syncing…' : 'Sync', disabled: syncingIds.value.has(p.id), run: () => { openOpModal('sync', { kind: 'custom', id: p.id, name: p.name }, () => syncRow(p)); } });
    }
    items.push({ key: 'compose', icon: 'file', label: composingIds.value.has(p.id) ? 'Composing…' : 'Compose', disabled: composingIds.value.has(p.id), run: () => { openOpModal('compose', { kind: 'custom', id: p.id, name: p.name }, () => composeRow(p)); } });
  }
  items.push({ key: 'edit', icon: 'edit', label: 'Edit', run: () => { void editRow(p); } });
  return items;
}

// Admin-only access surfaces — a Users × playlists assignment matrix ("Assign access") and a unified
// published-URL view across every user ("Get access"). Both reuse the shared USERS singleton, so changes
// here and on the Users screen stay in lockstep. Non-admins never see the buttons.
const assignOpen = ref(false);
const getOpen = ref(false);

// Merge a persisted edit (drawer PUT) back into the matching list row — no full refetch needed.
function onPlaylistUpdated(patch: Partial<Playlist>): void {
  const id = editPlaylist.value?.id;
  if (!id) return;
  playlists.value = playlists.value.map((p) => p.id === id ? { ...p, ...patch } : p);
  editPlaylist.value = { ...editPlaylist.value!, ...patch };
}
</script>

<template>
  <div class="col">
    <div class="card flush">
      <div class="toolbar">
        <SearchInput :value="''" @change="() => {}" placeholder="Search playlists" />
        <span class="spacer" />
        <Btn v-if="isAdmin" variant="ghost" icon="lock" @click="assignOpen = true">Assign access</Btn>
        <Btn v-if="isAdmin" variant="ghost" icon="link" @click="getOpen = true">Get access</Btn>
        <Btn variant="primary" icon="plus" @click="emit('add', 'playlist')">Add playlist</Btn>
      </div>
      <template v-for="g in groupedPlaylists" :key="g.key">
        <div class="pl-group-hdr">{{ g.key }}</div>
        <PlaylistRow v-for="p in g.items" :key="p.id" :playlist="p" grouped @open="router.push(`/playlists/${p.id}`)">
          <template #actions>
            <Btn
              variant="ghost"
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

    <AssignAccessModal v-if="assignOpen" @close="assignOpen = false" />
    <GetAccessModal v-if="getOpen" @close="getOpen = false" />

    <PlaylistOpModal
      v-if="opOpen && opScope && opRun"
      :mode="opMode"
      :scope="opScope"
      :run="opRun"
      @close="opOpen = false"
    />
  </div>
</template>
