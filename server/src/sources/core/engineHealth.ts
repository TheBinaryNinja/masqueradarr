// Shared ffmpeg `-progress` → streamState health state machine for the external-player engine. Both engine
// paths consume it: the loopback-HLS engine (externalEngine.ts, output:'hls') and the raw-TS passthrough
// (externalTsEngine.ts, output:'ts'). ffmpeg emits `key=value` blocks on its -progress fd (each terminated
// by `progress=continue|end`); this maps `out_time_us` advance onto the existing streamState retry model
// (noteSuccess / noteFailure / noteFailed). The mapping is EDGE-triggered, not per-block — the retry budget
// would be spent in two ticks if we fired every 1s — so a transition only fires on a phase change.
//
// Buffering is driven by TWO signals (the old single-sample `speed < stallSpeed` flip was retired — it
// over-fired on benign keyframe/jitter dips and flooded Active Streams + History/Metrics with buffer events):
//   1. a DE-FLICKERED no-progress stall — `out_time_us` stuck for ≥ STALL_DEBOUNCE_MS (a true rebuffer: no
//      data ⇒ no new frames, which freezedetect can't see), and
//   2. freezedetect (`-vf freezedetect`, read off a dedicated metadata pipe) — frozen CONTENT where out_time
//      keeps advancing but the picture is static (a stuck slate / hung encoder), which the no-progress path
//      cannot see. Both flip live→buffer and escalate to failed; the watchdog + non-zero exit stay hard
//      backstops. `speed`/fps/bitrate are still captured, but only as Active Streams panel metrics.
//
// DB-free + source-agnostic (like the rest of sources/core): the only side effect is the streamState calls
// keyed by `channelKey`. While the engine is active it is the SOLE streamState writer for that channel (the
// /api/ext composer runs passive — see brollProxy driveStreamState), so this is what surfaces a channel's
// buffering/failed phase in Active Streams for an otherwise-opaque external session.

import { noteSuccess, noteFailure, noteFailed } from './streamState.js';

// Defaults match the VideoConfig ffmpeg.options sub-schema defaults (0.95 / 15s). Overridable per engine via
// the cfg the route reads from videoconfig. NOTE: `stallSpeed` no longer drives state (it was the flood
// source — see handleProgressBlock); it is retained only as a captured Active Streams panel metric.
export const DEFAULT_STALL_SPEED = 0.95;
export const DEFAULT_FAIL_TIMEOUT_S = 15;

// A non-freeze (no-progress) stall must persist this long before a live→buffer flip — the de-flicker that
// stops a single jittery 1s `-progress` block from recording a buffer event. Env-overridable (mirrors the
// EXT_ENGINE_* knobs in externalEngine.ts).
export const STALL_DEBOUNCE_MS = Number(process.env.EXT_STALL_DEBOUNCE_MS || 4000);

// The mutable per-process health state. `health` is the engine's internal phase; the streamState calls it
// drives are what the rest of the stack reads via phaseFor().
export interface EngineHealth {
  channelKey: string; // = streamKey(source, entryUrl) — the streamState key this proc's health drives
  health: 'init' | 'live' | 'buffer' | 'failed';
  lastOutTimeUs: number; // out_time from the previous progress block (advance check)
  lastProgressAt: number; // when the last progress block arrived (watchdog for a fully-hung ffmpeg)
  lastAdvanceAt: number; // last time out_time_us advanced — the no-progress stall de-flicker clock
  frozen: boolean; // inside a freezedetect freeze interval (frames frozen but out_time still advances)
  bufferSince: number | null; // when the current buffering interval began (escalation to failed)
  failTimeoutMs: number; // failTimeoutS × 1000 (cached)
  stallSpeed: number; // captured-only metric (no longer drives state — see handleProgressBlock)
  // Latest realtime metrics parsed off the ffmpeg -progress block, surfaced in the Active Streams engine
  // panel. Null until the first progress block arrives.
  lastSpeed: number | null; // encode speed × (e.g. 1.01)
  lastFps: number | null; // output frame rate
  lastBitrateKbps: number | null; // output bitrate (kbit/s)
  lastDropFrames: number | null; // cumulative frames dropped (ffmpeg `drop_frames`)
}

