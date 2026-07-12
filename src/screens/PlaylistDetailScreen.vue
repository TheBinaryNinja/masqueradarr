<script setup lang="ts">
import { ref, computed, inject, watch, watchEffect, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';
import Pill from '../components/Pill.vue';
import Checkbox from '../components/Checkbox.vue';
import StatusDot from '../components/StatusDot.vue';
import Segmented from '../components/Segmented.vue';
import SearchInput from '../components/SearchInput.vue';
import ChannelLogo from '../components/ChannelLogo.vue';
import ChannelBulkDrawer from '../components/ChannelBulkDrawer.vue';
import PlaylistStatusDrawer from '../components/PlaylistStatusDrawer.vue';
import Stat from '../components/Stat.vue';
import ProgressBar from '../components/ProgressBar.vue';
import PlaylistOpModal, { type OpMode, type OpScope, type OpRunResult } from '../components/PlaylistOpModal.vue';
import RowActionsMenu, { type RowActionItem } from '../components/RowActionsMenu.vue';
import GroupConfigModal from '../components/GroupConfigModal.vue';
import { PLAYLISTS, CUSTOM_PLAYLISTS, GROUPS_BY_PLAYLIST, playlistScheduleLabel, reloadCustomPlaylists, reloadPlaylists, reloadEpgSources, reloadChannels, reloadGroups, disbandFailoverGroup, deleteChannels as apiDeleteChannels, type Playlist, type Channel, type CustomPlaylist, type FailoverGroupResult } from '../data';
import { useToast } from '../composables/useToast';
import { usePlaylistActions } from '../composables/usePlaylistActions';
import { bus } from '../composables/bus';

const { banner } = useToast();
const router = useRouter();
const route = useRoute();
const { syncingGlobal, composingGlobal, globalSyncProgress, globalComposeProgress, syncAllGlobal, composeAllGlobal } = usePlaylistActions();

const props = defineProps<{ id: string }>();
const openChannel = inject<(c: Channel) => void>('openChannel')!;

const PLACEHOLDER: Playlist = {
  id: '', name: '…', url: '', channels: 0, groups: 0,
  lastSync: '', status: 'good', auto: false, interval: '',
};
// The header row is derived from the shared PLAYLISTS store — the SAME source of truth the list, Dashboard,
// nav count, and Users copyable URLs read — so an edit (this screen or the status drawer), a scheduled sync,
// or a domain change surfaces here without a full page reload. The channel LIST below stays a local fetch
// (per-playlist detail, not held in the shared store). reload() refreshes both.
const playlist = computed<Playlist>(() => PLAYLISTS.value.find((p) => p.id === props.id) ?? PLACEHOLDER);

// Live human-readable schedule labels, derived from the playlist's two cron jobs (never the stored
// interval): targetType 'playlist' = Sync schedule, 'playlist-m3u' = Compose-m3u schedule. Each reads
// 'Manual' when no job exists (or a source-less playlist), so the chips always reflect the real schedule.
const scheduleLabel = computed(() => playlistScheduleLabel(playlist.value.id, 'playlist'));
const m3uLabel = computed(() => playlistScheduleLabel(playlist.value.id, 'playlist-m3u'));

// A "clone" is a user-composed custom playlist (Playlist row with source==='clone'). Per the clone-from
// rule it can't be cloned/appended FROM, so the Create/Append actions are hidden on its detail screen.
const isClone = computed(() => playlist.value.source === 'clone');
// Clones carry interval 'none' → no Sync schedule chip, Custom endpoint only (see PlaylistStatusDrawer). They
// DO get a Compose-m3u schedule though, so the M3U chip is shown for a clone regardless of `noSchedule` (its
// label reads 'manual' until a schedule is set). Case-insensitive so a pre-normalization 'None' row still hides
// the Sync chip before the boot migration runs.
const noSchedule = computed(() => (playlist.value.interval ?? '').toLowerCase() === 'none');
// Custom-type playlists with a LIVE upstream "Sync" can re-fetch: 'url' (the stored remoteUrl m3u),
// 'hdhomerun' (the device lineup), and 'local' (a Local Now market re-fetch). 'file'/legacy 'import' have no
// upstream, so the header Sync button is suppressed for them (it would only ever 500) — they keep Compose only.
const isSyncableCustom = computed(() => {
  const s = playlist.value.source;
  return s === 'url' || s === 'hdhomerun' || s === 'local';
});

// Delete a playlist — BOTH user-composed (clone/import) AND built-in (Default) source playlists are now
// deletable. The backend cascades: a clone drops its channels + per-user m3u files + access-list refs; a
// built-in additionally prunes its copies out of every clone (by `origin`) and removes its playlist-bound
// EPG source. For a built-in we first fetch a real affected-areas report (GET /:id/delete-impact) and show it
// in the confirm modal so the operator sees exactly what is removed before confirming.
interface DeleteImpact {
  playlist: { id: string; name: string; channels: number };
  affectedClones: { id: string; name: string; channelsRemoved: number }[];
  boundEpgSource: { id: string; name: string } | null;
}
const confirmDelete = ref(false);
const deleting = ref(false);
const impact = ref<DeleteImpact | null>(null);
const impactLoading = ref(false);
const impactError = ref(false);

// Open the delete confirmation. For a built-in, fetch the affected-areas report first (a brief spinner in the
// modal while it loads); a clone uses the generic checklist (no impact fetch). A failed/non-ok preview is
// surfaced (impactError + a toast) and the modal renders an explicit "preview unavailable" notice — the
// Delete button stays gated so the operator can never confirm the destructive cascade blind.
async function openDelete() {
  impact.value = null;
  impactError.value = false;
  confirmDelete.value = true;
  if (!playlist.value.builtin) return;
  impactLoading.value = true;
  try {
    const res = await fetch(`/api/playlists/${encodeURIComponent(playlist.value.id)}/delete-impact`);
    if (res.ok) impact.value = await res.json();
    else impactError.value = true; // a non-ok (400/403/404) never enters catch — flag it here
  } catch {
    impactError.value = true;
  } finally {
    impactLoading.value = false;
    if (impactError.value) {
      banner({ text: 'Could not calculate affected areas', tone: 'bad', icon: 'warn' });
    }
  }
}

async function deletePlaylist() {
  const p = playlist.value;
  if (!p.id || deleting.value) return;
  deleting.value = true;
  const name = p.name;
  const wasBuiltin = !!p.builtin;
  try {
    const res = await fetch(`/api/playlists/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    // A built-in delete prunes clone copies + drops a bound EPG source — refresh the channel union and EPG
    // store too so other screens reflect the cascade without a full reload.
    await Promise.all([
      reloadPlaylists(),
      reloadCustomPlaylists(),
      wasBuiltin ? reloadChannels().catch(() => {}) : Promise.resolve(),
      wasBuiltin ? reloadEpgSources().catch(() => {}) : Promise.resolve(),
    ]);
    confirmDelete.value = false;
    banner({ text: `Deleted "${name}"`, tone: 'good', icon: 'trash' });
    router.push('/playlists');
  } catch (e) {
    banner({ text: `Delete failed: ${(e as Error).message}`, tone: 'bad', icon: 'warn' });
  } finally {
    deleting.value = false;
  }
}

const view = ref<'table' | 'grid'>('table');
// State filter (orthogonal to the table/grid view): defaults to Active so a channel list always opens
// showing only Active channels. Filters on the top-level 'Active' | 'Disabled' governor (playlistchannels.status).
const stateFilter = ref<'Active' | 'Disabled'>('Active');
// Channel-list sort key (the toolbar Segmented to the right of the group filter): by name (default),
// channel number, or group. Applied AFTER the state/group/search filters, in both Table and Grid views.
const sortBy = ref<'name' | 'channelNo' | 'group'>('name');
const search = ref('');
const group = ref('all');
const selected = ref<Set<string>>(new Set());
const editingId = ref<string | null>(null);
const channels = ref<Channel[]>([]);

// Whenever a different playlist is opened, default the state filter back to Active (each time a
// channel list is displayed it should start on Active).
watch(() => props.id, () => { stateFilter.value = 'Active'; });

// Nav-in load: refresh the shared playlist store (fresh header row) + THIS playlist's channel list. Re-runs
// whenever the route id changes (tracked via props.id here); reload() writes only the store + channels, so it
// never re-triggers this effect.
watchEffect(() => {
  if (!props.id) return;
  void reload();
  void reloadGroups(props.id).catch(() => {});
});
const customAction = ref<null | 'create' | 'append'>(null);
const customPlaylists = ref<CustomPlaylist[]>([]);
watch(CUSTOM_PLAYLISTS, (v) => { customPlaylists.value = [...v]; }, { immediate: true });
const bulkOpen = ref(false);
const statusOpen = ref(false);
const lastSelectedId = ref<string | null>(null);

// A dulo sign-in/out on Settings flips this playlist's isAuthenticated server-side — re-pull the shared
// store so the header auth badge (derived from it) updates without a manual refresh. (A drawer edit is
// handled by the drawer's own save() → reloadPlaylists, so this screen needs no @updated listener.)
async function onAuthChanged() {
  if (!props.id) return;
  await reloadPlaylists();
}
// A parent's EPG edit in the App-level ChannelDrawer cascaded to its children server-side — merge the
// returned children into this screen's LOCAL list so the group stays coherent without a refetch.
function onFailoverCascade(p: { source: string; children: Channel[] }) {
  if (p.source !== props.id || !p.children.length) return;
  const byId = new Map(p.children.map((k) => [k.id, k]));
  channels.value = channels.value.map((c) => byId.get(c.id) ?? c);
}
// A single channel was hard-deleted in the App-level ChannelDrawer's Remove — drop it from the LOCAL list.
function onChannelsDeleted(p: { source: string; ids: string[] }) {
  if (p.source !== props.id || !p.ids.length) return;
  const dead = new Set(p.ids);
  channels.value = channels.value.filter((c) => !dead.has(c.id));
  if (selected.value.size) {
    const n = new Set(selected.value);
    for (const id of p.ids) n.delete(id);
    selected.value = n;
  }
}
onMounted(() => {
  bus.on('tvapp:auth-changed', onAuthChanged);
  bus.on('tvapp:failover-cascade', onFailoverCascade);
  bus.on('tvapp:channels-deleted', onChannelsDeleted);
  bus.on('tvapp:group-changed', onGroupChanged);
});
onBeforeUnmount(() => {
  bus.off('tvapp:auth-changed', onAuthChanged);
  bus.off('tvapp:failover-cascade', onFailoverCascade);
  bus.off('tvapp:channels-deleted', onChannelsDeleted);
  bus.off('tvapp:group-changed', onGroupChanged);
  if (flashTimer) clearTimeout(flashTimer);
});

// ── Deep-link focus: global search lands here with ?focus=<channelId>. Scroll the row into view + flash it.
// The row that carries the transient .flash highlight (a dedicated ref, NOT the `selected` set, so focusing
// never arms the bulk toolbar).
const focusId = ref<string | null>(null);
let flashTimer: number | null = null;

function focusChannel(id: string) {
  const ch = channels.value.find((c) => c.id === id);
  if (!ch) return;
  // Relax the filters so the target actually renders — the list defaults to Active, and a group/search filter
  // could otherwise hide it (filteredView filters on stateFilter + group + search).
  group.value = 'all';
  search.value = '';
  stateFilter.value = ch.status as 'Active' | 'Disabled';
  void nextTick(() => {
    const el = document.querySelector(`[data-channel-id="${id}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    focusId.value = id;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => { focusId.value = null; }, 2200);
  });
}

// Fire once the channels have loaded (the watch tracks both the query and the local list), then clear the
// query so a refresh / back-nav doesn't re-trigger the flash.
watch(
  [() => route.query.focus, channels],
  ([f]) => {
    const id = typeof f === 'string' ? f : Array.isArray(f) ? f[0] : null;
    if (!id || !channels.value.some((c) => c.id === id)) return;
    focusChannel(id);
    void router.replace({ query: {} });
  },
  { immediate: true },
);

// ── Failover group modal + tree ───────────────────────────────────────────
const groupOpen = ref(false);
// Failover-group tree state: which groups are collapsed (empty ⇒ all expanded), which parent row's actions
// menu is open, and the parent whose group the Edit-group modal is scoped to (so the per-row "Edit group"
// path doesn't clobber the multi-select `selected` set that the toolbar "Group" button relies on).
const collapsedGroups = ref<Set<string>>(new Set());
const openGroupMenuId = ref<string | null>(null);
const editGroupAnchor = ref<Channel | null>(null);
function isCollapsed(gid: string | null | undefined): boolean {
  return !!gid && collapsedGroups.value.has(gid);
}
function toggleCollapse(gid: string | null | undefined) {
  if (!gid) return;
  const n = new Set(collapsedGroups.value);
  if (n.has(gid)) n.delete(gid); else n.add(gid);
  collapsedGroups.value = n;
}

function onGroupSaved(r: FailoverGroupResult) {
  const byId = new Map([r.parent, ...r.children].map((m) => [m.id, m]));
  channels.value = channels.value.map((c) => (byId.get(c.id) ?? c));
  banner({ text: `Failover group saved · ${r.children.length} backup${r.children.length === 1 ? '' : 's'} behind "${r.parent.tvg_name}"`, tone: 'good', icon: 'check' });
  groupOpen.value = false;
  editGroupAnchor.value = null;
  selected.value = new Set();
  // The save can also mutate rows OUTSIDE the returned group: members dropped from it, foreign children
  // moved in (their donor group possibly auto-disbanded server-side). The merge above keeps the UI snappy;
  // this authoritative refetch reconciles everything else.
  void reload();
}
// Local patch shared by the modal's Disband and the per-row "Disband group": clear the three failover
// fields on every member of the group and drop any stale collapsed-state for it.
function applyDisbandLocal(gid: string) {
  channels.value = channels.value.map((c) =>
    c.failoverGroupId === gid ? { ...c, failoverGroupId: null, failoverRole: null, failoverOrder: null } : c,
  );
  if (collapsedGroups.value.has(gid)) {
    const n = new Set(collapsedGroups.value);
    n.delete(gid);
    collapsedGroups.value = n;
  }
}
function onGroupDisbanded(gid: string) {
  applyDisbandLocal(gid);
  banner({ text: 'Failover group disbanded — children re-enter the export', tone: 'good', icon: 'trash' });
  groupOpen.value = false;
  editGroupAnchor.value = null;
  selected.value = new Set();
}

// Per-parent-row actions (waffle menu). "Edit group" opens the existing GroupConfigModal scoped to this
// group via editGroupAnchor (the modal back-fills the rest of the group from :all-channels); "Disband
// group" clears the whole group in place. Both reuse the existing data-layer + merge handlers.
function groupMenuItems(parent: Channel): RowActionItem[] {
  return [
    { key: 'edit', icon: 'link', label: 'Edit group', run: () => { editGroupAnchor.value = parent; groupOpen.value = true; } },
    { key: 'disband', icon: 'trash', label: 'Disband group', danger: true, run: () => { void disbandGroupFromRow(parent); } },
  ];
}
async function disbandGroupFromRow(parent: Channel) {
  const gid = parent.failoverGroupId;
  if (!gid) return;
  try {
    await disbandFailoverGroup(props.id, gid);
    applyDisbandLocal(gid);
    banner({ text: 'Failover group disbanded — children re-enter the export', tone: 'good', icon: 'trash' });
  } catch (err) {
    banner({ text: `Disband failed: ${(err as Error).message}`, tone: 'bad', icon: 'warn' });
  }
}

function onRowClick(c: Channel, e: MouseEvent) {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey) {
    selectRange(c.id);
    lastSelectedId.value = c.id;
    return;
  }
  if (mod) {
    toggleSel(c.id);
    lastSelectedId.value = c.id;
    return;
  }
  if (selected.value.size >= 2) bulkOpen.value = true;
  else openChannel(c);
}

function selectRange(toId: string) {
  const ids = filtered.value.map((c) => c.id);
  const toIdx = ids.indexOf(toId);
  if (toIdx < 0) return;
  const fromIdx = lastSelectedId.value ? ids.indexOf(lastSelectedId.value) : -1;
  const startIdx = fromIdx < 0 ? toIdx : Math.min(fromIdx, toIdx);
  const endIdx = Math.max(fromIdx < 0 ? toIdx : fromIdx, toIdx);
  const n = new Set(selected.value);
  for (let i = startIdx; i <= endIdx; i++) n.add(ids[i]);
  selected.value = n;
}

async function applyBulk(payload: { status?: string; group?: string; clearEpg?: boolean; playerPref?: number | null }) {
  if (!payload.status && !payload.group && !payload.clearEpg && payload.playerPref === undefined) {
    bulkOpen.value = false;
    return;
  }
  const ids = selected.value;
  const n = ids.size;
  const targets = channels.value.filter((c) => ids.has(c.id));
  const supportsPlayer = (c: Channel) => ['dlhd'].includes(c.origin ?? c.source);
  // The persisted PUT body: status/group pass through; clearEpg unlinks the 2-factor EPG link (tvg_id + epg
  // → null) and flips epgState to 'unmatched' (mirrors DELETE /api/epg-sources/:id's unlink). playerPref sets
  // the DaddyLive player override (null = Auto/inherit); it's stripped per-channel below for non-DaddyLive sources.
  const body: Record<string, unknown> = {};
  if (payload.status) body.status = payload.status;
  if (payload.group) body.group = payload.group;
  if (payload.clearEpg) { body.tvg_id = null; body.epg = null; body.epgState = 'unmatched'; }
  if (payload.playerPref !== undefined) body.playerPref = payload.playerPref;
  // Failover CHILDREN mirror their parent's EPG — the server rejects an EPG write on them with a 409 that
  // discards the WHOLE patch. Strip the clearEpg keys from a child's body (its link follows the parent),
  // and skip its PUT entirely when nothing else changed.
  const bodyFor = (c: Channel): Record<string, unknown> => {
    let b = body;
    if (payload.clearEpg && c.failoverRole === 'child') {
      const { tvg_id: _t, epg: _e, epgState: _s, ...rest } = b;
      b = rest;
    }
    // playerPref only means anything on DaddyLive-family channels — strip it elsewhere so a mixed selection
    // doesn't store a dead field (and a channel with nothing else to change is skipped below).
    if (payload.playerPref !== undefined && !supportsPlayer(c)) {
      const { playerPref: _p, ...rest } = b;
      b = rest;
    }
    return b;
  };
  // Persist each channel edit (PUT /api/playlists/<source>/channels/<id>), then update locally.
  await Promise.all(
    targets.map((c) => {
      const chBody = bodyFor(c);
      if (!Object.keys(chBody).length) return Promise.resolve(undefined);
      return fetch(`/api/playlists/${encodeURIComponent(c.source)}/channels/${encodeURIComponent(c.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chBody),
      }).catch(() => undefined);
    }),
  );
  channels.value = channels.value.map((c) =>
    ids.has(c.id)
      ? {
          ...c,
          ...(payload.status ? { status: payload.status } : {}),
          ...(payload.group ? { group: payload.group } : {}),
          ...(payload.clearEpg && c.failoverRole !== 'child'
            ? { tvg_id: null, epg: null, epgState: 'unmatched' as const }
            : {}),
          ...(payload.playerPref !== undefined && supportsPlayer(c) ? { playerPref: payload.playerPref } : {}),
        }
      : c
  );
  const parts: string[] = [];
  if (payload.status) parts.push(`status → ${payload.status}`);
  if (payload.group) parts.push(`group → ${payload.group}`);
  if (payload.clearEpg) parts.push('EPG match removed');
  if (payload.playerPref !== undefined) parts.push(`player → ${payload.playerPref === null ? 'Auto' : payload.playerPref}`);
  banner({ text: `Updated ${n} channel${n === 1 ? '' : 's'} · ${parts.join(', ')}`, tone: 'good', icon: 'edit' });
  bulkOpen.value = false;
  selected.value = new Set();
}

// A group was renamed/deleted across the WHOLE playlist via the shared GroupManager — either the bulk editor
// (rendered on this screen) or the App-level single-channel drawer (over this screen). GroupManager already
// ran the data-layer op (which patched the global CHANNELS union + the registry store); patch this screen's
// LOCAL channel list to match and fix the active group filter so the table + filter stay coherent without a
// refetch. Deleting keeps the channels — only their group assignment is cleared.
function onGroupChanged(
  p:
    | { source: string; kind: 'rename'; oldName: string; newName: string }
    | { source: string; kind: 'delete'; name: string },
) {
  if (p.source !== props.id) return;
  if (p.kind === 'rename') {
    channels.value = channels.value.map((c) => (c.group === p.oldName ? { ...c, group: p.newName } : c));
    if (group.value === p.oldName) group.value = p.newName;
    banner({ text: `Renamed group "${p.oldName}" → "${p.newName}"`, tone: 'good', icon: 'edit' });
  } else {
    const n = channels.value.filter((c) => c.group === p.name).length;
    channels.value = channels.value.map((c) => (c.group === p.name ? { ...c, group: null } : c));
    if (group.value === p.name) group.value = 'all';
    banner({ text: `Deleted group "${p.name}"${n ? ` from ${n} channel${n === 1 ? '' : 's'}` : ''}`, tone: 'good', icon: 'trash' });
  }
}

// Hard-delete the selected channels (bulk-editor "Delete N channels"). Tombstoned server-side so a re-sync
// won't re-add them; patch the LOCAL list, clear the selection, close the drawer.
async function onDeleteChannels(ids: string[]) {
  if (!ids.length) { bulkOpen.value = false; return; }
  try {
    await apiDeleteChannels(props.id, ids);
    const dead = new Set(ids);
    channels.value = channels.value.filter((c) => !dead.has(c.id));
    banner({ text: `Deleted ${ids.length} channel${ids.length === 1 ? '' : 's'}`, tone: 'good', icon: 'trash' });
  } catch (e) {
    banner({ text: `Delete failed: ${(e as Error).message}`, tone: 'bad', icon: 'warn' });
  }
  bulkOpen.value = false;
  selected.value = new Set();
}

// Live sync for (Default) source playlists: re-runs the source adapter on the server, upserts the
// channels, and refreshes this view. Built-in channels are EMPTY until this first runs (nothing is
// seeded at boot) and persist in Mongo thereafter.
const syncing = ref(false);
const playlistSource = computed(() => playlist.value.source ?? null);

async function reload() {
  // Header row via the shared store (reloadPlaylists → /api/playlists); the channel list is this playlist's
  // own fetch (not held in the shared store). Run both together.
  const [, cRes] = await Promise.all([
    reloadPlaylists(),
    fetch(`/api/playlists/${encodeURIComponent(props.id)}/channels`),
  ]);
  if (cRes.ok) channels.value = await cRes.json();
}
// Returns { failed } (the playlist name when the sync errored) so the sync-mode PlaylistOpModal can settle
// the single row red. The direct callers ignore the return; only the modal reads it.
async function syncNow(): Promise<OpRunResult> {
  const src = playlistSource.value;
  if (!src || syncing.value) return { failed: [] };
  syncing.value = true;
  const name = playlist.value.name;
  let ok = true;
  try {
    // Custom-type playlists with a live upstream re-sync via the custom-playlists route: 'hdhomerun' re-fetches
    // the device lineup, 'url' re-fetches the stored remoteUrl m3u. A Default source playlist syncs via the
    // registry source route.
    const res =
      src === 'hdhomerun' || src === 'url' || src === 'local'
        ? await fetch(`/api/custom-playlists/${encodeURIComponent(props.id)}/sync`, { method: 'POST' })
        : await fetch(`/api/sources/${encodeURIComponent(src)}/sync`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    // Reload this playlist AND the shared EPG store — a source sync's afterSync hook can create/refresh
    // EPG sources (dlhd/tubi self-EPG), which otherwise stay invisible until a full browser refresh.
    await Promise.all([reload(), reloadEpgSources().catch(() => {})]);
    const n = result.count ?? result.channels ?? '';
    banner({ text: `Synced ${n} channels${result.live === false ? ' (snapshot)' : ''}`.trim(), tone: 'good', icon: 'sync' });
  } catch (err) {
    ok = false;
    banner({ text: `Sync failed: ${(err as Error).message}`, tone: 'bad', icon: 'warn' });
  } finally {
    syncing.value = false;
  }
  return { failed: ok ? [] : [name] };
}

// (Re)compose this playlist's stream-ready m3u export on demand — the manual twin of the `playlist-m3u`
// cron schedule (both hit composeM3u server-side). Source-backed (Default) playlists only.
const composing = ref(false);
async function composeNow() {
  if (!playlistSource.value || composing.value) return;
  composing.value = true;
  try {
    const res = await fetch(`/api/playlists/${encodeURIComponent(props.id)}/compose`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    const n = result.channels ?? 0;
    banner({ text: `Composed ${n} channel${n === 1 ? '' : 's'} → ${result.endpoint}`, tone: 'good', icon: 'file' });
  } catch (err) {
    banner({ text: `Compose failed: ${(err as Error).message}`, tone: 'bad', icon: 'warn' });
  } finally {
    composing.value = false;
  }
}

// Global cohort: a Global playlist's header buttons are "Sync Global" / "Compose Global" and fan out
// across EVERY Global playlist (shared singleton state, so the buttons stay in lockstep with the list
// screen). Custom playlists keep the single-playlist syncNow/composeNow above. `isCustom` selects which
// busy source the header reads — Custom → local booleans (indeterminate), Global → shared determinate.
const isCustom = computed(() => playlist.value.endpoint === 'custom');
const headerBusy = computed(() =>
  isCustom.value ? syncing.value || composing.value : syncingGlobal.value || composingGlobal.value,
);
const headerProgress = computed<number | null>(() => {
  if (isCustom.value) return null; // single op → indeterminate
  if (syncingGlobal.value) return globalSyncProgress.value;
  if (composingGlobal.value) return globalComposeProgress.value;
  return null;
});

// Returns { failed } (the names of global playlists whose sync errored) so the sync-mode PlaylistOpModal can
// settle those rows red while marking the rest done.
async function onSyncGlobal(): Promise<OpRunResult> {
  if (syncingGlobal.value) return { failed: [] };
  const { total, failed } = await syncAllGlobal();
  await reload();
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

// Op preview modal — the header Sync / Sync Global / Compose / Compose m3u / Compose Global buttons open the
// shared PlaylistOpModal. In 'sync' mode it lists the scoped playlist(s) + each one's sync progress/status;
// in 'compose' mode it lists the users (grouped by access) + per-user compose progress. The modal runs the
// op itself via the `run` thunk (the existing syncNow / composeNow / onSyncGlobal / onComposeGlobal handlers),
// so the toast + reload behavior is unchanged.
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

// Header actions, collapsed into the waffle popover menu. Faithfully ports the former inline button cluster:
// the Global cohort gets a single Sync + the cohort-wide Sync Global / Compose Global; a clone gets manual
// Compose m3u; a syncable custom playlist gets Sync (live upstream only) + Compose; Edit and Delete are
// always present. Each run() calls the same openOpModal / statusOpen / openDelete path the buttons used, so
// toast / reload / modal behavior is unchanged. The computed recomputes on the inflight refs, so the
// labels/disabled stay live while the menu is open.
const menuOpen = ref(false);
const headerMenuItems = computed<RowActionItem[]>(() => {
  const p = playlist.value;
  const items: RowActionItem[] = [];
  if (playlistSource.value && !isCustom.value) {
    items.push({
      key: 'sync', icon: 'refresh', disabled: syncing.value, label: syncing.value ? 'Syncing…' : 'Sync',
      run: () => { openOpModal('sync', { kind: 'custom', id: p.id, name: p.name }, () => syncNow()); },
    });
    items.push({
      key: 'sync-global', icon: 'refresh', disabled: syncingGlobal.value, label: syncingGlobal.value ? 'Syncing…' : 'Sync Global',
      run: () => { openOpModal('sync', { kind: 'global' }, () => onSyncGlobal()); },
    });
    items.push({
      key: 'compose-global', icon: 'file', disabled: composingGlobal.value, label: composingGlobal.value ? 'Composing…' : 'Compose Global',
      run: () => { openOpModal('compose', { kind: 'global' }, () => onComposeGlobal()); },
    });
  } else if (isClone.value) {
    items.push({
      key: 'compose', icon: 'file', disabled: composing.value, label: composing.value ? 'Composing…' : 'Compose m3u',
      run: () => { openOpModal('compose', { kind: 'custom', id: p.id, name: p.name }, () => composeNow()); },
    });
  } else if (playlistSource.value) {
    if (isSyncableCustom.value) {
      items.push({
        key: 'sync', icon: 'refresh', disabled: syncing.value, label: syncing.value ? 'Syncing…' : 'Sync',
        run: () => { openOpModal('sync', { kind: 'custom', id: p.id, name: p.name }, () => syncNow()); },
      });
    }
    items.push({
      key: 'compose', icon: 'file', disabled: composing.value, label: composing.value ? 'Composing…' : 'Compose',
      run: () => { openOpModal('compose', { kind: 'custom', id: p.id, name: p.name }, () => composeNow()); },
    });
  }
  items.push({ key: 'edit', icon: 'edit', label: 'Edit', run: () => { statusOpen.value = true; } });
  if (p.id) {
    items.push({
      key: 'delete', icon: 'trash', label: 'Delete', danger: true, disabled: deleting.value,
      run: () => { void openDelete(); },
    });
  }
  return items;
});

// The filtered + sorted rows, then CLUSTERED into a failover tree: each parent keeps its sorted slot and is
// immediately followed by its failoverOrder-sorted children (unless the group is collapsed). `nestedIds`
// marks the child rows placed under a present parent (indent + connector); `childCounts` is the visible
// backup count per parent id (always equals the nested rows shown). A child whose parent is filtered out
// falls through as a normal, un-nested row.
const filteredView = computed(() => {
  const rows = channels.value.filter((c) =>
    c.status === stateFilter.value &&
    (group.value === 'all' || c.group === group.value) &&
    (search.value === '' || c.tvg_name.toLowerCase().includes(search.value.toLowerCase()))
  );
  // Sort by the selected key. channelNo is a user-editable string (may be numeric or null) — compare it
  // numerically when both sides parse, else lexically, with nulls last; name/group are plain string sorts.
  const byName = (a: Channel, b: Channel) => a.tvg_name.localeCompare(b.tvg_name);
  const sorted = [...rows];
  if (sortBy.value === 'name') {
    sorted.sort(byName);
  } else if (sortBy.value === 'group') {
    sorted.sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || byName(a, b));
  } else {
    sorted.sort((a, b) => {
      const an = a.channelNo, bn = b.channelNo;
      if (an == null && bn == null) return byName(a, b);
      if (an == null) return 1;
      if (bn == null) return -1;
      const af = parseFloat(an), bf = parseFloat(bn);
      const bothNum = !Number.isNaN(af) && !Number.isNaN(bf);
      return (bothNum ? af - bf : an.localeCompare(bn)) || byName(a, b);
    });
  }
  // Cluster failover groups over the sorted list.
  const childrenByGroup = new Map<string, Channel[]>();
  const parentPresent = new Set<string>();
  for (const c of sorted) {
    if (c.failoverGroupId && c.failoverRole === 'parent') parentPresent.add(c.failoverGroupId);
    if (c.failoverGroupId && c.failoverRole === 'child') {
      const arr = childrenByGroup.get(c.failoverGroupId);
      if (arr) arr.push(c); else childrenByGroup.set(c.failoverGroupId, [c]);
    }
  }
  for (const arr of childrenByGroup.values()) arr.sort((a, b) => (a.failoverOrder ?? 0) - (b.failoverOrder ?? 0));
  const treeRows: Channel[] = [];
  const nestedIds = new Set<string>();
  const childCounts = new Map<string, number>();
  for (const c of sorted) {
    // A child whose parent is present is emitted under that parent below — don't also place it here.
    if (c.failoverRole === 'child' && c.failoverGroupId && parentPresent.has(c.failoverGroupId)) continue;
    treeRows.push(c);
    if (c.failoverRole === 'parent' && c.failoverGroupId) {
      const kids = childrenByGroup.get(c.failoverGroupId) ?? [];
      if (kids.length) childCounts.set(c.id, kids.length);
      if (kids.length && !collapsedGroups.value.has(c.failoverGroupId)) {
        for (const k of kids) { treeRows.push(k); nestedIds.add(k.id); }
      }
    }
  }
  return { rows: treeRows, nestedIds, childCounts };
});
// `filtered` stays a flat Channel[] in tree order so every existing consumer (selection range/all, the
// count pill, both v-for loops) is unchanged; the tree metadata rides alongside on `filteredView`.
const filtered = computed(() => filteredView.value.rows);

const selectedChannels = computed(() => channels.value.filter((c) => selected.value.has(c.id)));

// Header channel count — value "<active> / <disabled>" (active cyan, disabled amber) with the total
// folded into the Stat label as "Channels (<total>)". Derived from the loaded channels' top-level
// Active/Disabled governor (status), not the API-computed playlist.channels total.
const activeCount = computed(() => channels.value.filter((c) => c.status === 'Active').length);
const disabledCount = computed(() => channels.value.filter((c) => c.status === 'Disabled').length);
const totalCount = computed(() => channels.value.length);

// Group filter options — the first-class group registry (GROUPS_BY_PLAYLIST) unioned with any group name
// present on a loaded channel (a belt-and-suspenders safety net for a channel whose group predates a registry
// reconcile). Empty groups (zero channels) DO appear here, which is the point of the registry.
const groupOptions = computed(() => {
  const s = new Set<string>((GROUPS_BY_PLAYLIST.value[props.id] ?? []).map((g) => g.name));
  for (const c of channels.value) if (c.group) s.add(c.group);
  return [...s].sort();
});

function toggleSel(id: string) {
  const n = new Set(selected.value);
  if (n.has(id)) n.delete(id); else n.add(id);
  selected.value = n;
  lastSelectedId.value = id;
}
function toggleAll() {
  if (selected.value.size === filtered.value.length) selected.value = new Set();
  else selected.value = new Set(filtered.value.map((c) => c.id));
}
function rename(id: string, name: string) {
  channels.value = channels.value.map((c) => c.id === id ? { ...c, tvg_name: name } : c);
}
function onRenameBlur(id: string, e: FocusEvent) {
  rename(id, (e.target as HTMLInputElement).value);
  editingId.value = null;
}
function onRenameKey(id: string, e: KeyboardEvent) {
  if (e.key === 'Enter') { rename(id, (e.target as HTMLInputElement).value); editingId.value = null; }
  if (e.key === 'Escape') editingId.value = null;
}

// Create modal state. A clone's id/url/path are derived SERVER-side from the name (non-alphanumerics
// stripped, collision-disambiguated), so the modal collects only the name; `previewId` mirrors the server's
// sanitize for a live "served at" preview.
const createName = ref('My Custom Playlist');
const previewId = computed(() => createName.value.trim().replace(/[^a-zA-Z0-9]/g, '') || 'clone');
const canSubmitCreate = computed(() => createName.value.trim().length > 0);
const creating = ref(false);

function openCreate() {
  createName.value = 'My Custom Playlist';
  customAction.value = 'create';
}
// POST /api/custom-playlists — create a clone from the selected source channels (copied server-side).
async function doCreate() {
  if (!canSubmitCreate.value || creating.value) return;
  creating.value = true;
  const name = createName.value.trim();
  const channelIds = selectedChannels.value.map((c) => c.id);
  try {
    const res = await fetch('/api/custom-playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, channelIds }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    await Promise.all([reloadCustomPlaylists(), reloadPlaylists()]);
    banner({ text: `Created "${name}" · ${channelIds.length} channel${channelIds.length === 1 ? '' : 's'}`, tone: 'good', icon: 'plus' });
    customAction.value = null;
    selected.value = new Set();
  } catch (err) {
    banner({ text: `Create failed: ${(err as Error).message}`, tone: 'bad', icon: 'warn' });
  } finally {
    creating.value = false;
  }
}

// Append modal state
const targetId = ref('');
const appending = ref(false);
function openAppend() {
  targetId.value = customPlaylists.value[0]?.id || '';
  customAction.value = 'append';
}
const target = computed(() => customPlaylists.value.find((p) => p.id === targetId.value));
const newTotal = computed(() => target.value ? target.value.channels + selectedChannels.value.length : 0);
// PUT /api/custom-playlists/:id — append the selected source channels to an existing clone.
async function doAppend() {
  if (!target.value || appending.value) return;
  appending.value = true;
  const name = target.value.name;
  const appendChannelIds = selectedChannels.value.map((c) => c.id);
  try {
    const res = await fetch(`/api/custom-playlists/${encodeURIComponent(target.value.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appendChannelIds }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    await Promise.all([reloadCustomPlaylists(), reloadPlaylists()]);
    banner({ text: `Appended ${appendChannelIds.length} channel${appendChannelIds.length === 1 ? '' : 's'} to "${name}"`, tone: 'good', icon: 'playlist' });
    customAction.value = null;
    selected.value = new Set();
  } catch (err) {
    banner({ text: `Append failed: ${(err as Error).message}`, tone: 'bad', icon: 'warn' });
  } finally {
    appending.value = false;
  }
}
</script>

<template>
  <div class="col">
    <div class="card" style="display: flex; align-items: center; gap: 16px;">
      <div :class="['src-ico', { builtin: playlist.builtin }]" style="width: 52px; height: 52px; border-radius: 12px;">
        <Icon :name="playlist.builtin ? 'tv' : 'playlist'" :size="22" />
      </div>
      <div style="flex: 1; display: flex; flex-direction: column; gap: 8px;">
        <div class="row" style="gap: 10px;">
          <StatusDot :status="playlist.status" :pulse="playlist.status === 'good'" />
          <h2 style="margin: 0; font-size: 18px; font-weight: 600;">{{ playlist.name }}</h2>
        </div>
        <div class="row" style="gap: 10px; flex-wrap: wrap;">
          <Pill v-if="playlist.builtin" tone="system"><Icon name="check" :size="10" />built-in</Pill>
          <Pill :tone="playlist.state !== false ? 'active' : 'disabled'">
            {{ playlist.state !== false ? 'Active' : 'Inactive' }}
          </Pill>
          <Pill v-if="!noSchedule" tone="cyan"><Icon name="refresh" :size="10" />Sync: {{ scheduleLabel }}</Pill>
          <Pill v-if="!noSchedule || isClone" tone="cyan"><Icon name="file" :size="10" />M3U: {{ m3uLabel }}</Pill>
          <Pill :tone="playlist.endpoint === 'custom' ? 'warn' : 'good'">
            <Icon :name="playlist.endpoint === 'custom' ? 'file' : 'globe'" :size="10" />
            {{ playlist.endpoint === 'custom' ? 'custom' : 'global' }}
          </Pill>
          <Pill v-if="playlist.authentication" :tone="playlist.isAuthenticated ? 'good' : 'warn'">
            <Icon :name="playlist.isAuthenticated ? 'check' : 'lock'" :size="10" />
            {{ playlist.isAuthenticated ? 'Authenticated' : 'Sign-in needed' }}
          </Pill>
        </div>
        <div v-if="playlist.builtin" class="muted" style="font-size: var(--fs-xs);">
          Built-in source · click <b>Sync</b> to fetch the latest channels.
        </div>
      </div>
      <ProgressBar v-if="headerBusy" class="pl-detail-progress" :value="headerProgress" />
      <div v-else class="row" style="gap: 18px;">
        <Stat :label="`Channels (${totalCount})`" :value="activeCount">
          <span style="color: var(--accent-hi);">{{ activeCount }}</span><span style="color: var(--text-0);"> / </span><span style="color: var(--warn);">{{ disabledCount }}</span>
        </Stat>
        <Stat label="Groups" :value="playlist.groups" />
        <Stat label="Synced" :value="playlist.lastSync" small />
      </div>
      <!-- All header actions (Sync / Sync Global / Compose[ Global] / Edit / Delete) collapse into one cyan
           waffle popover, mirroring the Playlists list-screen row-actions pattern. position:relative anchors
           the absolutely-positioned RowActionsMenu; @click.stop is the contract its outside-click listener
           relies on (and keeps the trigger click off the card). -->
      <div class="row" style="gap: 10px; position: relative;" @click.stop>
        <Btn
          variant="cyan"
          icon="waffle"
          title="Actions"
          aria-label="Actions"
          aria-haspopup="menu"
          :aria-expanded="menuOpen"
          @click="menuOpen = !menuOpen"
        />
        <RowActionsMenu v-if="menuOpen" :items="headerMenuItems" @close="menuOpen = false" />
      </div>
    </div>

    <div class="card flush pl-detail-sticky">
      <div class="toolbar">
        <SearchInput :value="search" @change="(v) => search = v" placeholder="Search channels" />
        <div class="select">
          <select v-model="group">
            <option value="all">All groups</option>
            <option v-for="g in groupOptions" :key="g">{{ g }}</option>
          </select>
        </div>
        <Segmented :value="sortBy" @change="(v) => sortBy = v as any" :options="[
          { value: 'name', label: 'Channel', icon: 'tv' },
          { value: 'channelNo', label: 'Channel No', icon: 'list' },
          { value: 'group', label: 'Group', icon: 'grid' },
        ]" />
        <Pill>{{ filtered.length }} of {{ channels.length }}</Pill>

        <span class="spacer" />

        <template v-if="selected.size > 0">
          <Pill tone="cyan">{{ selected.size }} selected</Pill>
          <Btn variant="ghost" size="sm" icon="link" title="Configure a failover group from the selection" @click="groupOpen = true">Group</Btn>
          <Btn v-if="!isClone" variant="primary" size="sm" icon="plus" @click="openCreate">Create</Btn>
          <Btn v-if="!isClone" variant="ghost" size="sm" icon="playlist" @click="openAppend">Append</Btn>
          <span class="tbar-sep" aria-hidden="true" />
          <Btn variant="ghost" size="sm" icon="edit" title="Bulk edit, manage groups, delete" @click="bulkOpen = true">Edit</Btn>
          <Btn variant="ghost" size="sm" @click="selected = new Set()">Clear</Btn>
        </template>
        <template v-else>
          <Segmented :value="stateFilter" @change="(v) => stateFilter = v as any" :options="[
            { value: 'Active', label: 'Active', icon: 'check', cls: 'seg-cyan' },
            { value: 'Disabled', label: 'Disabled', icon: 'x', cls: 'seg-amber' },
          ]" />
          <Segmented :value="view" @change="(v) => view = v as any" :options="[
            { value: 'table', label: 'Table', icon: 'list' },
            { value: 'grid', label: 'Grid', icon: 'grid' },
          ]" />
        </template>
      </div>

      <template v-if="channels.length">
      <table v-if="view === 'table' && filtered.length" class="tbl">
        <thead>
          <tr>
            <th style="width: 40px;">
              <Checkbox :on="selected.size > 0 && selected.size === filtered.length" @change="toggleAll" />
            </th>
            <th>Channel</th>
            <th>Group</th>
            <th style="width: 90px;">Channel No.</th>
            <th>TVG-ID</th>
            <th>State</th>
            <th>Source</th>
            <th>EPG</th>
            <th style="width: 80px;">Stream</th>
            <th style="width: 44px;" aria-label="Group actions"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in filtered" :key="c.id" :data-channel-id="c.id" :class="{ selected: selected.has(c.id), 'ch-child-row': filteredView.nestedIds.has(c.id), flash: focusId === c.id }" @click="onRowClick(c, $event)">
            <td @click.stop>
              <Checkbox :on="selected.has(c.id)" @change="toggleSel(c.id)" />
            </td>
            <td>
              <div class="row ch-tree-row" :class="{ 'is-child': filteredView.nestedIds.has(c.id) }" style="gap: 10px;">
                <button
                  v-if="c.failoverRole === 'parent' && filteredView.childCounts.has(c.id)"
                  class="ch-tree-toggle"
                  :title="isCollapsed(c.failoverGroupId) ? 'Expand failover group' : 'Collapse failover group'"
                  @click.stop="toggleCollapse(c.failoverGroupId)"
                >
                  <Icon :name="isCollapsed(c.failoverGroupId) ? 'chevron-r' : 'chevron-d'" :size="14" />
                </button>
                <span v-else-if="filteredView.nestedIds.has(c.id)" class="ch-tree-branch" aria-hidden="true">└</span>
                <span v-else class="ch-tree-spacer" aria-hidden="true" />
                <ChannelLogo :ch="c" />
                <input v-if="editingId === c.id" :value="c.tvg_name"
                       @blur="onRenameBlur(c.id, $event)" @keydown="onRenameKey(c.id, $event)"
                       @click.stop
                       style="background: var(--bg-2); border: 1px solid var(--accent); border-radius: 6px; padding: 3px 8px; color: var(--text-0); font-weight: 500; width: 200px; box-shadow: 0 0 0 3px var(--accent-soft);" />
                <span v-else style="font-weight: 500;" @dblclick.stop="editingId = c.id" title="Double-click to rename">{{ c.tvg_name }}</span>
                <Pill v-if="c.stream.res">{{ c.stream.res }}</Pill>
                <Pill v-if="c.failoverRole === 'parent'" tone="parent" title="Failover group parent — exported and served first">parent</Pill>
                <Pill v-else-if="c.failoverRole === 'child'" tone="child" title="Failover backup — hidden from exports, EPG inherited from the parent">child</Pill>
                <Pill v-if="filteredView.childCounts.has(c.id)" title="Failover backups behind this parent">{{ filteredView.childCounts.get(c.id) }} backup{{ filteredView.childCounts.get(c.id) === 1 ? '' : 's' }}</Pill>
              </div>
            </td>
            <td class="muted">{{ c.group }}</td>
            <td class="mono muted">{{ c.channelNo ?? '—' }}</td>
            <td class="mono muted">
              <template v-if="c.tvg_id">{{ c.tvg_id }}</template>
              <span v-else style="color: var(--text-3);">—</span>
            </td>
            <td>
              <Pill :tone="c.status === 'Active' ? 'active' : 'disabled'">
                {{ c.status }}
              </Pill>
            </td>
            <td><Pill tone="cyan">{{ c.origin || c.source }}</Pill></td>
            <td>
              <Pill v-if="c.epgState === 'matched'" tone="good"><Icon name="check" :size="11" />matched</Pill>
              <Pill v-else-if="c.epgState === 'unmatched'" tone="warn"><Icon name="warn" :size="11" />no match</Pill>
              <span v-else style="color: var(--text-3);">—</span>
            </td>
            <td>
              <div class="row" style="gap: 6px;">
                <template v-if="c.stream.status">
                  <StatusDot
                    :status="c.stream.status === 'live' ? 'good' : c.stream.status === 'failed' ? 'bad' : 'warn'"
                    :pulse="c.stream.status !== 'live' && c.stream.status !== 'failed'" />
                  <span class="muted" style="font-size: var(--fs-xs);">
                    {{ c.stream.status === 'live' ? 'live' : c.stream.status === 'failed' ? 'down' : c.stream.status }}
                  </span>
                </template>
                <span v-else class="muted" style="font-size: var(--fs-xs); color: var(--text-3);">—</span>
              </div>
            </td>
            <td @click.stop>
              <div v-if="c.failoverRole === 'parent'" class="ch-row-actions" style="position: relative;">
                <Btn variant="ghost" size="sm" icon="waffle" title="Group actions" aria-haspopup="menu" :aria-expanded="openGroupMenuId === c.id" @click="openGroupMenuId = openGroupMenuId === c.id ? null : c.id" />
                <RowActionsMenu v-if="openGroupMenuId === c.id" :items="groupMenuItems(c)" @close="openGroupMenuId = null" />
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-else-if="view === 'grid' && filtered.length" class="ch-grid">
        <div v-for="c in filtered" :key="c.id" :data-channel-id="c.id" :class="['ch-card', { selected: selected.has(c.id), 'ch-card-child': filteredView.nestedIds.has(c.id), 'ch-card-parent': filteredView.childCounts.has(c.id), flash: focusId === c.id }]" @click="onRowClick(c, $event)">
          <div class="cbx-pos">
            <Checkbox :on="selected.has(c.id)" @change="toggleSel(c.id)" />
          </div>
          <div class="top">
            <ChannelLogo :ch="c" size="lg" />
            <div style="min-width: 0;">
              <div class="name">{{ c.tvg_name }}</div>
              <div class="meta mono" style="margin-top: 4px;">#{{ c.channelNo ?? '—' }}<template v-if="c.stream.res"> · {{ c.stream.res }}</template></div>
            </div>
          </div>
          <div class="meta">{{ c.group }}</div>
          <div class="row ch-card-foot">
            <Pill :tone="c.status === 'Active' ? 'active' : 'disabled'">
              {{ c.status }}
            </Pill>
            <Pill v-if="c.epgState === 'matched'" tone="good"><Icon name="check" :size="11" />EPG</Pill>
            <Pill v-else-if="c.epgState === 'unmatched'" tone="warn">no EPG</Pill>
            <Pill v-if="c.failoverRole === 'parent'" tone="parent">parent</Pill>
            <Pill v-else-if="c.failoverRole === 'child'" tone="child">child</Pill>
            <Pill v-if="filteredView.childCounts.has(c.id)" title="Failover backups behind this parent">{{ filteredView.childCounts.get(c.id) }} backup{{ filteredView.childCounts.get(c.id) === 1 ? '' : 's' }}</Pill>
            <Pill tone="cyan">{{ c.origin || c.source }}</Pill>
            <span class="spacer" />
            <div v-if="c.failoverRole === 'parent'" class="ch-row-actions" style="position: relative;" @click.stop>
              <button
                v-if="filteredView.childCounts.has(c.id)"
                class="ch-tree-toggle"
                :title="isCollapsed(c.failoverGroupId) ? 'Expand failover group' : 'Collapse failover group'"
                @click.stop="toggleCollapse(c.failoverGroupId)"
              >
                <Icon :name="isCollapsed(c.failoverGroupId) ? 'chevron-r' : 'chevron-d'" :size="14" />
              </button>
              <Btn variant="ghost" size="sm" icon="waffle" title="Group actions" aria-haspopup="menu" :aria-expanded="openGroupMenuId === c.id" @click="openGroupMenuId = openGroupMenuId === c.id ? null : c.id" />
              <RowActionsMenu v-if="openGroupMenuId === c.id" :items="groupMenuItems(c)" @close="openGroupMenuId = null" />
            </div>
            <StatusDot v-if="c.status" :status="c.status" :pulse="c.status === 'good'" />
          </div>
        </div>
      </div>

      <div v-else class="empty" style="padding: 40px 24px; text-align: center;">
        <h3 style="margin: 0; font-size: var(--fs-base);">No {{ stateFilter }} channels</h3>
        <p class="muted" style="font-size: var(--fs-sm); margin: 6px 0 0;">
          No channels match the current filters.
          <template v-if="stateFilter === 'Active'">Switch to <b>Disabled</b> to see disabled channels.</template>
          <template v-else>Switch to <b>Active</b> to see active channels.</template>
        </p>
      </div>
      </template>

      <div v-else class="empty" style="padding: 40px 24px; text-align: center;">
        <h3 style="margin: 0; font-size: var(--fs-base);">No channels yet</h3>
        <p class="muted" style="font-size: var(--fs-sm); margin: 6px 0 0;">
          <template v-if="playlist.builtin">Click <b>Sync</b> to fetch this source's channels.</template>
          <template v-else>This playlist has no channels.</template>
        </p>
      </div>
    </div>

    <!-- Create modal -->
    <div v-if="customAction === 'create'" class="modal-bg" @click="customAction = null">
      <div class="modal" @click.stop style="width: 520px; max-width: 92vw;">
        <div class="modal-hd">
          <Icon name="plus" :size="18" />
          <h2>New custom playlist</h2>
          <span class="spacer" />
          <Btn variant="ghost" size="sm" icon="x" @click="customAction = null" />
        </div>
        <div class="modal-body">
          <div class="row" style="gap: 8px; padding: 8px 10px; background: var(--accent-soft); border-radius: 8px; align-items: center;">
            <Icon name="playlist" :size="13" style="color: var(--accent-hi);" />
            <span style="font-size: var(--fs-sm); color: var(--text-1);">
              <b style="color: var(--accent-hi);">{{ selectedChannels.length }}</b>
              selected channel{{ selectedChannels.length === 1 ? '' : 's' }} will be added to the new playlist.
            </span>
          </div>

          <div class="form-row">
            <div class="field-lbl">Playlist name</div>
            <div class="input"><input v-model="createName" placeholder="e.g. Saturday Football" /></div>
          </div>

          <div class="form-row">
            <div class="field-lbl">Served at</div>
            <div class="muted" style="font-size: var(--fs-xs); display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
              <Icon name="link" :size="11" />
              <span>Path</span>
              <span class="mono" style="color: var(--text-1);">/{{ previewId }}/</span>
              <span>on your domain — one tokenized file per user (download is token-free, streams are token-gated).</span>
            </div>
          </div>

          <div style="border: 1px solid var(--hairline); border-radius: 10px; padding: 10px 12px; background: var(--bg-2); max-height: 168px; overflow: auto;">
            <div class="row" style="gap: 8px; margin-bottom: 8px;">
              <Icon name="check" :size="13" style="color: var(--good);" />
              <span style="font-weight: 600; font-size: var(--fs-sm);">Channels to include</span>
              <span class="spacer" />
              <Pill tone="cyan">{{ selectedChannels.length }}</Pill>
            </div>
            <div v-for="c in selectedChannels.slice(0, 8)" :key="c.id" class="row" style="gap: 8px; padding: 3px 0; font-size: var(--fs-sm);">
              <span class="mono muted" style="font-size: var(--fs-xs); min-width: 32px;">#{{ c.channelNo ?? '—' }}</span>
              <span style="font-weight: 500;">{{ c.tvg_name }}</span>
              <span class="muted" style="font-size: var(--fs-xs);">· {{ c.group }}</span>
            </div>
            <div v-if="selectedChannels.length > 8" class="muted" style="font-size: var(--fs-xs); padding-top: 6px;">
              + {{ selectedChannels.length - 8 }} more
            </div>
          </div>
        </div>
        <div class="modal-ft">
          <span class="spacer" />
          <Btn variant="ghost" @click="customAction = null">Cancel</Btn>
          <Btn variant="primary" icon="plus" :disabled="!canSubmitCreate" @click="doCreate">Create playlist</Btn>
        </div>
      </div>
    </div>

    <!-- Append modal -->
    <div v-if="customAction === 'append'" class="modal-bg" @click="customAction = null">
      <div class="modal" @click.stop style="width: 520px; max-width: 92vw;">
        <div class="modal-hd">
          <Icon name="playlist" :size="18" />
          <h2>Append to custom playlist</h2>
          <span class="spacer" />
          <Btn variant="ghost" size="sm" icon="x" @click="customAction = null" />
        </div>
        <div class="modal-body">
          <div class="row" style="gap: 8px; padding: 8px 10px; background: var(--accent-soft); border-radius: 8px; align-items: center;">
            <Icon name="playlist" :size="13" style="color: var(--accent-hi);" />
            <span style="font-size: var(--fs-sm); color: var(--text-1);">
              <b style="color: var(--accent-hi);">{{ selectedChannels.length }}</b>
              selected channel{{ selectedChannels.length === 1 ? '' : 's' }} will be appended to the playlist you choose.
            </span>
          </div>

          <div v-if="customPlaylists.length === 0" class="empty" style="padding: 28px 20px; text-align: center;">
            <h3 style="margin: 0; font-size: var(--fs-base);">No custom playlists yet</h3>
            <p class="muted" style="font-size: var(--fs-sm); margin: 6px 0 0;">
              Use <b>Create</b> to make your first custom playlist.
            </p>
          </div>
          <template v-else>
            <div class="form-row">
              <div class="field-lbl">Destination playlist</div>
              <div class="select">
                <select v-model="targetId">
                  <option v-for="p in customPlaylists" :key="p.id" :value="p.id">{{ p.name }} — {{ p.channels }} channels</option>
                </select>
              </div>
            </div>

            <div v-if="target" style="border: 1px solid var(--hairline); border-radius: 10px; padding: 12px 14px; background: var(--bg-2); display: grid; gap: 10px;">
              <div class="row" style="gap: 10px;">
                <div class="src-ico" style="width: 40px; height: 40px; border-radius: 10px;">
                  <Icon name="playlist" :size="16" />
                </div>
                <div style="flex: 1; min-width: 0;">
                  <div style="font-weight: 600; font-size: var(--fs-sm);">{{ target.name }}</div>
                  <div class="mono muted" style="font-size: var(--fs-xs); margin-top: 2px;">/{{ target.slug }}/</div>
                </div>
                <div class="muted" style="font-size: var(--fs-xs);">updated {{ target.updated }}</div>
              </div>
              <div class="row" style="gap: 10px; align-items: center; padding-top: 8px; border-top: 1px dashed var(--hairline);">
                <Stat label="Now" :value="target.channels" small />
                <span style="color: var(--text-3); font-size: 18px;">→</span>
                <Stat label="After append" :value="newTotal" small>
                  <span style="color: var(--accent-hi);">{{ newTotal }}</span>
                </Stat>
                <span class="spacer" />
                <Pill tone="cyan">+{{ selectedChannels.length }}</Pill>
              </div>
            </div>
          </template>
        </div>
        <div class="modal-ft">
          <span class="spacer" />
          <Btn variant="ghost" @click="customAction = null">Cancel</Btn>
          <Btn variant="primary" icon="check" :disabled="!target" @click="doAppend">
            Append {{ selectedChannels.length }} channel{{ selectedChannels.length === 1 ? '' : 's' }}
          </Btn>
        </div>
      </div>
    </div>

    <GroupConfigModal
      v-if="groupOpen"
      :source="props.id"
      :channels="editGroupAnchor ? [editGroupAnchor] : selectedChannels"
      :all-channels="channels"
      @close="groupOpen = false; editGroupAnchor = null"
      @saved="onGroupSaved"
      @disbanded="onGroupDisbanded"
    />

    <ChannelBulkDrawer
      v-if="bulkOpen"
      :channels="selectedChannels"
      :playlist-id="props.id"
      @close="bulkOpen = false"
      @apply="applyBulk"
      @delete-channels="onDeleteChannels"
    />

    <PlaylistStatusDrawer
      v-if="statusOpen"
      :playlist="playlist"
      :channels="channels"
      @close="statusOpen = false"
    />

    <PlaylistOpModal
      v-if="opOpen && opScope && opRun"
      :mode="opMode"
      :scope="opScope"
      :run="opRun"
      @close="opOpen = false"
    />

    <!-- Delete confirmation -->
    <div v-if="confirmDelete" class="modal-bg" @click="deleting || (confirmDelete = false)">
      <div class="modal" @click.stop style="width: 520px; max-width: 92vw;">
        <div class="modal-hd">
          <span style="color: var(--bad);"><Icon name="trash" :size="18" /></span>
          <h2>Delete playlist?</h2>
          <span class="spacer" />
          <Btn variant="ghost" size="sm" icon="x" :disabled="deleting" @click="confirmDelete = false" />
        </div>
        <div class="modal-body">
          <div style="font-size: var(--fs-base); color: var(--text-1); line-height: 1.5;">
            This permanently removes <strong>{{ playlist.name }}</strong> and everything in it.
            This cannot be undone.
          </div>

          <!-- Built-in: real affected-areas summary from GET /:id/delete-impact. -->
          <template v-if="playlist.builtin">
            <div v-if="impactLoading" class="row" style="gap: 8px; padding: 12px 0; color: var(--text-2); font-size: var(--fs-sm);">
              <Icon name="refresh" :size="13" />
              <span>Calculating affected areas…</span>
            </div>
            <template v-else-if="impact">
              <!-- Playlist Channels -->
              <div class="impact-block">
                <div class="impact-hd"><Icon name="list" :size="13" />Playlist Channels</div>
                <div class="impact-row">
                  <span class="impact-name">{{ impact.playlist.name }}</span>
                  <span class="spacer" />
                  <span class="impact-lbl">Channels Deleted:</span>
                  <span class="impact-val bad">everything</span>
                </div>
                <div v-for="c in impact.affectedClones" :key="c.id" class="impact-row">
                  <span class="impact-name">{{ c.name }}</span>
                  <span class="spacer" />
                  <span class="impact-lbl">Channels Deleted:</span>
                  <span class="impact-val warn">{{ c.channelsRemoved }}</span>
                </div>
                <div v-if="!impact.affectedClones.length" class="impact-row muted" style="font-size: var(--fs-xs);">
                  No cloned playlists include this source's channels.
                </div>
              </div>
              <!-- Playlist EPG -->
              <div class="impact-block">
                <div class="impact-hd"><Icon name="grid" :size="13" />Playlist EPG</div>
                <div class="impact-row">
                  <span class="impact-lbl">Playlist-bound:</span>
                  <span class="spacer" />
                  <span class="impact-val" :class="impact.boundEpgSource ? 'warn' : 'muted'">
                    {{ impact.boundEpgSource ? impact.boundEpgSource.name : 'None' }}
                  </span>
                </div>
              </div>
            </template>
            <!-- Preview failed (non-ok / network error): no affected-areas data — say so explicitly and keep
                 the Delete button gated (see modal-ft below) so the cascade is never confirmed blind. -->
            <div v-else class="impact-block">
              <div class="impact-row warn" style="gap: 8px;">
                <Icon name="warn" :size="14" />
                <span><b>Affected-areas preview unavailable.</b> Could not calculate what this delete will
                  remove. Close this dialog and try again.</span>
              </div>
            </div>
          </template>

          <!-- Clone / custom: the generic checklist (no impact fetch needed). -->
          <div v-else style="display: grid; gap: 8px;">
            <div v-for="it in [
              { icon: 'list', text: `${channels.length} channel${channels.length === 1 ? '' : 's'} are removed` },
              { icon: 'file', text: 'Its per-user M3U files + guide sibling are deleted' },
              { icon: 'tv', text: 'It is removed from every user\'s allowed playlists' },
            ]" :key="it.text" class="row"
                 style="gap: 8px; padding: 4px 0; font-size: var(--fs-sm); color: var(--text-1);">
              <span style="color: var(--text-2);"><Icon :name="it.icon" :size="13" /></span>
              <span>{{ it.text }}</span>
            </div>
          </div>
        </div>
        <div class="modal-ft">
          <span class="spacer" />
          <Btn variant="ghost" :disabled="deleting" @click="confirmDelete = false">Cancel</Btn>
          <button class="btn ghost danger" :disabled="deleting || impactLoading || (playlist.builtin && !impact)" @click="deletePlaylist">
            <Icon name="trash" :size="14" />{{ deleting ? 'Deleting…' : 'Delete playlist' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Transient highlight when a global-search result deep-links to a channel row/card (pulse, then cleared). */
.flash {
  animation: mq-row-flash 2.2s ease-out;
}
.ch-card.flash {
  box-shadow: inset 0 0 0 2px var(--accent-hi);
}
@keyframes mq-row-flash {
  0%, 25% { background: var(--accent-soft); }
  100% { background: transparent; }
}
</style>

