// Vidaa Free TV self-EPG — builds the 'vidaa' guide from the OVP's SEPARATE /epg/grid schedule fetch, then hands
// ALREADY-MAPPED docs to fastSelfEpg's writer (like vizio/samsung/lg). Unlike tubi/lg (programs inline in the
// catalog), Vidaa's guide is a second fetch keyed off the catalog — chunked by 50 BARE station uids PER GEO (the
// grid is keyed by the bare uid, not the geo-qualified channel id). A reverse (geo, bare-uid) → qualified-channelId
// map joins each grid entry back to its catalog channel (the FastChannels vidaa.py insight). The grid URL is built
// from the bootstrapped backend (BOURL + tenant), so this module bootstraps once per build.
//
// ⚠️ Composite guide-key convention (composeGuide.ts): EpgChannel._id / Program.channelId are "vidaa:<chId>" where
// <chId> is the GEO-QUALIFIED id ('US:<uid>'), joined to a PlaylistChannel by `${epg}:${tvg_id}`. linkFastSelfEpg
// sets tvg_id=<chId>, so each guide channel matches its PlaylistChannel _id "vidaa:US:<uid>".
//
// Guide-richness note: program artwork (poster) + season/seriesId/episodeTitle are DROPPED/null (the Program model
// has no artwork slot, and Vidaa exposes no clean series id) — the same snapshot-size posture as tubi/samsung/vizio/
// lg. Enriching it is a future uplift and must not fork the shared writer.

import { writeFastEpg } from './fastSelfEpg.js';
import { logger } from '../sources/core/logger.js';
import {
  EPG_CHUNK_SIZE,
  EPG_HOURS,
  bootstrap,
  fetchVidaaRows,
  gridUrl,
  isSurfacedRow,
  splitQualifiedChannelId,
  stationHeaders,
  type VidaaRow,
} from '../sources/adapters/vidaa/config.js';
import type { EpgChannelDoc } from '../models/EpgChannel.js';
import type { ProgramDoc } from '../models/Program.js';

export const VIDAA_EPG_NAME = 'Vidaa Free TV Schedule';
export const VIDAA_EPG_URL = 'https://vtvapp-ovp.vidaahub.com/catalogue-search';

const SOURCE_ID = 'vidaa';

const US_TV_RATINGS = new Set(['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA']);
const MPAA_RATINGS = new Set(['G', 'PG', 'PG-13', 'R', 'NC-17']);

// ── grid fetch helpers ────────────────────────────────────────────────────────

/** ISO instant at minute precision + 'Z' (the format the OVP's startTime/endTime want, e.g. 2026-06-27T03:27Z). */
function gridTime(offsetHours: number): string {
  return `${new Date(Date.now() + offsetHours * 3600_000).toISOString().slice(0, 16)}Z`;
}

// ── event → ProgramDoc helpers ─────────────────────────────────────────────────

/** An event's genre from taxonomyTerms.genres (first value); else null (the channel category is the fallback). */
function eventGenre(event: any): string | null {
  const tax = event?.taxonomyTerms;
  if (tax && typeof tax === 'object') {
    const genres = Object.values((tax.genres as Record<string, string>) || {});
    if (genres.length) return String(genres[0]);
  }
  return null;
}

/** An event's rating from parentalRatings, filtered to known US-TV/MPAA codes; else null. */
function eventRating(event: any): string | null {
  for (const r of (event?.parentalRatings as any[]) || []) {
    const val = String(r?.rating ?? '')
      .toUpperCase()
      .replace('TVG', 'TV-G');
    if (US_TV_RATINGS.has(val) || MPAA_RATINGS.has(val)) return val;
  }
  return null;
}

/**
 * Map one grid entry's events to Program docs, keyed by the COMPOSITE channelId. `qualifiedChannelId` is the
 * catalog channel this station maps to; `info` carries its number/category/rating for the program rows. Events
 * with unparseable / zero-length times are skipped; a Korean `<N>` episode suffix is split off the title.
 */
