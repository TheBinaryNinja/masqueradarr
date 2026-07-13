<script setup lang="ts">
// DebugHlsPlayer — a diagnostic in-app player. A first-class port of the throwaway `hlstest.html` we built
// during the HLS-vs-rawTS investigation: a bare <video> + RAW hls.js (deliberately not Vidstack — the point
// is to observe the engine directly), instrumented with a live status line and a color-coded event log so an
// operator can watch a channel's client-side playback health in real time. Everything here is measured from
// the actual <video>/hls.js in the operator's browser — distinct from the server-side stream telemetry
// (useStreamStats). Same `{ src }` prop + `resolution` emit as the normal in-app player, so the slide-out can
// swap between them (see ChannelPlayer.vue). Token-append comes from useAppStreamSource — do NOT re-implement
// it here.
//
// Layout: a HUD inside the drawer's 16:9 media frame — video fills the frame, a status strip is docked at the
// top and the scrolling event log at the bottom. Native <video> controls are intentionally omitted (the log
// would overlap them, and this is a passive live-observation tool — use the normal player for scrubbing).
import { ref, reactive, watch, onMounted, onBeforeUnmount, toRef, nextTick } from 'vue';
import Hls from 'hls.js';
import Pill from './Pill.vue';
import { useAppStreamSource } from '../composables/useAppStreamSource';

const props = defineProps<{ src: string | null }>();
const emit = defineEmits<{ (e: 'resolution', res: string): void }>();

const video = ref<HTMLVideoElement | null>(null);
const logEl = ref<HTMLElement | null>(null);
let hls: Hls | null = null;

// Token append lives in the composable; we bind hls.js to gatedSrc (the authenticated URL, or null while idle).
const { gatedSrc } = useAppStreamSource(toRef(props, 'src'));

// ---- live status line (sampled every 500ms) ----
const m = reactive({
  currentTime: 0, frozenFor: 0, bufAhead: 0, readyState: 0, paused: true,
  stalls: 0, fragLoaded: 0, keyLoaded: 0, fragErr: 0, fatal: 0, dropped: 0, latency: 0,
});

// ---- color-coded event log (ring buffer) ----
type Tone = 'good' | 'warn' | 'bad' | 'accent' | '';
const logs = ref<{ t: string; tone: Tone; msg: string }[]>([]);
function log(tone: Tone, msg: string) {
  logs.value.push({ t: new Date().toLocaleTimeString(), tone, msg });
  if (logs.value.length > 200) logs.value.shift(); // cap — keep the tail
  void nextTick(() => { const el = logEl.value; if (el) el.scrollTop = el.scrollHeight; });
}

// Read the playing <video>'s pixel height and report it as e.g. "1080p" (guarding 0/NaN until metadata lands).
function reportResolution() {
  const el = video.value;
  if (!el) return;
  const h = el.videoHeight;
  if (!h || Number.isNaN(h)) return;
  emit('resolution', `${h}p`);
}

// ---- 500ms sampler + freeze detector ----
let lastTime = 0;
let freezeLogged = false;
let sampler: ReturnType<typeof setInterval> | null = null;
function sample() {
  const v = video.value;
  if (!v) return;
  m.currentTime = v.currentTime;
  m.readyState = v.readyState;
  m.paused = v.paused;
  // buffered ahead of the playhead (the range the playhead currently sits in)
  let ahead = 0;
  for (let i = 0; i < v.buffered.length; i++) {
    if (v.currentTime >= v.buffered.start(i) && v.currentTime <= v.buffered.end(i)) {
      ahead = v.buffered.end(i) - v.currentTime;
      break;
    }
  }
  m.bufAhead = ahead;
  const q = v.getVideoPlaybackQuality?.();
  if (q) m.dropped = q.droppedVideoFrames;
  if (hls) m.latency = hls.latency ?? 0;
  // freeze detector: currentTime stuck > 3s while not paused → log once, with buffer depth + readyState.
  if (!v.paused && v.currentTime === lastTime) {
    m.frozenFor += 0.5;
    if (m.frozenFor > 3 && !freezeLogged) {
      log('bad', `FROZEN ${m.frozenFor.toFixed(1)}s · bufAhead=${ahead.toFixed(2)}s readyState=${v.readyState}`);
      freezeLogged = true;
    }
  } else {
    if (freezeLogged) log('good', `resumed after ${m.frozenFor.toFixed(1)}s frozen`);
    m.frozenFor = 0;
    freezeLogged = false;
  }
  lastTime = v.currentTime;
}

