// Xumo Play — shared leaf constants + the live catalog fetch + the multi-hop stream resolver, imported by BOTH
// the adapter (sources/adapters/xumo.ts) and the EPG module (epg/xumo.ts), so neither imports the other (an
// acyclic leaf, mirroring adapters/whale/config.ts + adapters/vidaa/config.ts). Xumo is the SIXTH FastChannels
// FAST source (Comcast's Xumo Play, the play.xumo.com web client), served from the Valencia MDS backend.
//
// Unlike the truly-direct FAST sources (Samsung/Vizio/LG/Vidaa/Whale, whose catalog row carries the HLS master
// itself), Xumo's catalog yields ONLY channel ids — the playable master is minted on demand, so this is a
// SENTINEL + RESOLVE source (the dlhd/dulo shape, ported onto makeFastSource): normalize() stores a broadcast.json
// ENTRY url and resolveStream() does a 3-hop resolve PER PLAY:
//   (1) channel/<id>/broadcast.json?hour=<H>  → the currently-LIVE assetId
//   (2) assets/asset/<assetId>.json            → the HLS master uri (providers[].sources[] produces mpegurl)
//   (3) processStreamUri(uri)                   → fill the ad macros ([IFA]/[DEVICE_ID]/[SESSION_ID]/…) fresh
//                                                 per play + strip the leftover [PLACEHOLDER] tokens → clean URL
// The guide is a SEPARATE paginated MARKET EPG (epg/xumo.ts) keyed by market+date+page+offset (NOT inline like
// LG, NOT channel-id-batched like Whale/Vidaa); the asset metadata rides along in each page response, so no
// per-program asset fetch is needed. No auth, no per-user surface. Ported from FastChannels xumo.py.

import { randomUUID } from 'node:crypto';

// ── endpoints / market ─────────────────────────────────────────────────────────

export const BASE_URL = 'https://valencia-app-mds.xumo.com';
/** Per-asset poster CDN (EPG program artwork — not stored, kept for parity/future uplift). */
export const IMAGE_BASE = 'https://image.xumo.com/v1/assets/asset';
/** Per-channel tile CDN (channel logos). */
export const CHANNEL_IMAGE = 'https://image.xumo.com/v1/channels/channel';

/** Market + geo selectors (env-overridable; the play.xumo.com web defaults). FastChannels uses these verbatim. */
export const MARKET_ID = String(process.env.XUMO_MARKET_ID || '10006');
export const GEO_ID = String(process.env.XUMO_GEO_ID || '2f08a9b3');

// play.xumo.com is a desktop web client (Origin/Referer gated on the API hops); match its UA. The CDN stream
// hops need only the UA (the proxy's upstreamHeaders), so Origin/Referer are sent ONLY on the resolve API hops.
export const UA =
  process.env.XUMO_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/** Full headers for the JSON API hops (catalog / broadcast / asset / EPG) — Origin/Referer gated. */
export const XUMO_API_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://play.xumo.com',
  Referer: 'https://play.xumo.com/',
};

/** Headers for the CDN stream hops (master/variant/segment) — UA only; cloudfront ignores/rejects the Origin. */
export const XUMO_STREAM_HEADERS: Record<string, string> = { 'User-Agent': UA };

// SSRF allowlist seed for the stream proxy — the registrable CDN families Xumo's masters live on. The resolved
// master is a per-distribution *.cloudfront.net host (seen live: d1s6rvbgqjbf6a.cloudfront.net), and the SSAI
// ad-stitched variant/segment hops land on a long tail of FreeWheel/Publica hosts. The adapter's dynamic
// allow-set pre-allows the macro-resolved master host at play time (resolveStream) + learns the child
// variant/segment hosts during playlist rewrite (onPlaylistChildHost), so a stitcher host that appears mid-stream
// is covered without a code change — private IPs are always blocked.
export const XUMO_SUFFIXES = [
  'cloudfront.net',
  'xumo.com',
  'xumo.tv',
  'amazonaws.com',
  'akamaized.net',
];

// ── per-process device identity (stable, like FastChannels' uuid4s) ──────────────
// One device/ifa pair per process keeps the catalog + ad/stream requests coherent with the web client. The
// raw form goes in the catalog list params; the dash-stripped form fills the stream's [DEVICE_ID] macro.
const DEVICE_ID = randomUUID();
const IFA_ID = randomUUID();

