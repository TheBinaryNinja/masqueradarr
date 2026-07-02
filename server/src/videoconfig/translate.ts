import type { VideoConfigDoc } from '../models/VideoConfig.js';
import { ADDON_IDS } from './addonCatalog.js';

// videoconfig boundary layer (mirrors settings/translate.ts): the default seed for first provision and the
// request-body → whitelisted $set validator. There are no secrets to redact, so the read shape is the doc
// minus its `_id`.

export const VIDEO_CONFIG_ID = 'app';

// Default OPERATIVE args = the ffmpeg "Remux / Copy" preset (lowest CPU, lossless), with the spawn
// placeholders <INPUT> <UA> <OUTDIR> <M3U8> <SEG> the engine substitutes at run time. Seeded on first
// provision so /api/ext works out of the box. The full preset CATALOG lives frontend-side (the Settings
// picker); this mirrors its default entry so the engine has sane starting args.
export const DEFAULT_FFMPEG_ARGS =
  '-hide_banner -loglevel error -user_agent "<UA>" -reconnect 1 -reconnect_streamed 1 ' +
  '-reconnect_delay_max 4 -fflags +genpts -i "<INPUT>" -map 0:v:0 -map 0:a? -c copy -copyts ' +
  '-f hls -hls_time 6 -hls_list_size 6 -hls_flags delete_segments+independent_segments+omit_endlist ' +
  '-hls_segment_filename "<OUTDIR>/seg_%05d.ts" "<M3U8>"';

// Default OPERATIVE args for the raw-TS passthrough (output:'ts', externalTsEngine.ts): remux to MPEG-TS on
// stdout (pipe:1) — no segment files, so only <INPUT>/<UA> placeholders apply (-progress is injected on fd 3).
// Used when output==='ts' UNLESS the user's ffmpeg.advancedArgs already targets `pipe:1` (a custom TS string).
export const DEFAULT_TS_ARGS =
  '-hide_banner -loglevel error -user_agent "<UA>" -reconnect 1 -reconnect_streamed 1 ' +
  '-reconnect_delay_max 4 -fflags +genpts -i "<INPUT>" -map 0:v:0 -map 0:a? -c copy -copyts -f mpegts pipe:1';

const MODES = ['auto', 'copy', 'transcode'];
const OUTPUTS = ['hls', 'ts'];
// The selectable HW encoders (matches the VideoConfig HwEncoder union + hwDetect.ts). The Settings card only
// OFFERS the subset present in the server-derived hwAccel.detected, but the PUT validator accepts any known
// value (the card never sends an undetected one).
const HW_ENCODERS = [
  'none',
  'h264_nvenc',
  'hevc_nvenc',
  'h264_qsv',
  'hevc_qsv',
  'h264_vaapi',
  'hevc_vaapi',
  'h264_videotoolbox',
  'h264_amf',
];

type Patch = { ok: true; $set: Record<string, unknown> } | { ok: false; error: string };

// Validate a PUT body into a whitelisted dotted-path $set. v1's write surface is mode, output, ffmpeg's preset
// + advancedArgs (the operative driver), the extPickyOverride/freezeDetect toggles, and the hwAccel
// enable/encoder. The comprehensive `options` catalog is accepted as a whole-object replace for a future
// structured UI; the server-derived `hwAccel.detected` is read-only and ignored if sent. ffmpeg is the
// always-on external engine — there is no engine-selector / enable field.
export function toExternalVideoPatch(body: unknown): Patch {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, any>;
  const $set: Record<string, unknown> = {};

  if ('mode' in b) {
    if (!MODES.includes(b.mode)) return { ok: false, error: 'mode must be auto|copy|transcode' };
    $set.mode = b.mode;
  }
  if ('output' in b) {
    if (!OUTPUTS.includes(b.output)) return { ok: false, error: 'output must be hls|ts' };
    $set.output = b.output;
  }
  if ('extPickyOverride' in b) {
    // ffmpeg-only "ExtPicky Override" toggle → the engine adds `-extension_picky 0` (dlhd disguised segments).
    $set.extPickyOverride = !!b.extPickyOverride;
  }
  if ('freezeDetect' in b) {
    // "Freeze detection" toggle → ffmpeg engine spawns a decode-only freezedetect tap (frozen-content buffer
    // state). Per-playlist like extPickyOverride — editable on 'app' (Default) or a Custom 'app_<id>' doc.
    $set.freezeDetect = !!b.freezeDetect;
  }
  if ('addons' in b) {
    // Selected externalPlayer addon ids (ad-break resilience flag-splices). Validate it's a string[] and drop
    // any id not in the known catalog (ADDON_IDS) — the server composes only recognised ids; unknown ⇒ ignored.
    if (!Array.isArray(b.addons) || b.addons.some((x: unknown) => typeof x !== 'string')) {
      return { ok: false, error: 'addons must be an array of strings' };
    }
    $set.addons = [...new Set(b.addons as string[])].filter((id) => ADDON_IDS.has(id));
  }
  {
    const e = b.ffmpeg;
    if (e && typeof e === 'object') {
      if ('preset' in e) {
        if (typeof e.preset !== 'string') return { ok: false, error: 'ffmpeg.preset must be a string' };
        $set['ffmpeg.preset'] = e.preset;
      }
      if ('advancedArgs' in e) {
        if (typeof e.advancedArgs !== 'string') return { ok: false, error: 'ffmpeg.advancedArgs must be a string' };
        $set['ffmpeg.advancedArgs'] = e.advancedArgs;
      }
      if ('options' in e && e.options && typeof e.options === 'object') {
        $set['ffmpeg.options'] = e.options; // sub-schema casts; whole-object replace (reserved structured form)
      }
    }
  }
  if (b.hwAccel && typeof b.hwAccel === 'object') {
    if ('enabled' in b.hwAccel) $set['hwAccel.enabled'] = !!b.hwAccel.enabled;
    if ('encoder' in b.hwAccel) {
      if (typeof b.hwAccel.encoder !== 'string' || !HW_ENCODERS.includes(b.hwAccel.encoder)) {
        return { ok: false, error: `hwAccel.encoder must be one of: ${HW_ENCODERS.join(', ')}` };
      }
      $set['hwAccel.encoder'] = b.hwAccel.encoder;
    }
    // hwAccel.detected is server-derived (boot capability detection) — read-only, ignored if sent.
  }

  if (Object.keys($set).length === 0) return { ok: false, error: 'no recognized fields to update' };
  return { ok: true, $set };
}

// Read projection: strip the internal _id (singleton 'app') from the returned doc.
export function toRuntimeVideoConfig(doc: VideoConfigDoc): Omit<VideoConfigDoc, '_id'> {
  const { _id, ...rest } = doc;
  void _id;
  return rest;
}
