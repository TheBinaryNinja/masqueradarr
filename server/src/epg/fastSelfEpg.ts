// fastSelfEpg — the source-agnostic WRITE / LINK / UPSERT half of a FAST source's self-EPG, extracted from
// epg/tubi.ts + epg/dlhd.ts + epg/dami.ts (which were three copies of the same mechanics). It carries NO
// per-source fetch/parse logic: a source's epg/<id>.ts produces already-mapped EpgChannel/Program docs (Samsung
// reuses the shared XMLTV mappers; an inline-program source builds them with a tiny mapper) and calls these.
//
// ⚠️ Same COMPOSITE guide-key convention as every provider (composeGuide.ts): EpgChannel._id and
// Program.channelId are "<source>:<channelId>", joined to a PlaylistChannel by `${epg}:${tvg_id}`. The
// EpgSource.source field is the sync DISCRIMINATOR (== sourceId here); EpgSource.id is the composite-key
// namespace (also sourceId). See schemas.md §3.4/§3.5.

import { EpgSource } from '../models/EpgSource.js';
import { EpgChannel, type EpgChannelDoc } from '../models/EpgChannel.js';
import { Program, type ProgramDoc } from '../models/Program.js';
import { PlaylistChannel } from '../models/PlaylistChannel.js';

/**
 * Per-source REPLACE of the guide stores (epgchannels + programs, both scoped by `source`) from already-mapped
 * docs. Returns the new counts PLUS the distinct bare channelIds present (the playlist hook self-links those via
 * linkFastSelfEpg). The same pattern Gracenote / EPG-PW / tubi / dlhd / dami use.
 */
export async function writeFastEpg(
  sourceId: string,
  channelDocs: EpgChannelDoc[],
  programDocs: ProgramDoc[],
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  await EpgChannel.deleteMany({ source: sourceId });
  if (channelDocs.length) await EpgChannel.insertMany(channelDocs, { ordered: false });

  await Program.deleteMany({ source: sourceId });
  if (programDocs.length) await Program.insertMany(programDocs, { ordered: false });

  const channelIds = [...new Set(channelDocs.map((c) => c.channelId))];
  return { channels: channelDocs.length, programs: programDocs.length, channelIds };
}

/**
 * Self-link a source's still-UNTOUCHED PlaylistChannels onto its own guide (FILL-ONLY-IF-UNTOUCHED — generalized
 * from dlhd/dami's afterSync). The filter requires epg == null AND epgState == null, so a user link/unlink (or a
 * crosswalk that already claimed the row) is never overwritten. Returns the number of channels linked.
 */
export async function linkFastSelfEpg(sourceId: string, channelIds: string[]): Promise<number> {
  const ops = channelIds.map((cid) => ({
    updateOne: {
      filter: { _id: `${sourceId}:${cid}`, source: sourceId, epg: null, epgState: null },
      update: { $set: { tvg_id: cid, epg: sourceId, epgState: 'matched' as const } },
    },
  }));
  if (!ops.length) return 0;
  const res = await PlaylistChannel.bulkWrite(ops, { ordered: false });
  return res.modifiedCount ?? 0;
}

/**
 * Create-or-update the self-EPG EpgSource row so the EPG source appears (and its counts refresh) whenever the
 * playlist syncs. Refreshed fields → $set; user-owned/lifetime fields → $setOnInsert (a user's schedule + the
 * counters survive a re-sync). `source` == `id` == sourceId (the dispatch discriminator + composite namespace);
 * builtin is FALSE (same EPG-Sources capabilities as any source) and playlistBinding is TRUE (created by the
 * playlist's afterSync — the UI hides redundant sync/schedule controls). Mirrors upsert{Tubi,Dlhd,Dami}EpgSource.
 */
export async function upsertFastEpgSource(
  sourceId: string,
  counts: { channels: number; programs: number },
  meta: { name: string; url: string },
): Promise<void> {
  await EpgSource.updateOne(
    { id: sourceId },
    {
      $set: {
        name: meta.name,
        url: meta.url,
        source: sourceId, // sync discriminator + the SOURCE chip; the (separate) id is the composite namespace
        channels: counts.channels,
        programs: counts.programs,
        lastSync: new Date().toISOString(),
        status: 'good',
        builtin: false,
        playlistBinding: true,
      },
      $setOnInsert: {
        auto: false,
        interval: 'manual',
        syncSuccessCount: 1,
        syncFailCount: 0,
        lastXmlAt: null,
        xmlGeneratedCount: 0,
        xmlFailCount: 0,
      },
    },
    { upsert: true },
  );
}
