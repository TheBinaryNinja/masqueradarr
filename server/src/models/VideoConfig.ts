import { Schema, model } from 'mongoose';

// videoconfig — the singleton (`_id:'app'`) config for the externalPlayer engine: which engine serves
// third-party IPTV-client (TiviMate/Kodi/VLC/…) sessions through /api/ext, and how. Env-seeded on first read
// (mirrors settings/translate.ts), Mongo authoritative thereafter.
//
// The OPERATIVE driver is each engine's `advancedArgs` — the raw single-line ffmpeg/VLC syntax the engine
// spawns with (placeholders <INPUT> <UA> <OUTDIR> <M3U8> <SEG> are substituted at spawn time). The Settings
// "Video Configuration" card populates it from a preset or lets the user type custom syntax.
//
// The `options` sub-objects are the COMPREHENSIVE catalog of every researched ffmpeg/VLC tunable — they exist
// so the schema "holds all possible options" and so a future structured UI (or validation) can compose the
// args string. They are OPTIONAL: a field that isn't being used is stored as explicit `null` (repo convention
// — never fabricated), so an unset knob reads back null rather than a made-up value. v1 drives playback from
// `advancedArgs`; `options` is the reserved structured form.

export type VideoEngine = 'ffmpeg' | 'vlc';
export type VideoMode = 'auto' | 'copy' | 'transcode';
export type VideoOutput = 'hls' | 'ts';
export type HwEncoder =
  | 'none'
  | 'h264_nvenc'
  | 'hevc_nvenc'
  | 'h264_qsv'
  | 'hevc_qsv'
  | 'h264_vaapi'
  | 'hevc_vaapi'
  | 'h264_videotoolbox'
  | 'h264_amf';

// ── ffmpeg option catalog (research Part E) ───────────────────────────────────────────────────────────
export interface FfmpegOptions {
  // input / transport (go before -i)
  userAgent: string | null;
  referer: string | null;
  headers: string | null; // CRLF-joined extra headers
  reconnect: boolean;
  reconnectStreamed: boolean;
  reconnectDelayMax: number; // seconds
  reconnectOnHttpError: string | null; // e.g. "4xx,5xx"
  rwTimeoutUs: number | null; // microseconds
  readNativeRate: boolean; // -re (only for file-as-live)
  fflags: string | null; // e.g. "+genpts"
  analyzeDurationUs: number | null;
  probesizeBytes: number | null;
  // video
  vcodec: string; // copy | libx264 | libx265 | h264_nvenc | h264_qsv | h264_vaapi | …
  x264Preset: string | null; // ultrafast..placebo — libx264/265 ONLY (invalid for HW encoders)
  tune: string | null; // zerolatency | film | animation | … — libx264/265 only
  crf: number | null; // 0–51 — software only; mutually exclusive with bitrateK
  bitrateK: number | null; // -b:v (kbps) — ABR/CBR and HW encoders
  maxrateK: number | null; // -maxrate (VBV ceiling)
  bufsizeK: number | null; // -bufsize (VBV buffer)
  hwPreset: string | null; // HW-encoder preset (nvenc p1..p7, qsv target-usage) — separate from x264Preset
  hwTune: string | null; // nvenc/amf low-latency tune (ll | ull | hq | lossless)
  hwRc: string | null; // HW rate-control (vbr | cbr | constqp | cqp)
  hwQuality: number | null; // nvenc -cq / qsv -global_quality / vaapi -qp
  width: number | null;
  height: number | null;
  scaleExpr: string | null; // e.g. "-2:720"
  fps: number | null;
  gop: number | null; // -g (default fps×hlsTime)
  keyintMin: number | null;
  scThreshold: number | null; // default 0 for uniform segments
  forceKeyFramesExpr: string | null;
  pixFmt: string | null; // default yuv420p (browser-safe)
  profile: string | null; // baseline | main | high
  deinterlace: boolean;
  threads: number | null;
  // audio
  acodec: string; // copy | aac | ac3 | opus | none
  audioBitrateK: number | null;
  audioChannels: number | null;
  audioSampleRate: number | null;
  // output / muxing
  outputFormat: string; // hls | mpegts
  hlsTime: number | null;
  hlsListSize: number | null;
  hlsFlags: string | null;
  hlsSegmentType: string | null; // mpegts | fmp4
  muxOptions: string | null;
  // telemetry
  progress: boolean; // -progress pipe:2 (health stream)
  statsPeriodS: number | null; // -stats_period
  logLevel: string; // quiet | error | warning | info | verbose | debug
  probeOnStart: boolean; // ffprobe once per stream-begin (already implemented)
  stallSpeedThreshold: number; // flag buffering when ffmpeg speed < this
  failTimeoutS: number; // no progress/bytes for N s ⇒ failed
}

