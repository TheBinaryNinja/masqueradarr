// Distro TV — shared leaf constants + the geo helpers, macro fill, tag/title parsers, and the live catalog
// fetch, imported by BOTH the adapter (sources/adapters/distro.ts) and the EPG module (epg/distro.ts), so
// neither imports the other (an acyclic leaf, mirroring adapters/vidaa/config.ts + adapters/freelivesports/
// config.ts). Distro is the EIGHTH FastChannels FAST source ported and a TIER-B (macro-expansion) port. Like
// LG/FreeLiveSports it is DIRECT-HLS + PER-PLAY macro expansion — each live show's seasons[0].episodes[0].
// content.url IS the real HLS master (the path ends .m3u8) but carries jsrdn VAST ad macros in the query string
// (the DOUBLE-underscore `__MACRO__` vocab, e.g. __CACHE_BUSTER__/__DEVICE_ID__/__GEO_COUNTRY__) that must be
// FRESH per play, so resolveStream fills them at play time (the FastChannels distro.py `resolve()` posture)
// rather than baking a subset in at normalize. TWO twists vs FreeLiveSports:
//   (1) GEO-QUALIFIED channel ids — the getfeed catalog is region-fed (env DISTRO_GEO, default 'US'), and the
//       SAME upstream tvg_id can appear in multiple regions, so the source-channel id is '<GEO>:<tvg_id>' (the
//       FastChannels _qualified_channel_id posture; geos are uppercase, the jsrdn `&geo=` param's own casing).
//   (2) the guide is a SEPARATE epg/query.php fetch keyed by the BARE tvg_id (epg/distro.ts), not inline.
// The catalog fetch uses an Android-TV UA (the jsrdn feed gates on it); the STREAM proxy instead needs the
// browser UA + distro.tv Origin/Referer (the cloudfront/publica CDNs are Origin-restricted) — see DISTRO_STREAM_
// HEADERS, fed to the adapter's upstreamHeaders. No auth, no resolve hop.

import { randomUUID } from 'node:crypto';

// Public, keyless catalog + guide endpoints (the jsrdn `tv_v5` backend). FEED is the live channel catalog;
// EPG is the schedule query (epg/distro.ts). Ported verbatim from FastChannels distro.py FEED_URL / EPG_URL.
export const FEED_URL = 'https://tv.jsrdn.com/tv_v5/getfeed.php?type=live';
export const EPG_URL = 'https://tv.jsrdn.com/epg/query.php';

// The jsrdn getfeed/query backend gates the CATALOG + GUIDE on an Android-TV (DistroTV app) UA. Ported from
// FastChannels distro.py ANDROID_UA.
export const ANDROID_UA =
  process.env.DISTRO_UA ||
  'Dalvik/2.1.0 (Linux; U; Android 9; AFTT Build/STT9.221129.002) GTV/AFTT DistroTV/2.0.9';

// The catalog/guide request headers (Android-TV UA + JSON Accept). Distinct from the STREAM proxy headers.
export const DISTRO_CATALOG_HEADERS: Record<string, string> = {
  'User-Agent': ANDROID_UA,
  Accept: 'application/json,*/*',
};

// The STREAM proxy headers — Distro's masters live on Origin/Referer-restricted CDNs (the d35j504z0x2vu2 /v1/
// master CDN 404s without them), so the proxy presents a desktop browser UA + the distro.tv Origin/Referer on
// EVERY upstream hop (master/variant/segment). Ported from FastChannels distro.py HLS_HEADERS.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
export const DISTRO_STREAM_HEADERS: Record<string, string> = {
  'User-Agent': BROWSER_UA,
  Origin: 'https://distro.tv',
  Referer: 'https://distro.tv/',
};

