// FreeLiveSports — shared leaf constants + the live catalog fetch, imported by BOTH the adapter
// (sources/adapters/freelivesports.ts) and the EPG module (epg/freelivesports.ts), so neither imports the other
// (an acyclic leaf, mirroring adapters/lg/config.ts + adapters/whale/config.ts). FreeLiveSports is the SEVENTH
// FastChannels FAST source ported and the first TIER-B (macro-expansion) port: a public, keyless, sports-only
// FAST channel pack run on the Unreel/PowR platform. Like LG it is direct-HLS + PER-PLAY macro expansion — the
// catalog's `url` IS the real HLS master (pathname ends .m3u8) but carries Unreel VAST ad macros
// ([DEVICE_ID]/[CB]/[REF]/[UA]/[GDPR]/…) that must be FRESH per play, so resolveStream fills them at play time
// (the FastChannels freelivesports.py `resolve()` posture) rather than baking a subset in at normalize. The
// catalog AND the guide arrive in ONE fetch (each channel's epg.entries inline, the LG/Tubi shape), so afterSync
// builds the self-EPG from the SAME rows — no second fetch. No auth, no resolve hop.

import { randomUUID } from 'node:crypto';

// Public, keyless catalog+guide endpoint (the Unreel EPG service). The top-level response is a JSON ARRAY of
// channels, each with its stream `url` (macro-laden) + inline `epg.entries` (the LG/Tubi shape — catalog + guide
// in one shot). Ported verbatim from FastChannels freelivesports.py EPG_URL.
export const CATALOG_URL =
  'https://epg.unreel.me/v2/sites/freelivesports/live-channels/public/' +
  '081f73704b56aaceb6b459804761ec54?__site=freelivesports&__source=web';

// FreeLiveSports is a single-genre (sports) source; the upstream `categories` are opaque ids with NO label map,
// so — like FastChannels freelivesports.py (which hardcodes category="Sports") — every channel groups under one
// "Sports" bucket. Also the program category fallback in the EPG builder.
export const FLS_GROUP = 'Sports';

// www.freelivesports.tv is a browser web client (Origin/Referer gated); send a desktop browser UA + the web
// app's Origin/Referer. The same UA + Referer also feed the `[UA]`/`[REF]` stream macros at resolve time. Ported
// from FastChannels freelivesports.py _HEADERS / MACRO_REPLACEMENTS.
const REFERER = 'https://www.freelivesports.tv/';
export const UA =
  process.env.FREELIVESPORTS_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export const FLS_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://www.freelivesports.tv',
  Referer: REFERER,
};

// SSRF allowlist seed for the stream proxy — the registrable CDN families FreeLiveSports' masters live on (from
// the live catalog: Amagi ~49%, AWS MediaTailor ~18%, Ottera ~9%, Wurl ~8%, CloudFront/Frequency/BunnyCDN, plus
// a long tail). The adapter's dynamic allow-set pre-allows each macro-filled master host at play time
// (resolveStream) and learns child variant/segment hosts during playlist rewrite (onPlaylistChildHost), so a new
// CDN that appears in the catalog is covered without a code change — private IPs are always blocked.
export const FLS_SUFFIXES = [
  'amagi.tv',
  'amazonaws.com',
  'ottera.tv',
  'otteravision.com',
  'wurl.com',
  'cloudfront.net',
  'frequency.stream',
  'b-cdn.net',
  'sofast.tv',
  'daiconnect.com',
  'akamaized.net',
  'fastly.net',
];

// ── per-play stream-macro expansion ───────────────────────────────────────────

// Stable per-process device id for the ad-targeting `[DEVICE_ID]` param (mirrors FastChannels' module-level
// DEVICE_ID — fresh once per process, NOT per play). Matches any remaining [PLACEHOLDER] ad macro left after the
// fixed fill — stripped to empty (the CDN serves the master without them). Mirrors freelivesports.py MACRO_RE.
const DEVICE_ID = randomUUID();
const MACRO_RE = /\[[A-Z_]+\]/g;

/**
 * Fill the per-play VAST ad macros baked into a FreeLiveSports master, FRESH per call ([CB] = current unix
 * seconds, the cache-buster that must be current). A pure string replace on the RAW url (NOT a re-serialized
 * URL.href) so the literal `[KEY]` tokens — which survive the proxy's encodeURIComponent/decodeURIComponent
 * round-trip — still match (the same reason lg/whale use a string replace). Any unmapped macro is then stripped
 * to empty. Mirrors FastChannels freelivesports.py `resolve()` + `_replace_macros()`.
 */
