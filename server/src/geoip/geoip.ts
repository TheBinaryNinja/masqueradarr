// GeoIP resolution via the MaxMind GeoLite2 City *web service*. The client IP captured by the HLS proxy
// (req.ip — trust-proxy aware, so X-Forwarded-For resolves behind the edge gateway) is already threaded
// through the telemetry core and persisted on every ViewSession; this module turns that IP into a
// human "City, Region, Country" label for the Active Streams + History/Metrics screens.
//
// Design (matches the subsystem rules):
//   - Disabled by default. With no account id / license key configured on the Settings singleton,
//     resolveGeo() returns null and every caller renders an em-dash — no outbound calls are made.
//   - Minimal DB touch. The only Mongo read is the MaxMind credentials off the Settings singleton,
//     memoized in-module (~60s). No per-source branching; no new npm dependency (Node global fetch +
//     Buffer base64).
//   - Cheap + rate-limit-safe. Private/loopback IPs short-circuit with no network call; every result is
//     cached per-IP (positive 24h, negative 10min) so repeated polls + repeat viewers never re-query
//     MaxMind. The free GeoLite2 web service is daily-rate-limited; per-IP caching keeps us well under.

import { logger } from '../sources/core/logger.js';
import { Settings, SETTINGS_ID } from '../models/Settings.js';

const tag = 'geoip';
const ENDPOINT = 'https://geolite.info/geoip/v2.1/city';
const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const CREDS_TTL_MS = 60 * 1000;
const CACHE_MAX = 5000;

export interface GeoResult {
  location: string; // "City, Region, US" (missing parts omitted), or "Local" for private/loopback IPs
  countryCode: string | null; // ISO-3166-1 alpha-2, for the flag emoji (null when unknown/local)
}

interface CacheEntry {
  value: GeoResult | null; // null = a negative result (lookup failed) — short-TTL cached so we don't hammer
  expires: number;
}
const cache = new Map<string, CacheEntry>();

interface Creds {
  accountId: string;
  licenseKey: string;
}
let credsCache: { value: Creds | null; expires: number } | null = null;

// MaxMind credentials live on the Settings singleton (set via the Settings screen). Read directly (not via
// the redacting translate.ts projection, which hides the key from the SPA) and memoize briefly.
async function getCreds(): Promise<Creds | null> {
  const now = Date.now();
  if (credsCache && credsCache.expires > now) return credsCache.value;
  let value: Creds | null = null;
  try {
    const doc = await Settings.findOne(
      { _id: SETTINGS_ID },
      { maxmindAccountId: 1, maxmindLicenseKey: 1 },
    ).lean();
    const accountId = doc?.maxmindAccountId?.trim();
    const licenseKey = doc?.maxmindLicenseKey?.trim();
    if (accountId && licenseKey) value = { accountId, licenseKey };
  } catch {
    value = null; // settings unreadable → treat the feature as disabled
  }
  credsCache = { value, expires: now + CREDS_TTL_MS };
  return value;
}

// Express trust-proxy may yield an IPv4-mapped IPv6 address (::ffff:1.2.3.4) — unwrap to the dotted-quad.
function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

// Loopback / RFC-1918 / link-local / IPv6 ULA — never worth a lookup (and a privacy/SSRF non-starter).
function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  if (ip === '::1' || ip.startsWith('127.') || ip.startsWith('169.254.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true; // 172.16.0.0 – 172.31.255.255
  }
  const lower = ip.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true; // IPv6 ULA + link-local
  return false;
}

// Just the slice of the GeoLite2 City response we use.
interface MaxMindCity {
  city?: { names?: Record<string, string> };
  subdivisions?: { iso_code?: string; names?: Record<string, string> }[];
  country?: { iso_code?: string; names?: Record<string, string> };
}

function buildResult(body: MaxMindCity): GeoResult {
  const city = body.city?.names?.en;
  const region = body.subdivisions?.[0]?.iso_code ?? body.subdivisions?.[0]?.names?.en;
  const country = body.country?.iso_code ?? body.country?.names?.en;
  const parts = [city, region, country].filter((p): p is string => !!p);
  return {
    location: parts.length ? parts.join(', ') : 'Unknown',
    countryCode: body.country?.iso_code ?? null,
  };
}

/**
 * Resolve a client IP to a geolocation label. Returns null when geo is disabled (no key) or the lookup
 * fails; returns { location: 'Local' } for private/loopback IPs. Cached per-IP; safe to call on every poll.
 */
export async function resolveGeo(ipRaw: string): Promise<GeoResult | null> {
  const ip = normalizeIp((ipRaw ?? '').trim());
  if (isPrivateIp(ip)) return { location: 'Local', countryCode: null };

  const now = Date.now();
  const hit = cache.get(ip);
  if (hit && hit.expires > now) return hit.value;

  const creds = await getCreds();
  if (!creds) return null; // feature disabled — don't cache, so adding a key works on the next poll

  let value: GeoResult | null = null;
  let ttl = NEGATIVE_TTL_MS;
  try {
    const auth = Buffer.from(`${creds.accountId}:${creds.licenseKey}`).toString('base64');
    const res = await fetch(`${ENDPOINT}/${encodeURIComponent(ip)}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (res.ok) {
      value = buildResult((await res.json()) as MaxMindCity);
      ttl = POSITIVE_TTL_MS;
    } else {
      // 401/403 bad creds, 404 ip-not-found, 429 over-quota, 5xx — negative-cache + log.
      logger.warn(tag, `lookup ${ip} failed: ${res.status}`);
    }
  } catch (err) {
    logger.warn(tag, `lookup ${ip} error: ${(err as Error).message}`);
  }

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value; // Map preserves insertion order — drop the eldest
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(ip, { value, expires: now + ttl });
  return value;
}
