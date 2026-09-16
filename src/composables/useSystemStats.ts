
import { ref } from 'vue';
import { SYSTEM_STATS, type SystemStats } from '../data';

const SERIES_MAX = 60;
const RECONNECT_MS = 3000;

export const cpuSeries = ref<number[]>([]);

export const cpuTimes = ref<number[]>([]);

let ws: WebSocket | null = null;
let refCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function ingest(s: SystemStats): void {
  SYSTEM_STATS.value = s;
  const now = Date.now();
  if (s.cpu.usagePct != null) {
    cpuSeries.value.push(s.cpu.usagePct);
    cpuTimes.value.push(now);
    if (cpuSeries.value.length > SERIES_MAX) { cpuSeries.value.shift(); cpuTimes.value.shift(); }
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
  return { subscribe, release, cpuSeries, cpuTimes };
}