// SSRF allowlist seed for the stream proxy — the registrable CDN families Distro's masters live on (from the
// live US feed: cloudfront.net ~78%, getpublica.com ~11%, amagi.tv ~5%, caton.cloud, cdn01.net, plus
// broadpeak/akamai/fastly headroom). The adapter's dynamic allow-set pre-allows each macro-filled master host at
// play time (resolveStream) and learns child variant/segment hosts during playlist rewrite (onPlaylistChildHost),
// so a new CDN that appears in the catalog is covered without a code change — private IPs are always blocked.
export const DISTRO_SUFFIXES = [
  'cloudfront.net',
  'getpublica.com',
  'amagi.tv',
  'caton.cloud',
  'cdn01.net',
  'broadpeak.io',
  'akamaized.net',
  'fastly.net',
  'b-cdn.net',
  'wurl.com',
];

// ── geo helpers (the channel-id namespace) ───────────────────────────────────

const DEFAULT_GEO = 'US';

/** Normalize one geo token to an UPPER code (the jsrdn `&geo=` param's casing); blank → 'US'. */
export function normalizeGeo(value: string | null | undefined): string {
  return (value || DEFAULT_GEO).trim().toUpperCase() || DEFAULT_GEO;
}

/** The source-channel id namespace: '<GEO>:<tvg_id>' (mirrors FastChannels _qualified_channel_id). */
function qualifiedChannelId(geo: string, tvgId: string): string {
  return `${normalizeGeo(geo)}:${tvgId}`;
}

/** Recover (geo, bare tvg_id) from a qualified id; a bare (':'-less) id assumes the default geo. */
export function splitQualifiedChannelId(id: string): { geo: string; tvgId: string } {
  const raw = (id || '').trim();
  const i = raw.indexOf(':');
  if (i < 0) return { geo: DEFAULT_GEO, tvgId: raw };
  return { geo: normalizeGeo(raw.slice(0, i)), tvgId: raw.slice(i + 1).trim() };
}

/**
 * Requested Distro geos: env DISTRO_GEO (csv/space), uppercased + deduped; default ['US']. 'US' is the bare
 * getfeed (no `&geo=` param, ~93 channels); other codes (CA/MX/AR/QQ…) append `&geo=<GEO>`. 'QQ' is jsrdn's
 * worldwide feed (extra channels), per FastChannels distro.py.
 */
export function distroGeos(): string[] {
  const raw = String(process.env.DISTRO_GEO || '').trim();
  if (!raw) return [DEFAULT_GEO];
  const wanted = raw
    .split(/[\s,|/]+/)
    .map((s) => normalizeGeo(s))
    .filter(Boolean);
  return wanted.length ? [...new Set(wanted)] : [DEFAULT_GEO];
}

/** The catalog feed URL for a geo: bare for 'US' (the default feed), `&geo=<GEO>` otherwise. */
export function feedUrl(geo: string): string {
  const g = normalizeGeo(geo);
  return g === DEFAULT_GEO ? FEED_URL : `${FEED_URL}&geo=${g}`;
}

// ── per-play stream-macro expansion ───────────────────────────────────────────

// Stable per-process device id for the ad-targeting `__DEVICE_ID__` param (the masq precedent — fresh once per
// process, NOT per play, unlike FastChannels distro.py which mints one per call; ad targeting only, no playback
// effect). Matches any leftover `__MACRO__` ad token after the fixed fill — stripped to empty (the CDN serves the
// master without them). Mirrors FastChannels distro.py MACRO_RE (`__[^_].*?__`).
const DEVICE_ID = randomUUID();
const MACRO_RE = /__[^_].*?__/g;

