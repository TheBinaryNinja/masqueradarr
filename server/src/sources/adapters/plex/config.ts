// Plex — shared leaf constants + the anonymous-JWT session manager, the live catalog fetch, the RSC category
// parse, the sentinel/resolve helpers, and the grid-EPG primitive, imported by BOTH the adapter
// (sources/adapters/plex.ts) and the EPG module (epg/plex.ts), so neither imports the other (an acyclic leaf,
// mirroring adapters/roku/config.ts + adapters/pluto/config.ts). Plex is the FOURTEENTH (and last of the
// FastChannels FAST batch) source ported (Plex's free FAST service, the watch.plex.tv web client) and — like
// xumo/stirr/tcl/pluto/roku — a SENTINEL + RESOLVE source, NOT direct-HLS: the catalog yields channel
// ids/metadata, and the playable master is minted on demand by Plex's provider backend (a per-play signed HLS
// master, served at epg.provider.plex.tv → 302 to AWS MediaTailor segments).
//
// The TWIST vs the rest of the resolve family is a fully ANONYMOUS JWT (no credentials, no cookies, no csrf —
// far simpler than roku's cookie+csrf session): POST plex.tv/api/v2/users/anonymous mints an anon X-Plex-Token
// that gates the catalog/EPG/resolve hops (cached in-process with a TTL; NOT a per-user surface). So normalize()
// stores a `plex://<compoundId>` ENTRY sentinel (the dulo/pluto/roku custom-scheme posture — the catalog gives
// only ids, the master needs the token) and resolveStream() builds the signed library/parts master URL PER PLAY:
//   GET  watch.plex.tv/                       → cookie seed (best-effort)
//   POST plex.tv/api/v2/users/anonymous       → anon X-Plex-Token       (cached, TOKEN_TTL)
//   GET  epg.provider.plex.tv/lineups/plex/channels (JSON) → the catalog (Channel[] with Media[].Part[].key)
//   GET  watch.plex.tv/live-tv?_rsc=…         → RSC blob → the {"categories":[…]} object (brace-matched)
//   POST epg.provider.plex.tv/channels/<id>/tune     → wake the channel (best-effort, fire-and-forget)
//   →    epg.provider.plex.tv/library/parts/<id>.m3u8?…X-Plex-Token=…   the resolved master (deterministic)
// The guide is a SEPARATE per-channel per-day grid fetch (epg/plex.ts) reading epg.provider.plex.tv/grid.
//
// ⚠️ Two id forms (FastChannels roku.py rationale): the catalog `id` is COMPOUND `<serverPrefix>-<channelId>`
// (the server prefix rotates when Plex migrates infra); `gridKey` is the STABLE 24-hex channel part. The
// deterministic masq `_id` uses the STABLE part (so a prefix rotation doesn't churn ids); the sentinel carries
// the COMPOUND id (the resolve manifest path needs it). The EPG grid is keyed by gridKey (== the stable part).
//
// Divergence from FastChannels plex.py (1120 LOC): masqueradarr keeps the token + caches IN-PROCESS (the
// roku/pluto posture — no per-source DB config blob), so plex.py's persisted client/session/playback UUIDs
// collapse to one process-global client id; the RSC is used ONLY for the category map (plex.py's catalog moved to
// the clean JSON lineups endpoint since the genre-slug GridChannelFilter endpoint went empty); the optional
// luma.plex.tv schedule GAP-FILL second pass is NOT ported (the per-channel grid is the guide, gaps left as
// null — never fabricated, the family's snapshot-lean posture). Ported from FastChannels plex.py.

import { randomUUID } from 'node:crypto';
import { logger } from '../../core/logger.js';

// ── endpoints ────────────────────────────────────────────────────────────────────────

