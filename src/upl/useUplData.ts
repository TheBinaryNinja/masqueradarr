
import { ref, computed, watch } from 'vue';
import type { Channel, Program } from '../data';

const HOUR_MS = 3_600_000;
const MAX_CHANNEL_IDS = 500;
const RAIL_WINDOW = { back: 1 * HOUR_MS, fwd: 3 * HOUR_MS };
const STRIP_WINDOW = { back: 1 * HOUR_MS, fwd: 12 * HOUR_MS };
const RAIL_TTL_MS = 15 * 60_000;
const CLOCK_TICK_MS = 30_000;


export interface UplParams { pl: string; ch: string }

export function parseHash(hash = window.location.hash): UplParams {
  const q = new URLSearchParams(hash.replace(/^#\/?/, ''));
  return { pl: q.get('pl') ?? '', ch: q.get('ch') ?? '' };
}


export const now = ref(Date.now());
let clockTimer: number | undefined;

export function startClock(): void {
  if (clockTimer !== undefined) return;
  clockTimer = window.setInterval(() => { now.value = Date.now(); }, CLOCK_TICK_MS);
}
export function stopClock(): void {
  if (clockTimer !== undefined) window.clearInterval(clockTimer);
  clockTimer = undefined;
}


export const channels = ref<Channel[]>([]);
export const channelsError = ref<string | null>(null);
export const loading = ref(true);

export function epgKey(ch: Channel | null | undefined): string | null {
  if (!ch?.tvg_id || !ch.epg) return null;
  return `${ch.epg}:${ch.tvg_id}`;
}

export async function loadChannels(pl: string): Promise<void> {
  loading.value = true;
  channelsError.value = null;
  try {
    const res = await fetch(`/api/playlists/${encodeURIComponent(pl)}/channels`);
    if (!res.ok) {
      channelsError.value = res.status === 403
        ? 'You do not have access to this playlist.'
        : `Could not load channels (${res.status}).`;
      channels.value = [];
      return;
    }
    const all = (await res.json()) as Channel[];
    channels.value = all.filter((c) => c.failoverRole !== 'child' && c.status !== 'Disabled');
  } catch {
    channelsError.value = 'Could not reach the server.';
    channels.value = [];
  } finally {
    loading.value = false;
  }
}


export const railPrograms = ref<Record<string, Program[]>>({});
let railInflight = new Set<string>();
let railFetchedAt = 0;
let railTimer: number | undefined;
let railPending = new Set<string>();

async function fetchRailChunk(pl: string, keys: string[]): Promise<void> {
  const sig = keys.join(',');
  if (railInflight.has(sig)) return;
  railInflight.add(sig);
  try {
    const from = Date.now() - RAIL_WINDOW.back;
    const to = Date.now() + RAIL_WINDOW.fwd;
    const res = await fetch(
      `/api/playlists/${encodeURIComponent(pl)}/programs`
      + `?channelIds=${encodeURIComponent(sig)}&from=${from}&to=${to}`,
    );
    if (!res.ok) return;
    const grouped = (await res.json()) as Record<string, Program[]>;
    const next = { ...railPrograms.value };
    for (const k of keys) next[k] = grouped[k] ?? [];
    railPrograms.value = next;
  } catch {
  } finally {
    railInflight.delete(sig);
  }
}

export function ensureRailPrograms(pl: string, keys: (string | null)[]): void {
  if (railFetchedAt && Date.now() - railFetchedAt > RAIL_TTL_MS) {
    railPrograms.value = {};
    railFetchedAt = 0;
  }
  for (const k of keys) {
    if (k && !(k in railPrograms.value)) railPending.add(k);
  }
  if (railPending.size === 0) return;

  if (railTimer !== undefined) window.clearTimeout(railTimer);
  railTimer = window.setTimeout(() => {
    railTimer = undefined;
    const batch = [...railPending];
    railPending = new Set();
    if (batch.length === 0) return;
    railFetchedAt = railFetchedAt || Date.now();
    for (let i = 0; i < batch.length; i += MAX_CHANNEL_IDS) {
      void fetchRailChunk(pl, batch.slice(i, i + MAX_CHANNEL_IDS));
    }
  }, 150);
}


export const stripPrograms = ref<Program[]>([]);
export const stripKey = ref<string | null>(null);

export async function loadStripPrograms(pl: string, key: string | null): Promise<void> {
  stripKey.value = key;
  if (!key) { stripPrograms.value = []; return; }
  try {
    const from = Date.now() - STRIP_WINDOW.back;
    const to = Date.now() + STRIP_WINDOW.fwd;
    const res = await fetch(
      `/api/playlists/${encodeURIComponent(pl)}/programs`
      + `?channelIds=${encodeURIComponent(key)}&from=${from}&to=${to}&rich=1`,
    );
    if (!res.ok) { stripPrograms.value = []; return; }
    const grouped = (await res.json()) as Record<string, Program[]>;
    if (stripKey.value !== key) return;
    stripPrograms.value = grouped[key] ?? [];
  } catch {
    if (stripKey.value === key) stripPrograms.value = [];
  }
}


export interface NowNext { live: Program | null; upcoming: Program[] }

export function nowNext(list: Program[] | undefined, at: number, take = 5): NowNext {
  if (!list || list.length === 0) return { live: null, upcoming: [] };
  const live = list.find((p) => p.start <= at && p.end > at) ?? null;
  const upcoming = list.filter((p) => p.start > at).slice(0, take);
  return { live, upcoming };
}

export function progressOf(p: Program | null, at: number): number {
  if (!p || p.end <= p.start) return 0;
  return Math.min(1, Math.max(0, (at - p.start) / (p.end - p.start)));
}


export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtRemaining(p: Program | null, at: number): string {
  if (!p) return '';
  const mins = Math.max(0, Math.round((p.end - at) / 60_000));
  if (mins < 60) return `${mins} min left`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m left`;
}

export function fmtEpisode(p: Program | null): string {
  if (!p) return '';
  const s = p.season ? `S${p.season}` : '';
  const e = p.episode ? `E${p.episode}` : '';
  return [s, e].filter(Boolean).join(' ');
}

const SORT_PREF_KEY = 'upl:sort';
export type UplSortKey = 'name' | 'channelNo';

function loadSortPref(): UplSortKey {
  try {
    const raw = localStorage.getItem(SORT_PREF_KEY);
    if (raw === 'name' || raw === 'channelNo') return raw;
  } catch {   }
  return 'name';
}

export const sortKey = ref<UplSortKey>(loadSortPref());

watch(sortKey, (k) => {
  try { localStorage.setItem(SORT_PREF_KEY, k); } catch {   }
});

export const orderedChannels = computed<Channel[]>(() => {
  const byName = (a: Channel, b: Channel) => a.tvg_name.localeCompare(b.tvg_name);
  const rows = [...channels.value];
  if (sortKey.value === 'name') return rows.sort(byName);
  return rows.sort((a, b) => {
    const an = a.channelNo?.trim() || null;
    const bn = b.channelNo?.trim() || null;
    if (an == null && bn == null) return byName(a, b);
    if (an == null) return 1;
    if (bn == null) return -1;
    const af = parseFloat(an), bf = parseFloat(bn);
    const bothNum = !Number.isNaN(af) && !Number.isNaN(bf);
    return (bothNum ? af - bf : an.localeCompare(bn)) || byName(a, b);
  });
});