// ── EPG pagination knobs (mirrors FastChannels xumo.py) ──────────────────────────
// The market EPG is paginated by date → page (a ~6-hour time block; pages 0-3 cover a day, page 4+ → HTTP 400)
// → offset (50 channels each, 0..totalChannels). MAX_EPG_DAYS forward + the previous date (the overnight UTC
// window buckets under yesterday's key). The build's early-break logic (HTTP 400 / empty page / offset ≥ total)
// prunes the nominal 24 pages × 1000 offsets down to ~4 pages × ~9 offsets per date.
export const MAX_EPG_DAYS = 2; // forward days (range is [-1 .. MAX_EPG_DAYS) → yesterday, today, tomorrow)
export const EPG_PAGES_PER_DAY = 24;
export const EPG_LIMIT = 50;
export const EPG_MAX_OFFSET = 1000;
export const EPG_OFFSET_STEP = 50;

// Callsign suffixes that mark a DRM (Widevine/PlayReady) channel — dropped at catalog time (HLS-only proxy).
const DRM_CALLSIGN_SUFFIXES = ['-DRM', 'DRM-CMS'];

// ── URL builders ─────────────────────────────────────────────────────────────────

/** The channel catalog (live linear + VOD shells), market-scoped, with the per-process device/ifa params. */
export function channelListUrl(): string {
  const qs = new URLSearchParams({
    sort: 'hybrid',
    geoId: GEO_ID,
    deviceId: DEVICE_ID,
    ifaId: IFA_ID,
  });
  return `${BASE_URL}/v2/proxy/channels/list/${MARKET_ID}.json?${qs}`;
}

/** The currently-broadcasting asset(s) for a channel in a given UTC hour (resolve hop 1). */
export function broadcastUrl(channelId: string, hour: number): string {
  return `${BASE_URL}/v2/channels/channel/${encodeURIComponent(channelId)}/broadcast.json?hour=${hour}`;
}

/** The asset detail (providers → HLS source uri) for a resolved live asset (resolve hop 2). */
export function assetUrl(assetId: string): string {
  const fields = [
    'providers', 'cuePoints', 'connectorId', 'genres', 'title',
    'episodeTitle', 'runtime', 'ratings', 'keywords', 'season', 'episode',
  ];
  const qs = fields.map((f) => `f=${f}`).join('&');
  return `${BASE_URL}/v2/assets/asset/${encodeURIComponent(assetId)}.json?${qs}`;
}

/** One paginated market-EPG page (date bucket → ~6h page → 50-channel offset window). */
export function epgPageUrl(dateStr: string, page: number, offset: number): string {
  return (
    `${BASE_URL}/v2/epg/${MARKET_ID}/${dateStr}/${page}.json` +
    `?f=asset.title&f=asset.descriptions&limit=${EPG_LIMIT}&offset=${offset}`
  );
}

// ── sentinel entry url (the channel id is the only stored handle to a per-play master) ──
// normalize() stores broadcast.json as the channel ENTRY (the dlhd posture: a real-looking URL whose id is all
// that matters — the hour is re-stamped fresh at resolve time). isXumoEntry gates it; channelIdFromEntry parses
// the id back out for the resolve hops.

export function channelEntryUrl(channelId: string): string {
  return `${BASE_URL}/v2/channels/channel/${encodeURIComponent(channelId)}/broadcast.json`;
}

export function isXumoEntry(url: string): boolean {
  try {
    const u = new URL(url);
    return /^\/v2\/channels\/channel\/[^/]+\/broadcast\.json$/i.test(u.pathname);
  } catch {
    return false;
  }
}

export function channelIdFromEntry(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/^\/v2\/channels\/channel\/([^/]+)\/broadcast\.json$/i);
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

// ── small JSON fetch helper (API hops) ───────────────────────────────────────────