const WATCH_HOME = 'https://watch.plex.tv/';
const ANON_AUTH = 'https://plex.tv/api/v2/users/anonymous';
/** The provider backend — its `/lineups/plex/channels` JSON IS the catalog; `/grid` + `/library/parts` are EPG + resolve. */
export const EPG_HOST = 'https://epg.provider.plex.tv';
const CHANNELS_URL = `${EPG_HOST}/lineups/plex/channels`;
/** watch.plex.tv RSC (React Server Component) blob — the source of the category→channel map (the genre rails). */
function rscUrl(): string {
  const rnd = Math.floor(now() / 1000).toString(36).slice(-5) || 'plex0';
  return `${WATCH_HOME}live-tv?_rsc=${rnd}`;
}

/** Stable per-process client identifier (Plex likes a consistent client across hops for token caching). */
const CLIENT_ID = process.env.PLEX_CLIENT_ID || randomUUID();
const PRODUCT = 'Plex Mediaverse';

// watch.plex.tv is a desktop web client; match its UA. The provider/CDN stream hops (master/variant/segment) need
// only the UA (the token rides in the URL query), so the X-Plex envelope rides on the API hops below.
export const UA =
  process.env.PLEX_UA ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/** Headers for the CDN stream hops (master/variant/segment) — UA + the X-Plex product/client (the token is in the URL). */
export const PLEX_STREAM_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  'X-Plex-Product': PRODUCT,
  'X-Plex-Client-Identifier': CLIENT_ID,
};

// SSRF allowlist seed for the stream proxy — the registrable families Plex's resolved masters live on. The master
// + variants are served on `epg.provider.plex.tv` (a `*.plex.tv` host); the segments/subtitles 302 to AWS
// MediaTailor (`*.mediatailor.<region>.amazonaws.com`) which itself fronts a long tail of CloudFront/Akamai/Fastly
// CDN hosts a static suffix list can't fully enumerate. The adapter's dynamic allow-set pre-allows the resolved
// master host at play time + learns child variant/segment hosts during playlist rewrite (onPlaylistChildHost), so
// a CDN host that appears mid-stream is covered without a code change — private IPs are always blocked.
export const PLEX_SUFFIXES = [
  'plex.tv',
  'amazonaws.com',
  'mediatailor.amazonaws.com',
  'cloudfront.net',
  'akamaized.net',
  'akamai.net',
  'fastly.net',
  'llnwd.net',
];

// ── timing constants ───────────────────────────────────────────────────────────────────

const TOKEN_TTL_MS = 6 * 3600_000; // re-mint the anon token after 6h (syncs also re-mint; plays use the cached one)
const DEFAULT_TIMEOUT_MS = 15_000;

// ── in-process anon token (the roku/pluto posture — no per-source DB config blob) ──
// One process-global anon X-Plex-Token shared across the catalog, EPG, and resolve hops. Keyless + anonymous,
// NOT a per-user surface.

let authToken: string | null = null;
let tokenAt = 0;

function now(): number {
  return Date.now();
}

function tokenFresh(): boolean {
  return !!authToken && now() - tokenAt < TOKEN_TTL_MS;
}

// ── fetch helper (timeout) ──────────────────────────────────────────────────────────────

