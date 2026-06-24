// HDHomeRun TS→HLS remux manager — the streaming half of the HDHomeRun adapter.
//
// HDHomeRun tuners serve a channel as raw MPEG-TS over plain HTTP (http://<ip>:5004/auto/v<ch>), which the
// in-app hls.js player CANNOT play and which the B-Roll composer (built around HLS) can't mirror. So per
// active channel we run one ffmpeg that bridges the device's TS into a live HLS window — video COPIED when
// it's already browser-safe (h264/hevc, cheap + lossless) or TRANSCODED to H.264 when it isn't (OTA is
// often mpeg2video, which browsers/hls.js cannot decode → audio plays but the picture is black); audio is
// always re-encoded to AAC (OTA audio is usually AC-3, undecodable in browsers) — written to a temp dir and
// served back over a 127.0.0.1 loopback HTTP origin. The video mode is auto-detected per channel via a
// one-shot ffprobe (cached), overridable with HDHR_VIDEO_MODE. The adapter's resolveStream() hands the
// composer that loopback master URL, so the ENTIRE existing proxy/B-Roll/ffprobe/telemetry stack works
// UNCHANGED (it just mirrors a local HLS playlist); the only adapter-specific knowledge is "the loopback
// origin is allowed and emits TS" (adapters/hdhomerun/index.ts isAllowedUpstream). See restapi-sources/SKILL.md.
//
// Lifecycle: one shared ffmpeg per channel (multiple viewers ride one remux = one device tuner); started on
// first resolve; the per-device tuner cap (discover.json TunerCount, kept current by registerDevice) fails a
// new channel fast when tuners are exhausted (the device also 503s); an idle sweep reaps a process once the
// composer stops polling its loopback playlist (deleting a playlist therefore reaps its remuxes for free).
// Spawn/degradation mirrors core/broll.ts + core/streamProbe.ts (bare `ffmpeg`, ENOENT logged once).

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, createReadStream, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../core/logger.js';

const TAG = 'stream:hdhomerun';
const ROOT = join(tmpdir(), 'masqueradarr-hdhr'); // <ROOT>/<key>/{index.m3u8,seg*.ts}

const SEGMENT_SECONDS = Number(process.env.HDHR_REMUX_SEG_SECONDS || 2);
const HLS_LIST_SIZE = Number(process.env.HDHR_REMUX_LIST_SIZE || 6); // sliding live window
const READY_TIMEOUT_MS = Number(process.env.HDHR_REMUX_READY_MS || 12_000); // wait for the first playlist+segment
const IDLE_MS = Number(process.env.HDHR_REMUX_IDLE_MS || 45_000); // reap a process unpolled this long (> the 30s telemetry client TTL)
const SWEEP_MS = 15_000;

// ── video codec policy ── OTA channels are often MPEG-2 (undecodable in browsers → black picture). In the
// default `auto` mode we ffprobe the device once and COPY the video when it's already browser-safe
// (h264/hevc — lossless, no CPU) or TRANSCODE to H.264 when it isn't. `copy`/`transcode` force it (no probe).
type VideoMode = 'copy' | 'transcode';
const VIDEO_MODE = (process.env.HDHR_VIDEO_MODE || 'auto').toLowerCase(); // auto | copy | transcode
const COPY_CODECS = (process.env.HDHR_COPY_CODECS || 'h264,hevc') // input codecs copied (not transcoded) in auto
  .toLowerCase()
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const X264_PRESET = process.env.HDHR_X264_PRESET || 'veryfast';
const X264_CRF = String(Number(process.env.HDHR_X264_CRF || 21));
const X264_MAXRATE = process.env.HDHR_X264_MAXRATE || '8M'; // cap output bitrate for stable live segments
const X264_BUFSIZE = process.env.HDHR_X264_BUFSIZE || doubleRate(X264_MAXRATE);
const PROBE_TIMEOUT_MS = 8_000;

