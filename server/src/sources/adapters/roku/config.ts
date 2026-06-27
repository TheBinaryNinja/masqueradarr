// The Roku Channel — shared leaf constants + the anonymous session manager (cookie jar + csrf + 403 cooldown),
// the live catalog fetch, the sentinel/resolve helpers, and the content-proxy primitive, imported by BOTH the
// adapter (sources/adapters/roku.ts) and the EPG module (epg/roku.ts), so neither imports the other (an acyclic
// leaf, mirroring adapters/pluto/config.ts + adapters/tcl/config.ts). The Roku Channel is the THIRTEENTH
// FastChannels FAST source ported (Roku's free FAST service, the therokuchannel.roku.com web client) and — like
// xumo/stirr/tcl/pluto — a SENTINEL + RESOLVE source, NOT direct-HLS: the `/api/v2/epg` catalog yields only
// channel ids/metadata, and the playable master is minted on demand by Roku's OSM CDN (a per-play JWT-signed HLS
// master).
//
// The TWIST vs the rest of the resolve family is a stateful, Cloudflare-sensitive anonymous SESSION (the FAST
// family's first cookie-bearing session): a 3-step keyless bootstrap mints session cookies + a csrf token that
// gate the catalog/EPG/resolve hops, and a 403 from the CloudFront edge trips a 5-minute cooldown (the
// resilience the plan calls out — keeping the previous catalog/guide and the B-Roll slate, never hammering). So
// normalize() stores a `roku://<id>` ENTRY sentinel (the dulo/pluto custom-scheme posture — the playable master
// needs a freshly-minted playback JWT) and resolveStream() boots the session (cached), resolves a fresh playId
// via the content proxy, and POSTs `/api/v3/playback` PER PLAY:
//   GET /                        → session cookies            (cached, 12h hard TTL)
//   GET /api/v1/csrf             → csrf token                 (cached with the cookies)
//   GET content-proxy(<id>)      → viewOptions[0].playId      (cached per channel, 6h TTL)
//   POST /api/v3/playback        → osm.sr.roku.com HLS master (cached per channel, 5h TTL)
// The guide is a SEPARATE per-channel content-proxy fanout (epg/roku.ts) reading each station's linearSchedule.
// No USER auth, no per-user surface (the session is keyless + process-global, the pluto/whale precedent).
//
// Divergence from FastChannels roku.py (1541 LOC): masqueradarr keeps the session + caches IN-PROCESS (the
// pluto/tcl posture — no per-source DB config blob), so the ~400 lines of `sources.config` persistence
// (csrf/cookies/play_id/selector_url/stream_url/osm_session/description_cache) collapse to in-process Maps; the
// cross-channel OSM-session-token reuse (`_synthetic_osm_url`) and the 48h description-backfill second pass are
// NOT ported (each channel resolves via its own cached playback call; descriptions come inline from the
// linearSchedule). Ported from FastChannels roku.py.

import { logger } from '../../core/logger.js';
import { inferCategoryFromName } from './categorize.js';

// ── endpoints ────────────────────────────────────────────────────────────────────────

const BASE = 'https://therokuchannel.roku.com';
const HOME = `${BASE}/`;
const CSRF_URL = `${BASE}/api/v1/csrf`;
const PLAYBACK_URL = `${BASE}/api/v3/playback`;
/** The full-lineup live EPG endpoint — its `collections[].features.station` rows ARE the catalog. */
export const EPG_URL = `${BASE}/api/v2/epg`;
/** Per-content metadata proxy base — a target content url is appended url-encoded. */
const PROXY_BASE = `${BASE}/api/v2/homescreen/content/`;
/** The content backend the proxy fronts (per-station metadata: playId, logo, linearSchedule). */
const CONTENT_HOST = 'https://content.sr.roku.com/content/v1/roku-trc';

function contentUrl(stationId: string, featureInclude = ''): string {
  const qs = featureInclude ? `?featureInclude=${featureInclude}` : '';
  return `${PROXY_BASE}${encodeURIComponent(`${CONTENT_HOST}/${stationId}${qs}`)}`;
}

