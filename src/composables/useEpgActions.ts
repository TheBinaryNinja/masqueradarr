
import { ref } from 'vue';
import { reloadEpgSources, type EpgSource } from '../data';

export interface EpgSyncResult {
  total: number;
  failed: string[];
}

const syncingAllEpg = ref(false);
const syncAllProgress = ref(0);

const syncingIds = ref<Set<string>>(new Set());

export function isEpgSyncTarget(s: EpgSource): boolean {
  return !s.playlistBinding;
}

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
    await reloadEpgSources().catch(() => {});
    return { total: targets.length, failed };
  } finally {
    syncingAllEpg.value = false;
    syncAllProgress.value = 0;
  }
}

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
