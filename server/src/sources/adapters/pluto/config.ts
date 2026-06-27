// Pluto TV — shared leaf constants + the per-region boot/session bootstrap, the live catalog fetch, the
// sentinel/resolve helpers, and the EPG-timeline fetch primitives, imported by BOTH the adapter
// (sources/adapters/pluto.ts) and the EPG module (epg/pluto.ts), so neither imports the other (an acyclic leaf,
// mirroring adapters/tcl/config.ts + adapters/xumo/config.ts). Pluto TV is the TWELFTH FastChannels FAST source
// ported (Paramount's free FAST service, the pluto.tv web client) and — like xumo/stirr/tcl — a SENTINEL +
// RESOLVE source, NOT direct-HLS: the `/v2/guide/channels` catalog yields only channel ids, and the playable
// master is minted on demand by the stitcher CDN, which signs a per-play JWT-stitched HLS master.
//
// The ONE twist vs the rest of the resolve family: a per-region BOOT/SESSION. `boot.pluto.tv/v4/start` mints a
// short-lived `sessionToken` + `stitcherParams` (cached per region, 4h TTL — NOT a per-user surface, like whale's
// keyless token), gated by an `X-Forwarded-For` geo header so each Pluto region returns its own lineup. The token
// gates BOTH the catalog/EPG fetches (Bearer) AND the resolve (the master's `?…&jwt=<token>`). So normalize()
// stores a `pluto://<region>/<id>` ENTRY sentinel (the dulo/local custom-scheme posture — the region rides along
// because resolveStream must boot the SAME region's token) and resolveStream() boots the region (cached) and
// constructs the stitcher master PER PLAY:
//   GET boot.pluto.tv/v4/start (cached) → sessionToken + stitcherParams
//   → STITCHER/v2/stitch/hls/channel/<id>/master.m3u8?<stitcherParams>&jwt=<token>&masterJWTPassthrough=true
// The guide is a SEPARATE per-region `/v2/guide/timelines` fetch (epg/pluto.ts), batched 100 ids over 3 windows.
// No USER auth, no per-user surface. Ported from FastChannels pluto.py (575 LOC).

import { randomUUID } from 'node:crypto';

// ── endpoints ────────────────────────────────────────────────────────────────────────

/** Boot endpoint — mints the per-region sessionToken + stitcherParams (geo-gated via X-Forwarded-For). */
export const BOOT_URL = 'https://boot.pluto.tv/v4/start';
/** Channel/category catalog backend (Bearer sessionToken). */
const CHANNELS_URL = 'https://service-channels.clusters.pluto.tv/v2/guide/channels';
const CATEGORIES_URL = 'https://service-channels.clusters.pluto.tv/v2/guide/categories';
/** Schedule timelines backend (Bearer sessionToken) — the SEPARATE guide fetch (epg/pluto.ts). */
export const TIMELINES_URL = 'https://service-channels.clusters.pluto.tv/v2/guide/timelines';
/** The channel stitcher CDN that signs the per-play JWT-stitched HLS master. */
export const STITCHER = 'https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv';

// pluto.tv is a desktop web client (Origin/Referer gated on its backend hops); match its UA. The CDN stream hops
// (the resolved master/variant/segment) need only the UA (the proxy's upstreamHeaders), so Origin/Referer ride
// ONLY on the boot + catalog + EPG API hops. Ported from FastChannels pluto.py BOOT_HEADERS.
export const UA =
  process.env.PLUTO_UA ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** Base headers for every Pluto backend JSON hop (boot / catalog / EPG) — Origin/Referer gated. */
const PLUTO_API_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://pluto.tv',
  Referer: 'https://pluto.tv/',
  'User-Agent': UA,
};

/** Headers for the CDN stream hops (master/variant/segment) — UA only (the stitcher CDN ignores the Origin). */
export const PLUTO_STREAM_HEADERS: Record<string, string> = { 'User-Agent': UA };

