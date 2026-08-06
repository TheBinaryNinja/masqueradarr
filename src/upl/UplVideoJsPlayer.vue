<script setup lang="ts">
// UplVideoJsPlayer — the Ultimate Player's media engine: Video.js v8 + VHS (@videojs/http-streaming).
//
// Distinct from the in-drawer players on purpose. VidstackPlayer/DebugHlsPlayer drive hls.js; this drives
// Video.js's own VHS. Consequence to keep in mind: the repo now carries TWO HLS engines, so a playback bug
// may need fixing in both places, and this player is not a like-for-like A/B against the in-app one.
//
// PER-BROWSER BEHAVIOUR — the accepted tradeoff of choosing Video.js, surfaced rather than hidden:
//   - Chromium (Chrome/Edge/Brave/Opera) + Firefox → VHS over MSE. One identical JS engine: manifest
//     parsing, ABR, AES-128 decryption, buffering, error handling.
//   - Safari (desktop AND iOS)                     → the browser's NATIVE HLS. VHS defaults overrideNative
//     to true *except* on Safari and its README recommends native there; forcing it hits videojs#9117
//     (open, v8.23.4: currentSource() comes back empty → "no source supported"). So
//     `!videojs.browser.IS_ANY_SAFARI` is the correct setting, not a workaround to remove later.
// The `engine` emit reports which path is live so the UI can say so out loud, and the feature deltas
// (no quality levels, no bandwidth stats on native) degrade to explicit "unavailable" states.
//
// Token handling is delegated to useAppStreamSource — do NOT re-implement it. It appends ?token= to the
// MANIFEST url; the Rust proxy re-embeds that same query onto every segment and EXT-X-KEY URI it rewrites,
// so segment + AES key fetches authenticate themselves whichever engine is doing the fetching.
import { ref, toRef, onMounted, onBeforeUnmount, watch } from 'vue';
import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import { useAppStreamSource } from '../composables/useAppStreamSource';

const props = defineProps<{ src: string | null }>();
interface QualityOption { index: number; label: string; active: boolean }

const emit = defineEmits<{
  (e: 'resolution', res: string): void;
  (e: 'engine', kind: 'vhs' | 'native'): void;
  (e: 'stats', s: { bitrateKbps: number | null; bufferSec: number; dropped: number }): void;
  (e: 'levels', l: QualityOption[]): void;
}>();

// Video.js's own types describe the element-bound API loosely in places (tech().vhs is untyped, as are the
// quality-level lists), and the repo is strict:false — `any` here matches VidstackPlayer.vue's precedent.
const host = ref<HTMLElement | null>(null);
let player: any = null;
let sampler: number | undefined;

const playbackError = ref<string | null>(null);
const engine = ref<'vhs' | 'native'>('native');

const { gatedSrc, reload } = useAppStreamSource(toRef(props, 'src'));

// Capped recovery, mirroring VidstackPlayer.vue's policy so both players fail the same way: retry a network
// failure up to 3× by re-sourcing, then surface it. Reset once playback is demonstrably healthy again.
const MAX_NET_RETRIES = 3;
let netAttempts = 0;

function applySrc(): void {
  if (!player || !gatedSrc.value) return;
  playbackError.value = null;
  player.src({ src: gatedSrc.value, type: 'application/x-mpegURL' });
  const p = player.play();
  if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay interrupted; controls remain */ });
}

function retry(): void {
  netAttempts = 0;
  playbackError.value = null;
  reload(); // re-emits gatedSrc → the watcher below re-sources even for an identical URL
}

function onError(): void {
  const err = player?.error?.();
  const code = err?.code;
  // MEDIA_ERR_NETWORK (2) and MEDIA_ERR_SRC_NOT_SUPPORTED (4) are the recoverable shapes for a live stream
  // whose upstream blipped; DECODE (3) is not worth hammering. VHS surfaces its own failures through the
  // same player error, so one branch covers both engines.
  const recoverable = code === 2 || code === 4;
  if (recoverable && netAttempts < MAX_NET_RETRIES) {
    netAttempts++;
    playbackError.value = null;
    applySrc();
    return;
  }
  playbackError.value = err?.message ? `Playback error · ${err.message}` : 'Playback error';
}

