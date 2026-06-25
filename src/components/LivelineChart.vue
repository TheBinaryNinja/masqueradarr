<script setup lang="ts">
// React-in-Vue bridge for the `liveline` chart (npm: liveline — a React component; this SPA is Vue).
// Mounts <Liveline> into a DOM node via react-dom/client createRoot, re-renders on prop/theme change,
// unmounts on teardown. Self-contained, reusable "Bitrate · live" chart — drop it into any screen or
// component (Active Streams detail panel, Channel Drawer, …) inside a width-bearing parent.
// liveline draws to <canvas>, so `color` is a concrete hex (not a CSS var); `theme` binds to the app's
// reactive tweaks.theme. Props are { series, target }, fed by a consumer's data pipeline
// (useStreamStats → bitrateSeries → series/target).
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Liveline } from 'liveline';
import { useTweaks } from '../composables/useTweaks';

// `times` (optional): per-sample arrival timestamps (epoch ms), index-aligned with `series`. When a
// consumer supplies them, each point keeps a STABLE absolute time so liveline scrolls the window
// smoothly; without them the bridge synthesizes times from a fixed cadence (correct only at the render
// instant — fine for a growing/short series, but a full window re-anchors and jitters; skill §7.1).
const props = defineProps<{ series: number[]; target: number; times?: number[] }>();
const { tweaks } = useTweaks();

const SAMPLE_MS = 2500; // WS push cadence (statsHub.ts BROADCAST_MS / useStreamStats SERIES_MAX×2.5s = 150s)

// --accent resolved to hex per theme (canvas can't take a CSS var). Source-of-truth: src/styles.css.
const ACCENT_DARK = '#48d7fe';  // oklch(0.82 0.13 220) — :root --accent
const ACCENT_LIGHT = '#0079a4'; // oklch(0.52 0.15 220) — [data-theme="light"] --accent
const color = computed(() => (tweaks.theme === 'dark' ? ACCENT_DARK : ACCENT_LIGHT));

// Guard: liveline's grid-tick math has uncapped while-loops that diverge (hard main-thread freeze)
// when fed a degenerate series — a zero/near-zero value-range or non-finite values, which is exactly
// what a freshly-switched channel produces before real samples arrive. Only mount <Liveline> once the
// data has ≥2 finite samples with a real spread; otherwise show a placeholder.
const renderable = computed(() => {
  const s = props.series ?? [];
  if (s.length < 2 || !s.every(Number.isFinite)) return false;
  return Math.max(...s) - Math.min(...s) > 0;
});

// number[] (oldest→newest) → LivelinePoint[]. Prefer caller-supplied per-sample arrival timestamps
// (`times`, epoch ms, index-aligned) — a STABLE anchor per point that lets liveline scroll the window
// smoothly. Fall back to synthesizing times from `now` on a fixed cadence when none are passed (newest
// at "now"); that re-anchors on every render, so steady-state consumers should pass `times` (skill §7.1).
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

// Coalesce reactive bursts (rapid channel switches + per-sample ticks all fire in one frame) into a
// single React reconcile per animation frame. liveline self-animates via its own RAF, so the bridge
// only needs to push fresh props.
function scheduleRender() {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => { rafId = null; render(); });
}

function render() {
  if (!root) return;
  if (!renderable.value) {
    // Neutral placeholder — keeps the host's height stable without feeding liveline degenerate data.
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
      theme: tweaks.theme,        // 'light' | 'dark' — bound to the app theme
      color: color.value,         // concrete cyan hex, theme-resolved
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
      window: 150,                // seconds (2:30) — matches 60 samples × 2.5s
      windowStyle: 'rounded',
    }),
  );
}

onMounted(() => {
  if (!host.value) return;
  root = createRoot(host.value);
  render();
});

// Re-render the React tree on data / target / theme / renderability change. Deep on series:
// bitrateSeries() mutates the array in place (push/shift), so the ref identity is stable and only a
// deep watch fires per sample. Routed through scheduleRender() so a burst collapses to one reconcile.
watch(() => [props.series, props.times, props.target, tweaks.theme, renderable.value] as const, scheduleRender, { deep: true });

onBeforeUnmount(() => {
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  // Defer unmount out of Vue's synchronous teardown to avoid React's "unmount during render" warning.
  const r = root;
  root = null;
  if (r) Promise.resolve().then(() => r.unmount());
});
</script>

<template>
  <!-- liveline fills its parent; the parent needs a height. 250px matches the prior chart spec. -->
  <div ref="host" class="liveline-host" />
</template>

<style scoped>
/* Deliberate scoped-block exception (precedent: HlsPlayer.vue): liveline sizes to this host, so the
   height can't be a reusable token class. */
.liveline-host { width: 100%; height: 250px; min-height: 250px; }
</style>
