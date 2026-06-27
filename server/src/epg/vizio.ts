// Vizio WatchFree+ self-EPG — builds the 'vizio' guide from the WatchFree+ /api/airings schedule grid, then
// hands ALREADY-MAPPED docs to fastSelfEpg's writer. Unlike tubi (programs embedded in the catalog) and samsung
// (a per-region XMLTV file), Vizio's guide is a SEPARATE airings fetch keyed off the catalog: a single BULK call
// (startChannel = first channel, channelCount = all) returns ~a day of programs across the whole lineup, with a
// per-channel fallback if the bulk call comes back empty. An airing's `stationId` joins to the catalog row's
// `airingsKey` (NOT its channelId) — so we build a reverse station→channel map first (the FastChannels insight).
//
// ⚠️ Composite guide-key convention (composeGuide.ts): EpgChannel._id / Program.channelId are "vizio:<chId>",
// joined to a PlaylistChannel by `${epg}:${tvg_id}`. linkFastSelfEpg sets tvg_id=<chId>, so each guide channel
// matches its PlaylistChannel _id "vizio:<chId>".
//
// Guide-richness note: program artwork (airingIcon) + program_type are DROPPED (the Program model has no slot —
// the same snapshot-size posture as tubi/samsung). Enriching that is a future uplift and must not be forked here.

import { writeFastEpg } from './fastSelfEpg.js';
import { logger } from '../sources/core/logger.js';
import {
  AIRINGS_URL,
  EPG_LOOKAHEAD_HOURS,
  UA,
  fetchVizioCatalog,
  isSurfacedRow,
  type VizioRow,
} from '../sources/adapters/vizio/config.js';
import type { EpgChannelDoc } from '../models/EpgChannel.js';
import type { ProgramDoc } from '../models/Program.js';

export const VIZIO_EPG_NAME = 'Vizio WatchFree+ Schedule';
export const VIZIO_EPG_URL = 'https://watchfreeplus-epg-prod.smartcasttv.com/api/channels';

const SOURCE_ID = 'vizio';
const PER_CHANNEL_CONCURRENCY = 8; // fallback path only — kind to the guide host

// ── airings fetch ───────────────────────────────────────────────────────────

