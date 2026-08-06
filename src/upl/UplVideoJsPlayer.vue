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
//
// AUDIO — why autoplay is hand-rolled instead of `autoplay: 'muted'` (this WAS a silent-player bug):
// Video.js re-runs manualAutoplay_() on every `loadstart`, i.e. on every player.src() — so once per channel
// change. With autoplay:'muted' that path calls muted(true) and pushes a restoreMuted callback onto
// playTerminatedQueue_ … a queue runPlayCallbacks_() CLEARS when the play SUCCEEDS. Net effect: tuning a
// channel re-muted the player permanently and the unmute the viewer had just performed was thrown away.
// Video.js persists text-track settings but never volume, so nothing put it back either.
// So: autoplay is off, applySrc() drives play() itself, and the viewer's mute/volume choice is the authority
// — persisted to localStorage, restored on open, and overridden only when the browser's autoplay policy
// actually refuses sound (which raises a visible "click to unmute" affordance rather than silent silence).
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

// Video.js's own types describe the element-bound API loosely in places (tech().vhs is untyped, as are the
// quality-level lists), and the repo is strict:false — `any` here matches VidstackPlayer.vue's precedent.
const host = ref<HTMLElement | null>(null);
let player: any = null;
let sampler: number | undefined;

const playbackError = ref<string | null>(null);
const engine = ref<'vhs' | 'native'>('native');

// Audio state, mirrored out of the player so the template can react to it. `policyMuted` distinguishes "the
// browser refused sound" from "the viewer chose silence" — only the latter is worth persisting.
const isMuted = ref(false);
const policyMuted = ref(false);

const { gatedSrc, reload } = useAppStreamSource(toRef(props, 'src'));

// Volume/mute survives both a channel change and the window being reopened. Default is sound ON: let the
// autoplay policy demote us if it must, rather than starting silent and hoping the viewer finds the control.
const AUDIO_PREF_KEY = 'upl:audio';

function loadAudioPref(): { muted: boolean; volume: number } {
  try {
    const raw = localStorage.getItem(AUDIO_PREF_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { muted?: unknown; volume?: unknown };
      const v = typeof p.volume === 'number' && p.volume >= 0 && p.volume <= 1 ? p.volume : 1;
      return { muted: p.muted === true, volume: v };
    }
  } catch { /* unparseable or storage blocked — fall through to the default */ }
  return { muted: false, volume: 1 };
}

function saveAudioPref(): void {
  if (!player) return;
  try {
    localStorage.setItem(AUDIO_PREF_KEY, JSON.stringify({ muted: !!player.muted(), volume: player.volume() }));
  } catch { /* private mode / quota — a lost preference is not worth failing playback over */ }
}

// Capped recovery, mirroring VidstackPlayer.vue's policy so both players fail the same way: retry a network
// failure up to 3× by re-sourcing, then surface it. Reset once playback is demonstrably healthy again.
const MAX_NET_RETRIES = 3;
let netAttempts = 0;

// Bumped per source so a play() rejection can be attributed correctly: "the browser refused sound" and "a
// newer load request interrupted this one" arrive as the same rejected promise, and only the first should
// cost the viewer their audio.
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
    // Superseded by a newer channel — not a verdict on audio.
    if (gen !== playGen || !player || player.muted()) return;
    // The autoplay policy refused UNMUTED playback (a popup does not always inherit user activation).
    // Demote to muted rather than showing a dead frame, and raise the unmute affordance to say so.
    policyMuted.value = true;
    player.muted(true);
    try { await player.play(); } catch { /* still refused — Video.js's big play button remains */ }
  }
}

// Viewer-driven unmute: a real click/keypress carries the activation the autoplay policy wanted, so this is
// the one path that can reliably turn sound on. Also lifts volume off zero, which would otherwise unmute to
// the same silence, and re-plays in case the policy paused us on the way down.
function unmute(): void {
  if (!player) return;
  policyMuted.value = false;
  player.muted(false);
  if (player.volume() === 0) player.volume(1);
  const p = player.play();
  if (p && typeof p.catch === 'function') p.catch(() => { /* controls remain */ });
}

function toggleMute(): void {
  if (!player) return;
  if (player.muted() || player.volume() === 0) unmute();
  else player.muted(true);
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
defineExpose({ selectLevel, toggleMute });

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

  const pref = loadAudioPref();

  player = videojs(el, {
    controls: true,
    // NOT `autoplay: 'muted'` — see the AUDIO note at the top of this file. Any string value here hands the
    // mute flag back to manualAutoplay_(), which re-mutes on every source change and never restores it.
    // applySrc() → attemptPlay() owns the first play instead, so `muted` below stays the viewer's to set.
    autoplay: false,
    muted: pref.muted,
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

  player.volume(pref.volume); // no `volume` player option exists; set it once the player is up
  isMuted.value = !!player.muted();

  // Track every mute/volume change, whoever caused it. A change while policyMuted means the viewer overrode
  // the browser's refusal, so drop that flag; a change we made ourselves to satisfy the policy is NOT a
  // preference and must not be written back, or the demotion would follow them into every future window.
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
    <!-- Silence is indistinguishable from a broken stream, so say which it is and make it one click to fix.
         Shown for a deliberate mute too — in a dedicated player window that doubles as the audio readout. -->
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

/* Top-left, clear of both the control bar (bottom) and the centred big-play button. */
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
