
import { LOGS, type Log } from '../data';

const LOGS_MAX = 1000;
const RECONNECT_MS = 3000;

let ws: WebSocket | null = null;
let refCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function ingestLog(log: Log): void {
  LOGS.value = [log, ...LOGS.value].slice(0, LOGS_MAX);
}

function connect(): void {
  if (ws) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/logs-stream`);
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    try {
      const msg = JSON.parse(ev.data) as { type?: string; log?: Log };
      if (msg.type === 'log' && msg.log) ingestLog(msg.log);
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

export function useLogStream() {
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
