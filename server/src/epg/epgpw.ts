// EPG-PW (epg.pw) integration — pure fetch + parse helpers, no Express, no Mongo (mirrors gracenote.ts).
//
// Unlike Gracenote, epg.pw serves HTML (the region list, the per-region channel table) and XML (each
// channel's guide) — and has NO bulk program endpoint, so a sync fetches each channel's XML separately.
// We parse with whitespace/newline-tolerant regex (no parser dep) and send browser-like headers; a non-OK
// response throws a tagged error so the route can return a clean 502 (epgpw_unreachable). Program start/stop
// arrive as "YYYYMMDDHHmmss ±HHMM" (NOT ISO) → parseEpgpwTime maps them to epoch MS. See restapi.md + schemas.md.

import type { ProgramDoc } from '../models/Program.js';

const EPGPW_BASE = 'https://epg.pw';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const EPGPW_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  Referer: `${EPGPW_BASE}/`,
  Origin: EPGPW_BASE,
};

// ──────────────────────────────────────────────────────────────────────
// Wire shapes (upstream boundary)
// ──────────────────────────────────────────────────────────────────────

export interface EpgpwRegion {
  label: string;   // e.g. 'USA'
  href: string;    // e.g. '/areas/us.html?lang=en'
  code: string;    // e.g. 'us'
}

export interface EpgpwRawChannel {
  channelId: string;
  affiliateName: string;
}

export interface EpgpwRawEvent {
  start: number;   // epoch ms
  end: number;     // epoch ms
  title: string;
  desc: string | null;
}

export interface EpgpwSampleItem {
  channelNo: string | null;
  callSign: string | null;
  title: string;
  start: number;   // epoch ms
  end: number;     // epoch ms
}

export interface EpgpwSummary {
  regionName: string | null;
  channelCount: number;
  sample: EpgpwSampleItem[];
}

// ──────────────────────────────────────────────────────────────────────
// Fetch (with non-OK guard)
// ──────────────────────────────────────────────────────────────────────

// Read an epg.pw response as text, or throw a tagged error on a non-OK status (→ 502 epgpw_unreachable).
async function readText(res: Response, what: string): Promise<string> {
  if (!res.ok) throw new Error(`epgpw ${what}: HTTP ${res.status}`);
  return res.text();
}

// ──────────────────────────────────────────────────────────────────────
// Small parse helpers
// ──────────────────────────────────────────────────────────────────────

// Decode the handful of HTML entities epg.pw emits in anchor/title text.
export function decodeEntities(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

// Today's date as a UTC YYYYMMDD string (the &date= the channel XML expects).
export function todayYmd(): string {
  const d = new Date();
  return (
    String(d.getUTCFullYear()) +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0')
  );
}

// Parse an epg.pw time "YYYYMMDDHHmmss ±HHMM" → epoch ms. Builds the UTC instant from the digits, then
// subtracts the signed offset (a +0000 stamp is already UTC). Returns NaN on an unparseable value.
export function parseEpgpwTime(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})$/.exec(String(s).trim());
  if (!m) return NaN;
  const [, yy, mo, dd, hh, mm, ss, sign, oh, om] = m;
  const base = Date.UTC(
    Number(yy),
    Number(mo) - 1,
    Number(dd),
    Number(hh),
    Number(mm),
    Number(ss),
  );
  const offsetMs = (Number(oh) * 60 + Number(om)) * 60_000 * (sign === '-' ? -1 : 1);
  return base - offsetMs;
}

// ──────────────────────────────────────────────────────────────────────
// Region list  (HTML)
// ──────────────────────────────────────────────────────────────────────

