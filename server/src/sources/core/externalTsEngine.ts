// externalPlayer raw-TS passthrough engine — the opt-in `videoconfig.output === 'ts'` path for raw-only
// IPTV clients (the classic "IPTV link": MPEG-TS over a held-open HTTP socket). It is the sibling of
// externalEngine.ts (the default loopback-HLS path): both serve the /api/ext mount, share the spawn-time
// config (ExternalEngineConfig), the -progress→streamState health machine (engineHealth.ts), and the argv
// builder (engineArgs.ts) — they differ only in HOW bytes reach the client.
//
//   externalEngine.ts (output:'hls')   ffmpeg → segment files → loopback HLS → composer → client polls
//   externalTsEngine.ts (output:'ts')  ffmpeg → -f mpegts pipe:1 → in-proc RING BUFFER → client socket(s)
//
// Why a ring buffer (not one ffmpeg per client): the field's universal pattern (Dispatcharr/Threadfin/…) is
// ONE upstream pull shared to N clients. So per channel (keyed by streamKey) we spawn ONE shared ffmpeg, tap
// its stdout into a byte-bounded ring of 188-aligned TS chunks, and fan each chunk out to every attached
// client's response — each client following the ring at its own cursor (a slow client that falls behind the
// eviction window skips forward to live rather than stalling the channel). We do NOT use ffmpeg's `-listen 1`
// (single-client/fragile): the server owns the socket lifecycle, ffmpeg is just a byte producer.
//
// Telemetry — the fork: a raw-TS socket never polls, so the poll-recency model (streamTelemetry.ts) is blind
// to it. We register each socket via the socket-liveness hooks (noteSocketViewerOpen/Bytes/Close) so it feeds
// the SAME ClientConn/ClosedSession shape — Active Streams + History treat TS and HLS sessions uniformly. The
// engine's -progress drives the channel phase (live/buffer/failed) exactly as the HLS engine does.
//
// fd layout (the key difference from externalEngine): stdout (pipe:1) carries the TS BYTES (ffmpeg `-f mpegts
// pipe:1`), so -progress can't use it — ffmpeg sends it to a dedicated fd 3 (pipe:3); stderr (pipe:2) keeps
// the logs. DB-free + source-agnostic like the rest of sources/core. One shared engine process per channel;
// reaped a short delay after the last client leaves (fast re-join) or when fully hung.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import { logger } from './logger.js';
import { streamKey, noteFailure, noteFailed } from './streamState.js';
import { createEngineHealth, parseProgress, parseFreezeLines, watchdog, newProgressCarry, newFreezeCarry, type EngineHealth, type ProgressCarry, type EngineSnapshot } from './engineHealth.js';
import { buildFfmpegArgv } from './engineArgs.js';
import { noteSocketViewerOpen, noteSocketBytes, noteSocketViewerClose, nextSocketConnId, type PlayerType } from './streamTelemetry.js';
import { type ExternalEngineConfig } from './externalEngine.js';

const TAG = 'stream:ext-ts';

const TS_PACKET = 188; // MPEG-TS packet size — chunk boundaries are aligned to it so a late joiner starts on a packet
const MAX_BUFFER_BYTES = Number(process.env.EXT_TS_BUFFER_BYTES || 16 * 1024 * 1024); // per-channel ring cap (~a few s; bounds memory)
const START_BEHIND_MS = Number(process.env.EXT_TS_START_BEHIND_MS || 4_000); // a new client starts ~this far behind live (fast initial fill + jitter cushion)
const READY_TIMEOUT_MS = Number(process.env.EXT_TS_READY_MS || 15_000); // wait for the first produced chunk before responding
const SHUTDOWN_DELAY_MS = Number(process.env.EXT_TS_SHUTDOWN_MS || 10_000); // keep ffmpeg this long after the last client leaves (fast channel-surf re-join)
const SWEEP_MS = 5_000;
const STATS_PERIOD_S = 1; // -progress emit cadence

const EMPTY = Buffer.alloc(0);

interface RingChunk {
  idx: number; // monotonic, +1 per chunk
  data: Buffer; // 188-aligned TS bytes
  at: number; // ms epoch produced (for start-behind-live)
}

