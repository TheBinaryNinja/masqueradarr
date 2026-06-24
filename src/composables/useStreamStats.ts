// Live Active Streams over WebSocket (/api/stream-stats). A module-level singleton: every screen that needs
// the live snapshot calls subscribe()/release() (ref-counted) so a single socket is shared. Each push frame
// updates the shared ACTIVE_STREAMS ref (so the sidebar nav count + any consumer stay live) and appends to a
// per-channel rolling bitrate series for the detail bitrate chart. Mirrors the dulo login-stream WS pattern
// (DuloLoginDrawer.vue): proto from location.protocol, same-origin host, onmessage → update refs.

import { reactive } from 'vue';
import { ACTIVE_STREAMS, VIEW_SESSIONS, type ActiveStream, type ViewSession } from '../data';

const SERIES_MAX = 60; // points kept per channel for the bitrate chart
const SESSIONS_MAX = 500; // mirror GET /api/view-sessions' .limit(500)
const RECONNECT_MS = 3000;

// channelId → recent per-viewer bitrate samples (Mbps). reactive so the chart computed re-renders.
const series = reactive<Record<string, number[]>>({});

let ws: WebSocket | null = null;
let refCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function ingest(streams: ActiveStream[]): void {
  ACTIVE_STREAMS.value = streams;
  const present = new Set<string>();
  for (const s of streams) {
    present.add(s.channelId);
    const arr = series[s.channelId] ?? (series[s.channelId] = []);
    arr.push(s.bitrate);
    if (arr.length > SERIES_MAX) arr.shift();
  }
  // Forget the series of channels that no longer have viewers.
  for (const id of Object.keys(series)) if (!present.has(id)) delete series[id];
}

// A freshly-closed watch session pushed on session-close — prepend (newest-first, matching the server's
// sort) into the shared VIEW_SESSIONS history so the History/Metrics screen surfaces it live, with no
// re-fetch. Deduped by the session's natural key (guard against a row already pulled by the on-enter
// reload) and capped to the server's list limit. New array → ref identity changes → downstream computeds rerun.
function ingestSession(s: ViewSession): void {
  const key = `${s.channelId}|${s.ip}|${s.startedAt}`;
  const rest = VIEW_SESSIONS.value.filter((v) => `${v.channelId}|${v.ip}|${v.startedAt}` !== key);
  VIEW_SESSIONS.value = [s, ...rest].slice(0, SESSIONS_MAX);
}

function connect(): void {
  if (ws) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/stream-stats`);
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    try {
      const msg = JSON.parse(ev.data) as { type?: string; streams?: ActiveStream[]; session?: ViewSession };
      if (msg.type === 'active-streams' && Array.isArray(msg.streams)) ingest(msg.streams);
      else if (msg.type === 'view-session' && msg.session) ingestSession(msg.session);
      // 'buffer-event' frames are already reflected in the next snapshot's status, so no extra handling yet.
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

export function useStreamStats() {
  function subscribe(): void {
    refCount++;
    if (refCount === 1) connect();
  }
  function release(): void {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) disconnect();
  }
  /** Rolling per-viewer bitrate samples (Mbps) for a channel — drives the detail bitrate chart. */
  function bitrateSeries(channelId: string): number[] {
    return series[channelId] ?? [];
  }
  return { subscribe, release, bitrateSeries };
}
