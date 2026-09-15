// resolver.ts — zlive's per-play stream resolution: `GET https://iptv.<domain>/<slug>` answers a 302 whose
// Location is a signed playlist URL (…/main/secure/<token>/<expiry>/<file>.m3u8), valid for ~2.5 h. This module
// turns that into a ResolvedStream and holds the small amount of state that makes it SAFE to call on every play:
//
//   · A PER-SLUG REUSE CACHE. The data plane re-resolves an entry every minute (Rust's target TTL) for as long as
//     anyone watches it; forwarding each of those to zlive would be one resolver hit per channel per minute, and
//     zlive logs and ranks every hit per IP. A resolved target is reused for most of its token's LIFETIME — until
//     10 min before it expires, or a quarter of the lifetime for a token shorter than 40 min. The lifetime is read
//     on zlive's OWN clock (the signed expiry minus the 302's Date header), so a skewed local clock can neither
//     shrink the window nor hand the data plane an expiry it will misjudge. With ~2.5 h tokens a watched channel
//     costs about one resolver request per 2⅓ h, and the data plane's renewal (60 s before expiry) lands on a
//     freshly minted token. Concurrent resolves of one slug share a single request.
//
//   · A RATE-LIMITED WAY OUT OF THAT CACHE. Reuse that long is only safe because the data plane can say "the
//     target you gave me was refused, or stopped refreshing, before its expiry" (ResolveStreamOptions.fresh — or
//     `advance`, which for zlive means the same thing: a new token is its only alternative). That drops the slug's
//     cached target so the next contact mints a new one — but only once the current token is 60 s old, and that
//     floor doubles (to 15 min) while each replacement fails too. An upstream that refuses EVERY token — the CDN's
//     IP-wide 9-byte 403 — so costs a handful of resolver requests an hour, not one per player retry.
//
//   · FAILURE BACKOFF. Nothing else about a failure is retried at zlive's expense either:
//       - a resolver REFUSAL (401/403/429) is about this IP, not the slug, so it starts a GLOBAL cool-down — the
//         Retry-After when zlive sends one of up to 1 h, else 60 s doubling per consecutive refusal to 15 min,
//         reset by the next good 302 to a request sent after it began — during which no slug contacts zlive.
//         Answers to requests already in flight when it began can lengthen it, never shorten or end it. Cached
//         targets are still handed out: tokens already minted stay usable, the refusal is the resolver's.
//       - any OTHER failed contact (a 5xx, a timeout, DNS, a rejected Location) is negative-cached for that slug
//         for 30 s.
//     So a player retrying a failed channel every few seconds costs zlive nothing extra.
//
//   · LOCATION VETTING. The Location is upstream-supplied and becomes the data plane's fetch target, so it is an
//     SSRF surface: it must be https, on zlive's signed shape (config.ts LOCATION_RE) — or, when the shape
//     changes, on the same registrable domain as the last good one — and its host must resolve (through the SAME
//     resolver fetch() uses, dns.ts lookupAll) only to public unicast addresses. That is an EARLY REFUSAL, not a
//     connection-time guarantee: the data plane resolves the host again when it connects and checks only IP
//     literals itself, so an answer that changes between the two lookups (DNS rebinding), or a private host named
//     inside the signed playlist, is not caught here.
//
//   · DECOY DETECTION — surface only, never evasion. zlive keeps a manual IP leech list whose members are served
//     a decoy ad stream instead of the channel. The one signature visible from here is many unrelated channels
//     suddenly resolving to the SAME feed — the signed file name, or for an off-shape Location its whole path
//     less any token-like segments (a per-channel directory with a generic `index.m3u8` is many feeds, not one).
//     So when one feed is answered for ≥ 3 slugs that are not aliases of each other (config.ts ALIAS_TABLE, or a
//     file named after the slug, as espn → espn-usa), the feed is LATCHED for 30 min: the slugs known to map to
//     it fail with `zlive_decoy_suspected` WITHOUT contacting zlive, the latch is logged at warn and shown in
//     status(). Nothing here tries to route around a listing — no alternate hosts, no header games, no retries;
//     the operator is told, and the latch simply stops us re-asking in the meantime.
//
// Errors carry one of four classes for status(): `refusal-403` (the resolver refused us: 403, or its 401/429
// cousins — and every resolve refused locally during the cool-down that follows), `dns-connect` (the resolver or
// the Location host could not be reached, resolved, or answered a 5xx), `decoy`, and `shape` (any other
// unexpected answer, including a Location that failed vetting). A throw becomes a 502 `resolve_failed: <message>`
// in the resolve seam, so the data plane moves on to the channel's failover backups.
//
// Everything network-facing is injected (fetch, the DNS lookup, the clock), so the whole state machine can be
// exercised offline with fabricated answers; the adapter wires in global fetch and dns.ts lookupAll.