interface TsClient {
  connId: number; // telemetry id (also the socket-liveness key)
  res: ServerResponse; // the held-open client response
  nextIdx: number; // the ring index this client will read next
  writing: boolean; // reentrancy guard around the write loop (one pump frame at a time)
  paused: boolean; // socket backpressured — wait for 'drain' before writing again (a new chunk must NOT resume it)
  closed: boolean;
}

interface TsProc {
  key: string; // sha1(channelKey).slice(0,16)
  channelKey: string; // = streamKey(source, entryUrl) — the streamState key this proc's health drives
  upstreamUrl: string; // the adapter-resolved master — ffmpeg's -i input
  proc: ChildProcess | null;
  startedAt: number;
  configId: string; // resolved videoconfig id this proc runs under ('app' | 'app_<playlistId>') — Active Streams panel
  mode: string; // spawn-time mode ('auto' | 'copy' | 'transcode')
  hs: EngineHealth; // shared -progress → streamState health (engineHealth.ts)
  carry: ProgressCarry; // -progress fd parse carry (ffmpeg only)
  // ── ring buffer ──
  chunks: RingChunk[]; // contiguous oldest→newest
  nextChunkIdx: number; // idx to assign to the next produced chunk (== head)
  bytesBuffered: number; // Σ chunk sizes (eviction trigger)
  partial: Buffer; // unaligned tail (< 188 B) carried to the next stdout event
  producedFirst: boolean; // first chunk seen (readiness)
  // ── clients ──
  clients: Set<TsClient>;
  lastClientLeftAt: number | null; // when the last client left (shutdown-delay reap); null while ≥1 client
  exited: boolean;
}

const procs = new Map<string, TsProc>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let ffmpegMissingLogged = false;
let exitCleanupRegistered = false;

