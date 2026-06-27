// Plex self-EPG — builds the 'plex' guide from a SEPARATE per-channel per-day grid fanout, then hands
// ALREADY-MAPPED docs to fastSelfEpg's writer (like roku/xumo/tcl/pluto). Unlike the inline-program FAST sources
// (lg/freelivesports) or the batched-grid sources (whale/vidaa/pluto), Plex's guide is a per-channel-per-DAY
// fetch: each `epg.provider.plex.tv/grid?channelGridKey=<gridKey>&date=<YYYY-MM-DD>` JSON response carries that
// day's `MediaContainer.Metadata[]` airings with full metadata (title/series/summary/rating/season/episode/genre).
// The per-channel channelGridKey grid is Plex's SOLE EPG endpoint (the bulk beginningAt/endingAt grid was retired),
// so a multi-day guide means EPG_DAYS calls per channel; the fanout is bounded (concurrency EPG_CONCURRENCY) and
// deduped by airing id across days. Program artwork + program-type + original-air-date are DROPPED (the
// snapshot-lean posture of tubi/xumo/roku — masq's ProgramDoc has no slot for them); seriesId is null (the family
// convention). The optional luma.plex.tv schedule GAP-FILL second pass is NOT ported (the grid is the guide; gaps
// left null, never fabricated). Ported from FastChannels plex.py fetch_epg / _parse_grid_xml_programs.
//
// ⚠️ Composite guide-key convention (composeGuide.ts): EpgChannel._id / Program.channelId are "plex:<gridKey>",
// joined to a PlaylistChannel by `${epg}:${tvg_id}`. linkFastSelfEpg sets tvg_id=<gridKey>, so each guide channel
// matches its PlaylistChannel _id "plex:<gridKey>".

import { fetchGrid, fetchPlexRows, type PlexRow } from '../sources/adapters/plex/config.js';
import { writeFastEpg } from './fastSelfEpg.js';
import { logger } from '../sources/core/logger.js';
import type { EpgChannelDoc } from '../models/EpgChannel.js';
import type { ProgramDoc } from '../models/Program.js';

export const PLEX_EPG_NAME = 'Plex Live TV Schedule';
export const PLEX_EPG_URL = 'https://epg.provider.plex.tv/grid';

const SOURCE_ID = 'plex';

// Per-(channel × day) fanout concurrency. Plex's provider backend tolerates more parallelism than roku's
// CloudFront edge; FastChannels uses 6 guide workers. The horizon is EPG_DAYS forward (today + EPG_DAYS-1).
const EPG_CONCURRENCY = 8;
// Multi-day horizon (today through today+EPG_DAYS-1). plex.py uses 5 days (PLEX_EXTRA_DAYS=4); masq defaults to a
// lighter 3 (≈695×3 grid calls per sync) — env PLEX_EPG_DAYS extends it (clamped 1..7) for a longer guide.
const EPG_DAYS = Math.min(7, Math.max(1, Number.parseInt(process.env.PLEX_EPG_DAYS || '', 10) || 3));

function str(v: unknown): string | null {
  const s = (v == null ? '' : String(v)).trim();
  return s || null;
}

function intStr(v: unknown): string | null {
  if (v == null) return null;
  const n = Number.parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? String(n) : null;
}

