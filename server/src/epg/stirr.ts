// STIRR self-EPG — builds the 'stirr' guide PER CHANNEL via a TWO-TIER fetch, then hands ALREADY-MAPPED docs to
// fastSelfEpg's writer (like distro/whale/xumo). Unlike the other FAST sources (one catalog/guide call, or a
// single batched schedule fetch), STIRR has no unified guide: each catalog row carries a third-party provider
// `epg_url` (+ `epg_channel_id`) — tried FIRST (XMLTV via the shared parseXmltv, or generic JSON) — with STIRR's
// own `/api/epg?channel_id=…` as the FALLBACK (generic JSON). Fetched under bounded concurrency; a per-channel
// failure is skipped (provider hosts are flaky — the FastChannels posture). Ported from FastChannels stirr.py
// `fetch_epg` (the ctvcraft + wurl special-case parsers are NOT ported — the XMLTV + generic-JSON tiers cover
// the common providers; enriching those is a future uplift and must not fork the shared writer).
//
// ⚠️ SSRF: provider `epg_url`s are UPSTREAM-CONTROLLED third-party hosts (unlike every other EPG fetch, which
// targets a known host) — each is gated by `isPrivateHost` (block loopback/link-local/private literals) + an
// AbortSignal timeout before fetch, so a malicious catalog can't point the server at the internal network or
// hang the sync. (Defends IP-literal targets only; DNS-rebinding is out of scope — the same caveat core/ssrf.ts
// documents.)
//
// ⚠️ Composite guide-key convention (composeGuide.ts): EpgChannel._id / Program.channelId are "stirr:<videoid>",
// joined to a PlaylistChannel by `${epg}:${tvg_id}`. linkFastSelfEpg sets tvg_id=<videoid>, so each guide
// channel matches its PlaylistChannel _id "stirr:<videoid>".

import { writeFastEpg } from './fastSelfEpg.js';
import { parseXmltv, parseXmltvTime } from './xmltvIngest.js';
import { logger } from '../sources/core/logger.js';
import { isPrivateHost } from '../sources/core/ssrf.js';
import { STIRR_API_HEADERS, fetchStirrRows, stirrEpgUrl, type StirrRow } from '../sources/adapters/stirr/config.js';
import type { EpgChannelDoc } from '../models/EpgChannel.js';
import type { ProgramDoc } from '../models/Program.js';

export const STIRR_EPG_NAME = 'STIRR Schedule';
export const STIRR_EPG_URL = 'https://stirr.com/api/epg';

const SOURCE_ID = 'stirr';
const EPG_CONCURRENCY = 8; // bounded per-channel guide fetches (matches FastChannels' worker pool)
const FETCH_TIMEOUT_MS = 8000; // dead provider hosts fail fast instead of hanging the sync

function str(v: unknown): string | null {
  const s = (v == null ? '' : String(v)).trim();
  return s || null;
}

/** Fetch a guide URL's body as text, bounded by an AbortSignal timeout. Throws on a non-2xx / timeout. */
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: STIRR_API_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Parse a program timestamp → epoch ms (UTC). Accepts an ISO string (a timezone-LESS one is read as UTC — the
 * V8 "naive ISO parses as local" trap distro/epgpw also dodge), an epoch number/string (ms when ≥1e12, else
 * seconds). NaN when unparseable. (Robust replacement for FastChannels' `_parse_dt`, whose 2e12 seconds/ms
 * threshold mis-handles current-era ms values.)
 */