// Double a `<number><unit>` rate string (e.g. "8M" → "16M") for the default x264 -bufsize (= 2× -maxrate).
function doubleRate(r: string): string {
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMgG]?)$/.exec(r.trim());
  return m ? `${Number(m[1]) * 2}${m[2]}` : r;
}

interface RemuxProc {
  key: string; // sha1(deviceTsUrl).slice(0,16) — the opaque loopback path segment
  deviceTsUrl: string; // http://<ip>:5004/auto/v<ch> — ffmpeg's input
  deviceHost: string; // the device hostname (the physical tuner; the cap is per-host)
  dir: string; // <ROOT>/<key>
  proc: ChildProcess | null; // null once the process has exited
  startedAt: number;
  lastPollAt: number; // refreshed on every loopback fetch + ensureMaster — drives the idle sweep
}

const procs = new Map<string, RemuxProc>(); // key → running remux
const caps = new Map<string, number>(); // device hostname → TunerCount (the client-side cap)
const modeCache = new Map<string, VideoMode>(); // deviceTsUrl → decided video mode (probe once, reuse)

let server: Server | null = null;
let serverReady: Promise<void> | null = null;
let port = 0;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let ffmpegMissingLogged = false;
let ffprobeMissingLogged = false;

function keyFor(deviceTsUrl: string): string {
  return createHash('sha1').update(deviceTsUrl).digest('hex').slice(0, 16);
}
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
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

/** Record a device's TunerCount (the per-host concurrent-stream cap). Called by the create/sync path. */
export function registerDevice(base: string, tunerCount: number): void {
  const h = hostnameOf(base);
  if (h) caps.set(h, tunerCount > 0 ? tunerCount : 1);
}

/** True for a URL served by THIS module's loopback remux server (the only upstream the adapter proxies). */
export function isLoopbackRemuxUrl(rawUrl: string): boolean {
  if (!port) return false;
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port === String(port);
  } catch {
    return false;
  }
}

// The loopback HLS server: serves <ROOT>/<key>/{index.m3u8,seg<N>.ts}. The key + filename are regex-validated
// (no path traversal — mirrors broll.ts readBrollSegment). Every hit refreshes the proc's poll heartbeat, so
// the composer's per-poll media-playlist fetch keeps a watched channel's remux alive.
function handleRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
  const path = (req.url || '').split('?')[0];
  const m = /^\/([a-f0-9]{16})\/(index\.m3u8|seg\d+\.ts)$/.exec(path);
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
  serverReady = new Promise<void>((resolve, reject) => {
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
      logger.info(TAG, `remux loopback on 127.0.0.1:${port}`);
      resolve();
    });
  });
  return serverReady;
}

function startSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const rec of [...procs.values()]) {
      if (now - rec.lastPollAt > IDLE_MS) stopProc(rec, 'idle');
    }
  }, SWEEP_MS);
  sweepTimer.unref?.();
}

function liveProcsForHost(host: string): number {
  let n = 0;
  for (const rec of procs.values()) if (rec.deviceHost === host && rec.proc) n++;
  return n;
}

