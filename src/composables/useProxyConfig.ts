import { reactive, ref, watch, nextTick } from 'vue';

// The durable video-engine proxy config (Settings → Advanced for the (Default), the playlist drawer for a
// (Custom) per-playlist override). Mirrors useSettings.ts's hydrate-guard + 500 ms debounced auto-PUT, but as
// a FACTORY (there are N configs, not one singleton): useProxyConfig(id) returns reactive state scoped to that
// id ('app' = Default, 'app_<playlistId>' = Custom) with no save button — edits auto-persist.
//
// The route upserts, so a first edit of a not-yet-existing Custom row CREATES it; the drawer instead seeds a
// new Custom as a COPY of the current Default via createCustomFromDefault (below) so it starts populated, then
// mounts the panel. See server/src/routes/proxyConfigs.ts + models/ProxyConfig.ts.

export interface ProxyConfigState {
  connectTimeoutMs: number; // LIVE in P2 (Rust upstream client connect timeout)
  readTimeoutMs: number | null; // LIVE (P3.1/RSL — idle/read timeout enforced per-stream)
  bufferSizeKb: number | null; // LIVE (P3.1/RSL — bounded upstream→client read-ahead buffer)
  maxRedirects: number; // LIVE in P2 (Rust upstream redirect cap)
  headerOverrides: Record<string, string>; // LIVE in P2 (merged into the grant's upstream headers)
  outputFormat: string; // LIVE (P3.2/DST) — 'hls' (segmented) | 'ts' (continuous raw MPEG-TS, ext mount); enc/fMP4→HLS
  segmentCacheTtlSec: number | null; // reserved (the only unapplied knob)
}

export type ProxyConfigSaveState = 'idle' | 'saving' | 'saved' | 'error';

// Client-side defaults — mirror the server envDefaults so a brief pre-hydrate render (and a Custom row that
// inherits the Default) looks right.
export function proxyConfigDefaults(): ProxyConfigState {
  return {
    connectTimeoutMs: 15000,
    readTimeoutMs: null,
    bufferSizeKb: null,
    maxRedirects: 10,
    headerOverrides: {},
    outputFormat: 'hls',
    segmentCacheTtlSec: null,
  };
}

// Coerce a raw API response into a full ProxyConfigState (defaults fill any missing/wrong-typed field).
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
  let hydrated = false; // guards the load-triggered watcher fire so hydration doesn't echo a PUT
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function load(): Promise<void> {
    loading.value = true;
    hydrated = false;
    try {
      const res = await fetch(url(id));
      if (res.ok) Object.assign(state, normalize(await res.json()));
      // A 404 (a Custom row that doesn't exist yet) leaves the defaults in place; the first edit upserts it.
    } catch {
      // Best-effort — defaults stand if the API is unreachable.
    } finally {
      loading.value = false;
      await nextTick();
      hydrated = true;
    }
  }

  // Debounced PUT of the full state (the route validates + upserts; nulls clear the reserved knobs).
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

// ── Drawer helpers for the (Default)/(Custom) toggle ──────────────────────────────────────────────────────

// Does a Custom override row (app_<playlistId>) exist? A 200 → yes; a 404 → the playlist inherits the Default.
export async function customConfigExists(id: string): Promise<boolean> {
  try {
    const res = await fetch(url(id));
    return res.ok;
  } catch {
    return false;
  }
}

// Toggle a playlist to Custom: seed the new override as a COPY of the current effective Default so it starts
// populated (not env defaults), then it's ready for the panel to edit.
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

// Toggle a playlist back to the Default: delete its override row.
export async function deleteCustomConfig(id: string): Promise<boolean> {
  try {
    const res = await fetch(url(id), { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}
