// Whale TV+ — shared leaf constants + the auth-token bootstrap + live catalog fetch, imported by BOTH the
// adapter (sources/adapters/whale.ts) and the EPG module (epg/whale.ts), so neither imports the other (an
// acyclic leaf, mirroring adapters/lg/config.ts + adapters/vidaa/config.ts). Whale is the FIFTH FastChannels
// FAST source, served from the rlaxx/zeasn.tv platform (Whale TV+ = the watch.whaletvplus.com web client). It
// is direct-HLS + PER-PLAY macro expansion — the LG posture: each channel's `chlUrl` IS the real HLS master
// (pathname ends .m3u8), but carries Ottera/SSAI ad-targeting macros ([did]/[session_id]/[cachebuster]/…) in
// its query string that must be FRESH per play, so resolveStream expands them at play time (the FastChannels
// whale.py `_fill_url_macros` posture) rather than baking a subset in at normalize. ONE twist vs LG: a cheap
// AUTH BOOTSTRAP — a keyless apiToken → short-lived bearer `token` exchange (auth/access) gates both the
// catalog and the /epg fetch (no USER credentials; this is NOT a per-user auth surface like dulo). The guide
// is a SEPARATE /epg fetch (epg/whale.ts), batched by channel id like Vidaa's grid — not inline like LG.

import { randomUUID } from 'node:crypto';

const PLATFORM = 'https://rlaxx.zeasn.tv/livetv/api';

/** Keyless app token → short-lived bearer `token` exchange (no user credentials). */
export const AUTH_URL = `${PLATFORM}/v1/auth/access`;
/** Category → channels catalog (token-gated). { data:[ { ctgName, channels:[ { chlId, chlUrl, … } ] } ] }. */
export const CHANNELS_URL = `${PLATFORM}/device/browser/v1/category/channels`;
/** Schedule grid (token-gated), keyed by comma-joined channelIds + a ms time window. */
export const EPG_URL = `${PLATFORM}/device/browser/v1/epg`;

// The public apiToken the Whale TV+ web client ships with (ported verbatim from FastChannels whale.py). It is
// NOT a secret — it identifies the Browser app to rlaxx's auth endpoint, which mints the real per-session bearer.
const API_TOKEN = '4ef13b5f3d2744e3b0a569feb8dde298';

// White-label channel logos live under one CDN prefix, addressed by imageIdentifier (e.g. 'watchmojo' →
// .../icon-white/watchmojo_white.png). Ported from FastChannels whale.py _LOGO_BASE.
const LOGO_BASE =
  'https://d3b6luslimvglo.cloudfront.net/images/79/rlaxximages/channels-rescaled/icon-white';

// watch.whaletvplus.com is a browser web client (Origin/Referer gated); send a desktop browser UA + the web
// app's Origin/Referer. Ported from FastChannels whale.py _HEADERS.
export const UA =
  process.env.WHALE_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

export const WHALE_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Origin: 'https://watch.whaletvplus.com',
  Referer: 'https://watch.whaletvplus.com/',
  Accept: 'application/json, text/plain, */*',
};

// EPG window + batching (ported from FastChannels whale.py). The /epg endpoint takes comma-joined channelIds;
// the web client batches 10 at a time over a 7-day look-ahead.
export const EPG_DAYS = 7;
export const EPG_BATCH_SIZE = 10;

// SSRF allowlist seed for the stream proxy — the registrable CDN families Whale's masters live on (from the
// live catalog: Amagi ~31%, SoFast ~18%, AWS/CloudFront ~15%, plus a long tail of per-brand SSAI hosts
// api-ott.<brand>.tv on Ottera, Frequency, Wurl, Broadpeak, …). Because Whale fronts MANY per-brand SSAI hosts,
// a static suffix list can't cover them all — the adapter's dynamic allow-set pre-allows each macro-expanded
// master host at play time (resolveStream) and learns child variant/segment hosts during playlist rewrite
// (onPlaylistChildHost), so a brand host that appears in the catalog is covered without a code change — private
// IPs are always blocked.
export const WHALE_SUFFIXES = [
  'amagi.tv',
  'sofast.tv',
  'amazonaws.com',
  'cloudfront.net',
  'ottera.tv',
  'frequency.stream',
  'wurl.com',
  'broadpeak.io',
  'akamaized.net',
  'b-cdn.net',
  'fastly.net',
];

// Categories that are effectively "all channels" buckets — skipped for grouping so a channel buckets by its
// real genre (it always also appears in a genre category). Ported from FastChannels whale.py _SKIP_CATEGORIES.
const SKIP_CATEGORIES = new Set(['All', 'Featured all other countries']);