// ── VLC option catalog (research Part E) ──────────────────────────────────────────────────────────────
export interface VlcOptions {
  networkCachingMs: number | null;
  liveCachingMs: number | null;
  httpUserAgent: string | null;
  httpReferrer: string | null;
  httpReconnect: boolean;
  adaptiveMaxHeight: number | null;
  runTimeS: number | null;
  // #transcode{} (omit to remux only)
  vcodec: string | null; // none | h264 | hevc | mp2v
  vb: number | null; // video bitrate kb/s
  venc: string | null; // encoder + opts, e.g. x264{preset=veryfast,tune=zerolatency}
  scale: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  deinterlace: boolean;
  acodec: string | null; // mp4a | mpga | a52 | none
  ab: number | null; // audio bitrate kb/s
  channels: number | null;
  samplerate: number | null;
  threads: number | null;
  // #std{} output
  access: string; // livehttp | http | file | rtp | udp
  mux: string; // ts | …
  seglen: number | null; // livehttp segment seconds
  numsegs: number | null; // livehttp window
  delsegs: boolean;
  // telemetry (coarser than ffmpeg — see WS7)
  verbose: number | null; // --verbose level
  httpStats: boolean; // --extraintf http + poll status.xml
  httpPort: number | null;
}

export interface FfmpegEngineConfig {
  preset: string; // preset name | 'custom'
  advancedArgs: string; // ★ OPERATIVE raw args
  options: FfmpegOptions; // comprehensive catalog (reserved/structured)
}
export interface VlcEngineConfig {
  preset: string;
  advancedArgs: string;
  options: VlcOptions;
}
export interface HwAccelConfig {
  enabled: boolean;
  encoder: HwEncoder;
  detected: string[]; // read-only host capabilities, filled by boot detection (WS6)
}

export interface VideoConfigDoc {
  _id: string; // always 'app'
  enabledEngine: VideoEngine | null; // null ⇒ external engine OFF → /api/ext behaves as a direct relay
  mode: VideoMode; // auto | copy | transcode
  output: VideoOutput; // hls (default, reuses the whole stack) | ts (raw-TS passthrough)
  // ffmpeg-only "ExtPicky Override": when true the external engine adds `-extension_picky 0` so ffmpeg's HLS
  // demuxer will read segments with NON-media extensions. Sources like dlhd disguise their MPEG-TS segments as
  // .js/.jpg/.png/.pdf, which ffmpeg blocks by default ("Invalid data found"). Default false keeps the gate ON.
  // No effect on VLC (no such gate) or the in-app /api/v1 player. Set on 'app' (all external) or a Custom
  // 'app_<playlistId>' doc (that playlist only).
  extPickyOverride: boolean;
  // "Freeze detection" toggle. When true the external ffmpeg engine spawns a decode-only freezedetect
  // analysis tap whose freeze_start/_end metadata drives the buffer state for FROZEN CONTENT (a stuck slate /
  // hung encoder — out_time keeps advancing but the picture is static, which the no-progress stall path can't
  // see). Costs a per-stream decode (no re-encode). Default ON for every config (the more accurate buffer
  // signal is worth the modest decode cost); the operator turns it off per-config if needed. Per-playlist like
  // extPickyOverride: read from the route-resolved config — set on 'app' (all external) or a Custom
  // 'app_<playlistId>' doc (that playlist only). ffmpeg-only (VLC has no freezedetect).
  freezeDetect: boolean;
  ffmpeg: FfmpegEngineConfig;
  vlc: VlcEngineConfig;
  hwAccel: HwAccelConfig;
}

