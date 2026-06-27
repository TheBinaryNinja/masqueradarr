// Vizio WatchFree+ — shared leaf constants + the live catalog fetch, imported by BOTH the adapter
// (sources/adapters/vizio.ts) and the EPG module (epg/vizio.ts), so neither imports the other (an acyclic leaf,
// mirroring adapters/samsung/config.ts). Vizio is a DIRECT-HLS FAST source: the WatchFree+ guide host serves a
// public, anonymous catalog where each channel's `channelUrls[0]` is the real HLS master — there is NOTHING to
// resolve per play (unlike Samsung's jmp2.uk redirect). The one wrinkle is ad-DI MACRO placeholders ({ADID},
// {USPRIVACY}, …) embedded in the master query string (often percent-encoded as %7bADID%7d); we substitute the
// privacy-neutral subset here (matching the app's anonymous WatchFree DI) and leave the rest as literal — the
// CDN serves the master regardless. EPG is a SEPARATE /api/airings fetch (epg/vizio.ts), not inline.

export const API_BASE = 'https://watchfreeplus-epg-prod.smartcasttv.com';
/** Public anonymous catalog: { channels: [ { channelId, channelName, channelUrls[], airingsKey, … } ] }. */
export const CHANNELS_URL = `${API_BASE}/api/channels`;
/** Schedule grid: /api/airings/?start=<ISO>&end=<ISO>&startChannel=<channelId>&channelCount=<n> → { airings: [] }. */
export const AIRINGS_URL = `${API_BASE}/api/airings/`;

// The smartcasttv guide host serves a plain mobile-client UA fine; match FastChannels' okhttp client.
export const UA = process.env.VIZIO_UA || 'okhttp/4.12.0';

/** How far ahead to fetch the airings guide (FastChannels uses 24h). */
export const EPG_LOOKAHEAD_HOURS = 24;

// SSRF allowlist seed for the stream proxy — the registrable CDN families Vizio's masters live on (Amagi ~60%,
// then CloudFront/Wurl/AWS/Frequency/Transmit/Ottera, plus a few one-offs). The adapter's dynamic allow-set
// pre-allows each stored master host at play time (resolveStream) and learns child variant/segment hosts during
// playlist rewrite (onPlaylistChildHost), so this seed is a belt-and-suspenders safety net — private IPs always
// blocked. Derived from the live catalog's master hosts.
export const VIZIO_SUFFIXES = [
  'amagi.tv',
  'cloudfront.net',
  'wurl.com',
  'amazonaws.com',
  'frequency.stream',
  'transmit.live',
  'ottera.tv',
  'afrolandtv.com',
  'jltv.tv',
  'b-cdn.net',
];

// Privacy-neutral ad-macro defaults matching the app's anonymous WatchFree DI config (ported verbatim from
// FastChannels' vizio.py _DEFAULT_MACROS). Only this subset is substituted; the remaining ad-targeting macros
// ({GPP}, {VIZIO_NETWORK_NAME}, …) are left as literal query params — harmless for playback.
export const DEFAULT_MACROS: Record<string, string> = {
  ADID: '00000000-0000-0000-0000-000000000000',
  USPRIVACY: '1---',
  IFATYPE: 'aaid',
  LMT: '0',
  TARGETOPT: 'False',
  APP_NAME: 'VIZIO',
  APP_BUNDLE: 'com.vizio.vue.launcher',
  APP_STORE_URL: 'https://play.google.com/store/apps/details?id=com.vizio.vue.launcher',
  DOMAIN: 'https://www.vizio.com',
  DNT: '0',
  COPPA: '0',
  DEVICE_MAKE: 'Google',
  WIDTH: '1080',
  HEIGHT: '1920',
  DEVICE_MODEL: 'Pixel 7',
  APP_VERSION: '5.0.0',
  DEVICE_TYPE: 'mobile',
  SKIPPABLE: '1',
};

