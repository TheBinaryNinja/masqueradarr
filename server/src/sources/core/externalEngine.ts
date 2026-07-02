// externalPlayer engine — the server-side ffmpeg path that third-party IPTV-client (TiviMate/Kodi/VLC/…)
// sessions are routed through on the /api/ext mount. It GENERALIZES adapters/hdhomerun/remux.ts: where
// remux.ts is hardwired to an HDHomeRun TS input with a fixed argv, this engine takes the adapter-resolved
// upstream master URL as its input and spawns ffmpeg with the OPERATIVE `advancedArgs` from the videoconfig
// singleton (placeholders <INPUT> <UA> <OUTDIR> <M3U8> <SEG> substituted at spawn time). It writes a live
// HLS window to a temp dir served back over a 127.0.0.1 loopback HTTP origin, so the ENTIRE existing
// composer / B-Roll / ffprobe / poll-recency telemetry stack works unchanged — it just mirrors a local HLS
// playlist (exactly as remux.ts does for the device).
//
// What this adds over remux.ts: a `-progress pipe:1` health stream parsed into the existing streamState
// phases (live / buffer / failed) — the NEW visibility into otherwise-opaque external-client sessions the
// whole workstream is for. ffprobe stays the one-shot technical-detail side-channel (unchanged).
//
// DB-free + source-agnostic by design (like the rest of sources/core): it receives a plain `cfg` object
// (read from videoconfig by the route layer) and the adapter's upstream headers — it never imports a model.
// One shared ffmpeg per channel (keyed by streamKey(source, entryUrl)) so multiple external viewers of one
// channel ride one process; an idle sweep reaps a process once the composer stops polling its loopback
// playlist. Spawn/degradation mirrors core/broll.ts + remux.ts (bare `ffmpeg`, ENOENT logged once,
// SIGKILL on exit). This engine is ffmpeg + HLS output (output:'hls'); the raw-TS passthrough (output:'ts')
// is the sibling externalTsEngine.ts (shares engineHealth/engineArgs). ffmpeg is the sole external engine.

import { spawn, type ChildProcess } from 'node:child_process';
import { type Readable } from 'node:stream';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, createReadStream, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from './logger.js';
import { streamKey, noteFailure, noteFailed } from './streamState.js';
import { createEngineHealth, parseProgress, parseFreezeLines, watchdog, newProgressCarry, newFreezeCarry, type EngineHealth, type EngineSnapshot } from './engineHealth.js';
import { buildFfmpegArgv } from './engineArgs.js';

const TAG = 'stream:ext-engine';
const ROOT = join(tmpdir(), 'masqueradarr-extengine'); // <ROOT>/<key>/{index.m3u8,seg*.ts}

const READY_TIMEOUT_MS = Number(process.env.EXT_ENGINE_READY_MS || 15_000); // wait for the first playlist+segment
const IDLE_MS = Number(process.env.EXT_ENGINE_IDLE_MS || 45_000); // reap a process unpolled this long (> the 30s telemetry client TTL)
const SWEEP_MS = 5_000;
const STATS_PERIOD_S = 1; // -progress emit cadence

// Spawn-time config handed in by the route layer (read from the videoconfig singleton, cached). The engine
// stays DB-free — it never reads Mongo itself. `args` is the OPERATIVE ffmpeg advancedArgs (with placeholders).
// Shared with the raw-TS engine (externalTsEngine.ts), which reads the same fields with output:'ts'.
export interface ExternalEngineConfig {
  args: string; // the operative spawn string (advancedArgs), placeholders substituted
  mode: 'auto' | 'copy' | 'transcode'; // informational in v1 (the preset/args already encode the codec choice)
  output: 'hls' | 'ts'; // this engine handles 'hls'; the route dispatches 'ts' to externalTsEngine.ts
  stallSpeedThreshold: number; // ffmpeg speed below this ⇒ buffering
  failTimeoutS: number; // sustained stall longer than this ⇒ failed
  // The resolved per-playlist videoconfig id ('app' = global Default, 'app_<playlistId>' = a Custom config).
  // Folded into the proc-map key so two playlists that resolve to DIFFERENT configs for the SAME channel each
  // get their OWN engine process (different args/loopback) — full per-config isolation. The streamState/health
  // key stays the plain streamKey (below) so Active Streams' phaseFor() read is unaffected.
  configId: string;
  // Extra ffmpeg INPUT options (before -i) this stream needs — the videoconfig "ExtPicky Override" toggle
  // (['-extension_picky','0'] for dlhd disguised segments) concatenated with the selected addons' inputFlags
  // (persistent-http-off / segment-resilience; addonCatalog.ts). The route composes it; the engine forwards it.
  inputArgs?: string[];
  // Addon `-fflags` flag names to MERGE into the base -fflags token (discontinuity-tolerance's igndts/discardcorrupt).
  fflags?: string[];
  // Addon OUTPUT/muxer flags (before the operator's output) — discontinuity-tolerance's -avoid_negative_ts /
  // -max_muxing_queue_size. Route composes both from cfg.addons via composeAddonArgs; engine forwards verbatim.
  outputArgs?: string[];
  // "Freeze detection" toggle (from the route-resolved per-playlist videoconfig). When true, ffmpeg spawns a
  // decode-only freezedetect analysis tap whose freeze_start/_end metadata drives the buffer state for frozen
  // content. Absent/false ⇒ no tap.
  freezeDetect?: boolean;
}