function stopProc(rec: RemuxProc, why: string): void {
  procs.delete(rec.key);
  if (rec.proc) {
    logger.info(TAG, `remux stop ${rec.key} (${why})`);
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

// One bounded ffprobe of the device TS to read its primary video codec (auto mode only). Returns the
// lowercased codec_name, or null on any failure — the caller maps null to `transcode`, the safe default
// that guarantees a picture. Mirrors core/streamProbe.ts (bare `ffprobe`, ENOENT logged once, SIGKILL on
// timeout). Runs only after the tuner-cap check, so it and the remux use the device sequentially.
async function probeDeviceVideoCodec(deviceTsUrl: string): Promise<string | null> {
  const args = [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_name',
    '-of',
    'json',
    '-probesize',
    '2000000',
    '-analyzeduration',
    '2000000',
    '-user_agent',
    'Masqueradarr-hdhr/1.0',
    '-i',
    deviceTsUrl,
  ];
  return new Promise<string | null>((resolveCodec) => {
    let proc: ChildProcess;
    try {
      proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolveCodec(null);
      return;
    }
    let out = '';
    let done = false;
    const finish = (v: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolveCodec(v);
    };
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    timer.unref?.();
    proc.stdout?.on('data', (d: Buffer) => {
      out = (out + d.toString()).slice(0, 4000);
    });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' && !ffprobeMissingLogged) {
        logger.warn(TAG, 'ffprobe not found — video-codec auto-detect disabled (defaulting to transcode)');
        ffprobeMissingLogged = true;
      }
      finish(null);
    });
    proc.on('exit', () => {
      try {
        const codec = JSON.parse(out)?.streams?.[0]?.codec_name;
        finish(typeof codec === 'string' ? codec.toLowerCase() : null);
      } catch {
        finish(null);
      }
    });
  });
}

// Decide copy vs transcode from the probed codec. Forced modes ignore the codec; in `auto`, copy only
// browser-safe codecs (COPY_CODECS) and transcode everything else — including null (probe failed/absent).
function decideVideoMode(codec: string | null): VideoMode {
  if (VIDEO_MODE === 'copy') return 'copy';
  if (VIDEO_MODE === 'transcode') return 'transcode';
  return codec && COPY_CODECS.includes(codec) ? 'copy' : 'transcode';
}