// Sub-schemas: every catalog field optional, default null when unused (the "considerations if a setting is
// not being used" requirement — an unset knob is explicit null, never a fabricated value). _id:false so the
// sub-objects aren't addressable subdocuments.
const FfmpegOptionsSchema = new Schema<FfmpegOptions>(
  {
    userAgent: { type: String, default: null },
    referer: { type: String, default: null },
    headers: { type: String, default: null },
    reconnect: { type: Boolean, default: true },
    reconnectStreamed: { type: Boolean, default: true },
    reconnectDelayMax: { type: Number, default: 4 },
    reconnectOnHttpError: { type: String, default: null },
    rwTimeoutUs: { type: Number, default: null },
    readNativeRate: { type: Boolean, default: false },
    fflags: { type: String, default: '+genpts' },
    analyzeDurationUs: { type: Number, default: null },
    probesizeBytes: { type: Number, default: null },
    vcodec: { type: String, default: 'copy' },
    x264Preset: { type: String, default: null },
    tune: { type: String, default: null },
    crf: { type: Number, default: null },
    bitrateK: { type: Number, default: null },
    maxrateK: { type: Number, default: null },
    bufsizeK: { type: Number, default: null },
    hwPreset: { type: String, default: null },
    hwTune: { type: String, default: null },
    hwRc: { type: String, default: null },
    hwQuality: { type: Number, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    scaleExpr: { type: String, default: null },
    fps: { type: Number, default: null },
    gop: { type: Number, default: null },
    keyintMin: { type: Number, default: null },
    scThreshold: { type: Number, default: null },
    forceKeyFramesExpr: { type: String, default: null },
    pixFmt: { type: String, default: null },
    profile: { type: String, default: null },
    deinterlace: { type: Boolean, default: false },
    threads: { type: Number, default: null },
    acodec: { type: String, default: 'copy' },
    audioBitrateK: { type: Number, default: null },
    audioChannels: { type: Number, default: null },
    audioSampleRate: { type: Number, default: null },
    outputFormat: { type: String, default: 'hls' },
    hlsTime: { type: Number, default: null },
    hlsListSize: { type: Number, default: null },
    hlsFlags: { type: String, default: null },
    hlsSegmentType: { type: String, default: null },
    muxOptions: { type: String, default: null },
    progress: { type: Boolean, default: true },
    statsPeriodS: { type: Number, default: null },
    logLevel: { type: String, default: 'error' },
    probeOnStart: { type: Boolean, default: true },
    stallSpeedThreshold: { type: Number, default: 0.95 },
    failTimeoutS: { type: Number, default: 15 },
  },
  { _id: false },
);

const VlcOptionsSchema = new Schema<VlcOptions>(
  {
    networkCachingMs: { type: Number, default: 1500 },
    liveCachingMs: { type: Number, default: null },
    httpUserAgent: { type: String, default: null },
    httpReferrer: { type: String, default: null },
    httpReconnect: { type: Boolean, default: true },
    adaptiveMaxHeight: { type: Number, default: null },
    runTimeS: { type: Number, default: null },
    vcodec: { type: String, default: null },
    vb: { type: Number, default: null },
    venc: { type: String, default: null },
    scale: { type: Number, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    fps: { type: Number, default: null },
    deinterlace: { type: Boolean, default: false },
    acodec: { type: String, default: null },
    ab: { type: Number, default: null },
    channels: { type: Number, default: null },
    samplerate: { type: Number, default: null },
    threads: { type: Number, default: null },
    access: { type: String, default: 'livehttp' },
    mux: { type: String, default: 'ts' },
    seglen: { type: Number, default: null },
    numsegs: { type: Number, default: null },
    delsegs: { type: Boolean, default: true },
    verbose: { type: Number, default: null },
    httpStats: { type: Boolean, default: false },
    httpPort: { type: Number, default: null },
  },
  { _id: false },
);

const FfmpegEngineSchema = new Schema<FfmpegEngineConfig>(
  {
    preset: { type: String, default: 'Remux / Copy (lowest CPU)' },
    advancedArgs: { type: String, default: '' },
    options: { type: FfmpegOptionsSchema, default: () => ({}) },
  },
  { _id: false },
);
const VlcEngineSchema = new Schema<VlcEngineConfig>(
  {
    preset: { type: String, default: 'Remux / Copy → HLS' },
    advancedArgs: { type: String, default: '' },
    options: { type: VlcOptionsSchema, default: () => ({}) },
  },
  { _id: false },
);
const HwAccelSchema = new Schema<HwAccelConfig>(
  {
    enabled: { type: Boolean, default: false },
    encoder: { type: String, default: 'none' },
    detected: { type: [String], default: [] },
  },
  { _id: false },
);

const VideoConfigSchema = new Schema<VideoConfigDoc>(
  {
    _id: { type: String, required: true },
    enabledEngine: { type: String, default: null }, // null ⇒ external engine off
    mode: { type: String, default: 'auto' },
    output: { type: String, default: 'hls' },
    extPickyOverride: { type: Boolean, default: false }, // ffmpeg `-extension_picky 0` (dlhd disguised segments)
    freezeDetect: { type: Boolean, default: true }, // per-playlist ffmpeg freezedetect tap → frozen-content buffer state (default ON)
    ffmpeg: { type: FfmpegEngineSchema, default: () => ({}) },
    vlc: { type: VlcEngineSchema, default: () => ({}) },
    hwAccel: { type: HwAccelSchema, default: () => ({}) },
  },
  { versionKey: false },
);

export const VideoConfig = model<VideoConfigDoc>('VideoConfig', VideoConfigSchema);
