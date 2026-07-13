<script setup lang="ts">
// VidstackPlayer — the in-app HLS player (replaces the old bare-hls.js HlsPlayer). It wraps Vidstack's
// <media-player> web component + its default video layout (which gives, for free, a quality menu built from the
// HLS levels, picture-in-picture, fullscreen, a volume slider, keyboard shortcuts and a captions button) while
// keeping the EXACT stream-handling contract of the old player:
//   - REUSES the app's bundled hls.js (provider.library = Hls) so nothing is fetched from Vidstack's default
//     jsDelivr CDN — critical for a self-hosted / possibly air-gapped deploy.
//   - Binds `src` to the token-gated URL from useAppStreamSource (gatedSrc); the stream resolves on demand
//     server-side when hls.js fetches it.
//   - Adds a capped (3×) network-error reload plus a visible error surface with Retry. Vidstack auto-recovers
//     fatal MEDIA errors (recoverMediaError, uncapped) and only NOTIFIES network/other, so we add the network
//     retry and surface an error once retries are exhausted / media errors keep recurring — never double-recover.
//   - Emits `resolution` from the underlying <video> height, same contract as before.
// Same `{ src }` prop as the old HlsPlayer, so it's a drop-in swap at both mount sites (the slide-out via
// ChannelPlayer, and the Dashboard preview directly).
import { ref, toRef, onMounted, onBeforeUnmount } from 'vue';
import Hls from 'hls.js';
import 'vidstack/player';
import 'vidstack/player/layouts/default';
import 'vidstack/player/styles/default/theme.css';
import 'vidstack/player/styles/default/layouts/video.css';
import { useAppStreamSource } from '../composables/useAppStreamSource';

const props = defineProps<{ src: string | null }>();
const emit = defineEmits<{ (e: 'resolution', res: string): void }>();

// The <media-player> element ref (a Vidstack-augmented HTMLElement). Typed `any` — the repo is strict:false and
// Vidstack's event `detail` payloads are pragmatic to treat loosely.
const player = ref<any>(null);

// Set once the hls.js provider hands us its instance. When true, that instance's ERROR handler is the
// authoritative error source and we ignore Vidstack's `error` DOMEvent (which fires per network fatal, before our
// capped retries get a chance) to avoid flashing the overlay mid-retry.
let hasHls = false;

// A user-facing playback error (network retries exhausted, fatal media errors recurring, or a fatal OTHER error).
// Vidstack only auto-recovers media errors and silently notify()s the rest, so without this a dead stream just
// freezes with no surface — the old HlsPlayer had a .hls-error banner we restore here.
const playbackError = ref<string | null>(null);

// Token append lives in the composable; we bind <media-player>'s src to gatedSrc (the authenticated URL, or null
// while idle). reload() re-attaches the current src for the Retry button.
const { gatedSrc, reload } = useAppStreamSource(toRef(props, 'src'));

function retry() {
  playbackError.value = null;
  reload(); // re-attach the current src
}

// Backstop for the non-hls.js path (Safari native HLS, where `hls-instance` never fires): Vidstack dispatches its
// notify('error') as an `error` DOMEvent carrying { message } on <media-player>. Suppressed when hls.js is driving.
function onError(e: any) {
  if (hasHls) return;
  playbackError.value = e?.detail?.message || 'Playback error';
}

// `provider-change` fires when Vidstack dynamically imports the provider, BEFORE it runs setup — the documented
// moment to configure it. Point the HLS provider at the bundled hls.js so it never fetches from the CDN.
function onProviderChange(e: any) {
  const p = e.detail;
  if (p?.type === 'hls') {
    p.library = Hls; // the bundled constructor — no CDN fetch
    p.config = { enableWorker: true, lowLatencyMode: false }; // parity with the old player's Hls config
  }
}

