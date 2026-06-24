import { Schema, model } from 'mongoose';

// viewsessions — the per-viewer watch-session history (append-only). One row per client (ip|user-agent)
// that watched a channel through the proxy, written when that client's session ends (it goes stale past
// the telemetry TTL) by the stats layer's persistence sink (stats/statsHub.ts ← streamTelemetry.onSessionClose).
// Feeds the History/Metrics screen (sessions table, buffer histogram, problem channels, QoE). Distinct from
// streamsessions (the ffprobe quality TIME-SERIES) and from the live in-memory ActiveStream snapshot. See
// schemas.md §3.x.
//
// QoE score (0–100), computed at write time: start at 100, subtract a rebuffer-ratio penalty
// (rebufferMs/durationMs, weighted ×400, capped 60) and a buffer-count penalty (×6, capped 30). `health`
// thresholds mirror the SPA's existing HistoryMetricsScreen mapping (score<55 → bad, <80 → warn, else good).

export interface BufferEventDoc {
  at: number; // ms epoch the buffering interval began
  phase: 'buffer' | 'failed';
  ms: number; // interval duration
}

export interface ViewSessionDoc {
  channelId: string; // = PlaylistChannel._id ("<source>:<sourceChannelId>") — the linkage field
  source: string;
  ip: string;
  userAgent: string;
  username: string | null;
  playerType: 'appPlayer' | 'externalPlayer'; // in-app slide-out player vs a third-party IPTV client (TiviMate/Kodi/VLC/…)
  location: string | null; // geo label resolved from `ip` at write time ("City, Region, US" / "Local"); null = geo disabled
  countryCode: string | null; // ISO-3166-1 alpha-2 for the flag emoji; null when unknown/local/disabled
  startedAt: number; // ms epoch
  endedAt: number | null; // ms epoch (set when the session is written; null reserved for live rollups)
  durationMs: number;
  bytesTotal: number;
  avgBitrate: number; // kbps = bytesTotal*8 / durationMs
  resolution: string | null; // snapshotted from the channel's last ffprobe at close
  codec: string | null;
  bufferCount: number;
  rebufferMs: number;
  bufferEvents: BufferEventDoc[];
  qoeScore: number; // 0–100
  health: 'good' | 'warn' | 'bad';
}

// Sub-schema without its own _id (a plain event list, not addressable subdocuments).
const BufferEventSchema = new Schema<BufferEventDoc>(
  {
    at: { type: Number, required: true },
    phase: { type: String, required: true },
    ms: { type: Number, required: true },
  },
  { _id: false },
);

const ViewSessionSchema = new Schema<ViewSessionDoc>(
  {
    channelId: { type: String, required: true },
    source: { type: String, required: true },
    ip: { type: String, required: true },
    userAgent: { type: String, required: true },
    username: { type: String, default: null, index: true },
    // Forward-only: pre-existing rows (written before this field) read back as 'appPlayer' — the historical
    // default, since every session before the external engine came from the in-app player.
    playerType: { type: String, default: 'appPlayer', index: true },
    location: { type: String, default: null },
    countryCode: { type: String, default: null },
    startedAt: { type: Number, required: true },
    endedAt: { type: Number, default: null },
    durationMs: { type: Number, required: true },
    bytesTotal: { type: Number, required: true },
    avgBitrate: { type: Number, required: true },
    resolution: { type: String, default: null },
    codec: { type: String, default: null },
    bufferCount: { type: Number, required: true, default: 0 },
    rebufferMs: { type: Number, required: true, default: 0 },
    bufferEvents: { type: [BufferEventSchema], default: [] },
    qoeScore: { type: Number, required: true },
    health: { type: String, required: true },
  },
  { versionKey: false },
);

// Covers the per-channel history query (problem-channels grouping) …
ViewSessionSchema.index({ channelId: 1, startedAt: 1 });
// … and the recent-sessions listing (GET /api/view-sessions, newest first).
ViewSessionSchema.index({ startedAt: 1 });

export const ViewSession = model<ViewSessionDoc>('ViewSession', ViewSessionSchema);
