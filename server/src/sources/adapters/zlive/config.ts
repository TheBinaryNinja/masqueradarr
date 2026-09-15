// config.ts — the single place that knows where zlive lives and what its answers look like. Mirrors
// adapters/dulo/config.ts: a Mongo-FREE leaf imported by the adapter, its resolver, the playlist-config module (for
// the defaults and the validator) and the playlist-config "Test" probe. It must never import the models layer and
// must stay side-effect-free at import: dns.ts → settings/translate.ts → core/playlistConfig.ts → here loads before
// Mongo connects, before anything is allowed to make a request.
//
// Two OPERATOR SETTINGS are cached here at module level, hydrated from the playlist configuration by
// settings/applyPlaylistConfig.ts at boot, on every save and after a backup restore:
//   · the DOMAIN (`zlive.domain`). zlive's public catalog is cast.<domain> and its stream resolver is
//     iptv.<domain>; every URL is derived at USE time through the getters, so a setDomain() applies at once. The
//     stored channel entries are host-free `zlive://<slug>` sentinels, so a domain change never invalidates a
//     stored channel or an exported M3U line.
//   · the STREAM CAP (`zlive.extendedProperties.concurrency`): how many DISTINCT zlive channels may be live at once.
//     SourceAdapter.maxConcurrentStreams() reads it on every live resolve (proxy/resolveSeam.ts), and
//     upstreamHeaders()/isAllowedUpstream() are synchronous too — which is why these are module caches, not
//     per-call Mongo reads.
//
// The rest is the SHAPE of zlive's answers — the slug rule, the entry sentinel, the resolver's Location format,
// the alias table — so the adapter, its resolver and any future script agree on one definition.

import { createDynamicAllow, type DynamicAllow } from '../_fast/dynamicAllow.js';
import { normalizeDomain as normalizeSourceDomain, type DomainParse } from '../../core/domain.js';

/** The committed default — zlive's domain as last known. Also the playlist config default. */
export const ZLIVE_DEFAULT_DOMAIN = 'zlive.st';

/**
 * Default cap on distinct concurrently-live zlive channels (`concurrency`; 0 = unlimited). Two, because zlive ranks
 * clients by "unique streams per IP" and keeps a manual leech list — a household watching a couple of channels is
 * ordinary traffic, a server pulling a dozen is the profile it looks for.
 */
export const ZLIVE_DEFAULT_MAX_STREAMS = 2;
/** Upper bound the playlist-config validator accepts for `concurrency` (a sanity bound, not a recommendation). */
export const ZLIVE_MAX_STREAMS_LIMIT = 100;

// ── Domain ──────────────────────────────────────────────────────────────────────────────────────────────
// The active zlive domain, as a bare lowercase host. Read it only through the getters; write it only through
// setDomain(). `_domainEpoch` counts changes, so the resolver can tell that its per-slug cache and decoy state
// belong to a deployment the operator has just switched away from (see resolver.ts syncEpoch) without this leaf
// having to import it.
let _domain = ZLIVE_DEFAULT_DOMAIN;
let _domainEpoch = 0;

/** The active domain, e.g. "zlive.st". Always read at use time. */
export function getDomain(): string {
  return _domain;
}

/** Bumped every time setDomain() actually changes the domain. */
export function getDomainEpoch(): number {
  return _domainEpoch;
}

// The `*For(domain)` builders exist so the Settings "Test" probe can hit a CANDIDATE domain without duplicating
// zlive's URL shapes in the route layer; the no-argument getters are these bound to the active domain.

/** The public channel catalog for an arbitrary zlive domain — a bare JSON array, no auth. */
export function catalogUrlFor(domain: string): string {
  return `https://cast.${domain}/channels.json`;
}

/** The stream resolver base for an arbitrary zlive domain: GET <base>/<slug> answers a 302 to a signed playlist. */
export function resolverBaseFor(domain: string): string {
  return `https://iptv.${domain}`;
}

/** The active catalog URL, e.g. "https://cast.zlive.st/channels.json". */
export function getCatalogUrl(): string {
  return catalogUrlFor(_domain);
}

/** The active resolver base, e.g. "https://iptv.zlive.st". */
export function getResolverBase(): string {
  return resolverBaseFor(_domain);
}

