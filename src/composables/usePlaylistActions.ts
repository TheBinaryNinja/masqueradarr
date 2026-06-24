// Shared "Global" playlist fan-out — a module-level singleton (like useToast/useStreamStats) so the
// Playlists list and detail screens read ONE source of truth. Clicking "Sync Global" / "Compose Global"
// on any Global row (or the detail header) syncs/composes every Global playlist (endpoint !== 'custom')
// in sequence, exposing a determinate 0..1 progress that all Global rows display in lockstep — and the
// shared booleans disable every Global button at once. Custom single-playlist ops stay local to each
// screen (per-id Sets on the list, per-row booleans on the detail) and render an indeterminate bar.
//
// Each per-playlist call reuses the existing endpoints — POST /api/sources/:source/sync and
// POST /api/playlists/:id/compose — so there is no new backend surface. (A single Global compose already
// recomposes the whole union server-side; iterating per playlist is mildly redundant but gives an honest
// per-step progress bar, which matches the "process each playlist" intent.)

import { ref } from 'vue';
import { reloadEpgSources, type Playlist } from '../data';

export interface GlobalActionResult {
  total: number;
  failed: string[]; // names of playlists whose request errored
}

const syncingGlobal = ref(false);
const composingGlobal = ref(false);
const globalSyncProgress = ref(0); // 0..1
const globalComposeProgress = ref(0); // 0..1

// The authoritative Global target set: source-backed playlists that are not Custom. Fetched live so the
// detail screen (which holds only one playlist) drives the same complete cohort as the list.
async function globalTargets(): Promise<Playlist[]> {
  const res = await fetch('/api/playlists');
  if (!res.ok) return [];
  const all: Playlist[] = await res.json();
  return all.filter((p) => p.source && p.endpoint !== 'custom');
}

async function syncAllGlobal(): Promise<GlobalActionResult> {
  if (syncingGlobal.value) return { total: 0, failed: [] };
  syncingGlobal.value = true;
  globalSyncProgress.value = 0;
  const failed: string[] = [];
  try {
    const targets = await globalTargets();
    let done = 0;
    for (const p of targets) {
      try {
        const res = await fetch(`/api/sources/${encodeURIComponent(p.source!)}/sync`, { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch {
        failed.push(p.name);
      }
      done += 1;
      globalSyncProgress.value = targets.length ? done / targets.length : 1;
    }
    // A source sync's afterSync hook can create/refresh EPG sources (dlhd/tubi self-EPG + crosswalk links),
    // so re-surface the EPG store here — otherwise the EPG Sources screen shows stale (empty on a fresh
    // instance) data until a full browser refresh. Non-fatal: a refresh failure must not fail the sync.
    await reloadEpgSources().catch(() => {});
    return { total: targets.length, failed };
  } finally {
    syncingGlobal.value = false;
    globalSyncProgress.value = 0;
  }
}

async function composeAllGlobal(): Promise<GlobalActionResult> {
  if (composingGlobal.value) return { total: 0, failed: [] };
  composingGlobal.value = true;
  globalComposeProgress.value = 0;
  const failed: string[] = [];
  try {
    const targets = await globalTargets();
    let done = 0;
    for (const p of targets) {
      try {
        const res = await fetch(`/api/playlists/${encodeURIComponent(p.id)}/compose`, { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch {
        failed.push(p.name);
      }
      done += 1;
      globalComposeProgress.value = targets.length ? done / targets.length : 1;
    }
    return { total: targets.length, failed };
  } finally {
    composingGlobal.value = false;
    globalComposeProgress.value = 0;
  }
}

export function usePlaylistActions() {
  return {
    syncingGlobal,
    composingGlobal,
    globalSyncProgress,
    globalComposeProgress,
    syncAllGlobal,
    composeAllGlobal,
  };
}
