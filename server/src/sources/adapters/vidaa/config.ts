// Vidaa Free TV (Hisense) — shared leaf constants + the bootstrap + live catalog fetch, imported by BOTH the
// adapter (sources/adapters/vidaa.ts) and the EPG module (epg/vidaa.ts), so neither imports the other (an acyclic
// leaf, mirroring adapters/vizio/config.ts + adapters/lg/config.ts). Vidaa is a DIRECT-HLS FAST source with TWO
// twists vs vizio:
//   (1) a BOOTSTRAP step — the client-configuration endpoint returns the backend origin (BOURL) + tenant that the
//       stations AND the epg/grid calls are built from; both fetch paths bootstrap() first (a cheap GET).
//   (2) GEO-QUALIFIED channel ids — the Vidaa catalog is region-fed (env VIDAA_GEO, default 'us,ca'), and the
//       SAME upstream uid can appear in multiple regions, so the source-channel id is '<GEO_UPPER>:<uid>' (the
//       FastChannels vidaa.py posture). The bare uid is recovered by splitting on the first ':' for the EPG grid
//       (which is keyed by the bare station uid).
// Each station's primary liveStream `url` IS the real HLS master, but carries '[KEY]'-style ad-DI macro
// placeholders ([CACHEBUSTER], [ADS.W], …). Unlike LG (per-play macro freshness) these are simply STRIPPED at
// catalog time (cleanStreamUrl) — the CDN serves the master without them — so vizio's identity-resolve posture
// applies (resolveStream pre-allows the host; no per-play work). DRM / DASH (mpd) streams are DROPPED (HLS-only
// proxy). The guide is a SEPARATE epg/grid fetch (epg/vidaa.ts), not inline.

const DEFAULT_GEOS = ['us', 'ca'] as const;

const API_HOST = 'https://vtvapp-ovp.vidaahub.com';
/** Client configuration: { configuration: "<json-string>" } → JSON.parse → Environment.{ BOURL, Tenant }. */
export const CONFIG_URL = `${API_HOST}/cms/vidaa-adrenalin8/clientconfiguration/versions/2`;

/** Station catalog fields requested (ported verbatim from FastChannels vidaa.py _STATIONS_FIELDS). */
export const STATIONS_FIELDS =
  'taxonomyTerms,title,uid,assetType,externalResources,relations,' +
  'channelNumber,isFast,externalIds,language,taxonomyParentTerms,' +
  'androidDeeplinkBaseUrl,organizationDomainUrl';

/** EPG grid: how many station ids per /epg/grid request, and the look-ahead window (~7d; upstream horizon ~5d). */
export const EPG_CHUNK_SIZE = 50;
export const EPG_HOURS = 168;

// Vidaa's Android-TV client UA (ported from FastChannels). The OVP gates on it + the x-user-* device headers.
export const UA =
  process.env.VIDAA_UA || 'NitroX/1.17.0-2 (Google sdk_gphone_x86; Android 11; mobile; release)';

// SSRF allowlist seed for the stream proxy — the registrable CDN families Vidaa's masters live on (from the live
// catalog: aniview.com ~32% [the SSAI ad host the masters front], cloudfront.net ~20%, amagi.tv ~16%, wurl.com,
// g-mana.live, amazonaws.com, ottera.tv, its-newid.net, plus b-cdn/akamai/fastly headroom). The adapter's dynamic
// allow-set pre-allows each stored master host at play time (resolveStream) and learns child variant/segment hosts
// during playlist rewrite (onPlaylistChildHost), so a new CDN that appears in the catalog is covered without a code
// change — private IPs are always blocked.
export const VIDAA_SUFFIXES = [
  'aniview.com',
  'cloudfront.net',
  'amagi.tv',
  'wurl.com',
  'g-mana.live',
  'amazonaws.com',
  'ottera.tv',
  'its-newid.net',
  'akamaized.net',
  'b-cdn.net',
  'fastly.net',
];

// ── geo helpers (the channel-id namespace) ───────────────────────────────────

/** Normalize one geo token to a lowercase code; blank → the first default. */
export function normalizeGeo(value: string | null | undefined): string {
  return (value || DEFAULT_GEOS[0]).trim().toLowerCase() || DEFAULT_GEOS[0];
}

/** The source-channel id namespace: '<GEO_UPPER>:<uid>' (mirrors FastChannels _qualified_channel_id). */
function qualifiedChannelId(geo: string, uid: string): string {
  return `${normalizeGeo(geo).toUpperCase()}:${uid}`;
}