// A read-only per-process snapshot for the Active Streams engine panel (GET /api/active-streams/:id/engine).
// Each engine core's enginesForChannel() builds one of these per live process serving a channel; the route
// then enriches it (preset/advancedArgs/hwEncoder from the videoconfig) and redacts upstreamUrl. `clients` is
// the raw-TS socket count (null for HLS). `engine` is always 'ffmpeg' (the sole external engine).
export interface EngineSnapshot {
  output: 'hls' | 'ts';
  engine: 'ffmpeg';
  configId: string; // 'app' (Default) | 'app_<playlistId>' (Custom)
  mode: string; // 'auto' | 'copy' | 'transcode'
  upstreamUrl: string; // adapter-resolved master (raw here; the route redacts the query before responding)
  startedAt: number;
  state: 'init' | 'live' | 'buffer' | 'failed';
  speed: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  outTimeMs: number | null;
  dropFrames: number | null; // cumulative dropped frames (ffmpeg -progress)
  clients: number | null; // raw-TS attached socket count; null for the HLS engine
  producing: boolean;
}

// `carry` persists across `data` events (a progress block — ~15 short lines ending in `progress=`, usually
// one pipe write but not guaranteed atomic): `buf` holds the trailing partial LINE, `block` holds the
// key/values accumulated so far for the CURRENT block (so a block split across two chunks isn't lost).
export interface ProgressCarry {
  buf: string;
  block: Record<string, string>;
}

export function newProgressCarry(): ProgressCarry {
  return { buf: '', block: {} };
}

export function createEngineHealth(
  channelKey: string,
  opts: { stallSpeedThreshold?: number; failTimeoutS?: number },
  now: number,
): EngineHealth {
  return {
    channelKey,
    health: 'init',
    lastOutTimeUs: 0,
    lastProgressAt: now,
    lastAdvanceAt: now,
    frozen: false,
    bufferSince: null,
    failTimeoutMs: Math.max(2_000, (opts.failTimeoutS || DEFAULT_FAIL_TIMEOUT_S) * 1000),
    stallSpeed: opts.stallSpeedThreshold || DEFAULT_STALL_SPEED,
    lastSpeed: null,
    lastFps: null,
    lastBitrateKbps: null,
    lastDropFrames: null,
  };
}

// One parsed `-progress` block → a streamState transition. We watch `out_time_us` (advance check) for the
// de-flickered no-progress stall; `speed`/fps/bitrate are captured only as Active Streams panel metrics (the
// old `speed < stallSpeed` flip was retired — it flooded with false buffer events). Content freezes are
// handled separately by freezedetect (markFreezeStart/End). out_time_us is microseconds (ffmpeg 5+);
// out_time_ms is ALSO microseconds despite the name (legacy quirk) — code against out_time_us, fall back.
export function handleProgressBlock(h: EngineHealth, fields: Record<string, string>, now: number): void {
  h.lastProgressAt = now;
  // Capture the latest realtime metrics for the Active Streams engine panel (display-only). bitrate arrives as
  // e.g. "2730.5kbits/s" — parseFloat stops at the unit suffix.
  const speedRaw = fields.speed; // "1.01x" | "N/A"
  const speed = speedRaw && speedRaw !== 'N/A' ? parseFloat(speedRaw) : NaN;
  if (Number.isFinite(speed)) h.lastSpeed = speed;
  const fps = parseFloat(fields.fps ?? '');
  if (Number.isFinite(fps)) h.lastFps = fps;
  const bitrate = parseFloat(fields.bitrate ?? '');
  if (Number.isFinite(bitrate)) h.lastBitrateKbps = bitrate;
  const drop = Number(fields.drop_frames ?? NaN); // cumulative dropped-frame count (ffmpeg -progress)
  if (Number.isFinite(drop)) h.lastDropFrames = drop;

  const outTimeUs = Number(fields.out_time_us ?? fields.out_time_ms ?? NaN);
  const advancing = Number.isFinite(outTimeUs) && outTimeUs > h.lastOutTimeUs;
  if (Number.isFinite(outTimeUs)) h.lastOutTimeUs = outTimeUs;
  if (advancing) h.lastAdvanceAt = now;

  // A content freeze advances out_time while the picture is frozen — it is owned by freeze_start/_end
  // (markFreezeStart/End), so an advancing block must NOT clear it here. Only let the freeze escalate to
  // failed once it has run past the fail window.
  if (h.frozen) {
    markStall(h, now);
    return;
  }

  if (advancing) {
    if (h.health !== 'live') noteSuccess(h.channelKey); // (re)established → live; clears the failure counter
    h.health = 'live';
    h.bufferSince = null;
  } else if (now - h.lastAdvanceAt > STALL_DEBOUNCE_MS) {
    // De-flickered no-progress stall: out_time stuck past the debounce ⇒ live→buffer, then buffer→failed
    // after failTimeoutMs. A brief non-advancing gap within the debounce (or 'init' not yet advancing) holds
    // the current state — the engine's readiness wait / process exit cover a true establish failure.
    markStall(h, now);
  }
}

