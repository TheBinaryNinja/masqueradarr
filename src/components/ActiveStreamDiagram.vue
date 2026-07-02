<script setup lang="ts">
// Active Streams → the "Video Engine Service" rail. A per-stream architecture diagram for the SELECTED active
// stream: Channel Source → Video Engine → Client, with the Playlist that drives the engine and a GPU node when
// the engine is actually hardware-accelerated. Modeled on EncoderDiagramPanel.vue (HTML node-cards over an SVG
// cubic-bezier connector layer; `.enc-*` classes reused, `.asd-*` added). Pure presentational — the screen
// fetches engines (GET /api/active-streams/:id/engine) + the GPU frame (useSystemStats) and passes them in.
// Rendered ONLY when ≥1 external engine exists (the screen shows a passthrough note otherwise).
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { PLAYLISTS, type Channel, type ActiveStream, type StreamClient, type EngineSnapshot, type GpuStats } from '../data';

const props = defineProps<{
  channel: Channel;
  stream: ActiveStream;
  engines: EngineSnapshot[];
  clients: StreamClient[];
  gpu: GpuStats | null;
}>();

// The engine to depict: prefer a live one, else the most recently started. `extra` = how many other engine
// processes serve this channel under different videoconfigs (shown as a +N badge).
const eng = computed<EngineSnapshot | null>(() => {
  const es = props.engines;
  if (!es.length) return null;
  return es.find((e) => e.state === 'live') ?? [...es].sort((a, b) => b.startedAt - a.startedAt)[0];
});
const extra = computed(() => Math.max(0, props.engines.length - 1));

// The source playlist this channel belongs to (Playlist.id === the channel's source id), for the Playlist node.
const pl = computed(() => PLAYLISTS.value.find((p) => p.id === props.channel.source) ?? null);

// External-client identity for the Client node — same soft UA label the Active Streams table uses.
function externalClientName(ua: string): string {
  const u = (ua || '').toLowerCase();
  if (u.includes('tivimate')) return 'TiviMate';
  if (u.includes('kodi')) return 'Kodi';
  if (u.includes('vlc')) return 'VLC';
  if (u.includes('exoplayer')) return 'ExoPlayer';
  if (u.includes('lavf') || u.includes('ffmpeg')) return 'ffmpeg';
  if (u.includes('coremedia') || u.includes('apple')) return 'Apple';
  if (u.includes('okhttp') || u.includes('dalvik')) return 'Android';
  return 'External';
}
const extClients = computed(() => props.clients.filter((c) => c.playerType === 'externalPlayer'));
const clientPlayers = computed(() => {
  const names = [...new Set(extClients.value.map((c) => externalClientName(c.userAgent)))];
  return names.length ? names.join(', ') : 'external';
});
const extViewers = computed(() => props.stream.viewersByPlayer.externalPlayer || extClients.value.length);

// GPU node shows only when this stream's engine is hardware-accelerated AND a live host GPU frame exists.
const showGpu = computed(() => !!eng.value?.hwEncoder && !!props.gpu);

function hwLabel(e: EngineSnapshot): string {
  return e.hwEncoder || 'CPU';
}
function kindLabel(e: EngineSnapshot): string {
  return e.configId === 'app' ? 'Default' : 'Custom';
}
function mbps(kbps: number | null): string {
  return kbps == null ? '—' : (kbps / 1000).toFixed(1) + 'M';
}
function fpsLabel(n: number | null): string {
  return n == null ? '—' : n.toFixed(0);
}
function speedLabel(n: number | null): string {
  return n == null ? '—' : n.toFixed(2) + '×';
}
function dropLabel(n: number | null): string {
  return n == null ? '—' : String(n);
}
function pct(n: number | null): string {
  return n == null ? '—' : `${Math.round(n)}%`;
}
function fmtUptime(startedAt: number): string {
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}
// Strip a redacted upstream "host/path" to a compact display (host + a short tail of the path).
function shortUrl(u: string): string {
  if (!u) return '—';
  return u.length > 46 ? `…${u.slice(-44)}` : u;
}

