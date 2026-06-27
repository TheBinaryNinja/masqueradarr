// Distro TV self-EPG — builds the 'distro' guide from the jsrdn SEPARATE epg/query.php schedule fetch, then
// hands ALREADY-MAPPED docs to fastSelfEpg's writer (like vidaa/vizio/lg). Unlike freelivesports/lg (programs
// inline in the catalog), Distro's guide is a second fetch keyed off the catalog — chunked by BARE tvg_ids (the
// query.php key, not the geo-qualified channel id). A reverse (bare tvg_id) → qualified-channelId[] map joins each
// query entry back to its catalog channel(s) (the same tvg_id can recur across geos, so it fans out to all). The
// catalog rows are passed in by the adapter's afterSync (already fetched) or fetched live by the standalone sync.
//
// ⚠️ Composite guide-key convention (composeGuide.ts): EpgChannel._id / Program.channelId are "distro:<chId>"
// where <chId> is the GEO-QUALIFIED id ('US:<tvg_id>'), joined to a PlaylistChannel by `${epg}:${tvg_id}`.
// linkFastSelfEpg sets tvg_id=<chId>, so each guide channel matches its PlaylistChannel _id "distro:US:<tvg_id>".
//
// Guide-richness note: program artwork (img_thumbh) is DROPPED (the Program model has no artwork slot) — the same
// snapshot-size posture as vidaa/lg/tubi. The S##E##/"Episode N" title parse + the slot rating ARE kept (Distro
// exposes them cleanly); seriesId stays null (no clean series id). Enriching it is a future uplift and must not
// fork the shared writer.

import { writeFastEpg } from './fastSelfEpg.js';
import { logger } from '../sources/core/logger.js';
import {
  DISTRO_CATALOG_HEADERS,
  EPG_URL,
  decodeEntities,
  fetchDistroRows,
  parseTitle,
  type DistroRow,
} from '../sources/adapters/distro/config.js';
import type { EpgChannelDoc } from '../models/EpgChannel.js';
import type { ProgramDoc } from '../models/Program.js';

export const DISTRO_EPG_NAME = 'Distro TV Schedule';
export const DISTRO_EPG_URL = 'https://tv.jsrdn.com/epg/query.php';

const SOURCE_ID = 'distro';

// How many bare tvg_ids per epg/query.php request (the catalog fits in one call, but chunk for URL-length safety
// across larger multi-geo feeds), and the look-ahead window (the jsrdn `range=now,24h` horizon).
const EPG_CHUNK_SIZE = 100;
const EPG_RANGE = 'now,24h';

/** jsrdn's "YYYY-MM-DD HH:MM:SS" (UTC, naive) → epoch ms. Rewritten to ISO+Z so Date.parse reads it as UTC
 * (a bare space-separated string parses as LOCAL time in V8 — the bug FastChannels avoids with tzinfo=utc). */
function toEpoch(s: unknown): number {
  const raw = String(s ?? '').trim();
  if (!raw) return NaN;
  return Date.parse(`${raw.replace(' ', 'T')}Z`);
}

/**
 * Build the mapped guide docs from a set of catalog rows (the adapter's afterSync passes its already-fetched
 * `raw`; the standalone sync fetches them live). Fetches the schedule from epg/query.php chunked by bare tvg_id
 * (a failed chunk is logged + skipped), fanning each entry's slots out to every qualified channel sharing that
 * tvg_id. Returns merged EpgChannel + Program docs for a single per-source REPLACE.
 */
export async function buildDistroEpg(
  rows: DistroRow[],
  offset: string,
): Promise<{ channelDocs: EpgChannelDoc[]; programDocs: ProgramDoc[] }> {
  // Guide channels + the reverse (bare tvg_id → qualified-channelId[]) map + per-channel category fallback.
  const channelDocs: EpgChannelDoc[] = [];
  const byTvgId = new Map<string, string[]>();
  const category = new Map<string, string>();
  for (const r of rows) {
    channelDocs.push({
      _id: `${SOURCE_ID}:${r.channelId}`,
      callSign: null,
      affiliateName: r.name,
      channelId: r.channelId, // GEO-QUALIFIED — the link target
      channelNo: null, // Distro shows carry no channel number
      source: SOURCE_ID,
    });
    category.set(r.channelId, r.category || 'Live TV');
    if (!byTvgId.has(r.tvgId)) byTvgId.set(r.tvgId, []);
    byTvgId.get(r.tvgId)!.push(r.channelId);
  }

  if (!byTvgId.size) return { channelDocs, programDocs: [] };

  const tvgIds = [...byTvgId.keys()];
  const programDocs: ProgramDoc[] = [];
  for (let i = 0; i < tvgIds.length; i += EPG_CHUNK_SIZE) {
    const chunk = tvgIds.slice(i, i + EPG_CHUNK_SIZE);
    try {
      const url = `${EPG_URL}?id=${encodeURIComponent(chunk.join(','))}&range=${encodeURIComponent(EPG_RANGE)}`;
      const res = await fetch(url, { headers: DISTRO_CATALOG_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const epg = ((await res.json()) as { epg?: Record<string, any> })?.epg || {};
      for (const [tvgId, chEpg] of Object.entries(epg)) {
        const targets = byTvgId.get(tvgId);
        if (!targets) continue;
        for (const slot of (chEpg?.slots as any[]) || []) {
          const start = toEpoch(slot?.start);
          const end = toEpoch(slot?.end);
          if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
          const { title, season, episode, episodeTitle } = parseTitle(slot?.title);
          const desc = decodeEntities(String(slot?.description ?? '').trim()) || null;
          const rating = String(slot?.rating ?? '').trim() || null;
          for (const channelId of targets) {
            programDocs.push({
              channelId: `${SOURCE_ID}:${channelId}`,
              start,
              end,
              offset,
              title: title || 'Unknown',
              cat: category.get(channelId) || 'Live TV',
              source: SOURCE_ID,
              callSign: null,
              channelNo: null,
              shortDesc: desc,
              rating,
              seriesId: null, // Distro exposes no clean series id — not fabricated
              season,
              episode,
              episodeTitle,
            });
          }
        }
      }
    } catch (err) {
      logger.warn('epg', `[${SOURCE_ID}] query chunk ${i}-${i + chunk.length} failed: ${(err as Error).message}`);
    }
  }

  return { channelDocs, programDocs };
}

/**
 * Standalone EPG sync (the EPG Sources "Sync" button + scheduler path, dispatched from syncEpgSource on
 * src.source === 'distro'). Fetches the catalog LIVE-ONLY (no snapshot fallback: a transient outage should fail
 * loudly → status 'error' → the existing guide is preserved) and per-source replaces the guide. EPG-ONLY: never
 * touches the distro playlist or its channel links (that direction is the playlist sync's afterSync hook).
 */
export async function syncDistroEpg(
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const rows = await fetchDistroRows();
  const { channelDocs, programDocs } = await buildDistroEpg(rows, offset);
  return writeFastEpg(sourceId, channelDocs, programDocs);
}
