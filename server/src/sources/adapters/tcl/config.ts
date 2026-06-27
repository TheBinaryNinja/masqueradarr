// TCL TV+ — shared leaf constants + the catalog walk, the sentinel/resolve helpers, and the program-schedule
// fetch primitives, imported by BOTH the adapter (sources/adapters/tcl.ts) and the EPG module (epg/tcl.ts), so
// neither imports the other (an acyclic leaf, mirroring adapters/xumo/config.ts + adapters/stirr/config.ts).
// TCL TV+ is the ELEVENTH FastChannels FAST source ported (TCL's free FAST service, the tcltv.plus web client,
// served from the ideonow.com gateway) and — like xumo/stirr — a SENTINEL + RESOLVE source, NOT direct-HLS:
// the `livetab` → `programlist/by/category` catalog yields a per-channel `media` url and a `source` tag, but the
// PLAYABLE master is minted on demand by the gateway's `format-stream-url` POST (a Roku-style per-play resolve).
// So normalize() stores a `…/format-stream-url?bundle_id=…&source=…&media=…` ENTRY url (the dlhd/xumo/stirr
// posture — a real-looking URL whose query is all that matters) and resolveStream() does ONE resolve hop PER PLAY:
//   POST /api/metadata/v1/epg→format-stream-url  → data.stream_url  (falling back to the catalog `media` url)
// The guide is a SEPARATE, heavy per-category fetch (epg/tcl.ts): the same category walk WITH a time range
// yields program stubs, then a batched `/epg/program/detail` lookup enriches each (desc/rating/season/episode).
// No auth, no per-user surface. Ported from FastChannels tcl.py (441 LOC).

// ── endpoints / device identity ────────────────────────────────────────────────────

/** The ideonow.com gateway that serves the TCL TV+ catalog, EPG, and stream-resolve endpoints. */
export const BASE = 'https://gateway-prod.ideonow.com';
/** CDN that hosts TCL channel logos + program artwork (root-relative `/…` paths are prefixed with this). */
export const IMAGE_BASE = 'https://tcl-channel-cdn.ideonow.com';
/** The tcltv.plus web client origin (Origin/Referer gate on the gateway API hops). */
export const ORIGIN = 'https://tcltv.plus';

// A stable device id keeps the catalog + resolve requests coherent with the web client (FastChannels uses this
// exact constant). Env-overridable; not a per-user surface (one identity per deployment is fine for a FAST source).
export const DEVICE_ID = process.env.TCL_DEVICE_ID || '1776786148042-4c4uc';

// The gateway requires a US-state code on every common-params call; FastChannels hardcodes Ohio and it is not
// geographically meaningful (the catalog is national per country_code) — kept verbatim for parity.
const STATE_CODE = 'OH';

// tcltv.plus is a desktop web client (Origin/Referer gated on its gateway API hops); match its UA. The CDN
// stream hops (the resolved master/variant/segment) need only the UA (the proxy's upstreamHeaders), so
// Origin/Referer are sent ONLY on the catalog + resolve + EPG API hops.
export const UA =
  process.env.TCL_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

/** Full headers for the gateway JSON API hops (catalog / EPG / stream resolve) — Origin/Referer gated. */
export const TCL_API_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  Origin: ORIGIN,
  Referer: `${ORIGIN}/`,
};

/** Headers for the CDN stream hops (master/variant/segment) — UA only (the resolved CDN ignores the Origin). */
export const TCL_STREAM_HEADERS: Record<string, string> = { 'User-Agent': UA };

// SSRF allowlist seed for the stream proxy — the registrable families TCL's resolved masters live on. The
// gateway mints the master on a TCL/ideonow CDN or a generic ad/CDN host; the adapter's dynamic allow-set
// pre-allows the resolved master host at play time (resolveStream) + learns child variant/segment hosts during
// playlist rewrite (onPlaylistChildHost), so a host that appears mid-stream is covered without a code change —
// private IPs are always blocked.
export const TCL_SUFFIXES = [
  'ideonow.com',
  'tcltv.plus',
  'cloudfront.net',
  'akamaized.net',
  'amazonaws.com',
  'fastly.net',
  'llnwd.net',
  'b-cdn.net',
  'wurl.com',
  'amagi.tv',
];

// ── geo selection (env-configured, like vidaa/distro — NOT a required playlist config) ──
// TCL serves a national catalog per country_code (US / CA). Channels shared across regions are deduped by their
// bundle id (the first region claims them — the FastChannels posture), so the id is the bare bundle id, NOT
// geo-qualified (unlike vidaa/distro, where the same tvg_id recurs and must be geo-namespaced).

const VALID_GEOS = new Set(['US', 'CA']);

