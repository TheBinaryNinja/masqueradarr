import {
  noteViewer,
  noteBytes,
  noteMedia,
  noteSocketViewerOpen,
  noteSocketBytes,
  noteSocketViewerClose,
  nextSocketConnId,
  noteIngest,
  noteRingFootprint,
  type PlayerType,
} from '../sources/core/streamTelemetry.js';
import { streamKey, noteSuccess, noteFailed, noteFailure } from '../sources/core/streamState.js';

// TELEMETRY INGEST (TEL). The sidecar measures the true byte edge (viewers, bytes) and reports events here;
// Node stays the telemetry AUTHORITY, feeding the SAME cores the old in-process proxy drove (streamTelemetry →
// the /api/stream-stats WS + GET /api/active-streams; streamState → the phase machine; the 30s heartbeat-stop
// sweep then persists a ViewSession for History/Metrics). So Active Streams + History light up with
// edge-measured data. Best-effort + fire-and-forget from Rust's side — a telemetry hiccup must never affect
// streaming.
//
// Event kinds. All but `ring` carry { source, entryUrl } so the channel's phase-machine key =
// streamKey(source, entryUrl); `ring` is the one PROCESS-WIDE kind and belongs to no channel:
//  · viewer   — one per manifest poll Rust serves (the heartbeat that keeps a viewer "active"; 30s TTL). Also
//    a 2xx success → noteSuccess (→ live). Fields: { source, entryUrl, ip, ua, username?, playerType, bytes? }.
//  · bytes    — one per segment/other 2xx send. P3.1/RSL: emitted at END-of-body with the ACCURATE delivered
//    byte count (incl. chunked / no-Content-Length segments the header count missed; partial on a client
//    disconnect). Drives noteBytes (egress, attributed by identity) AND noteSuccess (keeps the channel live).
//    Fields: { source, entryUrl, ip, ua, username?, bytes }.
//  · upstream — a failure: a non-2xx response OR a Node resolve failure (ok:false, status>0 — Rust uses a 502
//    sentinel for a resolve failure) → noteFailed (→ failed); a transport error / mid-body stall or error with
//    no definitive response (status 0) → noteFailure (spends one retry). Fields: { source, entryUrl, status }.
//  · media    — manifest-declared decode metadata → noteMedia. Fields: { source, entryUrl, resolution?,
//    codecs?, frameRate?, container? } (any subset; nulls mean "no update this poll").
//  · open/sbytes/close — P3.2/DST continuous raw-TS: the SOCKET model (a single long-lived TS connection, no
//    polling). `open` mints a socket connId (noteSocketViewerOpen) mapped from the Rust streamId; `sbytes`
//    (periodic) → noteSocketBytes(connId); `close` → noteSocketViewerClose(connId). Fields: open = { streamId,
//    source, entryUrl, ip, ua, username?, playerType }, sbytes = { streamId, bytes }, close = { streamId }.
//  · iop      — S3/ORIGIN Side-1 (the per-channel INGEST). The only INGRESS-side kind: every other event
//    above measures what we sent to a viewer. Once one ingest feeds N viewers those are independent
//    quantities, so this drives its own map (noteIngest) and never noteBytes. Fields: { source, entryUrl,
//    status ('ok'|'stalled'|'resolve_failed'|'closed'), subscribers, ringSegments, ringBytes, headSeq,
//    generation, ingestedSegments, ingestedBytes, evictedSegments, targetDuration }.
//  · ring     — S3/ORIGIN, PROCESS-WIDE: the sidecar's whole origin registry summed into one frame →
//    noteRingFootprint. Carries no channel, so it never reaches streamKey/the phase machine. Exists because
//    `iop` describes one channel and only while that channel polls, which cannot answer how much RAM the
//    rings hold in total — an origin in its idle grace still owns its bytes. Rust stays silent while no
//    ingest exists and sends one trailing zero when the last closes. Fields: { origins, subscribed,
//    ringBytes, ringCapBytes }.
// A body may be a single event or { events: [...] } (Rust batches, P3.1); both are accepted.

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
  streamId?: unknown; // DST: the continuous-TS session id (open/sbytes/close), mapped to a socket connId
  // S3/ORIGIN `iop` (Side-1 ingest) counters. `status` is a STRING here ('ok'|'stalled'|…), unlike the
  // `upstream` kind where it is an HTTP status number — the two kinds never share a branch.
  subscribers?: unknown;
  ringSegments?: unknown;
  ringBytes?: unknown;
  headSeq?: unknown;
  generation?: unknown;
  ingestedSegments?: unknown;
  ingestedBytes?: unknown;
  evictedSegments?: unknown;
  targetDuration?: unknown;
  // S3/ORIGIN `ring` (process-wide). `ringBytes` is shared with `iop` but means something different here —
  // there it is one channel's window, here it is every window summed.
  origins?: unknown;
  subscribed?: unknown;
  ringCapBytes?: unknown;
}

