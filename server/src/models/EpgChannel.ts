// EPG channel store — one row per channel an EPG source publishes (today: EPG-PW). Distinct from the
// streaming `playlistchannels` store: these are the guide's channels, the things programs hang off of.
// `_id` is the deterministic "<sourceId>:<channelId>" so a re-sync upserts instead of duplicating, and a
// per-source replace (deleteMany({source}) + insertMany) is scoped by `source`. Fields the upstream has no
// equivalent for are stored explicit null — never fabricated. NOT surfaced to any screen today. See
// schemas.md (epgchannels) + epg/toEpgChannel.ts.

import { Schema, model } from 'mongoose';

export interface EpgChannelDoc {
  _id: string;                 // "<sourceId>:<channelId>"
  callSign: string | null;
  affiliateName: string;
  channelId: string;           // the upstream channel id (string)
  channelNo: string | null;
  source: string;              // owning EPG source id
}

const EpgChannelSchema = new Schema<EpgChannelDoc>(
  {
    _id: { type: String, required: true },
    callSign: { type: String, default: null },
    affiliateName: { type: String, required: true },
    channelId: { type: String, required: true },
    channelNo: { type: String, default: null },
    source: { type: String, required: true },
  },
  { versionKey: false },
);

// Scopes the per-EPG-source channel replace/listing (deleteMany({ source }) + insertMany).
EpgChannelSchema.index({ source: 1 });

export const EpgChannel = model<EpgChannelDoc>('EpgChannel', EpgChannelSchema);
