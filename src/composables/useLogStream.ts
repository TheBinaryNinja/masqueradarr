// Live application logs over WebSocket (/api/logs-stream). A module-level singleton: the Logs drawer calls
// subscribe()/release() (ref-counted) so a single socket is shared. Each pushed frame is prepended into the
// shared LOGS ref (newest-first, capped) so the drawer — and any future consumer — stays live without
// polling. Mirrors useStreamStats.ts exactly (the repo's one-WS-client-per-concern pattern): proto from
// location.protocol, same-origin host, onmessage → update the shared ref, ref-counted reconnect.

import { LOGS, type Log } from '../data';

const LOGS_MAX = 1000; // bound the client-side buffer (the drawer renders a filtered slice of this)
const RECONNECT_MS = 3000;

let ws: WebSocket | null = null;
let refCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Prepend a freshly-pushed log line (server-generated → no dedupe needed). New array → ref identity changes
// → the drawer's computed re-runs. Capped to LOGS_MAX so a long-lived tab can't grow unbounded.
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
