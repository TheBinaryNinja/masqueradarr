// FreeLiveSports self-EPG — builds the 'freelivesports' guide from the SAME catalog payload the channels come
// from (FreeLiveSports bundles each channel's epg.entries inline, the LG/Tubi shape), then hands ALREADY-MAPPED
// docs to fastSelfEpg's writer (like lg/samsung/vizio). So this module carries only the FLS-specific map and
// reuses the shared write/link/upsert half — no extra fetch on the playlist-sync path: the adapter's afterSync
// passes its already-fetched `raw` rows straight to buildFreeLiveSportsEpg.
//
// ⚠️ Composite guide-key convention (composeGuide.ts): EpgChannel._id / Program.channelId are
// "freelivesports:<chId>", joined to a PlaylistChannel by `${epg}:${tvg_id}`. linkFastSelfEpg sets
// tvg_id=<chId>, so each guide channel matches its PlaylistChannel _id "freelivesports:<chId>".
//
// Guide-richness note: program artwork + rating + season/episode/seriesId are DROPPED/null — the entries carry no
// artwork/rating inline, and the FastChannels title S/E parser is NOT ported (it mostly no-ops for a sports
// source; the same thinner-guide posture as lg/whale/tubi). Enriching it is a future uplift and must not fork the
// shared writer.

import { writeFastEpg } from './fastSelfEpg.js';
import { fetchFlsRows, FLS_GROUP, type FlsRow } from '../sources/adapters/freelivesports/config.js';
import type { EpgChannelDoc } from '../models/EpgChannel.js';
import type { ProgramDoc } from '../models/Program.js';

export const FLS_EPG_NAME = 'FreeLiveSports Schedule';
export const FLS_EPG_URL = 'https://epg.unreel.me/v2/sites/freelivesports/live-channels';

const SOURCE_ID = 'freelivesports';

// ISO 8601 (FreeLiveSports' start/stop, e.g. "2026-06-27T02:20:00.000Z") → epoch ms, or NaN when unparseable
// (that airing is then skipped: Program.start/end are required numbers).
function toEpoch(iso: unknown): number {
  return Date.parse(String(iso));
}

/**
 * Build the mapped guide docs from a set of catalog rows (the adapter's afterSync passes its already-fetched
 * `raw`; the standalone sync fetches them live). Each row carries its inline programs[] (the channel's epg.entries
 * trimmed); the program category is the single "Sports" group. Returns merged EpgChannel + Program docs for a
 * single per-source REPLACE.
 */
export function buildFreeLiveSportsEpg(
  rows: FlsRow[],
  offset: string,
): { channelDocs: EpgChannelDoc[]; programDocs: ProgramDoc[] } {
  const channelDocs: EpgChannelDoc[] = [];
  const programDocs: ProgramDoc[] = [];

  for (const row of rows) {
    const cid = row.channelId;
    const compositeId = `${SOURCE_ID}:${cid}`; // EpgChannel._id == Program.channelId (the composite join key)
    const number = row.number != null ? String(row.number) : null;

    // (A) the guide's channel record — channelId (bare) + source are the 2-factor link targets.
    channelDocs.push({
      _id: compositeId,
      callSign: null,
      affiliateName: row.name,
      channelId: cid,
      channelNo: number,
      source: SOURCE_ID,
    });

    // (B) this channel's schedule — keyed by the COMPOSITE channelId. NaN-timed / zero-length airings are skipped.
    for (const p of row.programs) {
      const start = toEpoch(p.start);
      const end = toEpoch(p.end);
      if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;

      programDocs.push({
        channelId: compositeId,
        start,
        end,
        offset,
        title: p.title || 'Unknown',
        cat: FLS_GROUP,
        source: SOURCE_ID,
        callSign: null,
        channelNo: number,
        shortDesc: p.desc,
        rating: null, // entries carry no rating — not fabricated
        seriesId: null, // FreeLiveSports exposes no clean series/episode ids — not fabricated
        season: null,
        episode: null,
        episodeTitle: null,
      });
    }
  }

  return { channelDocs, programDocs };
}

/**
 * Standalone EPG sync (the EPG Sources "Sync" button + scheduler path, dispatched from syncEpgSource on
 * src.source === 'freelivesports'). Fetches the catalog LIVE-ONLY (no snapshot fallback: a transient outage should
 * fail loudly → status 'error' → the existing guide is preserved) and per-source replaces the guide. EPG-ONLY:
 * never touches the freelivesports playlist or its channel links (that direction is the playlist sync's afterSync
 * hook).
 */
export async function syncFreeLiveSportsEpg(
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const rows = await fetchFlsRows();
  const { channelDocs, programDocs } = buildFreeLiveSportsEpg(rows, offset);
  return writeFastEpg(sourceId, channelDocs, programDocs);
}