// therokuchannel.roku.com is a desktop web client (csrf + Origin/Referer + cookie gated on its API hops); match
// its UA. The OSM CDN stream hops (the resolved master/variant/segment) need only the UA (the proxy's
// upstreamHeaders), so the csrf/Origin/cookie envelope rides ONLY on the bootstrap + catalog + EPG + resolve hops.
export const UA =
  process.env.ROKU_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/** Headers for the CDN stream hops (master/variant/segment) — UA only (the OSM CDN ignores the csrf/Origin). */
export const ROKU_STREAM_HEADERS: Record<string, string> = { 'User-Agent': UA };

// Browser-navigation headers for the bootstrap GET / (clears the CloudFront anti-bot gate the same way the web
// client's first navigation does). Ported from FastChannels roku.py _live_tv_headers.
const NAV_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'max-age=0',
  Pragma: 'no-cache',
  Referer: HOME,
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

// The fixed Roku reserved headers every JSON API hop carries (the web client's experiment/amoeba envelope), plus
// csrf + Origin/Referer. Ported from FastChannels roku.py _api_headers.
function apiHeaders(): Record<string, string> {
  return {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    'csrf-token': session?.csrf || '',
    origin: BASE,
    referer: HOME,
    'x-roku-reserved-amoeba-ids': '',
    'x-roku-reserved-experiment-configs': 'e30=',
    'x-roku-reserved-experiment-state': 'W10=',
    'x-roku-reserved-lat': '0',
    ...(cookieHeader() ? { cookie: cookieHeader() } : {}),
  };
}

// SSRF allowlist seed for the stream proxy — the registrable families Roku's resolved masters live on. The
// playback API mints the master on `osm.sr.roku.com` (a `*.roku.com` host) and the ad-stitched variant/segment
// hops land on a long tail of Akamai/CloudFront/Fastly CDN hosts a static suffix list can't fully enumerate. The
// adapter's dynamic allow-set pre-allows the resolved master host at play time (resolveStream) + learns child
// variant/segment hosts during playlist rewrite (onPlaylistChildHost), so a CDN host that appears mid-stream is
// covered without a code change — private IPs are always blocked.
export const ROKU_SUFFIXES = [
  'roku.com',
  'rokucdn.com',
  'cloudfront.net',
  'akamaized.net',
  'akamai.net',
  'amazonaws.com',
  'fastly.net',
  'llnwd.net',
];

// ── timing constants (ported from FastChannels roku.py) ────────────────────────────────

const SESSION_HARD_TTL_MS = 12 * 3600_000; // discard a cached session after 12h
const PLAY_ID_TTL_MS = 6 * 3600_000; // reuse a channel's playId for a few hours
const STREAM_URL_TTL_MS = 5 * 3600_000; // reuse a resolved OSM master url (the JWT stays valid ~6h)
const COOLDOWN_MS = 5 * 60_000; // back off this long after a CloudFront 403 (do NOT hammer)
const CSRF_RETRIES = 4; // csrf endpoint is occasionally flaky right after the bootstrap nav

// ── in-process session + caches (the pluto/tcl posture — no per-source DB config blob) ──
// One process-global session (cookies + csrf) shared across the catalog, EPG, and resolve hops, plus per-channel
// playId/streamUrl caches that cut tune-time content lookups. Keyless + anonymous, NOT a per-user surface.

interface RokuSession {
  csrf: string;
  bornAt: number;
}

let session: RokuSession | null = null;
const cookies = new Map<string, string>(); // name → value (the anonymous session cookie jar)
let cooldownUntil = 0;
let cooldownReason = '';

const playIdCache = new Map<string, { playId: string; at: number }>();
const streamUrlCache = new Map<string, { url: string; at: number }>();

// ── cookie jar (undici fetch has no jar — capture Set-Cookie, replay as a Cookie header) ──

/** Capture every Set-Cookie on a response into the jar (name=value only; attributes dropped). */
function captureCookies(res: Response): void {
  // Node 18.14+/undici: getSetCookie() returns the raw set-cookie header lines.
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of setCookies) {
    const first = line.split(';', 1)[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name) cookies.set(name, value);
  }
}

