// STIRR — shared leaf constants + the catalog walk, the sentinel/resolve helpers, and the name/category/url
// cleaners, imported by BOTH the adapter (sources/adapters/stirr.ts) and the EPG module (epg/stirr.ts), so
// neither imports the other (an acyclic leaf, mirroring adapters/xumo/config.ts + adapters/distro/config.ts).
// STIRR is the NINTH FastChannels FAST source ported (Sinclair's STIRR, stirr.com) and — like xumo — a
// SENTINEL + RESOLVE source, NOT direct-HLS: the `videos/list` catalog yields only video ids + provider EPG
// pointers, and the playable master is minted on demand. So normalize() stores a `…/playable` ENTRY url (the
// dlhd/xumo posture — a real-looking URL whose video id is all that matters) and resolveStream() does ONE
// resolve hop PER PLAY:
//   POST /api/v2/videos/<videoid>/playable  → data[0].media[0]  (an aniview SSAI master, `[vx_nonce]` filled)
// The guide is a SEPARATE, per-channel TWO-TIER fetch (epg/stirr.ts): each catalog row carries a provider
// `epg_url` (+ `epg_channel_id`) tried first (XMLTV or generic JSON), with STIRR's own `/api/epg?channel_id=…`
// as the fallback. No auth, no per-user surface. Ported from FastChannels stirr.py (724 LOC).
//
// ⚠️ The plan sketch ("partner M3U + webpage scrape") predates the live FastChannels reference: stirr.py uses
// the JSON `videos/list` catalog API + a `/playable` POST resolve — i.e. the xumo SENTINEL+RESOLVE shape — not
// an M3U scrape. This port follows the live reference (the source of truth), like the xumo/distro phases did.

import { randomBytes } from 'node:crypto';

// ── endpoints ────────────────────────────────────────────────────────────────────

/** The full live catalog (all categories, live linear `content_type=4`, unpaginated). */
export const CHANNELS_URL =
  'https://stirr.com/api/videos/list/?categories=all_categories&content_type=4&no_limit=true';

/** Per-video playable resolve (POST → `data[0].media[0]`); resolve hop 1 (the only hop). */
export function playableUrl(videoId: string): string {
  return `https://stirr.com/api/v2/videos/${encodeURIComponent(videoId)}/playable`;
}

/** STIRR's own per-channel guide fallback (generic JSON), used by epg/stirr.ts when the provider EPG is empty. */
export function stirrEpgUrl(channelId: string): string {
  return `https://stirr.com/api/epg?channel_id=${encodeURIComponent(channelId)}&tz=UTC`;
}

// stirr.com is a desktop web client (Origin/Referer gated on its API hops); match its UA. The CDN stream hops
// (aniview SSAI master/variant/segment) need only the UA (the proxy's upstreamHeaders), so Origin/Referer are
// sent ONLY on the catalog + resolve API hops. Ported from FastChannels stirr.py session headers.
export const UA =
  process.env.STIRR_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/** Full headers for the JSON API hops (catalog / playable resolve / STIRR fallback EPG) — Origin/Referer gated. */
export const STIRR_API_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://stirr.com',
  Referer: 'https://stirr.com/',
};

/** Headers for the CDN stream hops (master/variant/segment) — UA only (the aniview SSAI host ignores Origin). */
export const STIRR_STREAM_HEADERS: Record<string, string> = { 'User-Agent': UA };

// SSRF allowlist seed for the stream proxy — the registrable CDN families STIRR's resolved masters live on. The
// resolved master is an aniview SSAI host (ssai.aniview.com) and the ad-stitched variant/segment hops land on a
// tail of provider/CDN hosts; the adapter's dynamic allow-set pre-allows the resolved master host at play time
// (resolveStream) + learns child variant/segment hosts during playlist rewrite (onPlaylistChildHost), so a host
// that appears mid-stream is covered without a code change — private IPs are always blocked.
export const STIRR_SUFFIXES = [
  'stirr.com',
  'aniview.com',
  'weathernationtv.com',
  'cloudfront.net',
  'akamaized.net',
  'amazonaws.com',
  'fastly.net',
  'llnwd.net',
  'b-cdn.net',
];

// ── small JSON fetch helper (API hops) ───────────────────────────────────────────

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, headers: STIRR_API_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function str(v: unknown): string | null {
  const s = (v == null ? '' : String(v)).trim();
  return s || null;
}

function coerceInt(v: unknown): number | null {
  if (v == null) return null;
  const n = Number.parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// ── sentinel entry url (the video id is the only stored handle to a per-play master) ──
// normalize() stores `/api/v2/videos/<id>/playable` as the channel ENTRY (the dlhd/xumo posture: a real-looking
// URL whose id is all that matters). isStirrEntry gates it; channelIdFromEntry parses the id back out for resolve.

export function channelEntryUrl(videoId: string): string {
  return playableUrl(videoId);
}

export function isStirrEntry(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().endsWith('stirr.com') && /^\/api\/v2\/videos\/[^/]+\/playable$/i.test(u.pathname);
  } catch {
    return false;
  }
}