// SSRF allowlist seed for the stream proxy — the registrable families Pluto's stitched masters live on. The
// stitcher mints the master on a `*.prd.pluto.tv` host and the ad-stitched variant/segment hops land on a long
// tail of Pluto CDN + JW Player + Akamai/CloudFront hosts a static suffix list can't fully enumerate. The
// adapter's dynamic allow-set pre-allows the resolved master host at play time (resolveStream) + learns child
// variant/segment hosts during playlist rewrite (onPlaylistChildHost), so a stitcher host that appears mid-stream
// is covered without a code change — private IPs are always blocked.
export const PLUTO_SUFFIXES = [
  'pluto.tv',
  'cloudfront.net',
  'akamaized.net',
  'amazonaws.com',
  'fastly.net',
  'jwpsrv.com',
  'jwpcdn.com',
  'jwplayer.com',
];

// ── region selection (env-configured, like vidaa/distro/tcl — NOT a required playlist config) ──
// Pluto serves a distinct lineup per region, selected by the boot's X-Forwarded-For geo header. The same channel
// id recurs across regions; it is deduped (first region wins — the FastChannels posture), and the WINNING region
// rides in the channel's `pluto://<region>/<id>` sentinel so resolveStream + the guide boot the matching token.

// Geo IP per region (the boot's X-Forwarded-For — Pluto reads it to pick the lineup). 'local' sends none (the
// server's own egress IP — useful for local-affiliate channels). Ported from FastChannels pluto.py X_FORWARD.
const REGION_XFF: Record<string, string> = {
  local: '',
  us_east: '108.82.206.181',
  us_west: '76.81.9.69',
  ca: '192.206.151.131',
  uk: '178.238.11.6',
  fr: '193.169.64.141',
  de: '81.173.176.155',
};
const VALID_REGIONS = new Set(Object.keys(REGION_XFF));
const REGION_ALIASES: Record<string, string> = { gb: 'uk' };

