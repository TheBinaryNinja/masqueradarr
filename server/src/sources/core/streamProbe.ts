// Per-channel stream technical-detail probe — the ffprobe side-channel monitor.
//
// When a channel goes live through the proxy, we run `ffprobe` against the resolved variant playlist to
// read the stream's real technical details (video codec/profile/pixfmt/resolution/bitrate, frame rate +
// time base, audio codec/sample rate/channels/format). This NEVER touches the byte pipe — the proxy
// forwards bytes verbatim; the probe is fire-and-forget. A live stream's technical details don't change
// after it starts, so we probe ONCE per stream-begin (not on a TTL): the first successful ffprobe is
// cached for the whole session and every later poll is a no-op. If a probe fails we retry — up to
// MAX_PROBE_ATTEMPTS spawns total, spaced by RETRY_DELAY_MS — then give up until the stream re-establishes;
// `resetProbe(key)` (called by the proxy at each fresh resolve) clears the budget so a re-established
// stream probes again. Pure in-memory like streamState.ts / metrics.ts — the latest probe lives here and
// is surfaced read-only by GET /api/sources/:id/stream-details; durable persistence (the streamsessions
// time-series + the channel snapshot) is the route layer's injected `sink` so this core stays DB-free and
// source-agnostic.
//
// `tbc` (codec time base) is intentionally omitted — it was removed from modern ffprobe JSON output; `tbn`
// (the stream time_base) and `tbr` (r_frame_rate) are the faithful, JSON-available equivalents.

import { spawn } from 'node:child_process';
import { logger } from './logger.js';
import type { StreamProbe } from '../../models/StreamSession.js';

const tag = 'streamprobe';

// Probe budget per stream-begin: at most this many ffprobe spawns before we give up (until the stream
// re-establishes and resetProbe clears it). The first success is cached for the whole session.
const MAX_PROBE_ATTEMPTS = 3;
// Minimum spacing between failed attempts — gives a stream that needs a moment to buffer a fair chance
// between tries (and stops a fast-polling client from burning the whole budget in a few hundred ms).
const RETRY_DELAY_MS = 3_000;
// ffprobe on a LIVE HLS url reads a segment; bound the wait so a stalled upstream can't hang the process.
const PROBE_TIMEOUT_MS = 12_000;
// Cap concurrent ffprobe spawns across all channels/sources (ffprobe is light, but unbounded fan-out on a
// busy box isn't). Excess ensureProbe() calls no-op and a later poll retries (the budget is preserved).
const MAX_CONCURRENT = 2;

interface ProbeEntry {
  probe: StreamProbe | null; // null until a spawn succeeds this stream-begin
  probedAt: number; // ms epoch of the successful probe
  attempts: number; // ffprobe spawns spent this stream-begin (capped at MAX_PROBE_ATTEMPTS)
  lastAttemptAt: number; // ms epoch of the last spawn — spaces retries (RETRY_DELAY_MS)
}

const probes = new Map<string, ProbeEntry>();
const inflight = new Set<string>();
let active = 0;
let ffprobeMissingLogged = false;

// ── ffprobe JSON shape (only the fields we map) ──────────────────────────
interface RawStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  time_base?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  sample_fmt?: string;
}
interface RawProbe {
  streams?: RawStream[];
  format?: { format_name?: string };
}

// "30000/1001" → 29.97 (3dp); null on a zero/garbage denominator or unparseable input.
function parseFraction(v: string | undefined): number | null {
  if (!v) return null;
  const [n, d] = v.split('/');
  const num = Number(n);
  const den = d === undefined ? 1 : Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return Math.round((num / den) * 1000) / 1000;
}

