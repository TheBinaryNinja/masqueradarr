
import { reactive } from 'vue';
import { ACTIVE_STREAMS, VIEW_SESSIONS, type ActiveStream, type ViewSession } from '../data';

const SERIES_MAX = 60;
const SESSIONS_MAX = 500;
const LIVE_BUFFER_MAX = 200;
const RECONNECT_MS = 3000;

const series = reactive<Record<string, number[]>>({});

interface IngestMeta {
  lastAt: number;
  recvAt: number;
  lastBytes: number;
  mbps: number | null;
}
const ingestMeta = reactive<Record<string, IngestMeta>>({});

export interface LiveBufferEvent {
  channelId: string | null;
  channelKey: string;
  phase: 'buffer' | 'failed';
  at: number;
  side: 'upstream' | 'client';
  recvAt: number;
}
const liveBufferEvents = reactive<LiveBufferEvent[]>([]);

let ws: WebSocket | null = null;
let refCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

let serverOffset = 0;

function noteServerClock(at: number): void {
  if (Number.isFinite(at)) serverOffset = at - Date.now();
}

export function serverNow(): number {
  return Date.now() + serverOffset;
}

function ingest(streams: ActiveStream[]): void {
  ACTIVE_STREAMS.value = streams;
  const present = new Set<string>();
  const now = Date.now();
  for (const s of streams) {
    present.add(s.channelId);
    const arr = series[s.channelId] ?? (series[s.channelId] = []);
    arr.push(s.bitrate);
    if (arr.length > SERIES_MAX) arr.shift();

    const ing = s.ingest;
    if (!ing) continue;
    const prev = ingestMeta[s.channelId];
    if (!prev) {
      const age = Math.max(0, serverNow() - ing.at);
      ingestMeta[s.channelId] = { lastAt: ing.at, recvAt: now - age, lastBytes: ing.ingestedBytes, mbps: null };
    } else if (ing.at !== prev.lastAt) {
      const dtMs = ing.at - prev.lastAt;
      const dBytes = ing.ingestedBytes - prev.lastBytes;
      prev.mbps = dtMs <= 0 || dBytes < 0 ? null : (dBytes * 8) / (dtMs / 1000) / 1e6;
      prev.lastAt = ing.at;
      prev.recvAt = now;
      prev.lastBytes = ing.ingestedBytes;
    }
  }
  for (const id of Object.keys(series)) if (!present.has(id)) delete series[id];
  for (const id of Object.keys(ingestMeta)) if (!present.has(id)) delete ingestMeta[id];
}

function ingestSession(s: ViewSession): void {
  const key = `${s.channelId}|${s.ip}|${s.startedAt}`;
  const rest = VIEW_SESSIONS.value.filter((v) => `${v.channelId}|${v.ip}|${v.startedAt}` !== key);
  VIEW_SESSIONS.value = [s, ...rest].slice(0, SESSIONS_MAX);
}

function ingestBufferEvent(m: { channelId?: string | null; channelKey?: string; phase?: 'buffer' | 'failed'; at?: number; side?: 'upstream' | 'client' }): void {
  liveBufferEvents.push({
    channelId: m.channelId ?? null,
    channelKey: m.channelKey ?? '',
    phase: m.phase === 'failed' ? 'failed' : 'buffer',
    at: typeof m.at === 'number' ? m.at : Date.now(),
    side: m.side === 'client' ? 'client' : 'upstream',
    recvAt: Date.now(),
  });
  if (liveBufferEvents.length > LIVE_BUFFER_MAX) liveBufferEvents.splice(0, liveBufferEvents.length - LIVE_BUFFER_MAX);
}

function connect(): void {
  if (ws) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/stream-stats`);
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    try {
      const msg = JSON.parse(ev.data) as {
        type?: string;
        streams?: ActiveStream[];
        session?: ViewSession;
        channelId?: string | null;
        channelKey?: string;
        phase?: 'buffer' | 'failed';
        at?: number;
        side?: 'upstream' | 'client';
      };
      if (typeof msg.at === 'number' && msg.type === 'active-streams') noteServerClock(msg.at);
      if (msg.type === 'active-streams' && Array.isArray(msg.streams)) ingest(msg.streams);
      else if (msg.type === 'view-session' && msg.session) ingestSession(msg.session);
      else if (msg.type === 'buffer-event' && msg.channelKey) ingestBufferEvent(msg);
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

export function useStreamStats() {
  function subscribe(): void {
    refCount++;
    if (refCount === 1) connect();
  }
  function release(): void {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) disconnect();
  }
  function bitrateSeries(channelId: string): number[] {
    return series[channelId] ?? [];
  }
  function ingestAge(channelId: string): number {
    const m = ingestMeta[channelId];
    return m ? Date.now() - m.recvAt : Infinity;
  }
  function ingestMbps(channelId: string): number | null {
    return ingestMeta[channelId]?.mbps ?? null;
  }
  return { subscribe, release, bitrateSeries, ingestAge, ingestMbps, liveBufferEvents };
}