function keyFor(channelKey: string): string {
  return createHash('sha1').update(channelKey).digest('hex').slice(0, 16);
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

// ── ring buffer ───────────────────────────────────────────────────────────────────────────────────────

// ffmpeg stdout arrives in arbitrary-sized buffers; coalesce with the carried tail, cut the largest whole
// number of TS packets into a ring chunk (so every chunk boundary is a packet boundary → a late joiner starts
// cleanly), and carry the < 188 B remainder forward. We flush the aligned portion on EVERY stdout event for
// low latency (the ring, not chunk size, is what enables fan-out — the 1 MB chunks of disk/Redis proxies are
// an out-of-process optimization we don't need).
function onStdout(rec: TsProc, buf: Buffer): void {
  const merged = rec.partial.length ? Buffer.concat([rec.partial, buf]) : buf;
  const alignedLen = merged.length - (merged.length % TS_PACKET);
  if (alignedLen > 0) {
    appendChunk(rec, merged.subarray(0, alignedLen));
    rec.partial = alignedLen < merged.length ? Buffer.from(merged.subarray(alignedLen)) : EMPTY;
  } else {
    rec.partial = merged; // < one packet yet — keep accumulating
  }
}

function appendChunk(rec: TsProc, data: Buffer): void {
  rec.chunks.push({ idx: rec.nextChunkIdx++, data, at: Date.now() });
  rec.bytesBuffered += data.length;
  rec.producedFirst = true;
  // Evict oldest chunks past the byte cap (always keep ≥1 so a just-attached client has something to read).
  while (rec.bytesBuffered > MAX_BUFFER_BYTES && rec.chunks.length > 1) {
    rec.bytesBuffered -= rec.chunks.shift()!.data.length;
  }
  for (const cl of rec.clients) pump(rec, cl);
}

function chunkByIdx(rec: TsProc, idx: number): RingChunk | undefined {
  if (!rec.chunks.length) return undefined;
  const off = idx - rec.chunks[0].idx;
  return off >= 0 && off < rec.chunks.length ? rec.chunks[off] : undefined;
}

// Drain all available chunks to one client, honouring socket backpressure (stop on a falsey write(), resume on
// 'drain'). A client whose next chunk was already evicted (it fell behind the window) skips forward to the
// oldest available chunk — losing data but staying live, never stalling the shared channel.
function pump(rec: TsProc, cl: TsClient): void {
  if (cl.writing || cl.paused || cl.closed) return; // paused ⇒ a queued chunk must wait for 'drain', not write now
  cl.writing = true;
  while (cl.nextIdx < rec.nextChunkIdx) {
    const chunk = chunkByIdx(rec, cl.nextIdx);
    if (!chunk) {
      const oldest = rec.chunks.length ? rec.chunks[0].idx : rec.nextChunkIdx;
      if (oldest <= cl.nextIdx) break; // nothing newer available yet
      cl.nextIdx = oldest; // fell behind the eviction window → skip forward to live-ish
      continue;
    }
    cl.nextIdx = chunk.idx + 1;
    let ok = false;
    try {
      ok = cl.res.write(chunk.data);
    } catch {
      break; // socket died mid-write; its 'close'/'error' handler detaches it
    }
    noteSocketBytes(cl.connId, chunk.data.length);
    if (!ok) {
      // Socket buffer full — pause until it drains. One 'drain' listener (pump returns early while paused, so a
      // new chunk can't register a second). On resume, nextIdx may now point past the eviction window → skip-forward.
      cl.paused = true;
      cl.writing = false;
      cl.res.once('drain', () => {
        cl.paused = false;
        pump(rec, cl);
      });
      return;
    }
  }
  cl.writing = false;
}

// The ring index ~START_BEHIND_MS behind live (so a new client gets a few seconds of buffered data to fill its
// own jitter buffer immediately, then follows live). Falls back to the oldest/head when the buffer is shorter.
function startBehindIdx(rec: TsProc): number {
  const cutoff = Date.now() - START_BEHIND_MS;
  for (const c of rec.chunks) if (c.at >= cutoff) return c.idx;
  return rec.nextChunkIdx;
}

// ── spawn / lifecycle ───────────────────────────────────────────────────────────────────────────────────

function spawnTs(key: string, channelKey: string, upstreamUrl: string, headers: Record<string, string>, cfg: ExternalEngineConfig): TsProc {
  // Raw-TS: stdout (pipe:1) carries the TS bytes (ffmpeg `-f mpegts pipe:1`). ffmpeg sends -progress to a
  // dedicated fd 3 (pipe:3); stderr (pipe:2) keeps the logs.
  const ua = headers['User-Agent'] || headers['user-agent'] || 'Masqueradarr-ext/1.0';
  const bin = 'ffmpeg';
  // freezedetect tap. Here stdout (fd 1) is the TS bytes and fd 3 is the -progress stream, so the freeze
  // metadata pipe is fd 4.
  const freezeOn = !!cfg.freezeDetect;
  const argv = buildFfmpegArgv(cfg.args, { placeholders: { INPUT: upstreamUrl, UA: ua }, headers, progressPipe: 'pipe:3', statsPeriodS: STATS_PERIOD_S, inputArgs: cfg.inputArgs, fflags: cfg.fflags, outputArgs: cfg.outputArgs, freezePipe: freezeOn ? 'pipe:4' : undefined });

  const rec: TsProc = {
    key,
    channelKey,
    upstreamUrl,
    proc: null,
    startedAt: Date.now(),
    configId: cfg.configId,
    mode: cfg.mode,
    hs: createEngineHealth(channelKey, cfg, Date.now()),
    carry: newProgressCarry(),
    chunks: [],
    nextChunkIdx: 0,
    bytesBuffered: 0,
    partial: EMPTY,
    producedFirst: false,
    clients: new Set(),
    lastClientLeftAt: null,
    exited: false,
  };
  procs.set(key, rec);
  registerExitCleanup();
  startSweep();

  let proc: ChildProcess;
  try {
    // fd 0 ignored, 1 = TS bytes, 2 = logs, 3 = -progress; fd 4 = freezedetect metadata when the freeze tap is enabled.
    const stdio: Array<'ignore' | 'pipe'> = freezeOn
      ? ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']
      : ['ignore', 'pipe', 'pipe', 'pipe'];
    proc = spawn(bin, argv, { stdio });
  } catch {
    rec.exited = true;
    procs.delete(key);
    return rec; // waitUntilProducing sees no proc → throws → route 502s
  }
  rec.proc = proc;

  proc.stdout?.on('data', (d: Buffer) => onStdout(rec, d));
  {
    // fd 3 = the ffmpeg -progress health stream (separate from the TS bytes on stdout and the logs on stderr).
    const progress = proc.stdio[3] as Readable | undefined | null;
    progress?.on('data', (d: Buffer) => parseProgress(rec.hs, d.toString(), rec.carry));
  }
  // fd 4 = ffmpeg freezedetect metadata → freeze_start/_end → buffer state for frozen content.
  if (freezeOn) {
    const fcarry = newFreezeCarry();
    (proc.stdio[4] as Readable | null | undefined)?.on('data', (d: Buffer) => parseFreezeLines(rec.hs, d.toString(), fcarry, Date.now()));
  }

  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  proc.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      if (!ffmpegMissingLogged) {
        logger.warn(TAG, `${bin} not found — raw-TS engine unavailable (external clients get a 502 until it is present)`);
        ffmpegMissingLogged = true;
      }
    } else {
      logger.error(TAG, `${bin} spawn error ${key}: ${err.message}`);
    }
    rec.exited = true;
    rec.proc = null;
    endAllClients(rec);
    procs.delete(key);
  });
  proc.on('exit', (code, signal) => {
    const last = stderr.trim().split('\n').filter(Boolean).pop() || '';
    logger.info(TAG, `${bin} exit ${key} code=${code} signal=${signal}${last ? ` · ${last}` : ''}`);
    // A clean stop (our SIGKILL reap, code 0, or 255 = benign client-initiated stop) leaves streamState alone.
    // A genuine non-zero exit is a definitive failure.
    if (signal !== 'SIGKILL' && code !== 0 && code !== 255 && code !== null) {
      noteFailed(rec.channelKey);
    }
    rec.exited = true;
    rec.proc = null;
    endAllClients(rec); // close every client socket so they reconnect (and their sessions close)
    procs.delete(key);
  });

  logger.info(TAG, `ts engine start ${key} (ffmpeg/${cfg.mode}) ← ${upstreamUrl}`);
  return rec;
}