// Parse the area navbar-dropdown into the list of regions. The SECOND `navbar-dropdown` block is the area
// list; the post-divider "All channels" global entry (after the <hr class="navbar-divider">) is dropped.
export async function fetchRegions(): Promise<EpgpwRegion[]> {
  const html = await readText(await fetch(`${EPGPW_BASE}/index.html?lang=en`, { headers: EPGPW_HEADERS }), 'regions');

  // Grab every navbar-dropdown block; the area list is the one whose anchors point at /areas/.
  const blocks = html.match(/<div[^>]*class="[^"]*navbar-dropdown[^"]*"[^>]*>[\s\S]*?<\/div>/g) || [];
  let areaBlock = '';
  for (const b of blocks) {
    if (/\/areas\/[a-z0-9_-]+\.html/i.test(b)) {
      areaBlock = b;
      break;
    }
  }
  if (!areaBlock) areaBlock = html; // fall back to scanning the whole page

  // Cut off anything after the divider — that is the global "All channels" entry, which we omit.
  const dividerAt = areaBlock.search(/<hr[^>]*navbar-divider/i);
  const scope = dividerAt >= 0 ? areaBlock.slice(0, dividerAt) : areaBlock;

  // Whitespace-tolerant: attributes and the label can span multiple lines.
  const re = /<a[^>]*href="(\/areas\/([a-z0-9_-]+)\.html[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const out: EpgpwRegion[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope)) !== null) {
    const href = m[1];
    const code = m[2];
    const label = decodeEntities(m[3].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
    if (!label || seen.has(code)) continue;
    seen.add(code);
    out.push({ label, href, code });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Region channel table  (HTML)
// ──────────────────────────────────────────────────────────────────────

// Fetch a region's channel table → the channel id + affiliate name for each `/last/<id>.html` anchor.
export async function fetchRegionChannels(href: string): Promise<EpgpwRawChannel[]> {
  const url = href.startsWith('http') ? href : `${EPGPW_BASE}${href}`;
  const html = await readText(await fetch(url, { headers: EPGPW_HEADERS }), 'region channels');

  const re = /<a[^>]*href="\/last\/(\d+)\.html[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const out: EpgpwRawChannel[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const channelId = m[1];
    if (seen.has(channelId)) continue;
    const affiliateName = decodeEntities(m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
    seen.add(channelId);
    out.push({ channelId, affiliateName: affiliateName || channelId });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Channel guide  (XML)
// ──────────────────────────────────────────────────────────────────────

// Fetch one channel's guide XML for a date (UTC YYYYMMDD) → its programme events. Events with an
// unparseable start/stop time are skipped.
export async function fetchChannelXml(channelId: string, date: string): Promise<EpgpwRawEvent[]> {
  const url = `${EPGPW_BASE}/api/epg.xml?lang=en&date=${encodeURIComponent(date)}&channel_id=${encodeURIComponent(channelId)}`;
  const xml = await readText(await fetch(url, { headers: EPGPW_HEADERS }), 'channel xml');

  const out: EpgpwRawEvent[] = [];
  const re = /<programme\b[^>]*\bstart="([^"]*)"[^>]*\bstop="([^"]*)"[^>]*>([\s\S]*?)<\/programme>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const start = parseEpgpwTime(m[1]);
    const end = parseEpgpwTime(m[2]);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const inner = m[3];
    const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(inner)?.[1] || '').replace(/<[^>]*>/g, ' '));
    const descRaw = /<desc[^>]*>([\s\S]*?)<\/desc>/i.exec(inner)?.[1];
    const desc = descRaw != null ? decodeEntities(descRaw.replace(/<[^>]*>/g, ' ')) || null : null;
    out.push({ start, end, title: title || 'Program', desc });
  }
  return out;
}

// Project a channel's events into flat ProgramDoc rows tagged with the owning EPG source id. cat falls back
// to 'Other' (epg.pw has no category); the extended Gracenote-only fields stay null (never fabricated).
// `offset` is the operator's UTC offset stamped onto every row (settings.offset) — start/end stay UTC epoch-ms.
export function mapEventsToPrograms(
  channelId: string,
  events: EpgpwRawEvent[],
  sourceId: string,
  offset: string,
): ProgramDoc[] {
  return events.map((e) => ({
    channelId,
    start: e.start,
    end: e.end,
    offset,
    title: e.title,
    cat: 'Other',
    source: sourceId,
    callSign: null,
    channelNo: null,
    shortDesc: e.desc,
    rating: null,
    seriesId: null,
    season: null,
    episode: null,
    episodeTitle: null,
  }));
}

// ──────────────────────────────────────────────────────────────────────
// Preview summary (modal)
// ──────────────────────────────────────────────────────────────────────

// A short summary for the Add modal: the region's channel count + a small program sample from the first
// channel (so the user sees real titles before committing to the full inline sync).
export async function summarizeEpgpw(href: string, regionName: string | null): Promise<EpgpwSummary> {
  const channels = await fetchRegionChannels(href);
  const sample: EpgpwSampleItem[] = [];
  if (channels.length) {
    try {
      const events = await fetchChannelXml(channels[0].channelId, todayYmd());
      for (const e of events) {
        if (sample.length >= 5) break;
        sample.push({
          channelNo: null,
          callSign: channels[0].affiliateName,
          title: e.title,
          start: e.start,
          end: e.end,
        });
      }
    } catch {
      // A sample failure shouldn't fail the preview — the channel count is the headline number.
    }
  }
  return { regionName, channelCount: channels.length, sample };
}