export function channelIdFromEntry(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/^\/api\/v2\/videos\/([^/]+)\/playable$/i);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

// ── url sanitize (provider epg_url cleanup at catalog time) ───────────────────────

// File extensions that mean a value is a filename, not a URL hostname (a malformed provider `epg_url`).
const FILE_EXTS = new Set(['xml', 'json', 'm3u8', 'm3u', 'csv', 'txt', 'zip']);

/**
 * Strip whitespace, add a missing scheme, and validate a provider `epg_url` looks like a real http(s) URL —
 * else return null (the row then falls back to STIRR's own /api/epg). Mirrors FastChannels stirr.py
 * `_sanitize_url` (the HTML-entity decode is unnecessary — the catalog returns plain JSON strings).
 */
export function sanitizeUrl(raw: string | null | undefined): string | null {
  let url = String(raw ?? '').trim();
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const netloc = parsed.hostname.toLowerCase();
  if (!netloc || !netloc.includes('.')) return null;
  const tld = netloc.slice(netloc.lastIndexOf('.') + 1);
  if (FILE_EXTS.has(tld)) return null; // a "Foo_2024.xml"-style netloc — not a host
  return parsed.toString();
}

// ── name normalization (STIRR carries hundreds of local-news channels) ────────────

// Ported from FastChannels stirr.py CATEGORY_MAP — the STIRR "… Live"/series buckets → a normalized group label.
const CATEGORY_MAP: Record<string, string> = {
  'News Flash Live': 'News',
  'Sports Live': 'Sports',
  'Entertainment Live': 'Entertainment',
  'Music Live': 'Music',
  'Food and Fitness Live': 'Lifestyle',
  'Comedy Live': 'Comedy',
  'Shopping Live': 'Shopping',
  'Default Category': 'General',
  'Crime Files': 'Crime',
  'Documentary Series': 'Documentary',
  'STIRR Kids': 'Kids',
  'Finance and Business': 'Business',
  'Paranormal Series': 'Entertainment',
  'Science to Space, Amplified': 'Science',
  'Pack your Bag Travel': 'Travel',
};

/**
 * Simplify a STIRR local-news channel name — `"FOX 9 - WTOV - (Steubenville, OH)"` → `"FOX 9 Steubenville OH"` —
 * applied ONLY when the name carries the `" - (Location)"` pattern AND the location looks geographic (a comma,
 * an ampersand, or a trailing 2-letter state code). Mirrors FastChannels stirr.py `_normalize_local_news_name`.
 */
function normalizeLocalNewsName(name: string): string {
  if (!name.includes(' - (')) return name;
  const m = /\(([^)]+)\)\s*(?:#(\d+))?\s*$/.exec(name);
  if (!m) return name;
  const locationRaw = m[1];
  const numberSuffix = m[2];
  if (!locationRaw.includes(',') && !locationRaw.includes('&') && !/\b[A-Z]{2}$/.test(locationRaw)) return name;

  const location = locationRaw.replace(/,/g, '').replace(/\s+/g, ' ').trim();
  let prefix = name.slice(0, m.index).replace(/[\s-]+$/, '').trim();

  // Drop a trailing standalone callsign segment (last " - WXYZ", 2–5 all-caps).
  const parts = prefix.split(/\s+-\s+/);
  if (parts.length > 1 && /^[A-Z]{2,5}$/.test(parts[parts.length - 1])) parts.pop();
  prefix = parts.join(' - ').trim();

  let result = `${prefix} ${location}`.trim();
  if (numberSuffix) result += ` ${numberSuffix}`;
  return result.trim();
}

/** Clean a STIRR channel name (trim odd whitespace/asterisks, collapse runs, then the local-news simplifier). */
function normalizeName(raw: string): string {
  let name = raw.replace(/^[\s\t ]+|[\s\t ]+$/g, '').replace(/\*/g, '');
  name = name.replace(/ {2,}/g, ' ');
  name = name.replace(/\s*-\s*\(/g, ' - (');
  name = normalizeLocalNewsName(name);
  return name.trim();
}

// ── catalog → trimmed rows ─────────────────────────────────────────────────────────

// One catalog row, trimmed to exactly what normalize() + the EPG builder need (drops the many unused catalog
// fields so the committed snapshot stays lean). `epgUrl`/`epgChannelId` carry the provider guide pointer the
// two-tier self-EPG fetch (epg/stirr.ts) needs — kept on the row so the snapshot round-trips them. `number` is
// the catalog `channel_number` (the guide channelNo; STIRR carries no number on the SourceChannel itself).
export interface StirrRow {
  channelId: string; // videoid
  name: string;
  logo: string | null;
  category: string; // mapped grouping label (fallback 'Live TV')
  number: number | null; // channel_number (guide channelNo)
  epgUrl: string | null; // provider EPG url (sanitized) — self-EPG primary
  epgChannelId: string | null; // provider EPG channel id — XMLTV channel match
}

/** Recursively collect catalog rows (dicts carrying both `videoid` + `title`), deduped by videoid. */
function extractChannelRows(payload: any): any[] {
  const rows: any[] = [];
  const walk = (obj: any): void => {
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item);
    } else if (obj && typeof obj === 'object') {
      if ('videoid' in obj && 'title' in obj) {
        rows.push(obj);
        return; // a channel row — don't recurse into it
      }
      for (const v of Object.values(obj)) walk(v);
    }
  };
  walk(payload);
  const seen = new Set<string>();
  const deduped: any[] = [];
  for (const row of rows) {
    const vid = str(row?.videoid);
    if (vid && !seen.has(vid)) {
      seen.add(vid);
      deduped.push(row);
    }
  }
  return deduped;
}