// ── Layout — the diagram FILLS the rail. Node widths scale to the measured canvas width; the leftover canvas
// height is spread across the inter-node gaps (nodes keep readable fixed heights) so the diagram uses the full
// height instead of clustering at the top. Canvas size tracked via ResizeObserver.
const ACCENT = 'var(--accent)';
const GOOD = 'var(--good)';

// Arrowhead markers: one pair (start + end) per connector color so each <path> gets arrowheads filled
// with its own stroke token. (Avoids SVG2 context-stroke, which Chromium does not honor in <marker>.)
const ARROW_COLORS: { key: string; color: string }[] = [
  { key: 'accent', color: ACCENT },
  { key: 'good', color: GOOD },
];
const arrowMarkers = computed(() =>
  ARROW_COLORS.flatMap((c) => [
    { id: `asd-arrow-${c.key}-start`, color: c.color },
    { id: `asd-arrow-${c.key}-end`, color: c.color },
  ]),
);
function markerRef(hue: string, end: 'start' | 'end'): string {
  const key = hue === GOOD ? 'good' : 'accent';
  return `url(#asd-arrow-${key}-${end})`;
}

const canvasEl = ref<HTMLElement | null>(null);
const cw = ref(360);
const ch = ref(560);
let ro: ResizeObserver | null = null;
onMounted(() => {
  if (!canvasEl.value || typeof ResizeObserver === 'undefined') return;
  ro = new ResizeObserver((entries) => {
    const r = entries[0]?.contentRect;
    if (r) { cw.value = Math.round(r.width); ch.value = Math.round(r.height); }
  });
  ro.observe(canvasEl.value);
});
onBeforeUnmount(() => { ro?.disconnect(); ro = null; });

const PAD = 14;
const GAP_X = 14;

const layout = computed(() => {
  const gpuOn = showGpu.value;
  const W = Math.max(300, cw.value);
  const usableW = W - PAD * 2;
  const half = (usableW - GAP_X) / 2;
  // readable fixed node heights; the leftover canvas height fills the 3 inter-band gaps.
  const sH = 80, eH = 214, rowH = 112, cH = 92;
  const gap = Math.max(20, (ch.value - PAD * 2 - (sH + eH + rowH + cH)) / 3);

  const source = { x: PAD, y: PAD, w: usableW, h: sH, hue: ACCENT };
  const engine = { x: PAD, y: source.y + sH + gap, w: usableW, h: eH, hue: ACCENT };
  const rowY = engine.y + eH + gap;
  const playlist = { x: PAD, y: rowY, w: half, h: rowH, hue: ACCENT }; // always left-half; GPU takes the right slot
  const gpu = { x: PAD + half + GAP_X, y: rowY, w: half, h: rowH, hue: GOOD };
  const client = { x: PAD, y: rowY + rowH + gap, w: usableW, h: cH, hue: ACCENT };
  const h = Math.max(ch.value, client.y + cH + PAD);

  const cx = W / 2;
  const sBot = source.y + source.h, eTop = engine.y, eBot = engine.y + engine.h, cTop = client.y;
  const midGap = cTop - eBot;
  const conns: { key: string; d: string; hue: string; dash: boolean }[] = [];
  // feed spine: source → engine → client (solid accent), centered (clears the playlist/gpu row through its gap)
  conns.push({ key: 'src-eng', hue: ACCENT, dash: false, d: `M${cx} ${sBot} C${cx} ${sBot + gap * 0.4}, ${cx} ${eTop - gap * 0.4}, ${cx} ${eTop}` });
  conns.push({ key: 'eng-cli', hue: ACCENT, dash: false, d: `M${cx} ${eBot} C${cx} ${eBot + midGap * 0.5}, ${cx} ${cTop - midGap * 0.5}, ${cx} ${cTop}` });
  // playlist reference loop: engine ⇠ playlist ⇠ client (dashed) on the left — colored to the Playlist card accent
  const plcx = playlist.x + playlist.w / 2;
  conns.push({ key: 'pl-eng', hue: ACCENT, dash: true, d: `M${plcx} ${playlist.y} C${plcx} ${playlist.y - gap * 0.5}, ${plcx} ${eBot + gap * 0.5}, ${plcx} ${eBot}` });
  conns.push({ key: 'pl-cli', hue: ACCENT, dash: true, d: `M${plcx} ${playlist.y + rowH} C${plcx} ${playlist.y + rowH + gap * 0.5}, ${plcx} ${cTop - gap * 0.5}, ${plcx} ${cTop}` });
  // gpu branch: engine ↔ gpu (solid green) on the right — only when HW accelerated
  if (gpuOn) {
    const gcx = gpu.x + gpu.w / 2;
    conns.push({ key: 'gpu-eng', hue: GOOD, dash: false, d: `M${gcx} ${gpu.y} C${gcx} ${gpu.y - gap * 0.5}, ${gcx} ${eBot + gap * 0.5}, ${gcx} ${eBot}` });
  }
  return { source, engine, playlist, gpu, client, conns, w: W, h, gpuOn };
});

