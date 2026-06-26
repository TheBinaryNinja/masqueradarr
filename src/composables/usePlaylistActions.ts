// Shared "Global" playlist fan-out — a module-level singleton (like useToast/useStreamStats) so the
// Playlists list and detail screens read ONE source of truth. Clicking "Sync Global" / "Compose Global"
// on any Global row (or the detail header) fans out over the Global cohort in sequence, exposing a
// determinate 0..1 progress that all Global rows display in lockstep — and the shared booleans disable
// every Global button at once. The SYNC cohort is the explicit endpoint === 'global' set (see
// isGlobalSyncTarget below); compose keeps its own union filter. Custom single-playlist ops stay local to
// each screen (per-id Sets on the list, per-row booleans on the detail) and render an indeterminate bar.
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

// The single source of truth for the Global SYNC cohort: a playlist is a Global sync target iff it is hosted
// on the Global endpoint (endpoint === 'global', the same canonical "Global" test usePublishedUrls' member
// split uses). The sync run thunk (syncAllGlobal, below) and the sync modal's displayed list
// (PlaylistOpModal → syncTargets) BOTH consume this exact predicate, so the operation and its preview can
// never diverge. Deliberately endpoint-driven: a clone hosted as Global IS included; a source playlist
// somehow not on the Global endpoint is NOT.
export function isGlobalSyncTarget(p: Playlist): boolean {
  return p.endpoint === 'global';
}

// Fetch the live playlist set and filter it with the given predicate. Fetched live (not the PLAYLISTS store)
// so the detail screen — which holds only one playlist — drives the same complete cohort as the list.
async function globalTargets(match: (p: Playlist) => boolean): Promise<Playlist[]> {
  const res = await fetch('/api/playlists');
  if (!res.ok) return [];
  const all: Playlist[] = await res.json();
  return all.filter(match);
}

async function syncAllGlobal(): Promise<GlobalActionResult> {
  if (syncingGlobal.value) return { total: 0, failed: [] };
  syncingGlobal.value = true;
  globalSyncProgress.value = 0;
  const failed: string[] = [];
  try {
    const targets = await globalTargets(isGlobalSyncTarget);
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
    // Compose keeps its established union filter (source-backed, not Custom) so this change does not regress
    // Global compose; only the Sync cohort moves to the explicit endpoint === 'global' predicate.
    const targets = await globalTargets((p) => Boolean(p.source) && p.endpoint !== 'custom');
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