import { BlockList, isIP } from 'node:net';
import { logger } from '../../core/logger.js';
import { logMilestone, logTrace } from '../../../logs/tier.js';
import {
  ALIAS_TABLE,
  UA,
  aliasClass,
  getDomainEpoch,
  getResolverBase,
  parseSignedLocation,
  zliveAllow,
} from './config.js';

const TAG = 'zlive';

/** A target is reused until this long before its token expires… */
const EXPIRY_MARGIN_MS = 10 * 60_000;
/** …(or until a quarter of its lifetime remains, when that is sooner); a window shorter than this is not cached. */
const MIN_REUSE_MS = 5_000;
/** Reuse window for an accepted off-shape Location, whose expiry cannot be read: short, as nothing bounds it. */
const UNKNOWN_EXPIRY_REUSE_MS = 10 * 60_000;
/** Tokens living less than this are worth a warning: the cache is degrading and resolver requests will rise. */
const SHORT_LIFETIME_WARN_MS = 15 * 60_000;
/** A data-plane "fresh target" request re-mints only once the cached token is this old… */
const FRESH_MIN_INTERVAL_MS = 60_000;
/** …doubling per consecutive re-mint (each replacement failed too), up to this. */
const FRESH_MAX_INTERVAL_MS = 15 * 60_000;
/** Fresh requests for a slug that stop for this long end the incident: the next one starts over at the minimum. */
const FRESH_STREAK_RESET_MS = 5 * 60_000;
/** Resolver refusal cool-down: the first wait, doubling per consecutive refusal up to the max. */
const REFUSAL_COOLDOWN_MIN_MS = 60_000;
const REFUSAL_COOLDOWN_MAX_MS = 15 * 60_000;
/** A Retry-After is honoured up to this long; anything larger is treated as junk (the backoff above still applies). */
const RETRY_AFTER_MAX_MS = 60 * 60_000;
/** Any other failed contact is not retried against zlive for this long, per slug. */
const NEGATIVE_TTL_MS = 30_000;
/** Distinct alias classes answered the same file before it is suspected to be a decoy. */
const DECOY_MIN_CLASSES = 3;
/** How long a suspected decoy file is latched (its known slugs are refused without contacting zlive). */
const DECOY_LATCH_MS = 30 * 60_000;
/** How long a slug → file answer counts toward the decoy test. Long enough to connect channels opened hours apart. */
const OBSERVATION_TTL_MS = 6 * 60 * 60_000;
/** The resolver answers in ~0.3 s; a hung request must not hold a stream start (or a cap slot) for long. */
const RESOLVE_TIMEOUT_MS = 10_000;
/** Repeat warnings about one slug/class inside this window drop to level-3 lineage. */
const WARN_THROTTLE_MS = 60_000;

export type ZliveErrorClass = 'refusal-403' | 'dns-connect' | 'decoy' | 'shape';

export class ZliveResolveError extends Error {
  readonly errorClass: ZliveErrorClass;
  readonly httpStatus: number | null;
  constructor(errorClass: ZliveErrorClass, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = 'ZliveResolveError';
    this.errorClass = errorClass;
    this.httpStatus = httpStatus;
  }
}

export interface ZliveResolved {
  masterUrl: string;
  /** The token's expiry in epoch ms (absent for an accepted off-shape Location, whose expiry is unreadable). */
  expiresAtMs?: number;
}

export interface ResolverDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Every address `host` resolves to — dns.ts lookupAll in production. Rejects when nothing resolves. */
  lookup: (host: string) => Promise<Array<{ address: string; family: number }>>;
  now: () => number;
}

export interface ZliveResolveOptions {
  /** The data plane's alternate-upstream request (never sent to zlive today); for zlive, identical to `fresh`. */
  advance?: boolean;
  /** The target handed out for this slug failed before its expiry — don't hand it back (rate-limited; see the header). */
  fresh?: boolean;
}

interface CacheEntry {
  masterUrl: string;
  file: string;
  host: string;
  expiresAtMs: number | null;
  /** When the 302 that minted it arrived (epoch ms) — the fresh-request floor counts from here. */
  mintedAt: number;
  /** Reused until this instant (epoch ms); see EXPIRY_MARGIN_MS. */
  reuseUntil: number;
}

interface DecoyLatch {
  file: string;
  since: number;
  until: number;
  /** The slugs known to be answered this file — refused without contact while the latch holds. */
  slugs: string[];
}

/**
 * The resolver refused this server; kept after it lapses so the next refusal doubles the wait (a 302 to a request
 * sent after it began clears it).
 */
interface CoolDown {
  since: number;
  until: number;
  /** Consecutive refusals, 1-based. */
  step: number;
  httpStatus: number;
  /** The resolver's own Retry-After, in ms, when it sent a readable one within RETRY_AFTER_MAX_MS. */
  retryAfterMs: number | null;
}

