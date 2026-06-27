// LG Channels — shared leaf constants + the live catalog fetch, imported by BOTH the adapter
// (sources/adapters/lg.ts) and the EPG module (epg/lg.ts), so neither imports the other (an acyclic leaf,
// mirroring adapters/vizio/config.ts + adapters/samsung/config.ts). LG is a DIRECT-HLS FAST source served from
// ONE public endpoint: api.lgchannels.com/schedulelist returns the channel catalog AND each channel's inline
// programs[] in a single payload (the Tubi shape — catalog + guide in one shot — not Vizio's separate /api/airings
// nor Samsung's separate XMLTV). Each channel's `mediaStaticUrl` is the real HLS master, but carries LG-style
// VAST ad macros ([DEVICE_ID]/[UA]/[NONCE]/…) in its query string that need PER-PLAY freshness — so unlike
// Vizio's privacy-neutral {KEY} macros (baked in at normalize), these are expanded in the adapter's resolveStream
// (the FastChannels lg_channels.py `resolve()` posture). The generic 0.2 macros helper stays DEFERRED — LG keeps
// its macro vocabulary source-local, the same precedent Vizio set with its own expandMacros.

import { randomUUID } from 'node:crypto';

export const API_BASE = 'https://api.lgchannels.com/api/v1.0';
/** Public anonymous catalog+guide: { timestamp, categories:[ { categoryName, channels:[ { …, programs:[] } ] } ] }. */
export const SCHEDULELIST_URL = `${API_BASE}/schedulelist`;

// LG's web client identifiers (ported from FastChannels lg_channels.py): a US/en WEB device. The `[COUNTRY]`,
// `[APP_NAME]`, `[DEVICE_TYPE]` stream macros below resolve to these.
export const LG_COUNTRY = 'US';
export const LG_LANGUAGE = 'en';
const APP_NAME = 'lgchannels_web';
const PLAY_DEVICE_TYPE = 'Personal Computer';

// lgchannels.com is a browser web client (Origin/Referer gated); send a desktop browser UA. The same UA is fed
// to the `[UA]` ad macro at resolve time (matching FastChannels' session-UA behavior).
export const UA =
  process.env.LG_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Request headers for the schedulelist fetch — the web-client device headers LG's API gates on. */
export const LG_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://lgchannels.com',
  Referer: 'https://lgchannels.com/',
  'x-device-country': LG_COUNTRY,
  'x-device-language': LG_LANGUAGE,
  'x-device-type': 'WEB',
};

// SSRF allowlist seed for the stream proxy — the registrable CDN families LG's masters live on (from the live
// catalog: Amagi ~44%, Transmit/Wurl ~36%, CloudFront ~10%, Frequency, Stingray, plus AWS/BunnyCDN headroom).
// The adapter's dynamic allow-set pre-allows each macro-expanded master host at play time (resolveStream) and
// learns child variant/segment hosts during playlist rewrite (onPlaylistChildHost), so a new CDN that appears in
// the catalog is covered without a code change — private IPs are always blocked.
export const LG_SUFFIXES = [
  'amagi.tv',
  'transmit.live',
  'cloudfront.net',
  'frequency.stream',
  'stingray.com',
  'wurl.com',
  'amazonaws.com',
  'b-cdn.net',
];

// LG-style VAST ad macros embedded in mediaStaticUrl query strings. PER-PLAY values ([DEVICE_ID] fresh uuid,
// [NONCE] fresh unix seconds) are why expansion happens in resolveStream, not normalize. Ported verbatim from
// FastChannels lg_channels.py `_expand_stream_macros`, plus the extra macros observed live ([CHANNEL_NAME],
// [COPPA], [PCS], [HOTEL_TYPE]) mapped to safe empties. Unmapped macros are harmless ad-targeting params; the CDN
// serves the master regardless (same posture as Vizio's literal leftovers).
function staticMacros(): Record<string, string> {
  return {
    '[IFA]': '',
    '[IFA_TYPE]': '',
    '[LMT]': '0',
    '[DNS]': '0',
    '[UA]': UA,
    '[IP]': '0.0.0.0',
    '[GDPR]': '',
    '[GDPR_CONSENT]': '',
    '[COUNTRY]': LG_COUNTRY,
    '[US_PRIVACY]': '',
    '[APP_STOREURL]': '',
    '[APP_BUNDLE]': '',
    '[APP_NAME]': APP_NAME,
    '[APP_VERSION]': '',
    '[DEVICE_TYPE]': PLAY_DEVICE_TYPE,
    '[DEVICE_MAKE]': '',
    '[DEVICE_MODEL]': '',
    '[TARGETAD_ALLOWED]': '',
    '[FCK]': '',
    '[VIEWSIZE]': '1920x1080',
    '[HOTELTYPE]': '',
    // extras observed in the live catalog beyond FastChannels' map:
    '[CHANNEL_NAME]': '',
    '[COPPA]': '0',
    '[PCS]': '',
    '[HOTEL_TYPE]': '',
  };
}

