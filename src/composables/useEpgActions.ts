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

export function useEpgActions() {
  return {
    syncingAllEpg,
    syncAllProgress,
    syncAllEpg,
  };
}
