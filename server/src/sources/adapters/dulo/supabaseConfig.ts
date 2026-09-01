// dulo.tv Supabase config resolution + RUNTIME DISCOVERY.
//
// dulo gates Live TV behind a Supabase session that the server refreshes via the project's public
// (non-secret) `apikey` — the opaque `sb_publishable_…` key baked into dulo's own frontend bundle. The
// gotcha: **dulo periodically MIGRATES its entire Supabase project**, rotating BOTH the project ref (URL)
// and the publishable key together. Every stored session then fails the apikey gate with
// 401 "Invalid API key … owned by another Supabase project" — even though its refresh token is still good
// (the grant isn't even evaluated). Previously the correct values were a committed constant that a human
// had to re-scrape and re-deploy (or override via env), which put dulo's identity into infra config.
//
// This module removes that manual step: when a refresh 401s at the key gate, auth.ts calls
// discoverSupabaseConfig(), which reads dulo's CURRENT config straight from its live frontend bundle
// (fetch homepage → find /assets/index-<hash>.js → grep the `sb_publishable_…` key + `<ref>.supabase.co`
// URL — exactly what a browser's supabase-js client is initialised with). The site it scrapes is the
// OPERATOR-CONFIGURED domain (./config.ts getOrigin()), read at use time, so a dulo rebrand redirects
// discovery too; changing that setting calls resetSupabaseDiscovery() to drop the old project's cache.
// The discovered pair is cached
// in-process and persisted onto the session doc by the caller, so a dulo migration self-heals with no
// human action and no dulo-specific values in docker-compose / .env.
//
// Resolution order (never returns null — refresh always has an apikey): the key captured WITH the session
// (streamed-login network intercept) → the runtime-discovered value → the committed offline SEED below.

import { logger } from '../../core/logger.js';
import { getOrigin, UA } from './config.js';

const tag = 'dulo:auth';

// Committed OFFLINE SEED — dulo's public Supabase config as last verified (2026-07-22). This is only the
// last-resort fallback (same role as each adapter's committed *.snapshot.json): discoverSupabaseConfig()
// supersedes it at runtime. Bump it only if discovery is ever blocked (bot-gate) AND dulo has migrated —
// re-scrape from <configured dulo domain>/assets/index-*.js. NOTE this is the Supabase PROJECT seed, and
// is independent of Settings.duloDomain (dulo can rebrand without migrating its Supabase project).
const SEED_SUPABASE_URL = 'https://wsudbodtjjfenprwsagd.supabase.co';
const SEED_ANON_KEY = 'sb_publishable_521pnlSRNoR0xpBn6uiuHw_f78kT63_';

// Discovery is REACTIVE (only fired by auth.ts on a key-gate 401) and cooldown-gated so a burst of failed
// refreshes can't hammer dulo's site. Mirrors the dlhd mirrorDirectory reprobe-cooldown idiom.
const DISCOVERY_COOLDOWN_MS = Number(process.env.DULO_DISCOVERY_COOLDOWN_MS || 300_000); // 5 min
const DISCOVERY_MAX_BUNDLES = 6; // scan at most this many /assets/*.js chunks per attempt
const DISCOVERY_FETCH_TIMEOUT_MS = 10_000; // per-request abort so discovery can't hang a refresh

// Bot-gate-friendly headers for the scrape (dulo checks these on its API; harmless on static assets).
// A function, not a const: the Origin/Referer must follow the configured domain at USE time. The Referer
// is the site ROOT here (the homepage is what we fetch), not the /live page browserHeaders() implies.
function discoveryHeaders(origin: string): Record<string, string> {
  return { 'User-Agent': UA, Origin: origin, Referer: `${origin}/` };
}

export interface SupabaseConfig {
  supabaseUrl: string;
  anonKey: string;
}

// Process-lifetime cache of the last successfully discovered config. Seeded on the first discovery hit;
// wins over SEED but not over a value captured with the session. Lost on restart → re-discovered on the
// next key-gate 401 (the corrected key is also persisted per-session by the caller, so the singleton
// session survives a restart without needing re-discovery).
let discovered: SupabaseConfig | null = null;
let lastDiscoveryAt = 0;

