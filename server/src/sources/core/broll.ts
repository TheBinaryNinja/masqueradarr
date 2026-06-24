// B-Roll placeholder stream renderer.
//
// While a channel stream is establishing, mid-stream re-buffering, or has failed, the proxy serves a
// "B-Roll" HLS clip in place of a black/broken player — a broadcast-style slate showing the operator
// Display Name, the channel name, and the live status + retry count. Dumb IPTV clients (VLC, set-top
// boxes) can't render a DOM overlay, so the card is burned into real encoded HLS video here.
//
// Pipeline — deliberately freetype-free so it runs on ANY ffmpeg build (incl. Homebrew's, which ships
// without libfreetype/drawtext): rasterize the card to an RGB bitmap in pure Node using an embedded
// 8x8 font (font8x8.ts) → write a 24-bit BMP → ffmpeg encodes the still into a short H.264 HLS clip
// (libx264 + hls muxer + bmp decoder — all core, no external libs). Renders are cached on disk by a
// hash of (title, channel, status, retry), so ffmpeg runs once per distinct card; the media-playlist
// composer (proxyHandler) loops the cached segments to fake a "live" playlist.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { FONT8X8, FONT_FIRST_CODE, GLYPH_W, GLYPH_H } from './font8x8.js';
import { logger } from './logger.js';

const tag = 'broll';

export type BrollStatus = 'establishing' | 'buffer' | 'failed';

export interface BrollParams {
  title: string; // operator Display Name
  channel: string; // channel name
  status: BrollStatus;
  retry: number; // 0..BROLL_RETRY_MAX
}

export interface BrollRender {
  hash: string;
  dir: string;
  segments: { name: string; duration: number }[]; // ordered seg0.ts, seg1.ts, …
}

// Retry budget shown on the card ("Retry X of 2"). The stream-state tracker (streamState.ts) owns the
// authoritative MAX_RETRIES and must keep it in sync with this display value.
export const BROLL_RETRY_MAX = 2;

// Bump when the card layout / encode changes so stale cached renders are ignored.
const RENDER_VERSION = 2;

// ── Card geometry & look ────────────────────────────────────────────────
const WIDTH = 1280;
const HEIGHT = 720;
const SEG_SECONDS = 2; // each HLS segment
const CLIP_SECONDS = 4; // total clip (=> 2 segments); the composer loops it for "live"
const FPS = 8; // low fps — it's a static slate
export const BROLL_SEG_SECONDS = SEG_SECONDS;

type RGB = readonly [number, number, number];
const BG: RGB = [14, 17, 22]; // dark slate (#0e1116)
const ACCENT: RGB = [90, 180, 210]; // cyan accent bar
const TITLE: RGB = [240, 242, 245];
const SUBTLE: RGB = [150, 160, 170];
const AMBER: RGB = [232, 184, 64]; // establishing / buffer
const RED: RGB = [222, 86, 74]; // failed

const TITLE_SCALE = 9; // nominal; each line is auto-fit smaller if it would overflow
const BODY_SCALE = 6;
const SMALL_SCALE = 5;
const LINE_GAP = 30; // px between text lines
const MARGIN = 80; // min horizontal padding each side
const MAX_LINE_W = WIDTH - MARGIN * 2;

function statusColor(s: BrollStatus): RGB {
  return s === 'failed' ? RED : AMBER;
}

export function statusLine(s: BrollStatus): string {
  switch (s) {
    case 'establishing':
      return 'establishing buffer';
    case 'buffer':
      return 'buffer';
    case 'failed':
      return 'failed';
  }
}

// ── Pure-Node bitmap rasterizer ─────────────────────────────────────────

interface Line {
  text: string;
  scale: number;
  color: RGB;
}

function cardLines(p: BrollParams): Line[] {
  const lines: Line[] = [
    { text: p.title.trim() || 'TVApp2', scale: TITLE_SCALE, color: TITLE },
    { text: `Channel Stream: ${p.channel.trim() || '—'}`, scale: BODY_SCALE, color: SUBTLE },
    { text: `Status: ${statusLine(p.status)}`, scale: BODY_SCALE, color: statusColor(p.status) },
  ];
  if (p.status !== 'failed' && p.retry > 0) {
    lines.push({ text: `Retry ${p.retry} of ${BROLL_RETRY_MAX}`, scale: SMALL_SCALE, color: SUBTLE });
  }
  return lines;
}

// Advance per glyph (8 columns + 1 spacing column), in source font pixels.
const ADVANCE = GLYPH_W + 1;

function lineWidthPx(text: string, scale: number): number {
  if (text.length === 0) return 0;
  return (text.length * ADVANCE - 1) * scale; // drop the trailing spacing column
}