// Bounded wait for the first produced chunk (re-evaluable, no stale promise): a dead process throws so the
// route serves a 502 (raw-TS has no B-Roll slate — the engine's -progress still records the failure).
async function waitUntilProducing(rec: TsProc): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (rec.producedFirst) return;
    if (!rec.proc || rec.exited) throw new Error('ts engine process exited');
    if (Date.now() >= deadline) throw new Error('ts engine not producing (timeout)');
    await delay(150);
  }
}

function endAllClients(rec: TsProc): void {
  for (const cl of [...rec.clients]) {
    try {
      cl.res.end(); // → 'close' → detach → noteSocketViewerClose
    } catch {
      /* ignore */
    }
  }
}

function stopTs(rec: TsProc, why: string): void {
  procs.delete(rec.key);
  rec.exited = true;
  endAllClients(rec);
  if (rec.proc) {
    logger.info(TAG, `ts engine stop ${rec.key} (${why})`);
    try {
      rec.proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    rec.proc = null;
  }
}

function startSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const rec of [...procs.values()]) {
      // Reap a process whose last client left more than the shutdown delay ago (one pull, no viewers → stop).
      if (rec.clients.size === 0 && rec.lastClientLeftAt !== null && now - rec.lastClientLeftAt > SHUTDOWN_DELAY_MS) {
        stopTs(rec, 'idle (no clients)');
        continue;
      }
      // Watchdog: a fully-hung ffmpeg (no -progress block for longer than the fail window) → escalate health.
      if (rec.proc && !rec.exited) watchdog(rec.hs, now);
    }
  }, SWEEP_MS);
  sweepTimer.unref?.();
}

function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  // SIGKILL any surviving ffmpeg children on a normal process exit (the shutdown handler calls process.exit).
  process.once('exit', () => {
    for (const rec of procs.values()) rec.proc?.kill('SIGKILL');
  });
}

