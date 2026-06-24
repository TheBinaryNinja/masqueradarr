// Routes ALL global fetch() DNS resolution through the nameserver(s) configured for the app.
// Side-effect-only module: importing it installs a global undici dispatcher. It MUST be the
// very first import in index.ts so the dispatcher is in place before any module can issue a
// fetch (none does at import time today, but ordering keeps that invariant load-bearing).
//
// WHY a custom lookup (the load-bearing gotcha): dns.setServers() ONLY reconfigures the c-ares
// resolvers (dns.resolve* / new Resolver()). undici — which backs Node's global fetch() — resolves
// hostnames via dns.lookup() (getaddrinfo / the OS resolver), which IGNORES setServers() entirely.
// So to make fetch() honor a custom nameserver we hand undici a dns.lookup-SHAPED callback that is
// actually backed by a c-ares Resolver pointed at the configured server(s). Only global fetch() is
// affected; the MongoDB driver (net.connect + dns.lookup) and the ffmpeg/Chromium subprocesses keep
// the OS resolver — so a bad value can never break the (fatal-on-fail) Mongo connect at boot.
//
// CONFIG SOURCE: there is no NAMESERVER env any more. The IMPORT-TIME bootstrap (before Mongo connects)
// applies the hardcoded DEFAULT_NAMESERVERS so the very first outbound fetch already has a working
// resolver; the authoritative runtime value then lives in the `settings` singleton (nameservers +
// dnsLogLevel). settings/applyDns.ts reads that doc and calls applyDnsSettings() after connect ('mongo')
// and on every Settings PUT ('update'), so the dispatcher is re-installed live without a restart. Mongo is
// kept OUT of this module (it imports first, before connect) — the Settings read is done by applyDns.ts.
// (DEFAULT_NAMESERVERS comes from settings/translate.ts, which is side-effect-free: node:net + a type.)

import { isIP } from 'node:net';
import { Resolver } from 'node:dns';
import { setGlobalDispatcher, Agent } from 'undici';
import { logger } from './sources/core/logger.js';
import { DEFAULT_NAMESERVERS } from './settings/translate.js';

// undici's connector calls lookup(hostname, options, callback) where options carries `family`
// (0 = any, 4, 6) and `all` (true => callback gets an array of {address, family}; false => the
// classic (err, address, family) triple). We must honor both shapes precisely.
interface LookupOptions {
  family?: number;
  all?: boolean;
}
type LookupAllCb = (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void;
type LookupOneCb = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
type LookupCb = LookupAllCb | LookupOneCb;

// Module state: the servers + log level currently in force, and the per-host dedupe cache used at
// level 2 (logs a resolution only the first time a host resolves or when its result changes).
let activeServers: string[] = [];
let activeLogLevel = 2;
const lastResolved = new Map<string, string>();

function parseServers(raw: string | null | undefined): { valid: string[]; invalid: string[] } {
  if (!raw) return { valid: [], invalid: [] };
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    if (isIP(p) !== 0) valid.push(p);
    else invalid.push(p);
  }
  return { valid, invalid };
}