/** The replay Cookie header (`name1=v1; name2=v2`), or '' when the jar is empty. */
function cookieHeader(): string {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── 403 cooldown (the Cloudflare-sensitivity mitigation) ───────────────────────────────

function cooldownActive(): boolean {
  if (!cooldownUntil) return false;
  if (Date.now() >= cooldownUntil) {
    cooldownUntil = 0;
    cooldownReason = '';
    return false;
  }
  return true;
}

/** Whole-minute remaining (for an actionable cooldown error message). */
export function cooldownRemainingMin(): number {
  return cooldownUntil ? Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 60_000)) : 0;
}

/** Re-export so callers (the EPG fanout) can short-circuit when a 403 trips mid-run. */
export function isCoolingDown(): boolean {
  return cooldownActive();
}

function setCooldown(reason: string): void {
  cooldownUntil = Date.now() + COOLDOWN_MS;
  cooldownReason = reason;
  logger.warn('seed', `[roku] entering ${COOLDOWN_MS / 60_000}m cooldown after 403 (${reason})`);
}

// ── fetch helper (timeout + transient JSON parse) ──────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 12_000;

async function rawFetch(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

// ── session bootstrap ──────────────────────────────────────────────────────────────────

function sessionFresh(): boolean {
  return !!session && cookies.size > 0 && Date.now() - session.bornAt < SESSION_HARD_TTL_MS;
}

/** Drop the cached session (cookies + csrf) — forces a fresh bootstrap on the next ensureSession. */
function clearSession(): void {
  session = null;
  cookies.clear();
}

/**
 * Boot a fresh anonymous Roku session: GET / for cookies, then GET /api/v1/csrf for the token. Returns true on
 * success. A 403 on the bootstrap nav trips the cooldown (CloudFront edge block — back off, keep prior data).
 * Always clears the prior session first, so every call boots clean (callers invoke it on staleness, an empty
 * catalog, or a mid-run 401 rejection).
 */
async function bootSession(): Promise<boolean> {
  if (cooldownActive()) {
    logger.warn('seed', `[roku] bootstrap blocked by 403 cooldown (~${cooldownRemainingMin()}m, ${cooldownReason})`);
    return false;
  }
  clearSession();

  // Step 1: hit the home page for the anonymous session cookies (/live-tv is intermittently CloudFront-blocked;
  // the root yields the same cookies, the FastChannels posture).
  let home: Response;
  try {
    home = await rawFetch(HOME, { headers: NAV_HEADERS }, 15_000);
  } catch (err) {
    logger.warn('seed', `[roku] home bootstrap failed: ${(err as Error).message}`);
    return false;
  }
  if (home.status === 403) {
    setCooldown('bootstrap');
    return false;
  }
  if (!home.ok) {
    logger.warn('seed', `[roku] home bootstrap returned ${home.status}`);
    return false;
  }
  captureCookies(home);

  // Step 2: fetch the csrf token (a couple of retries — the endpoint is flaky right after the nav).
  let csrf = '';
  for (let attempt = 0; attempt <= CSRF_RETRIES; attempt++) {
    try {
      const res = await rawFetch(CSRF_URL, { headers: { ...apiHeaders(), accept: 'application/json' } }, 10_000);
      captureCookies(res);
      if (res.status === 403) {
        setCooldown('csrf');
        return false;
      }
      if (res.ok) {
        const payload = (await res.json()) as { csrf?: string };
        csrf = (payload?.csrf || '').trim();
        if (csrf) break;
      }
    } catch {
      /* transient — retry */
    }
  }
  if (!csrf) {
    logger.warn('seed', '[roku] could not obtain csrf token');
    return false;
  }

  session = { csrf, bornAt: Date.now() };
  return true;
}

/** Ensure a usable session exists (boot if stale/absent). Throws on a cooldown so the caller fails cleanly. */
async function ensureSession(): Promise<void> {
  if (cooldownActive()) throw new Error(`roku: rate-limited (403) — ~${cooldownRemainingMin()}m cooldown remaining`);
  if (sessionFresh()) return;
  if (!(await bootSession())) {
    throw new Error(
      cooldownActive()
        ? `roku: rate-limited (403) — ~${cooldownRemainingMin()}m cooldown remaining`
        : 'roku: session bootstrap failed',
    );
  }
}

// ── authenticated API calls (one re-boot retry on a 401/403, then cooldown) ─────────────

/** GET a Roku JSON API endpoint with the session envelope; one re-boot retry on a 401/403. Returns the Response. */
async function apiGet(url: string, label: string, timeoutMs = 10_000): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await rawFetch(url, { headers: apiHeaders() }, timeoutMs);
    } catch {
      return null;
    }
    captureCookies(res);
    if (res.status === 403) {
      setCooldown(label);
      return res;
    }
    if (res.status !== 401 || attempt === 1) return res;
    // 401 → the cached session was rejected; re-boot once and retry.
    if (!(await bootSession())) return res;
  }
  return null;
}