// A normal desktop-browser User-Agent, sent on the catalog GET, every resolve, and (via upstreamHeaders) every
// data-plane hop. zlive needs no other header — a Referer/Origin made no difference to the resolver — so none is
// sent: masqueradarr identifies as a browser client, it does not impersonate zlive's own site.
export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── SSRF allow-set ────────────────────────────────────────────────────────────────────────────────────
// The shared per-source dynamic allow-set: seeded with the active domain (exact-or-subdomain), grown with every
// Location host the resolver accepts and every child host seen inside a resolved playlist, private targets
// always blocked. Like dulo's, SourceAdapter.isAllowedUpstream/onPlaylistChildHost are called by nothing in the
// Node tree today — the live gate is Rust-side (seeded from the grant's target). The guards that DO run are
// normalizeDomain() on operator input and the resolver's Location checks (resolver.ts).
export const zliveAllow: DynamicAllow = createDynamicAllow([ZLIVE_DEFAULT_DOMAIN]);

/**
 * Normalize an operator-typed domain into a bare lowercase host: the shared core/domain.ts gate (strips
 * scheme/path/port/userinfo; rejects IP literals, private/loopback hosts and implausible names). A real SSRF
 * boundary — the catalog fetch, the resolver and the Test endpoint all go to whatever comes back from here.
 */
export function normalizeDomain(raw: string): DomainParse {
  return normalizeSourceDomain(raw, 'zlive');
}

/**
 * Switch the active zlive domain (boot, every playlist-config save, a backup restore — all via
 * settings/applyPlaylistConfig.ts). Folds the new apex into the allow-set. Returns true when the value actually CHANGED.
 */
export function setDomain(next: string): boolean {
  const parsed = normalizeDomain(next);
  if (!parsed.ok) return false;
  const changed = parsed.domain !== _domain;
  _domain = parsed.domain;
  if (changed) _domainEpoch += 1;
  zliveAllow.allow(_domain);
  return changed;
}

// ── Stream cap ────────────────────────────────────────────────────────────────────────────────────────
let _maxStreams = ZLIVE_DEFAULT_MAX_STREAMS;

/** Distinct zlive channels allowed live at once; 0 = unlimited (resolveSeam's contract for "no cap"). */
export function getMaxStreams(): number {
  return _maxStreams;
}

/** Cache a new cap. Junk (NaN, negative, fractional) collapses to the nearest sane value, never to "refuse all". */
export function setMaxStreams(n: number): void {
  const v = Math.trunc(Number(n));
  _maxStreams = Number.isFinite(v) ? Math.min(ZLIVE_MAX_STREAMS_LIMIT, Math.max(0, v)) : ZLIVE_DEFAULT_MAX_STREAMS;
}

// ── Catalog rows + channel identity ───────────────────────────────────────────────────────────────────

/** The only catalog fields the adapter keeps (zlive's rows also carry cosmetic tagline/region/flag/accent/…). */
export interface CatalogRow {
  id: string;
  name: string;
  sport: string;
}

/**
 * Trim a catalog body (a bare JSON array) to the fields normalize needs, or null when it is not an array at all.
 * Shared by the adapter's listChannels and the Settings Test route, so "how many channels does this domain
 * serve" means the same thing in both. Rows without a string id are dropped here; slug validity is normalize's.
 */
export function parseCatalog(body: unknown): CatalogRow[] | null {
  if (!Array.isArray(body)) return null;
  const rows: CatalogRow[] = [];
  for (const r of body as Array<Record<string, unknown> | null>) {
    if (!r || typeof r.id !== 'string' || !r.id) continue;
    rows.push({
      id: r.id,
      name: typeof r.name === 'string' ? r.name : '',
      sport: typeof r.sport === 'string' ? r.sport : '',
    });
  }
  return rows;
}

/** The characters zlive's own add-by-slug dialog allows, and the ones its resolver signs rather than 404s. */
export const SLUG_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Catalog id → resolver slug, reproducing zlive's player (`n7`) exactly: strip ONE leading `auto-` (its 10-minute
 * upstream re-sync prefixes every auto-managed row), then ONE leading `evt-` — in that order, each once. null when
 * the result is not a slug the resolver would sign. The slug, not the raw id, is the channel identity: it is what
 * the resolver keys on, and it survives zlive flipping a row between auto and manual.
 */
export function slugOf(id: string): string | null {
  const slug = String(id).replace(/^auto-/, '').replace(/^evt-/, '');
  return SLUG_RE.test(slug) ? slug : null;
}

/** zlive's own label for rows with no sport (its player's `sport.trim() || "Other"`). */
export function groupOf(sport: unknown): string {
  return (typeof sport === 'string' && sport.trim()) || 'Other';
}

// The stored stream entry: a host-free sentinel (the dulo/pluto pattern). Only the slug is stored; the resolver
// host is read from the domain cache at resolve time.
export const ENTRY_PREFIX = 'zlive://';

export function entryUrlFor(slug: string): string {
  return `${ENTRY_PREFIX}${slug}`;
}