async function rawFetch(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** The fixed X-Plex envelope every JSON API hop carries (the web client's product/client/platform headers). */
function apiHeaders(accept = 'application/json'): Record<string, string> {
  return {
    'User-Agent': UA,
    Accept: accept,
    'X-Plex-Client-Identifier': CLIENT_ID,
    'X-Plex-Product': PRODUCT,
    'X-Plex-Platform': 'Chrome',
    'X-Plex-Platform-Version': '145.0.0.0',
    'X-Plex-Language': 'en',
  };
}

// ── anonymous auth ──────────────────────────────────────────────────────────────────────

/**
 * Ensure a usable anon token exists (mint if stale/absent or `force`). Seeds watch.plex.tv cookies first
 * (best-effort — the FastChannels posture), then POSTs the anonymous-users endpoint for the token. Throws on
 * failure so the caller fails cleanly (the catalog falls back to the snapshot; resolve maps it to the B-Roll slate).
 */
export async function ensureAuth(force = false): Promise<string> {
  if (!force && tokenFresh()) return authToken as string;

  // Seed watch.plex.tv session cookies — best-effort (the anon POST works without them in practice, but the
  // navigation primes Plex's edge the same way the web client's first hit does).
  try {
    await rawFetch(WATCH_HOME, { headers: { 'User-Agent': UA } }, 12_000);
  } catch {
    /* non-fatal — proceed to the auth POST */
  }

  let res: Response;
  try {
    res = await rawFetch(
      ANON_AUTH,
      {
        method: 'POST',
        headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
        body: '',
      },
      15_000,
    );
  } catch (err) {
    throw new Error(`plex: anonymous auth request failed: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`plex: anonymous auth returned ${res.status}`);
  let token = '';
  try {
    token = String(((await res.json()) as { authToken?: string })?.authToken || '');
  } catch {
    /* fallthrough → throw below */
  }
  if (!token) throw new Error('plex: anonymous auth payload had no authToken');
  authToken = token;
  tokenAt = now();
  return token;
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

// Plex channel `id` is COMPOUND `<serverPrefix>-<channelId>` (both 24-hex); the prefix rotates on infra
// migrations, the channel part is stable. Strip to the stable part. Ported from plex.py _PLEX_COMPOUND_ID_RE.
const COMPOUND_ID_RE = /^[0-9a-f]{24}-([0-9a-f]{24})$/;

function stableId(rawId: string): string {
  const m = COMPOUND_ID_RE.exec(rawId);
  return m ? m[1] : rawId;
}

// ── category derivation (the RSC {"categories":[…]} blob — brace-matched) ────────────────

// Plex category slug → a human-readable label. Keys are the CURRENT watch.plex.tv genre-rail slugs (the
// `GridChannelFilter` JSON endpoint plex.py used went empty, so the RSC blob is the sole category source);
// 'featured' is an editorial pick list (NOT a genre) → excluded; 'en-espanol' also flags the Spanish language.
// A handful of plex.py's older slugs are kept too, harmless if Plex reverts. Ported/updated from plex.py
// _PLEX_CATEGORY_MAP.
const PLEX_CATEGORY_MAP: Record<string, string> = {
  // current live slugs
  bingeworthy: 'Entertainment',
  movies: 'Movies',
  crime: 'True Crime',
  news: 'News',
  sports: 'Sports',
  reality: 'Reality TV',
  'classic-tv': 'Classics',
  'adrenaline-sci-fi': 'Sci-Fi',
  comedy: 'Comedy',
  'daytime-tv-games': 'Game Shows',
  explore: 'Nature',
  'food-home-culture': 'Food',
  'kids-family': 'Kids',
  'en-espanol': 'En Español',
  global: 'International',
  music: 'Music',
  // legacy plex.py slugs (forward-compat)
  entertainment: 'Entertainment',
  drama: 'Drama',
  thriller: 'Thriller',
  action: 'Action',
  'history-science': 'History',
  'nature-travel': 'Nature',
  lifestyle: 'Lifestyle',
  'game-show': 'Game Shows',
  international: 'International',
  'gaming-anime': 'Anime',
};

// Categories carried in the RSC blob are keyed by the COMPOUND channel id, so the map is compound-keyed and the
// row resolves its category by its compound id (then stores it on the lean row, offline-safe).
export interface PlexCategoryMap {
  byCompound: Map<string, string>;
  spanishCompound: Set<string>;
}

/** Return the index just past the closing `}` for the JSON object starting at `start`. Ported from plex.py _find_json_end. */
function findJsonEnd(text: string, start: number): number | null {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/**
 * Brace-match the first balanced `{"categories":[…]}` object out of the RSC blob and build the compound-id →
 * category-label map (first non-'featured' slug wins per channel — plex.py _build_category_map), plus the set of
 * Spanish-bucket channel ids. Returns empty maps when the blob lacks the anchor (the name-keyword fallback then
 * categorizes). This is the "heaviest parser" the plan calls out — scoped here to ONE object, not the 3.5MB blob.
 */
export function buildCategoryMap(rscText: string): PlexCategoryMap {
  const byCompound = new Map<string, string>();
  const spanishCompound = new Set<string>();
  const anchor = '{"categories":[';
  const start = rscText.indexOf(anchor);
  if (start < 0) return { byCompound, spanishCompound };
  const end = findJsonEnd(rscText, start);
  if (end == null) return { byCompound, spanishCompound };

  let obj: { categories?: Array<{ slug?: string; channels?: Array<{ id?: string }> }> };
  try {
    obj = JSON.parse(rscText.slice(start, end));
  } catch {
    return { byCompound, spanishCompound };
  }
  for (const cat of obj.categories ?? []) {
    const slug = str(cat?.slug) ?? '';
    if (slug === 'featured') continue;
    const isSpanish = slug === 'en-espanol';
    const label = PLEX_CATEGORY_MAP[slug] ?? titleize(slug);
    for (const ch of cat?.channels ?? []) {
      const cid = str(ch?.id);
      if (!cid) continue;
      if (isSpanish) spanishCompound.add(cid);
      if (label && !byCompound.has(cid)) byCompound.set(cid, label);
    }
  }
  return { byCompound, spanishCompound };
}

/** Slug → Title Case ("food-home-culture" → "Food Home Culture") for an unmapped (future) category slug. */
function titleize(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// ── name-keyword category fallback (the ~1% the RSC misses, + the offline-without-RSC path) ──
// A compact keyword scan (the RSC categorizes ~99% of channels; this only covers the tail). NOT a full port of
// plex.py category_utils — just the high-signal buckets; everything else → 'Live TV'.
const NAME_CATEGORY: Array<[RegExp, string]> = [
  [/\bnews\b|\bcnn\b|\bmsnbc\b|\bfox news\b|\bweather\b/i, 'News'],
  [/\bsports?\b|\bespn\b|\bnfl\b|\bnba\b|\bmlb\b|\bnhl\b|\bgolf\b|\bfootball\b/i, 'Sports'],
  [/\bmovie|\bcinema|\bfilms?\b/i, 'Movies'],
  [/\bkids?\b|\bcartoon|\bbaby\b|\bjr\.?\b/i, 'Kids'],
  [/\bmusic\b|\bmtv\b|\bvevo\b|\bradio\b/i, 'Music'],
  [/\bcomedy\b/i, 'Comedy'],
  [/\bcrime\b|\bjustice\b/i, 'True Crime'],
  [/\bfood\b|\bcooking\b|\bkitchen\b/i, 'Food'],
  [/\bnature\b|\bwild\b|\btravel\b|\bnat geo\b/i, 'Nature'],
  [/\bespañol\b|\bespanol\b|\blatino\b|\btelemundo\b|\bunivision\b/i, 'En Español'],
];

function inferCategoryFromName(name: string): string {
  for (const [re, label] of NAME_CATEGORY) if (re.test(name)) return label;
  return 'Live TV';
}

// ── row shape ────────────────────────────────────────────────────────────────────────

// One catalog row, trimmed to exactly what normalize() + the EPG channel records need (drops the many unused
// channel fields so the committed snapshot stays lean). `id` is the COMPOUND id (the resolve sentinel); `channelId`
// is the STABLE gridKey (the masq _id + EPG key); `category` is the RSC/name-derived bucket.
export interface PlexRow {
  channelId: string; // stable gridKey (dedup key, masq _id, EPG channelId)
  id: string; // compound `<serverPrefix>-<channelId>` (the resolve sentinel + manifest path)
  name: string;
  logo: string | null;
  category: string; // derived category (fallback 'Live TV')
  number: number | null; // virtual channel number (vcn) when real, else null
}

/** Trim one catalog `Channel` JSON object → a lean PlexRow, or null when it lacks an id/name/playable HLS media. */
function trimChannel(ch: any, cats: PlexCategoryMap): PlexRow | null {
  const rawId = str(ch?.id);
  if (!rawId) return null;
  const channelId = str(ch?.gridKey) || stableId(rawId);
  const name = str(ch?.title) || str(ch?.callSign) || channelId;
  if (!name) return null;

  // HLS-only (the plan's mandate): drop DRM / non-HLS / media-less channels — never emit a broken master.
  const media = Array.isArray(ch?.Media) ? ch.Media[0] : null;
  if (!media || media.drm === true) return null;
  if (media.protocol && String(media.protocol).toLowerCase() !== 'hls') return null;
  if (ch?.hidden === true) return null;

  const vcn = parseInt10(ch?.vcn);
  const category = cats.byCompound.get(rawId) || (cats.spanishCompound.has(rawId) ? 'En Español' : inferCategoryFromName(name));

  return {
    channelId,
    id: rawId,
    name,
    logo: str(ch?.thumb) || str(ch?.coverPoster) || null,
    category,
    number: vcn && vcn > 0 ? vcn : null,
  };
}

// ── catalog → trimmed rows ───────────────────────────────────────────────────────────

/** Fetch the RSC blob → the category map. Best-effort: a failure logs + returns empty maps (name fallback kicks in). */
async function fetchCategoryMap(): Promise<PlexCategoryMap> {
  try {
    const res = await rawFetch(rscUrl(), { headers: { 'User-Agent': UA, Accept: '*/*', RSC: '1', 'Next-Url': '/en' } }, 30_000);
    if (!res.ok) {
      logger.warn('seed', `[plex] RSC category blob returned ${res.status} — name-keyword categories only`);
      return { byCompound: new Map(), spanishCompound: new Set() };
    }
    return buildCategoryMap(await res.text());
  } catch (err) {
    logger.warn('seed', `[plex] RSC category fetch failed (${(err as Error).message}) — name-keyword categories only`);
    return { byCompound: new Map(), spanishCompound: new Set() };
  }
}

/**
 * LIVE catalog fetch → trimmed PlexRow[]. Mints the anon token, GETs `/lineups/plex/channels` (JSON, ~695
 * channels), fetches the RSC category map, and trims each `MediaContainer.Channel`, deduping by stable channelId.
 * Retries once after a forced token refresh if the first response is 401/403. No snapshot fallback here (that's the
 * adapter's listChannels wrapper); the standalone EPG sync needs a live-only fetch that throws on total failure so a
 * transient outage preserves the existing guide. Throws on an empty catalog.
 */
export async function fetchPlexRows(): Promise<PlexRow[]> {
  let token = await ensureAuth();

  const fetchOnce = async (tok: string): Promise<Response> =>
    rawFetch(`${CHANNELS_URL}?X-Plex-Token=${encodeURIComponent(tok)}`, { headers: apiHeaders() }, 30_000);

  let res = await fetchOnce(token);
  if (res.status === 401 || res.status === 403) {
    token = await ensureAuth(true);
    res = await fetchOnce(token);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} (channels)`);

  const payload = (await res.json()) as { MediaContainer?: { Channel?: any[] } };
  const cats = await fetchCategoryMap();

  const seen = new Set<string>();
  const rows: PlexRow[] = [];
  for (const ch of payload?.MediaContainer?.Channel ?? []) {
    const row = trimChannel(ch, cats);
    if (row && !seen.has(row.channelId)) {
      seen.add(row.channelId);
      rows.push(row);
    }
  }
  rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  if (!rows.length) throw new Error('catalog payload had no channels');
  return rows;
}

// ── sentinel entry url (custom scheme — the catalog gives only ids; the master needs the token) ──
// normalize() stores `plex://<compoundId>` as the channel ENTRY (the dulo/pluto/roku custom-scheme posture — a
// sentinel, NOT a fetchable URL). isPlexEntry gates on the scheme; parsePlexEntry reads the compound id back out.

const ENTRY_SCHEME = 'plex://';

export function channelEntryUrl(compoundId: string): string {
  return `${ENTRY_SCHEME}${compoundId}`;
}

export function isPlexEntry(url: string): boolean {
  return typeof url === 'string' && url.startsWith(ENTRY_SCHEME);
}

export function parsePlexEntry(url: string): { compoundId: string } | null {
  if (!isPlexEntry(url)) return null;
  const compoundId = url.slice(ENTRY_SCHEME.length);
  return compoundId ? { compoundId } : null;
}

// ── stream resolve (build the signed master URL, per play) ──────────────────────────────

/** Best-effort channel "tune" — wakes the channel on Plex's infra. Fire-and-forget (the manifest works without it). */
function tunePlex(compoundId: string, token: string): void {
  void rawFetch(
    `${EPG_HOST}/channels/${compoundId}/tune`,
    { method: 'POST', headers: { ...apiHeaders(), 'Content-Type': 'application/json' }, body: '' },
    8_000,
  ).catch(() => {
    /* best-effort */
  });
}

/**
 * Resolve a channel → its signed library/parts HLS master url. Ensures the anon token (cached), fires a best-effort
 * tune, and builds the deterministic master URL (the provider serves the master at 200 or 302s to AWS MediaTailor;
 * the proxy follows the redirect and learns the CDN child hosts). No per-play fetch here (unlike roku's playback
 * POST) — the master URL is deterministic given the compound id + token, so a dead channel simply 4xx's at the
 * proxy's master fetch → the B-Roll "failed" slate (liveness is request-time, the family's posture). The caller
 * (the adapter's resolveStream) pre-allows the master host so the proxy's SSRF gate passes its child hops.
 */
export async function resolvePlexMaster(compoundId: string): Promise<string> {
  const token = await ensureAuth();
  tunePlex(compoundId, token);
  return (
    `${EPG_HOST}/library/parts/${compoundId}.m3u8` +
    `?includeAllStreams=1&X-Plex-Product=${encodeURIComponent(PRODUCT)}&X-Plex-Token=${encodeURIComponent(token)}`
  );
}

// ── grid EPG primitive (exported for epg/plex.ts) ───────────────────────────────────────

/**
 * Fetch one channel's guide for one day → the raw `MediaContainer.Metadata[]` airing array (or [] on any non-200 /
 * parse failure — a flaky channel/day must not abort the fanout). `gridKey` is the stable channel id; `date` is
 * 'YYYY-MM-DD' (UTC). One re-mint retry on a 401/403. The per-channel channelGridKey grid is Plex's sole EPG
 * endpoint (the bulk beginningAt/endingAt grid was retired). Mirrors plex.py _fetch_extra_day_programs's per-call.
 */
export async function fetchGrid(gridKey: string, date: string): Promise<any[]> {
  let token: string;
  try {
    token = await ensureAuth();
  } catch {
    return [];
  }
  const url = (tok: string): string =>
    `${EPG_HOST}/grid?channelGridKey=${encodeURIComponent(gridKey)}&date=${encodeURIComponent(date)}&X-Plex-Token=${encodeURIComponent(tok)}`;

  let res: Response;
  try {
    res = await rawFetch(url(token), { headers: apiHeaders() }, 12_000);
    if (res.status === 401 || res.status === 403) {
      token = await ensureAuth(true);
      res = await rawFetch(url(token), { headers: apiHeaders() }, 12_000);
    }
  } catch {
    return [];
  }
  if (!res.ok) return [];
  try {
    const payload = (await res.json()) as { MediaContainer?: { Metadata?: any[]; Video?: any[] } };
    const mc = payload?.MediaContainer ?? {};
    return mc.Metadata ?? mc.Video ?? [];
  } catch {
    return [];
  }
}