// The anon key to present, most-trusted first: captured-with-session → runtime-discovered → committed seed.
export function currentAnonKey(captured?: string | null): string {
  return captured || discovered?.anonKey || SEED_ANON_KEY;
}

// The Supabase project URL fallback used when a session's JWT carries no derivable issuer (rare).
export function currentSupabaseUrl(): string {
  return discovered?.supabaseUrl || SEED_SUPABASE_URL;
}

// Drop the discovered pair AND the cooldown. Called when the operator changes Settings.duloDomain
// (settings/applyDuloDomain.ts): the cached config was scraped from the OLD site and may belong to a
// decommissioned project, and the cooldown would otherwise suppress a re-scrape for up to
// DISCOVERY_COOLDOWN_MS. After this, the next key-gate 401 rediscovers against the new domain.
export function resetSupabaseDiscovery(): void {
  discovered = null;
  lastDiscoveryAt = 0;
}

async function fetchText(url: string, origin: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DISCOVERY_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: discoveryHeaders(origin), signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

const KEY_RE = /sb_publishable_[A-Za-z0-9_-]+/;
const URL_RE = /https:\/\/[a-z0-9]{20}\.supabase\.co/; // supabase project refs are 20-char lowercase alnum

// The scrape itself, against an ARBITRARY origin: fetch that site's frontend and extract the Supabase
// project URL + publishable anon key its supabase-js client is initialised with. PURE — it touches neither
// the cache nor the cooldown, so the Settings "Test domain" probe can run it against a candidate domain
// without poisoning the active session's config. Best effort: returns null and never throws.
export async function scrapeSupabaseConfig(origin: string): Promise<SupabaseConfig | null> {
  try {
    // The homepage is a tiny SPA shell that lists the content-hashed bundle URLs. Parse it each time so a
    // dulo redeploy (which changes the hash) is handled automatically; try the `index-*` chunk first (that
    // is where the supabase client is initialised today), then any remaining chunk.
    const html = await fetchText(origin, origin);
    const assets = [...new Set([...html.matchAll(/\/assets\/[A-Za-z0-9._-]+\.js/g)].map((m) => m[0]))];
    const ordered = [...assets.filter((a) => a.includes('index-')), ...assets.filter((a) => !a.includes('index-'))];
    if (!ordered.length) {
      logger.warn(tag, `supabase discovery: no /assets/*.js bundles found on ${origin}`);
      return null;
    }
    for (const path of ordered.slice(0, DISCOVERY_MAX_BUNDLES)) {
      const js = await fetchText(`${origin}${path}`, origin).catch(() => '');
      const anonKey = js.match(KEY_RE)?.[0];
      const supabaseUrl = js.match(URL_RE)?.[0];
      if (anonKey && supabaseUrl) return { supabaseUrl, anonKey };
    }
    logger.warn(tag, `supabase discovery: no sb_publishable_ key found in ${origin} bundles`);
    return null;
  } catch (err) {
    logger.warn(tag, `supabase discovery failed for ${origin}: ${(err as Error).message}`);
    return null;
  }
}

// The CACHING wrapper around the scrape, aimed at the currently configured dulo domain. Returns the
// freshly-discovered pair, or the last cached one (possibly null) on any failure — never throws.
// Cooldown-gated unless opts.force.
export async function discoverSupabaseConfig(opts?: { force?: boolean }): Promise<SupabaseConfig | null> {
  if (!opts?.force && lastDiscoveryAt && Date.now() - lastDiscoveryAt < DISCOVERY_COOLDOWN_MS) {
    return discovered;
  }
  lastDiscoveryAt = Date.now();
  const found = await scrapeSupabaseConfig(getOrigin());
  if (!found) return discovered;
  const changed = !discovered || discovered.anonKey !== found.anonKey || discovered.supabaseUrl !== found.supabaseUrl;
  discovered = found;
  if (changed) logger.ok(tag, `discovered current dulo supabase config (${found.supabaseUrl})`);
  return discovered;
}
