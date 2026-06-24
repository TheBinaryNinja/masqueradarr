// Probe-progress WebSocket hub — the transport layer over the DB-free probeAll.ts sweep. Mirrors
// stats/statsHub.ts: a Set of sockets, a JSON broadcast, and an attach() that registers a freshly-upgraded
// socket (from index.ts's upgrade handler on /api/probe-progress) and sends it the current state at once so
// a client connecting mid-sweep sees the live counter immediately. probeAll exposes onProbeProgress +
// getProbeStatus; this module subscribes — keeping the sweep itself transport-free (no cycle).

import { WebSocket } from 'ws';
import { logger } from './core/logger.js';
import { onProbeProgress, getProbeStatus, type ProbeState } from './probeAll.js';

const sockets = new Set<WebSocket>();

function send(ws: WebSocket, text: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(text);
    } catch {
      /* a broken socket is cleaned up on its own close/error */
    }
  }
}

function frame(status: ProbeState): string {
  return JSON.stringify({ type: 'probe-progress', status });
}

function broadcast(status: ProbeState): void {
  const text = frame(status);
  for (const ws of sockets) send(ws, text);
}

/** Wire a freshly-upgraded WebSocket into the probe-progress fan-out (called from index.ts's upgrade handler). */
export function attachProbe(ws: WebSocket): void {
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
  ws.on('error', () => {
    sockets.delete(ws);
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
  send(ws, frame(getProbeStatus())); // immediate first frame for the new client
}

let started = false;

/** Subscribe to the sweep's progress and fan it out. Non-fatal at boot; idempotent. */
export function startProbeHub(): void {
  if (started) return;
  started = true;
  onProbeProgress((status) => broadcast(status));
  logger.info('probe', 'probe hub started');
}

/** Close every socket (graceful shutdown). */
export function closeAllProbe(): void {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  sockets.clear();
}