/** POST a Roku JSON API endpoint with the session envelope; one re-boot retry on a 401/403. Returns the Response. */
async function apiPost(url: string, body: unknown, label: string, timeoutMs = 10_000): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await rawFetch(url, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) }, timeoutMs);
    } catch {
      return null;
    }
    captureCookies(res);
    if (res.status === 403) {
      setCooldown(label);
      return res;
    }
    if (res.status !== 401 || attempt === 1) return res;
    if (!(await bootSession())) return res;
  }
  return null;
}

/**
 * Fetch one station's content-proxy JSON (playId / metadata / linearSchedule). Exported so epg/roku.ts can read
 * each station's `features.linearSchedule`. Returns null on any non-200 (a flaky channel must not abort a fanout).
 */
export async function fetchContent(stationId: string, featureInclude = ''): Promise<any | null> {
  const res = await apiGet(contentUrl(stationId, featureInclude), `content proxy for ${stationId}`);
  if (!res || res.status !== 200) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ── small helpers ──────────────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  const s = (v == null ? '' : String(v)).trim();
  return s || null;
}

function parseInt10(v: unknown): number | null {
  if (v == null) return null;
  const n = Number.parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// ── category derivation (ported from FastChannels roku.py _category_from_station) ───────

// Station tags → a human-readable category (first match wins). Ported from roku.py _TAG_CATEGORY_PRIORITY.
const TAG_CATEGORY: Array<[string, string]> = [
  ['news', 'News'],
  ['spanish-language', 'Spanish'],
  ['music', 'Music'],
  ['kids_music', 'Kids'],
  ['kids_linear', 'Kids'],
  ['ages_1-3', 'Kids'],
  ['ages_4-6', 'Kids'],
  ['ages_7-9', 'Kids'],
  ['ages_10plus', 'Kids'],
  ['educational', 'Kids'],
  ['preschool_specials', 'Kids'],
];

/**
 * Derive a category from an EPG station object. Roku stations carry no genre field — only `tags` — so this mirrors
 * FastChannels roku.py `_category_from_station`: kidsDirected flag → tag priority list → `channelcode_*` tag
 * keyword scan → a NAME-keyword fallback (categorize.ts — the bulk of channels resolve here, since most tags are
 * operational flags) → 'Live TV'.
 */
function categoryFromStation(station: any, name: string): string {
  if (station?.kidsDirected) return 'Kids';
  const tags: string[] = Array.isArray(station?.tags) ? station.tags.map((t: unknown) => String(t)) : [];
  const tagSet = new Set(tags);
  for (const [tag, label] of TAG_CATEGORY) if (tagSet.has(tag)) return label;
  for (const tag of tags) {
    const tl = tag.toLowerCase();
    if (tl.includes('reality') || tl.includes('wedding')) return 'Reality TV';
    if (tl.includes('thriller') || tl.includes('movie') || tl.includes('film') || tl.includes('ifc')) return 'Movies';
    if (tl.includes('comedy')) return 'Comedy';
    if (tl.includes('drama') || tl.includes('stories')) return 'Drama';
  }
  return inferCategoryFromName(name) || 'Live TV';
}

/** Pick the best station logo from the imageMap (gridEpg → epgLogo → liveHudLogo → epgLogoDark). */
function stationLogo(station: any): string | null {
  const imageMap = station?.imageMap || {};
  for (const key of ['gridEpg', 'epgLogo', 'liveHudLogo', 'epgLogoDark']) {
    const path = str(imageMap?.[key]?.path);
    if (path) return path;
  }
  return null;
}

// ── row shape ────────────────────────────────────────────────────────────────────────

// One catalog row, trimmed to exactly what normalize() + the EPG channel records need (drops the many unused
// station fields so the committed snapshot stays lean). The playId is NOT stored (it is per-content + short-lived
// — resolveStream fetches it fresh per play, cached in-process); `category` is the station's derived bucket.
export interface RokuRow {
  channelId: string; // Roku station id (dedup key)
  name: string;
  logo: string | null;
  category: string; // derived category (fallback 'Live TV')
  number: number | null; // displayNumber (EPG channelNo)
}

/** Trim one EPG `features.station` object → a lean RokuRow (also warms the in-process playId cache). */
function trimStation(station: any): RokuRow | null {
  const channelId = str(station?.meta?.id);
  const name = str(station?.title) || str(station?.shortName);
  if (!channelId || !name) return null;

  // Warm the playId cache from the catalog (the station carries viewOptions[0].playId) — saves a content lookup
  // on the first tune. Best-effort; resolveStream refetches when absent/stale.
  const playId = str(station?.viewOptions?.[0]?.playId);
  if (playId) cachePlayId(channelId, playId);

  return {
    channelId,
    name,
    logo: stationLogo(station),
    category: categoryFromStation(station, name),
    number: parseInt10(station?.displayNumber),
  };
}

// ── catalog → trimmed rows ───────────────────────────────────────────────────────────

/**
 * LIVE catalog fetch → trimmed RokuRow[]. Boots the session, GETs `/api/v2/epg` (the full live lineup, ~795
 * channels), and trims each `collections[].features.station`, deduping by station id. Retries once after a fresh
 * bootstrap if the first response is empty (a stale/expired session yields 0 rows). No snapshot fallback here
 * (that's the adapter's listChannels wrapper); the standalone EPG sync needs a live-only fetch that throws on
 * total failure so a transient outage preserves the existing guide. Throws on an empty catalog.
 */
export async function fetchRokuRows(): Promise<RokuRow[]> {
  await ensureSession();

  const fetchOnce = async (): Promise<RokuRow[]> => {
    const res = await apiGet(EPG_URL, 'epg', 20_000);
    if (!res || res.status !== 200) {
      if (res?.status === 403) clearSession();
      throw new Error(`HTTP ${res?.status ?? 'no-response'} (epg)`);
    }
    const payload = (await res.json()) as { collections?: any[] };
    const seen = new Set<string>();
    const rows: RokuRow[] = [];
    for (const col of payload?.collections ?? []) {
      const row = trimStation(col?.features?.station);
      if (row && !seen.has(row.channelId)) {
        seen.add(row.channelId);
        rows.push(row);
      }
    }
    return rows;
  };

  let rows = await fetchOnce();
  if (!rows.length) {
    // Empty payload — the session may be upstream-expired; re-boot and retry once (the FastChannels posture).
    if (await bootSession()) rows = await fetchOnce();
  }
  if (!rows.length) throw new Error('catalog payload had no channels');
  return rows;
}

// ── sentinel entry url (custom scheme — the playable master needs a freshly-minted playback JWT) ──
// normalize() stores `roku://<id>` as the channel ENTRY (the dulo/pluto custom-scheme posture — a sentinel, NOT a
// fetchable URL). isRokuEntry gates on the scheme; parseRokuEntry reads the station id back out.

const ENTRY_SCHEME = 'roku://';

export function channelEntryUrl(channelId: string): string {
  return `${ENTRY_SCHEME}${channelId}`;
}

export function isRokuEntry(url: string): boolean {
  return typeof url === 'string' && url.startsWith(ENTRY_SCHEME);
}

export function parseRokuEntry(url: string): { channelId: string } | null {
  if (!isRokuEntry(url)) return null;
  const channelId = url.slice(ENTRY_SCHEME.length);
  return channelId ? { channelId } : null;
}

// ── per-channel caches (playId, resolved stream url) ───────────────────────────────────

function cachePlayId(stationId: string, playId: string): void {
  if (stationId && playId) playIdCache.set(stationId, { playId, at: Date.now() });
}

function cachedPlayId(stationId: string): string | null {
  const e = playIdCache.get(stationId);
  if (!e) return null;
  if (Date.now() - e.at >= PLAY_ID_TTL_MS) {
    playIdCache.delete(stationId);
    return null;
  }
  return e.playId;
}

function cachedStreamUrl(stationId: string): string | null {
  const e = streamUrlCache.get(stationId);
  if (!e) return null;
  if (Date.now() - e.at >= STREAM_URL_TTL_MS) {
    streamUrlCache.delete(stationId);
    return null;
  }
  return e.url;
}

function invalidate(stationId: string): void {
  playIdCache.delete(stationId);
  streamUrlCache.delete(stationId);
}

// ── stream resolve (content → playback, per play) ──────────────────────────────────────

// The playback request body envelope (the web client's fixed params). mediaFormat is forced to 'm3u' to stay
// HLS-only (the plan's mandate — a DASH-only channel simply fails resolve → the B-Roll "failed" slate, never a
// broken master). Ported from FastChannels roku.py resolve body.
function playbackBody(stationId: string, playId: string): Record<string, unknown> {
  const sessionId = cookies.get('_usn') || 'roku-scraper';
  return {
    rokuId: stationId,
    playId,
    mediaFormat: 'm3u',
    drmType: 'widevine',
    quality: 'fhd',
    bifUrl: null,
    adPolicyId: '',
    providerId: 'rokuavod',
    playbackContextParams: `sessionId=${sessionId}&pageId=trc-us-live-ml-page-en-current&isNewSession=0&idType=roku-trc`,
  };
}

/**
 * Resolve a station → a fresh, signed OSM HLS master url. Reuses a cached resolved url within its TTL; otherwise
 * boots the session (cached), resolves a playId (cached → content proxy), and POSTs `/api/v3/playback`. Throws an
 * actionable error when no playId/master can be obtained (the proxy maps it to a 502 + the B-Roll "failed"
 * slate). The caller (the adapter's resolveStream) pre-allows the resolved host so the proxy's SSRF gate passes
 * the master's child hops. `allowCache=false` forces a fresh playback lookup (audit-time). Mirrors roku.py resolve.
 */
export async function resolveRokuMaster(stationId: string, allowCache = true): Promise<string> {
  if (allowCache) {
    const cached = cachedStreamUrl(stationId);
    if (cached) return cached;
  }
  if (cooldownActive()) throw new Error(`roku: rate-limited (403) — ~${cooldownRemainingMin()}m cooldown remaining`);
  await ensureSession();

  // Step 1: playId (cached, else a content-proxy lookup).
  let playId = cachedPlayId(stationId);
  if (!playId) {
    const content = await fetchContent(stationId);
    playId = str(content?.viewOptions?.[0]?.playId);
    if (playId) cachePlayId(stationId, playId);
  }
  if (!playId) throw new Error(`roku: no playId for channel ${stationId}`);

  // Step 2: POST /api/v3/playback → the OSM HLS master url.
  const res = await apiPost(PLAYBACK_URL, playbackBody(stationId, playId), `playback for ${stationId}`);
  if (res && res.status === 200) {
    let url = '';
    try {
      url = String(((await res.json()) as { url?: string })?.url || '');
    } catch {
      /* fallthrough → throw below */
    }
    if (url) {
      streamUrlCache.set(stationId, { url, at: Date.now() });
      return url;
    }
  }
  // A 401/403/404/502 means the cached playId/url is stale — drop them so the next play re-resolves clean.
  if (res && [401, 403, 404, 502].includes(res.status)) invalidate(stationId);
  throw new Error(`roku: playback returned ${res?.status ?? 'no-response'} for ${stationId}`);
}
