import { Schema, model } from 'mongoose';

// Per-channel stream technical-detail probe (ffprobe-derived). The persisted shape shared by the
// streamsessions time-series rows (this model) and the PlaylistChannel.stream.probe snapshot. `tbc` (codec
// time base) is intentionally absent — it was removed from modern ffprobe JSON; `tbn` (the stream time_base)
// and `tbr` (r_frame_rate) are the faithful, JSON-available equivalents. See schemas.md §3.8.
export interface StreamProbe {
  video: {
    codec: string | null; // ffprobe codec_name (e.g. "h264")
    profile: string | null; // ffprobe profile (e.g. "High")
    pixFmt: string | null; // ffprobe pix_fmt (e.g. "yuv420p")
    width: number | null;
    height: number | null;
    resolution: string | null; // derived "1920x1080"
    bitrate: number | null; // bps (ffprobe bit_rate — often null for HLS)
    fps: number | null; // avg_frame_rate evaluated (e.g. 29.97)
    tbr: number | null; // r_frame_rate evaluated
    tbn: number | null; // time_base denominator (e.g. 90000)
  };
  audio: {
    codec: string | null;
    sampleRate: number | null; // Hz (ffprobe sample_rate)
    channels: number | null;
    channelLayout: string | null; // ffprobe channel_layout (e.g. "stereo")
    format: string | null; // ffprobe sample_fmt (e.g. "fltp")
    bitrate: number | null; // bps
  };
  container: string | null; // ffprobe format.format_name (e.g. "hls,applehttp")
}

// streamsessions — the per-channel stream-probe store, 1:1 with the streaming channel. Each row is the
// LATEST ffprobe capture for one channel, UPSERTED (not appended) under a deterministic `_id` =
// PlaylistChannel._id, so there is exactly one row per channel (no duplicate probe rows) and the row's
// identity is permanently bound to the channel that was streaming. Written by the proxy's probe sink
// (routes/sources.ts → makePersistProbe), which re-probes ~once per stream-begin and overwrites the row.
// Feeds the History/Metrics build-out (later). (History: this collection previously held viewer-session
// mock data {ip, region, client, joined, bitrate, order}, then an append-only ffprobe time-series — fully
// repurposed; legacy ObjectId-keyed rows + the stale `order`/{channelId,capturedAt} indexes are reconciled
// at boot — see sources/seed.ts → bootInitSources.)
export interface StreamSessionDoc {
  _id: string; // = PlaylistChannel._id ("<source>:<sourceChannelId>"); deterministic — one row per channel
  channelId: string; // runtime mirror of _id (the linkage field the API surfaces; the read projects _id out)
  capturedAt: number; // ms epoch of the probe
  video: StreamProbe['video'];
  audio: StreamProbe['audio'];
  container: string | null;
}

// Nested-object field maps (not subdocuments) → Mongoose adds no per-object `_id`.
const VideoProbeFields = {
  codec: { type: String, default: null },
  profile: { type: String, default: null },
  pixFmt: { type: String, default: null },
  width: { type: Number, default: null },
  height: { type: Number, default: null },
  resolution: { type: String, default: null },
  bitrate: { type: Number, default: null },
  fps: { type: Number, default: null },
  tbr: { type: Number, default: null },
  tbn: { type: Number, default: null },
};
const AudioProbeFields = {
  codec: { type: String, default: null },
  sampleRate: { type: Number, default: null },
  channels: { type: Number, default: null },
  channelLayout: { type: String, default: null },
  format: { type: String, default: null },
  bitrate: { type: Number, default: null },
};

const StreamSessionSchema = new Schema<StreamSessionDoc>(
  {
    _id: { type: String, required: true }, // = channelId = PlaylistChannel._id (deterministic; upsert key)
    channelId: { type: String, required: true },
    capturedAt: { type: Number, required: true },
    video: VideoProbeFields,
    audio: AudioProbeFields,
    container: { type: String, default: null },
  },
  { versionKey: false },
);

// Per-channel lookup is served by the `_id` primary index (one row per channel). This index serves the
// newest-first listing (GET /api/stream-sessions, sorted by capturedAt desc).
StreamSessionSchema.index({ capturedAt: -1 });

export const StreamSession = model<StreamSessionDoc>('StreamSession', StreamSessionSchema);