function toInt(v: string | number | undefined): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function mapProbe(raw: RawProbe): StreamProbe {
  const streams = Array.isArray(raw.streams) ? raw.streams : [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const width = toInt(v?.width);
  const height = toInt(v?.height);
  // time_base "1/90000" → tbn 90000 (the timescale denominator).
  const tbn = v?.time_base ? toInt(v.time_base.split('/')[1]) : null;
  return {
    video: {
      codec: v?.codec_name ?? null,
      profile: v?.profile ?? null,
      pixFmt: v?.pix_fmt ?? null,
      width,
      height,
      resolution: width && height ? `${width}x${height}` : null,
      bitrate: toInt(v?.bit_rate),
      fps: parseFraction(v?.avg_frame_rate),
      tbr: parseFraction(v?.r_frame_rate),
      tbn,
    },
    audio: {
      codec: a?.codec_name ?? null,
      sampleRate: toInt(a?.sample_rate),
      channels: toInt(a?.channels),
      channelLayout: a?.channel_layout ?? null,
      format: a?.sample_fmt ?? null,
      bitrate: toInt(a?.bit_rate),
    },
    container: raw.format?.format_name ?? null,
  };
}

// ffmpeg/ffprobe HTTP options must precede -i. User-Agent has a first-class flag; everything else rides a
// single CRLF-joined -headers blob (passed via the spawn ARRAY, so the \r\n is never shell-mangled). Uses
// the adapter's upstreamHeaders so a tokenized/auth upstream (dulo) probes with the same headers the proxy
// fetches it with.
function headerArgs(headers: Record<string, string>): string[] {
  const entries = Object.entries(headers ?? {});
  const out: string[] = [];
  const ua = entries.find(([k]) => k.toLowerCase() === 'user-agent');
  if (ua) out.push('-user_agent', ua[1]);
  const rest = entries.filter(([k]) => k.toLowerCase() !== 'user-agent');
  if (rest.length) out.push('-headers', rest.map(([k, val]) => `${k}: ${val}\r\n`).join(''));
  return out;
}

// Spawn ffprobe and parse its JSON. Mirrors broll.ts → runFfmpeg: spawn the system binary, capture
// stdout/stderr, degrade gracefully when the binary is absent (ENOENT → log once, return null). Adds a
// hard kill-timer (a live HLS url can hang ffprobe) guarded by `settled` so the Promise resolves once.
function runFfprobe(url: string, headers: Record<string, string>): Promise<RawProbe | null> {
  const args = [
    // `error` (not `quiet`) so a non-zero exit logs the real reason — the close handler reads the last
    // stderr line; `quiet` left it blank and hid HLS demux failures.
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    // Bound the analysis so a live stream doesn't read its whole window.
    '-analyzeduration',
    '4000000',
    '-probesize',
    '4000000',
    // Hardened ffmpeg builds (Debian's 5.1.x backport) gate HLS segments behind extension_picky /
    // allowed_segment_extensions. Sources whose segment URLs carry no media extension (dulo serves
    // `/live-gateway/resource/<jwt>`) are otherwise rejected as "Invalid data" and every probe exits 1.
    '-extension_picky',
    '0',
    ...headerArgs(headers),
    '-i',
    url,
  ];
  return new Promise((resolveDone) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (val: RawProbe | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveDone(val);
    };
    let proc;
    try {
      proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => {
      logger.warn(tag, `ffprobe timed out after ${PROBE_TIMEOUT_MS}ms`);
      proc.kill('SIGKILL');
      finish(null);
    }, PROBE_TIMEOUT_MS);
    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        if (!ffprobeMissingLogged) {
          logger.warn(tag, 'ffprobe not found — stream-detail monitoring disabled');
          ffprobeMissingLogged = true;
        }
      } else {
        logger.error(tag, `ffprobe spawn error: ${err.message}`);
      }
      finish(null);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        if (!settled) logger.warn(tag, `ffprobe exited ${code}: ${stderr.trim().split('\n').slice(-1).join(' ')}`);
        return finish(null);
      }
      try {
        finish(JSON.parse(stdout) as RawProbe);
      } catch {
        finish(null);
      }
    });
  });
}

/**
 * One-shot probe for the scheduled background sweep (sources/probeAll.ts): resolve → ffprobe → map and
 * return the result directly, bypassing the per-stream-begin in-memory cache + retry budget that
 * ensureProbe maintains for the live proxy. Never throws; returns null when ffprobe is unavailable, times
 * out, or the stream can't be read (a non-null result means ffprobe analyzed the stream → it's up).
 */
export async function probeOnce(url: string, headers: Record<string, string>): Promise<StreamProbe | null> {
  const raw = await runFfprobe(url, headers);
  return raw ? mapProbe(raw) : null;
}

export type ProbeSink = (probe: StreamProbe) => void | Promise<void>;

/**
 * Probe this channel's live variant once per stream-begin. Fire-and-forget (mirrors
 * brollProxy.ensureResolve): never throws to the caller, never blocks the byte stream. Skips once a probe
 * has succeeded (one-time, cached for the session), once the MAX_PROBE_ATTEMPTS budget is spent (give up
 * until resetProbe), and within RETRY_DELAY_MS of the last failed attempt (spacing). On a success it caches
 * the result and invokes the optional persistence `sink` (best-effort); a failure just spends an attempt
 * and a later poll retries until the budget runs out.
 */
export function ensureProbe(key: string, url: string, headers: Record<string, string>, sink?: ProbeSink): void {
  if (inflight.has(key)) return;
  const e = probes.get(key);
  if (e?.probe) return; // already captured this stream-begin — one-time, never re-probe
  if (e && e.attempts >= MAX_PROBE_ATTEMPTS) return; // budget exhausted — give up until resetProbe
  if (e && Date.now() - e.lastAttemptAt < RETRY_DELAY_MS) return; // space the retries
  if (active >= MAX_CONCURRENT) return; // capped — a later poll retries (the budget is preserved)
  const entry = e ?? { probe: null, probedAt: 0, attempts: 0, lastAttemptAt: 0 };
  entry.attempts++;
  entry.lastAttemptAt = Date.now();
  probes.set(key, entry);
  inflight.add(key);
  active++;
  void (async () => {
    try {
      const raw = await runFfprobe(url, headers);
      if (raw) {
        entry.probe = mapProbe(raw);
        entry.probedAt = Date.now();
        if (sink) {
          try {
            await sink(entry.probe);
          } catch (err) {
            logger.warn(tag, `probe sink failed: ${(err as Error).message}`);
          }
        }
      }
      // On failure: the attempt is already spent; a later poll retries until MAX_PROBE_ATTEMPTS.
    } finally {
      inflight.delete(key);
      active--;
    }
  })();
}

/** The last probed technical details for a channel, or null if not yet successfully probed (drives the SPA drawer). */
export function probeFor(key: string): (StreamProbe & { probedAt: string }) | null {
  const e = probes.get(key);
  if (!e || !e.probe) return null;
  return { ...e.probe, probedAt: new Date(e.probedAt).toISOString() };
}

/**
 * Clear a channel's probe state so a freshly-(re)established stream probes again from scratch — called by
 * the proxy at each fresh resolve (a re-establish is a new "stream begins"), resetting the retry budget and
 * the cached probe.
 */
export function resetProbe(key: string): void {
  probes.delete(key);
}
