<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Liveline } from 'liveline';
import { useTweaks } from '../composables/useTweaks';

const props = defineProps<{ series: number[]; target: number; times?: number[] }>();
const { tweaks } = useTweaks();

const SAMPLE_MS = 2500;

const ACCENT_DARK = '#48d7fe';
const ACCENT_LIGHT = '#0079a4';
const color = computed(() => (tweaks.theme === 'dark' ? ACCENT_DARK : ACCENT_LIGHT));

const renderable = computed(() => {
  const s = props.series ?? [];
  if (s.length < 2 || !s.every(Number.isFinite)) return false;
  return Math.max(...s) - Math.min(...s) > 0;
});

function toPoints(series: number[]) {
  const t = props.times;
  if (t && t.length === series.length) {
    return series.map((v, i) => ({ time: t[i] / 1000, value: v }));
  }
  const nowSec = Date.now() / 1000;
  const n = series.length;
  return series.map((v, i) => ({ time: nowSec - (n - 1 - i) * (SAMPLE_MS / 1000), value: v }));
}

const host = ref<HTMLDivElement | null>(null);
let root: Root | null = null;
let rafId: number | null = null;

function scheduleRender() {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => { rafId = null; render(); });
}

function render() {
  if (!root) return;
  if (!renderable.value) {
    root.render(
      createElement('div', {
        style: { width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: 'var(--text-3)', fontSize: '12px' },
      }, 'Waiting for live samples…'),
    );
    return;
  }
  const series = props.series;
  const latest = series[series.length - 1];
  root.render(
    createElement(Liveline, {
      data: toPoints(series),
      value: latest,
      theme: tweaks.theme,
      color: color.value,
      grid: true,
      badge: true,
      badgeVariant: 'default',
      fill: true,
      pulse: true,
      lineWidth: 4,
      scrub: true,
      exaggerate: true,
      showValue: true,
      valueMomentumColor: true,
      degen: true,
      window: 150,
      windowStyle: 'rounded',
    }),
  );
}

onMounted(() => {
  if (!host.value) return;
  root = createRoot(host.value);
  render();
});

watch(() => [props.series, props.times, props.target, tweaks.theme, renderable.value] as const, scheduleRender, { deep: true });

onBeforeUnmount(() => {
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  const r = root;
  root = null;
  if (r) Promise.resolve().then(() => r.unmount());
});
</script>

<template>
  <div ref="host" class="liveline-host" />
</template>

<style scoped>
.liveline-host {
  --liveline-h: 250px;
  width: 100%;
  min-height: var(--liveline-h);
}
.liveline-host > :deep(div:last-child) { height: var(--liveline-h) !important; }
</style>