/** Recover (lower-geo, bare uid) from a qualified id; a bare (':'-less) id assumes the default geo. */
export function splitQualifiedChannelId(id: string): { geo: string; uid: string } {
  const raw = (id || '').trim();
  const i = raw.indexOf(':');
  if (i < 0) return { geo: DEFAULT_GEOS[0], uid: raw };
  return { geo: normalizeGeo(raw.slice(0, i)), uid: raw.slice(i + 1).trim() };
}

/** Requested Vidaa geos: env VIDAA_GEO (csv/space), lowercased + deduped; default ['us','ca']. */
export function vidaaGeos(): string[] {
  const raw = String(process.env.VIDAA_GEO || '').trim();
  if (!raw) return [...DEFAULT_GEOS];
  const wanted = raw
    .split(/[\s,|/]+/)
    .map((s) => normalizeGeo(s))
    .filter(Boolean);
  return wanted.length ? [...new Set(wanted)] : [...DEFAULT_GEOS];
}

/** Per-geo station/grid request headers — the Android-mobile device identity the OVP gates on. */
export function stationHeaders(geo: string): Record<string, string> {
  return {
    'User-Agent': UA,
    'Accept-Language': 'en',
    'x-language': 'en',
    'x-user-device': 'android-mobile',
    'x-user-domain': normalizeGeo(geo),
  };
}

// ── genre / rating / logo / url helpers (ported from FastChannels vidaa.py) ───

// '[KEY]' / 'REPLACEME' / '{KEY}' ad-macro placeholders — stripped from the stream URL (the CDN serves the
// master without them) and from any param we extract a genre/rating from (a macro is not a real value).
const MACRO_RE = /^\[.*\]$|^REPLACEME$|^\{.*\}$/;
const GENRE_PARAM_RE = /(?:AV_CONTENT_GENRE|content_genre|_fw_content_genre)=([^&]+)/i;
const RATING_PARAM_RE = /(?:AV_CONTENT_RATING|content_rating|_fw_content_rating)=([^&]+)/i;
const IAB_PARAM_RE = /(?:AV_CONTENT_CAT|content_category|_fw_content_category)=([^&]+)/i;

const IAB_GENRES: Record<string, string> = {
  IAB1: 'Entertainment',
  'IAB1-5': 'Movies',
  'IAB1-6': 'Music',
  'IAB1-7': 'Entertainment',
  IAB6: 'Kids',
  IAB12: 'News',
  'IAB12-1': 'News',
  IAB17: 'Sports',
  'IAB17-6': 'Sports',
  'IAB17-9': 'Sports',
  'IAB17-10': 'Sports',
  'IAB17-44': 'Sports',
  IAB18: 'Lifestyle',
  IAB20: 'Travel',
  IAB22: 'Shopping',
  'IAB23-2': 'Faith',
};

const GENRE_NORM: Record<string, string> = {
  television: 'Entertainment',
  entertainment: 'Entertainment',
  movies: 'Movies',
  movie: 'Movies',
  gameshow: 'Game Shows',
  realitytv: 'Reality TV',
  reality: 'Reality TV',
  music: 'Music',
  sports: 'Sports',
  sport: 'Sports',
  soccer: 'Sports',
  news: 'News',
  religious: 'Faith',
  religion: 'Faith',
  animation: 'Kids',
  shopping: 'Shopping',
  lifestyle: 'Lifestyle',
  drama: 'Drama',
  comedy: 'Comedy',
  variedades: 'Entertainment',
  soapopera: 'Drama',
  daytimadrama: 'Drama',
};

const US_TV_RATINGS = new Set(['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA']);
const MPAA_RATINGS = new Set(['G', 'PG', 'PG-13', 'R', 'NC-17']);

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Map one raw genre label to the normalized vocabulary (first comma-segment, alnum-keyed); else the label. */
function normalizeGenre(raw: string): string | null {
  const first = safeDecode(raw).trim().split(',')[0].trim();
  if (!first) return null;
  const key = first.toLowerCase().replace(/[\s_-]/g, '');
  return GENRE_NORM[key] || first;
}

/** Pull a channel genre from taxonomyTerms.genres, then the stream URL's genre / IAB-category params. */
function extractGenre(station: any, streamUrl: string): string | null {
  const tax = station?.taxonomyTerms;
  if (tax && typeof tax === 'object') {
    const genres = Object.values((tax.genres as Record<string, string>) || {});
    if (genres.length) return normalizeGenre(String(genres[0])) || String(genres[0]);
  }
  const g = GENRE_PARAM_RE.exec(streamUrl);
  if (g) {
    const raw = safeDecode(g[1]).trim();
    if (!MACRO_RE.test(raw)) {
      const norm = normalizeGenre(raw);
      if (norm) return norm;
    }
  }
  const i = IAB_PARAM_RE.exec(streamUrl);
  if (i) {
    const iab = safeDecode(i[1]).trim().toUpperCase();
    if (!MACRO_RE.test(iab)) return IAB_GENRES[iab] || null;
  }
  return null;
}