// Read the underlying <video>'s pixel height and report it as e.g. "1080p" (HLSProvider extends VideoProvider,
// which exposes `.video`). Engine-agnostic, matches the old player's videoHeight-based contract.
function reportResolution() {
  const v = player.value?.provider?.video as HTMLVideoElement | undefined;
  const h = v?.videoHeight;
  if (!h || Number.isNaN(h)) return;
  emit('resolution', `${h}p`);
}

// `hls-instance` hands us the live Hls instance. We own: the capped (3×) network reload; counting fatal media
// errors to surface an error when Vidstack's uncapped recovery clearly isn't taking; surfacing fatal OTHER errors;
// and the resolution taps. We never recover media errors ourselves — Vidstack's provider already does.
function onHlsInstance(e: any) {
  hasHls = true;
  const hls = e.detail as Hls;
  let netAttempts = 0;
  let mediaFatals = 0;
  hls.on(Hls.Events.FRAG_BUFFERED, () => {
    // Healthy playback: reset both recovery budgets and clear any surfaced error.
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
      // Vidstack's provider already called recoverMediaError() (uncapped) before this handler runs — but that
      // detaches+reattaches the MSE buffer, which PAUSES the <video>, and neither hls.js nor Vidstack re-issues
      // play() once playback has started. So the stream would start then freeze until a manual play. Resume it
      // ourselves (mirrors DebugHlsPlayer.vue). We never recover the error ourselves — only re-play after Vidstack's
      // recovery — and give up (surface an error) once recovery clearly isn't taking.
      if (++mediaFatals >= 4) {
        playbackError.value = `Playback error · ${d.details}`;
      } else {
        player.value?.provider?.video?.play().catch(() => { /* interrupted mid-reattach; harmless */ });
      }
    } else {
      // Fatal OTHER (mux, key, etc.) — Vidstack only notify()s these; surface it (the old player did too).
      playbackError.value = `Playback error · ${d.details}`;
    }
  });
  hls.on(Hls.Events.MANIFEST_PARSED, reportResolution);
  hls.on(Hls.Events.LEVEL_SWITCHED, reportResolution);
}

onMounted(() => {
  // Keep the Vidstack control bar always visible (it otherwise idle-hides after defaultDelay=2s, which is why
  // controls "only appear on right-click"). `canIdle = false` disables idle tracking — Vidstack's #init effect
  // re-runs and disposes its play/pause/mouse auto-hide listeners; since controlsVisible starts false, show()
  // forces the bar visible now. NOT the `controls` attribute — that swaps to native browser controls and hides
  // this rich layout (quality menu / PiP / fullscreen). `player.value.controls` exists once the element connects.
  const c = player.value?.controls;
  if (c) { c.canIdle = false; c.show(); }
});

onBeforeUnmount(() => {
  // Vidstack tears the hls instance down with the element, but destroy explicitly to avoid a lingering worker
  // during rapid channel switches.
  try { player.value?.destroy?.(); } catch { /* noop */ }
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
      <!-- small-when="never" MUST be a static attribute: the layout's converter (value !== "never" && !!value)
           only runs for the attribute; a Vue bind would bypass it and force the small/mobile layout on (which
           drops the volume slider + persistent control bar in these sub-576px / sub-380px frames). -->
      <media-video-layout small-when="never" />
    </media-player>
    <div v-if="playbackError" class="vds-error mono">
      <span>{{ playbackError }}</span>
      <button type="button" class="vds-retry mono" @click="retry">Retry</button>
    </div>
  </div>
</template>

<style scoped>
/* Media component owning irreducible layout — the documented exception for a scoped block. Fill the drawer /
   dashboard 16:9 frame; the parent already enforces the aspect ratio + overflow. */
.vds-host {
  position: relative;
  width: 100%;
  height: 100%;
}
.vds-host media-player {
  width: 100%;
  height: 100%;
}
/* Error banner: bottom-docked, above the control bar (z-index 2). Keeps pointer events so the Retry button is
   clickable. Mirrors the old HlsPlayer's .hls-error. */
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
