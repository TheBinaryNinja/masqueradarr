import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { reloadPlaylists, reloadSources, reloadChannels, reloadEpgSources } from '../data';

export interface RebelOp {
  id: string;
  kind: 'update' | 'restart' | 'start' | 'provision' | 'recover';
  phase: string;
  startedAt: string;
  endedAt?: string;
  ok?: boolean;
  error?: string;
  pull?: { percent: number | null; layers: number; layersDone: number };
  from?: string;
  to?: string;
  log: string[];
}

export interface RebelUpdateInfo {
  checkedAt: string;
  current: { version: string | null; imageId: string | null; digests: string[]; tag: string } | null;
  latest: {
    version: string | null;
    publishedAt: string | null;
    notesUrl: string | null;
    notesText: string | null;
    remoteDigest: string | null;
  };
  available: boolean | null;
  pinned: boolean;
  error: string | null;
}

export interface RebelStatus {
  enabled: boolean;
  mode: 'adopt' | 'managed';
  configError: string | null;
  internalUrl: string | null;
  docker: {
    access: boolean;
    available: boolean;
    endpoint: string | null;
    apiVersion: string | null;
    error: string | null;
    manualUpdateCommand: string | null;
  };
  container: {
    id: string;
    name: string;
    state: string;
    health: string | null;
    failingStreak: number;
    lastCheck: { at: string; exitCode: number; output: string } | null;
    startedAt: string | null;
    restartCount: number;
    image: { ref: string; id: string; version: string | null; digest: string | null; created: string | null };
  } | null;
  reachability: { ok: boolean; ms: number | null; status: number | null; error: string | null; at: string };
  update: RebelUpdateInfo | null;
  op: RebelOp | null;
  lastOp: RebelOp | null;
  lastUpdate: { at: string; kind: string; ok: boolean; from: string | null; to: string | null; error: string | null } | null;
  catalog: {
    keySet: boolean;
    provisioned: boolean;
    channels: number;
    lastSync: string | null;
    status: string | null;
    epg: { programs: number; channels: number; lastSync: string | null; status: string | null } | null;
    lastFetchError: string | null;
  };
  viewers: { streams: number; clients: number; channels: string[] };
  config: { idleOnly: boolean; maxStreams: number; autoUpdate: boolean };
  ui: { port: number; publicUrl: string | null };
}

export interface RebelConfigPatch {
  apiKey?: string | null;
  idleOnly?: boolean;
  maxStreams?: number;
  autoUpdate?: boolean;
}

export class RebelApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/rebel-iptv${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (data.message || data.error)) || `HTTP ${res.status}`;
    throw new RebelApiError(String(msg), res.status, data && typeof data === 'object' ? data.error ?? null : null);
  }
  return data as T;
}

const SLOW_MS = 30_000;
const FAST_MS = 2_000;

export function useRebelIptv() {
  const status = ref<RebelStatus | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const busy = ref<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const opRunning = computed(() => !!status.value?.op);
  const dockerAccess = computed(() => status.value?.docker.access === true);
  const dockerReady = computed(() => dockerAccess.value && status.value?.docker.available === true && !status.value?.configError);

  function schedule(): void {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void refresh(), opRunning.value ? FAST_MS : SLOW_MS);
  }

  async function refresh(): Promise<void> {
    const hadOp = opRunning.value;
    loading.value = true;
    try {
      status.value = await call<RebelStatus>('GET', '/status');
      error.value = null;
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loading.value = false;
      if (hadOp && !opRunning.value) void reloadCatalog();
      schedule();
    }
  }

  async function act<T>(label: string, fn: () => Promise<T>): Promise<T> {
    busy.value = label;
    try {
      return await fn();
    } finally {
      busy.value = null;
      void refresh();
    }
  }

  async function reloadCatalog(): Promise<void> {
    await Promise.all([reloadSources(), reloadPlaylists(), reloadEpgSources()]).catch(() => undefined);
    await reloadChannels().catch(() => undefined);
  }

  const checkNow = () => act('check', () => call<RebelUpdateInfo>('POST', '/check'));
  const update = () => act('update', () => call<{ op: RebelOp }>('POST', '/update', { confirm: true }));
  const restart = () => act('restart', () => call<{ op: RebelOp }>('POST', '/restart'));
  const start = () => act('start', () => call<{ op: RebelOp }>('POST', '/start'));
  const repair = () => act('repair', () => call<{ op: RebelOp }>('POST', '/provision'));
  const saveConfig = (patch: RebelConfigPatch) => act('config', () => call<RebelStatus['config'] & { apiKeySet: boolean }>('PUT', '/config', patch));
  const test = () => act('test', () => call<{ ok: boolean; channels: number | null; ms: number | null; error: string | null }>('POST', '/test'));

  async function fetchLogs(tail: number): Promise<string> {
    const res = await fetch(`/api/rebel-iptv/logs?tail=${tail}`);
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        msg = JSON.parse(text).message ?? msg;
      } catch {
      }
      throw new RebelApiError(msg || `HTTP ${res.status}`, res.status, null);
    }
    return text;
  }

  async function addPlaylist(): Promise<void> {
    await act('provision-playlist', async () => {
      const res = await fetch('/api/sources/rebel/provision', { method: 'POST' });
      if (!res.ok) throw new RebelApiError(`Could not add the playlist (HTTP ${res.status})`, res.status, null);
      await syncNowInner();
    });
  }

  async function syncNowInner(): Promise<void> {
    const res = await fetch('/api/sources/rebel/sync', { method: 'POST' });
    if (!res.ok) throw new RebelApiError(`Sync failed (HTTP ${res.status})`, res.status, null);
    await reloadCatalog();
  }

  const syncNow = () => act('sync', syncNowInner);

  const onFocus = () => void refresh();

  onMounted(() => {
    void refresh();
    window.addEventListener('focus', onFocus);
  });
  onBeforeUnmount(() => {
    disposed = true;
    if (timer) clearTimeout(timer);
    window.removeEventListener('focus', onFocus);
  });

  return {
    status,
    loading,
    error,
    busy,
    opRunning,
    dockerAccess,
    dockerReady,
    refresh,
    checkNow,
    update,
    restart,
    start,
    repair,
    saveConfig,
    test,
    fetchLogs,
    addPlaylist,
    syncNow,
  };
}