/** Pull a US TV / MPAA rating from the stream URL's rating param; else null (a macro / unknown code → null). */
function extractRating(streamUrl: string): string | null {
  const m = RATING_PARAM_RE.exec(streamUrl);
  if (!m) return null;
  const raw = safeDecode(m[1]).trim().toUpperCase().replace('TVG', 'TV-G').replace('TV14', 'TV-14');
  return US_TV_RATINGS.has(raw) || MPAA_RATINGS.has(raw) ? raw : null;
}

/** Prefer a 1:1 then 16:9 station logo (by aspectRatio); else the first image. */
function pickLogo(station: any): string | null {
  const imgs = (station?.externalResources?.image as any[]) || [];
  if (!imgs.length) return null;
  const norm = (ar: unknown): string => String(ar ?? '').replace(/:/g, 'x').toLowerCase();
  for (const preferred of ['1x1', '16x9']) {
    for (const img of imgs) {
      if (norm(img?.metadata?.aspectRatio) === preferred) return img?.cdnUrl || null;
    }
  }
  return imgs[0]?.cdnUrl || null;
}

/**
 * Strip ad-macro placeholder query params ('[KEY]'/'REPLACEME'/'{KEY}') and dedupe keys; also fixes the known
 * Triton Poker malformed URL (raw JSON appended after an unescaped '"' — truncate the value at it). The CDN
 * serves the master without the ad params, so unlike LG's per-play macros this is a one-time clean at catalog
 * time (the cleaned URL is the stored master). Mirrors FastChannels vidaa.py _clean_stream_url.
 */
export function cleanStreamUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url; // unparseable — store as-is (normalize drops a non-http master)
  }
  const seen = new Set<string>();
  const keep: [string, string][] = [];
  for (const [k, vRaw] of u.searchParams.entries()) {
    let v = vRaw;
    const q = v.indexOf('"');
    if (q >= 0) v = v.slice(0, q); // Triton Poker: truncate at the stray quote
    if (!MACRO_RE.test(v) && !seen.has(k)) {
      keep.push([k, v]);
      seen.add(k);
    }
  }
  u.search = '';
  const sp = new URLSearchParams();
  for (const [k, v] of keep) sp.append(k, v);
  const qs = sp.toString();
  return qs ? `${u.toString()}?${qs}` : u.toString();
}

// ── row shape ────────────────────────────────────────────────────────────────