export function fillStreamMacros(url: string): string {
  if (!url) return url;
  const reps: Record<string, string> = {
    '[DEVICE_ID]': DEVICE_ID,
    '[DEVICE_MODEL]': 'web',
    '[REF]': REFERER,
    '[UA]': UA,
    '[CB]': String(Math.floor(Date.now() / 1000)),
    '[LAT]': '0',
    '[GDPR]': '0',
    '[CONSENT_STRING]': '',
    '[US_PRIVACY]': '',
    '[IP]': '0.0.0.0',
  };
  let out = url;
  for (const [key, value] of Object.entries(reps)) out = out.split(key).join(value);
  return out.replace(MACRO_RE, '');
}

// ── row shape ──────────────────────────────────────────────────────────────────

// One inline EPG entry, trimmed to exactly the fields epg/freelivesports.ts maps into a ProgramDoc. The
// contentType/videoUids fields are DROPPED (no clean series/episode ids; the entries carry no artwork either —
// the Program model has no artwork slot), keeping the committed snapshot lean (the lg/tubi posture). `start`/`end`
// stay ISO strings (upstream-faithful in the snapshot); the EPG builder parses them to epoch ms.
export interface FlsProgram {
  title: string;
  start: string | null; // ISO 8601 (the entry's `start`, e.g. "2026-06-27T02:20:00.000Z")
  end: string | null; // ISO 8601 (the entry's `stop`)
  desc: string | null;
}

// One catalog row, trimmed to the fields normalize() + the EPG builder need (drops ~16 unused catalog fields so
// the snapshot stays lean). `streamUrl` is the RAW (unexpanded) master — resolveStream fills the macros per play
// — so the snapshot round-trips upstream-faithfully via rebuild-source-seed.ts. `programs[]` rides along
// (FreeLiveSports bundles them inline, the LG/Tubi shape) so afterSync builds the guide from the same rows the
// sync consumed.
export interface FlsRow {
  channelId: string; // _id
  name: string;
  streamUrl: string; // url (raw, macro-laden) — resolveStream fills macros per play
  logo: string | null; // thumbnail
  number: number | null; // channelNumber
  programs: FlsProgram[];
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

/** Trim one upstream EPG entry to a lean FlsProgram. */
function trimProgram(e: any): FlsProgram {
  return {
    title: str(e?.title) || '',
    start: str(e?.start),
    end: str(e?.stop),
    desc: str(e?.description),
  };
}

/**
 * Flatten the catalog payload into trimmed FlsRow[]: the top-level is a JSON ARRAY (a legacy `{channels:[]}`
 * shape is also tolerated), sorted by channelNumber (the FastChannels ordering), deduped by _id, dropping rows
 * missing an id / name / stream. Each row's inline epg.entries ride along as trimmed programs[]. Only ever called
 * on the LIVE upstream payload — the offline path reads back already-trimmed FlsRow[] from the snapshot verbatim.
 */
export function flattenFlsRows(payload: any): FlsRow[] {
  const list: any[] = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.channels)
      ? payload.channels
      : [];
  const sorted = [...list].sort(
    (a, b) => (parseInt10(a?.channelNumber) ?? 9999) - (parseInt10(b?.channelNumber) ?? 9999),
  );
  const rows: FlsRow[] = [];
  const seen = new Set<string>();
  for (const ch of sorted) {
    const channelId = str(ch?._id);
    const name = str(ch?.name);
    const streamUrl = str(ch?.url);
    if (!channelId || !name || !streamUrl) continue;
    if (seen.has(channelId)) continue;
    seen.add(channelId);

    const entries = Array.isArray(ch?.epg?.entries) ? ch.epg.entries : [];
    rows.push({
      channelId,
      name,
      streamUrl,
      logo: str(ch?.thumbnail),
      number: parseInt10(ch?.channelNumber),
      programs: entries.map(trimProgram),
    });
  }
  return rows;
}

/**
 * LIVE catalog+guide fetch → trimmed FlsRow[]. No snapshot fallback here (that's the adapter's listChannels
 * wrapper): the standalone EPG sync (epg/freelivesports.ts) needs a live-only fetch that throws on failure so a
 * transient outage fails loudly and preserves the existing guide. Throws on HTTP error or an empty catalog.
 */
export async function fetchFlsRows(): Promise<FlsRow[]> {
  const res = await fetch(CATALOG_URL, { headers: FLS_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  const rows = flattenFlsRows(payload);
  if (!rows.length) throw new Error('catalog had no channels');
  return rows;
}
