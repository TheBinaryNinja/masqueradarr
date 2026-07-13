// Shared "Sync all EPG sources" fan-out — a module-level singleton (like usePlaylistActions/useToast) so the
// EPG Sources list screen and its progress modal read ONE source of truth. Clicking "Sync all" fans out over
// every EPG source IN SEQUENCE (one at a time), exposing a determinate 0..1 progress the modal displays as it
// settles each row; the shared boolean disables the button while a run is in flight.
//
// Playlist-bound sources (the tubi/dlhd self-EPG rows whose guide is driven by their playlist's cadence) are
// EXCLUDED — see isEpgSyncTarget. Their detail screen hides the Sync action and the backend rejects a direct
// sync of them, so they have no working per-source sync to call.
//
// Each per-source call reuses the existing endpoint — POST /api/epg-sources/:id/sync — so there is no new
// backend surface (there is intentionally no bulk endpoint; the playlist "Sync Global" loops client-side too).

import { ref } from 'vue';
import { reloadEpgSources, type EpgSource } from '../data';

export interface EpgSyncResult {
  total: number;
  failed: string[]; // names of EPG sources whose sync errored
}

const syncingAllEpg = ref(false);
const syncAllProgress = ref(0); // 0..1

// Per-source inflight set for single-row syncs (the waffle "Sync" item on the list + detail screens). A Set
// reassigned on each mutation so `.has(id)` stays reactive in the menu-item builders (label → "Syncing…",
// disabled). Independent of the "Sync all" cohort — a row can be syncing on its own without a full run.
const syncingIds = ref<Set<string>>(new Set());

// The single source of truth for the sync cohort: an EPG source is a "Sync all" target iff it is NOT
// playlist-bound. The run thunk (syncAllEpg, below) and the modal's displayed list (EpgSyncModal → syncTargets)
// BOTH consume this exact predicate, so the operation and its preview can never diverge — the same role
// isGlobalSyncTarget plays for playlists.
export function isEpgSyncTarget(s: EpgSource): boolean {
  return !s.playlistBinding;
}

// Fetch the live EPG source set and keep only the sync targets. Fetched live (not the EPG_SOURCES store) so the
// loop always reflects the persisted set, mirroring usePlaylistActions' globalTargets.
async function epgTargets(): Promise<EpgSource[]> {
  const res = await fetch('/api/epg-sources');
  if (!res.ok) return [];
  const all: EpgSource[] = await res.json();
  return all.filter(isEpgSyncTarget);
}

async function syncAllEpg(): Promise<EpgSyncResult> {
  if (syncingAllEpg.value) return { total: 0, failed: [] };
  syncingAllEpg.value = true;
  syncAllProgress.value = 0;
  const failed: string[] = [];
  try {
    const targets = await epgTargets();
    let done = 0;
    for (const s of targets) {
      try {
        const res = await fetch(`/api/epg-sources/${encodeURIComponent(s.id)}/sync`, { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch {
        failed.push(s.name);
      }
      done += 1;
      syncAllProgress.value = targets.length ? done / targets.length : 1;
    }
    // Re-surface the refreshed counts/status into the store so the list reflects the sync without a full reload.
    // Non-fatal: a refresh failure must not fail the sync.
    await reloadEpgSources().catch(() => {});
    return { total: targets.length, failed };
  } finally {
    syncingAllEpg.value = false;
    syncAllProgress.value = 0;
  }
}

// Sync ONE EPG source via the same endpoint the "Sync all" loop uses (POST /api/epg-sources/:id/sync). Tracks
// its own inflight flag in syncingIds and re-pulls the store so the row's counts/status settle without a full
// reload. Returns { ok, offsetDefaulted } so a caller can surface the "time zone offset not set" toast.
async function syncEpgSource(id: string): Promise<{ ok: boolean; offsetDefaulted?: boolean }> {
  if (syncingIds.value.has(id)) return { ok: false };
  syncingIds.value = new Set(syncingIds.value).add(id);
  try {
    const res = await fetch(`/api/epg-sources/${encodeURIComponent(id)}/sync`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json().catch(() => null);
    await reloadEpgSources().catch(() => {});
    return { ok: true, offsetDefaulted: !!body?.offsetDefaulted };
  } catch {
    // The server flips status to 'error' on a 502; re-read so the row reflects it.
    await reloadEpgSources().catch(() => {});
    return { ok: false };
  } finally {
    const next = new Set(syncingIds.value);
    next.delete(id);
    syncingIds.value = next;
  }
}

export function useEpgActions() {
  return {
    syncingAllEpg,
    syncAllProgress,
    syncAllEpg,
    syncingIds,
    syncEpgSource,
  };
}
