import { Schema, model } from 'mongoose';
import type { StreamProbe } from './StreamSession.js';

// PlaylistChannel — the editable, UI-facing channel store. One doc per channel, seeded FROM the pristine
// SourceChannel reference at provisioning/sync time via sources/toPlaylistChannel.ts, then editable by the
// operator (Read + Update; no HTTP create/delete). It is 1:1 with the runtime `Channel` interface
// (src/data.ts) — the read path returns these docs verbatim (no projection). Deterministic string `_id`
// ("<source>:<sourceChannelId>") matches the source doc so seed/sync upserts idempotently and the merge can
// preserve user edits by key. Channels associate to a (Default) playlist by `source` (playlist id === source).
//
// `status` is the enable/disable governor ('Active'|'Disabled' — governs m3u inclusion). The nested `stream`
// holds volatile per-channel detail that doesn't affect availability: realtime `status`, `isPlayable`, `res`,
// and the `initials` logo fallback. (History: this collection was previously a dormant {playlistId, channelId,
// order} join against the removed `channels` collection — fully repurposed here.)

export interface PlaylistChannelDoc {
  _id: string; // "<source>:<sourceChannelId>" — deterministic, == sourcechannels._id
  id: string; // runtime mirror of _id
  tvg_name: string;
  group: string | null;
  channel: number | null; // no source equivalent
  channelNo: string | null; // displayed channel number (user-editable); the legacy numeric `channel` is unused for display
  tvg_id: string | null; // EPG link factor 1: the bare upstream channel id (= epgchannels.channelId)
  epg: string | null; // EPG link factor 2: owning EPG source id (= epgchannels.source); null = unlinked.
  //                    Together (tvg_id, epg) map 1:1 to one epgchannels doc (_id = "<source>:<channelId>").
  epgState: 'matched' | 'unmatched' | null; // EPG match status — the visual/programmatic "already matched?"
  //                    indicator; DISTINCT from the (tvg_id, epg) link factors. null at seed (unmatched-by-absence).
  status: string; // 'Active' | 'Disabled' — enable/disable governor (m3u inclusion)
  source: string;
  origin: string | null; // upstream PROVIDER source for a clone copy (e.g. "dulo"); null for source-playlist
  //                        channels (where the proxy source IS `source`). The stream URL is built from
  //                        (origin ?? source) so a clone — whose `source` is its own clone id — still routes
  //                        through the real adapter at /api/v1/<origin>/…. See .claude/skills/m3u/SKILL.md.
  logoColor: string;
  logoUrl: string | null;
  streamEntryUrl: string;
  stream: {
    initials: string | null;
    isPlayable: boolean;
    res: string | null;
    status: string | null; // realtime: 'live'|'establishing'|'buffer'|'failed'|null
    probe: StreamProbe | null; // ffprobe-derived technical details — latest snapshot; null until first probed
  };
}

const PlaylistChannelSchema = new Schema<PlaylistChannelDoc>(
  {
    _id: { type: String, required: true },
    id: { type: String, required: true },
    tvg_name: { type: String, required: true },
    group: { type: String, default: null },
    channel: { type: Number, default: null },
    channelNo: { type: String, default: null },
    tvg_id: { type: String, default: null },
    epg: { type: String, default: null },
    epgState: { type: String, default: null }, // 'matched' | 'unmatched' | null — match-status indicator (distinct from the link factors)
    status: { type: String, required: true },
    source: { type: String, required: true },
    origin: { type: String, default: null }, // clone-copy provider source; null for source-playlist channels
    logoColor: { type: String, required: true },
    logoUrl: { type: String, default: null },
    streamEntryUrl: { type: String, required: true },
    // Nested object (not a subdocument) → Mongoose adds no `stream._id`.
    stream: {
      initials: { type: String, default: null },
      isPlayable: { type: Boolean, required: true },
      res: { type: String, default: null },
      status: { type: String, default: null },
      // ffprobe StreamProbe snapshot (latest); null until first probed. Whole object is $set by the proxy
      // probe sink (routes/sources.ts), never mutated in place — Mixed is safe here.
      probe: { type: Schema.Types.Mixed, default: null },
    },
  },
  { versionKey: false },
);

// Covers the per-source grouped/ordered UI listing query (source → group → tvg_name).
PlaylistChannelSchema.index({ source: 1, group: 1, tvg_name: 1 });
// Active/Disabled filtering per source (m3u build / dead-channel filtering).
PlaylistChannelSchema.index({ source: 1, status: 1 });

export const PlaylistChannel = model<PlaylistChannelDoc>('PlaylistChannel', PlaylistChannelSchema);
