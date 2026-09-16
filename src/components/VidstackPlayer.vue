<script setup lang="ts">
import { ref, toRef, onMounted, onBeforeUnmount } from 'vue';
import Hls from 'hls.js';
import 'vidstack/player';
import 'vidstack/player/layouts/default';
import 'vidstack/player/styles/default/theme.css';
import 'vidstack/player/styles/default/layouts/video.css';
import { useAppStreamSource } from '../composables/useAppStreamSource';

const props = defineProps<{ src: string | null }>();
const emit = defineEmits<{ (e: 'resolution', res: string): void }>();

const player = ref<any>(null);

let hasHls = false;

const playbackError = ref<string | null>(null);

const { gatedSrc, reload } = useAppStreamSource(toRef(props, 'src'));

function retry() {
  playbackError.value = null;
  reload();
}

function onError(e: any) {
  if (hasHls) return;
  playbackError.value = e?.detail?.message || 'Playback error';
}

function onProviderChange(e: any) {
  const p = e.detail;
  if (p?.type === 'hls') {
    p.library = Hls;
    p.config = { enableWorker: true, lowLatencyMode: false };
  }
}

function reportResolution() {
  const v = player.value?.provider?.video as HTMLVideoElement | undefined;
  const h = v?.videoHeight;
  if (!h || Number.isNaN(h)) return;
  emit('resolution', `${h}p`);
}

function onHlsInstance(e: any) {
  hasHls = true;
  const hls = e.detail as Hls;
  let netAttempts = 0;
  let mediaFatals = 0;
  hls.on(Hls.Events.FRAG_BUFFERED, () => {
    netAttempts = 0;
    mediaFatals = 0;
    playbackError.value = null;
  });
  hls.on(Hls.Events.ERROR, (_t, d) => {
    if (!d.fatal) return;
    if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
      if (netAttempts < 3) {
        netAttempts++;
        hls.startLoad();
      } else {
        playbackError.value = `Network error · ${d.details}`;
      }
    } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
      if (++mediaFatals >= 4) {
        playbackError.value = `Playback error · ${d.details}`;
      } else {
        player.value?.provider?.video?.play().catch(() => {   });
      }
    } else {
      playbackError.value = `Playback error · ${d.details}`;
    }
  });
  hls.on(Hls.Events.MANIFEST_PARSED, reportResolution);
  hls.on(Hls.Events.LEVEL_SWITCHED, reportResolution);
}

onMounted(() => {
  const c = player.value?.controls;
  if (c) { c.canIdle = false; c.show(); }
});

onBeforeUnmount(() => {
  try { player.value?.destroy?.(); } catch {   }
});
</script>

<template>
  <div class="vds-host">
    <media-player
      ref="player"
      :src="gatedSrc ?? ''"
      autoplay
      muted
      playsinline
      @provider-change="onProviderChange"
      @hls-instance="onHlsInstance"
      @error="onError"
    >
      <media-provider />
      <media-video-layout small-when="never" />
    </media-player>
    <div v-if="playbackError" class="vds-error mono">
      <span>{{ playbackError }}</span>
      <button type="button" class="vds-retry mono" @click="retry">Retry</button>
    </div>
  </div>
</template>

<style scoped>
.vds-host {
  position: relative;
  width: 100%;
  height: 100%;
}
.vds-host media-player {
  width: 100%;
  height: 100%;
}
.vds-error {
  position: absolute;
  inset: auto 8px 8px 8px;
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
.vds-retry {
  border: 1px solid rgba(255, 255, 255, 0.55);
  background: transparent;
  color: #fff;
  border-radius: 5px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
}
</style>
