// config.ts — the single place that knows where the dlhd content mirror lives. Ported from
// ../d-combine/sources/dlhd/config.mjs.
//
// dlhd is only a MIRROR and the domain rotates. The active base is NOT a static const: it is resolved at
// runtime (see ./mirrorDirectory.ts, which reads DaddyLive's directory site, probes the advertised
// mirrors, and calls setBase() with the best one). Everything that points at the mirror reads it through
// getBase()/getReferer()/getMirrorHost() at USE time — never captured at import — so a setBase() hop is
// honored everywhere instantly. Manual override wins: env DLHD_BASE pins a base and skips the directory.
//
// The rotating DOWNSTREAM hosts (player domain, CDN, segment host) are NOT hardcoded into the flow — they
// are discovered at runtime by the resolver (./resolveStream.ts) and the proxy. UPSTREAM_ALLOW below is
// only the SSRF allowlist seed; the proxy auto-extends it at runtime with every host it sees inside a
// resolved playlist, and setBase() keeps the mirror host in it.

function cleanBase(u: string): string {
  return String(u || '').trim().replace(/\/+$/, ''); // strip trailing slash(es)
}

// The active content-mirror base. Initial default matches the historical static value; a runtime resolve
// (or env DLHD_BASE) replaces it via setBase(). Read it only through getBase().
let _base = cleanBase(process.env.DLHD_BASE || 'https://dlhd.pk');

/** The active mirror base, e.g. "https://dlhd.pk". Always read at use time. */
export function getBase(): string {
  return _base;
}

/** The Referer the mirror's player chain expects (stream-N.php / daddy<n>.php gate on it). */
export function getReferer(): string {
  return `${_base}/`;
}

/** The hostname of the active mirror, e.g. "dlhd.pk". */
export function getMirrorHost(): string {
  try {
    return new URL(_base).hostname;
  } catch {
    return 'dlhd.pk';
  }
}

/** Switch the active mirror (called by mirrorDirectory after probing). Keeps the SSRF allowlist in sync so
 * the new mirror host is immediately proxyable. Returns the committed base. */
export function setBase(url: string): string {
  const next = cleanBase(url);
  if (!next) return _base;
  _base = next;
  UPSTREAM_ALLOW.add(getMirrorHost().toLowerCase());
  return _base;
}

// A normal desktop-browser User-Agent — the mirror + ad layer reject obvious bots.
export const UA =
  process.env.DLHD_UA ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// SSRF allowlist for the stream proxy: registrable domains we permit fetching as upstream stream hosts.
// Seeded with the currently-known rotating dlhd domains; override/extend with env
// DLHD_UPSTREAM_ALLOW="a.top,b.shop". The mirror's own host is always allowed (added below + on every
// setBase() hop), and the proxy adds child hosts it discovers in playlists at runtime.
const DEFAULT_UPSTREAM_ALLOW = [
  'phantemlis.top', // CDN: master/variant playlists       (rotates)
  'jimpenopisonline.online', // player domain: daddy3.php   (rotates)
  'zampikakis.shop', // segment host: /ingest/<uuid>        (rotates)
  'cdn-lab.shop', // P2P announce/signaling                 (rotates)
];

export const UPSTREAM_ALLOW = new Set<string>(
  [
    getMirrorHost(),
    ...DEFAULT_UPSTREAM_ALLOW,
    ...String(process.env.DLHD_UPSTREAM_ALLOW || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ].map((h) => h.toLowerCase()),
);

/** True if `hostname` is, or is a subdomain of, any allowlisted registrable domain. */
export function isAllowedHost(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase();
  for (const dom of UPSTREAM_ALLOW) {
    if (h === dom || h.endsWith(`.${dom}`)) return true;
  }
  return false;
}

/** Register a host discovered at runtime (e.g. a CDN host seen inside a resolved playlist). */
export function allowHost(hostname: string): void {
  const h = String(hostname || '').toLowerCase();
  if (h) UPSTREAM_ALLOW.add(h);
}

// ── Private-IP / loopback guard (SSRF defense-in-depth, Masqueradarr addition over the PoC) ──────────────────
// The dynamic allowlist trusts hosts learned from resolved playlists; belt-and-suspenders, never let a
// literal private / loopback / link-local target through. The implementation now lives in the shared
// sources/core/ssrf.ts (the `direct` import adapter reuses it); re-exported here so dlhd's callers are
// unchanged.
export { isPrivateHost } from '../../core/ssrf.js';

// The (rotating) player origin discovered by the last resolve, e.g. https://donis.jimpenopisonline.online/.
// The CDN/segment hosts saw this as the browser Referer, so the proxy replays it on those hops. Falls back
// lazily to the current mirror referer until the first resolve runs (lazy so a setBase() hop reflects too).
let _playerReferer: string | null = null;
export function setPlayerOrigin(originOrUrl: string): void {
  try {
    _playerReferer = `${new URL(originOrUrl).origin}/`;
  } catch {
    /* ignore malformed */
  }
}
export function playerReferer(): string {
  return _playerReferer || getReferer();
}