/** Fresh-per-call jsrdn ad-macro fills (the DOUBLE-underscore vocab; ported from distro.py MACRO_REPLACEMENTS). */
function macroFills(): Record<string, string> {
  return {
    __CACHE_BUSTER__: String(Date.now()),
    __DEVICE_ID__: DEVICE_ID,
    __LIMIT_AD_TRACKING__: '0',
    __IS_GDPR__: '0',
    __IS_CCPA__: '0',
    __GEO_COUNTRY__: 'US',
    __LATITUDE__: '',
    __LONGITUDE__: '',
    __GEO_DMA__: '',
    __GEO_TYPE__: '',
    __PAGEURL_ESC__: 'https%3A%2F%2Fdistro.tv%2F',
    __STORE_URL__: 'https%3A%2F%2Fdistro.tv%2F',
    __APP_BUNDLE__: 'distro.tv',
    __APP_VERSION__: '0',
    __APP_CATEGORY__: '',
    __WIDTH__: '1920',
    __HEIGHT__: '1080',
    __DEVICE__: 'Linux',
    __DEVICE_ID_TYPE__: 'uuid',
    __DEVICE_CONNECTION_TYPE__: '',
    __DEVICE_CATEGORY__: 'desktop',
    '__env.i__': 'web',
    '__env.u__': 'web',
    __PALN__: '',
    __GDPR_CONSENT__: '',
    __ADVERTISING_ID__: '',
    __CLIENT_IP__: '',
  };
}

/**
 * Fill the per-play VAST ad macros baked into a Distro master, FRESH per call (`__CACHE_BUSTER__` = current ms,
 * the cache-buster that must be current). A pure string replace on the (once-decoded) entry url — NOT a
 * re-serialized URL.href — so the literal `__KEY__` tokens, which survive the proxy's single
 * encodeURIComponent/decodeURIComponent round-trip (underscores are unreserved), still match (the same reason
 * lg/freelivesports use a string replace). The double-underscore delimiters prevent substring collisions
 * (`__DEVICE__` never matches inside `__DEVICE_ID__`). Any leftover unmapped `__MACRO__` is then stripped to
 * empty. ONE Distro-specific quirk: on the d3s7x6kmqcnb6b `/d/distro001a/` CDN the ad params make the CDN serve a
 * BROKEN master, so the whole query is dropped there (the `/v1/master/` CDN requires them — keep). Mirrors
 * FastChannels distro.py `resolve()` + `_sanitize_url`.
 */
export function fillStreamMacros(url: string): string {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.pathname.startsWith('/d/distro001a/')) return `${u.origin}${u.pathname}`;
  } catch {
    /* unparseable — fall through to the string replace (normalize already dropped non-http masters) */
  }
  let out = url;
  for (const [key, value] of Object.entries(macroFills())) out = out.split(key).join(value);
  return out.replace(MACRO_RE, '');
}

// ── tag → category parsing (ported from FastChannels distro.py) ─────────────────

// Tags that indicate language/region rather than content genre — split out of the category so a channel groups
// by its real genre (e.g. 'News,Current Affairs,Asian' → category 'News'). Distro stores everything comma-joined
// in one `genre` field.
const LANG_TAGS = new Set([
  'English', 'Spanish', 'Asian', 'African', 'Arabic', 'Middle Eastern', 'French', 'Portuguese', 'Hindi',
  'Urdu', 'Korean', 'Japanese', 'Chinese', 'Tagalog', 'Vietnamese', 'Russian',
]);

// Top-level genre tag → normalized grouping label.
const CATEGORY_MAP: Record<string, string> = {
  News: 'News',
  Sports: 'Sports',
  Music: 'Music',
  Lifestyle: 'Lifestyle',
  Documentary: 'Documentary',
  Education: 'Science',
  Travel: 'Travel',
  Finance: 'Business',
  Business: 'Business',
  'Fun & Games': 'Gaming',
};

// When the top-level tag is "Entertainment", the SECOND tag refines the grouping label.
const ENTERTAINMENT_MAP: Record<string, string> = {
  Movies: 'Movies',
  'Classic Movies': 'Movies',
  Drama: 'Drama',
  Comedy: 'Comedy',
  Horror: 'Horror',
  Thriller: 'Horror',
  'Action/Adventure': 'Action',
  'Animation & Anime': 'Anime',
  'True Crime': 'True Crime',
  Western: 'Westerns',
  'Reality TV': 'Reality TV',
  'Talk Show': 'Reality TV',
  Bollywood: 'Bollywood',
  'Hindi GEC': 'Drama',
  Circus: 'Entertainment',
  'Pop Culture': 'Entertainment',
  Infotainment: 'Entertainment',
  Food: 'Food',
  Fashion: 'Lifestyle',
  'Family/Children': 'Kids',
};

