// The Roku Channel self-EPG — builds the 'roku' guide from a SEPARATE per-channel content-proxy fanout, then
// hands ALREADY-MAPPED docs to fastSelfEpg's writer (like xumo/tcl/pluto). Unlike the inline-program FAST sources
// (lg/freelivesports) or the batched-grid sources (whale/vidaa/pluto), Roku's guide is a per-station fetch: each
// station's content-proxy response (`featureInclude=linearSchedule`) carries an inline `features.linearSchedule[]`
// of program entries with full metadata (title/series/descriptions/rating/season/episode/genres). The fanout is
// bounded (concurrency 4 — Roku is CloudFront-sensitive; a 403 trips the shared cooldown and short-circuits the
// rest of the run) so the heavy ~795-channel walk stays kind to the edge. Program artwork is DROPPED (the
// snapshot-lean posture of tubi/xumo/…); seriesId is null (the family convention). The FastChannels 48h
// description-backfill SECOND pass is NOT ported — descriptions come inline from the linearSchedule content (null
// where absent, never fabricated). Ported from FastChannels roku.py fetch_epg / _parse_program.
//
// ⚠️ Composite guide-key convention (composeGuide.ts): EpgChannel._id / Program.channelId are "roku:<id>", joined
// to a PlaylistChannel by `${epg}:${tvg_id}`. linkFastSelfEpg sets tvg_id=<id>, so each guide channel matches its
// PlaylistChannel _id "roku:<id>".

import { fetchContent, fetchRokuRows, isCoolingDown, type RokuRow } from '../sources/adapters/roku/config.js';
import { writeFastEpg } from './fastSelfEpg.js';
import { logger } from '../sources/core/logger.js';
import type { EpgChannelDoc } from '../models/EpgChannel.js';
import type { ProgramDoc } from '../models/Program.js';

export const ROKU_EPG_NAME = 'The Roku Channel Schedule';
export const ROKU_EPG_URL = 'https://therokuchannel.roku.com/api/v2/epg';

const SOURCE_ID = 'roku';

// Per-channel fanout concurrency — conservative (Roku rate-limits via CloudFront; FastChannels uses 3 workers).
const EPG_CONCURRENCY = 4;

function str(v: unknown): string | null {
  const s = (v == null ? '' : String(v)).trim();
  return s || null;
}

function intStr(v: unknown): string | null {
  if (v == null) return null;
  const n = Number.parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? String(n) : null;
}

/**
 * Parse a Roku program timestamp ('YYYY-MM-DDTHH:MM:SSZ') → epoch ms (UTC). A timezone-less ISO is read as UTC
 * (the V8 "naive ISO parses as local" trap the other FAST guides also dodge). NaN when unparseable.
 */
function parseDt(value: unknown): number {
  let s = str(value);
  if (!s) return NaN;
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  if (!hasTz && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) s = `${s.replace(' ', 'T')}Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/** Join a program's genre list → a `;`-separated category (capitalized), or null when empty. */
function joinGenres(values: unknown): string | null {
  if (!Array.isArray(values)) return null;
  const out: string[] = [];
  for (const v of values) {
    const clean = str(v);
    if (!clean) continue;
    const label = clean[0].toUpperCase() + clean.slice(1);
    if (!out.includes(label)) out.push(label);
  }
  return out.length ? out.join(';') : null;
}

interface ChannelInfo {
  number: string | null;
  category: string;
}

/** Parse one `linearSchedule` entry → a ProgramDoc, or null when it lacks a valid time window. Mirrors _parse_program. */
function parseProgram(stationId: string, entry: any, info: ChannelInfo, offset: string): ProgramDoc | null {
  const start = parseDt(entry?.date);
  const durationSec = Number(entry?.duration) || 0;
  if (Number.isNaN(start) || durationSec <= 0) return null;
  const end = start + durationSec * 1000;

  const c = entry?.content || {};
  const series = c?.series || {};
  const epTitle = str(c?.title);
  const seriesTitle = str(series?.title);
  const title = seriesTitle || epTitle || 'Unknown';

  const descs = c?.descriptions || {};
  const shortDesc =
    str(descs?.['250']?.text ?? descs?.['250']) ||
    str(descs?.['60']?.text ?? descs?.['60']) ||
    str(descs?.['40']?.text ?? descs?.['40']) ||
    str(c?.description);

  const ratings: any[] = Array.isArray(c?.parentalRatings) ? c.parentalRatings : [];
  const rating = str(ratings[0]?.code);

  return {
    channelId: `${SOURCE_ID}:${stationId}`,
    start,
    end,
    offset,
    title,
    cat: joinGenres(c?.genres) || info.category || 'Live TV',
    source: SOURCE_ID,
    callSign: null,
    channelNo: info.number,
    shortDesc,
    rating,
    seriesId: null, // dropped (the family's snapshot-lean posture)
    season: intStr(c?.seasonNumber),
    episode: intStr(c?.episodeNumber),
    episodeTitle: seriesTitle && epTitle && epTitle !== seriesTitle ? epTitle : null,
  };
}

// ── bounded-concurrency map (a single channel's rejection is swallowed → skip-on-failure) ──
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
 * station's `linearSchedule` content-proxy fetch under bounded concurrency. A mid-run CloudFront 403 trips the
 * shared cooldown and the loop stops issuing new fetches (the partial guide it has is still written). Returns
 * merged EpgChannel + Program docs for a single per-source REPLACE.
 */
export async function buildRokuEpg(
  rows: RokuRow[],
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

  const programDocs: ProgramDoc[] = [];
  const withGuide = new Set<string>();
  await mapLimit(rows, EPG_CONCURRENCY, async (r) => {
    if (isCoolingDown()) return; // a 403 tripped mid-run — stop hitting the edge; keep what we have
    const content = await fetchContent(r.channelId, 'linearSchedule');
    const schedule: any[] = content?.features?.linearSchedule;
    if (!Array.isArray(schedule)) return;
    const ci = info.get(r.channelId) ?? { number: null, category: 'Live TV' };
    for (const entry of schedule) {
      const prog = parseProgram(r.channelId, entry, ci, offset);
      if (prog) {
        programDocs.push(prog);
        withGuide.add(r.channelId);
      }
    }
  });

  logger.info(
    'epg',
    `[${SOURCE_ID}] guide: ${withGuide.size}/${rows.length} channels carried programs (${programDocs.length} total)`,
  );
  return { channelDocs, programDocs };
}

/**
 * Standalone EPG sync (the EPG Sources "Sync" button + scheduler path, dispatched from syncEpgSource on
 * src.source === 'roku'). Fetches the catalog LIVE-ONLY (no snapshot fallback: a transient outage / 403 cooldown
 * should fail loudly → status 'error' → the existing guide is preserved) and per-source replaces the guide.
 * EPG-ONLY: never touches the roku playlist or its channel links (that direction is the playlist sync's afterSync).
 */
export async function syncRokuEpg(
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const rows = await fetchRokuRows();
  const { channelDocs, programDocs } = await buildRokuEpg(rows, offset);
  return writeFastEpg(sourceId, channelDocs, programDocs);
}
