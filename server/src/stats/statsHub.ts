// Live stream-stats hub — the transport + persistence layer over the DB-free streamTelemetry core.
//
// Two responsibilities, both keeping streamTelemetry source-agnostic and DB-free:
//   1. Builds the DISPLAY snapshot — resolves each active channel's telemetry to a real channelId
//      (PlaylistChannel), attaches the live phase (streamState) + ffprobe quality (streamProbe), and formats
//      bytes/sec into Mbps + a human uptime. Served by GET /api/active-streams AND pushed over the WS.
//   2. WebSocket fan-out on /api/stream-stats — pushes the active-streams snapshot every BROADCAST_MS (only
//      while ≥1 client is connected) plus one-shot buffer-event frames, and persists a ViewSession row when
//      the telemetry core reports a closed viewer session.
//
// Mirrors routes/sources.ts → makePersistProbe: the core invokes injected sinks; the DB access lives here.

import { WebSocket } from 'ws';
import { logger } from '../sources/core/logger.js';
import { snapshotRaw, onSessionClose, onBufferEvent, type ClosedSession } from '../sources/core/streamTelemetry.js';
import { streamKey, phaseFor, type StreamPhase } from '../sources/core/streamState.js';
import { probeFor } from '../sources/core/streamProbe.js';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import { ViewSession } from '../models/ViewSession.js';
import type { StreamProbe } from '../models/StreamSession.js';
import { resolveGeo } from '../geoip/geoip.js';

const BROADCAST_MS = 2500;
// Don't persist a stray single poll as a "watch session" — only sessions of at least this long.
const MIN_SESSION_MS = 5_000;

// Display-side hysteresis for the live↔buffer pill. The underlying phase (streamState / engineHealth) flips to
// `buffer` the instant a single upstream poll fails or a transcode `speed` dips, then back to `live` on the
// next good sample — which makes the Active Streams pill flicker even though the stream is effectively fine.
// We hold the pill at `live` until a channel has stayed in `buffer` CONTINUOUSLY for STATUS_DEBOUNCE_MS; any
// `live` sample resets the streak. Recovery is instant and a hard `failed`/`establishing` is shown verbatim —
// only the noisy live↔buffer edge is damped. Display-ONLY: B-Roll serving, engine stall/fail detection, and
// buffer-event telemetry all still act on the REAL phase via phaseFor(); this just smooths what the pill shows.
const STATUS_DEBOUNCE_MS = 5_000;
// channelKey → epoch ms when the current uninterrupted `buffer` streak began (absent = not currently buffering).
const bufferDebounce = new Map<string, number>();

function statusOf(phase: StreamPhase): 'good' | 'warn' | 'bad' {
  return phase === 'live' ? 'good' : phase === 'failed' ? 'bad' : 'warn';
}

/** Apply the live↔buffer display debounce, returning the phase + status to PRESENT for this channel. */
function displayPhase(key: string, phase: StreamPhase, now: number): { phase: StreamPhase; status: 'good' | 'warn' | 'bad' } {
  if (phase !== 'buffer') {
    bufferDebounce.delete(key); // live / establishing / failed → show verbatim, reset any buffer streak
    return { phase, status: statusOf(phase) };
  }
  const since = bufferDebounce.get(key);
  if (since === undefined) {
    bufferDebounce.set(key, now); // first buffer sample of a streak — keep showing live for now
    return { phase: 'live', status: 'good' };
  }
  if (now - since < STATUS_DEBOUNCE_MS) return { phase: 'live', status: 'good' }; // within grace → hold at live
  return { phase: 'buffer', status: 'warn' }; // sustained buffering → surface it
}

// One display row per channel with ≥1 active viewer (1:1 with the SPA's ActiveStream interface).
export interface DisplayStream {
  id: string; // = channelId (stable row id)
  channelId: string;
  source: string;
  phase: StreamPhase;
  status: 'good' | 'warn' | 'bad'; // live → good, establishing/buffer → warn, failed → bad (live↔buffer debounced; see displayPhase)
  uptime: string; // human "1h 42m"
  uptimeMin: number;
  viewers: number;
  peakViewers: number;
  watchers: string[]; // distinct usernames watching (anonymous viewers omitted; never carries the token)
  viewersByPlayer: { appPlayer: number; externalPlayer: number }; // viewer split by player kind (in-app vs external IPTV client)
  bitrate: number; // Mbps — per-viewer stream bitrate
  bandwidth: number; // Mbps — total egress across all viewers
  bytesTotal: number;
  codec: string | null;
  audio: string | null;
  container: string | null;
  resolution: string | null;
  fps: number | null;
  probe: (StreamProbe & { probedAt: string }) | null;
}

// (source, entryUrl) → PlaylistChannel._id. Cached like routes/sources.ts → channelIdCache.
const channelIdCache = new Map<string, string | null>();
async function resolveChannelId(source: string, entryUrl: string): Promise<string | null> {
  const k = `${source}|${entryUrl}`;
  let id = channelIdCache.get(k);
  if (id === undefined) {
    // Match by the PROXY source (origin ?? source) — imports store source=<importId>, origin='direct', so the
    // telemetry's source ('direct') matches the channel's origin, not its source. Mirrors src/data.ts proxyPath.
    const doc = await PlaylistChannel.findOne(
      { streamEntryUrl: entryUrl, $or: [{ origin: source }, { origin: null, source }] },
      { _id: 1 },
    ).lean();
    id = doc?._id ?? null;
    channelIdCache.set(k, id);
  }
  return id;
}

function mbps(bytesPerSec: number): number {
  return +((bytesPerSec * 8) / 1_000_000).toFixed(2);
}

