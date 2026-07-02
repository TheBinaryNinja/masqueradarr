<script setup lang="ts">
// Settings → Video Configuration card. Configures the externalPlayer ffmpeg engine that serves third-party
// IPTV-client (TiviMate/Kodi/VLC/…) sessions through /api/ext (always on — no engine selector, no enable
// toggle). The in-app slide-out player (appPlayer) is unaffected. Edits persist live via useVideoConfig
// (debounced PUT /api/video-config).
import { computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Toggle from './Toggle.vue';
import Segmented from './Segmented.vue';
import { useVideoConfig } from '../composables/useVideoConfig';
import { FFMPEG_PRESETS, type VideoPreset } from '../composables/videoPresets';
import { VIDEO_ADDONS } from '../composables/videoAddons';

// configId: which videoconfig doc this panel edits — 'app' (the global Default, on Settings) or
// 'app_<playlistId>' (a per-playlist Custom config embedded in the playlist editor). bare: drop the outer
// card + heading chrome for embedding.
const props = withDefaults(defineProps<{ configId?: string; bare?: boolean; diagramOpen?: boolean }>(), { configId: 'app', bare: false, diagramOpen: false });
// The Settings instance (!bare) hosts the "Encoder Diagram" toggle; the split-pane state lives in the parent.
const emit = defineEmits<{ (e: 'toggle-diagram'): void }>();

const {
  videoMode, videoOutput, extPickyOverride, freezeDetect, addons,
  ffmpegPreset, ffmpegArgs,
  hwEnabled, hwEncoder, hwDetected,
  loadVideoConfig,
} = useVideoConfig(props.configId);

onMounted(loadVideoConfig);

// HW-encoder presets are usable once HW accel is enabled (the card gates them on detection).
const canUseHw = computed(() => hwEnabled.value);

// Addons = MULTI-SELECT ad-break resilience flag-splices (server composes them on top of advancedArgs). Toggle
// membership immutably so the useVideoConfig shallow watch fires the debounced PUT. A selection that doesn't
// apply to the current Output is greyed (and ignored server-side by composeAddonArgs), but kept so it
// reactivates when Output returns.
function toggleAddon(id: string): void {
  addons.value = addons.value.includes(id) ? addons.value.filter((x) => x !== id) : [...addons.value, id];
}
// Read-only preview of the flags the currently-selected + applicable addons add (display only; the server is
// the composer of record).
const effectiveAddonFlags = computed(() =>
  VIDEO_ADDONS.filter((a) => addons.value.includes(a.id) && a.appliesTo.includes(videoOutput.value))
    .map((a) => a.flagsPreview)
    .join('  '),
);

// Apply a preset: populate the Advanced input with its raw syntax, record the preset name, and align the
// output format to what the preset produces (HLS loopback vs raw-TS).
function applyPreset(p: VideoPreset): void {
  ffmpegArgs.value = p.args;
  ffmpegPreset.value = p.name;
  videoOutput.value = p.output;
}

const encoderOptions = computed(() => ['none', ...hwDetected.value]);
</script>

<template>
  <div :class="{ card: !bare }">
    <template v-if="!bare">
      <div class="row" style="align-items: center; gap: 10px; margin-bottom: var(--gap);">
        <h3 class="section-title" style="margin: 0;">Video Configuration</h3>
        <span class="spacer" />
        <Btn :variant="diagramOpen ? 'primary' : 'ghost'" size="sm" icon="topology"
             title="Visualize configs ↔ the playlists using them" @click="emit('toggle-diagram')">Encoder Diagram</Btn>
      </div>
      <div class="muted" style="font-size: var(--fs-xs); margin-top: -6px; margin-bottom: 14px;">
        The <b>external player</b> ffmpeg engine. Stream sessions opened by third-party IPTV clients (TiviMate,
        Kodi, VLC, …) through the <span class="mono">/api/ext</span> playlist URLs are always routed through
        ffmpeg so the server can transcode and capture loading / buffering / failed state + technical details.
        The in-app player is unaffected.
      </div>
    </template>

    <div style="border: 1px solid var(--hairline); border-radius: 10px; padding: 12px; background: var(--bg-2);">
      <div class="muted" style="font-size: var(--fs-xs); margin-bottom: 10px;">
        <Icon name="check" :size="12" /> ffmpeg gives clean machine-readable health (the <span class="mono">-progress</span>
        stream). Every external session is served through it.
      </div>

      <!-- Presets -->
      <div class="field-lbl" style="margin-bottom: 8px;">Presets</div>
      <div class="row" style="flex-wrap: wrap; gap: 6px; margin-bottom: 12px;">
        <Btn v-for="p in FFMPEG_PRESETS" :key="p.name"
             :variant="ffmpegPreset === p.name ? 'primary' : 'ghost'" size="sm"
             :disabled="p.needsHw && !canUseHw"
             :title="p.hint"
             @click="applyPreset(p)">
          {{ p.name }}<span v-if="p.needsHw" class="mono muted" style="margin-left: 4px;">· HW</span>
        </Btn>
      </div>

      <!-- Advanced single-line syntax (the operative driver) -->
      <div class="field-lbl" style="margin-bottom: 6px;">Advanced</div>
      <div class="input mono" style="font-size: 11px;">
        <input v-model="ffmpegArgs" spellcheck="false" placeholder="Raw ffmpeg syntax" />
      </div>
      <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
        Raw ffmpeg syntax — this string drives the stream. Placeholders
        <span class="mono">&lt;INPUT&gt; &lt;UA&gt; &lt;OUTDIR&gt; &lt;M3U8&gt; &lt;SEG&gt;</span> are substituted at run time.
      </div>
    </div>

    <div class="divider" style="margin: 16px 0 14px;" />

    <div class="row" style="gap: var(--gap); align-items: flex-start; flex-wrap: wrap;">
      <div class="form-row" style="flex: 0 0 auto; min-width: 150px;">
        <div class="field-lbl">Processing mode</div>
        <Segmented :value="videoMode" @change="(v) => videoMode = v as any" :options="[
          { value: 'auto', label: 'Auto' },
          { value: 'copy', label: 'Copy' },
          { value: 'transcode', label: 'Transcode' },
        ]" />
        <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
          Auto = copy when the source is browser-safe, transcode otherwise.
        </div>
      </div>
      <div class="form-row" style="flex: 0 0 auto; min-width: 150px;">
        <div class="field-lbl">Output</div>
        <Segmented :value="videoOutput" @change="(v) => videoOutput = v as any" :options="[
          { value: 'hls', label: 'HLS' },
          { value: 'ts', label: 'Raw TS' },
        ]" />
        <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
          HLS reuses the full telemetry stack; Raw TS is the classic IPTV link for raw-only clients.
        </div>
      </div>
      <!-- Addon: MULTI-SELECT resilience flag-splices, to the right of Output. Chips toggle independently;
           greyed when they don't apply to the current Output. Composed server-side on top of advancedArgs. -->
      <div class="form-row" style="flex: 1 1 260px; min-width: 260px;">
        <div class="field-lbl">Addon</div>
        <div class="row" style="flex-wrap: wrap; gap: 6px;">
          <Btn v-for="a in VIDEO_ADDONS" :key="a.id"
               :variant="addons.includes(a.id) ? 'primary' : 'ghost'" size="sm"
               :disabled="!a.appliesTo.includes(videoOutput)"
               :title="a.appliesTo.includes(videoOutput) ? a.description : a.description + ' — not applicable to ' + videoOutput.toUpperCase() + ' output'"
               @click="toggleAddon(a.id)">{{ a.label }}</Btn>
        </div>
        <div class="muted mono" style="font-size: 10px; margin-top: 6px; word-break: break-all;">
          Adds: {{ effectiveAddonFlags || '—' }}
        </div>
      </div>
    </div>

    <div class="divider" style="margin: 16px 0 14px;" />

    <!-- ExtPicky Override (ffmpeg-only): disable extension_picky so disguised-extension segments parse. -->
    <div class="field-lbl" style="margin-bottom: 4px;">ExtPicky Override</div>
    <div class="muted" style="font-size: var(--fs-xs); margin-bottom: 10px;">
      Allow non-standard HLS segment extensions by disabling ffmpeg's <span class="mono">extension_picky</span>
      check. Needed for sources that disguise their MPEG-TS segments as <span class="mono">.js</span> /
      <span class="mono">.jpg</span> (e.g. <b>dlhd</b>) — enable on that playlist's Custom config if its external
      stream fails with “Invalid data found”. ffmpeg only; the in-app player is unaffected.
    </div>
    <div class="row" style="gap: 14px; align-items: center;">
      <Toggle :on="extPickyOverride" @change="(v) => extPickyOverride = v" />
      <span class="muted" style="font-size: var(--fs-xs);">Disable ffmpeg segment-extension filtering</span>
    </div>

    <!-- Freeze detection (ffmpeg-only): spawn a decode-only freezedetect tap so frozen pictures register as
         buffering. Per-playlist, like ExtPicky Override above (the Default config covers playlists without a Custom one). -->
    <div class="divider" style="margin: 16px 0 14px;" />
    <div class="field-lbl" style="margin-bottom: 4px;">Freeze detection</div>
    <div class="muted" style="font-size: var(--fs-xs); margin-bottom: 10px;">
      Mark a stream as <b>buffering</b> when the picture freezes for 2&nbsp;s or more (a stuck slate / hung
      encoder where data keeps flowing but the image is static). Adds a lightweight per-stream
      <span class="mono">freezedetect</span> analysis pass (decode only — the served stream is untouched), so
      it costs some extra CPU. Applies to external sessions using this configuration. ffmpeg only; the in-app
      player is unaffected.
    </div>
    <div class="row" style="gap: 14px; align-items: center;">
      <Toggle :on="freezeDetect" @change="(v) => freezeDetect = v" />
      <span class="muted" style="font-size: var(--fs-xs);">Detect frozen video</span>
    </div>

    <div class="divider" style="margin: 16px 0 14px;" />

    <div class="field-lbl" style="margin-bottom: 4px;">Hardware acceleration</div>
    <div class="muted" style="font-size: var(--fs-xs); margin-bottom: 10px;">
      Offload transcoding to a GPU (NVENC / QSV / VAAPI). Detected on this host:
      <span class="mono">{{ hwDetected.length ? hwDetected.join(', ') : 'none' }}</span>.
    </div>
    <div class="row" style="gap: 14px; align-items: center;">
      <Toggle :on="hwEnabled" @change="(v) => hwEnabled = v" />
      <div class="select fill" style="max-width: 240px;" :style="{ opacity: hwEnabled ? 1 : 0.5 }">
        <select v-model="hwEncoder" :disabled="!hwEnabled">
          <option v-for="e in encoderOptions" :key="e" :value="e">{{ e }}</option>
        </select>
      </div>
    </div>
  </div>
</template>
