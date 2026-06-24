<script setup lang="ts">
// Settings → Advanced → Video Configuration → "Encoder Diagram". A read-only topology view of every
// externalPlayer video config (Default `app` + each Custom `app_<playlistId>`) curve-connected to the
// playlists that use it. Linkage is derived client-side from each playlist's `videoconfig` field; config
// detail is read with getJson (NOT useVideoConfig — that composable installs debounced PUT watchers meant
// for editing a single config). Rendered as HTML node-cards over an SVG cubic-bezier connector layer.
import { ref, computed, watch, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import { PLAYLISTS, getJson, type Playlist } from '../data';

const emit = defineEmits<{ (e: 'close'): void }>();

// Shape of GET /api/video-config/:id (server returns Omit<VideoConfigDoc, '_id'>) — only the fields shown.
interface VideoConfigData {
  enabledEngine: 'ffmpeg' | 'vlc' | null;
  mode: string;
  output: string;
  ffmpeg: { preset: string; advancedArgs: string };
  vlc: { preset: string; advancedArgs: string };
  hwAccel: { enabled: boolean; encoder: string };
}
interface ConfigGroup {
  id: string;                       // 'app' | 'app_<playlistId>'
  kind: 'default' | 'custom';
  data: VideoConfigData | null;     // null if the fetch failed
  playlists: Playlist[];
  hue: string;                      // glow / connector color
}

// Theme-safe palette: Default = accent cyan, customs cycle these oklch hues (all legible in light + dark).
const PALETTE = [
  'var(--accent)',
  'oklch(0.74 0.16 150)', // green
  'oklch(0.80 0.15 80)',  // amber
  'oklch(0.70 0.16 300)', // violet
  'oklch(0.74 0.15 25)',  // coral
  'oklch(0.78 0.12 195)', // teal
];

// Which config id a playlist routes through: 'default'/absent → the global 'app', else its 'app_<id>'.
function configIdFor(pl: Playlist): string {
  return !pl.videoconfig || pl.videoconfig === 'default' ? 'app' : pl.videoconfig;
}

const loading = ref(true);
const groups = ref<ConfigGroup[]>([]);

async function gather(): Promise<void> {
  loading.value = true;
  const pls = PLAYLISTS.value;
  const customIds = [...new Set(pls.map(configIdFor).filter((id) => id !== 'app'))].sort();
  const ids = ['app', ...customIds];
  const fetched = await Promise.all(
    ids.map((id) => getJson<VideoConfigData>('/api/video-config/' + id).catch(() => null)),
  );
  groups.value = ids.map((id, i) => ({
    id,
    kind: id === 'app' ? 'default' : 'custom',
    data: fetched[i],
    playlists: pls.filter((pl) => configIdFor(pl) === id).sort((a, b) => a.name.localeCompare(b.name)),
    hue: PALETTE[i % PALETTE.length],
  }));
  loading.value = false;
}

onMounted(gather);
// Re-gather if a playlist is added/removed or re-pointed at a different config while the panel is open.
watch(() => PLAYLISTS.value.map((p) => p.id + ':' + configIdFor(p)).join(','), gather);

// ── Layout (fixed node heights → deterministic coords shared by the cards and the SVG curves) ──
const NODE_W_CONFIG = 300;
const NODE_W_PL = 264;
const CONFIG_H = 184;
const PL_H = 114;
const COL_GAP = 190;   // horizontal room between columns for the curves to breathe
const PAD = 16;
const ROW_GAP = 16;    // between playlist cards within a group
const GROUP_GAP = 30;  // extra space between config groups
const CONFIG_GAP = 22; // min space between adjacent config cards (de-overlap)

const layout = computed(() => {
  const gs = groups.value;
  const colRX = PAD + NODE_W_CONFIG + COL_GAP;
  const plNodes: { pl: Playlist; x: number; y: number; hue: string }[] = [];
  const cfg: (ConfigGroup & { count: number; x: number; y: number; cy: number })[] = [];
  const plY = new Map<string, number>(); // playlist id → top-left y

  let y = PAD;
  for (const g of gs) {
    const top = y;
    for (const pl of g.playlists) {
      plNodes.push({ pl, x: colRX, y, hue: g.hue });
      plY.set(pl.id, y);
      y += PL_H + ROW_GAP;
    }
    const bottom = g.playlists.length ? y - ROW_GAP : top + CONFIG_H;
    const center = (top + bottom) / 2;
    cfg.push({ ...g, count: g.playlists.length, x: PAD, y: center - CONFIG_H / 2, cy: center });
    y = (g.playlists.length ? y : top + CONFIG_H + ROW_GAP) + GROUP_GAP;
  }

  // De-overlap the left (config) column while preserving order; keeps the fan shape, avoids collisions.
  let prevBottom = PAD - CONFIG_GAP;
  for (const c of cfg) {
    if (c.y < prevBottom + CONFIG_GAP) c.y = prevBottom + CONFIG_GAP;
    c.cy = c.y + CONFIG_H / 2;
    prevBottom = c.y + CONFIG_H;
  }

  // Cubic-bezier connectors: config right-middle → playlist left-middle (horizontal control points = no kinks).
  const conns: { key: string; d: string; hue: string }[] = [];
  for (const c of cfg) {
    const sx = c.x + NODE_W_CONFIG, sy = c.cy;
    for (const pl of c.playlists) {
      const ey = (plY.get(pl.id) ?? 0) + PL_H / 2;
      const ex = colRX;
      const dx = ex - sx;
      conns.push({ key: c.id + '->' + pl.id, hue: c.hue, d: `M${sx} ${sy} C${sx + dx * 0.5} ${sy}, ${ex - dx * 0.5} ${ey}, ${ex} ${ey}` });
    }
  }

  const w = colRX + NODE_W_PL + PAD;
  const h = Math.max(y - GROUP_GAP, prevBottom) + PAD;
  return { plNodes, cfg, conns, w, h };
});

function engineLabel(d: VideoConfigData | null): string {
  if (!d) return '—';
  return d.enabledEngine ?? 'disabled';
}
function presetLabel(d: VideoConfigData | null): string {
  if (!d) return '—';
  const eng = d.enabledEngine ?? 'ffmpeg';
  return (eng === 'vlc' ? d.vlc?.preset : d.ffmpeg?.preset) || '—';
}
function hwLabel(d: VideoConfigData | null): string {
  if (!d) return '—';
  return d.hwAccel?.enabled ? (d.hwAccel.encoder || 'on') : 'CPU';
}
function argsLabel(d: VideoConfigData | null): string {
  if (!d) return '';
  const eng = d.enabledEngine ?? 'ffmpeg';
  return (eng === 'vlc' ? d.vlc?.advancedArgs : d.ffmpeg?.advancedArgs) || '';
}
</script>

<template>
  <div class="enc-diagram card">
    <div class="enc-hd">
      <h3 class="section-title" style="margin: 0;"><Icon name="topology" :size="16" /> Encoder Diagram</h3>
      <span class="spacer" />
      <span class="muted mono" style="font-size: var(--fs-xs);">
        {{ groups.length }} config{{ groups.length === 1 ? '' : 's' }} · {{ PLAYLISTS.length }} playlist{{ PLAYLISTS.length === 1 ? '' : 's' }}
      </span>
      <Btn variant="ghost" size="sm" icon="x" title="Close diagram" @click="emit('close')" />
    </div>

    <div class="enc-canvas">
      <div v-if="loading" class="enc-state muted">Loading video configurations…</div>
      <div v-else class="enc-stage" :style="{ width: layout.w + 'px', height: layout.h + 'px' }">
        <!-- Connector layer (under the cards) -->
        <svg class="enc-svg" :viewBox="`0 0 ${layout.w} ${layout.h}`" :width="layout.w" :height="layout.h">
          <path v-for="c in layout.conns" :key="c.key" :d="c.d" :stroke="c.hue" class="enc-conn" />
        </svg>

        <!-- Config nodes (left column) -->
        <div v-for="n in layout.cfg" :key="n.id" class="enc-node enc-node-config"
             :style="{ left: n.x + 'px', top: n.y + 'px', width: NODE_W_CONFIG + 'px', height: CONFIG_H + 'px', '--hue': n.hue }">
          <div class="enc-node-hd">
            <span class="enc-kind" :style="{ color: n.hue }">{{ n.kind === 'default' ? 'Default' : 'Custom' }}</span>
            <span class="enc-badge mono">video&#8209;config</span>
          </div>
          <div class="enc-id mono">{{ n.id }}</div>
          <div class="enc-rows">
            <div class="enc-row"><span>Engine</span><b class="mono">{{ engineLabel(n.data) }}</b></div>
            <div class="enc-row"><span>Mode</span><b class="mono">{{ n.data?.mode ?? '—' }}</b></div>
            <div class="enc-row"><span>Output</span><b class="mono">{{ n.data?.output ?? '—' }}</b></div>
            <div class="enc-row"><span>Preset</span><b class="mono">{{ presetLabel(n.data) }}</b></div>
            <div class="enc-row"><span>HW</span><b class="mono">{{ hwLabel(n.data) }}</b></div>
          </div>
          <div class="enc-args mono" :title="argsLabel(n.data)">{{ argsLabel(n.data) || '—' }}</div>
        </div>

        <!-- Playlist nodes (right column) -->
        <div v-for="n in layout.plNodes" :key="n.pl.id" class="enc-node enc-node-pl"
             :style="{ left: n.x + 'px', top: n.y + 'px', width: NODE_W_PL + 'px', height: PL_H + 'px', '--hue': n.hue }">
          <div class="enc-pl-name">{{ n.pl.name }}</div>
          <div class="enc-id mono">{{ n.pl.id }}</div>
          <div class="enc-rows">
            <div class="enc-row"><span>Source</span><b class="mono">{{ n.pl.source || 'custom' }}</b></div>
            <div class="enc-row"><span>Channels</span><b class="mono">{{ n.pl.channels }}</b></div>
            <div class="enc-row"><span>Status</span><b class="mono">{{ n.pl.status }}</b></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