// ---- <video> element event taps ----
function onWaiting() { m.stalls++; log('warn', `video WAITING (stall) #${m.stalls}`); }
function onPlaying() { log('good', 'video PLAYING'); }
function onStalled() { log('warn', 'video STALLED'); }
function onEnded() { log('', 'video ENDED'); }
function onVideoError() { const c = video.value?.error?.code; log('bad', `video ELEMENT error${c ? ' code=' + c : ''}`); }
function bindVideoEvents(el: HTMLVideoElement) {
  el.addEventListener('waiting', onWaiting);
  el.addEventListener('playing', onPlaying);
  el.addEventListener('stalled', onStalled);
  el.addEventListener('ended', onEnded);
  el.addEventListener('error', onVideoError);
  el.addEventListener('loadedmetadata', reportResolution);
}
function unbindVideoEvents(el: HTMLVideoElement) {
  el.removeEventListener('waiting', onWaiting);
  el.removeEventListener('playing', onPlaying);
  el.removeEventListener('stalled', onStalled);
  el.removeEventListener('ended', onEnded);
  el.removeEventListener('error', onVideoError);
  el.removeEventListener('loadedmetadata', reportResolution);
}

function teardownHls() {
  if (hls) { hls.destroy(); hls = null; }
  const el = video.value;
  if (el) {
    unbindVideoEvents(el);
    if (el.getAttribute('src')) { el.removeAttribute('src'); el.load(); } // drop a native-HLS source
  }
}

// Attach raw hls.js (or native HLS on Safari) to the authenticated src.
function attach(el: HTMLVideoElement, src: string) {
  bindVideoEvents(el);
  if (el.canPlayType('application/vnd.apple.mpegurl')) {
    log('accent', 'native HLS (Safari) — hls.js diagnostics unavailable');
    el.src = src;
    el.play().catch(() => undefined);
    return;
  }
  if (!Hls.isSupported()) { log('bad', 'HLS not supported in this browser'); return; }

  hls = new Hls({ enableWorker: true, lowLatencyMode: false });
  let recoverAttempts = 0;
  hls.on(Hls.Events.MEDIA_ATTACHED, () => log('accent', 'media attached'));
  hls.on(Hls.Events.MANIFEST_PARSED, (_e, d) => { log('accent', `MANIFEST_PARSED · ${d.levels.length} levels`); reportResolution(); });
  hls.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => {
    const lv = hls?.levels[d.level];
    log('accent', `LEVEL → ${lv?.height ?? '?'}p${lv?.bitrate ? ' · ' + Math.round(lv.bitrate / 1000) + 'kbps' : ''}`);
    reportResolution();
  });
  hls.on(Hls.Events.FRAG_LOADED, () => { m.fragLoaded++; });
  hls.on(Hls.Events.KEY_LOADED, () => { m.keyLoaded++; });
  // Reset the recovery budget on healthy playback so a genuinely dead stream still surfaces the error.
  hls.on(Hls.Events.FRAG_BUFFERED, () => { recoverAttempts = 0; });
  hls.on(Hls.Events.ERROR, (_e, d) => {
    const line = `${d.type} · ${d.details}${d.fatal ? ' · FATAL' : ''}`;
    if (!d.fatal) { m.fragErr++; log('warn', line); return; }
    m.fatal++;
    log('bad', line);
    const h = hls;
    if (!h || recoverAttempts >= 3) return;
    recoverAttempts++;
    if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
      log('warn', `recovery: startLoad() #${recoverAttempts}`);
      h.startLoad();
    } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
      log('warn', `recovery: recoverMediaError() #${recoverAttempts}`);
      h.recoverMediaError();
      el.play().catch(() => undefined);
    }
  });
  hls.loadSource(src);
  hls.attachMedia(el);
  el.play().catch(() => undefined);
}

// gatedSrc drives attach/teardown. Null → tear down; a URL → attach.
watch(gatedSrc, (url) => {
  teardownHls();
  if (url && video.value) { log('accent', 'src ready → attaching'); attach(video.value, url); }
});