interface EngineProc {
  key: string; // sha1(channelKey).slice(0,16) — the opaque loopback path segment
  channelKey: string; // = streamKey(source, entryUrl) — the streamState key this proc's health drives
  upstreamUrl: string; // the adapter-resolved master — ffmpeg's -i input
  dir: string; // <ROOT>/<key>
  proc: ChildProcess | null; // null once the process has exited
  startedAt: number;
  lastPollAt: number; // refreshed on every loopback fetch + ensureStream — drives the idle sweep
  hs: EngineHealth; // shared -progress → streamState health state machine (engineHealth.ts)
  configId: string; // resolved videoconfig id this proc runs under ('app' | 'app_<playlistId>') — Active Streams panel
  mode: string; // spawn-time mode ('auto' | 'copy' | 'transcode')
}

const procs = new Map<string, EngineProc>(); // key → running engine process

let server: Server | null = null;
let serverReady: Promise<void> | null = null;
let port = 0;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let ffmpegMissingLogged = false;

function keyFor(channelKey: string): string {
  return createHash('sha1').update(channelKey).digest('hex').slice(0, 16);
}
function masterUrlFor(key: string): string {
  return `http://127.0.0.1:${port}/${key}/index.m3u8`;
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

/** True for a URL served by THIS module's loopback engine server — the SSRF escape hatch the /api/ext proxy
 *  handler ORs with the adapter's allowlist so the composer's rewritten loopback segment hops are permitted
 *  (the adapter's own isAllowedUpstream blocks 127.0.0.1 as a private host). */
export function isExternalEngineLoopbackUrl(rawUrl: string): boolean {
  if (!port) return false;
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port === String(port);
  } catch {
    return false;
  }
}

// The loopback HLS server: serves <ROOT>/<key>/{index.m3u8, <any>.ts}. The key + filename are regex-validated
// (no path traversal — mirrors remux.ts/broll.ts). The filename pattern is permissive (any word/dot/dash name
// ending .ts/.m3u8) so it works regardless of the segment-naming the user's advancedArgs picks (ffmpeg's
// seg_%05d.ts, etc.). Every hit refreshes the proc's poll heartbeat, so the composer's per-poll media-playlist
// fetch keeps a watched channel's engine alive.
function handleRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  const path = (req.url || '').split('?')[0];
  const m = /^\/([a-f0-9]{16})\/([\w.-]+\.(?:m3u8|ts))$/.exec(path);
  if (!m) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  const [, key, file] = m;
  const rec = procs.get(key);
  if (rec) rec.lastPollAt = Date.now();
  const abs = join(ROOT, key, file);
  if (!existsSync(abs)) {
    res.statusCode = 404;
    res.end('not ready');
    return;
  }
  res.setHeader('Content-Type', file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store');
  createReadStream(abs)
    .on('error', () => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    })
    .pipe(res);
}

// Lazily start the loopback server (ephemeral 127.0.0.1 port) + the idle sweep, once, on the first play.
// Clears any stale segment dirs from a previous process run. Resolves when the port is bound.
function ensureServer(): Promise<void> {
  if (serverReady) return serverReady;
  serverReady = new Promise<void>((resolveReady, reject) => {
    try {
      rmSync(ROOT, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    mkdirSync(ROOT, { recursive: true });
    const s = createServer(handleRequest);
    s.on('error', (err) => {
      logger.error(TAG, `loopback server error: ${err.message}`);
      reject(err);
    });
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      server = s;
      startSweep();
      // Kill any surviving ffmpeg children on a normal process exit (the shutdown handler calls process.exit).
      process.once('exit', () => {
        for (const rec of procs.values()) rec.proc?.kill('SIGKILL');
      });
      logger.info(TAG, `external-engine loopback on 127.0.0.1:${port}`);
      resolveReady();
    });
  });
  return serverReady;
}

function startSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const rec of [...procs.values()]) {
      // Idle reap: the composer stopped polling this channel's loopback playlist (viewers all left / playlist deleted).
      if (now - rec.lastPollAt > IDLE_MS) {
        externalPlayerStop(rec, 'idle');
        continue;
      }
      // Watchdog: a live/buffering proc with NO -progress block for longer than its fail window is hung.
      if (rec.proc) watchdog(rec.hs, now);
    }
  }, SWEEP_MS);
  sweepTimer.unref?.();
}

function externalPlayerStop(rec: EngineProc, why: string): void {
  procs.delete(rec.key);
  if (rec.proc) {
    logger.info(TAG, `engine stop ${rec.key} (${why})`);
    try {
      rec.proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    rec.proc = null;
  }
  try {
    rmSync(rec.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ── spawn ──────────────────────────────────────────────────────────────────────────────────────────────
function externalPlayerSpawn(key: string, channelKey: string, upstreamUrl: string, headers: Record<string, string>, cfg: ExternalEngineConfig): EngineProc {
  const dir = join(ROOT, key);
  try {
    rmSync(dir, { recursive: true, force: true }); // clear a prior run's stale segments
  } catch {
    /* ignore */
  }
  mkdirSync(dir, { recursive: true });

  // ffmpeg writes the live HLS window to FILES under <dir> (served by the loopback origin); stdout (pipe:1) is
  // free for the -progress health stream.
  const ua = headers['User-Agent'] || headers['user-agent'] || 'Masqueradarr-ext/1.0';
  const placeholders = { INPUT: upstreamUrl, UA: ua, OUTDIR: dir, M3U8: join(dir, 'index.m3u8'), SEG: join(dir, 'seg') };
  const bin = 'ffmpeg';
  // freezedetect tap on a dedicated pipe (fd 3 here — stdout is the -progress fd, stderr the logs).
  const freezeOn = !!cfg.freezeDetect;
  const argv = buildFfmpegArgv(cfg.args, { placeholders, headers, progressPipe: 'pipe:1', statsPeriodS: STATS_PERIOD_S, inputArgs: cfg.inputArgs, fflags: cfg.fflags, outputArgs: cfg.outputArgs, freezePipe: freezeOn ? 'pipe:3' : undefined });

  const rec: EngineProc = {
    key,
    channelKey,
    upstreamUrl,
    dir,
    proc: null,
    startedAt: Date.now(),
    lastPollAt: Date.now(),
    hs: createEngineHealth(channelKey, cfg, Date.now()),
    configId: cfg.configId,
    mode: cfg.mode,
  };
  procs.set(key, rec);

  let proc: ChildProcess;
  try {
    // fd 0 ignored, 1 = -progress, 2 = logs; fd 3 = freezedetect metadata when the freeze tap is enabled.
    proc = spawn(bin, argv, { stdio: freezeOn ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
  } catch {
    rec.proc = null;
    procs.delete(rec.key);
    return rec; // waitUntilReady sees no proc → throws → composer serves the failed card
  }
  rec.proc = proc;

  // stdout = the -progress health stream → streamState phases.
  {
    const carry = newProgressCarry();
    proc.stdout?.on('data', (d: Buffer) => parseProgress(rec.hs, d.toString(), carry));
  }
  // ffmpeg freezedetect metadata (fd 3) → freeze_start/_end → buffer state for frozen content.
  if (freezeOn) {
    const fcarry = newFreezeCarry();
    (proc.stdio[3] as Readable | null | undefined)?.on('data', (d: Buffer) => parseFreezeLines(rec.hs, d.toString(), fcarry, Date.now()));
  }

  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  proc.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      // A missing ffmpeg binary disables the external engine; the establish throws so the composer serves the
      // failed card (ffmpeg is the always-on external engine — there is no direct-relay fallback).
      if (!ffmpegMissingLogged) {
        logger.warn(TAG, `${bin} not found — external-player engine unavailable`);
        ffmpegMissingLogged = true;
      }
    } else {
      logger.error(TAG, `${bin} spawn error ${key}: ${err.message}`);
    }
    rec.proc = null;
    procs.delete(rec.key);
  });
  proc.on('exit', (code, signal) => {
    const last = stderr.trim().split('\n').filter(Boolean).pop() || '';
    logger.info(TAG, `${bin} exit ${key} code=${code} signal=${signal}${last ? ` · ${last}` : ''}`);
    // A clean stop (our SIGKILL reap, code 0, or 255 = benign client-initiated stop) leaves streamState alone —
    // the proc just leaves the map so a re-open restarts fresh. A genuine non-zero exit is a definitive failure.
    if (signal !== 'SIGKILL' && code !== 0 && code !== 255 && code !== null) {
      noteFailed(rec.channelKey);
    }
    rec.proc = null;
    procs.delete(rec.key);
  });

  logger.info(TAG, `engine start ${key} (ffmpeg/${cfg.mode}) ← ${upstreamUrl}`);
  return rec;
}

// Poll for the playlist (with ≥1 segment) to appear, re-evaluable on every call (no stale promise): a slow
// start self-heals on the next poll; a dead process throws so the composer spends a retry / shows the card.
async function waitUntilReady(rec: EngineProc): Promise<void> {
  const playlist = join(rec.dir, 'index.m3u8');
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (!rec.proc) throw new Error('engine process exited');
    if (existsSync(playlist)) {
      const txt = await readFile(playlist, 'utf8').catch(() => '');
      if (/\.ts\b/.test(txt)) return; // at least one segment listed
    }
    if (Date.now() >= deadline) throw new Error('engine not ready (timeout)');
    await delay(250);
  }
}

/**
 * Ensure an ffmpeg engine is running for this channel and return its loopback HLS master URL. Reuses a
 * running process (multiple external viewers of one channel share one ffmpeg); otherwise spawns one from the
 * configured advancedArgs. Awaits the first playlist+segment (bounded) so the composer's master fetch
 * succeeds; throws on spawn failure / timeout / death (the composer maps a throw to a retry + the
 * establishing/failed B-Roll card). `externalPlayer*`-prefixed per the workstream's naming split.
 */
export async function externalPlayerEnsureStream(
  source: string,
  entryUrl: string,
  upstreamMasterUrl: string,
  upstreamHeaders: Record<string, string>,
  cfg: ExternalEngineConfig,
): Promise<{ masterUrl: string }> {
  await ensureServer();
  const channelKey = streamKey(source, entryUrl); // streamState/health key (plain — readable via phaseFor())
  const key = keyFor(`${channelKey}#${cfg.configId}`); // proc-map key — per-config process isolation

  try {
    let rec = procs.get(key);
    if (!rec || !rec.proc) {
      rec = externalPlayerSpawn(key, channelKey, upstreamMasterUrl, upstreamHeaders, cfg);
    }
    rec.lastPollAt = Date.now();
    await waitUntilReady(rec);
    return { masterUrl: masterUrlFor(key) };
  } catch (err) {
    // The engine is the SOLE streamState writer while it's active (the /api/ext composer runs passive), so a
    // failed establish must spend a retry here — two failed establishes reach the budget ⇒ the failed card.
    // (A genuine non-zero ffmpeg exit additionally fires noteFailed from the exit handler.)
    noteFailure(channelKey);
    throw err;
  }
}

/**
 * Fast-path keep-alive for the entry resolver. If an engine process is ALREADY live for this channel+config,
 * refresh its idle-sweep heartbeat (lastPollAt) and return its loopback HLS master — WITHOUT a fresh upstream
 * resolve. Returns null when no live process exists (the caller must then resolve + spawn via
 * externalPlayerEnsureStream). This lets the per-poll entry resolver skip re-resolving an established stream:
 * the running ffmpeg already holds its own upstream connection (segments come from the CDN), so a per-poll
 * re-resolve only re-hits the rotating/flapping source mirror and tears down a healthy stream when it blips.
 */
export function externalPlayerKeepAlive(
  source: string,
  entryUrl: string,
  configId: string,
): { masterUrl: string } | null {
  const key = keyFor(`${streamKey(source, entryUrl)}#${configId}`);
  const rec = procs.get(key);
  if (!rec || !rec.proc) return null;
  rec.lastPollAt = Date.now();
  return { masterUrl: masterUrlFor(key) };
}

/**
 * Read-only snapshot of every HLS engine process currently serving `channelKey` (one per videoconfig that has
 * a live process for this channel) — for the Active Streams per-stream engine panel. Pure read: it MUST NOT
 * touch rec.lastPollAt (that is the idle-reap clock; bumping it on a read would keep a dead-but-watched
 * engine alive forever).
 */
export function enginesForChannel(channelKey: string): EngineSnapshot[] {
  const out: EngineSnapshot[] = [];
  for (const rec of procs.values()) {
    if (rec.channelKey !== channelKey || !rec.proc) continue;
    out.push({
      output: 'hls',
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
      clients: null,
      producing: rec.hs.health === 'live',
    });
  }
  return out;
}