function humanUptime(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

function resolutionLabel(probe: (StreamProbe & { probedAt: string }) | null): string | null {
  if (!probe) return null;
  if (probe.video.height) return `${probe.video.height}p`;
  return probe.video.resolution;
}

/** Build the live Active Streams snapshot (resolved + quality-annotated). Served by REST and the WS. */
export async function buildDisplaySnapshot(): Promise<DisplayStream[]> {
  const raw = snapshotRaw();
  const now = Date.now();
  const out: DisplayStream[] = [];
  const activeKeys = new Set<string>();
  for (const r of raw) {
    const channelId = await resolveChannelId(r.source, r.entryUrl);
    if (!channelId) continue; // a channel with no PlaylistChannel row (shouldn't happen for a real play)
    activeKeys.add(r.channelKey);
    const { phase, status } = displayPhase(r.channelKey, phaseFor(r.channelKey).phase, now);
    const probe = probeFor(r.channelKey);
    out.push({
      id: channelId,
      channelId,
      source: r.source,
      phase,
      status,
      uptime: humanUptime(r.uptimeMs),
      uptimeMin: Math.round(r.uptimeMs / 60000),
      viewers: r.viewers,
      peakViewers: r.peakViewers,
      watchers: r.watchers,
      viewersByPlayer: r.viewersByPlayer,
      bitrate: mbps(r.bitrateBps),
      bandwidth: mbps(r.egressBps),
      bytesTotal: r.bytesTotal,
      codec: probe?.video.codec ?? null,
      audio: probe?.audio.codec ?? null,
      container: probe?.container ?? null,
      resolution: resolutionLabel(probe),
      fps: probe?.video.fps ?? null,
      probe,
    });
  }
  // Drop debounce state for channels no longer active (keeps the map bounded to live channels).
  for (const key of bufferDebounce.keys()) if (!activeKeys.has(key)) bufferDebounce.delete(key);
  return out;
}

// ── ViewSession persistence (the onSessionClose sink) ─────────────────────────────────────────────────

async function persistSession(s: ClosedSession): Promise<void> {
  if (s.durationMs < MIN_SESSION_MS) return; // drop stray single-poll "sessions"
  try {
    const channelId = await resolveChannelId(s.source, s.entryUrl);
    if (!channelId) return;
    const probe = probeFor(s.channelKey);
    // bytes*8 / ms  =  bits per millisecond  =  kbps.
    const avgBitrate = s.durationMs > 0 ? Math.round((s.bytesTotal * 8) / s.durationMs) : 0;
    const rebufRatio = s.durationMs > 0 ? s.rebufferMs / s.durationMs : 0;
    const qoeScore = Math.max(
      0,
      Math.round(100 - Math.min(60, rebufRatio * 400) - Math.min(30, s.bufferCount * 6)),
    );
    const health = qoeScore < 55 ? 'bad' : qoeScore < 80 ? 'warn' : 'good';
    // Resolve the viewer IP → geolocation at write time (forward-only: pre-existing rows stay null). Returns
    // null when geo is disabled (no MaxMind key) or the lookup fails — the UI renders an em-dash.
    const geo = await resolveGeo(s.ip);
    const session = {
      channelId,
      source: s.source,
      ip: s.ip,
      userAgent: s.userAgent,
      username: s.username || null,
      playerType: s.playerType,
      location: geo?.location ?? null,
      countryCode: geo?.countryCode ?? null,
      startedAt: s.connectedAt,
      endedAt: s.endedAt,
      durationMs: s.durationMs,
      bytesTotal: s.bytesTotal,
      avgBitrate,
      resolution: resolutionLabel(probe),
      codec: probe?.video.codec ?? null,
      bufferCount: s.bufferCount,
      rebufferMs: s.rebufferMs,
      bufferEvents: s.bufferEvents,
      qoeScore,
      health,
    };
    await ViewSession.create(session);
    // Push the freshly-persisted row to any live History/Metrics screen — the frame IS the row shape
    // (minus _id), so the SPA prepends it without a re-fetch. No-op when no socket is connected.
    broadcast({ type: 'view-session', session });
    logger.info('history', `session persisted: ${channelId} · ${Math.round(s.durationMs / 1000)}s · qoe ${qoeScore}`);
  } catch (err) {
    logger.error('history', `viewsession persist failed: ${(err as Error).message}`);
  }
}

// ── WebSocket fan-out ─────────────────────────────────────────────────────────────────────────────────

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

function broadcast(payload: unknown): void {
  const text = JSON.stringify(payload);
  for (const ws of sockets) send(ws, text);
}

async function pushSnapshot(only?: WebSocket): Promise<void> {
  const text = JSON.stringify({ type: 'active-streams', streams: await buildDisplaySnapshot() });
  if (only) send(only, text);
  else for (const ws of sockets) send(ws, text);
}

/** Wire a freshly-upgraded WebSocket into the stats fan-out (called from index.ts's upgrade handler). */
export function attachStats(ws: WebSocket): void {
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
  void pushSnapshot(ws); // immediate first frame for the new client
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the broadcast loop + register the telemetry sinks. Non-fatal at boot; idempotent. */
export function startStatsHub(): void {
  if (timer) return;
  onSessionClose((s) => void persistSession(s));
  onBufferEvent((channelKey, source, entryUrl, phase, at) => {
    void (async () => {
      const channelId = await resolveChannelId(source, entryUrl);
      broadcast({ type: 'buffer-event', channelId, channelKey, phase, at });
    })();
  });
  timer = setInterval(() => {
    if (sockets.size) void pushSnapshot();
  }, BROADCAST_MS);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info('stats', 'stats hub started');
}

/** Stop the loop + close every socket (graceful shutdown). */
export function closeAllStats(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  sockets.clear();
}