export interface ZliveResolverStatus {
  cacheSize: number;
  cached: Array<{
    slug: string;
    file: string;
    host: string;
    expiresAtMs: number | null;
    mintedAt: number;
    reuseUntil: number;
  }>;
  /** Host of the last Location that passed vetting. */
  lastLocationHost: string | null;
  /** Registrable domain an off-shape Location must be on to be accepted (from the last on-shape one). */
  lastGoodSuffix: string | null;
  /** Lifetime of the last on-shape token, on zlive's own clock (≈ 9 000 000 ms as observed). */
  lastLifetimeMs: number | null;
  decoyLatches: DecoyLatch[];
  /** An ACTIVE resolver-refusal cool-down (no slug contacts zlive until `until`), or null. */
  coolDown: CoolDown | null;
  /** Slugs whose last contact failed, not retried against zlive until `until`. */
  negative: Array<{ slug: string; until: number; errorClass: ZliveErrorClass }>;
  lastError: {
    errorClass: ZliveErrorClass;
    message: string;
    slug: string;
    at: number;
    httpStatus: number | null;
  } | null;
  lastOkAt: number | null;
  /**
   * Since boot: resolver requests that produced a target (`minted`), cache reuses, failed resolves — of which
   * `suppressed` were answered locally without contacting zlive (cool-down, negative cache, decoy latch) — and
   * cached targets dropped because the data plane reported them failing (`retired`).
   */
  counts: { minted: number; reused: number; failed: number; suppressed: number; retired: number };
}

export interface ZliveResolver {
  resolve(slug: string, opts?: ZliveResolveOptions): Promise<ZliveResolved>;
  status(): ZliveResolverStatus;
}

// ── Address + domain vetting ──────────────────────────────────────────────────────────────────────────
// Addresses a CDN can never legitimately live on. Two lists, one per family, on purpose: node's BlockList maps an
// IPv4 address to ::ffff:a.b.c.d when checking it against IPv6 rules, so a mapped-range rule in a shared list
// would match EVERY IPv4 address.
const V4_NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT (a household's WAN side, often)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. cloud metadata endpoints)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  V4_NON_PUBLIC.addSubnet(net, prefix, 'ipv4');
}
// The v6 list also refuses every range that EMBEDS an IPv4 address a translator or tunnel could deliver to —
// a CDN has no business answering one, and on an IPv6-only host behind NAT64/DNS64 an AAAA-only name in
// 64:ff9b::/96 reaches whatever IPv4 address it carries (169.254.169.254 included).
const V6_NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback (::1) and the deprecated IPv4-compatible ::a.b.c.d
  ['::ffff:0:0:0', 96], // SIIT IPv4-translated ::ffff:0:a.b.c.d
  ['64:ff9b::', 96], // NAT64 well-known prefix
  ['64:ff9b:1::', 48], // NAT64 local-use prefix
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo (embeds an IPv4 server and client)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address)
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated, still routed on some LANs)
  ['ff00::', 8], // multicast
] as const) {
  V6_NON_PUBLIC.addSubnet(net, prefix, 'ipv6');
}
// IPv4-MAPPED IPv6 (::ffff:a.b.c.d) is refused outright: a public CDN name has no business answering one, and
// it is the classic way to smuggle an IPv4 target past a v6-only check.
const V6_MAPPED = new BlockList();
V6_MAPPED.addSubnet('::ffff:0:0', 96, 'ipv6');

/**
 * Is `address` a public unicast IP (not private/loopback/link-local/CGNAT/multicast/reserved, and not an IPv6
 * form that maps, translates or tunnels to an IPv4 address)?
 */
export function isPublicAddress(address: string): boolean {
  try {
    const family = isIP(address);
    if (family === 4) return !V4_NON_PUBLIC.check(address, 'ipv4');
    if (family === 6) return !V6_MAPPED.check(address, 'ipv6') && !V6_NON_PUBLIC.check(address, 'ipv6');
  } catch {
    // A zone-scoped or otherwise unparseable literal — not something to connect a data plane to.
  }
  return false;
}

// Second-level labels that sit UNDER a two-letter ccTLD as part of its public suffix (co.uk, com.au, net.br, …).
const GENERIC_SLD = /^(?:ac|co|com|edu|gob|gov|ltd|mil|ne|net|nom|or|org|plc)$/;

/**
 * Approximate registrable domain (eTLD+1) of a host, without a public-suffix list: the last two labels, or the
 * last three when the second-level label is a generic one under a two-letter ccTLD (epidd.hundxvision.co.uk →
 * hundxvision.co.uk). Used only to ask "is this off-shape Location still on the same operator's domain". Its one
 * blind spot is a PRIVATE multi-label suffix (two unrelated *.github.io sites compare equal), which is why it
 * only ever relaxes the check for a host whose suffix already served a fully on-shape Location. null for IP
 * literals and single-label names.
 */
export function registrableSuffix(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h || !h.includes('.') || isIP(h.replace(/^\[|\]$/g, ''))) return null;
  const labels = h.split('.');
  const n = labels.length;
  const take = n >= 3 && labels[n - 1].length === 2 && GENERIC_SLD.test(labels[n - 2]) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/**
 * A Retry-After header → milliseconds to wait, or null when absent/unreadable. Accepts both forms: delta-seconds,
 * and an HTTP-date, measured against `serverNowMs` (the response's own Date when it sent one, so the two instants
 * come from the same clock).
 */