// The live→buffer transition (from a stalled progress block OR the watchdog). One noteFailure (the buffer
// card shows; everStreamed ⇒ buffer not establishing); a later sustained stall escalates to failed.
export function markStall(h: EngineHealth, now: number): void {
  if (h.health === 'live') {
    noteFailure(h.channelKey);
    h.health = 'buffer';
    h.bufferSince = now;
  } else if (h.health === 'buffer' && h.bufferSince !== null && now - h.bufferSince > h.failTimeoutMs) {
    noteFailed(h.channelKey);
    h.health = 'failed';
  }
}

// freezedetect (ffmpeg `-vf freezedetect`) freeze interval boundaries, parsed off the engine's dedicated
// metadata pipe (see engineArgs.buildFfmpegArgv). A freeze is frozen CONTENT — out_time keeps advancing while
// the picture is static — which handleProgressBlock's out_time-advance path cannot see, so these drive it.

// Freeze begins: own the buffer state until freeze_end. One noteFailure (everStreamed ⇒ buffer card, not
// establishing); a sustained freeze later escalates to failed via the frozen branch in handleProgressBlock.
export function markFreezeStart(h: EngineHealth, now: number): void {
  h.frozen = true;
  if (h.health === 'live') {
    noteFailure(h.channelKey);
    h.health = 'buffer';
    h.bufferSince = now;
  }
}

// Freeze recovers: clear the freeze and (re)establish live. Reset lastAdvanceAt so the no-progress debounce
// doesn't immediately re-flip on the next block.
export function markFreezeEnd(h: EngineHealth, now: number): void {
  h.frozen = false;
  h.lastAdvanceAt = now;
  if (h.health !== 'live') {
    noteSuccess(h.channelKey);
    h.health = 'live';
    h.bufferSince = null;
  }
}

// Carry for the freezedetect metadata pipe (mirrors ProgressCarry): the `metadata=mode=print` lines may split
// across chunk boundaries, so keep the trailing partial line.
export interface FreezeCarry {
  buf: string;
}
export function newFreezeCarry(): FreezeCarry {
  return { buf: '' };
}

// Feed a raw chunk off the freezedetect metadata pipe; drives the freeze interval transitions. The filter
// emits `lavfi.freezedetect.freeze_start=<sec>` when a freeze begins and `…freeze_end=<sec>` (alongside
// `…freeze_duration`) on the first frame after it recovers. Substring match is tolerant of the print framing.
export function parseFreezeLines(h: EngineHealth, chunk: string, carry: FreezeCarry, now: number): void {
  carry.buf = (carry.buf + chunk).slice(-8000); // bound the carry (defensive)
  const lines = carry.buf.split('\n');
  carry.buf = lines.pop() || ''; // keep the trailing partial line
  for (const line of lines) {
    if (line.includes('lavfi.freezedetect.freeze_start')) markFreezeStart(h, now);
    else if (line.includes('lavfi.freezedetect.freeze_end')) markFreezeEnd(h, now);
  }
}

// Feed a raw chunk off the -progress fd; emits a transition per complete block.
export function parseProgress(h: EngineHealth, chunk: string, carry: ProgressCarry): void {
  carry.buf = (carry.buf + chunk).slice(-8000); // bound the carry (defensive)
  const lines = carry.buf.split('\n');
  carry.buf = lines.pop() || ''; // keep the trailing partial line
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    carry.block[k] = v;
    if (k === 'progress') {
      handleProgressBlock(h, carry.block, Date.now());
      carry.block = {};
    }
  }
}

// Watchdog for a fully-hung ffmpeg: a live/buffering proc that has emitted NO progress block for longer than
// its fail window (the per-block parser only fires when blocks arrive). Drives the same escalation. The
// engine's idle sweep calls this each tick.
export function watchdog(h: EngineHealth, now: number): void {
  if ((h.health === 'live' || h.health === 'buffer') && now - h.lastProgressAt > h.failTimeoutMs) {
    markStall(h, now);
  }
}
