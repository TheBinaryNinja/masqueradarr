import {
  noteViewer,
  noteBytes,
  noteMedia,
  noteSocketViewerOpen,
  noteSocketBytes,
  noteSocketViewerClose,
  nextSocketConnId,
  noteIngest,
  noteAdBreak,
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
//    codecs?, frameRate?, container?, bandwidth?, upstreamShape?, encryption?, replace? }. Nulls mean "no update this poll"
//    for the PASSTHROUGH producer (master and media playlist are separate polls); the ORIGIN producer reads
//    both in one pass and sets `replace` so its frame overwrites instead of merging.
//  · open/sbytes/close — P3.2/DST continuous raw-TS: the SOCKET model (a single long-lived TS connection, no
//    polling). `open` mints a socket connId (noteSocketViewerOpen) mapped from the Rust streamId; `sbytes`
//    (periodic) → noteSocketBytes(connId) AND noteSuccess (→ live — the socket twin of `bytes`, without which
//    a raw-TS channel never left `establishing`); `close` → noteSocketViewerClose(connId). Only `open` carries
//    the channel, so it also records streamId → channelKey for `sbytes` to use. Fields: open = { streamId,
//    source, entryUrl, ip, ua, username?, playerType }, sbytes = { streamId, bytes },
//    close = { streamId, reason? }. NOTE only raw-TS sockets emit `close` at all — an HLS session ends by
//    simply ceasing to poll, and is reaped by streamTelemetry's TTL sweep.
//  · iop      — S3/ORIGIN Side-1 (the per-channel INGEST). The only INGRESS-side kind: every other event
//    above measures what we sent to a viewer. Once one ingest feeds N viewers those are independent
//    quantities, so this drives its own map (noteIngest) and never noteBytes. Fields: { source, entryUrl,
//    status ('ok'|'stalled'|'resolve_failed'|'closed'), subscribers, ringSegments, ringBytes,
//    channelRingCapBytes, ringSeconds, floorBeatsCap, headSeq, generation, discSeq, discInWindow,
//    ingestedSegments, ingestedBytes, evictedSegments, targetDuration, demuxed, ineligible, upstreamShape,
//    encryption, suspect, suspectRetires }.
//  · cue      — S3/CUE, Side-1 EVENT (not a snapshot): exactly two frames per ad break → noteAdBreak. Like
//    `iop` it is an INGEST observation and never touches noteBytes — a break says nothing about egress.
//    Fields: { source, entryUrl, state ('open'|'close'), breakId, signal, segments, durationSec,
//    announcedSec, profileChanged }.
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
  // `media` only: this frame is a COMPLETE snapshot, not a partial poll — overwrite rather than merge.
  replace?: unknown;
  // `close` only: WHY a raw-TS socket session ended ('endlist' | 'failover_exhausted' | 'pair_declines' |
  // 'ingest_stopped' | 'client_gone'). HLS sessions emit no close frame at all — their ending is inferred by
  // the Node TTL sweep, which can only name a mechanism.
  reason?: unknown;
  // Sent by BOTH `media` (passthrough, MEDIA-playlist polls only — a master carries no #EXT-X-KEY) and `iop`
  // (origin): the declared encryption METHOD. 'NONE' is a MEASUREMENT of cleartext; absent means no reading.
  encryption?: unknown;
  // Sent by BOTH `media` (passthrough, entry poll only) and `iop` (origin): what the upstream turned out to
  // be — 'ts' | 'hls-master' | 'hls-media'. Two producers, two maps, because a channel can legitimately have
  // an origin reading and a passthrough reading at once (an INELIGIBLE origin produces both).
  upstreamShape?: unknown;
  streamId?: unknown; // DST: the continuous-TS session id (open/sbytes/close), mapped to a socket connId
  // S3/ORIGIN `iop` (Side-1 ingest) counters. `status` is a STRING here ('ok'|'stalled'|…), unlike the
  // `upstream` kind where it is an HTTP status number — the two kinds never share a branch.
  subscribers?: unknown;
  ringSegments?: unknown;
  ringBytes?: unknown;
  // THIS channel's live applied cap — `ringBytes`' missing denominator. Named apart from the `ring` kind's
  // `ringCapBytes` below (Σ across every origin) because this interface is flat and untagged: one key here
  // cannot be allowed to mean two things.
  channelRingCapBytes?: unknown;
  // Σ of the held segments' real durations. BOOLEAN, not a count — `floorBeatsCap` says the MIN_SEGMENTS
  // floor beat the byte cap, i.e. the ring is over budget on purpose.
  ringSeconds?: unknown;
  floorBeatsCap?: unknown;
  headSeq?: unknown;
  generation?: unknown;
  // Disjoint discontinuity counts: `discSeq` = tags that have LEFT the window (RFC 8216's
  // EXT-X-DISCONTINUITY-SEQUENCE), `discInWindow` = tags still in it. Never add them together.
  discSeq?: unknown;
  discInWindow?: unknown;
  ingestedSegments?: unknown;
  ingestedBytes?: unknown;
  evictedSegments?: unknown;
  targetDuration?: unknown;
  // Whether the origin is actually authoring output. `demuxed` is a BOOLEAN; `ineligible` is a nullable
  // REASON STRING, set when the origin declined the upstream and the rewrite path took over serving — from
  // here that case is otherwise indistinguishable from a healthy origin, since both keep emitting `iop`.
  demuxed?: unknown;
  ineligible?: unknown;
  // S3/UND: the last structural fault that retired an upstream on this channel, and how many have been
  // retired for one. Null/0 on a healthy channel; non-null means it has been hopping providers, which none
  // of the byte counters above can express.
  suspect?: unknown;
  suspectRetires?: unknown;
  // S3/ORIGIN `ring` (process-wide). `ringBytes` is shared with `iop` but means something different here —
  // there it is one channel's window, here it is every window summed.
  origins?: unknown;
  subscribed?: unknown;
  ringCapBytes?: unknown;
  // S3/CUE `cue` (ad-break edges). `state` is 'open'|'close' — distinct from the `iop` kind's `status` and
  // the `upstream` kind's numeric `status`; the three never share a branch.
  state?: unknown;
  breakId?: unknown;
  signal?: unknown;
  segments?: unknown;
  durationSec?: unknown;
  announcedSec?: unknown;
  profileChanged?: unknown;
}

