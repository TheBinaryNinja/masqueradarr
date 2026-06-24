// Gracenote (tvlistings.gracenote.com) EPG integration — pure fetch + map helpers, no Express, no Mongo.
//
// Two upstream endpoints back this:
//   · getPostalCodeProviders → the list of TV providers for a ZIP (the user picks one)
//   · /api/grid              → the EPG grid (channels + events) for a chosen provider
//
// Gracenote sits behind AWS WAF: datacenter IPs can get an HTML CAPTCHA challenge instead of JSON. We send
// browser-like headers (mirrors sources/adapters/dulo.ts) and detect a non-JSON response, throwing a tagged
// error so the route can return a clean 502 (graceful degrade — no headless-browser fallback today). `start`/`end`
// are mapped from Gracenote's ISO-8601 UTC strings to epoch MS via Date.parse. See restapi.md + schemas.md.

import type { ProgramDoc } from '../models/Program.js';
import type { EpgChannelDoc } from '../models/EpgChannel.js';
import { toEpgChannelDocFromGracenote } from './toEpgChannel.js';

const GRACENOTE_ORIGIN = 'https://tvlistings.gracenote.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const GRACENOTE_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  Referer: `${GRACENOTE_ORIGIN}/`,
  Origin: GRACENOTE_ORIGIN,
};

// ──────────────────────────────────────────────────────────────────────
// Wire shapes (upstream boundary — intentionally permissive)
// ──────────────────────────────────────────────────────────────────────

export interface GracenoteProvider {
  type: string;       // 'OTA' | 'CABLE' | 'SATELLITE'
  device: string;     // '' | 'X'
  lineupId: string;
  name: string;
  location: string;
  timezone: string;
  postalCode: string;
  headendId: string;
}

export interface ProvidersResult {
  providers: GracenoteProvider[];
  tz: { dstUtcOffset: string | null; stdUtcOffset: string | null; primetime: string | null };
}

export interface GridSampleItem {
  channelNo: string | null;
  callSign: string | null;
  title: string;
  start: number; // epoch ms
  end: number;   // epoch ms
}

export interface GridSummary {
  headendName: string | null;
  channelCount: number;
  programCount: number;
  sample: GridSampleItem[];
}

export interface GridBuildParams {
  aid: string;
  country: string;
  lang: string;
  timespan: number;
}

// ──────────────────────────────────────────────────────────────────────
// Fetch (with WAF/HTML guard)
// ──────────────────────────────────────────────────────────────────────

// Read a Gracenote response as JSON, or throw a tagged error when the WAF returns an HTML challenge.
async function readJson(res: Response, what: string): Promise<any> {
  if (!res.ok) throw new Error(`gracenote ${what}: HTTP ${res.status}`);
  const text = await res.text();
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) throw new Error(`gracenote ${what}: blocked (HTML/CAPTCHA response)`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`gracenote ${what}: non-JSON response`);
  }
}

export async function fetchProviders(
  country: string,
  postalCode: string,
  aid: string,
  lang: string,
): Promise<ProvidersResult> {
  const url = `${GRACENOTE_ORIGIN}/gapzap_webapi/api/Providers/getPostalCodeProviders/${encodeURIComponent(
    country,
  )}/${encodeURIComponent(postalCode)}/${encodeURIComponent(aid)}/${encodeURIComponent(lang)}`;
  const body = await readJson(await fetch(url, { headers: GRACENOTE_HEADERS }), 'providers');
  const list: any[] = Array.isArray(body?.Providers) ? body.Providers : [];
  const providers: GracenoteProvider[] = list.map((p) => ({
    type: String(p?.type ?? ''),
    device: String(p?.device ?? ''),
    lineupId: String(p?.lineupId ?? ''),
    name: String(p?.name ?? ''),
    location: String(p?.location ?? ''),
    timezone: String(p?.timezone ?? ''),
    postalCode: String(p?.postalCode ?? postalCode),
    headendId: String(p?.headendId ?? ''),
  }));
  return {
    providers,
    tz: {
      dstUtcOffset: body?.DSTUTCOffset ?? null,
      stdUtcOffset: body?.StdUTCOffset ?? null,
      primetime: body?.primetime ?? null,
    },
  };
}

// Build the stored grid URL TEMPLATE — trailing `time=` is left blank to fill at sync (fillTime).
export function buildGridUrl(p: GracenoteProvider, opts: GridBuildParams): string {
  const params = new URLSearchParams({
    lineupId: p.lineupId,
    timespan: String(opts.timespan),
    headendId: p.headendId,
    country: opts.country,
    timezone: p.timezone ?? '',
    device: p.device ?? '',
    postalCode: p.postalCode,
    isOverride: 'true',
    pref: '16,128',
    userId: '-',
    aid: opts.aid,
    languagecode: opts.lang,
  });
  return `${GRACENOTE_ORIGIN}/api/grid?${params.toString()}&time=`;
}