function reportResolution(): void {
  const h = player?.videoHeight?.();
  if (!h || Number.isNaN(h)) return;
  emit('resolution', `${h}p`);
}

// Rebuild the quality menu from the QualityLevelList that videojs-contrib-quality-levels (a bundled
// dependency of video.js 8 — no extra plugin needed) populates from the HLS renditions. Empty on Safari's
// native path, which is exactly why the UI renders an explicit "Auto (native)" instead of an empty menu.
function refreshLevels(): void {
  const ql = player?.qualityLevels?.();
  if (!ql || ql.length === 0) { emit('levels', []); return; }
  const out: QualityOption[] = [];
  for (let i = 0; i < ql.length; i++) {
    const l = ql[i];
    out.push({
      index: i,
      label: l.height ? `${l.height}p` : `${Math.round((l.bitrate ?? 0) / 1000)} kbps`,
      active: i === ql.selectedIndex,
    });
  }
  emit('levels', out);
}

// Pick a rendition, or -1 for ABR. Enabling exactly one level pins it; enabling all restores ABR. Exposed
// so the shell can own the picker UI — Video.js's default control bar has no quality selector of its own.
//
// The change registers immediately (the QualityLevelList's selectedIndex moves) but is only VISIBLE once the
// already-buffered segments play out — with a healthy live buffer that can be the better part of a minute.
// That is MSE working as intended, not a stuck control: VHS appends the new rendition at the end of the
// buffer rather than flushing it. Deliberately not "fixed" by seeking, which on a live stream risks dropping
// the viewer off the live edge.
function selectLevel(index: number): void {
  const ql = player?.qualityLevels?.();
  if (!ql) return;
  for (let i = 0; i < ql.length; i++) ql[i].enabled = index < 0 || i === index;
  refreshLevels();
}
defineExpose({ selectLevel });

// 500ms health sampler, modelled on DebugHlsPlayer.vue's. VHS exposes measured bandwidth; native HLS does
// not, so bitrate reports null there and the UI shows an em-dash rather than a fabricated number.
function sample(): void {
  if (!player) return;
  const vhs = player.tech?.({ IWillNotUseThisInPlugins: true })?.vhs;
  const el: HTMLVideoElement | undefined = player.el?.()?.querySelector('video') ?? undefined;

  let bufferSec = 0;
  if (el && el.buffered.length > 0) {
    const t = el.currentTime;
    for (let i = 0; i < el.buffered.length; i++) {
      if (el.buffered.start(i) <= t && t <= el.buffered.end(i)) { bufferSec = el.buffered.end(i) - t; break; }
    }
  }
  const dropped = el?.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0;
  const bw = vhs?.stats?.bandwidth;
  const bitrateKbps = typeof bw === 'number' && bw > 0 ? Math.round(bw / 1000) : null;

  emit('stats', { bitrateKbps, bufferSec, dropped });

  // Healthy playback clears the retry budget and any stale error banner.
  if (bufferSec > 1 && !el?.paused) { netAttempts = 0; if (playbackError.value) playbackError.value = null; }
}

