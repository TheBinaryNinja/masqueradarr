// EPG source registration. The display fields (name/url/channels/programs/lastSync/status/auto/interval)
// drive the EPG Sources list + detail screens; the Gracenote provenance fields (source/location/
// lineup_Type/postalCode/aid + headendId/lineupId/country/device/timezone/languagecode) capture the
// provider a Gracenote source was created from so its grid URL can be rebuilt and re-synced. The
// provenance fields are nullable (legacy/mock rows have none). The sync counters (syncSuccessCount /
// syncFailCount) are maintained by the single shared sync path (epg/syncEpgSource.ts) so both the
// on-demand POST sync and the scheduler tick increment them. See restapi.md + schemas.md §3.4.

import { Schema, model } from 'mongoose';

export interface EpgSourceDoc {
  id: string;
  name: string;
  url: string;
  channels: number;
  programs: number;
  lastSync: string;
  status: string;
  auto: boolean;
  interval: string;
  builtin?: boolean;
  // true ⇒ this EPG source was created by a playlist's afterSync automation (the tubi/dlhd/dami self-EPG rows),
  // not added by a user. Bound rows hide manual sync + schedule controls in the UI (the playlist owns the
  // refresh cadence). Set in the $set block of upsert{Tubi,Dlhd,Dami}EpgSource so it is re-asserted on every sync.
  playlistBinding: boolean;
  // User-defined list position (the EPG Sources screen's drag-to-reorder ordinal). Persisted so the order
  // survives reloads; GET /api/epg-sources sorts by it (ascending) with `name` as the stable tiebreaker.
  // PUT /api/epg-sources/reorder rewrites it from the new id sequence. Legacy/pre-field rows default to 0
  // (a boot normalize seeds a stable initial ordinal so the very first drag has a sane baseline). See schemas.md §3.4.
  order: number;
  // Lifetime sync outcome counters ($inc'd by syncEpgSource on success/failure).
  syncSuccessCount: number;
  syncFailCount: number;
  // EPG-XML generation run stats (persisted; the XMLTV generation job is deferred, so these stay at the
  // defaults until it lands — same payload-riding pattern as the sync counters). See schemas.md §3.4.
  lastXmlAt: string | null;
  xmlGeneratedCount: number;
  xmlFailCount: number;
  // Gracenote provenance (null for non-Gracenote / legacy rows).
  source: string | null;        // lowercase kind discriminator: 'gracenote' | 'epg-pw' | 'jesmann' | 'tubi' | 'dlhd' | 'dami' | 'local' | 'xml file' | 'remote url'
  location: string | null;
  lineup_Type: string | null;   // provider.type: 'OTA' | 'CABLE' | 'SATELLITE'
  postalCode: string | null;
  aid: string | null;
  headendId: string | null;
  lineupId: string | null;
  country: string | null;
  device: string | null;
  timezone: string | null;
  languagecode: string | null;
}

const EpgSourceSchema = new Schema<EpgSourceDoc>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    url: { type: String, required: true },
    channels: { type: Number, required: true },
    programs: { type: Number, required: true },
    lastSync: { type: String, required: true },
    status: { type: String, required: true },
    auto: { type: Boolean, required: true },
    interval: { type: String, required: true },
    builtin: { type: Boolean },
    // Set true by the tubi/dlhd/dami self-EPG upserts (playlist afterSync); gates the UI's sync/schedule controls.
    playlistBinding: { type: Boolean, required: true, default: false },
    // List position for the drag-to-reorder UI; GET sorts by { order: 1, name: 1 }.
    order: { type: Number, required: true, default: 0 },
    syncSuccessCount: { type: Number, required: true, default: 0 },
    syncFailCount: { type: Number, required: true, default: 0 },
    lastXmlAt: { type: String, default: null },
    xmlGeneratedCount: { type: Number, required: true, default: 0 },
    xmlFailCount: { type: Number, required: true, default: 0 },
    source: { type: String, default: null },
    location: { type: String, default: null },
    lineup_Type: { type: String, default: null },
    postalCode: { type: String, default: null },
    aid: { type: String, default: null },
    headendId: { type: String, default: null },
    lineupId: { type: String, default: null },
    country: { type: String, default: null },
    device: { type: String, default: null },
    timezone: { type: String, default: null },
    languagecode: { type: String, default: null },
  },
  { versionKey: false },
);

export const EpgSource = model<EpgSourceDoc>('EpgSource', EpgSourceSchema);