function installCustomLookup(servers: string[]): void {
  const resolver = new Resolver();
  resolver.setServers(servers); // c-ares honors this (unlike dns.setServers for fetch's lookup path)

  const lookup = (hostname: string, options: LookupOptions, callback: LookupCb): void => {
    const family = options.family ?? 0;
    const wantAll = options.all === true;

    const done = (err: NodeJS.ErrnoException | null, recs: { address: string; family: number }[]): void => {
      if (err) {
        // Resolver error — always surfaced (independent of log level).
        logger.error('dns', `${hostname} resolve failed: ${err.message}`);
        if (wantAll) (callback as LookupAllCb)(err, []);
        else (callback as LookupOneCb)(err, '', 0);
        return;
      }
      traceResolution(hostname, recs);
      if (wantAll) {
        (callback as LookupAllCb)(null, recs);
      } else {
        const first = recs[0];
        (callback as LookupOneCb)(null, first.address, first.family);
      }
    };

    // Hostname is already an IP literal — never hit the resolver (matches getaddrinfo semantics).
    const lit = isIP(hostname);
    if (lit !== 0) {
      done(null, [{ address: hostname, family: lit }]);
      return;
    }

    const resolve6 = (onEmpty?: () => void): void =>
      resolver.resolve6(hostname, (e, addrs) => {
        if ((e || (addrs ?? []).length === 0) && onEmpty) {
          onEmpty();
          return;
        }
        done(e ?? null, (addrs ?? []).map((address) => ({ address, family: 6 })));
      });

    if (family === 6) {
      resolve6();
    } else if (family === 4) {
      resolver.resolve4(hostname, (e, addrs) =>
        done(e ?? null, (addrs ?? []).map((address) => ({ address, family: 4 }))),
      );
    } else {
      // family 0 (default): A-first, AAAA fallback. IPv4-leaning is deliberate — most IPTV/CDN
      // upstreams are v4 and many container bridge networks have no working v6 egress.
      resolver.resolve4(hostname, (e4, a4) => {
        if (!e4 && a4 && a4.length > 0) {
          done(null, a4.map((address) => ({ address, family: 4 })));
        } else {
          // v4 empty/failed → try v6. Always warn (a fallback is a notable event), independent of level.
          logger.warn('dns', `${hostname}: A empty, trying AAAA`);
          resolve6(() => done(e4 ?? null, [])); // both empty -> surface the v4 error
        }
      });
    }
  };

  setGlobalDispatcher(new Agent({ connect: { lookup: lookup as never } }));
}

// Success traceability, gated by the active log level:
//   3 → log EVERY resolution at info.
//   2 → log at info DEDUPED (first-seen per host, or when the resolved set changes).
//   1 → suppressed (lifecycle + warn/error only).
function traceResolution(hostname: string, recs: { address: string; family: number }[]): void {
  if (activeLogLevel < 2) return;
  const family = recs[0]?.family ?? 0;
  const addrs = recs.map((r) => r.address).join(', ');
  const key = `${family}|${addrs}`;
  if (activeLogLevel === 2) {
    if (lastResolved.get(hostname) === key) return;
    lastResolved.set(hostname, key);
  }
  logger.info('dns', `${hostname} → ${addrs} (family ${family}) via ${activeServers.join(', ') || 'OS resolver'}`);
}

// (Re)install the global fetch() DNS dispatcher from a raw comma-separated nameserver string + a log
// level. Validates each server (invalid → warn + skip); with ≥1 valid server installs the custom c-ares
// lookup, otherwise resets to the default undici Agent (OS resolver). Stores the active servers/level in
// module state and emits a lifecycle info line. `source` tags where the config came from in the log.
export function applyDnsSettings(rawServers: string | null, logLevel: number, source: 'env' | 'mongo' | 'update'): void {
  const { valid, invalid } = parseServers(rawServers);
  for (const bad of invalid) {
    logger.warn('dns', `ignoring invalid nameserver '${bad}' (from ${source})`);
  }
  activeLogLevel = Math.min(3, Math.max(1, Math.trunc(logLevel) || 2));
  lastResolved.clear(); // a config change invalidates the dedupe cache

  if (valid.length > 0) {
    activeServers = valid;
    installCustomLookup(valid);
    logger.info('dns', `applied ${valid.length} nameserver(s) from ${source}: ${valid.join(', ')} (log level ${activeLogLevel})`);
  } else {
    activeServers = [];
    setGlobalDispatcher(new Agent()); // reset global fetch() resolution to the OS resolver
    logger.info('dns', `reset to OS resolver (no nameserver configured, from ${source}) (log level ${activeLogLevel})`);
  }
}

// IMPORT-TIME bootstrap: apply the hardcoded default before Mongo connects (NAMESERVER env is gone). The
// log-store sink isn't wired this early, so these lines are console-only — that's expected;
// settings/applyDns.ts re-applies from Mongo once connected (and the persisted value wins from then on,
// which on first provision is this same DEFAULT_NAMESERVERS written into the singleton by envDefaults()).
applyDnsSettings(
  DEFAULT_NAMESERVERS,
  Math.min(3, Math.max(1, Number(process.env.DNS_LOG_LEVEL) || 2)),
  'env',
);
