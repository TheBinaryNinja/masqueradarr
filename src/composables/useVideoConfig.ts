import { ref, watch, nextTick, type Ref } from 'vue';
import { bus } from './bus';

// externalPlayer engine config. A FACTORY: useVideoConfig(configId) binds one reactive config to
// GET/PUT /api/video-config/<configId> — 'app' is the global Default (Settings → Video Configuration card),
// 'app_<playlistId>' is a per-playlist Custom config (the playlist editor). Each instance has its OWN refs,
// hydration guard, and debounced PUT — the same shape as before, just no longer a module-level singleton. The
// OPERATIVE field is `ffmpeg.advancedArgs` (the raw ffmpeg syntax the server spawns with); presets just
// populate it. ffmpeg is the always-on external engine (no engine selector, no enable toggle). Loaded lazily
// by the card/drawer (admin-only config; not part of the global bootstrap).

export type VideoMode = 'auto' | 'copy' | 'transcode';
export type VideoOutput = 'hls' | 'ts';

// hwDetected is HOST-GLOBAL (boot-detected encoders) — identical for every config doc — so it lives at module
// level, loaded ONCE from the 'app' config, and is shared by every useVideoConfig() instance. A per-playlist
// doc carries a copied snapshot, but we always source detected[] from 'app' to avoid per-doc staleness.
export const hwDetected = ref<string[]>([]);
let hwLoaded = false;
async function loadHwDetected(): Promise<void> {
  if (hwLoaded) return;
  hwLoaded = true;
  try {
    const res = await fetch('/api/video-config/app');
    if (res.ok) {
      const c = await res.json();
      hwDetected.value = c.hwAccel?.detected ?? [];
    }
  } catch {
    /* best-effort: an empty list just hides the HW presets/encoders */
  }
}

export interface VideoConfigInstance {
  videoMode: Ref<VideoMode>;
  videoOutput: Ref<VideoOutput>;
  extPickyOverride: Ref<boolean>; // ffmpeg `-extension_picky 0` toggle (disguised-extension sources e.g. dlhd)
  freezeDetect: Ref<boolean>; // per-playlist ffmpeg freezedetect tap → frozen-content buffer state
  addons: Ref<string[]>; // selected externalPlayer addon ids (ad-break resilience flag-splices); multi-select
  ffmpegPreset: Ref<string>;
  ffmpegArgs: Ref<string>;
  hwEnabled: Ref<boolean>;
  hwEncoder: Ref<string>;
  hwDetected: Ref<string[]>; // the shared host-global ref (same object for every instance)
  loadVideoConfig: () => Promise<void>;
}

export function useVideoConfig(configId: string = 'app'): VideoConfigInstance {
  const videoMode = ref<VideoMode>('auto');
  const videoOutput = ref<VideoOutput>('hls');
  const extPickyOverride = ref(false); // add `-extension_picky 0` for disguised-extension segments
  const freezeDetect = ref(true); // per-playlist: spawn the decode-only freezedetect tap (frozen content) — default ON
  const addons = ref<string[]>([]); // selected addon ids (multi-select; default OFF/opt-in)
  const ffmpegPreset = ref('Remux / Copy (lowest CPU)');
  const ffmpegArgs = ref('');
  const hwEnabled = ref(false);
  const hwEncoder = ref('none');

  const url = `/api/video-config/${encodeURIComponent(configId)}`;
  let hydrated = false;

  async function loadVideoConfig(): Promise<void> {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const c = await res.json();
      videoMode.value = c.mode ?? 'auto';
      videoOutput.value = c.output ?? 'hls';
      extPickyOverride.value = !!c.extPickyOverride;
      freezeDetect.value = !!c.freezeDetect;
      addons.value = Array.isArray(c.addons) ? c.addons : [];
      if (c.ffmpeg) { ffmpegPreset.value = c.ffmpeg.preset ?? ffmpegPreset.value; ffmpegArgs.value = c.ffmpeg.advancedArgs ?? ''; }
      if (c.hwAccel) {
        hwEnabled.value = !!c.hwAccel.enabled;
        hwEncoder.value = c.hwAccel.encoder ?? 'none';
        if (configId === 'app') hwDetected.value = c.hwAccel.detected ?? []; // 'app' is the host-global source of truth
      }
      if (configId !== 'app') void loadHwDetected(); // a per-playlist panel sources detected[] from 'app', not its snapshot
    } catch {
      /* best-effort: defaults stand if the API is unreachable */
    } finally {
      await nextTick(); // let hydration-triggered watchers flush (guard still false → no echo PUT) before arming
      hydrated = true;
    }
  }

  // Debounced PUT. Accumulates patches with a one-level-deep merge so a ffmpeg.preset edit and a
  // ffmpeg.advancedArgs edit in the same window don't clobber each other (the validator reads the nested body).
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: Record<string, any> = {};
  function mergeInto(target: Record<string, any>, patch: Record<string, any>): void {
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        target[k] = { ...(target[k] || {}), ...v };
      } else {
        target[k] = v;
      }
    }
  }
  function persist(patch: Record<string, any>): void {
    if (!hydrated) return;
    mergeInto(pending, patch);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const body = pending;
      pending = {};
      fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        // Signal a live config view (the Encoder Diagram) to re-read — naturally throttled by the debounce.
        .then((r) => { if (r.ok) bus.emit('tvapp:videoconfig-saved', { configId }); })
        .catch(() => undefined);
    }, 500);
  }

  watch(videoMode, (v) => persist({ mode: v }));
  watch(videoOutput, (v) => persist({ output: v }));
  watch(extPickyOverride, (v) => persist({ extPickyOverride: v }));
  watch(freezeDetect, (v) => persist({ freezeDetect: v }));
  watch(addons, (v) => persist({ addons: v })); // toggleAddon replaces the array immutably → shallow watch fires
  watch(ffmpegPreset, (v) => persist({ ffmpeg: { preset: v } }));
  watch(ffmpegArgs, (v) => persist({ ffmpeg: { advancedArgs: v } }));
  watch(hwEnabled, (v) => persist({ hwAccel: { enabled: v } }));
  watch(hwEncoder, (v) => persist({ hwAccel: { encoder: v } }));

  return {
    videoMode, videoOutput, extPickyOverride, freezeDetect, addons,
    ffmpegPreset, ffmpegArgs,
    hwEnabled, hwEncoder, hwDetected,
    loadVideoConfig,
  };
}