onMounted(() => {
  sampler = setInterval(sample, 500);
  if (gatedSrc.value && video.value) attach(video.value, gatedSrc.value);
});
onBeforeUnmount(() => {
  if (sampler) clearInterval(sampler);
  teardownHls();
});
</script>

<template>
  <div class="dbg-player mono">
    <video ref="video" autoplay muted playsinline class="dbg-video" />

    <!-- Status strip (top) -->
    <div class="dbg-status">
      <Pill :tone="m.fatal > 0 ? 'bad' : m.stalls > 0 ? 'warn' : 'good'">
        {{ m.fatal > 0 ? 'FATAL' : m.paused ? 'PAUSED' : 'LIVE' }}
      </Pill>
      <span class="dbg-kv"><i>t</i>{{ m.currentTime.toFixed(2) }}</span>
      <span class="dbg-kv"><i>frozen</i><b :class="m.frozenFor > 3 ? 'bad' : 'good'">{{ m.frozenFor.toFixed(1) }}s</b></span>
      <span class="dbg-kv"><i>buf</i><b :class="m.bufAhead < 1 ? 'bad' : 'good'">{{ m.bufAhead.toFixed(1) }}s</b></span>
      <span class="dbg-kv"><i>ready</i>{{ m.readyState }}</span>
      <span class="dbg-kv"><i>stalls</i><b :class="m.stalls ? 'warn' : ''">{{ m.stalls }}</b></span>
      <span class="dbg-kv"><i>frag</i>{{ m.fragLoaded }}</span>
      <span class="dbg-kv"><i>key</i>{{ m.keyLoaded }}</span>
      <span class="dbg-kv"><i>fragErr</i><b :class="m.fragErr ? 'warn' : ''">{{ m.fragErr }}</b></span>
      <span class="dbg-kv"><i>fatal</i><b :class="m.fatal ? 'bad' : ''">{{ m.fatal }}</b></span>
      <span class="dbg-kv"><i>dropped</i>{{ m.dropped }}</span>
      <span class="dbg-kv"><i>lat</i>{{ m.latency.toFixed(1) }}</span>
    </div>

    <!-- Event log (bottom) -->
    <div class="dbg-logwrap">
      <div class="dbg-loghdr">EVENT LOG · {{ logs.length }}</div>
      <div ref="logEl" class="dbg-log">
        <div v-for="(l, i) in logs" :key="i" class="dbg-logline" :class="l.tone">
          <span class="dbg-logt">{{ l.t }}</span> {{ l.msg }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* This component owns irreducible media/HUD layout — the same documented exception HlsPlayer/LivelineChart
   take by carrying a scoped block (most components in this repo use global classes + inline var() styles). */
.dbg-player {
  position: relative;
  width: 100%;
  height: 100%;
  background: #000;
  font-size: var(--fs-xs);
}
.dbg-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
  display: block;
}
.dbg-status {
  position: absolute;
  top: 0; left: 0; right: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  padding: 6px 8px;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(3px);
  border-bottom: 1px solid var(--hairline);
  line-height: 1.4;
  z-index: 2;
}
.dbg-kv { color: var(--text-1); white-space: nowrap; }
.dbg-kv i { color: var(--text-3); font-style: normal; margin-right: 3px; }
.dbg-kv b { font-weight: 600; }
.dbg-status .good, .dbg-logline.good { color: var(--good); }
.dbg-status .warn, .dbg-logline.warn { color: var(--warn); }
.dbg-status .bad, .dbg-logline.bad { color: var(--bad); }
.dbg-logline.accent { color: var(--accent); }

.dbg-logwrap {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 46%;
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, 0.66);
  backdrop-filter: blur(3px);
  border-top: 1px solid var(--hairline);
  z-index: 2;
}
.dbg-loghdr {
  padding: 3px 8px;
  color: var(--text-3);
  letter-spacing: 0.06em;
  border-bottom: 1px solid var(--hairline);
  flex-shrink: 0;
}
.dbg-log {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
  line-height: 1.45;
}
.dbg-logline {
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.dbg-logt { color: var(--text-3); margin-right: 6px; }
</style>