/**
 * Parse Distro's comma-joined `genre` string into a single normalized grouping category (language tags split
 * off + dropped — masqueradarr's channel schema has no language slot). Returns the channel's grouping label, or
 * null when only language tags are present. Mirrors FastChannels distro.py _parse_distro_tags (minus the lang
 * return).
 */
export function parseCategory(raw: string | null): string | null {
  if (!raw) return null;
  const genreTags = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t && !LANG_TAGS.has(t));
  if (!genreTags.length) return null;
  const primary = genreTags[0];
  const secondary = genreTags[1];
  if (primary === 'Entertainment' && secondary) return ENTERTAINMENT_MAP[secondary] || 'Entertainment';
  return CATEGORY_MAP[primary] || primary;
}

// ── HTML-entity decode (Distro titles/descriptions carry &amp; &#39; etc., sometimes multiply-encoded) ─────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
};

/** Decode the common named + numeric HTML entities, LOOPING until stable (handles multiply-encoded upstream
 * data — the FastChannels distro.py _unescape posture). */
export function decodeEntities(text: string): string {
  let prev = '';
  let out = text;
  while (prev !== out) {
    prev = out;
    out = out.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
      if (body[0] === '#') {
        const code =
          body[1] === 'x' || body[1] === 'X'
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named !== undefined ? named : m;
    });
  }
  return out;
}

// ── title parsing (S##E## / "Episode N" → series/season/episode/episodeTitle) ───

const SXE_DASH_RE = /^(?<series>.+?)\s+S(?<season>\d+)\s*E(?<episode>\d+)\s*[-–]\s*(?<episodeTitle>.+?)\s*$/i;
const EPISODE_WITH_SUBTITLE_RE = /^(?<series>.+?)(?::\s*|,\s*)Episode\s+(?<episode>\d+)\s*[-:]\s*(?<episodeTitle>.+?)\s*$/i;
const EPISODE_ONLY_RE = /^(?<series>.+?)(?::\s*|,\s*)Episode\s+(?<episode>\d+)\s*$/i;

export interface ParsedTitle {
  title: string;
  season: string | null;
  episode: string | null;
  episodeTitle: string | null;
}

/**
 * Parse a Distro program title into series + (season/episode/episodeTitle) where the title encodes them
 * ("Show S01E02 - Subtitle", "Show: Episode 5", "Show, Episode 5 - Subtitle"); else the title is returned
 * verbatim with null parts. HTML-entities are decoded first. Mirrors FastChannels distro.py _parse_distro_title.
 */
export function parseTitle(raw: string | null): ParsedTitle {
  const none: ParsedTitle = { title: raw || 'Unknown', season: null, episode: null, episodeTitle: null };
  if (!raw) return none;
  const title = decodeEntities(raw.trim()) || raw;

  let m = SXE_DASH_RE.exec(title);
  if (m?.groups) {
    return {
      title: m.groups.series.trim(),
      season: m.groups.season,
      episode: m.groups.episode,
      episodeTitle: m.groups.episodeTitle.trim() || null,
    };
  }
  m = EPISODE_WITH_SUBTITLE_RE.exec(title);
  if (m?.groups) {
    return {
      title: m.groups.series.trim(),
      season: null,
      episode: m.groups.episode,
      episodeTitle: m.groups.episodeTitle.trim() || null,
    };
  }
  m = EPISODE_ONLY_RE.exec(title);
  if (m?.groups) {
    return {
      title: m.groups.series.trim(),
      season: null,
      episode: m.groups.episode,
      episodeTitle: `Episode ${m.groups.episode}`,
    };
  }
  return { title, season: null, episode: null, episodeTitle: null };
}

