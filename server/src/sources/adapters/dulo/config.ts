// config.ts — the single place that knows which domain dulo is on today. Mirrors adapters/dlhd/config.ts.
//
// dulo periodically REBRANDS onto a new domain. Previously `dulo.tv` was a compile-time const repeated in
// five files, so a rebrand broke the catalog fetch, the playback-session mint, the Supabase bundle scrape,
// the pairing bookmarklet and the streamed login all at once — and the only fix was a code change plus a
// redeploy. The active domain is now an OPERATOR SETTING (`dulo.domain` in the playlist configuration,
// edited on Settings -> Advanced -> Playlist Domain / Configuration) cached here at module level.
//
// Everything that points at dulo reads it through the getters below at USE time — never captured at
// import — so a setDomain() hop is honored everywhere instantly. The module-level cache (rather than a
// per-call Mongo read) is REQUIRED, not an optimization: SourceAdapter.upstreamHeaders() and
// isAllowedUpstream() are synchronous and sit on the hot proxy path, so they cannot await the DB.
//
// This is a Mongo-FREE leaf — it must never import the models layer. The Settings bridge lives in
// settings/applyPlaylistConfig.ts (the one bridge for every operator-set source domain).

import { createDynamicAllow, type DynamicAllow } from '../_fast/dynamicAllow.js';
import { normalizeDomain as normalizeSourceDomain, type DomainParse } from '../../core/domain.js';

/** The committed default — dulo's domain as last known (dulo.tv stopped resolving). Also the playlist config default. */
export const DULO_DEFAULT_DOMAIN = 'dulo.gd';

// The active dulo domain, as a bare lowercase host (no scheme, no path, no port). Read it only through
// the getters; write it only through setDomain().
let _domain = DULO_DEFAULT_DOMAIN;

/** The active domain, e.g. "dulo.tv". Always read at use time. */
export function getDomain(): string {
  return _domain;
}

// The `*For(domain)` variants below exist so the Settings "Test" probe can hit a CANDIDATE domain that is
// not (yet) the active one, without duplicating dulo's URL shapes in the route layer. The no-argument
// getters are these bound to the active domain.

/** The origin for an arbitrary dulo domain, e.g. "https://dulo.tv". */
export function originFor(domain: string): string {
  return `https://${domain}`;
}

/** The metadata-only Live TV catalog endpoint for an arbitrary domain (no auth — streams mint per play). */
export function catalogUrlFor(domain: string): string {
  return `${originFor(domain)}/api/live-tv/channels`;
}

/** The active origin, e.g. "https://dulo.tv". */
export function getOrigin(): string {
  return originFor(_domain);
}

/** dulo's REST base, e.g. "https://dulo.tv/api" (live-tv/activate-device, live-tv/playback-session). */
export function getApiBase(): string {
  return `${getOrigin()}/api`;
}

/** The metadata-only Live TV catalog endpoint (no auth — the stream is minted per play). */
export function getCatalogUrl(): string {
  return catalogUrlFor(_domain);
}

/** The Referer dulo's API + memfs/proxy hosts expect (they gate on Origin/Referer). */
export function getReferer(): string {
  return `${getOrigin()}/live`;
}

/** dulo's sign-in page — the URL the streamed-login Chromium lands on. */
export function getLoginUrl(): string {
  return `${getOrigin()}/login`;
}

/** dulo's Live TV page — navigated to after sign-in to provoke the client's activate-device call. */
export function getLiveUrl(): string {
  return `${getOrigin()}/live`;
}

// A normal desktop-browser User-Agent — dulo is bot-gated. Single source of truth for every dulo hop
// (the adapter, the auth calls and the Supabase discovery scrape each used to carry their own copy, and
// two of them had drifted to different Chrome majors). A per-session captured UA overrides it.
export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Browser-like headers for an arbitrary dulo origin (candidate probing). */
export function browserHeadersFor(
  origin: string,
  ua?: string | null,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { 'User-Agent': ua || UA, Origin: origin, Referer: `${origin}/live`, ...extra };
}

/** Browser-like headers for any dulo hop. `ua` is the session's captured UA when there is one. */
export function browserHeaders(
  ua?: string | null,
  extra: Record<string, string> = {},
): Record<string, string> {
  return browserHeadersFor(getOrigin(), ua, extra);
}

// ── SSRF allow-set ────────────────────────────────────────────────────────────────────────────────────
// The shared per-source dynamic allow-set (adapters/_fast/dynamicAllow.ts): seeded with the active domain
// (exact-or-subdomain match, so *.dulo.tv is covered), grown at runtime with every host seen inside a
// playlist we legitimately resolved, and always blocking private/loopback targets. setDomain() folds the
// new apex in, exactly as dlhd's setBase() does with UPSTREAM_ALLOW.
//
// NOTE: SourceAdapter.isAllowedUpstream/onPlaylistChildHost are currently called by nothing in the Node
// tree — the live gate is Rust-side (proxy/src/proxy.rs ssrf_ok, seeded from the resolve grant's target).
// This keeps the contract honest and correct for the day it is re-wired; it is not the gate that runs
// today. The guard that DOES run on user input is normalizeDomain() below.
export const duloAllow: DynamicAllow = createDynamicAllow([
  DULO_DEFAULT_DOMAIN,
  ...(process.env.DULO_EXTRA_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
]);

/**
 * Normalize an operator-typed domain into a bare lowercase host.
 *
 * Accepts "dulo.tv", "https://Dulo.TV/", "HTTPS://dulo.tv/live?x=1" — scheme, path, query, userinfo and
 * port are all stripped. Rejects IP literals and private/loopback targets: the playlist-config Test
 * endpoint (routes/sources.ts) server-side-fetches whatever comes back from here, so this is a real SSRF
 * boundary, not cosmetic validation. The rules themselves live in the shared core/domain.ts (every
 * operator-set source domain runs the same gate); this binds dulo's name into the one source-specific
 * message, so the error text is what it has always been.
 */
export function normalizeDomain(raw: string): DomainParse {
  return normalizeSourceDomain(raw, 'dulo');
}

/**
 * Switch the active dulo domain. Keeps the SSRF allow-set in sync so the new apex is immediately
 * proxyable. Called at boot, on every playlist-config save and after a restore
 * (settings/applyPlaylistConfig.ts). Returns true when the value actually CHANGED — the caller uses that to
 * decide whether to reset Supabase discovery and force a re-authentication.
 */
export function setDomain(next: string): boolean {
  const parsed = normalizeDomain(next);
  if (!parsed.ok) return false;
  const changed = parsed.domain !== _domain;
  _domain = parsed.domain;
  duloAllow.allow(_domain);
  return changed;
}
