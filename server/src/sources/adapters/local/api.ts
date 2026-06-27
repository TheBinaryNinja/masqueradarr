// Local Now data-source core — the ported FastChannels app/scrapers/localnow.py bootstrap + fetchers.
// Local Now is a US FAST service whose channel lineup AND guide are keyed to a MARKET (a numeric DMA code +
// a comma-joined list of market/PBS slugs). Everything here is ANONYMOUS: a short-lived DSP JWT is lifted
// from the homepage's __NEXT_DATA__ blob and cached per process (refreshed near expiry) — there is no
// per-user auth surface (NOT a PlaylistAuth source). The service is US-geo-gated: outside the US the
// homepage 403s or omits __NEXT_DATA__, surfaced here as a typed LocalNowError(geoBlock) the routes map to
// an actionable 400 (a user-created Local playlist has no committed snapshot fallback, unlike a built-in).
//
// This module owns ONLY the upstream protocol (bootstrap, City/Search, the live/epg catalog, the per-play
// resolve). The synthetic `local` adapter (./index.ts) wires resolvePlayback into the proxy; the custom-
// playlist sync (./import.ts) + playlist-bound self-EPG (../../../epg/local.ts) consume fetchMarket. See
// .claude/docs/localnow-datasource.md.

import { logger } from '../../core/logger.js';

export interface LocalMarket {
  label: string; // display name, e.g. "New York, NY" (City/Search) or a humanized slug (auto-detect)
  dma: string; // numeric DMA id, e.g. "501"
  market: string; // comma-joined market + PBS slugs, e.g. "nyNewYorkCity,pbs-wnet,pbs-wedh"
}

export interface LocalRawProgram {
  starts_at?: number | string | null;
  ends_at?: number | string | null;
  program_title?: string | null;
  episode_title?: string | null;
  season?: number | string | null;
  episode?: number | string | null;
  program_description?: string | null;
  image?: string | null;
  rating?: string | null;
  program_id?: string | null;
}

export interface LocalRawChannel {
  video_id?: string | null;
  _id?: string | null;
  name?: string | null;
  slug?: string | null;
  logo?: string | null;
  genres?: string[] | null;
  iab_genres?: string[] | null;
  description?: string | null;
  language?: string | null;
  channel_number?: number | string | null;
  rating?: string | null;
  poster?: string | null;
  subscription_access?: { unlocked?: boolean } | null;
  program?: LocalRawProgram[] | null;
}

const HOME_URL = 'https://localnow.com/';
export const CHANNELS_PAGE_URL = 'https://localnow.com/channels';
const CITY_SEARCH_URL = 'https://prod.localnowapi.com/gis/api/v2/City/Search';
const DEFAULT_DSP_HOST = 'data-store-trans-cdn.api.cms.amdvids.com';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

// Headers replayed on every Local Now hop (homepage, catalog, City/Search, the resolved CDN master). The
// DSP backend + CDN are Origin-gated to localnow.com (the FastChannels posture).
export const LOCAL_STREAM_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Origin: 'https://localnow.com',
  Referer: 'https://localnow.com/',
};

// SSRF allow-set SEED for the synthetic `local` adapter (createDynamicAllow). The DSP host + localnow
// domains are known; the per-play `video_m3u8` lives on a rotating CDN we can't predict, so resolveStream
// pre-allows the resolved master host and the proxy's onPlaylistChildHost learns variant/segment hosts at
// play time (the distro/dlhd dynamic-allow pattern). Private/loopback targets are always blocked.
export const LOCAL_CDN_SUFFIXES = ['amdvids.com', 'localnow.com', 'localnowapi.com'];

export const GEO_BLOCK_MESSAGE =
  "Local Now is US-only and this server's IP appears to be outside the US (the homepage returned no runtime " +
  'config). Connect through a US network/VPN to add a Local Now playlist, or choose a different source.';

// A typed error so the routes can map a geo-block to a clean, actionable 400 (vs a generic upstream failure).
export class LocalNowError extends Error {
  geoBlock: boolean;
  constructor(message: string, geoBlock = false) {
    super(message);
    this.name = 'LocalNowError';
    this.geoBlock = geoBlock;
  }
}