/** Configured regions (env `PLUTO_GEO`, default `us_east`; e.g. `us_east,us_west,ca`). Invalid/dupe dropped. */
export function regions(): string[] {
  const raw = process.env.PLUTO_GEO || 'us_east';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,|\s]+/)) {
    const c = REGION_ALIASES[part.trim().toLowerCase()] ?? part.trim().toLowerCase();
    if (VALID_REGIONS.has(c) && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out.length ? out : ['us_east'];
}

// ── per-region boot/session (cached per process, 4h TTL) ───────────────────────────────
// One stable clientID per process keeps the boot/catalog/stream requests coherent with the web client (the
// FastChannels posture). The boot response (sessionToken + stitcherParams) is cached per region and shared across
// the catalog, EPG, and resolve hops — refreshed only when stale (4h) or forced after an auth failure.

const CLIENT_ID = randomUUID();
const BOOT_TTL_MS = 4 * 3600_000;

// The fixed device/app envelope every boot carries (the web client's params). Ported from FastChannels pluto.py
// BOOT_PARAMS_BASE — anonymous (no username/password; the optional credential path is intentionally not ported,
// the FastChannels "anonymous works fine" note).
const BOOT_PARAMS_BASE: Record<string, string> = {
  appName: 'web',
  appVersion: '8.0.0-111b2b9dc00bd0bea9030b30662159ed9e7c8bc6',
  deviceVersion: '122.0.0',
  deviceModel: 'web',
  deviceMake: 'chrome',
  deviceType: 'web',
  clientModelNumber: '1.0.0',
  serverSideAds: 'false',
  drmCapabilities: '',
  blockingMode: '',
  notificationVersion: '1',
  appLaunchCount: '',
  lastAppLaunchDate: '',
};

export interface BootSession {
  sessionToken: string;
  stitcherParams: string;
}

const bootCache = new Map<string, { resp: BootSession; at: number }>();

/** The X-Forwarded-For geo header for a region (omitted for 'local'). */
function xForward(region: string): Record<string, string> {
  const ip = REGION_XFF[region];
  return ip ? { 'X-Forwarded-For': ip } : {};
}

/**
 * Boot (and cache for the process, 4h) a region's session — the keyless sessionToken + stitcherParams Pluto mints
 * from the boot envelope + the region's X-Forwarded-For. Shared across the catalog, EPG, and resolve hops. Throws
 * on HTTP error or a missing sessionToken so the caller falls back to the snapshot / fails the EPG sync loudly.
 * `force` bypasses the cache (used after an auth failure, mirroring FastChannels' refresh-on-failure).
 */
export async function bootRegion(region: string, force = false): Promise<BootSession> {
  const cached = bootCache.get(region);
  if (!force && cached && Date.now() - cached.at < BOOT_TTL_MS) return cached.resp;

  const qs = new URLSearchParams({ ...BOOT_PARAMS_BASE, clientID: CLIENT_ID });
  const res = await fetch(`${BOOT_URL}?${qs}`, { headers: { ...PLUTO_API_HEADERS, ...xForward(region) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} (boot ${region})`);
  const payload = (await res.json()) as { sessionToken?: string; stitcherParams?: string };
  const sessionToken = (payload?.sessionToken || '').trim();
  if (!sessionToken) throw new Error(`pluto boot returned no sessionToken (${region})`);
  const resp: BootSession = { sessionToken, stitcherParams: (payload?.stitcherParams || '').trim() };
  bootCache.set(region, { resp, at: Date.now() });
  return resp;
}

/** The Bearer + geo headers for a region's catalog/EPG backend hops. */
export function regionHeaders(region: string, sessionToken: string): Record<string, string> {
  return { ...PLUTO_API_HEADERS, Authorization: `Bearer ${sessionToken}`, ...xForward(region) };
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

/** Reject Pluto's generic fallback placeholder images (its `assets/images/default…` art). */
function plutoImg(url: string | null): string | null {
  return url && !url.includes('assets/images/default') ? url : null;
}

// ── row shape ────────────────────────────────────────────────────────────────────────

// One catalog row, trimmed to exactly what normalize() + the EPG channel records need (drops the many unused
// catalog fields so the committed snapshot stays lean). `region` is the WINNING region (the boot token that
// resolves + guides this channel) — it rides in the `pluto://<region>/<id>` sentinel. `category` is the guide
// category the channel maps to (source-local, the xumo/tcl precedent — masqueradarr groups by the source's own
// category rather than porting FastChannels' cross-source name-inference table).
export interface PlutoRow {
  region: string; // winning region code (boot token selector)
  channelId: string; // pluto channel id (dedup key)
  name: string;
  logo: string | null;
  category: string; // category name (fallback 'Live TV')
  number: number | null; // channel number (EPG channelNo)
}

/** Trim one upstream channel object → a lean PlutoRow, or null when it lacks an id / name. */
function trimChannel(elem: any, region: string, catMap: Map<string, string>): PlutoRow | null {
  const channelId = str(elem?.id);
  const name = str(elem?.name) || str(elem?.call_sign);
  if (!channelId || !name) return null;

  const images: any[] = Array.isArray(elem?.images) ? elem.images : [];
  const colorLogo = images.find((img) => img?.type === 'colorLogoPNG');
  const logo = plutoImg(str(colorLogo?.url));

  return {
    region,
    channelId,
    name,
    logo,
    category: catMap.get(channelId) || 'Live TV',
    number: parseInt10(elem?.number),
  };
}

// ── catalog → trimmed rows ───────────────────────────────────────────────────────────

/** Fetch ONE region's channels + category map → trimmed PlutoRow[] (boots the region's token first). */
async function fetchRegionRows(region: string): Promise<PlutoRow[]> {
  const { sessionToken } = await bootRegion(region);
  const headers = regionHeaders(region, sessionToken);

  const chRes = await fetch(`${CHANNELS_URL}?channelIds=&offset=0&limit=1000&sort=number:asc`, { headers });
  if (!chRes.ok) throw new Error(`HTTP ${chRes.status} (channels ${region})`);
  const channelList: any[] = (await chRes.json())?.data ?? [];

  // Category map (best-effort: a channel without a mapped category buckets under 'Live TV').
  const catMap = new Map<string, string>();
  try {
    const catRes = await fetch(`${CATEGORIES_URL}?offset=0&limit=1000`, { headers });
    if (catRes.ok) {
      for (const cat of (await catRes.json())?.data ?? []) {
        const name = str(cat?.name);
        if (!name) continue;
        for (const cid of cat?.channelIDs ?? []) {
          const id = str(cid);
          if (id && !catMap.has(id)) catMap.set(id, name);
        }
      }
    }
  } catch {
    /* category fetch is best-effort — the catalog still buckets under 'Live TV' */
  }

  const rows: PlutoRow[] = [];
  for (const elem of channelList) {
    const row = trimChannel(elem, region, catMap);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * LIVE catalog fetch → trimmed PlutoRow[]. Walks every configured region, deduping by channel id across regions
 * (the first region claims the row — the FastChannels posture; the winning region rides in the sentinel). A
 * region whose boot/fetch fails is skipped (the rest still sync). No snapshot fallback here (that's the adapter's
 * listChannels wrapper): the standalone EPG sync needs a live-only fetch that throws on total failure so a
 * transient outage preserves the existing guide. Throws on an empty catalog.
 */
export async function fetchPlutoRows(): Promise<PlutoRow[]> {
  const deduped = new Map<string, PlutoRow>();
  for (const region of regions()) {
    let rows: PlutoRow[];
    try {
      rows = await fetchRegionRows(region);
    } catch {
      continue; // a flaky region must not abort the whole sync
    }
    for (const row of rows) if (!deduped.has(row.channelId)) deduped.set(row.channelId, row);
  }
  const out = [...deduped.values()];
  if (!out.length) throw new Error('catalog payload had no channels');
  return out;
}

// ── sentinel entry url (custom scheme, carries the resolve inputs: region + channel id) ──
// normalize() stores `pluto://<region>/<id>` as the channel ENTRY (the dulo/local custom-scheme posture — a
// sentinel, NOT a fetchable URL, since the playable master needs a freshly-minted JWT). Unlike xumo/stirr/tcl
// (whose http sentinel points at a real resolve endpoint), Pluto has no static per-channel URL — the region is
// the resolve input that must ride along (resolveStream boots THAT region's token). isPlutoEntry gates on the
// scheme; parsePlutoEntry reads the two inputs back out.

const ENTRY_SCHEME = 'pluto://';

export function channelEntryUrl(region: string, channelId: string): string {
  return `${ENTRY_SCHEME}${region}/${channelId}`;
}

export function isPlutoEntry(url: string): boolean {
  return typeof url === 'string' && url.startsWith(ENTRY_SCHEME);
}

export function parsePlutoEntry(url: string): { region: string; channelId: string } | null {
  if (!isPlutoEntry(url)) return null;
  const rest = url.slice(ENTRY_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const region = rest.slice(0, slash);
  const channelId = rest.slice(slash + 1);
  if (!region || !channelId) return null;
  return { region, channelId };
}

// ── stream resolve (boot + construct, per play) ────────────────────────────────────────

/**
 * Resolve a channel → a fresh, signed HLS master url via the region's boot session (the per-play stitcher JWT).
 * Boots the region (cached) and assembles the stitcher master with its stitcherParams + the session JWT. Throws
 * an actionable error when the region can't boot (the proxy maps it to a 502 + the B-Roll "failed" slate). The
 * caller (the adapter's resolveStream) pre-allows the resolved host so the proxy's SSRF gate passes the master's
 * same-host child hops. Mirrors FastChannels pluto.py `resolve`.
 */
export async function resolvePlutoMaster(region: string, channelId: string): Promise<string> {
  const { sessionToken, stitcherParams } = await bootRegion(region);
  const prefix = stitcherParams ? `${stitcherParams}&` : '';
  return (
    `${STITCHER}/v2/stitch/hls/channel/${encodeURIComponent(channelId)}/master.m3u8` +
    `?${prefix}jwt=${encodeURIComponent(sessionToken)}&masterJWTPassthrough=true&includeExtendedEvents=true`
  );
}

// ── EPG-timeline fetch (shared with epg/pluto.ts) ──────────────────────────────────────

/** Build a `/v2/guide/timelines` URL for a comma-joined batch of channel ids from `start` over `durationMin`. */
export function timelinesUrl(channelIds: string[], start: string, durationMin: number): string {
  const qs = new URLSearchParams({
    start,
    channelIds: channelIds.join(','),
    duration: String(durationMin),
  });
  return `${TIMELINES_URL}?${qs}`;
}