// One catalog row, trimmed to exactly the fields normalize() + the EPG builder need (drops the many unused station
// fields so the committed snapshot stays lean). `channelId` is GEO-QUALIFIED ('<GEO_UPPER>:<uid>'); `streamUrl` is
// the already-CLEANED master (ad macros stripped) so the snapshot round-trips verbatim via rebuild-source-seed.ts.
// `drm` flags a DASH/DRM primary stream (kept for snapshot faithfulness but dropped by normalize + the EPG gate —
// the vizio precedent). `stationId` is Vidaa's tva-stationId (a Gracenote-adjacent station id) carried for a future
// crosswalk addon (derivable from the catalog, like vizio's tmsStationId); unused today.
export interface VidaaRow {
  channelId: string; // '<GEO_UPPER>:<uid>'
  name: string;
  streamUrl: string; // cleaned HLS master (or a non-http leftover normalize drops)
  logo: string | null;
  category: string | null; // extracted genre (channel grouping + program category fallback)
  number: number | null; // channelNumber
  stationId: string | null; // externalIds.tva-stationId (future crosswalk; unused today)
  rating: string | null; // a channel-level rating sniffed from the stream URL (program rating fallback)
  drm: boolean; // true ⇒ DASH/DRM primary stream → dropped (HLS-only proxy)
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

/**
 * The coarse "this row becomes a streamable channel" gate, shared by normalize() (the playlist channels) and the
 * EPG builder (the guide channels) so both surface the SAME set: a non-DRM/non-DASH primary stream. normalize
 * additionally drops a row whose cleaned URL isn't http(s); that single edge case only yields a harmless orphan
 * guide channel.
 */
export function isSurfacedRow(row: VidaaRow): boolean {
  return !row.drm && !!row.streamUrl;
}

/** Trim one upstream station (within a geo) to a lean VidaaRow, or null when it has no usable primary stream. */
function trimStation(station: any, geo: string): VidaaRow | null {
  const uid = str(station?.uid);
  const name = str(station?.title);
  if (!uid || !name) return null;

  const streams = (station?.externalResources?.liveStream as any[]) || [];
  const primary = streams[0];
  const rawUrl = str(primary?.url);
  if (!primary || !rawUrl) return null;

  const meta = primary.metadata || {};
  const drm = !!meta.drmType || String(meta.streamType || '').toLowerCase() === 'mpd';

  return {
    channelId: qualifiedChannelId(geo, uid),
    name,
    streamUrl: cleanStreamUrl(rawUrl),
    logo: pickLogo(station),
    category: extractGenre(station, rawUrl),
    number: parseInt10(station?.channelNumber),
    stationId: str(station?.externalIds?.['tva-stationId']),
    rating: extractRating(rawUrl),
    drm,
  };
}

// ── bootstrap + live fetch ─────────────────────────────────────────────────────

/**
 * Fetch the client configuration → the backend origin (BOURL) + tenant the stations/grid calls are built from.
 * A fresh GET each sync (stateless leaf — the modules hold no instance state); the OVP rotates these rarely but we
 * never cache a stale origin. Throws on HTTP error or a malformed configuration.
 */
export async function bootstrap(): Promise<{ boUrl: string; tenant: string }> {
  // `Accept-Language: en` is REQUIRED: undici's fetch defaults Accept-Language to '*', which this OVP rejects
  // with HTTP 400 `{"error":"Language \"*\" is not supported"}` (curl, which sends no Accept-Language, gets 200).
  const res = await fetch(CONFIG_URL, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} (config)`);
  const outer = (await res.json()) as { configuration?: string };
  if (!outer?.configuration) throw new Error("Vidaa client configuration missing 'configuration' key");
  const appConfig = JSON.parse(outer.configuration);
  const boUrl = str(appConfig?.Environment?.BOURL);
  const tenant = str(appConfig?.Environment?.Tenant);
  if (!boUrl || !tenant) throw new Error('Vidaa bootstrap missing BOURL/Tenant');
  return { boUrl, tenant };
}

/** The stations catalog URL for a bootstrapped backend (geo is passed via headers, not the path). */
export function stationsUrl(boUrl: string, tenant: string): string {
  const qs = new URLSearchParams({ fields: STATIONS_FIELDS });
  return `${boUrl}/catalogue-search/${tenant}/search/public/usercontext/epg/stations?${qs}`;
}

/** The epg/grid URL for a bootstrapped backend + a chunk of bare station uids + an ISO time window. */
export function gridUrl(
  boUrl: string,
  tenant: string,
  stationIds: string[],
  startTime: string,
  endTime: string,
): string {
  const qs = new URLSearchParams({ stationIds: stationIds.join(','), startTime, endTime });
  return `${boUrl}/catalogue-search/${tenant}/search/public/usercontext/epg/grid?${qs}`;
}

/**
 * LIVE catalog fetch → trimmed VidaaRow[] across every requested geo. Bootstraps once, then fetches each geo's
 * stations; a per-geo failure is logged-by-throw-skip (caught here) so one geo being down/region-gated doesn't lose
 * the others — but bootstrap failing, or ALL geos failing (zero rows), throws so the adapter's listChannels falls
 * back to the snapshot and the standalone EPG sync fails loudly (the established live-only posture). Dedupes ids
 * across geos (first geo wins). No snapshot fallback here (that's the adapter's listChannels wrapper).
 */
export async function fetchVidaaRows(): Promise<VidaaRow[]> {
  const { boUrl, tenant } = await bootstrap();
  const url = stationsUrl(boUrl, tenant);
  const geos = vidaaGeos();

  const rows: VidaaRow[] = [];
  const seen = new Set<string>();
  let lastErr: unknown = null;
  for (const geo of geos) {
    try {
      const res = await fetch(url, { headers: stationHeaders(geo) });
      if (!res.ok) throw new Error(`HTTP ${res.status} (stations geo=${geo})`);
      const stations = await res.json();
      if (!Array.isArray(stations)) throw new Error(`stations response not a list (geo=${geo})`);
      for (const station of stations) {
        const row = trimStation(station, geo);
        if (!row || seen.has(row.channelId)) continue;
        seen.add(row.channelId);
        rows.push(row);
      }
    } catch (err) {
      lastErr = err; // skip this geo; surface only if EVERY geo fails (rows stays empty)
    }
  }
  if (!rows.length) throw new Error(`stations had no channels${lastErr ? `: ${(lastErr as Error).message}` : ''}`);
  return rows;
}