// rlaxx API category bucket → canonical group label. Ported from FastChannels whale.py _CATEGORY_MAP. An
// unmapped bucket passes through unchanged (kept source-local + lean, the lg/vidaa precedent — masqueradarr
// groups by the source's own category rather than porting FastChannels' cross-source name-inference table).
const CATEGORY_MAP: Record<string, string> = {
  'Movies and Series': 'Movies',
  Documentary: 'Documentary',
  Lifestyle: 'Lifestyle',
  Music: 'Music',
  Travel: 'Travel',
  DIY: 'Home & DIY',
  'Food and Drink': 'Food',
  Sports: 'Sports',
  Motorsports: 'Sports',
  News: 'News',
  'Slow TV': 'Ambiance',
};

function canonicalCategory(bucket: string): string {
  return CATEGORY_MAP[bucket] || bucket || 'Live TV';
}

// ── per-play stream-macro expansion ───────────────────────────────────────────

// Stable per-process device id for the ad-targeting `[did]` param (mirrors FastChannels whale.py _DEVICE_ID).
const DEVICE_ID = randomUUID();

// Matches any remaining [placeholder] / [%placeholder%] ad macro left after the fixed fill — stripped to empty
// (the CDN serves the master without them). Mirrors FastChannels whale.py _MACRO_RE.
const MACRO_RE = /\[%?[^\]]+%?\]/g;

/**
 * Fill the per-play ad-targeting macros baked into a Whale (Ottera/SSAI) master, FRESH per call ([session_id]
 * new uuid, [cachebuster] current ms) — the required params ([did]/[cachebuster]/[session_id]) must be present
 * or Ottera's passthrough endpoint 500s. A pure string replace on the RAW url (NOT a re-serialized URL.href) so
 * the literal `[KEY]` tokens — which survive the proxy's encodeURIComponent/decodeURIComponent round-trip — still
 * match (the same reason lg/config.ts expandStreamMacros uses a string replace). Any unmapped macro is then
 * stripped to empty. Mirrors FastChannels whale.py _fill_url_macros.
 */
export function fillUrlMacros(url: string): string {
  if (!url) return url;
  const reps: Record<string, string> = {
    '[did]': DEVICE_ID,
    '[session_id]': randomUUID(),
    '[cachebuster]': String(Date.now()),
    '[dnt]': '0',
    '[lmt]': '0',
    '[consent]': '',
    '[content_id]': '',
    '[content_language]': 'en',
    '[content_duration]': '',
    '[content_season]': '',
    '[content_episode]': '',
  };
  let out = url;
  for (const [key, value] of Object.entries(reps)) out = out.split(key).join(value);
  return out.replace(MACRO_RE, '');
}

// ── auth-token bootstrap (cached per process) ─────────────────────────────────

const TOKEN_TTL_MS = 82_800_000; // 23 hr (the API issues ~24 hr tokens) — refresh comfortably before expiry
let tokenValue: string | null = null;
let tokenExpiry = 0;

/**
 * Fetch (and cache for the process) the short-lived bearer `token` rlaxx's auth/access mints from the public
 * apiToken — NO user credentials. Both the catalog and the /epg fetch send it as a `token` header. The cache is
 * shared across the catalog + EPG calls within a sync (and across syncs until it expires). Throws on HTTP error
 * or a missing token so the caller falls back to the snapshot / fails the EPG sync loudly. `force` bypasses the
 * cache (used after a 401 retry, mirroring FastChannels' refresh-on-failure).
 */