// Spawn one ffmpeg that bridges the device TS into a live HLS window: video copied or transcoded to H.264
// per `mode`, audio always re-encoded to stereo AAC.
function startProc(key: string, deviceTsUrl: string, deviceHost: string, mode: VideoMode): RemuxProc {
  const dir = join(ROOT, key);
  try {
    rmSync(dir, { recursive: true, force: true }); // clear a prior run's stale segments
  } catch {
    /* ignore */
  }
  mkdirSync(dir, { recursive: true });

  const rec: RemuxProc = {
    key,
    deviceTsUrl,
    deviceHost,
    dir,
    proc: null,
    startedAt: Date.now(),
    lastPollAt: Date.now(),
  };
  procs.set(key, rec);

  // Video: copy when already browser-safe, else transcode to H.264. Audio is always re-encoded to AAC.
  const videoArgs =
    mode === 'copy'
      ? ['-c:v', 'copy', '-copyts'] // remux — cheap, lossless (preserve source timestamps)
      : [
          // Deinterlace only interlaced frames (1080i OTA); a no-op on 720p60 progressive.
          '-vf',
          'bwdif=mode=send_frame:deint=interlaced',
          '-c:v',
          'libx264',
          '-preset',
          X264_PRESET,
          '-tune',
          'zerolatency',
          '-profile:v',
          'high',
          '-pix_fmt',
          'yuv420p',
          '-sc_threshold',
          '0',
          // Align keyframes to segment boundaries so the live HLS window cuts cleanly (mirrors broll.ts).
          '-force_key_frames',
          `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
          '-crf',
          X264_CRF,
          '-maxrate',
          X264_MAXRATE,
          '-bufsize',
          X264_BUFSIZE,
          // no -copyts: the deinterlace filter retimes frames; +genpts regenerates PTS to keep A/V in sync.
        ];

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-fflags',
    '+genpts',
    // The input is a long-lived live TS over HTTP — reconnect transient drops instead of exiting.
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '2',
    '-user_agent',
    'Masqueradarr-hdhr/1.0',
    '-i',
    deviceTsUrl,
    // First video + all audio only (skip data/subtitle streams the mpegts HLS muxer may choke on).
    '-map',
    '0:v:0?',
    '-map',
    '0:a?',
    ...videoArgs,
    '-c:a',
    'aac', // re-encode audio so AC-3 OTA audio plays in browsers
    '-ac',
    '2',
    '-f',
    'hls',
    '-hls_time',
    String(SEGMENT_SECONDS),
    '-hls_list_size',
    String(HLS_LIST_SIZE),
    '-hls_flags',
    'delete_segments+independent_segments+omit_endlist',
    '-hls_segment_type',
    'mpegts',
    '-hls_segment_filename',
    join(dir, 'seg%d.ts'),
    join(dir, 'index.m3u8'),
  ];

  let proc: ChildProcess;
  try {
    proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    rec.proc = null;
    procs.delete(rec.key);
    return rec; // waitUntilReady sees no proc → throws → composer serves the failed card
  }
  rec.proc = proc;

  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  proc.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      if (!ffmpegMissingLogged) {
        logger.warn(TAG, 'ffmpeg not found — HDHomeRun streaming disabled (channels list/compose but do not play)');
        ffmpegMissingLogged = true;
      }
    } else {
      logger.error(TAG, `ffmpeg spawn error ${key}: ${err.message}`);
    }
    rec.proc = null;
    procs.delete(rec.key);
  });
  proc.on('exit', (code, signal) => {
    const last = stderr.trim().split('\n').filter(Boolean).pop() || '';
    logger.info(TAG, `ffmpeg exit ${key} code=${code} signal=${signal}${last ? ` · ${last}` : ''}`);
    rec.proc = null;
    procs.delete(rec.key); // gone from the map → a re-open restarts fresh
  });

  logger.info(TAG, `remux start ${key} (${mode}) ← ${deviceTsUrl}`);
  return rec;
}

// Poll for the playlist (with ≥1 segment) to appear, re-evaluable on every call (no stale promise): a slow
// start self-heals on the next poll; a dead process throws so the composer spends a retry / shows the card.
async function waitUntilReady(rec: RemuxProc): Promise<void> {
  const playlist = join(rec.dir, 'index.m3u8');
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (!rec.proc) throw new Error('remux process exited');
    if (existsSync(playlist)) {
      const txt = await readFile(playlist, 'utf8').catch(() => '');
      if (/seg\d+\.ts/.test(txt)) return;
    }
    if (Date.now() >= deadline) throw new Error('remux not ready (timeout)');
    await delay(250);
  }
}

/**
 * Ensure a remux is running for this device channel and return its loopback HLS master URL. Reuses a running
 * process (multi-viewer share one tuner); otherwise enforces the per-device tuner cap then starts one. Awaits
 * the first playlist+segment (bounded) so the composer's master fetch succeeds; throws on cap/timeout/death
 * (the composer maps a throw to a retry + the establishing/failed B-Roll card).
 */
export async function ensureMaster(deviceTsUrl: string): Promise<{ masterUrl: string }> {
  await ensureServer();
  const key = keyFor(deviceTsUrl);
  const deviceHost = hostnameOf(deviceTsUrl);

  let rec = procs.get(key);
  if (!rec || !rec.proc) {
    const cap = caps.get(deviceHost);
    if (cap !== undefined && liveProcsForHost(deviceHost) >= cap) {
      throw new Error(`tuner_cap (${cap})`);
    }
    // Decide copy vs transcode once per channel. Probe only in auto mode (forced modes skip the device
    // hit + the first-play latency); the probe runs after the cap check, so it + the remux are sequential.
    let mode = modeCache.get(deviceTsUrl);
    if (!mode) {
      const codec = VIDEO_MODE === 'auto' ? await probeDeviceVideoCodec(deviceTsUrl) : null;
      mode = decideVideoMode(codec);
      modeCache.set(deviceTsUrl, mode);
      logger.info(TAG, `codec=${codec ?? 'unknown'} → ${mode}`);
    }
    rec = startProc(key, deviceTsUrl, deviceHost, mode);
  }
  rec.lastPollAt = Date.now();
  await waitUntilReady(rec);
  return { masterUrl: masterUrlFor(key) };
}
