// Xumo Play self-EPG — builds the 'xumo' guide from the Valencia backend's SEPARATE paginated MARKET EPG, then
// hands ALREADY-MAPPED docs to fastSelfEpg's writer (like whale/vidaa/vizio/samsung/lg). Unlike the others, the
// schedule is NOT inline (lg) nor channel-id-batched (whale/vidaa) — it's paginated by market → date → page (a
// ~6-hour time block) → offset (50 channels each). The asset metadata (title/descriptions/episode/genre) rides
// along in each page's `assets` dict, so no per-program asset fetch is needed (resolve-time only). The build's
// early-break logic (HTTP 400 → no more pages; an empty page or offset ≥ totalChannels → no more offsets) prunes
// the nominal 24 pages × 1000 offsets to ~4 pages × ~9 offsets per date. Ported from FastChannels xumo.py fetch_epg.
//
// ⚠️ Composite guide-key convention (composeGuide.ts): EpgChannel._id / Program.channelId are "xumo:<id>", joined
// to a PlaylistChannel by `${epg}:${tvg_id}`. linkFastSelfEpg sets tvg_id=<id>, so each guide channel matches its
// PlaylistChannel _id "xumo:<id>".
//
// Guide-richness note: program artwork is DROPPED (the snapshot-lean posture of tubi/samsung/…); season/episode
// ride along when the asset carries them. The CHANNEL records come from the CATALOG rows (name/number) — the EPG
// page channel rows only carry ids + schedule — so every catalog channel gets a guide channel even if the market
// EPG window has no airing for it yet.

import {
  EPG_MAX_OFFSET,
  EPG_OFFSET_STEP,
  EPG_PAGES_PER_DAY,
  epgDateKeys,
  epgPageUrl,
  parseXumoTime,
  pickAssetDesc,
  pickAssetGenre,
  XUMO_API_HEADERS,
  type XumoRow,
} from '../sources/adapters/xumo/config.js';
import { fetchXumoRows } from '../sources/adapters/xumo/config.js';
import { writeFastEpg } from './fastSelfEpg.js';
import { logger } from '../sources/core/logger.js';
import type { EpgChannelDoc } from '../models/EpgChannel.js';
import type { ProgramDoc } from '../models/Program.js';

export const XUMO_EPG_NAME = 'Xumo Play Schedule';
export const XUMO_EPG_URL = 'https://valencia-app-mds.xumo.com/v2/epg';

const SOURCE_ID = 'xumo';

// Sentinel: an HTTP 400 page means "no data for this hour block" — break BOTH the offset loop and the page loop.
const NO_DATA = Symbol('xumo-epg-no-data');

/** Fetch one EPG page → its JSON, or NO_DATA on HTTP 400, or null on any other transient failure (skip + retry). */
async function fetchEpgPage(dateStr: string, page: number, offset: number): Promise<any | typeof NO_DATA | null> {
  let res: Response;
  try {
    res = await fetch(epgPageUrl(dateStr, page, offset), { headers: XUMO_API_HEADERS });
  } catch {
    return null;
  }
  if (res.status === 400) return NO_DATA;
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Build the mapped guide docs from a set of catalog rows (the adapter's afterSync passes its already-fetched
 * `raw`; the standalone sync fetches them live). Channel records come from the rows; programs come from the
 * paginated market EPG, filtered to the wanted (catalog) channel ids and joined to the per-page asset metadata.
 * Past airings (end ≤ now) and (channel, start, asset) duplicates are dropped. Returns merged EpgChannel +
 * Program docs for a single per-source REPLACE.
 */
export async function buildXumoEpg(
  rows: XumoRow[],
  offset: string,
): Promise<{ channelDocs: EpgChannelDoc[]; programDocs: ProgramDoc[] }> {
  // Guide channels + per-channel metadata (number/category fallback) from the catalog rows.
  const channelDocs: EpgChannelDoc[] = [];
  const info = new Map<string, { number: string | null; category: string }>();
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
  }
  if (!rows.length) return { channelDocs, programDocs: [] };

  const wanted = new Set(rows.map((r) => r.channelId));
  const now = Date.now();
  const programDocs: ProgramDoc[] = [];
  const seen = new Set<string>(); // (channelId|start|assetId) dedupe across pages/dates
  const assetCache = new Map<string, any>(); // assetId → asset metadata, accumulated across pages

  for (const dateStr of epgDateKeys(now)) {
    for (let page = 0; page < EPG_PAGES_PER_DAY; page++) {
      let pageNoData = false;
      let foundAny = false;
      let total = Infinity;

      for (let off = 0; off <= EPG_MAX_OFFSET && off < total; off += EPG_OFFSET_STEP) {
        const payload = await fetchEpgPage(dateStr, page, off);
        if (payload === NO_DATA) {
          pageNoData = true;
          break;
        }
        if (!payload) continue; // transient — try the next offset

        if (Number.isFinite(payload.totalChannels)) total = Number(payload.totalChannels);
        const assets = payload.assets;
        if (assets && typeof assets === 'object') for (const [k, v] of Object.entries(assets)) assetCache.set(k, v);

        const pageChannels: any[] = Array.isArray(payload.channels) ? payload.channels : [];
        if (!pageChannels.length) break; // past the end for this page block
        foundAny = true;

        for (const chRow of pageChannels) {
          const chId = String(chRow?.channelId ?? '');
          if (!wanted.has(chId)) continue;
          const ch = info.get(chId)!;
          for (const slot of chRow?.schedule || []) {
            const assetId = String(slot?.assetId ?? '');
            const start = parseXumoTime(slot?.start);
            const end = parseXumoTime(slot?.end);
            if (!assetId || Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
            if (end <= now) continue; // already aired

            const dedupe = `${chId}|${start}|${assetId}`;
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);

            const asset = assetCache.get(assetId) || {};
            const season = asset?.season;
            const episode = asset?.episode;
            programDocs.push({
              channelId: `${SOURCE_ID}:${chId}`,
              start,
              end,
              offset,
              title: String(asset?.title ?? '').trim() || 'Unknown',
              cat: pickAssetGenre(asset) || ch.category,
              source: SOURCE_ID,
              callSign: null,
              channelNo: ch.number,
              shortDesc: pickAssetDesc(asset),
              rating: null, // EPG page carries no rating — not fabricated
              seriesId: null,
              season: season != null ? String(season) : null,
              episode: episode != null ? String(episode) : null,
              episodeTitle: (() => {
                const t = String(asset?.episodeTitle ?? '').trim();
                return t || null;
              })(),
            });
          }
        }
      }

      if (pageNoData || !foundAny) break; // no more pages for this date
    }
  }

  return { channelDocs, programDocs };
}

/**
 * Standalone EPG sync (the EPG Sources "Sync" button + scheduler path, dispatched from syncEpgSource on
 * src.source === 'xumo'). Fetches the catalog LIVE-ONLY (no snapshot fallback: a transient outage should fail
 * loudly → status 'error' → the existing guide is preserved) and per-source replaces the guide. EPG-ONLY: never
 * touches the xumo playlist or its channel links (that direction is the playlist sync's afterSync hook).
 */
export async function syncXumoEpg(
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const rows = await fetchXumoRows();
  const { channelDocs, programDocs } = await buildXumoEpg(rows, offset);
  logger.info('epg', `[${sourceId}] market EPG built: ${channelDocs.length} channels / ${programDocs.length} programs`);
  return writeFastEpg(sourceId, channelDocs, programDocs);
}
