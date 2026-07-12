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
import { reloadEpgSources, reloadChannels, type Playlist } from '../data';

export interface GlobalActionResult {
  total: number;
  failed: string[]; // names of playlists whose request errored
}

const syncingGlobal = ref(false);
const composingGlobal = ref(false);
const globalSyncProgress = ref(0); // 0..1
const globalComposeProgress = ref(0); // 0..1

// ── Scope / type predicates — the two orthogonal axes the Playlists menus gate on ──────────────────────
// Scope is the `endpoint` field ALONE, decoupled from source type: a built-in set Custom is Custom; a 'url'
// import set Global is Global. Global playlists merge into the shared per-user union (composeGlobal); Custom
// ones are standalone files (composeCustom).
export function isGlobalScope(p: Playlist): boolean {
  return p.endpoint === 'global';
}
// A playlist "has a live upstream" — i.e. Sync can re-fetch its channels — purely by TYPE, independent of
// scope: a registry-backed built-in (Default source), or a custom import whose type carries a re-fetchable
// upstream ('url' = the stored remoteUrl m3u, 'hdhomerun' = the device lineup, 'local' = a Local Now market
// re-fetch). A 'clone'/'file'/legacy 'import'/source-less row has none → it is Compose-only at any endpoint.
const SYNCABLE_CUSTOM = new Set(['url', 'hdhomerun', 'local']);
export function hasLiveUpstream(p: Playlist): boolean {
  return p.builtin === true || SYNCABLE_CUSTOM.has(p.source ?? '');
}
// The correct single-playlist Sync route, chosen BY TYPE (never by scope): a custom import with a live
// upstream re-syncs via the custom-playlists route (keyed by playlist id); a Default source playlist syncs
// via its registry source route (id === source). Shared by syncRow/syncNow AND the syncAllGlobal cohort
// fan-out so all three route identically — the old hardcoded /api/sources/:source/sync 404'd for a
// 'url'/'hdhomerun'/'local' import hosted on the Global endpoint.
export function syncRequestUrl(p: Playlist): string {
  return SYNCABLE_CUSTOM.has(p.source ?? '')
    ? `/api/custom-playlists/${encodeURIComponent(p.id)}/sync`
    : `/api/sources/${encodeURIComponent(p.source ?? '')}/sync`;
}
// The single source of truth for the Global SYNC cohort: hosted on the Global endpoint AND actually
// syncable. The run thunk (syncAllGlobal, below) and the sync modal's preview list (PlaylistOpModal →
// syncTargets) BOTH consume this exact predicate, so the operation and its preview can never diverge.
// Non-syncable Global members (a 'file' import flipped to Global) are correctly excluded — Sync Global
// skips them rather than 404ing on /api/sources/file/sync.
export function isGlobalSyncTarget(p: Playlist): boolean {
  return isGlobalScope(p) && hasLiveUpstream(p);
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
        const res = await fetch(syncRequestUrl(p), { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch {
        failed.push(p.name);
      }
      done += 1;
      globalSyncProgress.value = targets.length ? done / targets.length : 1;
    }
    // A source sync's afterSync hook can create/refresh EPG sources (dlhd/tubi self-EPG + crosswalk links),
    // so re-surface the EPG store here — otherwise the EPG Sources screen shows stale (empty on a fresh
    // instance) data until a full browser refresh. Also re-pull the global CHANNELS union so the synced
    // channels land on the Channels/Mapping screens + the EPG detail's linked-channel list (the screen
    // callers refresh the PLAYLISTS store for counts/status). Non-fatal: a refresh must not fail the sync.
    await Promise.all([reloadEpgSources().catch(() => {}), reloadChannels().catch(() => {})]);
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
    // Compose targets every source-backed Global playlist (composeGlobal rebuilds the whole per-user union
    // server-side regardless, but iterating per playlist gives an honest per-step bar). Uses the same
    // isGlobalScope test as the Sync cohort so the two never drift on an absent-endpoint edge.
    const targets = await globalTargets((p) => Boolean(p.source) && isGlobalScope(p));
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
