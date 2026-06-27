// EPG program (one airing). Flat per-event row keyed by channelId; GET /api/epg-programs groups these
// into the Record<channelId, Program[]> the SPA expects. `start`/`end` are epoch MS (Gracenote ISO
// timestamps are mapped via Date.parse). `source` scopes a provider's rows so a re-sync can replace just
// that provider's programs (deleteMany({source}) + insertMany). The extended Gracenote fields (callSign…
// episodeTitle) are nullable — null when the upstream has no equivalent, never fabricated. See schemas.md §3.5.

import { Schema, model } from 'mongoose';

export interface ProgramDoc {
  channelId: string;
  start: number; // epoch ms (UTC — the absolute instant; always normalized)
  end: number;   // epoch ms (UTC)
  offset: string; // UTC offset ('±HHMM') copied from settings.offset at sync time; for localized display/compose
  title: string;
  cat: string;
  source: string | null;       // owning EPG source id (e.g. 'gracenote:VA45537:USA-VA45537-DEFAULT')
  callSign: string | null;
  channelNo: string | null;
  shortDesc: string | null;
  rating: string | null;
  seriesId: string | null;
  season: string | null;
  episode: string | null;
  episodeTitle: string | null;
  // Added later (U2) — OPTIONAL so the ~22 existing providers need no change; the schema `default: null`
  // backfills them on insert, and the XMLTV serializer's `!= null` guards skip both null and undefined.
  icon?: string | null;            // program artwork/poster URL → XMLTV <icon>; null when the source has none
  originalAirDate?: string | null; // release/air year (or date) → XMLTV <date>; null when unknown
}

const ProgramSchema = new Schema<ProgramDoc>(
  {
    channelId: { type: String, required: true, index: true },
    start: { type: Number, required: true },
    end: { type: Number, required: true },
    offset: { type: String, required: true, default: '+0000' },
    title: { type: String, required: true },
    cat: { type: String, required: true },
    source: { type: String, default: null },
    callSign: { type: String, default: null },
    channelNo: { type: String, default: null },
    shortDesc: { type: String, default: null },
    rating: { type: String, default: null },
    seriesId: { type: String, default: null },
    season: { type: String, default: null },
    episode: { type: String, default: null },
    episodeTitle: { type: String, default: null },
    icon: { type: String, default: null },
    originalAirDate: { type: String, default: null },
  },
  { versionKey: false },
);

// Covers the EPG schedule query (grouped + sorted by start).
ProgramSchema.index({ channelId: 1, start: 1 });
// Scopes per-EPG-source program prune/replace on re-sync (deleteMany({ source })).
ProgramSchema.index({ source: 1 });

export const Program = model<ProgramDoc>('Program', ProgramSchema);
