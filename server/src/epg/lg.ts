// LG Channels self-EPG — builds the 'lg' guide from the SAME schedulelist payload the catalog comes from (LG
// bundles each channel's programs[] inline, the Tubi shape), then hands ALREADY-MAPPED docs to fastSelfEpg's
// writer (like samsung/vizio). So unlike tubi (which kept its bespoke writeTubiEpg) this module carries only the
// LG-specific map and reuses the shared write/link/upsert half — no extra fetch on the playlist-sync path: the
// adapter's afterSync passes its already-fetched `raw` rows straight to buildLgEpg.
//
// ⚠️ Composite guide-key convention (composeGuide.ts): EpgChannel._id / Program.channelId are "lg:<chId>",
// joined to a PlaylistChannel by `${epg}:${tvg_id}`. linkFastSelfEpg sets tvg_id=<chId>, so each guide channel
// matches its PlaylistChannel _id "lg:<chId>".
//
// Guide-richness note: program artwork + season/episode/seriesId are DROPPED (LG exposes no clean series/episode
// ids; the Program model has no artwork slot) — stored explicit null, never fabricated. The same thinner-guide
// posture as tubi/samsung/vizio; enriching it is a future uplift and must not fork the shared writer.

import { writeFastEpg } from './fastSelfEpg.js';
import { fetchLgRows, type LgRow } from '../sources/adapters/lg/config.js';
import type { EpgChannelDoc } from '../models/EpgChannel.js';
import type { ProgramDoc } from '../models/Program.js';

export const LG_EPG_NAME = 'LG Channels Schedule';
export const LG_EPG_URL = 'https://api.lgchannels.com/api/v1.0/schedulelist';

const SOURCE_ID = 'lg';

// ISO 8601 (LG's startDateTime/endDateTime, e.g. "2026-06-27T02:00:00Z") → epoch ms, or NaN when unparseable
// (that airing is then skipped: Program.start/end are required numbers).
function toEpoch(iso: unknown): number {
  return Date.parse(String(iso));
}

/**
 * Build the mapped guide docs from a set of catalog rows (the adapter's afterSync passes its already-fetched
 * `raw`; the standalone sync fetches them live). Each row carries its inline programs[]; the program category
 * follows FastChannels' precedence (primary genre → channel genre → channel category), with the secondary genre
 * ';'-appended. Returns merged EpgChannel + Program docs for a single per-source REPLACE.
 */
export function buildLgEpg(
  rows: LgRow[],
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

      const base = p.genre || row.genre || row.category || 'Live TV';
      const cat = p.genre2 && p.genre2 !== base ? `${base};${p.genre2}` : base;

      programDocs.push({
        channelId: compositeId,
        start,
        end,
        offset,
        title: p.title || 'Unknown',
        cat,
        source: SOURCE_ID,
        callSign: null,
        channelNo: number,
        shortDesc: p.desc,
        rating: p.rating,
        seriesId: null, // LG's programId is a program-instance id, not a clean series id — not fabricated
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
 * src.source === 'lg'). Fetches the schedulelist LIVE-ONLY (no snapshot fallback: a transient outage should fail
 * loudly → status 'error' → the existing guide is preserved) and per-source replaces the guide. EPG-ONLY: never
 * touches the lg playlist or its channel links (that direction is the playlist sync's afterSync hook).
 */
export async function syncLgEpg(
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const rows = await fetchLgRows();
  const { channelDocs, programDocs } = buildLgEpg(rows, offset);
  return writeFastEpg(sourceId, channelDocs, programDocs);
}