function parseDt(val: unknown): number {
  if (val == null) return NaN;
  if (typeof val === 'number') return Number.isFinite(val) ? (val >= 1e12 ? val : val * 1000) : NaN;
  let s = String(val).trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? (n >= 1e12 ? n : n * 1000) : NaN;
  }
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  if (!hasTz && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) s = `${s.replace(' ', 'T')}Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/** Recursively collect generic guide entries (dicts carrying a start key). Mirrors stirr.py `_extract_generic_json_programs`. */
function walkGenericPrograms(payload: any): any[] {
  const rows: any[] = [];
  const walk = (obj: any): void => {
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item);
    } else if (obj && typeof obj === 'object') {
      if ('start' in obj || 'start_time' in obj || 'starts_at' in obj) {
        rows.push(obj);
        return; // a program entry — don't recurse into it
      }
      for (const v of Object.values(obj)) walk(v);
    }
  };
  walk(payload);
  return rows;
}

/** One generic-JSON guide entry → a ProgramDoc (composite channelId), or null when title/start/end are unusable. */
function programFromEntry(
  composite: string,
  entry: any,
  offset: string,
  cat: string,
  channelNo: string | null,
): ProgramDoc | null {
  const title = str(entry?.title ?? entry?.program_title ?? entry?.name);
  const start = parseDt(entry?.start ?? entry?.start_time ?? entry?.airing_start_time);
  const end = parseDt(entry?.end ?? entry?.end_time ?? entry?.airing_end_time);
  if (!title || Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return {
    channelId: composite,
    start,
    end,
    offset,
    title,
    cat: str(entry?.category ?? entry?.genre) || cat,
    source: SOURCE_ID,
    callSign: null,
    channelNo,
    shortDesc: str(entry?.description ?? entry?.summary),
    rating: str(entry?.rating),
    seriesId: null,
    season: str(entry?.season),
    episode: str(entry?.episode),
    episodeTitle: str(entry?.episode_title ?? entry?.subtitle),
  };
}

/**
 * Parse a provider XMLTV document → this channel's ProgramDocs (reusing the shared parseXmltv/parseXmltvTime).
 * Matches programmes by the source channel id OR the provider `epg_channel_id` (case-insensitive); a single-
 * channel feed with no id match takes all programmes (the FastChannels fallback). Mirrors stirr.py
 * `_extract_programs_from_xmltv`.
 */
function programsFromXmltv(
  xml: string,
  videoId: string,
  epgChannelId: string | null,
  offset: string,
  cat: string,
  channelNo: string | null,
): ProgramDoc[] {
  const { channels, programmes } = parseXmltv(xml);
  if (!programmes.length) return [];
  const targets = new Set([videoId.toLowerCase()]);
  if (epgChannelId) targets.add(epgChannelId.toLowerCase());
  let matched = programmes.filter((p) => targets.has(p.channel.toLowerCase()));
  if (!matched.length && channels.length <= 1) matched = programmes; // single-channel feed → take all

  const composite = `${SOURCE_ID}:${videoId}`;
  const out: ProgramDoc[] = [];
  for (const p of matched) {
    const start = parseXmltvTime(p.start);
    const end = parseXmltvTime(p.stop);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
    out.push({
      channelId: composite,
      start,
      end,
      offset,
      title: p.title || 'Unknown',
      cat: p.category || cat,
      source: SOURCE_ID,
      callSign: null,
      channelNo,
      shortDesc: p.desc,
      rating: null,
      seriesId: null,
      season: null,
      episode: null,
      episodeTitle: null,
    });
  }
  return out;
}

/**
 * Build one channel's guide: provider `epg_url` first (XMLTV or generic JSON, SSRF-guarded), STIRR `/api/epg`
 * fallback second. Returns [] when neither yields programs (a guideless live channel — it stays self-linked with
 * an empty grid). Never throws (the caller's mapLimit also swallows, but a clean [] keeps the count honest).
 */
async function fetchChannelPrograms(row: StirrRow, offset: string): Promise<ProgramDoc[]> {
  const composite = `${SOURCE_ID}:${row.channelId}`;
  const channelNo = row.number != null ? String(row.number) : null;
  const cat = row.category || 'Live TV';

  // 1. Provider EPG url — third-party host (SSRF-guarded), XMLTV or generic JSON.
  if (row.epgUrl) {
    try {
      const host = new URL(row.epgUrl).hostname;
      if (!isPrivateHost(host)) {
        const text = (await fetchText(row.epgUrl)).trim();
        if (text.startsWith('<')) {
          const progs = programsFromXmltv(text, row.channelId, row.epgChannelId, offset, cat, channelNo);
          if (progs.length) return progs;
        } else if (text) {
          const progs = walkGenericPrograms(JSON.parse(text))
            .map((e) => programFromEntry(composite, e, offset, cat, channelNo))
            .filter((p): p is ProgramDoc => p !== null);
          if (progs.length) return progs;
        }
      }
    } catch {
      /* provider EPG flaky/dead — fall through to STIRR's own endpoint */
    }
  }

  // 2. STIRR fallback — its own per-channel guide (generic JSON; a 400 here is expected for some video ids).
  try {
    const progs = walkGenericPrograms(JSON.parse(await fetchText(stirrEpgUrl(row.channelId))))
      .map((e) => programFromEntry(composite, e, offset, cat, channelNo))
      .filter((p): p is ProgramDoc => p !== null);
    return progs;
  } catch {
    return [];
  }
}

/** Bounded-concurrency for-each; a single item's rejection is swallowed (skip-on-failure). */
async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
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
 * `raw`; the standalone sync fetches them live). Channel records come straight from the rows; programs are a
 * per-channel TWO-TIER fetch under bounded concurrency (§module header). Returns merged EpgChannel + Program
 * docs for a single per-source REPLACE.
 */
export async function buildStirrEpg(
  rows: StirrRow[],
  offset: string,
): Promise<{ channelDocs: EpgChannelDoc[]; programDocs: ProgramDoc[] }> {
  const channelDocs: EpgChannelDoc[] = rows.map((r) => ({
    _id: `${SOURCE_ID}:${r.channelId}`,
    callSign: null,
    affiliateName: r.name,
    channelId: r.channelId,
    channelNo: r.number != null ? String(r.number) : null,
    source: SOURCE_ID,
  }));
  if (!rows.length) return { channelDocs, programDocs: [] };

  const programDocs: ProgramDoc[] = [];
  let withGuide = 0;
  await forEachLimit(rows, EPG_CONCURRENCY, async (row) => {
    const progs = await fetchChannelPrograms(row, offset);
    if (progs.length) {
      withGuide++;
      programDocs.push(...progs);
    }
  });
  logger.info(
    'epg',
    `[${SOURCE_ID}] guide: ${withGuide}/${rows.length} channels carried programs (${programDocs.length} total)`,
  );
  return { channelDocs, programDocs };
}

/**
 * Standalone EPG sync (the EPG Sources "Sync" button + scheduler path, dispatched from syncEpgSource on
 * src.source === 'stirr'). Fetches the catalog LIVE-ONLY (no snapshot fallback: a transient outage should fail
 * loudly → status 'error' → the existing guide is preserved) and per-source replaces the guide. EPG-ONLY: never
 * touches the stirr playlist or its channel links (that direction is the playlist sync's afterSync hook).
 */
export async function syncStirrEpg(
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const rows = await fetchStirrRows();
  const { channelDocs, programDocs } = await buildStirrEpg(rows, offset);
  return writeFastEpg(sourceId, channelDocs, programDocs);
}