/** Today + dayOffset as a UTC 'YYYY-MM-DD' string (the grid endpoint's `date` param). */
function ymdUtc(dayOffset: number): string {
  const d = new Date(Date.now() + dayOffset * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

const EP_ONLY_RE = /^Episode\s+\d+$/i;
const EP_COLON_RE = /^Episode\s+\d+\s*:\s*(.+)$/i;

/** Drop/fix generic Plex episode titles like 'Episode 3' or 'Episode 1 : Real Name'. Ported from plex.py _clean_ep_title. */
function cleanEpTitle(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t || t === '.' || t === '-' || t === '_') return null;
  const m = EP_COLON_RE.exec(t);
  if (m) return str(m[1]);
  if (EP_ONLY_RE.test(t)) return null;
  return t;
}

/** First genre tag from the grid item's `Genre[]` (objects `{tag}`/`{title}` or bare strings), or null. */
function firstGenre(values: unknown): string | null {
  if (!Array.isArray(values)) return null;
  for (const g of values) {
    const tag = typeof g === 'string' ? str(g) : str((g as any)?.tag) || str((g as any)?.title);
    if (tag) return tag;
  }
  return null;
}

interface ChannelInfo {
  number: string | null;
  category: string;
}

/** Parse one grid `Metadata` airing → a ProgramDoc, or null when it lacks a valid time window. Mirrors plex.py _parse_grid_xml_programs. */
function parseAiring(stationId: string, item: any, info: ChannelInfo, offset: string): ProgramDoc | null {
  const media = Array.isArray(item?.Media) ? item.Media[0] : null;
  const beginsAt = Number(media?.beginsAt);
  const endsAt = Number(media?.endsAt);
  if (!Number.isFinite(beginsAt) || !Number.isFinite(endsAt) || endsAt <= beginsAt) return null;

  const rawTitle = str(item?.title) || 'Unknown';
  const gpTitle = str(item?.grandparentTitle);
  let title: string;
  let episodeTitle: string | null;
  if (gpTitle && gpTitle.toLowerCase() !== rawTitle.toLowerCase()) {
    title = gpTitle;
    episodeTitle = cleanEpTitle(rawTitle);
  } else {
    title = rawTitle;
    episodeTitle = null;
  }

  return {
    channelId: `${SOURCE_ID}:${stationId}`,
    start: beginsAt * 1000,
    end: endsAt * 1000,
    offset,
    title,
    cat: firstGenre(item?.Genre) || info.category || 'Live TV',
    source: SOURCE_ID,
    callSign: null,
    channelNo: info.number,
    shortDesc: str(item?.summary),
    rating: str(item?.contentRating),
    seriesId: null, // dropped (the family's snapshot-lean posture)
    season: intStr(item?.parentIndex),
    episode: intStr(item?.index),
    episodeTitle,
  };
}

// ── bounded-concurrency map (a single task's rejection is swallowed → skip-on-failure) ──
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

/**
 * Build the mapped guide docs from a set of catalog rows (the adapter's afterSync passes its already-fetched
 * `raw`; the standalone sync fetches them live). Channel records come from the rows; programs come from each
 * channel's per-day grid fetch under bounded concurrency, deduped by airing id across days. Returns merged
 * EpgChannel + Program docs for a single per-source REPLACE.
 */
export async function buildPlexEpg(
  rows: PlexRow[],
  offset: string,
): Promise<{ channelDocs: EpgChannelDoc[]; programDocs: ProgramDoc[] }> {
  const channelDocs: EpgChannelDoc[] = [];
  const info = new Map<string, ChannelInfo>();
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

  // One task per (channel, day); each appends to the channel's program bucket (deduped by airing id).
  const dates = Array.from({ length: EPG_DAYS }, (_, d) => ymdUtc(d));
  const tasks: Array<{ row: PlexRow; date: string }> = [];
  for (const date of dates) for (const row of rows) tasks.push({ row, date });

  const byChannel = new Map<string, ProgramDoc[]>();
  const seenAirings = new Map<string, Set<string>>(); // channelId → airing ids already taken (dedup across days)
  const withGuide = new Set<string>();

  await mapLimit(tasks, EPG_CONCURRENCY, async ({ row, date }) => {
    const airings = await fetchGrid(row.channelId, date);
    if (!airings.length) return;
    const ci = info.get(row.channelId) ?? { number: null, category: 'Live TV' };
    let seen = seenAirings.get(row.channelId);
    if (!seen) {
      seen = new Set();
      seenAirings.set(row.channelId, seen);
    }
    let bucket = byChannel.get(row.channelId);
    if (!bucket) {
      bucket = [];
      byChannel.set(row.channelId, bucket);
    }
    for (const item of airings) {
      const airingId = str(item?.Media?.[0]?.id) || str(item?.ratingKey);
      if (airingId && seen.has(airingId)) continue;
      const prog = parseAiring(row.channelId, item, ci, offset);
      if (!prog) continue;
      if (airingId) seen.add(airingId);
      bucket.push(prog);
      withGuide.add(row.channelId);
    }
  });

  const programDocs: ProgramDoc[] = [];
  for (const bucket of byChannel.values()) programDocs.push(...bucket);

  logger.info(
    'epg',
    `[${SOURCE_ID}] guide: ${withGuide.size}/${rows.length} channels carried programs (${programDocs.length} total, ${EPG_DAYS}-day horizon)`,
  );
  return { channelDocs, programDocs };
}

/**
 * Standalone EPG sync (the EPG Sources "Sync" button + scheduler path, dispatched from syncEpgSource on
 * src.source === 'plex'). Fetches the catalog LIVE-ONLY (no snapshot fallback: a transient outage should fail
 * loudly → status 'error' → the existing guide is preserved) and per-source replaces the guide. EPG-ONLY: never
 * touches the plex playlist or its channel links (that direction is the playlist sync's afterSync).
 */
export async function syncPlexEpg(
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const rows = await fetchPlexRows();
  const { channelDocs, programDocs } = await buildPlexEpg(rows, offset);
  return writeFastEpg(sourceId, channelDocs, programDocs);
}