export function parseRetryAfter(value: string | null, serverNowMs: number): number | null {
  const v = value?.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - serverNowMs) : null;
}

// Off-shape path segments that carry a per-request signature rather than a feed name: long hex runs (tokens,
// hashes) and long digit runs (expiries, timestamps).
const TOKEN_SEGMENT_RE = /^(?:[0-9a-f]{16,}|\d{8,})$/i;

/**
 * The feed an off-shape Location names, for the decoy test: its path without `.m3u8` and without token-like
 * segments (/live/espn/index.m3u8 → live/espn/index). The last segment alone would make every channel of a
 * per-directory layout the same "index" feed.
 */
function offShapeFeed(pathname: string): string {
  const segs = pathname.split('/').filter(Boolean);
  if (segs.length) segs[segs.length - 1] = segs[segs.length - 1].replace(/\.m3u8$/i, '');
  return segs.filter((s) => s && !TOKEN_SEGMENT_RE.test(s)).join('/') || pathname;
}

/** Lowercase alphanumerics only, for "is this file named after that slug". */
function flat(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The decoy test's class for `slug` answered `file`: the file itself when the slug is a listed alias of it, or the
 * file is named after the slug (espn → espn-usa, bein-sports → beinsports-usa) — the resolver maps slugs to
 * upstream files server-side and ALIAS_TABLE only records the mappings seen so far — else the slug's own class.
 * A slug under 3 characters is too short to call a file named after it.
 */
function decoyClass(slug: string, file: string): string {
  const cls = aliasClass(slug);
  if (cls === file) return file;
  const s = flat(slug);
  return s.length >= 3 && flat(file).includes(s) ? file : cls;
}

/** How old the current token must be before a fresh request re-mints it, when `drops` re-mints already failed. */
function freshFloor(drops: number): number {
  return Math.min(FRESH_MAX_INTERVAL_MS, FRESH_MIN_INTERVAL_MS * 2 ** Math.max(0, drops));
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

// ── The resolver ──────────────────────────────────────────────────────────────────────────────────────

export function createZliveResolver(deps: ResolverDeps): ZliveResolver {
  // All state below belongs to ONE zlive deployment. `epoch` is the config leaf's domain epoch it was built
  // for; when the operator switches domains, the cache (targets another deployment minted), the decoy and
  // failure bookkeeping and the last-good suffix are all dropped on the next call (syncEpoch).
  let epoch = getDomainEpoch();
  const cache = new Map<string, CacheEntry>();
  const observations = new Map<string, { file: string; at: number }>(); // slug → its latest answered file
  const latches = new Map<string, DecoyLatch>(); // file → latch
  const inflight = new Map<string, Promise<ZliveResolved>>();
  const negative = new Map<string, { until: number; err: ZliveResolveError }>(); // slug → its last failed contact
  // slug → its current fresh-request incident: re-mints so far, and when the data plane last asked (see retireCached)
  const freshIncidents = new Map<string, { drops: number; lastAskAt: number }>();
  const warnedAt = new Map<string, number>();
  const notedRemaps = new Set<string>();
  let coolDown: CoolDown | null = null;
  // Bumped whenever a refusal starts a new cool-down step. Each contact remembers the value it was SENT under: an
  // answer to a request that left before the current cool-down began is part of the same burst (in-flight dedupe
  // is per slug, so several channels can be mid-request when the resolver starts refusing). Such a refusal may only
  // lengthen the wait — it is not another consecutive refusal — and such a 302 cannot end it.
  let coolDownGen = 0;
  let lastGoodSuffix: string | null = null;
  let lastLocationHost: string | null = null;
  let lastLifetimeMs: number | null = null;
  let lastError: ZliveResolverStatus['lastError'] = null;
  let lastOkAt: number | null = null;
  const counts = { minted: 0, reused: 0, failed: 0, suppressed: 0, retired: 0 };

  function syncEpoch(): void {
    const current = getDomainEpoch();
    if (current === epoch) return;
    epoch = current;
    cache.clear();
    observations.clear();
    latches.clear();
    negative.clear();
    freshIncidents.clear();
    notedRemaps.clear();
    coolDown = null;
    lastGoodSuffix = null;
    lastLocationHost = null;
    lastLifetimeMs = null;
    logger.info(TAG, `domain changed — resolver cache, decoy and backoff state and last-good host reset (${getResolverBase()})`);
  }

  function warnThrottled(key: string, msg: string, now: number): void {
    const last = warnedAt.get(key);
    if (last !== undefined && now - last < WARN_THROTTLE_MS) {
      logTrace(TAG, msg);
      return;
    }
    if (warnedAt.size > 1024) warnedAt.clear(); // bounded: keys are class×slug, this only guards pathology
    warnedAt.set(key, now);
    logger.warn(TAG, msg);
  }

  function fail(
    errorClass: ZliveErrorClass,
    slug: string,
    message: string,
    httpStatus: number | null = null,
  ): ZliveResolveError {
    const now = deps.now();
    counts.failed += 1;
    lastError = { errorClass, message, slug, at: now, httpStatus };
    warnThrottled(`${errorClass}:${slug}`, `${slug}: ${message}`, now);
    return new ZliveResolveError(errorClass, message, httpStatus);
  }

  // A resolve refused HERE, without contacting zlive (cool-down, negative cache). Counted and traced, but it does
  // not overwrite lastError — the operator needs to keep seeing the real failure that caused the suppression.
  function suppressed(slug: string, err: ZliveResolveError): ZliveResolveError {
    counts.failed += 1;
    counts.suppressed += 1;
    logTrace(TAG, `${slug}: ${err.message}`);
    return err;
  }

  function coolingDown(now: number): boolean {
    return coolDown !== null && coolDown.until > now;
  }

  function prune(now: number): void {
    for (const [file, latch] of latches) {
      if (latch.until > now) continue;
      latches.delete(file);
      logger.info(TAG, `decoy latch on ${file}.m3u8 expired — its ${latch.slugs.length} channel(s) may contact zlive again`);
    }
    for (const [slug, o] of observations) {
      if (now - o.at > OBSERVATION_TTL_MS) observations.delete(slug);
    }
    for (const [slug, c] of cache) {
      if (c.reuseUntil <= now) cache.delete(slug);
    }
    for (const [slug, n] of negative) {
      if (n.until <= now) negative.delete(slug);
    }
    for (const [slug, f] of freshIncidents) {
      if (now - f.lastAskAt >= FRESH_STREAK_RESET_MS) freshIncidents.delete(slug);
    }
  }

  function decoyMessage(latch: DecoyLatch): string {
    const shown = latch.slugs.slice(0, 6).join(', ') + (latch.slugs.length > 6 ? ', …' : '');
    const feeds = new Set(latch.slugs.map((s) => decoyClass(s, latch.file))).size;
    return (
      `zlive_decoy_suspected: the resolver answered ${latch.file}.m3u8 for ${latch.slugs.length} channels that ` +
      `should be ${feeds} different feeds (${shown}) — the signature of the decoy zlive serves to IPs on its leech ` +
      `list. Not contacting zlive for these channels until ${isoOf(latch.until)}`
    );
  }

  // Record this answer, then apply the decoy test to the feed it named. Throws when the feed is (or just became)
  // latched. Slugs that are aliases of the answered file (decoyClass) are ONE class, so the known sky-sports-f1 /
  // skysportsf1-uk pair, or rows zlive maps onto a file named after them, never count as "unrelated" channels.
  function observeAndCheckDecoy(slug: string, file: string, now: number): void {
    observations.set(slug, { file, at: now });
    const existing = latches.get(file);
    if (existing) {
      if (!existing.slugs.includes(slug)) existing.slugs.push(slug);
      throw fail('decoy', slug, decoyMessage(existing));
    }
    const members = [...observations].filter(([, o]) => o.file === file).map(([s]) => s);
    const classes = new Set(members.map((s) => decoyClass(s, file)));
    if (classes.size < DECOY_MIN_CLASSES) return;
    const latch: DecoyLatch = { file, since: now, until: now + DECOY_LATCH_MS, slugs: members };
    latches.set(file, latch);
    for (const [s, c] of cache) if (c.file === file) cache.delete(s); // never hand out a cached decoy either
    throw fail('decoy', slug, decoyMessage(latch));
  }

  // The data plane reports that the target handed out for `slug` failed before its expiry. Drop the cached one so
  // the next contact mints a new token — unless the cool-down forbids contact, or the current token is younger than
  // the floor: 60 s, doubling for every re-mint in this INCIDENT that failed too (to 15 min). An incident lasts as
  // long as the reports keep coming — they arrive every few seconds while a channel is failing — and ends after
  // FRESH_STREAK_RESET_MS without one, so the next failure, hours later, starts over at 60 s. A kept target is simply
  // served again: the data plane retries on its own schedule, and the first report past the floor gets a new token.
  function retireCached(slug: string, why: string, now: number): void {
    const hit = cache.get(slug);
    if (!hit) return;
    if (coolingDown(now)) {
      logTrace(TAG, `${slug}: ${why}, but the resolver cool-down forbids a new token until ${isoOf(coolDown!.until)} — serving the cached one`);
      return;
    }
    const prev = freshIncidents.get(slug);
    const incident = prev && now - prev.lastAskAt < FRESH_STREAK_RESET_MS ? prev : { drops: 0, lastAskAt: now };
    incident.lastAskAt = now;
    freshIncidents.set(slug, incident);
    const floor = freshFloor(incident.drops);
    const age = now - hit.mintedAt;
    if (age < floor) {
      logTrace(
        TAG,
        `${slug}: ${why}, but its token is only ${Math.round(age / 1000)} s old — a new one once it is ` +
          `${Math.round(floor / 1000)} s old` +
          (incident.drops ? ` (the last ${incident.drops} replacement(s) failed too)` : ''),
      );
      return;
    }
    cache.delete(slug);
    incident.drops += 1;
    counts.retired += 1;
    logMilestone(
      TAG,
      `${slug}: ${why} — dropping its cached ${hit.file}.m3u8 link (minted ${Math.round(age / 60_000)} min ago) for a fresh one` +
        (incident.drops > 1
          ? ` (replacement ${incident.drops}; if it fails too, the next no sooner than ${Math.round(freshFloor(incident.drops) / 60_000)} min)`
          : ''),
    );
  }

  async function contact(slug: string): Promise<ZliveResolved> {
    const epochAtStart = epoch;
    const genAtSend = coolDownGen;
    const url = `${getResolverBase()}/${encodeURIComponent(slug)}`;
    // Failure bookkeeping belongs to the deployment the request was made for (see the commit below).
    const current = (): boolean => getDomainEpoch() === epochAtStart && epoch === epochAtStart;

    // Any failed contact that is not a refusal (cool-down) or a decoy (latch): don't retry this slug for a while.
    const failContact = (
      errorClass: ZliveErrorClass,
      message: string,
      httpStatus: number | null = null,
    ): ZliveResolveError => {
      const err = fail(errorClass, slug, message, httpStatus);
      if (current()) negative.set(slug, { until: deps.now() + NEGATIVE_TTL_MS, err });
      return err;
    };

    let res: Response;
    try {
      // redirect:'manual' — only the Location is wanted. Following it would fetch the signed playlist from Node
      // (one more upstream request per play, from a different client than the one that will stream it).
      res = await deps.fetch(url, {
        redirect: 'manual',
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      });
    } catch (err) {
      throw failContact('dns-connect', `zlive_resolver_unreachable: ${url}: ${(err as Error).message}`);
    }
    const receivedAt = deps.now();
    try {
      await res.body?.cancel();
    } catch {
      /* ignore — the body is a one-line "Found" link */
    }
    // zlive's own clock at the moment it answered, when it said (every observed 302 carries a Date).
    const serverDate = Date.parse(res.headers.get('date') ?? '');

    if (res.status === 401 || res.status === 403 || res.status === 429) {
      // A refusal is about this IP, not this slug: every slug stops contacting zlive until the cool-down lapses.
      const retryAfterMs = parseRetryAfter(
        res.headers.get('retry-after'),
        Number.isFinite(serverDate) ? serverDate : receivedAt,
      );
      const sameBurst = coolDown !== null && genAtSend !== coolDownGen;
      const step = sameBurst ? coolDown!.step : (coolDown?.step ?? 0) + 1;
      const backoff = Math.min(REFUSAL_COOLDOWN_MAX_MS, REFUSAL_COOLDOWN_MIN_MS * 2 ** (step - 1));
      // A Retry-After past the ceiling is junk (a block page's "come back tomorrow"): ignored, not clamped.
      const honoured = retryAfterMs !== null && retryAfterMs <= RETRY_AFTER_MAX_MS ? retryAfterMs : null;
      let wait = Math.max(backoff, honoured ?? 0);
      if (current()) {
        if (!sameBurst) {
          coolDown = { since: receivedAt, until: receivedAt + wait, step, httpStatus: res.status, retryAfterMs: honoured };
          coolDownGen += 1;
        } else if (receivedAt + wait > coolDown!.until) {
          coolDown = { ...coolDown!, until: receivedAt + wait, httpStatus: res.status, retryAfterMs: honoured };
        } else {
          wait = coolDown!.until - receivedAt; // an earlier answer in this burst already asked for longer
        }
      }
      const retryNote =
        retryAfterMs === null
          ? ''
          : honoured === null
            ? ` (Retry-After ${Math.round(retryAfterMs / 1000)} s ignored — over the ${RETRY_AFTER_MAX_MS / 60_000} min ceiling)`
            : ` (Retry-After ${Math.round(retryAfterMs / 1000)} s)`;
      throw fail(
        'refusal-403',
        slug,
        `zlive_resolver_refused: HTTP ${res.status} from ${url} — not contacting zlive for any channel for ` +
          `${Math.round(wait / 1000)} s${retryNote}` +
          (step > 1 ? `, refusal ${step} in a row` : ''),
        res.status,
      );
    }
    if (res.status >= 500) {
      // Cloudflare's 52x, an origin 503…: the resolver is down, not reshaped — reported with the unreachables.
      throw failContact('dns-connect', `zlive_resolver_unavailable: HTTP ${res.status} from ${url}`, res.status);
    }
    if (res.status !== 302) {
      throw failContact('shape', `zlive_resolver_unexpected: HTTP ${res.status} from ${url} (expected a 302)`, res.status);
    }
    const location = res.headers.get('location') ?? '';
    if (!location) throw failContact('shape', 'zlive_location_rejected: 302 without a Location header', 302);

    // Shape. On-shape = zlive's signer format, any host. Off-shape = only on the last good registrable domain
    // (the format changed but the operator did not); anything else is refused, loudly.
    let host: string;
    let file: string;
    // The token's LIFETIME on zlive's own clock (signed expiry − the 302's Date; observed exactly 9000 s). Only a
    // duration crosses clocks: the expiry handed to the data plane is re-based on OUR clock below.
    let lifetimeMs: number | undefined;
    const signed = parseSignedLocation(location);
    if (signed) {
      host = signed.host;
      file = signed.file;
      const life = signed.expSec * 1000 - (Number.isFinite(serverDate) ? serverDate : receivedAt);
      if (life > 0) {
        lifetimeMs = life;
      } else if (Number.isFinite(serverDate)) {
        // Expired on zlive's OWN clock the moment it was signed (signer/edge skew): a dead link, not one of unknown
        // expiry. Reusing it would hand the data plane a 403 for as long as the cache and the fresh-request floor
        // hold it, so it is a failed contact like any other bad answer — negative-cached, the channel's failover
        // backups take over, and the next contact after the TTL asks for a new token.
        throw failContact(
          'shape',
          `zlive_token_expired: the resolver signed a playlist that had already expired by its own clock (expiry ` +
            `${isoOf(signed.expSec * 1000)}, answered at ${isoOf(serverDate)})`,
        );
      } else {
        // No Date header: the lifetime was measured on OUR clock, which may be the skewed one.
        warnThrottled(
          'expired',
          `${slug}: the resolver signed a playlist that looks expired by this server's clock (expiry ` +
            `${isoOf(signed.expSec * 1000)}; the answer carried no Date) — treating its expiry as unknown`,
          receivedAt,
        );
      }
    } else {
      let u: URL | null = null;
      try {
        u = new URL(location);
      } catch {
        /* handled below */
      }
      const shown = location.slice(0, 160);
      if (!u || u.protocol !== 'https:' || u.username || u.password) {
        throw failContact('shape', `zlive_location_rejected: not an absolute https URL: ${shown}`);
      }
      host = u.hostname.toLowerCase();
      const suffix = registrableSuffix(host);
      if (!suffix || !lastGoodSuffix || suffix !== lastGoodSuffix) {
        throw failContact(
          'shape',
          `zlive_location_rejected: off-shape Location (expected …/main/secure/<token>/<expiry>/<file>.m3u8` +
            `${lastGoodSuffix ? ` or a URL under ${lastGoodSuffix}` : ''}): ${shown}`,
        );
      }
      file = offShapeFeed(u.pathname);
      warnThrottled(
        `offshape:${suffix}`,
        `accepting an off-shape Location under ${suffix} (did the resolver's URL format change?): ${shown}`,
        deps.now(),
      );
    }

    // Decoy test BEFORE any further work on the answer: a suspected decoy is refused as it stands.
    observeAndCheckDecoy(slug, file, deps.now());
    // (On-shape only: the table records signed file names, which an off-shape feed path never equals.)
    if (signed && Object.hasOwn(ALIAS_TABLE, slug) && ALIAS_TABLE[slug] !== file && !notedRemaps.has(`${slug}:${file}`)) {
      notedRemaps.add(`${slug}:${file}`);
      logMilestone(TAG, `${slug} now resolves to ${file}.m3u8 (was ${ALIAS_TABLE[slug]}.m3u8 when the alias table was recorded)`);
    }

    // SSRF: the Location host becomes the data plane's fetch target — every address it resolves to must be public.
    // (An early refusal only — see LOCATION VETTING in the header for what it does not cover.)
    let addrs: Array<{ address: string; family: number }>;
    try {
      addrs = await deps.lookup(host);
    } catch (err) {
      throw failContact('dns-connect', `zlive_location_unresolvable: ${host}: ${(err as Error).message}`);
    }
    const bad = addrs.find((a) => !isPublicAddress(a.address));
    if (bad) {
      throw failContact('shape', `zlive_location_rejected: ${host} resolves to a non-public address (${bad.address})`);
    }

    const now = deps.now();
    const expiresAtMs = lifetimeMs !== undefined ? receivedAt + lifetimeMs : undefined;
    // Reuse until 10 min before expiry — or until a quarter of the lifetime remains, for a short token — and not at
    // all when that leaves under 5 s. An off-shape Location's expiry is unknown: a short fixed window.
    const reuseMs =
      lifetimeMs !== undefined ? lifetimeMs - Math.min(EXPIRY_MARGIN_MS, lifetimeMs / 4) : UNKNOWN_EXPIRY_REUSE_MS;
    counts.minted += 1;
    zliveAllow.allow(host);
    if (lifetimeMs !== undefined && lifetimeMs < SHORT_LIFETIME_WARN_MS) {
      warnThrottled(
        'lifetime',
        `the resolver now signs playlists for only ~${Math.max(1, Math.round(lifetimeMs / 60_000))} min (they were ` +
          `~150 min): each link is reused for ~${Math.max(0, Math.round(reuseMs / 60_000))} min, so resolver requests ` +
          'per watched channel rise accordingly',
        now,
      );
    }
    // Commit only into the deployment this request was made for: a domain switch mid-flight still hands this
    // caller its (valid) target, but must not seed the new deployment's cache or last-good suffix with it.
    if (current()) {
      const suffix = registrableSuffix(host);
      if (signed && suffix) {
        if (lastGoodSuffix && suffix !== lastGoodSuffix) {
          logger.warn(TAG, `the resolver now signs playlists on ${host} (previously under ${lastGoodSuffix})`);
        }
        lastGoodSuffix = suffix;
      }
      if (coolDown && genAtSend === coolDownGen) {
        logger.info(TAG, `the resolver is answering again — refusal backoff reset`);
        coolDown = null;
      } else if (coolDown) {
        logTrace(TAG, `${slug}: a 302 to a request sent before the current refusal — cool-down kept`);
      }
      negative.delete(slug);
      lastLocationHost = host;
      if (lifetimeMs !== undefined) lastLifetimeMs = lifetimeMs;
      lastOkAt = now;
      if (reuseMs >= MIN_REUSE_MS) {
        cache.set(slug, {
          masterUrl: location,
          file,
          host,
          expiresAtMs: expiresAtMs ?? null,
          mintedAt: receivedAt,
          reuseUntil: receivedAt + reuseMs,
        });
      }
    }
    const validity =
      lifetimeMs !== undefined
        ? `token valid ~${Math.round(lifetimeMs / 60_000)} min, reused ~${Math.round(reuseMs / 60_000)} min`
        : 'token expiry unknown';
    logMilestone(TAG, `resolved ${slug} → ${host} ${file}.m3u8 (${validity})`);
    return expiresAtMs !== undefined ? { masterUrl: location, expiresAtMs } : { masterUrl: location };
  }

  async function resolve(slug: string, opts?: ZliveResolveOptions): Promise<ZliveResolved> {
    syncEpoch();
    const now = deps.now();
    prune(now);

    // A latched decoy file: its known slugs are refused WITHOUT contacting zlive until the latch lapses.
    const seen = observations.get(slug);
    const latch = seen ? latches.get(seen.file) : undefined;
    if (latch) {
      counts.suppressed += 1;
      throw fail('decoy', slug, decoyMessage(latch));
    }

    // The data plane says the target it was given failed early — drop it, within the rate limit.
    if (opts?.fresh || opts?.advance) {
      retireCached(slug, opts.fresh ? 'the data plane reported its target failing' : 'the data plane asked for another upstream', now);
    }

    const hit = cache.get(slug);
    if (hit) {
      counts.reused += 1;
      logTrace(TAG, `reusing ${slug} → ${hit.host} ${hit.file}.m3u8 (until ${isoOf(hit.reuseUntil)})`);
      return hit.expiresAtMs !== null ? { masterUrl: hit.masterUrl, expiresAtMs: hit.expiresAtMs } : { masterUrl: hit.masterUrl };
    }

    // Refused recently (any slug), or this slug failed moments ago: answer locally, never at zlive's expense.
    if (coolingDown(now)) {
      const cd = coolDown!;
      throw suppressed(
        slug,
        new ZliveResolveError(
          'refusal-403',
          `zlive_resolver_cooling_down: the resolver refused this server (HTTP ${cd.httpStatus}) — not contacting ` +
            `zlive until ${isoOf(cd.until)}`,
          cd.httpStatus,
        ),
      );
    }
    const neg = negative.get(slug);
    if (neg) {
      throw suppressed(
        slug,
        new ZliveResolveError(neg.err.errorClass, `${neg.err.message} (not retried until ${isoOf(neg.until)})`, neg.err.httpStatus),
      );
    }

    // One resolver request per slug at a time: concurrent joins (two viewers, a viewer + an ingest renewal) share it.
    const pending = inflight.get(slug);
    if (pending) return pending;
    const p = contact(slug).finally(() => inflight.delete(slug));
    inflight.set(slug, p);
    return p;
  }

  function status(): ZliveResolverStatus {
    syncEpoch();
    const now = deps.now();
    prune(now);
    return {
      cacheSize: cache.size,
      cached: [...cache].map(([slug, c]) => ({
        slug,
        file: c.file,
        host: c.host,
        expiresAtMs: c.expiresAtMs,
        mintedAt: c.mintedAt,
        reuseUntil: c.reuseUntil,
      })),
      lastLocationHost,
      lastGoodSuffix,
      lastLifetimeMs,
      decoyLatches: [...latches.values()].map((l) => ({ ...l, slugs: [...l.slugs] })),
      coolDown: coolDown && coolDown.until > now ? { ...coolDown } : null,
      negative: [...negative].map(([slug, n]) => ({ slug, until: n.until, errorClass: n.err.errorClass })),
      lastError,
      lastOkAt,
      counts: { ...counts },
    };
  }

  return { resolve, status };
}