/**
 * Substitute {KEY} ad-macro placeholders with URL-encoded privacy-neutral values. Matches the app's
 * ChannelMapperUseCaseKt.mapChannelUrl(): DECODE the whole URL first (the catalog stores macros percent-encoded
 * as %7bADID%7d), then replace each placeholder with an individually re-encoded value. A malformed-percent URL
 * that decodeURIComponent can't parse falls back to a raw replace. Unmatched macros are left literal.
 */
export function expandMacros(url: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    decoded = url; // malformed %xx somewhere — replace against the raw form
  }
  for (const [key, value] of Object.entries(DEFAULT_MACROS)) {
    decoded = decoded.split(`{${key}}`).join(encodeURIComponent(value));
  }
  return decoded;
}

// One catalog row, trimmed to exactly the fields normalize() + the EPG builder need (drops the ~40 unused
// catalog fields so the committed snapshot stays lean). `streamUrl` is the RAW (unexpanded) master — normalize
// expands the macros — so the snapshot round-trips upstream-faithfully via rebuild-source-seed.ts.
export interface VizioRow {
  channelId: string;
  name: string;
  streamUrl: string | null;
  logo: string | null;
  category: string | null;
  number: number | null;
  airingsKey: string | null; // the EPG station key (airing.stationId joins to this, NOT channelId)
  tmsStationId: string | null; // Gracenote station id where present (future crosswalk); null when '-1'
  tokenUrl: string | null; // non-empty ⇒ token-gated (NFL) → dropped
  licenseUrl: string | null; // non-empty ⇒ DRM → dropped (HLS-only proxy)
  description: string | null;
}

function str(v: unknown): string | null {
  const s = (v == null ? '' : String(v)).trim();
  return s || null;
}

/**
 * The coarse "this row becomes a streamable channel" gate, shared by normalize() (the playlist channels) and the
 * EPG builder (the guide channels) so both surface the SAME set: a channel must have a stream URL and must NOT be
 * token-gated (NFL) or DRM (HLS-only proxy). normalize additionally drops a row whose macro-expanded URL isn't
 * http(s); that single edge case (a non-HTTP master) only ever yields a harmless orphan guide channel.
 */
export function isSurfacedRow(row: VizioRow): boolean {
  return !!row.streamUrl && !row.tokenUrl && !row.licenseUrl;
}

/** Trim one upstream catalog row to a VizioRow (only the fields normalize + EPG consume). */
function trimRow(ch: any): VizioRow {
  const urls = Array.isArray(ch?.channelUrls) ? ch.channelUrls : [];
  const streamUrl = (typeof urls[0] === 'string' && urls[0]) || str(ch?.channelUrl);
  const rawTms = ch?.tmsStationId;
  return {
    channelId: String(ch?.channelId ?? ''),
    name: str(ch?.channelName) || '',
    streamUrl,
    logo: str(ch?.channelIcon) || str(ch?.portraitIcon) || str(ch?.bwIcon),
    category: str(ch?.category),
    number: ch?.channelNumber != null && ch.channelNumber !== '' ? Number(ch.channelNumber) : null,
    airingsKey: str(ch?.airingsKey),
    tmsStationId: rawTms != null && String(rawTms) !== '-1' ? String(rawTms) : null,
    tokenUrl: str(ch?.tokenUrl),
    licenseUrl: str(ch?.licenseUrl),
    description: str(ch?.channelDescription),
  };
}

/**
 * LIVE catalog fetch → trimmed VizioRow[]. No snapshot fallback here (that's the adapter's listChannels wrapper):
 * the standalone EPG sync (epg/vizio.ts) needs a live-only fetch that throws on failure so a transient outage
 * fails loudly and preserves the existing guide. Throws on HTTP error or an empty catalog.
 */
export async function fetchVizioCatalog(): Promise<VizioRow[]> {
  const res = await fetch(CHANNELS_URL, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { channels?: any[] };
  const channels = Array.isArray(body?.channels) ? body.channels : [];
  const rows = channels.map(trimRow).filter((r) => r.channelId && r.name);
  if (!rows.length) throw new Error('catalog had no channels');
  return rows;
}
