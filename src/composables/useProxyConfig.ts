import { reactive, ref, watch, nextTick } from 'vue';


export interface ProxyConfigState {
  connectTimeoutMs: number;
  readTimeoutMs: number | null;
  bufferSizeKb: number | null;
  maxRedirects: number;
  headerOverrides: Record<string, string>;
  outputFormat: string;
  streamInfRedux: boolean;
  failoverEnabled: boolean;
  failoverOnDefiniteError: boolean;
  segmentCacheTtlSec: number | null;
  originEnabled: boolean;
  originRingMb: number;
  spliceNormalize: boolean;
}

export type ProxyConfigSaveState = 'idle' | 'saving' | 'saved' | 'error';

export function proxyConfigDefaults(): ProxyConfigState {
  return {
    connectTimeoutMs: 15000,
    readTimeoutMs: null,
    bufferSizeKb: 1024,
    maxRedirects: 10,
    headerOverrides: {},
    outputFormat: 'hls',
    streamInfRedux: false,
    failoverEnabled: true,
    failoverOnDefiniteError: false,
    segmentCacheTtlSec: null,
    originEnabled: false,
    originRingMb: 25,
    spliceNormalize: true,
  };
}

function normalize(raw: unknown): ProxyConfigState {
  const d = proxyConfigDefaults();
  const s = (raw ?? {}) as Partial<ProxyConfigState>;
  return {
    connectTimeoutMs: typeof s.connectTimeoutMs === 'number' ? s.connectTimeoutMs : d.connectTimeoutMs,
    readTimeoutMs: typeof s.readTimeoutMs === 'number' ? s.readTimeoutMs : null,
    bufferSizeKb: typeof s.bufferSizeKb === 'number' ? s.bufferSizeKb : null,
    maxRedirects: typeof s.maxRedirects === 'number' ? s.maxRedirects : d.maxRedirects,
    headerOverrides:
      s.headerOverrides && typeof s.headerOverrides === 'object' && !Array.isArray(s.headerOverrides)
        ? { ...(s.headerOverrides as Record<string, string>) }
        : {},
    outputFormat: typeof s.outputFormat === 'string' ? s.outputFormat : d.outputFormat,
    streamInfRedux: typeof s.streamInfRedux === 'boolean' ? s.streamInfRedux : false,
    originEnabled: typeof s.originEnabled === 'boolean' ? s.originEnabled : d.originEnabled,
    originRingMb: typeof s.originRingMb === 'number' ? s.originRingMb : d.originRingMb,
    spliceNormalize: typeof s.spliceNormalize === 'boolean' ? s.spliceNormalize : d.spliceNormalize,
    failoverEnabled: typeof s.failoverEnabled === 'boolean' ? s.failoverEnabled : true,
    failoverOnDefiniteError:
      typeof s.failoverOnDefiniteError === 'boolean' ? s.failoverOnDefiniteError : false,
    segmentCacheTtlSec: typeof s.segmentCacheTtlSec === 'number' ? s.segmentCacheTtlSec : null,
  };
}

function url(id: string): string {
  return `/api/proxy-configs/${encodeURIComponent(id)}`;
}

export function useProxyConfig(id: string) {
  const state = reactive<ProxyConfigState>(proxyConfigDefaults());
  const loading = ref(true);
  const saveState = ref<ProxyConfigSaveState>('idle');
  let hydrated = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function load(): Promise<void> {
    loading.value = true;
    hydrated = false;
    try {
      const res = await fetch(url(id));
      if (res.ok) Object.assign(state, normalize(await res.json()));
    } catch {
    } finally {
      loading.value = false;
      await nextTick();
      hydrated = true;
    }
  }

  function persist(): void {
    if (!hydrated) return;
    if (timer) clearTimeout(timer);
    saveState.value = 'saving';
    timer = setTimeout(async () => {
      try {
        const res = await fetch(url(id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...state, headerOverrides: { ...state.headerOverrides } }),
        });
        saveState.value = res.ok ? 'saved' : 'error';
      } catch {
        saveState.value = 'error';
      }
      setTimeout(() => {
        if (saveState.value !== 'saving') saveState.value = 'idle';
      }, 1600);
    }, 500);
  }

  watch(state, persist, { deep: true });

  return { state, loading, saveState, load };
}


export async function customConfigExists(id: string): Promise<boolean> {
  try {
    const res = await fetch(url(id));
    return res.ok;
  } catch {
    return false;
  }
}

export async function createCustomFromDefault(id: string): Promise<boolean> {
  try {
    const res = await fetch(url('app'));
    const base = res.ok ? normalize(await res.json()) : proxyConfigDefaults();
    const put = await fetch(url(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(base),
    });
    return put.ok;
  } catch {
    return false;
  }
}

export async function deleteCustomConfig(id: string): Promise<boolean> {
  try {
    const res = await fetch(url(id), { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}
