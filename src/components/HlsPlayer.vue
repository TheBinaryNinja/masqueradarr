<script setup lang="ts">
// appPlayer — the IN-APP HLS player: plays a proxied stream URL through hls.js, with a native-HLS fallback
// for Safari. This is the slide-out-panel player; every symbol here is prefixed `appPlayer*` so the in-app
// player is trivially distinguishable from the `externalPlayer` (third-party IPTV-client) path in the code.
// `src` is the /api/v1/<source>/<enc streamEntryUrl> proxy path (see appPlayerProxyPath() in data.ts) — the
// proxy handles every per-source resolve/auth/SSRF concern, so the player just points hls.js at it.
//
// Establishing gate: the proxy serves a B-Roll slate (a 1280×720 ffmpeg card) while a channel is
// establishing, then hands off to the live variant. That slate→live handoff (different resolution /
// codec / DTS timeline) is a fatal decode error in hls.js's MSE pipeline ("buffers not in DTS
// sequence"). So instead of attaching hls.js straight away, we PRIME the entry (which drives the
// server-side resolve + registers the viewer + kicks ffprobe) and only attach the player once the
// entry is serving real content (no `__broll__` slate segments). The slate therefore never enters the
// browser media buffer — headless IPTV clients still get it by loading the entry directly.
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue';
import Hls from 'hls.js';
import { token } from '../composables/useAuth';

const props = defineProps<{ src: string | null }>();
const emit = defineEmits<{ (e: 'resolution', res: string): void }>();
const video = ref<HTMLVideoElement | null>(null);
const appPlayerError = ref<string | null>(null);
const appPlayerConnecting = ref(false);
let appPlayerHls: Hls | null = null;
// Generation token: bumped on every teardown/reload so any in-flight prime loop for a superseded src
// bails instead of attaching the wrong stream.
let appPlayerLoadId = 0;

const appPlayerAuthenticatedSrc = computed(() => {
  if (!props.src) return null;
  const activeToken = token.value || localStorage.getItem('auth_token');
  if (!activeToken) return props.src;

  if (props.src.startsWith('/api/')) {
    try {
      const url = new URL(props.src, window.location.origin);
      url.searchParams.set('token', activeToken);
      return url.pathname + url.search;
    } catch {
      return props.src;
    }
  }
  return props.src;
});

// Read the playing <video>'s pixel height and report it as e.g. "1080p" (guarding 0/NaN until metadata lands).
function appPlayerReportResolution() {
  const el = video.value;
  if (!el) return;
  const h = el.videoHeight;
  if (!h || Number.isNaN(h)) return;
  emit('resolution', `${h}p`);
}

function appPlayerTeardown() {
  appPlayerLoadId++; // cancel any in-flight prime loop
  if (appPlayerHls) {
    appPlayerHls.destroy();
    appPlayerHls = null;
  }
  video.value?.removeEventListener('loadedmetadata', appPlayerReportResolution);
}

// Poll the entry until it's serving real content (master or media playlist with no B-Roll slate
// segments), so the slate never enters the MSE buffer. The fetch itself drives the server-side resolve
// and refreshes the viewer heartbeat. Returns true when ready to attach, false if superseded.
async function appPlayerWaitForLive(src: string, myId: number): Promise<boolean> {
  const deadline = Date.now() + 30_000; // cap establishing → best-effort attach so a stuck channel still surfaces
  for (;;) {
    if (myId !== appPlayerLoadId) return false;
    let text = '';
    try {
      text = await (await fetch(src, { cache: 'no-store' })).text();
    } catch {
      /* transient — retry below */
    }
    if (myId !== appPlayerLoadId) return false;
    const isPlaylist = text.includes('#EXTM3U');
    const establishing = text.includes('__broll__'); // the B-Roll slate's segment marker
    if (isPlaylist && !establishing) return true; // serving the real master/media playlist → safe to attach
    if (Date.now() > deadline) return true; // give up waiting (failed/slow channel) → attach best-effort
    await new Promise((f) => setTimeout(f, 1500));
  }
}

// Attach the actual player (hls.js, or native HLS on Safari) to a src that is known to be serving live.
function appPlayerAttach(el: HTMLVideoElement, src: string) {
  if (el.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari / iOS play HLS natively — no hls.js needed.
    el.addEventListener('loadedmetadata', appPlayerReportResolution);
    el.src = src;
    el.play().catch(() => undefined);
    return;
  }

  if (Hls.isSupported()) {
    appPlayerHls = new Hls({ enableWorker: true, lowLatencyMode: false });
    // Fatal-error recovery (hls.js's prescribed pattern). The establishing gate keeps the B-Roll slate
    // out of MSE on first load, but a mid-stream re-buffer can still splice slate→live; recoverMediaError()
    // flushes and re-appends from the live edge. Network blips reload. Attempts are capped and reset on
    // healthy playback so a genuinely dead stream still surfaces the error instead of looping.
    let recoverAttempts = 0;
    appPlayerHls.on(Hls.Events.FRAG_BUFFERED, () => {
      recoverAttempts = 0;
    });
    appPlayerHls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      const h = appPlayerHls;
      if (!h) return;
      if (recoverAttempts >= 3) {
        appPlayerError.value = `Playback error: ${data.type} · ${data.details}`;
        return;
      }
      recoverAttempts++;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        h.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        h.recoverMediaError();
        el.play().catch(() => undefined);
      } else {
        appPlayerError.value = `Playback error: ${data.type} · ${data.details}`;
      }
    });
    appPlayerHls.on(Hls.Events.MANIFEST_PARSED, appPlayerReportResolution);
    appPlayerHls.on(Hls.Events.LEVEL_SWITCHED, appPlayerReportResolution);
    appPlayerHls.loadSource(src);
    appPlayerHls.attachMedia(el);
    el.play().catch(() => undefined);
    return;
  }

  appPlayerError.value = 'HLS playback is not supported in this browser.';
}

function appPlayerLoad(src: string | null) {
  appPlayerError.value = null;
  appPlayerTeardown(); // bumps appPlayerLoadId, destroys any prior hls
  const el = video.value;
  if (!el || !src) return;
  const myId = appPlayerLoadId;
  appPlayerConnecting.value = true;
  void (async () => {
    const ready = await appPlayerWaitForLive(src, myId);
    if (myId !== appPlayerLoadId || !video.value) return; // superseded by a newer load / teardown
    appPlayerConnecting.value = false;
    if (ready) appPlayerAttach(video.value, src);
  })();
}

onMounted(() => appPlayerLoad(appPlayerAuthenticatedSrc.value));
watch(appPlayerAuthenticatedSrc, (s) => appPlayerLoad(s));
onBeforeUnmount(appPlayerTeardown);
</script>

<template>
  <div class="hls-player">
    <video
      ref="video"
      controls
      autoplay
      muted
      playsinline
      style="width: 100%; height: 100%; background: #000; border-radius: inherit; display: block;"
    />
    <div v-if="appPlayerConnecting" class="hls-connecting mono">Connecting…</div>
    <div v-if="appPlayerError" class="hls-error mono">{{ appPlayerError }}</div>
  </div>
</template>

<style scoped>
.hls-player {
  position: relative;
  width: 100%;
  height: 100%;
}
.hls-connecting {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.85);
  background: #000;
  border-radius: inherit;
  pointer-events: none;
}
.hls-error {
  position: absolute;
  inset: auto 8px 8px 8px;
  padding: 6px 9px;
  font-size: 11px;
  color: #fff;
  background: rgba(180, 40, 40, 0.85);
  border-radius: 6px;
}
</style>