export async function getToken(force = false): Promise<string> {
  if (!force && tokenValue && Date.now() < tokenExpiry) return tokenValue;
  const qs = new URLSearchParams({ uuid: '1', apiToken: API_TOKEN, langCode: 'en' });
  const res = await fetch(`${AUTH_URL}?${qs}`, { headers: WHALE_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} (auth)`);
  const payload = (await res.json()) as { data?: { token?: string }; token?: string };
  const token = (payload?.data?.token || payload?.token || '').trim();
  if (!token) throw new Error('Whale auth returned no token');
  tokenValue = token;
  tokenExpiry = Date.now() + TOKEN_TTL_MS;
  return token;
}

/** The token-gated request headers (the web-client device headers + the bearer in the `token` header). */
export function tokenHeaders(token: string): Record<string, string> {
  return { ...WHALE_HEADERS, token };
}

/** The /epg grid URL for a comma-joined batch of channel ids + a ms time window (US/en, like the web client). */
export function epgUrl(channelIds: string[], startMs: number, endMs: number): string {
  const qs = new URLSearchParams({
    channelIds: channelIds.join(','),
    startTime: String(startMs),
    endTime: String(endMs),
    langCode: 'en',
    countryCode: 'US',
  });
  return `${EPG_URL}?${qs}`;
}

// ── row shape ──────────────────────────────────────────────────────────────────

// The now-airing program captured from a channel's `currentProgram` at catalog time — the ONLY description
// source for the guide (the /epg ptList carries titles + times only). epg/whale.ts maps prgchId → desc and
// stamps it onto the matching schedule entry (the FastChannels whale.py _current_prog_desc fallback).
export interface WhaleCurrentProgram {
  prgchId: string;
  desc: string;
}

// One catalog row, trimmed to exactly the fields normalize() + the EPG builder need (drops the ~20 unused
// catalog fields so the committed snapshot stays lean). `streamUrl` is the RAW (unexpanded) master —
// resolveStream fills the macros per play — so the snapshot round-trips upstream-faithfully via
// rebuild-source-seed.ts. `category` is the canonicalized genre bucket (the channel grouping + the program
// category fallback). `currentProgram` rides along for the guide's now-airing description.
export interface WhaleRow {
  channelId: string; // chlId
  name: string; // chlName
  streamUrl: string; // chlUrl (raw, macro-laden) — resolveStream fills macros per play
  logo: string | null;
  category: string; // canonicalized genre bucket
  number: number | null; // chlNum
  currentProgram: WhaleCurrentProgram | null;
}

function str(v: unknown): string | null {
  const s = (v == null ? '' : String(v)).trim();
  return s || null;
}

function parseInt10(v: unknown): number | null {
  if (v == null) return null;
  const n = Number.parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Trim one upstream channel object (within a genre bucket) to a lean WhaleRow, or null when it lacks an id /
 *  name / stream (the coarse "this becomes a streamable channel" gate). */
function trimChannel(ch: any, bucket: string): WhaleRow | null {
  const channelId = str(ch?.chlId);
  const name = str(ch?.chlName);
  const streamUrl = str(ch?.chlUrl);
  if (!channelId || !name || !streamUrl) return null;

  const imageId = str(ch?.imageIdentifier);
  const cp = ch?.currentProgram;
  const cpId = str(cp?.prgchId);
  const cpDesc = str(cp?.prgDesc);

  return {
    channelId,
    name,
    streamUrl,
    logo: imageId ? `${LOGO_BASE}/${imageId}_white.png` : null,
    category: canonicalCategory(bucket),
    number: parseInt10(ch?.chlNum),
    currentProgram: cpId && cpDesc ? { prgchId: cpId, desc: cpDesc } : null,
  };
}

/**
 * Flatten the category/channels payload into trimmed WhaleRow[]: walk categories → channels, SKIP the
 * "All"/"Featured all other countries" buckets (so a channel buckets by its real genre), dedupe by channelId
 * (first non-skipped bucket wins, mirroring FastChannels' seen-set), and drop rows missing an id / name /
 * stream.
 */
export function flattenWhaleRows(payload: any): WhaleRow[] {
  const cats = Array.isArray(payload?.data) ? payload.data : [];
  const rows: WhaleRow[] = [];
  const seen = new Set<string>();
  for (const cat of cats) {
    const bucket = str(cat?.ctgName) || '';
    if (SKIP_CATEGORIES.has(bucket)) continue;
    for (const ch of Array.isArray(cat?.channels) ? cat.channels : []) {
      const row = trimChannel(ch, bucket);
      if (!row || seen.has(row.channelId)) continue;
      seen.add(row.channelId);
      rows.push(row);
    }
  }
  return rows;
}

/**
 * LIVE catalog fetch → trimmed WhaleRow[]. Bootstraps a bearer token (keyless), then fetches the US/en catalog.
 * No snapshot fallback here (that's the adapter's listChannels wrapper): the standalone EPG sync (epg/whale.ts)
 * needs a live-only fetch that throws on failure so a transient outage fails loudly and preserves the existing
 * guide. Throws on auth/HTTP error or an empty catalog.
 */
export async function fetchWhaleRows(): Promise<WhaleRow[]> {
  const token = await getToken();
  const qs = new URLSearchParams({ langCode: 'en', countryCode: 'US' });
  const res = await fetch(`${CHANNELS_URL}?${qs}`, { headers: tokenHeaders(token) });
  if (!res.ok) throw new Error(`HTTP ${res.status} (channels)`);
  const payload = await res.json();
  const rows = flattenWhaleRows(payload);
  if (!rows.length) throw new Error('channels payload had no channels');
  return rows;
}
