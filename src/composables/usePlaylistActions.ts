
import { ref } from 'vue';
import { reloadEpgSources, reloadChannels, type Playlist } from '../data';

export interface GlobalActionResult {
  total: number;
  failed: string[];
}

const syncingGlobal = ref(false);
const composingGlobal = ref(false);
const globalSyncProgress = ref(0);
const globalComposeProgress = ref(0);

export function isGlobalScope(p: Playlist): boolean {
  return p.endpoint === 'global';
}
const SYNCABLE_CUSTOM = new Set(['url', 'hdhomerun', 'local']);
export function hasLiveUpstream(p: Playlist): boolean {
  return p.builtin === true || SYNCABLE_CUSTOM.has(p.source ?? '');
}
export function syncRequestUrl(p: Playlist): string {
  return SYNCABLE_CUSTOM.has(p.source ?? '')
    ? `/api/custom-playlists/${encodeURIComponent(p.id)}/sync`
    : `/api/sources/${encodeURIComponent(p.source ?? '')}/sync`;
}
export function isGlobalSyncTarget(p: Playlist): boolean {
  return isGlobalScope(p) && hasLiveUpstream(p);
}

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