function isoNow(offsetHours = 0): string {
  return new Date(Date.now() + offsetHours * 3600_000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

async function getAirings(startChannel: string, channelCount: number, start: string, end: string): Promise<any[]> {
  const qs = new URLSearchParams({ start, end, startChannel, channelCount: String(channelCount) });
  const res = await fetch(`${AIRINGS_URL}?${qs}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { airings?: any[] };
  return Array.isArray(body?.airings) ? body.airings : [];
}

// Bounded-concurrency map; a single item's rejection is swallowed (its result is []) so one channel's guide
// failure can't abort the fallback. Mirrors syncEpgSource.mapLimit (kept local — that one isn't exported).
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<any[]>): Promise<any[]> {
  const out: any[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        out.push(...(await fn(item)));
      } catch {
        /* skip-on-failure */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () => worker()));
  return out;
}

// ── airing → ProgramDoc ───────────────────────────────────────────────────────

function startEnd(airing: any): { start: number; end: number } | null {
  // Prefer the upstream epoch-ms fields (already UTC instants); fall back to the ISO timeStart/timeEnd.
  const s = Number(airing?.epochTimeStart);
  const e = Number(airing?.epochTimeEnd);
  const start = Number.isFinite(s) && s > 0 ? s : Date.parse(String(airing?.timeStart));
  const end = Number.isFinite(e) && e > 0 ? e : Date.parse(String(airing?.timeEnd));
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { start, end };
}

function ratingCode(raw: unknown): string | null {
  if (raw && typeof raw === 'object') return (raw as any).code || null;
  const s = String(raw ?? '').trim();
  return s || null;
}

function numStr(v: unknown): string | null {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? String(n) : null; // 0 ⇒ "no season/episode" sentinel
}

/**
 * Parse one airings payload into Program docs, keyed by the COMPOSITE channelId. `stationToChannel` maps an
 * airing.stationId (== the catalog airingsKey) to the channelId; `meta` carries each channel's number/category
 * for the program rows. Airings for an unknown station, or with unparseable times, are skipped.
 */
function parseAirings(
  airings: any[],
  offset: string,
  stationToChannel: Map<string, string>,
  meta: Map<string, { number: string | null; category: string }>,
): ProgramDoc[] {
  const docs: ProgramDoc[] = [];
  for (const airing of airings) {
    const station = airing?.stationId == null ? null : String(airing.stationId);
    const channelId = station ? stationToChannel.get(station) : undefined;
    if (!channelId) continue;
    const times = startEnd(airing);
    if (!times) continue;

    const seriesTitle = String(airing?.seriesTitle ?? '').trim();
    const subTitle = String(airing?.subTitle ?? '').trim();
    const rawTitle = String(airing?.title ?? '').trim() || 'Unknown';

    // seriesTitle (when it differs from the airing title) is the programme title and subTitle the episode title;
    // otherwise the raw title stands alone. Ported from FastChannels vizio.py _parse_airings.
    let title: string;
    let episodeTitle: string | null;
    if (seriesTitle && seriesTitle.toLowerCase() !== rawTitle.toLowerCase()) {
      title = seriesTitle;
      episodeTitle = subTitle && subTitle.toLowerCase() !== seriesTitle.toLowerCase() ? subTitle : null;
    } else {
      title = rawTitle;
      episodeTitle = null;
    }

    const m = meta.get(channelId);
    const seriesId = String(airing?.seriesTmsId ?? '').trim() || numStr(airing?.seriesId);
    docs.push({
      channelId: `${SOURCE_ID}:${channelId}`,
      start: times.start,
      end: times.end,
      offset,
      title,
      cat: String(airing?.defaultGenre ?? '').trim() || m?.category || 'Live TV',
      source: SOURCE_ID,
      callSign: null,
      channelNo: m?.number ?? null,
      shortDesc: String(airing?.description ?? '').trim() || null,
      rating: ratingCode(airing?.rating),
      seriesId,
      season: numStr(airing?.seasonNumber),
      episode: numStr(airing?.episodeNumber),
      episodeTitle,
    });
  }
  return docs;
}

// ── build + sync ──────────────────────────────────────────────────────────────

/**
 * Build the mapped guide docs from a set of catalog rows (the adapter's afterSync passes its already-fetched
 * `raw`; the standalone sync fetches them live). One bulk airings call covers the whole lineup; an empty bulk
 * result falls back to per-channel fetches. Returns merged EpgChannel + Program docs for a single per-source
 * REPLACE.
 */
export async function buildVizioEpg(
  rows: VizioRow[],
  offset: string,
): Promise<{ channelDocs: EpgChannelDoc[]; programDocs: ProgramDoc[] }> {
  const surfaced = rows.filter(isSurfacedRow);

  const channelDocs: EpgChannelDoc[] = [];
  const stationToChannel = new Map<string, string>(); // airing.stationId (== airingsKey) → channelId
  const meta = new Map<string, { number: string | null; category: string }>();
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
    meta.set(r.channelId, { number, category: r.category || 'Live TV' });
    if (r.airingsKey) stationToChannel.set(r.airingsKey, r.channelId);
  }

  if (!surfaced.length) return { channelDocs, programDocs: [] };

  const start = isoNow(0);
  const end = isoNow(EPG_LOOKAHEAD_HOURS);

  let airings: any[] = [];
  try {
    airings = await getAirings(surfaced[0].channelId, surfaced.length, start, end);
  } catch (err) {
    logger.warn('epg', `[${SOURCE_ID}] bulk airings fetch failed: ${(err as Error).message}`);
  }
  if (!airings.length) {
    logger.info('epg', `[${SOURCE_ID}] bulk airings empty — falling back to per-channel`);
    airings = await mapLimit(surfaced, PER_CHANNEL_CONCURRENCY, (r) => getAirings(r.channelId, 1, start, end));
  }

  const programDocs = parseAirings(airings, offset, stationToChannel, meta);
  return { channelDocs, programDocs };
}

/**
 * Standalone EPG sync (the EPG Sources "Sync" button + scheduler path, dispatched from syncEpgSource on
 * src.source === 'vizio'). Fetches the catalog LIVE-ONLY (no snapshot fallback: a transient outage should fail
 * loudly → status 'error' → the existing guide is preserved) and per-source replaces the guide. EPG-ONLY: never
 * touches the vizio playlist or its channel links (that direction is the playlist sync's afterSync hook).
 */
export async function syncVizioEpg(
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const rows = await fetchVizioCatalog();
  const { channelDocs, programDocs } = await buildVizioEpg(rows, offset);
  return writeFastEpg(sourceId, channelDocs, programDocs);
}
