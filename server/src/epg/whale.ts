// Whale TV+ self-EPG — builds the 'whale' guide from the rlaxx platform's SEPARATE /epg schedule fetch, then
// hands ALREADY-MAPPED docs to fastSelfEpg's writer (like vidaa/vizio/samsung/lg). Unlike lg (programs inline
// in the catalog), Whale's guide is a second fetch keyed off the catalog — chunked by 10 channel ids (the
// FastChannels whale.py batching) over a 7-day window. The /epg `ptList` carries titles + times ONLY (no
// descriptions/ratings/episode metadata), so the ONLY guide description is each channel's now-airing
// `currentProgram`, captured at catalog time and matched back by prgchId (the FastChannels _current_prog_desc
// fallback). The fetch is token-gated, so this module bootstraps a bearer (cached from the catalog call).
//
// ⚠️ Composite guide-key convention (composeGuide.ts): EpgChannel._id / Program.channelId are "whale:<chlId>",
// joined to a PlaylistChannel by `${epg}:${tvg_id}`. linkFastSelfEpg sets tvg_id=<chlId>, so each guide channel
// matches its PlaylistChannel _id "whale:<chlId>".
//
// Guide-richness note: program artwork + ratings + season/episode/seriesId are DROPPED/null — the /epg endpoint
// returns none of them inline, and the FastChannels /epg/detail enrichment (descriptions/posters/episode meta
// for the near-term window, 15 concurrent workers) is NOT ported here (the same thinner-guide posture as
// tubi/samsung/vizio/lg/vidaa). Enriching it is a future uplift and must not fork the shared writer.

import { writeFastEpg } from './fastSelfEpg.js';
import { logger } from '../sources/core/logger.js';
import {
  EPG_BATCH_SIZE,
  EPG_DAYS,
  epgUrl,
  fetchWhaleRows,
  getToken,
  tokenHeaders,
  type WhaleRow,
} from '../sources/adapters/whale/config.js';
import type { EpgChannelDoc } from '../models/EpgChannel.js';
import type { ProgramDoc } from '../models/Program.js';

export const WHALE_EPG_NAME = 'Whale TV+ Schedule';
export const WHALE_EPG_URL = 'https://rlaxx.zeasn.tv/livetv/api/device/browser/v1/epg';

const SOURCE_ID = 'whale';

/** Epoch ms (the /epg `prgStm`/`prgEtm`) → number, or NaN when unparseable (that airing is then skipped). */
function toEpoch(ms: unknown): number {
  const n = Number(ms);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Build the mapped guide docs from a set of catalog rows (the adapter's afterSync passes its already-fetched
 * `raw`; the standalone sync fetches them live). The channel records come straight from the rows; the schedule
 * is a SEPARATE /epg fetch, chunked by EPG_BATCH_SIZE channel ids over a 7-day window (a failed chunk is logged
 * + skipped). Each program's description is the channel's now-airing `currentProgram` matched by prgchId (the
 * only description source). Returns merged EpgChannel + Program docs for a single per-source REPLACE.
 */
export async function buildWhaleEpg(
  rows: WhaleRow[],
  offset: string,
): Promise<{ channelDocs: EpgChannelDoc[]; programDocs: ProgramDoc[] }> {
  // Guide channels + per-channel program metadata + the now-airing description map (prgchId → desc).
  const channelDocs: EpgChannelDoc[] = [];
  const info = new Map<string, { number: string | null; category: string }>();
  const descByPrgch = new Map<string, string>();
  for (const r of rows) {
    const number = r.number != null ? String(r.number) : null;
    channelDocs.push({
      _id: `${SOURCE_ID}:${r.channelId}`,
      callSign: null,
      affiliateName: r.name,
      channelId: r.channelId,
      channelNo: number,
      source: SOURCE_ID,
    });
    info.set(r.channelId, { number, category: r.category || 'Live TV' });
    if (r.currentProgram) descByPrgch.set(r.currentProgram.prgchId, r.currentProgram.desc);
  }

  if (!rows.length) return { channelDocs, programDocs: [] };

  const token = await getToken();
  const ids = rows.map((r) => r.channelId);
  const startMs = Date.now();
  const endMs = startMs + EPG_DAYS * 86_400_000;

  const programDocs: ProgramDoc[] = [];
  for (let i = 0; i < ids.length; i += EPG_BATCH_SIZE) {
    const batch = ids.slice(i, i + EPG_BATCH_SIZE);
    try {
      const res = await fetch(epgUrl(batch, startMs, endMs), { headers: tokenHeaders(token) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as { data?: any[] };
      for (const chRow of payload?.data || []) {
        const chId = String(chRow?.chlId ?? '');
        const ch = info.get(chId);
        if (!ch) continue;
        for (const pt of chRow?.ptList || []) {
          const start = toEpoch(pt?.prgStm);
          const end = toEpoch(pt?.prgEtm);
          if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
          const prgchId = String(pt?.prgchId ?? '');
          programDocs.push({
            channelId: `${SOURCE_ID}:${chId}`,
            start,
            end,
            offset,
            title: String(pt?.prgTitle ?? '').trim() || 'Unknown',
            cat: ch.category,
            source: SOURCE_ID,
            callSign: null,
            channelNo: ch.number,
            shortDesc: descByPrgch.get(prgchId) || null,
            rating: null, // /epg ptList carries no rating — not fabricated
            seriesId: null,
            season: null,
            episode: null,
            episodeTitle: null,
          });
        }
      }
    } catch (err) {
      logger.warn(
        'epg',
        `[${SOURCE_ID}] epg batch ${i}-${i + batch.length} failed: ${(err as Error).message}`,
      );
    }
  }

  return { channelDocs, programDocs };
}

/**
 * Standalone EPG sync (the EPG Sources "Sync" button + scheduler path, dispatched from syncEpgSource on
 * src.source === 'whale'). Fetches the catalog LIVE-ONLY (no snapshot fallback: a transient outage should fail
 * loudly → status 'error' → the existing guide is preserved) and per-source replaces the guide. EPG-ONLY: never
 * touches the whale playlist or its channel links (that direction is the playlist sync's afterSync hook).
 */
export async function syncWhaleEpg(
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const rows = await fetchWhaleRows();
  const { channelDocs, programDocs } = await buildWhaleEpg(rows, offset);
  return writeFastEpg(sourceId, channelDocs, programDocs);
}