function pickSourceChannelId(row: any): string | null {
  for (const key of ['videoid', 'id', 'channel_id']) {
    const v = str(row?.[key]);
    if (v) return v;
  }
  return null;
}

/** First http(s) logo across `logo` / `thumbs` / `square_thumbs` buckets. Mirrors stirr.py `_pick_logo`. */
function pickLogo(row: any): string | null {
  const direct = str(row?.logo);
  if (direct && /^https?:\/\//i.test(direct)) return direct;
  for (const bucket of ['thumbs', 'square_thumbs']) {
    const b = row?.[bucket];
    if (b && typeof b === 'object') {
      for (const v of Object.values(b)) {
        const s = str(v);
        if (s && /^https?:\/\//i.test(s)) return s;
      }
    }
  }
  return null;
}

/** Channel category: first `categories[]` name (or `category`/`genre`), mapped via CATEGORY_MAP. */
function pickCategory(row: any): string | null {
  const cats = row?.categories;
  let raw: string | null = null;
  if (Array.isArray(cats) && cats.length) {
    const first = cats[0];
    raw = str(first && typeof first === 'object' ? first.category_name ?? first.name : first);
  } else {
    raw = str(row?.category ?? row?.genre);
  }
  if (!raw) return null;
  return CATEGORY_MAP[raw] ?? raw;
}

/** Trim one catalog row → a lean StirrRow, or null when it has no usable video id. */
function trimRow(row: any): StirrRow | null {
  const id = pickSourceChannelId(row);
  if (!id) return null;
  const name = normalizeName(str(row?.title) || str(row?.name) || str(row?.channel_name) || `STIRR ${id}`);
  return {
    channelId: id,
    name,
    logo: pickLogo(row),
    category: pickCategory(row) || 'Live TV',
    number: coerceInt(row?.channel_number),
    epgUrl: sanitizeUrl(row?.epg_url),
    epgChannelId: str(row?.epg_channel_id),
  };
}

/**
 * LIVE catalog fetch → trimmed StirrRow[]. Walks the payload for {videoid,title} rows, dedupes by id, and trims
 * each. No snapshot fallback here (that's the adapter's listChannels wrapper): the standalone EPG sync
 * (epg/stirr.ts) needs a live-only fetch that throws on failure so a transient outage preserves the existing
 * guide. Throws on HTTP error or an empty catalog.
 */
export async function fetchStirrRows(): Promise<StirrRow[]> {
  const payload = await getJson(CHANNELS_URL);
  const rows: StirrRow[] = [];
  for (const raw of extractChannelRows(payload)) {
    const row = trimRow(raw);
    if (row) rows.push(row);
  }
  if (!rows.length) throw new Error('catalog payload had no channels');
  return rows;
}

// ── stream resolve (1-hop POST, per play) ──────────────────────────────────────────

/** Pull the master URL out of a playable payload — `data[0].media[0]` (list) or `.media` (string). */
function extractMediaUrl(payload: any): string | null {
  const data = payload?.data;
  if (Array.isArray(data) && data.length) {
    const media = data[0]?.media;
    if (Array.isArray(media) && media.length) return str(media[0]);
    if (typeof media === 'string') return str(media);
  }
  return null;
}

/**
 * Fill the aniview SSAI `[vx_nonce]` placeholder with a fresh per-play hex nonce. FastChannels' `resolve()`
 * returns the master un-filled (its player fills it), but masqueradarr's proxy fetches the master directly — an
 * un-filled `[vx_nonce]` makes aniview answer 422 — so we fill it here (the same fill FastChannels' audit path
 * does). Other bracket macros (rare) are left intact.
 */
function fillNonce(url: string): string {
  return url.includes('[vx_nonce]') ? url.split('[vx_nonce]').join(randomBytes(16).toString('hex')) : url;
}

/**
 * Resolve a video id → a fresh HLS master url (the 1-hop POST resolve). Throws an actionable error when the
 * channel has no playable media (the proxy maps it to a 502 + the B-Roll "failed" slate). The caller (the
 * adapter's resolveStream) pre-allows the resolved host so the proxy's SSRF gate passes the master's child hops.
 */
export async function resolveStirrMaster(videoId: string): Promise<string> {
  const payload = await getJson(playableUrl(videoId), { method: 'POST' });
  const media = extractMediaUrl(payload);
  if (!media) throw new Error(`stirr: no playable media for video ${videoId}`);
  return fillNonce(media);
}