// New York City — the FastChannels known-good fallback when auto-detect can't read a market off the homepage.
const NYC_FALLBACK: LocalMarket = {
  label: 'New York, NY',
  dma: '501',
  market: 'nyNewYorkCity,pbs-wnet,pbs-wedh,pbs-wliw,pbs-wnjt',
};

// ── module-cached runtime (token + endpoints + geo default), refreshed near expiry ───────────────────────
let token: string | null = null;
let tokenExpiresMs = 0;
let dspHost = DEFAULT_DSP_HOST;
let lnApiKey: string | null = null;
let geoDefault: LocalMarket | null = null;

// JWT `exp` (seconds) → epoch ms; null when the token can't be decoded (caller defaults to +12h).
function decodeJwtExpMs(jwt: string): number | null {
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: number };
    return json.exp ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

function extractNextData(html: string): Record<string, unknown> | null {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">\s*([\s\S]*?)\s*<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Best-effort pull of a DMA id out of a homepage cookie value (object or string), per localnow.py.
function extractDmaId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const k of ['dmaId', 'dma_id', 'dma']) if (o[k]) return String(o[k]);
    return null;
  }
  const s = String(value);
  const keyed = s.match(/"?dmaId"?\s*[:=]\s*"?(\d+)/);
  if (keyed) return keyed[1];
  const bare = s.match(/\b(\d{3,4})\b/);
  return bare ? bare[1] : null;
}

// Best-effort pull of a market slug ("ohColumbus" style) out of a homepage cookie value, per localnow.py.
function extractMarketSlug(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const k of ['market', 'slug', 'citySlug', 'marketSlug']) if (o[k]) return String(o[k]);
    return null;
  }
  const s = String(value);
  const keyed = s.match(/"?(?:market|slug|citySlug|marketSlug)"?\s*[:=]\s*"?([A-Za-z0-9_-]+)/);
  if (keyed) return keyed[1];
  const camel = s.match(/\b([a-z]{2}[A-Z][A-Za-z0-9]+)\b/);
  return camel ? camel[1] : null;
}

// Read the geo-detected default DMA + market off the homepage's pageProps (serverCookies + localNow config).
function discoverGeoDefault(nextData: Record<string, unknown>): { dma: string | null; market: string | null } {
  const props = (nextData.props ?? {}) as Record<string, unknown>;
  const pageProps = (props.pageProps ?? {}) as Record<string, unknown>;
  const cookies = (pageProps.serverCookies ?? {}) as Record<string, unknown>;
  const myMarket = cookies._ln_myMarket;
  const myCity = cookies._ln_myCity;
  const detectedCity = cookies._ln_myDetectedCity;

  const dma = extractDmaId(myMarket) || extractDmaId(detectedCity) || extractDmaId(myCity);

  const parts: string[] = [];
  const citySlug = extractMarketSlug(myMarket) || extractMarketSlug(myCity) || extractMarketSlug(detectedCity);
  if (citySlug) parts.push(citySlug);
  const config = (pageProps.config ?? {}) as Record<string, unknown>;
  const localNowCfg = (config.localNow ?? {}) as Record<string, unknown>;
  const pbs = (localNowCfg.pbsMarkets ?? cookies._ln_pbsMarkets) as unknown;
  if (typeof pbs === 'string' && pbs.trim()) {
    for (const x of pbs.split(',')) {
      const t = x.trim();
      if (t) parts.push(t);
    }
  }
  const market = parts.length ? [...new Set(parts)].join(',') : null;
  return { dma, market };
}

// "nyNewYorkCity,pbs-wnet" → "New York City": strip a leading 2-letter state code, space out camelCase.
export function humanizeMarketSlug(market: string): string {
  const first = String(market || '').split(',')[0] || '';
  const stripped = first.replace(/^[a-z]{2}(?=[A-Z])/, '');
  const spaced = stripped.replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return spaced || first || 'Local Now';
}