// ── public API (the route layer calls these) ───────────────────────────────────────────────────────────

/** The viewer identity for socket-liveness telemetry (mirrors the HLS path's proxy-derived fields). */
export interface TsViewer {
  source: string;
  entryUrl: string; // the channel entry — channelKey + the channelId the stats layer resolves
  ip: string;
  ua: string;
  username?: string;
  playerType: PlayerType; // always 'externalPlayer' here
}

/**
 * Ensure the shared ffmpeg for this channel is running (reusing it across viewers) and wait until it is
 * producing TS. Returns the per-channel TsProc; the route then attaches the client with attachTsClient().
 * Throws on spawn failure / readiness timeout / death (the route maps a throw to a 502).
 */
export async function ensureTsStream(
  source: string,
  entryUrl: string,
  upstreamMasterUrl: string,
  upstreamHeaders: Record<string, string>,
  cfg: ExternalEngineConfig,
): Promise<TsProc> {
  const channelKey = streamKey(source, entryUrl); // streamState/health key (plain — readable via phaseFor())
  const key = keyFor(`${channelKey}#${cfg.configId}`); // proc-map key — per-config process isolation
  try {
    let rec = procs.get(key);
    if (!rec || !rec.proc || rec.exited) {
      rec = spawnTs(key, channelKey, upstreamMasterUrl, upstreamHeaders, cfg);
    }
    rec.lastClientLeftAt = null; // a client is arriving — cancel any pending shutdown-delay reap
    await waitUntilProducing(rec);
    return rec;
  } catch (err) {
    // The engine is the SOLE streamState writer while active — a failed establish spends a retry here (two
    // reach the budget ⇒ failed). A genuine non-zero ffmpeg exit additionally fires noteFailed from the exit handler.
    noteFailure(channelKey);
    throw err;
  }
}

/**
 * Attach a client's held-open response to the channel's ring buffer (starting ~START_BEHIND_MS behind live),
 * register it as a socket-liveness viewer, and flush the initial backlog. Detaches + closes the telemetry
 * session on socket close/error. Caller has already written the 200 + Content-Type: video/mp2t headers.
 */
export function attachTsClient(rec: TsProc, res: ServerResponse, viewer: TsViewer): void {
  const connId = nextSocketConnId();
  const cl: TsClient = { connId, res, nextIdx: startBehindIdx(rec), writing: false, paused: false, closed: false };
  rec.clients.add(cl);
  rec.lastClientLeftAt = null;
  noteSocketViewerOpen(viewer.source, viewer.entryUrl, viewer.ip, viewer.ua, viewer.username, viewer.playerType, connId);

  const detach = (): void => {
    if (cl.closed) return;
    cl.closed = true;
    rec.clients.delete(cl);
    if (rec.clients.size === 0) rec.lastClientLeftAt = Date.now();
    noteSocketViewerClose(connId);
  };
  res.on('close', detach);
  res.on('error', detach);

  pump(rec, cl); // flush the start-behind backlog immediately
}

/**
 * Read-only snapshot of every raw-TS engine process currently serving `channelKey` — for the Active Streams
 * per-stream engine panel. Pure read: it MUST NOT touch rec.lastClientLeftAt (the shutdown-delay reap clock).
 */
export function enginesForChannel(channelKey: string): EngineSnapshot[] {
  const out: EngineSnapshot[] = [];
  for (const rec of procs.values()) {
    if (rec.channelKey !== channelKey || !rec.proc || rec.exited) continue;
    out.push({
      output: 'ts',
      engine: 'ffmpeg',
      configId: rec.configId,
      mode: rec.mode,
      upstreamUrl: rec.upstreamUrl,
      startedAt: rec.startedAt,
      state: rec.hs.health,
      speed: rec.hs.lastSpeed,
      fps: rec.hs.lastFps,
      bitrateKbps: rec.hs.lastBitrateKbps,
      outTimeMs: rec.hs.lastOutTimeUs ? Math.round(rec.hs.lastOutTimeUs / 1000) : null,
      dropFrames: rec.hs.lastDropFrames,
      clients: rec.clients.size,
      producing: rec.producedFirst,
    });
  }
  return out;
}
