// TCL TV+ self-EPG — builds the 'tcl' guide from a SEPARATE, heavy per-category schedule fetch, then hands
// ALREADY-MAPPED docs to fastSelfEpg's writer (like xumo/stirr/distro). Unlike the inline-program FAST sources
// (lg/freelivesports) or the single batched schedule (whale/vidaa), TCL's guide is a TWO-STEP fetch: (1) re-walk
// the livetab categories WITH a time range — each category's channels then carry an inline `programs[]` schedule
// (id + start/end + a thin title); (2) a BATCHED `/epg/program/detail` lookup (50 ids/request, bounded
// concurrency) enriches each program with desc/rating/season/episode (the schedule itself carries only ids +
// times). This is the heaviest FAST guide ported — hence the wide [-4h, +7d] window matching FastChannels. The
// composite program/title parsers (`_parse_tcl_title`/`_normalize_rating`) are ported faithfully. Program artwork
// is DROPPED (the snapshot-lean posture of tubi/xumo/…). Ported from FastChannels tcl.py fetch_epg.
//
// ⚠️ Composite guide-key convention (composeGuide.ts): EpgChannel._id / Program.channelId are "tcl:<bundleId>",
// joined to a PlaylistChannel by `${epg}:${tvg_id}`. linkFastSelfEpg sets tvg_id=<bundleId>, so each guide
// channel matches its PlaylistChannel _id "tcl:<bundleId>".

import { writeFastEpg } from './fastSelfEpg.js';
import { logger } from '../sources/core/logger.js';
import {
  fetchTclRows,
  fetchLivetabCategories,
  fetchCategoryChannels,
  programDetailUrl,
  tclGetJson,
  geos,
  PRIMARY_GEO,
  type TclRow,
} from '../sources/adapters/tcl/config.js';
import type { EpgChannelDoc } from '../models/EpgChannel.js';
import type { ProgramDoc } from '../models/Program.js';

export const TCL_EPG_NAME = 'TCL TV+ Schedule';
export const TCL_EPG_URL = 'https://gateway-prod.ideonow.com/api/metadata/v1/epg';

const SOURCE_ID = 'tcl';

// Guide window — [-4h, +7d], matching FastChannels (TCL returns a dense 7-day schedule per channel).
const WINDOW_BACK_MS = 4 * 3600_000;
const WINDOW_FWD_MS = 7 * 86_400_000;

// Program-detail batching (FastChannels: 50 ids/request over a 4-worker pool).
const DETAIL_BATCH = 50;
const DETAIL_CONCURRENCY = 4;

function str(v: unknown): string | null {
  const s = (v == null ? '' : String(v)).trim();
  return s || null;
}

function intOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number.parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** ISO-8601 UTC with no millis ('YYYY-MM-DDTHH:MM:SSZ') — the gateway range param format. */
function isoZ(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Parse a program timestamp → epoch ms (UTC). Accepts an ISO string (a timezone-LESS one is read as UTC — the
 * V8 "naive ISO parses as local" trap stirr/distro also dodge). NaN when unparseable.
 */
function parseDt(val: unknown): number {
  let s = str(val);
  if (!s) return NaN;
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  if (!hasTz && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) s = `${s.replace(' ', 'T')}Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

// ── title / rating parsers (ported verbatim from FastChannels tcl.py) ────────────────

// "Bones S06: Twisted Bones In The Melted Truck 608"
const COLON_RE = /^(.+?)\s+S(\d+):\s+(.+)$/i;
const TRAILING_CODE = /\s+\d+$/;
// Trailing "S1 E5" / "S1" left inside an episode title after dash-pattern parsing
const TRAILING_SE = /[\s"]*\bS\d+(?:\s+E\d+)?\s*$/i;
// "Show S1 - \"Ep Title\"" / "Show S2 E4" / "Show S1"
const DASH_RE = /^(.+?)\s+S(\d+)(?:\s+E(\d+))?(?:\s*[-–]\s*"?(.+?)"?\s*)?$/i;
// "The Rifleman  - A Matter of Faith" (no season marker; 1–2 spaces before dash)
const PLAIN_DASH_RE = /^(.+?)\s{1,2}-\s+(.+)$/;

/** Parse a TCL composite title into [series_title, season, episode, episode_title]. Mirrors tcl.py `_parse_tcl_title`. */
function parseTclTitle(
  raw: string | null,
  apiSeason: number | null,
  apiEpisode: number | null,
): [string | null, number | null, number | null, string | null] {
  if (!raw) return [raw, apiSeason, apiEpisode, null];
  const s = raw.trim();

  // "Series S06: Episode Title 608"
  let m = COLON_RE.exec(s);
  if (m) {
    const series = m[1].trim();
    const season = Number.parseInt(m[2], 10);
    const epTitle = m[3].replace(TRAILING_CODE, '').trim() || null;
    return [series, season, apiEpisode, epTitle];
  }

  // "Series S1 - \"Ep Title\"" / "Series S2 E4" / "Series S1"
  m = DASH_RE.exec(s);
  if (m) {
    const series = m[1].trim();
    const season = m[2] ? Number.parseInt(m[2], 10) : apiSeason;
    const episode = m[3] ? Number.parseInt(m[3], 10) : apiEpisode;
    let epTitle = m[4] ? m[4].trim().replace(/^"+|"+$/g, '') : null;
    if (epTitle) {
      // Strip a trailing "S1 E5" artifact when the episode title itself carries a redundant season/episode marker.
      epTitle = epTitle.replace(TRAILING_SE, '').replace(/^[\s"]+|[\s"]+$/g, '') || null;
    }
    return [series, season, episode, epTitle];
  }

  // "The Rifleman  - A Matter of Faith" (no season in title, API has none either)
  if (apiSeason == null && apiEpisode == null) {
    m = PLAIN_DASH_RE.exec(s);
    if (m) return [m[1].trim(), null, null, m[2].trim() || null];
  }

  return [s, apiSeason, apiEpisode, null];
}

// Normalize TCL's inconsistent rating strings to standard US TV/MPAA values (strip sub-rating descriptors, then map).
const RATING_NORM: Record<string, string> = {
  TVY: 'TV-Y', 'TV Y': 'TV-Y',
  TVY7: 'TV-Y7', 'TV Y7': 'TV-Y7',
  TVG: 'TV-G', 'TV G': 'TV-G',
  TVPG: 'TV-PG', 'TV PG': 'TV-PG',
  TV14: 'TV-14', 'TV 14': 'TV-14',
  TVMA: 'TV-MA', 'TV MA': 'TV-MA',
  TVNR: 'TV-NR', 'TV NR': 'TV-NR',
  NR: 'TV-NR', NA: 'TV-NR', UNRATED: 'TV-NR',
};
const VALID_RATINGS = new Set([
  'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA', 'TV-NR',
  'G', 'PG', 'PG-13', 'R', 'NC-17', 'NR',
]);

function normalizeRating(raw: string | null): string | null {
  if (!raw) return null;
  const base = (raw.trim().split(/\s+/)[0] || '').toUpperCase(); // "TV-14 D,L,V" → "TV-14"
  const normed = RATING_NORM[base] ?? base;
  return VALID_RATINGS.has(normed) ? normed : null;
}

/**
 * Extract the content_id the detail API expects from a compound prog id. The schedule returns composite ids in
 * the form bundle_id:content_id:slot_id; `/epg/program/detail` accepts only the content_id (middle part). Simple
 * (non-compound) ids are returned unchanged. Mirrors tcl.py `_detail_lookup_id`.
 */
function detailLookupId(progId: string): string {
  const parts = progId.split(':');
  return parts.length === 3 ? parts[1] : progId;
}

// ── bounded-concurrency map (a single batch's rejection is swallowed → skip-on-failure) ──
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        await fn(items[i]);
      } catch {
        /* skip-on-failure */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () => worker()));
}

// ── schedule walk + detail enrichment ────────────────────────────────────────────────

interface Stub {
  bundleId: string;
  progId: string;
  start: string;
  end: string;
  listTitle: string;
}

/** Re-walk the livetab categories WITH the guide window → program stubs for the wanted (catalog) channels. */
async function collectStubs(wanted: Set<string>): Promise<Stub[]> {
  const now = Date.now();
  const range = { start: isoZ(now - WINDOW_BACK_MS), end: isoZ(now + WINDOW_FWD_MS) };
  const seen = new Set<string>();
  const stubs: Stub[] = [];

  for (const geo of geos()) {
    let cats: Array<{ id: string; name: string | null }>;
    try {
      cats = await fetchLivetabCategories(geo);
    } catch {
      continue;
    }
    for (const cat of cats) {
      let channels: any[];
      try {
        channels = await fetchCategoryChannels(geo, cat.id, range);
      } catch {
        continue; // a flaky category must not abort the whole guide build
      }
      for (const ch of channels) {
        const bundleId = str(ch?.bundle_id) || str(ch?.id);
        if (!bundleId || !wanted.has(bundleId)) continue;
        for (const prog of ch?.programs ?? []) {
          const progId = str(prog?.id);
          if (!progId) continue;
          const start = str(prog?.start) ?? '';
          const key = `${bundleId}:${progId}:${start}`;
          if (seen.has(key)) continue;
          seen.add(key);
          stubs.push({ bundleId, progId, start, end: str(prog?.end) ?? '', listTitle: str(prog?.title) ?? '' });
        }
      }
    }
  }
  return stubs;
}

/** Batch-fetch `/epg/program/detail` for the stubs' content ids → a content_id→detail map (deduped, bounded). */
async function fetchProgramDetails(progIds: string[]): Promise<Map<string, any>> {
  const ids = [...new Set(progIds.map(detailLookupId))];
  const details = new Map<string, any>();
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += DETAIL_BATCH) batches.push(ids.slice(i, i + DETAIL_BATCH));

  await mapLimit(batches, DETAIL_CONCURRENCY, async (batch) => {
    const items = await tclGetJson(programDetailUrl(PRIMARY_GEO, batch));
    if (Array.isArray(items)) {
      for (const item of items) {
        const lid = str(item?.id);
        if (lid) details.set(lid, item);
      }
    }
  });
  logger.info('epg', `[${SOURCE_ID}] program details fetched: ${details.size}/${ids.length}`);
  return details;
}

/**
 * Build the mapped guide docs from a set of catalog rows (the adapter's afterSync passes its already-fetched
 * `raw`; the standalone sync fetches them live). Channel records come from the rows; programs are the re-walked
 * schedule enriched by the batched detail lookup (§module header). Returns merged EpgChannel + Program docs for a
 * single per-source REPLACE.
 */
export async function buildTclEpg(
  rows: TclRow[],
  offset: string,
): Promise<{ channelDocs: EpgChannelDoc[]; programDocs: ProgramDoc[] }> {
  const channelDocs: EpgChannelDoc[] = rows.map((r) => ({
    _id: `${SOURCE_ID}:${r.channelId}`,
    callSign: null,
    affiliateName: r.name,
    channelId: r.channelId,
    channelNo: null, // TCL carries no channel number
    source: SOURCE_ID,
  }));
  if (!rows.length) return { channelDocs, programDocs: [] };

  const wanted = new Set(rows.map((r) => r.channelId));
  const catById = new Map(rows.map((r) => [r.channelId, r.category || 'Live TV']));

  const stubs = await collectStubs(wanted);
  const details = await fetchProgramDetails(stubs.map((s) => s.progId));

  const programDocs: ProgramDoc[] = [];
  const withGuide = new Set<string>();
  for (const stub of stubs) {
    const start = parseDt(stub.start);
    const end = parseDt(stub.end);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;

    const d = details.get(detailLookupId(stub.progId)) ?? {};
    const series = (d?.series ?? {}) as Record<string, unknown>;
    const rawTitle = str(d?.title) || stub.listTitle || 'No Title';
    const [title, season, episode, epTitle] = parseTclTitle(rawTitle, intOrNull(series?.season), intOrNull(series?.episode));

    programDocs.push({
      channelId: `${SOURCE_ID}:${stub.bundleId}`,
      start,
      end,
      offset,
      title: title || 'No Title',
      cat: catById.get(stub.bundleId) || 'Live TV',
      source: SOURCE_ID,
      callSign: null,
      channelNo: null,
      shortDesc: str(d?.desc),
      rating: normalizeRating(str(d?.rating)),
      seriesId: null,
      season: season != null ? String(season) : null,
      episode: episode != null ? String(episode) : null,
      episodeTitle: epTitle,
    });
    withGuide.add(stub.bundleId);
  }

  logger.info(
    'epg',
    `[${SOURCE_ID}] guide: ${withGuide.size}/${rows.length} channels carried programs (${programDocs.length} total)`,
  );
  return { channelDocs, programDocs };
}

/**
 * Standalone EPG sync (the EPG Sources "Sync" button + scheduler path, dispatched from syncEpgSource on
 * src.source === 'tcl'). Fetches the catalog LIVE-ONLY (no snapshot fallback: a transient outage should fail
 * loudly → status 'error' → the existing guide is preserved) and per-source replaces the guide. EPG-ONLY: never
 * touches the tcl playlist or its channel links (that direction is the playlist sync's afterSync hook).
 */
export async function syncTclEpg(
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const rows = await fetchTclRows();
  const { channelDocs, programDocs } = await buildTclEpg(rows, offset);
  return writeFastEpg(sourceId, channelDocs, programDocs);
}