onMounted(() => {
  // Create the <video> imperatively inside a wrapper div rather than putting it in the template: Video.js
  // replaces the element with its own .video-js container, and Vue must never try to diff a node the player
  // owns. (The documented Vue example binds a ref directly to <video>; the wrapper is the hardened variant.)
  const el = document.createElement('video');
  el.className = 'video-js vjs-big-play-centered';
  el.setAttribute('playsinline', '');
  host.value?.appendChild(el);

  player = videojs(el, {
    controls: true,
    autoplay: 'muted',
    muted: true,
    playsinline: true,
    preload: 'auto',
    fill: true,          // fill the flex area the shell gives us, not a fixed aspect box
    liveui: true,        // live-window seek bar + LIVE edge indicator
    userActions: { hotkeys: false }, // UplApp owns one keymap; two would fight
    html5: {
      nativeAudioTracks: false,
      nativeVideoTracks: false,
      vhs: {
        // See the PER-BROWSER BEHAVIOUR note at the top of this file.
        overrideNative: !videojs.browser.IS_ANY_SAFARI,
        cacheEncryptionKeys: true,       // reuse AES-128 keys instead of refetching per segment
        limitRenditionByPlayerDimensions: false, // never cap quality to a small popup
      },
    },
  });

  player.on('error', onError);
  player.on('loadedmetadata', () => {
    reportResolution();
    refreshLevels();
    // tech().vhs only exists when VHS is driving — the authoritative engine check.
    const isVhs = !!player.tech?.({ IWillNotUseThisInPlugins: true })?.vhs;
    engine.value = isVhs ? 'vhs' : 'native';
    emit('engine', engine.value);
  });

  const ql = player.qualityLevels?.();
  if (ql) {
    ql.on('addqualitylevel', refreshLevels);
    ql.on('change', () => { refreshLevels(); reportResolution(); });
  }

  sampler = window.setInterval(sample, 500);
  if (gatedSrc.value) applySrc();
});

// Channel change: re-source the SAME long-lived player instead of remounting the component (which is what
// the drawer's :key="src" does). Tearing down and rebuilding the engine per channel is the slow path; this
// is the point of having a dedicated player window.
watch(gatedSrc, (u) => {
  netAttempts = 0;
  if (u) applySrc();
});

onBeforeUnmount(() => {
  if (sampler !== undefined) window.clearInterval(sampler);
  try { player?.dispose(); } catch { /* already disposed with the element */ }
  player = null;
});
</script>

<template>
  <div class="upl-video" ref="host">
    <div v-if="playbackError" class="upl-video-error mono">
      <span>{{ playbackError }}</span>
      <button type="button" class="upl-video-retry mono" @click="retry">Retry</button>
    </div>
  </div>
</template>

<style scoped>
/* Media component owning irreducible layout + a third-party skin override — the same documented exception
   VidstackPlayer.vue takes. Everything else in this window uses the global --mq-* classes. */
.upl-video {
  position: relative;
  flex: 1;
  min-height: 0;
  background: #000;
}
.upl-video :deep(.video-js) {
  width: 100%;
  height: 100%;
}
/* Re-skin Video.js's default chrome to the masqueradarr palette (oklch throughout, as styles.css does). */
.upl-video :deep(.vjs-control-bar) {
  background: oklch(0.16 0.006 240 / 0.86);
  backdrop-filter: blur(10px) saturate(140%);
  -webkit-backdrop-filter: blur(10px) saturate(140%);
  font-family: var(--mq-font-sans);
}
.upl-video :deep(.vjs-play-progress),
.upl-video :deep(.vjs-volume-level) { background: var(--accent); }
.upl-video :deep(.vjs-load-progress) { background: oklch(1 0 0 / 0.18); }
.upl-video :deep(.vjs-load-progress div) { background: oklch(1 0 0 / 0.1); }
.upl-video :deep(.vjs-big-play-button) {
  border-color: var(--accent);
  background: oklch(0.16 0.006 240 / 0.7);
}
.upl-video :deep(.vjs-slider) { background: oklch(1 0 0 / 0.2); }
.upl-video :deep(.vjs-menu-content) { background: oklch(0.16 0.006 240 / 0.94); }

.upl-video-error {
  position: absolute;
  inset: auto 8px 44px 8px; /* clear of the control bar */
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 9px;
  font-size: 11px;
  color: #fff;
  background: rgba(180, 40, 40, 0.85);
  border-radius: 6px;
}
.upl-video-retry {
  border: 1px solid rgba(255, 255, 255, 0.55);
  background: transparent;
  color: #fff;
  border-radius: 5px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
}
</style>