async function getJson(url: string): Promise<any | null> {
  const res = await fetch(url, { headers: XUMO_API_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── catalog → trimmed rows ───────────────────────────────────────────────────────

// One catalog row, trimmed to exactly what normalize() + the EPG channel records need (drops the ~dozen unused
// catalog fields so the committed snapshot stays lean). `category` is the channel's first genre value (Xumo's
// genres are mostly clean linear buckets — Sports/News/Comedy/… — grouped source-local + lean, the lg/whale/vidaa
// precedent; an unmapped/promotional bucket passes through unchanged rather than porting FC's name-inference).
export interface XumoRow {
  channelId: string; // guid.value
  name: string; // title
  logo: string | null;
  category: string; // first genre value (fallback 'Live TV')
  number: number | null; // channel `number`
}

function str(v: unknown): string | null {
  const s = (v == null ? '' : String(v)).trim();
  return s || null;
}

function firstGenre(item: any): string {
  const genres = item?.genre;
  if (Array.isArray(genres) && genres.length) {
    const g = genres[0];
    const v = typeof g === 'object' && g ? g.value ?? g.title : g;
    const s = str(v);
    if (s) return s;
  }
  return 'Live TV';
}

function parseInt10(v: unknown): number | null {
  if (v == null) return null;
  const n = Number.parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Trim one catalog item → XumoRow, or null when it's not a live HLS-playable linear channel (non-live, DRM,
 *  or missing id/name). */
function trimItem(item: any): XumoRow | null {
  if (!item || typeof item !== 'object') return null;
  const props = item.properties || {};
  if (String(props.is_live ?? '').toLowerCase() !== 'true') return null; // VOD-only shell — skip
  const callsign = String(item.callsign || '');
  if (DRM_CALLSIGN_SUFFIXES.some((sfx) => callsign.endsWith(sfx))) return null; // DRM — HLS-only proxy can't serve it

  const channelId = str(item?.guid?.value);
  const name = str(item?.title);
  if (!channelId || !name) return null;

  return {
    channelId,
    name,
    logo: `${CHANNEL_IMAGE}/${channelId}/600x336.jpg?type=channelTile`,
    category: firstGenre(item),
    number: parseInt10(item?.number),
  };
}

/**
 * LIVE catalog fetch → trimmed XumoRow[]. Walks the `channel.item[]` (or legacy `items[]`) array, dropping
 * non-live / DRM / id-less rows and deduping by channel id. No snapshot fallback here (that's the adapter's
 * listChannels wrapper): the standalone EPG sync (epg/xumo.ts) needs a live-only fetch that throws on failure so
 * a transient outage fails loudly and preserves the existing guide. Throws on HTTP error or an empty catalog.
 */
export async function fetchXumoRows(): Promise<XumoRow[]> {
  const payload = await getJson(channelListUrl());
  let items: any[] = [];
  if (payload?.channel && typeof payload.channel === 'object') items = payload.channel.item || [];
  else if (Array.isArray(payload?.items)) items = payload.items;

  const rows: XumoRow[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const row = trimItem(item);
    if (!row || seen.has(row.channelId)) continue;
    seen.add(row.channelId);
    rows.push(row);
  }
  if (!rows.length) throw new Error('catalog payload had no live channels');
  return rows;
}

// ── stream resolve (3-hop, per play) ─────────────────────────────────────────────

/** Find the live (or first) asset id in a broadcast payload. */
function pickLiveAssetId(broadcast: any): string | null {
  const assets = Array.isArray(broadcast?.assets) ? broadcast.assets : [];
  for (const a of assets) {
    if (a && typeof a === 'object' && a.live === true && a.id) return String(a.id);
  }
  const first = assets[0];
  return first && typeof first === 'object' && first.id ? String(first.id) : null;
}

/** Pull the HLS master uri out of an asset's providers[].sources[] (produces mpegurl / .m3u8). */
function extractStreamSource(asset: any): string | null {
  for (const provider of asset?.providers || []) {
    for (const source of provider?.sources || []) {
      const uri = source?.uri;
      const produces = String(source?.produces || '').toLowerCase();
      if (!uri) continue;
      if (produces.includes('mpegurl') || uri.endsWith('.m3u8') || uri.includes('.m3u8?')) return String(uri);
    }
  }
  return null;
}

// Matches any leftover [placeholder] ad macro after the fixed fill — stripped to empty. Mirrors FC's re.sub.
const MACRO_RE = /\[[^\]]+\]/g;

/**
 * Fill the per-play ad-targeting macros baked into a resolved Xumo master FRESH per call ([SESSION_ID] new uuid,
 * [timestamp] current ms, [DEVICE_ID]/[IFA] the per-process ids), strip any leftover [PLACEHOLDER] tokens, then
 * drop the now-empty query params — producing a clean, bracket-free URL the proxy can fetch directly (unlike
 * lg/whale, whose macro-laden master is STORED and string-filled per play to survive the proxy round-trip; here
 * the master is resolved server-side and consumed immediately). Mirrors FastChannels xumo.py _process_stream_uri.
 */
export function processStreamUri(uri: string): string {
  const reps: Record<string, string> = {
    '[PLATFORM]': 'web',
    '[APP_VERSION]': '1.0.0',
    '[timestamp]': String(Date.now()),
    '[app_bundle]': 'play.xumo.com',
    '[device_make]': 'Masqueradarr',
    '[device_model]': 'Masqueradarr',
    '[content_language]': 'en',
    '[IS_LAT]': '0',
    '[IFA]': IFA_ID,
    '[IFA_TYPE]': 'aaid',
    '[SESSION_ID]': randomUUID(),
    '[DEVICE_ID]': DEVICE_ID.replace(/-/g, ''),
    '[CCPA_Value]': '1---',
    '[OS]': 'web',
  };
  let out = uri;
  for (const [key, value] of Object.entries(reps)) out = out.split(key).join(value);
  out = out.replace(MACRO_RE, ''); // strip any unmapped macro

  // Drop the query params left empty by stripped macros (FC's parse_qsl(keep_blank_values=False) + urlencode).
  try {
    const u = new URL(out);
    const kept = new URLSearchParams();
    for (const [k, v] of u.searchParams) if (v !== '') kept.append(k, v);
    u.search = kept.toString();
    return u.toString();
  } catch {
    return out;
  }
}

/**
 * Resolve a channel id → a fresh, clean HLS master url (the 3-hop resolve). Throws an actionable error when the
 * channel has no live broadcast / no HLS source (the proxy maps it to a 502 + the B-Roll "failed" slate). The
 * caller (the adapter's resolveStream) pre-allows the resolved host so the proxy's SSRF gate passes the master's
 * same-host child hops.
 */
export async function resolveXumoMaster(channelId: string): Promise<string> {
  const hour = new Date().getUTCHours();
  const broadcast = await getJson(broadcastUrl(channelId, hour));
  const assetId = pickLiveAssetId(broadcast);
  if (!assetId) throw new Error(`xumo: no live broadcast asset for channel ${channelId}`);

  const asset = await getJson(assetUrl(assetId));
  const sourceUri = extractStreamSource(asset);
  if (!sourceUri) throw new Error(`xumo: no HLS source on asset ${assetId} (channel ${channelId})`);

  return processStreamUri(sourceUri);
}

// ── EPG date/time helpers (shared by epg/xumo.ts) ────────────────────────────────

/** The date keys to fetch: the previous date (overnight UTC window) through MAX_EPG_DAYS forward, YYYYMMDD UTC. */
export function epgDateKeys(now: number): string[] {
  const keys: string[] = [];
  for (let day = -1; day < MAX_EPG_DAYS; day++) {
    const d = new Date(now + day * 86_400_000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    keys.push(`${y}${m}${dd}`);
  }
  return keys;
}

/** Parse a Xumo schedule timestamp ('YYYY-MM-DDTHH:MM:SS+0000' / epoch) → epoch ms UTC, or NaN if unparseable. */
export function parseXumoTime(value: unknown): number {
  if (value == null) return NaN;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const t = Date.parse(String(value).trim());
  return Number.isFinite(t) ? t : NaN;
}

/** First non-empty description from an asset's {large,medium,small,tiny} bag, or null. */
export function pickAssetDesc(asset: any): string | null {
  const d = asset?.descriptions || {};
  return str(d.large) || str(d.medium) || str(d.small) || str(d.tiny) || null;
}

/** Asset genres[] → the first genre value (or null). */
export function pickAssetGenre(asset: any): string | null {
  const genres = asset?.genres;
  if (Array.isArray(genres) && genres.length) {
    const g = genres[0];
    return str(typeof g === 'object' && g ? g.value ?? g.title : g);
  }
  return null;
}