/** The slug inside a `zlive://<slug>` entry, or null for anything else. */
export function slugFromEntry(url: string): string | null {
  if (typeof url !== 'string' || !url.startsWith(ENTRY_PREFIX)) return null;
  const slug = url.slice(ENTRY_PREFIX.length);
  return SLUG_RE.test(slug) ? slug : null;
}

/**
 * Catalog duplicates that are default-DISABLED on first sync (slug → the channel it duplicates). The manual row
 * `skysportsf1-uk` resolves to the very file the auto row `sky-sports-f1` does, so having both Active would run two
 * ingests of one feed — two of the operator's capped streams for one picture. The auto row stays (zlive keeps
 * four upstream sources behind it). First-sync only, like every defaultDisabled: an operator's Enable sticks.
 */
export const DUPLICATE_OF: Readonly<Record<string, string>> = {
  'skysportsf1-uk': 'sky-sports-f1',
};

/** Is `slug` a listed duplicate? Own-key test: a slug may legally be "constructor", which `in` would match. */
export function isDuplicateSlug(slug: string): boolean {
  return Object.hasOwn(DUPLICATE_OF, slug);
}

// ── The resolver's answer ─────────────────────────────────────────────────────────────────────────────
/**
 * The Location shape zlive's resolver signs (observed on every resolve, 2026-09-14): an https playlist URL whose
 * path is /main/secure/<64-hex token>/<10-digit unix expiry>/<file>.m3u8. The HOST is deliberately any DNS name
 * (the TLD label must start with a letter, so an IP literal never matches): the path is the signer's signature,
 * the host is its CDN and may rotate. A Location off this shape is only accepted on the registrable domain of the
 * last good one (resolver.ts). Groups: 1 host, 2 expiry (unix seconds), 3 file name without `.m3u8`.
 */
export const LOCATION_RE =
  /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*)\/main\/secure\/[0-9a-f]{64}\/(\d{10})\/([A-Za-z0-9_-]+)\.m3u8$/;

export interface SignedLocation {
  host: string;
  /** The token's expiry, epoch SECONDS (as signed). */
  expSec: number;
  /** The upstream file name without `.m3u8` — the resolver's real answer to "which feed is this slug". */
  file: string;
}

/** Parse an on-shape Location, or null when it is off-shape. */
export function parseSignedLocation(location: string): SignedLocation | null {
  const m = LOCATION_RE.exec(location);
  return m ? { host: m[1], expSec: Number(m[2]), file: m[3] } : null;
}

/**
 * The resolver's slug → file ALIAS TABLE, as observed (one resolve per slug, 2026-09-14, linear catalog channels
 * only — the event, mirror-key and bogus-slug probes are omitted because the adapter never resolves them). zlive
 * maps slugs to upstream files server-side (espn → espn-usa) and signs identity (`<slug>.m3u8`) for any slug it
 * does not know, so most rows below just record that mapping. The one that matters to the decoy check is the
 * PAIR sky-sports-f1 / skysportsf1-uk: two catalog rows legitimately sharing one file.
 *
 * Used only by the decoy heuristic (resolver.ts): slugs mapping to the same file here are ONE alias class, and a
 * slug absent from the table is its own class unless the file it is answered is named after it (resolver.ts
 * decoyClass). It is not a routing table — the resolver's live answer always
 * wins — so a stale entry can only make the decoy check slightly more or less eager, never break playback.
 */
export const ALIAS_TABLE: Readonly<Record<string, string>> = {
  abc: 'abc-usa',
  'acc-network': 'accn-usa',
  'apple-tv': 'apple-tv',
  'apple-tv-uhd': 'apple-tv-uhd',
  'bbc-one-london': 'bbcone-uk',
  'cartoon-network': 'cartoonnetwork-usa',
  'dazn-1-germany': 'dazn1-de',
  'disney-channel': 'disneychannel-usa',
  espn: 'espn-usa',
  'fox-sports-1': 'fox-sports-1',
  'nfl-network': 'nflnetwork-usa',
  'sky-sport-uno': 'skysportuno-it',
  'sky-sports-f1': 'skysportsf1-uk',
  'sky-sports-main-event': 'skysportsmainevent-uk',
  'skysportsf1-uk': 'skysportsf1-uk',
  'wapa-deportes': 'wapadeportes-usa',
  'willow-cricket': 'willow-usa',
};

/** A slug's alias class: its table file when listed, else itself. Equal classes = aliases of each other. */
export function aliasClass(slug: string): string {
  return Object.hasOwn(ALIAS_TABLE, slug) ? ALIAS_TABLE[slug] : slug;
}