/** Configured country codes (env `TCL_GEO`, default `US`; e.g. `US,CA`). Invalid/dupe entries dropped. */
export function geos(): string[] {
  const raw = process.env.TCL_GEO || 'US';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,|/\s]+/)) {
    const c = part.trim().toUpperCase();
    if (VALID_GEOS.has(c) && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out.length ? out : ['US'];
}

/** The primary country code — used for the per-play resolve (matching FastChannels' `self.country_code`). */
export const PRIMARY_GEO = geos()[0];

// ── small helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  const s = (v == null ? '' : String(v)).trim();
  return s || null;
}

/** Absolutize a root-relative CDN path (`/foo.png` → `${IMAGE_BASE}/foo.png`); leave absolute urls intact. */
export function fixUrl(url: string | null | undefined): string | null {
  const s = str(url);
  if (!s) return null;
  return s.startsWith('/') ? `${IMAGE_BASE}${s}` : s;
}

/** The gateway common params present on every catalog/EPG call (the web client's fixed device/app envelope). */
export function commonParams(geo: string): Record<string, string> {
  return {
    userId: DEVICE_ID,
    device_type: 'web',
    device_model: 'web',
    device_id: DEVICE_ID,
    app_version: '1.0',
    country_code: geo,
    state_code: STATE_CODE,
  };
}

function withParams(path: string, params: Record<string, string>, repeated?: Array<[string, string]>): string {
  const u = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (repeated) for (const [k, v] of repeated) u.searchParams.append(k, v);
  return u.toString();
}

/** GET a gateway JSON endpoint (API headers); throws on a non-2xx. Exported for epg/tcl.ts's detail batches. */
export async function tclGetJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: TCL_API_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postJson(url: string, payload: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...TCL_API_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── url builders (shared with epg/tcl.ts) ────────────────────────────────────────────

/** The live home tab → the category list (`lines[]`) for a country. */
export function livetabUrl(geo: string): string {
  return withParams('/api/metadata/v2/livetab', commonParams(geo));
}

/**
 * One category's channel list. WITHOUT a range → the catalog shape (channels + their `media`/`source`); WITH a
 * `{ start, end }` range → the EPG shape (each channel carries an inline `programs[]` schedule across the window).
 */
export function categoryProgramsUrl(geo: string, categoryId: string, range?: { start: string; end: string }): string {
  const params = { ...commonParams(geo), category_id: categoryId, ...(range ?? {}) };
  return withParams('/api/metadata/v1/epg/programlist/by/category', params);
}

/** A batched program-detail lookup (`ids` repeats per content id) → desc/rating/season/episode/poster per program. */
export function programDetailUrl(geo: string, ids: string[]): string {
  return withParams(
    '/api/metadata/v1/epg/program/detail',
    commonParams(geo),
    ids.map((id) => ['ids', id] as [string, string]),
  );
}

// ── catalog → trimmed rows ───────────────────────────────────────────────────────────

// One catalog row, trimmed to exactly what normalize() + the EPG channel records need (drops the many unused
// catalog fields so the committed snapshot stays lean). `source` + `media` are carried because the per-play
// resolve POST needs them (they ride in the stored sentinel entry url, so the snapshot round-trips them);
// `category` is the livetab category name the channel first appeared under (TCL channels recur across categories
// — the first claims the row, the FastChannels dedup posture).
export interface TclRow {
  channelId: string; // bundle_id (or id)
  name: string;
  logo: string | null;
  category: string; // first category name (fallback 'Entertainment')
  source: string | null; // stream `source` tag (resolve input)
  media: string | null; // catalog `media` url (resolve input + fallback master)
}

/** Fetch a country's livetab category list → `{ id, name }[]` (empty buckets dropped). */
export async function fetchLivetabCategories(geo: string): Promise<Array<{ id: string; name: string | null }>> {
  const payload = await tclGetJson(livetabUrl(geo));
  const lines: any[] = Array.isArray(payload?.lines) ? payload.lines : [];
  const cats: Array<{ id: string; name: string | null }> = [];
  for (const line of lines) {
    const id = str(line?.id);
    if (id) cats.push({ id, name: str(line?.name) });
  }
  return cats;
}

/** Fetch one category's raw channel objects (optionally over a time range, for the EPG schedule). */
export async function fetchCategoryChannels(
  geo: string,
  categoryId: string,
  range?: { start: string; end: string },
): Promise<any[]> {
  const payload = await tclGetJson(categoryProgramsUrl(geo, categoryId, range));
  return Array.isArray(payload?.channels) ? payload.channels : [];
}

// Livetab carries curated/promotional buckets ("TCL TOP 15", "Bingeable", "Home", …) alongside real genres. A
// channel recurs across categories and the FIRST walked claims its group — so a promo bucket walked early would
// mislabel a channel whose genre bucket comes later. These are deprioritized: a later REAL-genre occurrence
// upgrades the group (fetchTclRows), and a channel only ever in promo buckets keeps the promo label as a fallback.
const PROMO_CATEGORIES = new Set([
  'recommended for you',
  'tcl top 15',
  'home',
  'bingeable',
  'featured',
  'trending',
  'popular',
  'for you',
  'spotlight',
  'new & notable',
  'new and notable',
  'continue watching',
]);

function isPromoCategory(name: string | null | undefined): boolean {
  return !!name && PROMO_CATEGORIES.has(name.toLowerCase());
}

/** Trim one raw catalog channel → a lean TclRow, or null when it has no usable bundle id / name. */
function trimRow(ch: any, categoryName: string | null): TclRow | null {
  const channelId = str(ch?.bundle_id) || str(ch?.id);
  const name = str(ch?.name);
  if (!channelId || !name) return null;
  return {
    channelId,
    name,
    logo: fixUrl(str(ch?.logo_color) || str(ch?.logo_white)),
    category: categoryName || 'Entertainment',
    source: str(ch?.source),
    media: str(ch?.media),
  };
}

/**
 * LIVE catalog fetch → trimmed TclRow[]. Walks every country's livetab categories, fetches each category's
 * channel list, and dedupes by bundle id across categories + regions (the first occurrence claims the row — the
 * FastChannels posture). A failed category is skipped (the catalog is large; one 4xx must not abort the sync). No
 * snapshot fallback here (that's the adapter's listChannels wrapper): the standalone EPG sync needs a live-only
 * fetch that throws on total failure so a transient outage preserves the existing guide. Throws on an empty catalog.
 */
export async function fetchTclRows(): Promise<TclRow[]> {
  const deduped = new Map<string, TclRow>();
  for (const geo of geos()) {
    const cats = await fetchLivetabCategories(geo);
    for (const cat of cats) {
      let channels: any[];
      try {
        channels = await fetchCategoryChannels(geo, cat.id);
      } catch {
        continue; // skip a flaky category — the rest of the catalog still syncs
      }
      for (const ch of channels) {
        const row = trimRow(ch, cat.name);
        if (!row) continue;
        const existing = deduped.get(row.channelId);
        if (!existing) {
          deduped.set(row.channelId, row);
        } else if (isPromoCategory(existing.category) && !isPromoCategory(row.category)) {
          existing.category = row.category; // upgrade a curated/promo bucket to a real genre
        }
      }
    }
  }
  const rows = [...deduped.values()];
  if (!rows.length) throw new Error('catalog payload had no channels');
  return rows;
}

// ── sentinel entry url (carries the resolve inputs: bundle id + source + media) ──────
// normalize() stores the gateway `format-stream-url` endpoint with `?bundle_id=…&source=…&media=…` as the channel
// ENTRY (the authentic resolve path — resolveStream POSTs to this very path with the resolve query/body). Unlike
// stirr/xumo (whose id alone resolves), TCL's resolve POST needs the `source` tag + the catalog `media` url, so
// they ride in the entry's query (the proxy round-trips the whole url through resolveStream). isTclEntry gates it
// on host+path; parseTclEntry reads the three inputs back out.

const ENTRY_PATH = '/api/metadata/v1/format-stream-url';

export function channelEntryUrl(row: TclRow): string {
  const u = new URL(`${BASE}${ENTRY_PATH}`);
  u.searchParams.set('bundle_id', row.channelId);
  if (row.source) u.searchParams.set('source', row.source);
  if (row.media) u.searchParams.set('media', row.media);
  return u.toString();
}

export function isTclEntry(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().endsWith('ideonow.com') && u.pathname === ENTRY_PATH;
  } catch {
    return false;
  }
}