// ── row shape ────────────────────────────────────────────────────────────────

// One catalog row, trimmed to exactly the fields normalize() + the EPG builder need (drops the many unused show
// fields so the committed snapshot stays lean). `channelId` is GEO-QUALIFIED ('<GEO>:<tvg_id>'); `tvgId` is the
// BARE upstream id (the epg/query.php key — carried so the EPG builder needn't re-split). `streamUrl` is the RAW
// (macro-laden) master — resolveStream fills the macros per play — so the snapshot round-trips upstream-faithfully
// via rebuild-source-seed.ts. Distro shows carry no channel NUMBER, so number is absent (channelNo is null
// downstream). Programs are NOT inline (a separate query.php fetch), so this row carries no programs[].
export interface DistroRow {
  channelId: string; // '<GEO>:<tvg_id>'
  tvgId: string; // bare upstream id (epg/query.php key)
  name: string;
  streamUrl: string; // raw HLS master (macro-laden) — resolveStream fills macros per play
  logo: string | null; // img_logo
  category: string | null; // parsed grouping category (channel group + program category fallback)
}

function str(v: unknown): string | null {
  const s = (v == null ? '' : String(v)).trim();
  return s || null;
}

/** Yield the live `show` dicts from a getfeed payload, tolerating the dict/list `shows` variants jsrdn uses. */
function* iterShows(feed: any): Generator<any> {
  const shows = feed?.shows;
  if (shows && typeof shows === 'object' && !Array.isArray(shows)) {
    for (const s of Object.values(shows)) if (s && typeof s === 'object') yield s;
    return;
  }
  if (Array.isArray(shows)) {
    for (const s of shows) if (s && typeof s === 'object') yield s;
    return;
  }
  if (Array.isArray(feed)) {
    for (const s of feed) if (s && typeof s === 'object') yield s;
  }
}

/** Trim one upstream live `show` (within a geo) to a lean DistroRow, or null when it has no usable stream. */
function trimShow(show: any, geo: string): DistroRow | null {
  if (show?.type !== 'live') return null;
  const name = str(show?.title);
  const ep = show?.seasons?.[0]?.episodes?.[0];
  const tvgId = str(ep?.id);
  const streamUrl = str(ep?.content?.url);
  if (!name || !tvgId || !streamUrl) return null;
  return {
    channelId: qualifiedChannelId(geo, tvgId),
    tvgId,
    name,
    streamUrl,
    logo: str(show?.img_logo),
    category: parseCategory(str(show?.genre)),
  };
}

// ── live fetch ─────────────────────────────────────────────────────────────────

/**
 * LIVE catalog fetch → trimmed DistroRow[] across every requested geo. A per-geo failure is caught + skipped so
 * one geo being down/region-gated doesn't lose the others — but ALL geos failing (zero rows) throws so the
 * adapter's listChannels falls back to the snapshot and the standalone EPG sync fails loudly (the established
 * live-only posture). Dedupes ids across geos (first geo wins). No snapshot fallback here (that's the adapter's
 * listChannels wrapper).
 */
export async function fetchDistroRows(): Promise<DistroRow[]> {
  const geos = distroGeos();
  const rows: DistroRow[] = [];
  const seen = new Set<string>();
  let lastErr: unknown = null;
  for (const geo of geos) {
    try {
      const res = await fetch(feedUrl(geo), { headers: DISTRO_CATALOG_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status} (feed geo=${geo})`);
      const feed = await res.json();
      for (const show of iterShows(feed)) {
        const row = trimShow(show, geo);
        if (!row || seen.has(row.channelId)) continue;
        seen.add(row.channelId);
        rows.push(row);
      }
    } catch (err) {
      lastErr = err; // skip this geo; surface only if EVERY geo fails (rows stays empty)
    }
  }
  if (!rows.length) throw new Error(`feed had no channels${lastErr ? `: ${(lastErr as Error).message}` : ''}`);
  return rows;
}