/**
 * Substitute LG's [KEY] ad-macro placeholders with concrete values, FRESH per call ([DEVICE_ID] = new uuid,
 * [NONCE] = current unix seconds). A pure string replace on the RAW url (NOT a re-serialized URL.href) so the
 * literal `[KEY]` tokens — which survive the proxy's encodeURIComponent/decodeURIComponent round-trip — still
 * match. Unmapped macros are left literal. Mirrors FastChannels lg_channels.py `_expand_stream_macros`.
 */
export function expandStreamMacros(url: string): string {
  if (!url) return url;
  const reps: Record<string, string> = {
    '[DEVICE_ID]': randomUUID(),
    '[NONCE]': String(Math.floor(Date.now() / 1000)),
    ...staticMacros(),
  };
  let out = url;
  for (const [key, value] of Object.entries(reps)) out = out.split(key).join(value);
  return out;
}

// One inline program, trimmed to exactly the fields epg/lg.ts maps into a ProgramDoc. The three artwork URLs
// (imageUrl/thumbnailUrl/previewImgUrl) + captionList/duration/genreIds are DROPPED — the Program model has no
// artwork slot, and dropping them keeps the committed snapshot lean (the same posture as tubi/samsung/vizio).
// `start`/`end` stay ISO strings (upstream-faithful in the snapshot); the EPG builder parses them to epoch ms.
export interface LgProgram {
  title: string;
  start: string | null; // ISO 8601 (startDateTime, e.g. "2026-06-27T02:00:00Z")
  end: string | null; // ISO 8601 (endDateTime)
  desc: string | null;
  genre: string | null; // engGenreName (primary)
  genre2: string | null; // engSecondGenreName (secondary; ';'-appended to the program category)
  rating: string | null; // ratingCode ('' → null)
  programId: string | null;
}

// One catalog row, trimmed to the fields normalize() + the EPG builder need (drops ~6 unused catalog fields so
// the snapshot stays lean). `streamUrl` is the RAW (unexpanded) master — resolveStream expands the macros per
// play — so the snapshot round-trips upstream-faithfully via rebuild-source-seed.ts. `programs[]` rides along
// (LG bundles them inline, the Tubi shape) so afterSync builds the guide from the same rows the sync consumed.
export interface LgRow {
  channelId: string;
  name: string;
  streamUrl: string;
  logo: string | null;
  category: string | null; // categoryName ?? channelGenreName ?? providerId
  number: number | null; // channelNumber
  genre: string | null; // channelGenreName (the per-program category fallback)
  programs: LgProgram[];
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

/** Trim one upstream program object to a lean LgProgram (artwork + caption fields dropped). */
function trimProgram(p: any): LgProgram {
  return {
    title: str(p?.programTitle) || '',
    start: str(p?.startDateTime),
    end: str(p?.endDateTime),
    desc: str(p?.description),
    genre: str(p?.engGenreName),
    genre2: str(p?.engSecondGenreName),
    rating: str(p?.ratingCode),
    programId: str(p?.programId),
  };
}

/**
 * Flatten the schedulelist payload into trimmed LgRow[]: walk categories → channels, dedupe by channelId (first
 * category wins, mirroring FastChannels' seen-set), and drop rows missing an id / name / stream. The channel's
 * category is `categoryName ?? channelGenreName ?? providerId` (the FastChannels precedence).
 */
export function flattenLgRows(payload: any): LgRow[] {
  const categories = Array.isArray(payload?.categories) ? payload.categories : [];
  const rows: LgRow[] = [];
  const seen = new Set<string>();
  for (const cat of categories) {
    const categoryName = str(cat?.categoryName);
    const channels = Array.isArray(cat?.channels) ? cat.channels : [];
    for (const ch of channels) {
      const channelId = str(ch?.channelId);
      const name = str(ch?.channelName);
      const streamUrl = str(ch?.mediaStaticUrl);
      if (!channelId || !name || !streamUrl) continue;
      if (seen.has(channelId)) continue;
      seen.add(channelId);

      const genre = str(ch?.channelGenreName);
      const programs = (Array.isArray(ch?.programs) ? ch.programs : []).map(trimProgram);
      rows.push({
        channelId,
        name,
        streamUrl,
        logo: str(ch?.channelLogoUrl),
        category: categoryName || genre || str(ch?.providerId),
        number: parseInt10(ch?.channelNumber),
        genre,
        programs,
      });
    }
  }
  return rows;
}

/**
 * LIVE catalog+guide fetch → trimmed LgRow[]. No snapshot fallback here (that's the adapter's listChannels
 * wrapper): the standalone EPG sync (epg/lg.ts) needs a live-only fetch that throws on failure so a transient
 * outage fails loudly and preserves the existing guide. Throws on HTTP error or an empty catalog.
 */
export async function fetchLgRows(): Promise<LgRow[]> {
  const res = await fetch(SCHEDULELIST_URL, { headers: LG_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  const rows = flattenLgRows(payload);
  if (!rows.length) throw new Error('schedulelist had no channels');
  return rows;
}