export function parseTclEntry(url: string): { bundleId: string; source: string | null; media: string | null } | null {
  try {
    const u = new URL(url);
    const bundleId = u.searchParams.get('bundle_id');
    if (!bundleId) return null;
    return { bundleId, source: u.searchParams.get('source'), media: u.searchParams.get('media') };
  } catch {
    return null;
  }
}

// ── stream resolve (1-hop POST, per play) ────────────────────────────────────────────

/**
 * Resolve a channel → a fresh HLS master url via the gateway's `format-stream-url` POST (a Roku-style per-play
 * resolve). The catalog `media` url is the FALLBACK: on a resolve failure (or an empty `stream_url`) it is
 * returned directly (the un-personalized master, the FastChannels posture). Throws an actionable error only when
 * BOTH are unavailable (the proxy maps it to a 502 + the B-Roll "failed" slate). The caller (the adapter's
 * resolveStream) pre-allows the resolved host so the proxy's SSRF gate passes the master's child hops.
 */
export async function resolveTclMaster(
  bundleId: string,
  source: string | null,
  media: string | null,
): Promise<string> {
  const url = withParams(ENTRY_PATH, { country_code: PRIMARY_GEO, app_version: '3.2.7' });
  const payload = {
    type: 'channel',
    bundle_id: bundleId,
    device_id: DEVICE_ID,
    source,
    stream_url: media,
  };
  try {
    const data = await postJson(url, payload);
    const resolved = str(data?.stream_url) || media;
    if (resolved) return resolved;
  } catch {
    if (media) return media; // gateway resolve flaky/dead — fall back to the catalog master
  }
  throw new Error(`tcl: no playable media for channel ${bundleId}`);
}