// Bootstrap the runtime config (token + DSP host + API key + geo default) from the homepage, caching until
// ~2 min before the JWT expires. Throws LocalNowError(geoBlock) when the page is region-blocked.
async function ensureBootstrap(): Promise<void> {
  if (token && Date.now() < tokenExpiresMs - 120_000) return;

  let resp: Response;
  try {
    resp = await fetch(HOME_URL, { headers: LOCAL_STREAM_HEADERS, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new LocalNowError(`Local Now homepage unreachable: ${(err as Error).message}`);
  }
  if (resp.status === 403 || resp.status === 451) throw new LocalNowError(GEO_BLOCK_MESSAGE, true);
  if (!resp.ok) throw new LocalNowError(`Local Now homepage HTTP ${resp.status}`);

  const nextData = extractNextData(await resp.text());
  if (!nextData) throw new LocalNowError(GEO_BLOCK_MESSAGE, true);
  const rc = (nextData.runtimeConfig ?? {}) as Record<string, unknown>;
  if (!rc.DSP_TOKEN) throw new LocalNowError('Local Now runtime config missing (DSP_TOKEN)');

  dspHost = String(rc.DSP_API_URL || DEFAULT_DSP_HOST);
  lnApiKey = rc.LN_API_KEY ? String(rc.LN_API_KEY) : null;

  let tkn: string | null = null;
  try {
    const tokenObj = JSON.parse(String(rc.DSP_TOKEN)) as { token?: string };
    tkn = tokenObj.token ?? null;
  } catch (err) {
    throw new LocalNowError(`Local Now DSP_TOKEN parse failed: ${(err as Error).message}`);
  }
  if (!tkn) throw new LocalNowError('Local Now token missing inside DSP_TOKEN');

  token = tkn;
  tokenExpiresMs = decodeJwtExpMs(tkn) ?? Date.now() + 12 * 3_600_000;

  const { dma, market } = discoverGeoDefault(nextData);
  geoDefault = dma && market ? { dma, market, label: humanizeMarketSlug(market) } : null;

  logger.info(
    'local',
    `bootstrapped host=${dspHost} dma=${dma ?? '—'} market=${market ?? '—'} tokenExp=${new Date(tokenExpiresMs).toISOString()}`,
  );
}

// ── public API ───────────────────────────────────────────────────────────────────────────────────────────

/** City/Market typeahead → [{ label, dma, market }]. Needs LN_API_KEY (from bootstrap); [] when absent. */
export async function searchCities(query: string): Promise<LocalMarket[]> {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  await ensureBootstrap();
  if (!lnApiKey) {
    logger.warn('local', 'LN_API_KEY unavailable — city search disabled');
    return [];
  }
  const resp = await fetch(`${CITY_SEARCH_URL}?${new URLSearchParams({ text: q })}`, {
    headers: { ...LOCAL_STREAM_HEADERS, Accept: 'application/json', 'x-api-key': lnApiKey },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new LocalNowError(`City/Search HTTP ${resp.status}`);
  const data = (await resp.json()) as Array<Record<string, unknown>>;
  const out: LocalMarket[] = [];
  for (const city of Array.isArray(data) ? data : []) {
    const market = String(city.market ?? '').trim();
    const pbs = String(city.pbsMarkets ?? '').trim();
    const combined = [market, pbs].filter(Boolean).join(',');
    if (!combined) continue;
    const dma = String(city.dmaId ?? city.zipDma ?? '');
    out.push({ label: String(city.cityStateName || city.name || 'Unknown'), dma, market: combined });
  }
  return out;
}

/** The geo-detected default market (auto-detect), falling back to NYC when the homepage carries none. */
export async function detectMarket(): Promise<LocalMarket> {
  await ensureBootstrap();
  return geoDefault ?? NYC_FALLBACK;
}

/** Fetch a market's catalog + inline guide (one call) → the raw channels array. */
export async function fetchMarket(dma: string, market: string): Promise<LocalRawChannel[]> {
  await ensureBootstrap();
  const url = `https://${dspHost}/live/epg/US/website?${new URLSearchParams({ dma, market })}`;
  const resp = await fetch(url, {
    headers: { ...LOCAL_STREAM_HEADERS, Accept: 'application/json, text/plain, */*', 'x-access-token': token! },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new LocalNowError(`live/epg HTTP ${resp.status}`);
  const payload = (await resp.json()) as { channels?: LocalRawChannel[] };
  return payload.channels ?? [];
}

/** Resolve a channel's opaque sentinel to a fresh master HLS URL (per play). */
export async function resolvePlayback(videoId: string, slug: string | null): Promise<{ masterUrl: string }> {
  await ensureBootstrap();
  const pageUrl = slug ? `${CHANNELS_PAGE_URL}/${slug}` : CHANNELS_PAGE_URL;
  // The page_url value is itself percent-encoded BEFORE URLSearchParams encodes the query (so it arrives
  // double-encoded at the DSP backend) — the exact shape the FastChannels resolve() sends.
  const params = new URLSearchParams({
    page_url: encodeURIComponent(pageUrl),
    device_devicetype: 'desktop_web',
    app_version: '0.0.0',
    app_bundle: 'web.localnow',
    ccpa_us_privacy: '1YNY',
  });
  const url = `https://${dspHost}/video/play/${encodeURIComponent(videoId)}/1920/1080?${params}`;
  const resp = await fetch(url, {
    headers: { ...LOCAL_STREAM_HEADERS, Accept: 'application/json, text/plain, */*', 'x-access-token': token! },
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new LocalNowError(`video/play HTTP ${resp.status}`);
  const json = (await resp.json()) as { video_m3u8?: string; session_m3u8?: string };
  const masterUrl = json.video_m3u8 || json.session_m3u8 || '';
  if (!masterUrl) throw new LocalNowError(`no playback URL for ${videoId}`);
  return { masterUrl };
}

// The genre tag Local Now stamps on a channel that is NOT in the requested market — its own "More Cities"
// pool of OTHER DMAs' local stations, served identically in every market (~249 channels in NY/Columbus/LA
// alike). The requested market's own locals instead carry "My City" (mutually exclusive — never both), and
// the national FAST channels carry neither. Confirmed against live /live/epg samples; the tag lives ONLY in
// `genres` (never iab_genres/category). See .claude/docs/localnow-datasource.md.
export const MORE_CITIES_GENRE = 'More Cities';

/** True when a channel belongs to Local Now's cross-market "More Cities" pool (out of the requested market). */
export function isMoreCities(ch: LocalRawChannel): boolean {
  return (ch.genres ?? []).includes(MORE_CITIES_GENRE);
}

/**
 * Dedupe (by id) and drop the channels a Local Now playlist should not carry: ones with no id,
 * subscription-locked ones (`subscription_access.unlocked === false`), and OUT-OF-MARKET "More Cities"
 * channels (so a per-market playlist keeps only the market's own "My City" locals + the national channels,
 * giving each market a definitive, non-overlapping lineup — the new default for every Local Now playlist).
 * Shared by the catalog sync (import.ts) AND the standalone self-EPG (epg/local.ts) so both operate on the
 * SAME scoped channel set. Returns [channel, bareId] pairs (id resolved once).
 */
export function selectChannels(raw: LocalRawChannel[]): Array<{ ch: LocalRawChannel; id: string }> {
  const seen = new Set<string>();
  const out: Array<{ ch: LocalRawChannel; id: string }> = [];
  let outOfMarket = 0;
  for (const ch of raw ?? []) {
    const id = String(ch.video_id ?? ch._id ?? '').trim();
    if (!id || seen.has(id)) continue;
    if (ch.subscription_access && ch.subscription_access.unlocked === false) continue; // locked → skip
    if (isMoreCities(ch)) {
      outOfMarket++;
      continue; // out-of-market "More Cities" → skip (keep only this market's locals + national)
    }
    seen.add(id);
    out.push({ ch, id });
  }
  if (outOfMarket) logger.info('local', `excluded ${outOfMarket} out-of-market "More Cities" channel(s)`);
  return out;
}
