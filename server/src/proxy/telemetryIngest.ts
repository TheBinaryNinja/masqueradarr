import { noteViewer, noteBytes, noteMedia, type PlayerType } from '../sources/core/streamTelemetry.js';
import { streamKey, noteSuccess, noteFailed, noteFailure } from '../sources/core/streamState.js';

// TELEMETRY INGEST (TEL). The sidecar measures the true byte edge (viewers, bytes) and reports events here;
// Node stays the telemetry AUTHORITY, feeding the SAME cores the old in-process proxy drove (streamTelemetry →
// the /api/stream-stats WS + GET /api/active-streams; streamState → the phase machine; the 30s heartbeat-stop
// sweep then persists a ViewSession for History/Metrics). So Active Streams + History light up with
// edge-measured data. Best-effort + fire-and-forget from Rust's side — a telemetry hiccup must never affect
// streaming.
//
// Event kinds (all carry { source, entryUrl } so the channel's phase-machine key = streamKey(source, entryUrl)):
//  · viewer   — one per manifest poll Rust serves (the heartbeat that keeps a viewer "active"; 30s TTL). Also
//    a 2xx success → noteSuccess (→ live). Fields: { source, entryUrl, ip, ua, username?, playerType, bytes? }.
//  · bytes    — one per segment/other 2xx send. Drives noteBytes (egress, attributed by identity) AND
//    noteSuccess (keeps the channel live). Fields: { source, entryUrl, ip, ua, username?, bytes }.
//  · upstream — a failure: a non-2xx response OR a Node resolve failure (ok:false, status>0 — Rust uses a 502
//    sentinel for a resolve failure) → noteFailed (→ failed); a transport error with no response (status 0) →
//    noteFailure (spends one retry). Fields: { source, entryUrl, status }.
//  · media    — manifest-declared decode metadata → noteMedia. Fields: { source, entryUrl, resolution?,
//    codecs?, frameRate?, container? } (any subset; nulls mean "no update this poll").
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
  status?: unknown;
  resolution?: unknown;
  codecs?: unknown;
  frameRate?: unknown;
  container?: unknown;
  bandwidth?: unknown;
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
  const source = str(e.source);
  const entryUrl = str(e.entryUrl);
  const bytes = typeof e.bytes === 'number' && e.bytes > 0 ? e.bytes : 0;

  if (e.kind === 'viewer') {
    const playerType: PlayerType = e.playerType === 'externalPlayer' ? 'externalPlayer' : 'appPlayer';
    noteViewer(source, entryUrl, ip, ua, username, playerType);
    if (bytes) noteBytes(ip, ua, bytes, username);
    // PHZ: a served manifest poll is a 2xx upstream success → drive establishing→live.
    if (source && entryUrl) noteSuccess(streamKey(source, entryUrl));
  } else if (e.kind === 'bytes') {
    if (bytes) noteBytes(ip, ua, bytes, username);
    // PHZ: a served segment is a 2xx upstream success → keep the channel live.
    if (source && entryUrl) noteSuccess(streamKey(source, entryUrl));
  } else if (e.kind === 'upstream') {
    // PHZ: an upstream failure. A definitive non-2xx (status>0) → noteFailed (straight to `failed`); a
    // transport error with no response (status 0) → noteFailure (one retry toward the budget).
    if (source && entryUrl) {
      const key = streamKey(source, entryUrl);
      const status = typeof e.status === 'number' ? e.status : 0;
      if (status > 0) noteFailed(key);
      else noteFailure(key);
    }
  } else if (e.kind === 'media') {
    // DEC: merge manifest-declared decode metadata for this channel (null fields = no update this poll).
    if (source && entryUrl) {
      noteMedia(source, entryUrl, {
        resolution: optStr(e.resolution) ?? null,
        codecs: optStr(e.codecs) ?? null,
        frameRate: optStr(e.frameRate) ?? null,
        container: optStr(e.container) ?? null,
        bandwidth: typeof e.bandwidth === 'number' && e.bandwidth > 0 ? e.bandwidth : null,
      });
    }
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
