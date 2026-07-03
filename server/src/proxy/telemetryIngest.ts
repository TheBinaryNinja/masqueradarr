import { noteViewer, noteBytes, type PlayerType } from '../sources/core/streamTelemetry.js';

// TELEMETRY INGEST (TEL). The sidecar measures the true byte edge (viewers, bytes) and reports events here;
// Node stays the telemetry AUTHORITY, feeding the SAME dormant cores the old in-process proxy drove
// (streamTelemetry → the /api/stream-stats WS + GET /api/active-streams; the 30s heartbeat-stop sweep then
// persists a ViewSession for History/Metrics). So Active Streams + History light up again with edge-measured
// data. Best-effort + fire-and-forget from Rust's side — a telemetry hiccup must never affect streaming.
//
// Event kinds:
//  · viewer — one per manifest poll Rust serves (the heartbeat that keeps a viewer "active"; 30s TTL). May
//    also carry the manifest's byte count. Fields: { source, entryUrl, ip, ua, username?, playerType, bytes? }.
//  · bytes  — one per segment/other send. Fields: { ip, ua, bytes, username? }. Channel attribution is via
//    the last viewer heartbeat for this identity (streamTelemetry's lastChannelByIdentity), so no entryUrl.
// A body may be a single event or { events: [...] } (batched — a P3 optimization); both are accepted.

interface TelemetryEvent {
  kind?: string;
  source?: unknown;
  entryUrl?: unknown;
  ip?: unknown;
  ua?: unknown;
  username?: unknown;
  playerType?: unknown;
  bytes?: unknown;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function applyEvent(e: TelemetryEvent): void {
  if (!e || typeof e !== 'object') return;
  const ip = str(e.ip);
  const ua = str(e.ua);
  const username = optStr(e.username);
  const bytes = typeof e.bytes === 'number' && e.bytes > 0 ? e.bytes : 0;
  if (e.kind === 'viewer') {
    const playerType: PlayerType = e.playerType === 'externalPlayer' ? 'externalPlayer' : 'appPlayer';
    noteViewer(str(e.source), str(e.entryUrl), ip, ua, username, playerType);
    if (bytes) noteBytes(ip, ua, bytes, username);
  } else if (e.kind === 'bytes') {
    if (bytes) noteBytes(ip, ua, bytes, username);
  }
}

export function ingestTelemetry(body: unknown): void {
  if (!body || typeof body !== 'object') return;
  const b = body as { events?: unknown };
  if (Array.isArray(b.events)) {
    for (const e of b.events) applyEvent(e as TelemetryEvent);
  } else {
    applyEvent(body as TelemetryEvent);
  }
}
