// Live channel-probe sweep progress over WebSocket (/api/probe-progress). A module-level singleton mirroring
// useStreamStats.ts: consumers call subscribe()/release() (ref-counted) so one socket is shared. Each frame
// updates the shared PROBE_STATUS ref, which drives the sidebar "Probe: running" indicator (App.vue). The
// server sends the current state on connect (so a client joining mid-sweep sees it immediately) and a final
// idle frame (running:false) when the sweep ends.

import { PROBE_STATUS, type ProbeStatus } from '../data';

const RECONNECT_MS = 3000;

let ws: WebSocket | null = null;
let refCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connect(): void {
  if (ws) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/probe-progress`);
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    try {
      const msg = JSON.parse(ev.data) as { type?: string; status?: ProbeStatus };
      if (msg.type === 'probe-progress' && msg.status) PROBE_STATUS.value = msg.status;
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

export function useProbeProgress() {
  function subscribe(): void {
    refCount++;
    if (refCount === 1) connect();
  }
  function release(): void {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) disconnect();
  }
  return { subscribe, release };
}
