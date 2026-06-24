<script setup lang="ts">
// dulo streamed-login drawer. Opens a WebSocket to the server's /api/dulo/login-stream, which screencasts a
// real server-side Chromium sitting on the dulo.tv login page (CDP JPEG frames). We paint frames into a
// <canvas> and forward the user's mouse/keyboard back, scaled to the remote viewport. The user signs in on
// the ACTUAL dulo page — their password never reaches TVApp2; the server intercepts the Supabase session
// and stores only the tokens. See server/src/sources/adapters/dulo/loginBrowser.ts and restapi-sources.md.

import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import StatusDot from './StatusDot.vue';

const emit = defineEmits<{ (e: 'close'): void; (e: 'captured'): void }>();

type State = 'connecting' | 'live' | 'captured' | 'busy' | 'error';
const state = ref<State>('connecting');
const message = ref('');
const canvas = ref<HTMLCanvasElement | null>(null);

let ws: WebSocket | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let remoteW = 1280;
let remoteH = 800;
let lastMove = 0;

const tone = computed(() => {
  switch (state.value) {
    case 'live':
    case 'captured':
      return 'good';
    case 'busy':
      return 'warn';
    case 'error':
      return 'bad';
    default:
      return 'idle';
  }
});

const label = computed(() => {
  switch (state.value) {
    case 'connecting':
      return 'starting…';
    case 'live':
      // message is only set on the post-sign-in device-setup status; the initial 'live' has none.
      return message.value ? 'finishing setup' : 'ready';
    case 'captured':
      return 'connected';
    case 'busy':
      return 'busy';
    case 'error':
      return 'error';
    default:
      return '';
  }
});

function send(o: Record<string, unknown>) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
}

async function drawFrame(blob: Blob) {
  if (!ctx) return;
  try {
    const bmp = await createImageBitmap(blob);
    ctx.drawImage(bmp, 0, 0, remoteW, remoteH);
    bmp.close();
  } catch {
    /* a malformed/partial frame — skip it */
  }
}

function handleControl(raw: string) {
  let m: { type?: string; state?: State; message?: string; w?: number; h?: number };
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.type === 'meta') {
    remoteW = m.w || 1280;
    remoteH = m.h || 800;
    if (canvas.value) {
      canvas.value.width = remoteW;
      canvas.value.height = remoteH;
    }
  } else if (m.type === 'status' && m.state) {
    state.value = m.state;
    if (m.message) message.value = m.message;
  } else if (m.type === 'captured') {
    state.value = 'captured';
    emit('captured');
    setTimeout(() => emit('close'), 900);
  }
}

function remoteCoords(e: PointerEvent | WheelEvent) {
  const el = canvas.value;
  if (!el) return { x: 0, y: 0 };
  const r = el.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (remoteW / r.width),
    y: (e.clientY - r.top) * (remoteH / r.height),
  };
}

function onPointerDown(e: PointerEvent) {
  canvas.value?.focus();
  canvas.value?.setPointerCapture?.(e.pointerId);
  const { x, y } = remoteCoords(e);
  send({ type: 'mouse', action: 'down', x, y, button: e.button });
}
function onPointerUp(e: PointerEvent) {
  const { x, y } = remoteCoords(e);
  send({ type: 'mouse', action: 'up', x, y, button: e.button });
}
function onPointerMove(e: PointerEvent) {
  const now = performance.now();
  if (now - lastMove < 25) return; // throttle to ~40/s so we don't flood the socket
  lastMove = now;
  const { x, y } = remoteCoords(e);
  send({ type: 'mouse', action: 'move', x, y });
}
function onWheel(e: WheelEvent) {
  send({ type: 'mouse', action: 'wheel', dx: e.deltaX, dy: e.deltaY });
}
function onKeyDown(e: KeyboardEvent) {
  send({ type: 'key', key: e.key });
}

