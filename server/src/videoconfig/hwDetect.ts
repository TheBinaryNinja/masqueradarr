import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { VideoConfig } from '../models/VideoConfig.js';
import { VIDEO_CONFIG_ID } from './translate.js';
import { ensureVideoConfig } from './provision.js';
import { logger } from '../sources/core/logger.js';

// Host hardware-encoder capability detection (WS6). Runs once at boot and persists the usable HW encoders to
// videoconfig.hwAccel.detected, which the Settings → Video Configuration card reads to offer ONLY encoders that
// can actually run on this host (the dropdown is `['none', ...detected]`; HW presets gate on it). `detected` is
// server-derived + read-only over the API — overwritten each boot so it tracks the current host (e.g. a GPU
// added + container restarted). Non-fatal: software transcode and the loopback engine work regardless.
//
// Detection = (a) the encoder is COMPILED INTO this ffmpeg (`ffmpeg -encoders`) AND (b) the device family it
// needs is present (a render node for VAAPI/QSV/AMF, the nvidia devices for NVENC) — so we never offer an
// encoder that would fail at spawn time. videotoolbox (macOS) has no device gate. Mirrors the DB-free + injected
// posture of the rest of the engine: this module reads ffmpeg + /dev, then writes the one singleton field.

const TAG = 'settings';

// The HW encoders we surface — must match the VideoConfig HwEncoder union.
const HW_ENCODERS = [
  'h264_nvenc',
  'hevc_nvenc',
  'h264_qsv',
  'hevc_qsv',
  'h264_vaapi',
  'hevc_vaapi',
  'h264_videotoolbox',
  'h264_amf',
] as const;

const FFMPEG_TIMEOUT_MS = 8_000;

// Capture `ffmpeg -hide_banner -encoders` stdout (the encoder table). Resolves '' when ffmpeg is missing
// (ENOENT) or times out — detection then reports no HW encoders (software-only), never throwing.
function ffmpegEncoderListing(): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (s: string): void => {
      if (!settled) {
        settled = true;
        resolve(s);
      }
    };
    let proc;
    try {
      proc = spawn('ffmpeg', ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      done('');
      return;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      done(out);
    }, FFMPEG_TIMEOUT_MS);
    timer.unref?.();
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.on('error', () => {
      clearTimeout(timer);
      done(''); // ENOENT — no ffmpeg on PATH
    });
    proc.on('close', () => {
      clearTimeout(timer);
      done(out);
    });
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The HW encoders ffmpeg has compiled in AND whose device is present on this host. Empty when ffmpeg is
 * software-only or missing. DB-free — the caller persists the result.
 */
export async function detectHwEncoders(): Promise<string[]> {
  const listing = await ffmpegEncoderListing();
  if (!listing) return [];
  const hasDri = (await exists('/dev/dri/renderD128')) || (await exists('/dev/dri/card0'));
  const hasNvidia = (await exists('/dev/nvidia0')) || (await exists('/dev/nvidiactl'));
  const out: string[] = [];
  for (const enc of HW_ENCODERS) {
    if (!new RegExp(`\\b${enc}\\b`).test(listing)) continue; // not compiled into this ffmpeg build
    const needsDri = enc.includes('vaapi') || enc.includes('qsv') || enc.includes('amf');
    const needsNvidia = enc.includes('nvenc');
    if (needsDri && !hasDri) continue; // VAAPI/QSV/AMF need a render node (/dev/dri)
    if (needsNvidia && !hasNvidia) continue; // NVENC needs the nvidia container-runtime devices (/dev/nvidia*)
    out.push(enc);
  }
  return out;
}

/**
 * One-time, idempotent migration: bring existing videoconfig docs current with the new `freezeDetect` default
 * (ON for all configs). The field landed OFF; this flips every existing doc to true ONCE. The global Default
 * 'app' doc is the bellwether — the migration runs only while 'app' is still at the old value, so once flipped
 * it no-ops on every later boot and never re-flips a deliberate per-config `false`. A fresh install has nothing
 * to migrate (the schema default already writes `true` on first provision). Non-fatal.
 */
async function migrateFreezeDetectDefault(): Promise<void> {
  const app = await VideoConfig.findById(VIDEO_CONFIG_ID).select({ freezeDetect: 1 }).lean();
  // 'app' already on (fresh install seeds true; or a prior boot already migrated) ⇒ nothing to do.
  if (!app || app.freezeDetect === true) return;
  const res = await VideoConfig.updateMany({ freezeDetect: { $ne: true } }, { $set: { freezeDetect: true } });
  if (res.modifiedCount) logger.info(TAG, `freezeDetect default migrated ON for ${res.modifiedCount} videoconfig doc(s)`);
}

/**
 * Boot step: detect host HW encoders and persist them to videoconfig.hwAccel.detected. Ensures the singleton
 * exists first (shared seed) so a fresh install fills `detected` on its very first boot; then $sets only the
 * read-only field. Non-fatal — never throws to the boot sequence.
 */
export async function applyHwDetection(): Promise<void> {
  await ensureVideoConfig();
  await migrateFreezeDetectDefault();
  const detected = await detectHwEncoders();
  await VideoConfig.updateOne({ _id: VIDEO_CONFIG_ID }, { $set: { 'hwAccel.detected': detected } });
  logger.info(
    TAG,
    detected.length ? `hardware encoders detected: ${detected.join(', ')}` : 'no hardware encoders detected (software transcode only)',
  );
}
