// Pluto TV self-EPG — builds the 'pluto' guide from the Paramount backend's SEPARATE per-region `/v2/guide/
// timelines` fetch, then hands ALREADY-MAPPED docs to fastSelfEpg's writer (like xumo/whale/tcl). The schedule is
// NOT inline (lg) nor a single batched grid (whale/vidaa) — it is per-region (each region's channels are guided
// with that region's boot token + X-Forwarded-For), batched 100 channel ids at a time over 3 consecutive 12h
// windows (~36h of guide, matching FastChannels' window×batch loop). The timeline carries the program metadata
// inline (title/description/season/episode/genre), so no per-program fetch is needed. Program artwork is DROPPED
// (the snapshot-lean posture of tubi/xumo/…); seriesId is null (the family convention). Ported from FastChannels
// pluto.py fetch_epg / _parse_timelines.
//
// ⚠️ Composite guide-key convention (composeGuide.ts): EpgChannel._id / Program.channelId are "pluto:<id>", joined
// to a PlaylistChannel by `${epg}:${tvg_id}`. linkFastSelfEpg sets tvg_id=<id>, so each guide channel matches its
// PlaylistChannel _id "pluto:<id>".

import {
  bootRegion,
  regionHeaders,
  timelinesUrl,
  fetchPlutoRows,
  type PlutoRow,
} from '../sources/adapters/pluto/config.js';
import { writeFastEpg } from './fastSelfEpg.js';
import { logger } from '../sources/core/logger.js';
import type { EpgChannelDoc } from '../models/EpgChannel.js';
import type { ProgramDoc } from '../models/Program.js';

export const PLUTO_EPG_NAME = 'Pluto TV Schedule';
export const PLUTO_EPG_URL = 'https://service-channels.clusters.pluto.tv/v2/guide/timelines';

const SOURCE_ID = 'pluto';

// Guide window — 3 consecutive 12h blocks (~36h), matching FastChannels' 3-window × 720-minute loop.
const WINDOW_MINUTES = 720;
const WINDOW_COUNT = 3;
const BATCH_SIZE = 100; // channel ids per timelines request (the web client's batch size)

// ── parse helpers (ported from FastChannels pluto.py _parse_timelines) ─────────────────

// Pluto filler placeholder strings — a program whose title/description is one of these carries no real data.
const FILLER = new Set(['no info available', 'n/a']);
// Control chars Pluto occasionally leaves in titles/descriptions (XML-illegal — stripped before storage).
const ILLEGAL_CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
// A trailing "(YYYY)" year suffix on a movie title — stripped (the bare title is the guide title).
const YEAR_SUFFIX = /\s*\((\d{4})\)\s*$/;

function clean(s: unknown): string {
  return String(s ?? '')
    .replace(ILLEGAL_CTRL, '')
    .replace(/&quot;/g, '"')
    .trim();
}

/** Clean + collapse Pluto filler placeholders to null (so a guide cell isn't "No Info Available"). */
function cleanMeta(s: unknown): string | null {
  const v = clean(s);
  return v && !FILLER.has(v.toLowerCase()) ? v : null;
}

/** Strip a trailing "(YYYY)" from a title → the bare title. */
function stripYear(title: string): string {
  return title.replace(YEAR_SUFFIX, '').trim();
}