onMounted(() => {
  if (canvas.value) {
    canvas.value.width = remoteW;
    canvas.value.height = remoteH;
    ctx = canvas.value.getContext('2d');
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/dulo/login-stream`);
  ws.binaryType = 'blob';
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') handleControl(ev.data);
    else void drawFrame(ev.data as Blob);
  };
  ws.onerror = () => {
    if (state.value === 'connecting') {
      state.value = 'error';
      message.value = 'could not reach the login service';
    }
  };
});

onBeforeUnmount(() => {
  try {
    send({ type: 'close' });
    ws?.close();
  } catch {
    /* ignore */
  }
  ws = null;
});
</script>

<template>
  <div class="drawer-wrap">
    <div class="glass-bg drawer-backdrop" @click="emit('close')" />
    <div class="glass drawer-panel" style="width: min(920px, 96vw); max-width: 96vw;">
      <div class="drawer-hd">
        <Icon name="tv" :size="18" />
        <div style="flex: 1;">
          <div style="font-weight: 600; font-size: 15px;">Sign in to dulo</div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px;">
            This is dulo.tv — your password goes straight to dulo, never to TVApp2.
          </div>
        </div>
        <div class="row" style="gap: 8px; align-items: center;">
          <StatusDot :status="tone" :pulse="state === 'connecting' || state === 'live'" />
          <span class="muted" style="font-size: var(--fs-xs);">{{ label }}</span>
          <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
        </div>
      </div>

      <div class="drawer-body">
        <div class="dulo-stage">
          <canvas
            ref="canvas"
            class="dulo-canvas"
            tabindex="0"
            @pointerdown="onPointerDown"
            @pointerup="onPointerUp"
            @pointermove="onPointerMove"
            @wheel.prevent="onWheel"
            @keydown.prevent="onKeyDown"
          />
          <!-- Non-blocking guidance during the post-sign-in device-setup step — the canvas stays interactive
               so the user can confirm "use this device" on dulo's Live TV page if it prompts. -->
          <div v-if="state === 'live' && message" class="dulo-banner good">
            <Icon name="check" :size="14" /> {{ message }}
          </div>
          <div v-if="state === 'connecting'" class="dulo-overlay">
            <Icon name="refresh" :size="16" /> Starting a secure browser…
          </div>
          <div v-else-if="state === 'busy'" class="dulo-overlay">
            A dulo login is already in progress in another tab. Close it and try again.
          </div>
          <div v-else-if="state === 'error'" class="dulo-overlay">
            <Icon name="x" :size="16" /> {{ message || 'Something went wrong starting the login browser.' }}
          </div>
          <div v-else-if="state === 'captured'" class="dulo-overlay good">
            <Icon name="check" :size="16" /> Connected — saving your session…
          </div>
        </div>
        <div class="muted" style="font-size: var(--fs-xs); margin-top: 10px;">
          Sign in with email or a social provider. After you sign in, dulo opens Live TV to register this
          device — if it asks, choose to use this device. TVApp2 then captures the session automatically and
          closes this panel — only the tokens are stored, never your password.
        </div>
        <div class="muted" style="font-size: var(--fs-xs); margin-top: 4px;">
          If Google says it can't sign you in here, close this and use <b>Paste session</b> in Settings.
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The streamed remote-browser surface — the one place a canvas needs its own styling (cf. HlsPlayer.vue). */
.dulo-stage {
  position: relative;
  width: 100%;
  background: #000;
  border-radius: var(--radius-m);
  overflow: hidden;
}
.dulo-canvas {
  display: block;
  width: 100%;
  height: auto;
  outline: none;
  touch-action: none; /* forward touch drags to the remote instead of scrolling the panel */
  cursor: default;
}
.dulo-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  text-align: center;
  font-size: var(--fs-sm);
  color: var(--text-1);
  background: rgba(0, 0, 0, 0.55);
}
.dulo-overlay.good {
  color: var(--good);
}
/* A thin, non-blocking banner across the top of the stage (canvas stays clickable beneath it). */
.dulo-banner {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 12px;
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-0);
  background: rgba(0, 0, 0, 0.66);
  pointer-events: none; /* never intercept clicks meant for the remote browser */
}
.dulo-banner.good {
  color: var(--good);
}
</style>