// DST: Rust continuous-TS streamId → the socket-viewer connId minted on `open`. A tiny bounded map (one entry
// per LIVE raw-TS stream); entries are removed on `close`, and the socket telemetry's 60s no-byte backstop
// reaps a viewer whose `close` never arrived (a sidecar crash), so a leaked map entry only wastes a few bytes.
const tsConns = new Map<string, number>();

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
// Non-negative number or 0. The iop counters are all monotonic totals/gauges, so a missing or bogus field
// degrading to 0 is safe — it reads as "nothing reported", never as a negative that would skew a delta.
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
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
  } else if (e.kind === 'iop') {
    // S3/ORIGIN Side-1. Deliberately does NOT call noteBytes: `ingestedBytes` is what the single ingest pulled
    // from UPSTREAM, while noteBytes measures what we sent to viewers. With one ingest feeding N viewers those
    // are different numbers, and folding them together would both over-count egress and destroy the
    // attribution the iop/oop split exists to provide.
    if (source && entryUrl) {
      noteIngest(source, entryUrl, {
        status: str(e.status) || 'ok',
        subscribers: num(e.subscribers),
        ringSegments: num(e.ringSegments),
        ringBytes: num(e.ringBytes),
        headSeq: num(e.headSeq),
        generation: num(e.generation),
        ingestedSegments: num(e.ingestedSegments),
        ingestedBytes: num(e.ingestedBytes),
        evictedSegments: num(e.evictedSegments),
        targetDuration: num(e.targetDuration),
        at: Date.now(),
      });
    }
  } else if (e.kind === 'ring') {
    // S3/ORIGIN process-wide. Deliberately OUTSIDE the `if (source && entryUrl)` guard every other kind sits
    // behind: this frame belongs to the sidecar, not to a channel, and gating it on a channel it will never
    // carry would silently drop every one.
    noteRingFootprint({
      origins: num(e.origins),
      subscribed: num(e.subscribed),
      bytes: num(e.ringBytes),
      capBytes: num(e.ringCapBytes),
      at: Date.now(),
    });
  } else if (e.kind === 'open') {
    // DST continuous-TS: a new socket-style session. Mint a connId, map the Rust streamId to it, register the
    // viewer. Overwrite any stale mapping for this streamId (a sidecar restart resets its counter) by closing
    // the prior binding first, so a reused id can never double-count.
    const streamId = str(e.streamId);
    if (streamId && source && entryUrl) {
      const prev = tsConns.get(streamId);
      if (prev !== undefined) noteSocketViewerClose(prev);
      const connId = nextSocketConnId();
      tsConns.set(streamId, connId);
      const playerType: PlayerType = e.playerType === 'externalPlayer' ? 'externalPlayer' : 'appPlayer';
      noteSocketViewerOpen(source, entryUrl, ip, ua, username, playerType, connId);
    }
  } else if (e.kind === 'sbytes') {
    // DST continuous-TS: periodic egress for a live socket session (keeps its rate + lastSeen fresh).
    const streamId = str(e.streamId);
    const connId = streamId ? tsConns.get(streamId) : undefined;
    if (connId !== undefined && bytes) noteSocketBytes(connId, bytes);
  } else if (e.kind === 'close') {
    // DST continuous-TS: the socket ended → close the session (persists a ViewSession) + drop the mapping.
    const streamId = str(e.streamId);
    const connId = streamId ? tsConns.get(streamId) : undefined;
    if (connId !== undefined) {
      noteSocketViewerClose(connId);
      tsConns.delete(streamId);
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