function box(n: { x: number; y: number; w: number; h: number; hue: string }) {
  return { left: n.x + 'px', top: n.y + 'px', width: n.w + 'px', height: n.h + 'px', '--hue': n.hue };
}
</script>

<template>
  <div class="asd-canvas" ref="canvasEl">
    <div class="asd-stage" :style="{ width: layout.w + 'px', height: layout.h + 'px' }">
      <!-- connector layer (under the cards) -->
      <svg class="enc-svg" :viewBox="`0 0 ${layout.w} ${layout.h}`" :width="layout.w" :height="layout.h">
        <!-- Bidirectional arrowheads. One marker pair per connector color (cyan spine/playlist, green GPU
             branch) with an EXPLICIT token fill — context-stroke is SVG2 and unsupported for <marker> in
             Chromium, which is why the arrows were invisible. Each path picks the pair matching its stroke. -->
        <defs>
          <marker v-for="m in arrowMarkers" :key="m.id" :id="m.id" class="asd-arrow"
                  viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"
                  orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <path d="M0 0 L10 5 L0 10 z" :fill="m.color" />
          </marker>
        </defs>
        <path v-for="c in layout.conns" :key="c.key" :d="c.d" :stroke="c.hue" :class="['enc-conn', { 'asd-dash': c.dash }]"
              :marker-start="markerRef(c.hue, 'start')" :marker-end="markerRef(c.hue, 'end')" />
      </svg>

      <!-- Channel Source -->
      <div class="enc-node enc-node-config asd-card" :style="box(layout.source)">
        <div class="asd-hd"><Icon name="globe" :size="14" /><span>Channel Source</span></div>
        <div class="enc-rows">
          <div class="enc-row"><span>Upstream</span><b class="mono" :title="eng?.upstreamUrl || ''">{{ shortUrl(eng?.upstreamUrl || '') }}</b></div>
          <div class="enc-row"><span>Source</span><b class="mono">{{ channel.source }}</b></div>
        </div>
      </div>

      <!-- Video Engine -->
      <div class="enc-node enc-node-config asd-card" :style="box(layout.engine)">
        <div class="asd-hd">
          <Icon name="activity" :size="14" /><span>Video Engine</span>
          <span class="spacer" />
          <span v-if="eng" class="enc-kind" :style="{ color: 'var(--accent)' }">{{ kindLabel(eng) }}</span>
          <span v-if="extra" class="enc-badge mono">+{{ extra }}</span>
        </div>
        <div class="enc-id mono">{{ eng?.configId }} · {{ eng?.engine }}</div>
        <!-- Borderless two-pair table: each row holds two label→value pairs (left = static/config
             Mode/Output/Preset/HW, right = live -progress metrics FPS/BitRate/DropFrames/Speed). The
             table only enforces column alignment — labels left, values right. The ffmpeg engine fills the
             live column from its -progress stream (values are '—' until the first block). -->
        <table class="asd-engtbl mono">
          <tbody>
            <tr>
              <td class="asd-k">Mode</td><td class="asd-v">{{ eng?.mode ?? '—' }}</td>
              <td class="asd-k">FPS</td><td class="asd-v">{{ fpsLabel(eng?.fps ?? null) }}</td>
            </tr>
            <tr>
              <td class="asd-k">Output</td><td class="asd-v">{{ eng?.output ?? '—' }}</td>
              <td class="asd-k">BitRate</td><td class="asd-v">{{ mbps(eng?.bitrateKbps ?? null) }}</td>
            </tr>
            <tr>
              <td class="asd-k">Preset</td><td class="asd-v" :title="eng?.preset || ''">{{ eng?.preset ?? '—' }}</td>
              <td class="asd-k">DropFrames</td><td class="asd-v">{{ dropLabel(eng?.dropFrames ?? null) }}</td>
            </tr>
            <tr>
              <td class="asd-k">HW</td><td class="asd-v">{{ eng ? hwLabel(eng) : '—' }}</td>
              <td class="asd-k">Speed</td><td class="asd-v">{{ speedLabel(eng?.speed ?? null) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="eng" class="asd-rt">
          <span class="asd-state" :class="eng.state">{{ eng.state }}</span>
          <span class="spacer" />
          <span class="asd-rt-m mono" :title="'engine uptime'">{{ fmtUptime(eng.startedAt) }}</span>
        </div>
        <div class="enc-args mono" :title="eng?.advancedArgs || ''">{{ eng?.advancedArgs || '—' }}</div>
      </div>

      <!-- Playlist -->
      <div class="enc-node enc-node-pl asd-card" :style="box(layout.playlist)">
        <div class="asd-hd"><Icon name="playlist" :size="13" /><span>Playlist</span></div>
        <div class="enc-pl-name">{{ pl?.name ?? channel.source }}</div>
        <div class="enc-rows">
          <div class="enc-row"><span>Source</span><b class="mono">{{ pl?.source || channel.source }}</b></div>
          <div class="enc-row"><span>Channels</span><b class="mono">{{ pl?.channels ?? '—' }}</b></div>
        </div>
      </div>

      <!-- GPU (only when HW accelerated) -->
      <div v-if="layout.gpuOn && gpu" class="enc-node enc-node-config asd-card" :style="box(layout.gpu)">
        <div class="asd-hd"><Icon name="chip" :size="14" /><span>GPU</span></div>
        <div class="enc-id mono">{{ eng?.hwEncoder }}</div>
        <div class="enc-rows">
          <div class="enc-row"><span>{{ gpu.vendor }}</span><b class="mono">{{ pct(gpu.utilizationPct) }}</b></div>
          <div class="enc-row"><span>Mem</span><b class="mono">{{ pct(gpu.memUsedPct) }}</b></div>
          <div class="enc-row"><span>Temp</span><b class="mono">{{ gpu.temperatureC != null ? gpu.temperatureC + '°' : '—' }}</b></div>
        </div>
      </div>

      <!-- Client -->
      <div class="enc-node enc-node-config asd-card" :style="box(layout.client)">
        <div class="asd-hd"><Icon name="tv" :size="14" /><span>Client</span></div>
        <div class="enc-rows">
          <div class="enc-row"><span>Viewers</span><b class="mono">{{ extViewers }} external</b></div>
          <div class="enc-row"><span>Player</span><b class="mono" :title="clientPlayers">{{ clientPlayers }}</b></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
  masqueradarr engine-rail harmonization. Brings the node-card headers into the spec-label idiom
  (mono uppercase plus a teal-leaning glyph) so they read like the detail panel teal captions.
  Surface treatment only: the node hue glow, all layout and connector geometry, and the realtime
  table are untouched. Scoped, so the Settings encoder diagram that shares the global classes is
  unaffected.
*/
.asd-hd > span {
  font-family: var(--mq-font-mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-1);
}
.asd-hd .ico { color: var(--hue, var(--accent)); }
</style>
