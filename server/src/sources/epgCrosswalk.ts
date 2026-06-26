// Shared "committed EPG crosswalk" applier for resolve-on-demand sources (dulo, dlhd). After a sync
// populates the channels, a source can carry an offline crosswalk file (seed-data/<id>-playlist-addon.json,
// rows of { id, tvg_id, epg, confidence }) that links each channel onto an EXISTING external Gracenote EPG
// source. This is the ONE place that apply lives — the generic core never branches per source; an adapter
// just calls applyEpgCrosswalk(sourceId, addonFile) from its afterSync hook.
//
// FILL-ONLY-IF-UNTOUCHED: the per-row filter requires epg == null AND epgState == null, so a channel is
// linked exactly once (right after a sync) and a later user edit is NEVER overwritten — a manual link/remap
// sets epg, and an unlink leaves epgState 'unmatched' (not null), so both are skipped. Only HIGH-confidence
// rows auto-apply; medium rows are left for manual review on the Channel Mapping screen. Non-fatal: a
// missing/unreadable crosswalk must not fail a sync that succeeded.
//
// GUARD (the reason this helper exists): a row is staged epgState:'matched' ONLY when its (epg, tvg_id) pair
// resolves to a real epgchannels doc. The link factors map to EpgChannel as epg == EpgChannel.source and
// tvg_id == EpgChannel.channelId, i.e. the deterministic EpgChannel._id is `${epg}:${tvg_id}`. So a row whose
// target EPG source/channel does not exist yet (e.g. the user hasn't added the Gracenote source) is SKIPPED,
// leaving the channel untouched (epg/tvg_id/epgState null → shown unmatched). Because the filter stays
// fill-only-if-untouched, that same row auto-links on a LATER sync once the real source is present — which is
// exactly the intended "link to EXISTING sources" posture, instead of fabricating a match against nothing.

import { readFileSync } from 'node:fs';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import { EpgChannel } from '../models/EpgChannel.js';
import { logger } from './core/logger.js';

type AddonRow = { id: string; tvg_id: string; epg: string; confidence: 'high' | 'medium' };

/** Apply a source's committed gracenote crosswalk onto its just-synced playlistchannels (guarded). */
export async function applyEpgCrosswalk(sourceId: string, addonFile: string): Promise<void> {
  let rows: AddonRow[];
  try {
    const parsed = JSON.parse(readFileSync(addonFile, 'utf8'));
    rows = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logger.warn('seed', `[${sourceId}] EPG crosswalk not applied (unreadable): ${(err as Error).message}`);
    return;
  }

  const candidates = rows.filter((r) => r?.confidence === 'high' && r.id && r.tvg_id && r.epg);
  if (!candidates.length) return;

  // Guard: keep only rows whose (epg, tvg_id) resolves to a real epgchannels doc (deterministic _id). One
  // query — rows whose target EPG source/channel isn't present yet are dropped, not fabricated as matched.
  const wantedIds = candidates.map((r) => `${r.epg}:${r.tvg_id}`);
  const present = new Set(
    (await EpgChannel.find({ _id: { $in: wantedIds } }, { _id: 1 }).lean()).map((d) => d._id),
  );
  const linkable = candidates.filter((r) => present.has(`${r.epg}:${r.tvg_id}`));

  const skipped = candidates.length - linkable.length;
  if (!linkable.length) {
    logger.info(
      'seed',
      `[${sourceId}] EPG crosswalk: linked 0 of ${candidates.length} high-confidence mapping(s) (skipped ${skipped} — target EPG source/channel not present)`,
    );
    return;
  }

  const ops = linkable.map((r) => ({
    updateOne: {
      // Untouched-only: skips user-linked (epg set) AND user-unlinked (epgState 'unmatched') channels.
      filter: { _id: r.id, source: sourceId, epg: null, epgState: null },
      update: { $set: { tvg_id: r.tvg_id, epg: r.epg, epgState: 'matched' as const } },
    },
  }));
  const res = await PlaylistChannel.bulkWrite(ops, { ordered: false });
  logger.info(
    'seed',
    `[${sourceId}] EPG crosswalk: linked ${res.modifiedCount ?? 0} channel(s) of ${candidates.length} high-confidence mapping(s)` +
      (skipped ? ` (skipped ${skipped} — target EPG source/channel not present)` : ''),
  );
}
