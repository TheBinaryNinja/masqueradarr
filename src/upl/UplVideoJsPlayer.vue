<script setup lang="ts">
import { ref, toRef, onMounted, onBeforeUnmount, watch } from 'vue';
import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import Icon from '../components/Icon.vue';
import { useAppStreamSource } from '../composables/useAppStreamSource';

const props = defineProps<{ src: string | null }>();
interface QualityOption { index: number; label: string; active: boolean }

const emit = defineEmits<{
  (e: 'resolution', res: string): void;
  (e: 'engine', kind: 'vhs' | 'native'): void;
  (e: 'stats', s: { bitrateKbps: number | null; bufferSec: number; dropped: number }): void;
  (e: 'levels', l: QualityOption[]): void;
}>();

const host = ref<HTMLElement | null>(null);
let player: any = null;
let sampler: number | undefined;

const playbackError = ref<string | null>(null);
const engine = ref<'vhs' | 'native'>('native');

const isMuted = ref(false);
const policyMuted = ref(false);

const { gatedSrc, reload } = useAppStreamSource(toRef(props, 'src'));

const AUDIO_PREF_KEY = 'upl:audio';

function loadAudioPref(): { muted: boolean; volume: number } {
  try {
    const raw = localStorage.getItem(AUDIO_PREF_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { muted?: unknown; volume?: unknown };
      const v = typeof p.volume === 'number' && p.volume >= 0 && p.volume <= 1 ? p.volume : 1;
      return { muted: p.muted === true, volume: v };
    }
  } catch {   }
  return { muted: false, volume: 1 };
}

function saveAudioPref(): void {
  if (!player) return;
  try {
    localStorage.setItem(AUDIO_PREF_KEY, JSON.stringify({ muted: !!player.muted(), volume: player.volume() }));
  } catch {   }
}

const MAX_NET_RETRIES = 3;
let netAttempts = 0;

let playGen = 0;

function applySrc(): void {
  if (!player || !gatedSrc.value) return;
  playbackError.value = null;
  player.src({ src: gatedSrc.value, type: 'application/x-mpegURL' });
  void attemptPlay();
}

async function attemptPlay(): Promise<void> {
  if (!player) return;
  const gen = ++playGen;
  try {
    await player.play();
  } catch {
    if (gen !== playGen || !player || player.muted()) return;
    policyMuted.value = true;
    player.muted(true);
    try { await player.play(); } catch {   }
  }
}

function unmute(): void {
  if (!player) return;
  policyMuted.value = false;
  player.muted(false);
  if (player.volume() === 0) player.volume(1);
  const p = player.play();
  if (p && typeof p.catch === 'function') p.catch(() => {   });
}

function toggleMute(): void {
  if (!player) return;
  if (player.muted() || player.volume() === 0) unmute();
  else player.muted(true);
}

function retry(): void {
  netAttempts = 0;
  playbackError.value = null;
  reload();
}

function onError(): void {
  const err = player?.error?.();
  const code = err?.code;
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

function selectLevel(index: number): void {
  const ql = player?.qualityLevels?.();
  if (!ql) return;
  for (let i = 0; i < ql.length; i++) ql[i].enabled = index < 0 || i === index;
  refreshLevels();
}
defineExpose({ selectLevel, toggleMute });

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

  if (bufferSec > 1 && !el?.paused) { netAttempts = 0; if (playbackError.value) playbackError.value = null; }
}

onMounted(() => {
  const el = document.createElement('video');
  el.className = 'video-js vjs-big-play-centered';
  el.setAttribute('playsinline', '');
  host.value?.appendChild(el);

  const pref = loadAudioPref();

  player = videojs(el, {
    controls: true,
    autoplay: false,
    muted: pref.muted,
    playsinline: true,
    preload: 'auto',
    fill: true,
    liveui: true,
    userActions: { hotkeys: false },
    html5: {
      nativeAudioTracks: false,
      nativeVideoTracks: false,
      vhs: {
        overrideNative: !videojs.browser.IS_ANY_SAFARI,
        cacheEncryptionKeys: true,
        limitRenditionByPlayerDimensions: false,
      },
    },
  });

  player.volume(pref.volume);
  isMuted.value = !!player.muted();

  player.on('volumechange', () => {
    isMuted.value = !!player.muted();
    if (policyMuted.value && isMuted.value) return;
    policyMuted.value = false;
    saveAudioPref();
  });

  player.on('error', onError);
  player.on('loadedmetadata', () => {
    reportResolution();
    refreshLevels();
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

watch(gatedSrc, (u) => {
  netAttempts = 0;
  if (u) applySrc();
});

onBeforeUnmount(() => {
  if (sampler !== undefined) window.clearInterval(sampler);
  try { player?.dispose(); } catch {   }
  player = null;
});
</script>

<template>
  <div class="upl-video" ref="host">
    <button v-if="isMuted" type="button" class="upl-video-unmute mono" @click="unmute">
      <Icon name="mute" :size="14" />
      <span>{{ policyMuted ? 'Sound blocked by the browser — click to unmute' : 'Muted — click for sound' }}</span>
    </button>

    <div v-if="playbackError" class="upl-video-error mono">
      <span>{{ playbackError }}</span>
      <button type="button" class="upl-video-retry mono" @click="retry">Retry</button>
    </div>
  </div>
</template>

<style scoped>
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

.upl-video-unmute {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 11px;
  font-size: 11px;
  color: #fff;
  background: oklch(0.16 0.006 240 / 0.86);
  backdrop-filter: blur(10px) saturate(140%);
  -webkit-backdrop-filter: blur(10px) saturate(140%);
  border: 1px solid var(--accent);
  border-radius: var(--radius-s);
  cursor: pointer;
}
.upl-video-unmute:hover { color: var(--accent-hi); border-color: var(--accent-hi); }

.upl-video-error {
  position: absolute;
  inset: auto 8px 44px 8px;
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