/** Parse a Pluto timeline timestamp ('YYYY-MM-DDTHH:MM:SS.sssZ') → epoch ms UTC, or NaN if unparseable. */
function parseDt(value: unknown): number {
  const s = clean(value);
  if (!s) return NaN;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

function intStr(v: unknown): string | null {
  if (v == null) return null;
  const n = Number.parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? String(n) : null;
}

// ── timeline → program docs ────────────────────────────────────────────────────────────

interface ChannelInfo {
  number: string | null;
  category: string;
}

/** Parse one `/v2/guide/timelines` `data[]` payload into program docs for the wanted channels. */
function parseTimelines(
  data: any[],
  info: Map<string, ChannelInfo>,
  offset: string,
  seen: Set<string>,
  out: ProgramDoc[],
): void {
  for (const entry of data) {
    const chId = clean(entry?.channelId);
    const ci = info.get(chId);
    if (!chId || !ci) continue;

    for (const tl of entry?.timelines ?? []) {
      const start = parseDt(tl?.start);
      const end = parseDt(tl?.stop);
      if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;

      const title = stripYear(clean(tl?.title));
      if (!title || FILLER.has(title.toLowerCase())) continue; // a real filler slot — no program data

      const dedupe = `${chId}|${start}`;
      if (seen.has(dedupe)) continue; // window-boundary straddle (a slot in two adjacent windows)
      seen.add(dedupe);

      const ep = (tl?.episode ?? {}) as Record<string, unknown>;
      const series = (ep?.series ?? {}) as Record<string, unknown>;
      const seriesType = clean(series?.type);

      // Category: the program's own genre, else the series kind (Series/Movie), else the channel's bucket.
      const genre = cleanMeta(ep?.genre);
      const cat =
        genre || (seriesType === 'tv' ? 'Series' : seriesType === 'film' ? 'Movie' : ci.category);

      const epName = clean(ep?.name);

      out.push({
        channelId: `${SOURCE_ID}:${chId}`,
        start,
        end,
        offset,
        title,
        cat,
        source: SOURCE_ID,
        callSign: null,
        channelNo: ci.number,
        shortDesc: cleanMeta(ep?.description),
        rating: null, // the timeline carries no content rating — not fabricated
        seriesId: null, // dropped (the family's snapshot-lean posture)
        season: intStr(ep?.season),
        episode: intStr(ep?.number),
        episodeTitle: epName && epName.toLowerCase() !== title.toLowerCase() ? epName : null,
      });
    }
  }
}

// ── bounded fetch loop ─────────────────────────────────────────────────────────────────

/** The UTC hour-floored window start times: now, +12h, +24h (3 consecutive 12h blocks). */
function windowStarts(now: number): string[] {
  const hourFloor = Math.floor(now / 3600_000) * 3600_000;
  const starts: string[] = [];
  for (let w = 0; w < WINDOW_COUNT; w++) {
    starts.push(new Date(hourFloor + w * WINDOW_MINUTES * 60_000).toISOString());
  }
  return starts;
}

/** Fetch + parse one region's timelines (3 windows × 100-id batches) into program docs. */
async function fetchRegionEpg(
  region: string,
  rows: PlutoRow[],
  info: Map<string, ChannelInfo>,
  offset: string,
  seen: Set<string>,
  out: ProgramDoc[],
): Promise<void> {
  const { sessionToken } = await bootRegion(region);
  const headers = regionHeaders(region, sessionToken);
  const ids = rows.map((r) => r.channelId);

  for (const start of windowStarts(Date.now())) {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      try {
        const res = await fetch(timelinesUrl(batch, start, WINDOW_MINUTES), { headers });
        if (!res.ok) continue; // a flaky batch must not abort the region
        const payload = await res.json();
        parseTimelines(Array.isArray(payload?.data) ? payload.data : [], info, offset, seen, out);
      } catch {
        /* transient — skip this batch */
      }
    }
  }
}

/**
 * Build the mapped guide docs from a set of catalog rows (the adapter's afterSync passes its already-fetched
 * `raw`; the standalone sync fetches them live). Channel records come from the rows; programs come from each
 * region's `/v2/guide/timelines` fetch, grouped by the row's winning region (so each channel is guided with the
 * region's own boot token). Returns merged EpgChannel + Program docs for a single per-source REPLACE.
 */
export async function buildPlutoEpg(
  rows: PlutoRow[],
  offset: string,
): Promise<{ channelDocs: EpgChannelDoc[]; programDocs: ProgramDoc[] }> {
  const channelDocs: EpgChannelDoc[] = [];
  const info = new Map<string, ChannelInfo>();
  const byRegion = new Map<string, PlutoRow[]>();
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
    const bucket = byRegion.get(r.region);
    if (bucket) bucket.push(r);
    else byRegion.set(r.region, [r]);
  }
  if (!rows.length) return { channelDocs, programDocs: [] };

  const programDocs: ProgramDoc[] = [];
  const seen = new Set<string>(); // (channelId|start) dedupe across windows/regions
  for (const [region, regionRows] of byRegion) {
    try {
      await fetchRegionEpg(region, regionRows, info, offset, seen, programDocs);
    } catch (err) {
      logger.warn('epg', `[${SOURCE_ID}] region ${region} EPG failed (continuing): ${(err as Error).message}`);
    }
  }

  const withGuide = new Set(programDocs.map((p) => p.channelId));
  logger.info(
    'epg',
    `[${SOURCE_ID}] guide: ${withGuide.size}/${rows.length} channels carried programs (${programDocs.length} total)`,
  );
  return { channelDocs, programDocs };
}

/**
 * Standalone EPG sync (the EPG Sources "Sync" button + scheduler path, dispatched from syncEpgSource on
 * src.source === 'pluto'). Fetches the catalog LIVE-ONLY (no snapshot fallback: a transient outage should fail
 * loudly → status 'error' → the existing guide is preserved) and per-source replaces the guide. EPG-ONLY: never
 * touches the pluto playlist or its channel links (that direction is the playlist sync's afterSync hook).
 */
export async function syncPlutoEpg(
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const rows = await fetchPlutoRows();
  const { channelDocs, programDocs } = await buildPlutoEpg(rows, offset);
  return writeFastEpg(sourceId, channelDocs, programDocs);
}