function parseEvents(
  events: any[],
  qualifiedChannelId: string,
  offset: string,
  info: { number: string | null; category: string; rating: string | null },
): ProgramDoc[] {
  const docs: ProgramDoc[] = [];
  for (const event of events || []) {
    let title = String(event?.title ?? '').trim();
    const start = Date.parse(String(event?.startTime));
    const end = Date.parse(String(event?.endTime));
    if (!title || Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;

    // Korean EPG encodes the episode number as a trailing <N>; split it off the displayed title.
    let episode: string | null = null;
    const ep = /\s*<(\d+)>\s*$/.exec(title);
    if (ep) {
      episode = ep[1];
      title = title.slice(0, ep.index).trim();
    }

    const related = (event?.relations?.['event-related-asset'] as any[])?.[0] || {};
    const desc = String(related?.longDescription ?? '').trim() || null;

    docs.push({
      channelId: `${SOURCE_ID}:${qualifiedChannelId}`,
      start,
      end,
      offset,
      title: title || 'Unknown',
      cat: eventGenre(event) || info.category,
      source: SOURCE_ID,
      callSign: null,
      channelNo: info.number,
      shortDesc: desc,
      rating: eventRating(event) || info.rating,
      seriesId: null, // Vidaa exposes no clean series id — not fabricated
      season: null,
      episode,
      episodeTitle: null,
    });
  }
  return docs;
}

// ── build + sync ────────────────────────────────────────────────────────────────

/**
 * Build the mapped guide docs from a set of catalog rows (the adapter's afterSync passes its already-fetched `raw`;
 * the standalone sync fetches them live). Bootstraps the backend, then for each geo chunks the bare station uids by
 * EPG_CHUNK_SIZE and fetches the grid (a failed chunk is logged + skipped). Returns merged EpgChannel + Program
 * docs for a single per-source REPLACE.
 */
export async function buildVidaaEpg(
  rows: VidaaRow[],
  offset: string,
): Promise<{ channelDocs: EpgChannelDoc[]; programDocs: ProgramDoc[] }> {
  const surfaced = rows.filter(isSurfacedRow);

  // Guide channels + the reverse (geo → bare-uid → qualified-channelId) map + per-channel program metadata.
  const channelDocs: EpgChannelDoc[] = [];
  const byGeo = new Map<string, Map<string, string>>();
  const info = new Map<string, { number: string | null; category: string; rating: string | null }>();
  for (const r of surfaced) {
    const number = r.number != null ? String(r.number) : null;
    channelDocs.push({
      _id: `${SOURCE_ID}:${r.channelId}`,
      callSign: null,
      affiliateName: r.name,
      channelId: r.channelId,
      channelNo: number,
      source: SOURCE_ID,
    });
    info.set(r.channelId, { number, category: r.category || 'Live TV', rating: r.rating });
    const { geo, uid } = splitQualifiedChannelId(r.channelId);
    if (!uid) continue;
    if (!byGeo.has(geo)) byGeo.set(geo, new Map());
    byGeo.get(geo)!.set(uid, r.channelId);
  }

  if (!surfaced.length) return { channelDocs, programDocs: [] };

  const { boUrl, tenant } = await bootstrap();
  const startTime = gridTime(0);
  const endTime = gridTime(EPG_HOURS);

  const programDocs: ProgramDoc[] = [];
  for (const [geo, stationMap] of byGeo) {
    const uids = [...stationMap.keys()];
    for (let i = 0; i < uids.length; i += EPG_CHUNK_SIZE) {
      const chunk = uids.slice(i, i + EPG_CHUNK_SIZE);
      try {
        const res = await fetch(gridUrl(boUrl, tenant, chunk, startTime, endTime), {
          headers: stationHeaders(geo),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const entries = (await res.json()) as any[];
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          const qualified = stationMap.get(String(entry?.uid));
          if (!qualified) continue;
          const ch = info.get(qualified);
          if (!ch) continue;
          programDocs.push(...parseEvents(entry?.events, qualified, offset, ch));
        }
      } catch (err) {
        logger.warn('epg', `[${SOURCE_ID}] grid chunk ${i}-${i + chunk.length} geo=${geo} failed: ${(err as Error).message}`);
      }
    }
  }

  return { channelDocs, programDocs };
}

/**
 * Standalone EPG sync (the EPG Sources "Sync" button + scheduler path, dispatched from syncEpgSource on
 * src.source === 'vidaa'). Fetches the catalog LIVE-ONLY (no snapshot fallback: a transient outage should fail
 * loudly → status 'error' → the existing guide is preserved) and per-source replaces the guide. EPG-ONLY: never
 * touches the vidaa playlist or its channel links (that direction is the playlist sync's afterSync hook).
 */
export async function syncVidaaEpg(
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const rows = await fetchVidaaRows();
  const { channelDocs, programDocs } = await buildVidaaEpg(rows, offset);
  return writeFastEpg(sourceId, channelDocs, programDocs);
}
