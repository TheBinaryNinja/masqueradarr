// Live system-performance stats over WebSocket (/api/system-stats). A module-level singleton: every screen
// that needs the live frame calls subscribe()/release() (ref-counted) so a single socket is shared. Each push
// frame updates the shared SYSTEM_STATS ref and appends CPU% to a rolling series for the LivelineChart.
// Mirrors useStreamStats.ts (the same singleton + reconnect pattern); the feed is admin-only (operator data),
// so only the admin Dashboard subscribes.

import { ref } from 'vue';
import { SYSTEM_STATS, type SystemStats } from '../data';

const SERIES_MAX = 60; // points kept for the CPU chart (60 × 2.5s = 150s, matches LivelineChart window)
const RECONNECT_MS = 3000;

// Rolling CPU% samples (oldest→newest). A ref<number[]> mutated in place (push/shift) — stable identity, so
// LivelineChart's deep watch fires per sample (same contract as useStreamStats' reactive bitrate series).
export const cpuSeries = ref<number[]>([]);

// Rolling GPU utilization% samples — same in-place contract as cpuSeries, drives the GPU Performance card's
// liveline. Populated only while gpu.utilizationPct is reported; cleared when HW accel is off (gpu === null).
export const gpuSeries = ref<number[]>([]);

let ws: WebSocket | null = null;
let refCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function ingest(s: SystemStats): void {
  SYSTEM_STATS.value = s;
  if (s.cpu.usagePct != null) {
    cpuSeries.value.push(s.cpu.usagePct); // skip the first-tick null (CPU needs a delta)
    if (cpuSeries.value.length > SERIES_MAX) cpuSeries.value.shift();
  }
  if (s.gpu == null) {
    if (gpuSeries.value.length) gpuSeries.value.length = 0; // HW accel off → drop the stale GPU series
  } else if (s.gpu.utilizationPct != null) {
    gpuSeries.value.push(s.gpu.utilizationPct);
    if (gpuSeries.value.length > SERIES_MAX) gpuSeries.value.shift();
  }
}

function connect(): void {
  if (ws) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/system-stats`);
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    try {
      const msg = JSON.parse(ev.data) as { type?: string; stats?: SystemStats };
      if (msg.type === 'system-stats' && msg.stats) ingest(msg.stats);
    } catch {
      /* ignore a malformed frame */
    }
  };
  ws.onclose = () => {
    ws = null;
    if (refCount > 0) scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (refCount > 0) connect();
  }, RECONNECT_MS);
}

function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
}

export function useSystemStats() {
  function subscribe(): void {
    refCount++;
    if (refCount === 1) connect();
  }
  function release(): void {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) disconnect();
  }
  return { subscribe, release, cpuSeries, gpuSeries };
}