// Fill the trailing (or any) `time=` with a unix-SECONDS epoch.
export function fillTime(url: string, unixSeconds: number): string {
  if (/[?&]time=\d*$/.test(url)) return url.replace(/(time=)\d*$/, `$1${unixSeconds}`);
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}time=${unixSeconds}`;
}

export async function fetchGrid(url: string): Promise<any> {
  return readJson(await fetch(url, { headers: GRACENOTE_HEADERS }), 'grid');
}

// Multi-window grid fetch cadence. Each window advances by the full timespan, so windows are contiguous;
// any boundary overlap is absorbed by the (channelId, start, end) dedupe in syncPrograms.
export const GRID_TIMESPAN_HOURS = 6; // mirrors the timespan baked into the url template
export const GRID_STEP_HOURS = GRID_TIMESPAN_HOURS; // step by the full window (no gap)
export const GRID_WINDOW_COUNT = 12; // 4 windows/day × 3 days (72h = 3 days)

// Unix-SECONDS start time for each window, beginning at the current UTC day's 00:00 (the spec's
// "current day at 12:00 AM"). Caller fills each into the url template's trailing `time=` via fillTime.
export function gridWindowTimes(nowMs: number): number[] {
  const dayStart = Math.floor(nowMs / 1000 / 86400) * 86400; // today's UTC midnight (epoch seconds)
  return Array.from({ length: GRID_WINDOW_COUNT }, (_, n) => dayStart + n * GRID_STEP_HOURS * 3600);
}

// ──────────────────────────────────────────────────────────────────────
// Map / summarize
// ──────────────────────────────────────────────────────────────────────

// Category from the event filter (e.g. 'filter-news' → 'News'); falls back to 'Other'.
function deriveCat(e: any): string {
  const raw = Array.isArray(e?.filter) ? e.filter[0] : null;
  if (typeof raw === 'string' && raw) {
    const word = raw.replace(/^filter-/, '');
    return word ? word.charAt(0).toUpperCase() + word.slice(1) : 'Other';
  }
  return 'Other';
}

function str(v: unknown): string | null {
  return v == null || v === '' || v === 'null' ? null : String(v);
}

export function summarizeGrid(grid: any): GridSummary {
  const channels: any[] = Array.isArray(grid?.channels) ? grid.channels : [];
  let programCount = 0;
  const sample: GridSampleItem[] = [];
  for (const c of channels) {
    const events: any[] = Array.isArray(c?.events) ? c.events : [];
    programCount += events.length;
    if (sample.length < 5) {
      for (const e of events) {
        if (sample.length >= 5) break;
        sample.push({
          channelNo: str(e?.channelNo ?? c?.channelNo),
          callSign: str(c?.callSign ?? e?.callSign),
          title: String(e?.program?.title ?? e?.callSign ?? 'Program'),
          start: Date.parse(e?.startTime),
          end: Date.parse(e?.endTime),
        });
      }
    }
  }
  return {
    headendName: str(grid?.headendname),
    channelCount: channels.length,
    programCount,
    sample,
  };
}

// Project the grid's channels (depth=1) into EpgChannelDoc rows tagged with the owning EPG source id.
// Delegates each channel's field mapping to the per-source hub (toEpgChannel.ts), drops channels with no
// id, and dedupes by `_id` ("<source>:<channelId>") so the downstream insertMany can't collide.
export function mapGridToEpgChannels(grid: any, sourceId: string): EpgChannelDoc[] {
  const channels: any[] = Array.isArray(grid?.channels) ? grid.channels : [];
  const byId = new Map<string, EpgChannelDoc>();
  for (const c of channels) {
    const doc = toEpgChannelDocFromGracenote(c as Record<string, unknown>, sourceId);
    if (doc && !byId.has(doc._id)) byId.set(doc._id, doc);
  }
  return [...byId.values()];
}

// Project the grid into flat ProgramDoc rows tagged with the owning EPG source id. `offset` is the operator's
// UTC offset stamped onto every row (settings.offset; '+0000' when unset) — start/end stay UTC epoch-ms.
export function mapGridToPrograms(grid: any, sourceId: string, offset: string): ProgramDoc[] {
  const channels: any[] = Array.isArray(grid?.channels) ? grid.channels : [];
  const docs: ProgramDoc[] = [];
  for (const c of channels) {
    const channelId = str(c?.channelId);
    if (!channelId) continue;
    const events: any[] = Array.isArray(c?.events) ? c.events : [];
    for (const e of events) {
      const start = Date.parse(e?.startTime);
      const end = Date.parse(e?.endTime);
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      const prog = e?.program ?? {};
      docs.push({
        // Composite key `<source>:<channelId>` — matches epgchannels._id AND EPG-PW's program key, so a
        // linked PlaylistChannel resolves its guide via `${channel.epg}:${channel.tvg_id}` uniformly.
        channelId: `${sourceId}:${channelId}`,
        start,
        end,
        offset,
        title: String(prog?.title ?? e?.callSign ?? 'Program'),
        cat: deriveCat(e),
        source: sourceId,
        callSign: str(c?.callSign ?? e?.callSign),
        channelNo: str(e?.channelNo ?? c?.channelNo),
        shortDesc: str(prog?.shortDesc),
        rating: str(e?.rating),
        seriesId: str(e?.seriesId ?? prog?.seriesId),
        season: str(prog?.season),
        episode: str(prog?.episode),
        episodeTitle: str(prog?.episodeTitle),
      });
    }
  }
  return docs;
}
