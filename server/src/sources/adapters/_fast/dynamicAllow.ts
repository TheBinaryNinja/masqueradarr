// dynamicAllow — a per-source SSRF allow-set for the FAST-source family. The generalized, NON-shared port of
// dlhd's allowlist (adapters/dlhd/config.ts UPSTREAM_ALLOW / isAllowedHost / allowHost): a Set seeded with a
// source's known CDN domain suffixes that the source GROWS at runtime — `allow()` for a host learned by
// resolveStream (the resolved master CDN), `onPlaylistChildHost()` for a host seen inside a resolved playlist.
// Each FAST source gets its OWN instance (no shared module state, unlike dlhd↔dami which intentionally share an
// upstream). Private/loopback/link-local targets are ALWAYS blocked via the shared core/ssrf.ts guard — the
// dynamic set only ever widens to public CDN hosts.

import { isPrivateHost } from '../../core/ssrf.js';

export interface DynamicAllow {
  /** SSRF gate for a direct proxy hop: http(s) + not a private host + a suffix-match of the runtime set. */
  isAllowedUpstream(url: string): boolean;
  /** Learn a child host seen inside a resolved playlist (the proxy's per-rewritten-child hook). */
  onPlaylistChildHost(host: string): void;
  /** Learn a host from elsewhere (e.g. resolveStream's resolved master CDN). */
  allow(host: string): void;
}

export function createDynamicAllow(staticSuffixes: string[]): DynamicAllow {
  const allowed = new Set<string>(
    (staticSuffixes || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean),
  );

  const allow = (host: string): void => {
    const h = String(host || '').trim().toLowerCase();
    if (h) allowed.add(h);
  };

  // True if `hostname` is, or is a subdomain of, any allowlisted registrable domain (same test as dlhd's).
  const isAllowedHost = (hostname: string): boolean => {
    const h = String(hostname || '').toLowerCase();
    for (const dom of allowed) {
      if (h === dom || h.endsWith(`.${dom}`)) return true;
    }
    return false;
  };

  return {
    isAllowedUpstream(url: string): boolean {
      try {
        const u = new URL(url);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
        if (isPrivateHost(u.hostname)) return false; // SSRF: never proxy a private/loopback/link-local target
        return isAllowedHost(u.hostname);
      } catch {
        return false;
      }
    },
    onPlaylistChildHost(host: string): void {
      allow(host);
    },
    allow,
  };
}