// Largest integer scale (<= nominal) at which the text fits MAX_LINE_W; if it overflows even at 1,
// the text is truncated to fit (returned alongside). Keeps any Display Name / channel name contained.
function fitLine(text: string, nominal: number): { text: string; scale: number } {
  let s = nominal;
  while (s > 1 && lineWidthPx(text, s) > MAX_LINE_W) s--;
  if (lineWidthPx(text, s) <= MAX_LINE_W) return { text, scale: s };
  const maxChars = Math.max(1, Math.floor((MAX_LINE_W / s + 1) / ADVANCE));
  const clipped = text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 3))}...` : text;
  return { text: clipped, scale: s };
}

function glyphFor(code: number): readonly number[] {
  const idx = code - FONT_FIRST_CODE;
  if (idx >= 0 && idx < FONT8X8.length) return FONT8X8[idx];
  return FONT8X8['?'.charCodeAt(0) - FONT_FIRST_CODE]; // non-ASCII → '?'
}

function drawGlyph(
  buf: Uint8Array,
  code: number,
  x0: number,
  y0: number,
  scale: number,
  color: RGB,
): void {
  const glyph = glyphFor(code);
  for (let row = 0; row < GLYPH_H; row++) {
    const bits = glyph[row];
    for (let col = 0; col < GLYPH_W; col++) {
      if (!(bits & (1 << col))) continue; // bit 0 (LSB) = leftmost column
      const px = x0 + col * scale;
      const py = y0 + row * scale;
      for (let dy = 0; dy < scale; dy++) {
        let off = ((py + dy) * WIDTH + px) * 3;
        for (let dx = 0; dx < scale; dx++) {
          buf[off] = color[0];
          buf[off + 1] = color[1];
          buf[off + 2] = color[2];
          off += 3;
        }
      }
    }
  }
}

function drawText(buf: Uint8Array, text: string, scale: number, color: RGB, yTop: number): void {
  const w = lineWidthPx(text, scale);
  let x = Math.max(MARGIN, Math.round((WIDTH - w) / 2));
  for (const ch of text) {
    drawGlyph(buf, ch.charCodeAt(0), x, yTop, scale, color);
    x += ADVANCE * scale;
  }
}

function fillRect(buf: Uint8Array, x: number, y: number, w: number, h: number, color: RGB): void {
  for (let yy = y; yy < y + h; yy++) {
    let off = (yy * WIDTH + x) * 3;
    for (let xx = 0; xx < w; xx++) {
      buf[off] = color[0];
      buf[off + 1] = color[1];
      buf[off + 2] = color[2];
      off += 3;
    }
  }
}

function renderCard(p: BrollParams): Uint8Array {
  const buf = new Uint8Array(WIDTH * HEIGHT * 3);
  // background
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = BG[0];
    buf[i + 1] = BG[1];
    buf[i + 2] = BG[2];
  }
  // Auto-fit each line so long Display Name / channel names stay within the frame.
  const fitted = cardLines(p).map((l) => ({ ...fitLine(l.text, l.scale), color: l.color }));
  const heights = fitted.map((l) => GLYPH_H * l.scale);
  const totalH = heights.reduce((a, b) => a + b, 0) + LINE_GAP * (fitted.length - 1);
  let y = Math.round((HEIGHT - totalH) / 2);
  // accent bar above the title
  const barW = Math.min(560, Math.round(WIDTH * 0.5));
  fillRect(buf, Math.round((WIDTH - barW) / 2), Math.max(0, y - 30), barW, 4, ACCENT);
  for (let i = 0; i < fitted.length; i++) {
    drawText(buf, fitted[i].text, fitted[i].scale, fitted[i].color, y);
    y += heights[i] + LINE_GAP;
  }
  return buf;
}

// 24-bit uncompressed BMP (BGR, bottom-up, rows padded to 4 bytes). ffmpeg's bmp decoder reads it.
function encodeBMP(rgb: Uint8Array): Buffer {
  const rowSize = Math.floor((24 * WIDTH + 31) / 32) * 4;
  const pixelArraySize = rowSize * HEIGHT;
  const fileSize = 54 + pixelArraySize;
  const buf = Buffer.alloc(fileSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10); // pixel data offset
  buf.writeUInt32LE(40, 14); // BITMAPINFOHEADER size
  buf.writeInt32LE(WIDTH, 18);
  buf.writeInt32LE(HEIGHT, 22); // positive => bottom-up
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bpp
  buf.writeUInt32LE(0, 30); // BI_RGB
  buf.writeUInt32LE(pixelArraySize, 34);
  buf.writeInt32LE(2835, 38); // 72 dpi
  buf.writeInt32LE(2835, 42);
  for (let y = 0; y < HEIGHT; y++) {
    const srcY = HEIGHT - 1 - y; // BMP rows are bottom-up
    let off = 54 + y * rowSize;
    for (let x = 0; x < WIDTH; x++) {
      const i = (srcY * WIDTH + x) * 3;
      buf[off++] = rgb[i + 2]; // B
      buf[off++] = rgb[i + 1]; // G
      buf[off++] = rgb[i]; // R
    }
  }
  return buf;
}

// ── ffmpeg encode + on-disk cache ───────────────────────────────────────

const CACHE_ROOT = resolve(tmpdir(), 'masqueradarr-broll');
const inFlight = new Map<string, Promise<BrollRender | null>>();
let ffmpegMissingLogged = false;

function hashParams(p: BrollParams): string {
  return createHash('sha1')
    .update(`${RENDER_VERSION}|${p.title}|${p.channel}|${p.status}|${p.retry}`)
    .digest('hex')
    .slice(0, 16);
}

function readCached(dir: string): BrollRender['segments'] | null {
  if (!existsSync(resolve(dir, 'broll.m3u8'))) return null;
  const segs = readdirSync(dir)
    .filter((f) => /^seg\d+\.ts$/.test(f))
    .sort((a, b) => parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10));
  if (segs.length === 0) return null;
  // Parse EXTINF durations from the ffmpeg-written playlist (fall back to SEG_SECONDS).
  const text = readFileSync(resolve(dir, 'broll.m3u8'), 'utf8');
  const durations = [...text.matchAll(/#EXTINF:([0-9.]+)/g)].map((m) => parseFloat(m[1]));
  return segs.map((name, i) => ({ name, duration: durations[i] ?? SEG_SECONDS }));
}

function runFfmpeg(dir: string, bmpPath: string): Promise<boolean> {
  const gop = FPS * SEG_SECONDS;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-loop',
    '1',
    '-framerate',
    String(FPS),
    '-t',
    String(CLIP_SECONDS),
    '-i',
    bmpPath,
    '-r',
    String(FPS),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'stillimage',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(gop),
    '-keyint_min',
    String(gop),
    '-sc_threshold',
    '0',
    '-force_key_frames',
    `expr:gte(t,n_forced*${SEG_SECONDS})`,
    '-f',
    'hls',
    '-hls_time',
    String(SEG_SECONDS),
    '-hls_list_size',
    '0',
    '-hls_flags',
    'independent_segments',
    '-hls_segment_filename',
    resolve(dir, 'seg%d.ts'),
    resolve(dir, 'broll.m3u8'),
  ];
  return new Promise((resolveDone) => {
    let stderr = '';
    let proc;
    try {
      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      resolveDone(false);
      return;
    }
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        if (!ffmpegMissingLogged) {
          logger.warn(tag, 'ffmpeg not found — B-Roll placeholder disabled (upstream errors forwarded as before)');
          ffmpegMissingLogged = true;
        }
      } else {
        logger.error(tag, `ffmpeg spawn error: ${err.message}`);
      }
      resolveDone(false);
    });
    proc.on('close', (code) => {
      if (code === 0) return resolveDone(true);
      logger.error(tag, `ffmpeg exited ${code}: ${stderr.trim().split('\n').slice(-2).join(' ')}`);
      resolveDone(false);
    });
  });
}

/**
 * Render (or reuse a cached) B-Roll HLS clip for the given card. Returns null when ffmpeg is
 * unavailable or the encode fails — callers must treat null as "B-Roll disabled" and fall back.
 */
export function renderBroll(p: BrollParams): Promise<BrollRender | null> {
  const hash = hashParams(p);
  const dir = resolve(CACHE_ROOT, hash);

  const cached = (() => {
    try {
      return readCached(dir);
    } catch {
      return null;
    }
  })();
  if (cached) return Promise.resolve({ hash, dir, segments: cached });

  const pending = inFlight.get(hash);
  if (pending) return pending;

  const job = (async (): Promise<BrollRender | null> => {
    try {
      mkdirSync(dir, { recursive: true });
      const bmpPath = resolve(dir, 'card.bmp');
      writeFileSync(bmpPath, encodeBMP(renderCard(p)));
      const ok = await runFfmpeg(dir, bmpPath);
      if (!ok) return null;
      const segments = readCached(dir);
      if (!segments) return null;
      logger.ok(tag, `rendered card [${p.status} retry=${p.retry}] "${p.channel}" → ${segments.length} segs (${hash})`);
      return { hash, dir, segments };
    } catch (err) {
      logger.error(tag, `render failed: ${(err as Error).message}`);
      return null;
    } finally {
      inFlight.delete(hash);
    }
  })();
  inFlight.set(hash, job);
  return job;
}

/** Read a cached B-Roll segment by hash + name (name validated against traversal). */
export function readBrollSegment(hash: string, name: string): Buffer | null {
  if (!/^[a-f0-9]{16}$/.test(hash) || !/^seg\d+\.ts$/.test(name)) return null;
  const path = resolve(CACHE_ROOT, hash, name);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}
