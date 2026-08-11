import { Schema, model } from 'mongoose';

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
  // Failover group (operator-configured): one 'parent' + ordered 'child' backups per failoverGroupId.
  // Children mirror the parent's EPG identity, are hidden from exports, and serve as ordered play-time
  // fallbacks. OPTIONAL — docs from upgraded DBs / restored backups lack the fields entirely (treat
  // undefined as null). Settable ONLY via the /failover-groups routes, never the generic edit whitelist.
  failoverGroupId?: string | null; // opaque shared key (crypto.randomUUID()); null = ungrouped. Stable across parent swaps.
  failoverRole?: 'parent' | 'child' | null; // exactly one parent per group (route-enforced, no unique index)
  failoverOrder?: number | null; // child ordinal 0..N-1; null on parent/ungrouped. Gaps harmless (resolution sorts).
  // Pre-failover snapshot of this channel's OWN tvg_id (EPG link factor 1). Captured write-once the first
  // time the channel joins a group (parent or child, via the /failover-groups routes); restored to tvg_id
  // and REMOVED when the channel leaves the group. ABSENT = never grouped (the write-once sentinel) —
  // distinct from a stored null (its original tvg_id was unlinked). Never in a $set/$setOnInsert bucket,
  // so it rides re-sync untouched. See services/failover.ts failoverDisbandUpdate for the restore.
  origTvgId?: string | null;
  // Operator's preferred upstream "player" for sources that expose several (adapter.playerSelectable — dlhd's
  // DaddyLive Player 1..N). 1-based; null/absent = inherit the source-wide default (Settings.dlhdPlayer). Read at
  // resolve time by the seam (buildGrant) and honored+failed-over by the adapter's resolveStream. OPTIONAL — older
  // docs lack it (treat undefined as null). $setOnInsert-only, like the failover fields, so it survives re-sync.
  playerPref?: number | null;
  // Operator-assigned custom tag ids (opaque Tag.id references; see models/Tag.ts). $setOnInsert-only, like
  // the failover/playerPref fields, so it survives re-sync. OPTIONAL — older docs lack it (treat undefined
  // as []). Set via PUT /api/playlists/:id/channels/:channelId; a tag delete `$pull`s its id here.
  tags?: string[];
  stream: {
    initials: string | null;
    isPlayable: boolean;
    res: string | null;
    status: string | null; // realtime: 'live'|'establishing'|'buffer'|'failed'|null
    // Probed container: 'ts' | 'fmp4' | null (unknown / never probed). Written by the channel-probe sweep from
    // the sidecar's manifest inspection (#EXT-X-MAP ⇒ fmp4, else #EXTINF ⇒ ts). Persisted because container
    // decides real delivery capability — raw-TS output and any future concatenating path can serve `ts` and
    // must fall back for `fmp4` — so it needs to be answerable per channel WITHOUT re-probing the fleet.
    container: string | null;
    probe: unknown; // VESTIGIAL: was the deep decode/technical-details snapshot; always null after the video-engine
    //                teardown (nothing writes it). Kept as a nullable slot to repurpose when playback is rebuilt.
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
    failoverGroupId: { type: String, default: null },
    failoverRole: { type: String, default: null }, // 'parent' | 'child' | null
    failoverOrder: { type: Number, default: null },
    // Pre-failover tvg_id snapshot (see the interface). Intentionally NO `default`: the field must be
    // ABSENT until captured so `$type:'missing'` / `=== undefined` reliably means "never snapshotted".
    origTvgId: { type: String },
    playerPref: { type: Number, default: null }, // preferred upstream player (1-based) for playerSelectable sources; null = inherit source default
    // Operator-assigned custom tag ids (Tag.id references). $setOnInsert-only (survives re-sync), like failover/playerPref.
    tags: { type: [String], default: [] },
    // Nested object (not a subdocument) → Mongoose adds no `stream._id`.
    stream: {
      initials: { type: String, default: null },
      isPlayable: { type: Boolean, required: true },
      res: { type: String, default: null },
      status: { type: String, default: null },
      container: { type: String, default: null }, // 'ts' | 'fmp4' | null — see the interface
      // Channel-probe decode-metadata snapshot (latest); null until first probed. Whole object is $set by the proxy
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
// Failover group member fetch + reconcile. Partial: keeps the ungrouped null-majority out of the index
// ($type:'string' excludes both null and missing).
PlaylistChannelSchema.index(
  { source: 1, failoverGroupId: 1 },
  { partialFilterExpression: { failoverGroupId: { $type: 'string' } } },
);
// Resolve-time reverse lookup (buildGrant attempt>=1) + statsHub/probeAll streamEntryUrl matches.
// Leads with streamEntryUrl because the $or lookup pattern ({origin} arm) carries no `source`.
PlaylistChannelSchema.index({ streamEntryUrl: 1, source: 1 });

export const PlaylistChannel = model<PlaylistChannelDoc>('PlaylistChannel', PlaylistChannelSchema);