// DST: Rust continuous-TS streamId → the socket-viewer connId minted on `open`. A tiny bounded map (one entry
// per LIVE raw-TS stream); entries are removed on `close`, and the socket telemetry's 60s no-byte backstop
// reaps a viewer whose `close` never arrived (a sidecar crash), so a leaked map entry only wastes a few bytes.
const tsConns = new Map<string, number>();

// PHZ: the same streamId → the CHANNEL it is serving, captured on `open` (the only socket event that carries
// source/entryUrl — `sbytes` and `close` are identified by streamId alone).
//
// Why this exists: `phaseFor` reports `establishing` until `noteSuccess` is called, and `noteSuccess` was
// reachable only from the `viewer` and `bytes` kinds — both POLLING paths. A continuous raw-TS stream emits
// `open`/`sbytes`/`close` and none of those, so every TS channel sat on `establishing` FOREVER, playing
// perfectly, on all three producers (tsmux passthrough, origin muxed, origin interleaved). This map is what
// lets `sbytes` — the socket equivalent of `bytes` — drive the phase the same way.
const tsChannels = new Map<string, string>();

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
    // DEC: manifest-declared decode metadata. `replace` distinguishes the two producers — the passthrough
    // rewriter sends PARTIAL frames (master and media playlist are separate polls, so null = "no update this
    // poll" and must merge), while the origin resolver sends a COMPLETE snapshot of the upstream it just
    // resolved (null = "this upstream declares nothing"), which must overwrite or a retired provider's
    // numbers outlive it. See noteMedia.
    if (source && entryUrl) {
      noteMedia(source, entryUrl, {
        resolution: optStr(e.resolution) ?? null,
        codecs: optStr(e.codecs) ?? null,
        frameRate: optStr(e.frameRate) ?? null,
        container: optStr(e.container) ?? null,
        bandwidth: typeof e.bandwidth === 'number' && e.bandwidth > 0 ? e.bandwidth : null,
        // optStr, not str: this is null on a HOP poll by design, and the merge below must SKIP it there
        // rather than overwrite the entry poll's answer with an empty string.
        upstreamShape: optStr(e.upstreamShape) ?? null,
        encryption: optStr(e.encryption) ?? null,
      }, e.replace === true);
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
        channelRingCapBytes: num(e.channelRingCapBytes),
        ringSeconds: num(e.ringSeconds),
        // Booleans go through `=== true`, NEVER num() — num() tests `typeof v === 'number'` and would map
        // `true` to 0, i.e. permanently false. Same shape as the cue branch's `profileChanged` below.
        floorBeatsCap: e.floorBeatsCap === true,
        headSeq: num(e.headSeq),
        generation: num(e.generation),
        discSeq: num(e.discSeq),
        discInWindow: num(e.discInWindow),
        ingestedSegments: num(e.ingestedSegments),
        ingestedBytes: num(e.ingestedBytes),
        evictedSegments: num(e.evictedSegments),
        targetDuration: num(e.targetDuration),
        demuxed: e.demuxed === true,
        upstreamShape: optStr(e.upstreamShape) ?? null,
        encryption: optStr(e.encryption) ?? null,
        // Tri-state, so it takes the `suspect` shape rather than str(): str() coerces null to '' and the
        // difference between "eligible" and "declined, reason unknown" would be lost.
        ineligible: typeof e.ineligible === 'string' && e.ineligible ? e.ineligible.slice(0, 48) : null,
        suspect: typeof e.suspect === 'string' && e.suspect ? e.suspect.slice(0, 48) : null,
        suspectRetires: num(e.suspectRetires),
        at: Date.now(),
      });
    }
  } else if (e.kind === 'cue') {
    // S3/CUE Side-1 ad-break edge. Like `iop` this is an INGEST observation and must never reach noteBytes —
    // a break says nothing about what we sent anyone. Exactly two frames per break (open/close).
    if (source && entryUrl) {
      noteAdBreak(source, entryUrl, str(e.state), {
        signal: str(e.signal) || 'unknown',
        breakId: num(e.breakId),
        segments: num(e.segments),
        durationSec: num(e.durationSec),
        announcedSec: num(e.announcedSec),
        profileChanged: e.profileChanged === true,
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
      tsChannels.set(streamId, streamKey(source, entryUrl)); // PHZ: so `sbytes` can drive the phase
      const playerType: PlayerType = e.playerType === 'externalPlayer' ? 'externalPlayer' : 'appPlayer';
      noteSocketViewerOpen(source, entryUrl, ip, ua, username, playerType, connId);
    }
  } else if (e.kind === 'sbytes') {
    // DST continuous-TS: periodic egress for a live socket session (keeps its rate + lastSeen fresh).
    const streamId = str(e.streamId);
    const connId = streamId ? tsConns.get(streamId) : undefined;
    if (connId !== undefined && bytes) noteSocketBytes(connId, bytes);
    // PHZ: bytes reaching a client ARE the success signal — this is the socket twin of the `bytes` kind, and
    // without it a raw-TS channel never leaves `establishing`. Deliberately gated on bytes actually flowing
    // rather than on `open`: a socket that opens and then delivers nothing has not succeeded at anything.
    const channelKey = streamId ? tsChannels.get(streamId) : undefined;
    if (channelKey && bytes) noteSuccess(channelKey);
  } else if (e.kind === 'close') {
    // DST continuous-TS: the socket ended → close the session (persists a ViewSession) + drop the mapping.
    const streamId = str(e.streamId);
    const connId = streamId ? tsConns.get(streamId) : undefined;
    if (connId !== undefined) {
      // The data plane is the only party that knows WHY the socket ended — Node sees an absence, not a cause.
      noteSocketViewerClose(connId, optStr(e.reason) ?? null);
      tsConns.delete(streamId);
    }
    tsChannels.delete(streamId);
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
