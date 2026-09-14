// The authoritative CURRENT upstream nameserver list for the Rust data plane (the global `settings.nameservers`,
// reduced to exactly the IP list dns.ts applies), held in a tiny module singleton — the proxy/logLevel.ts
// pattern — so it can be read synchronously in the same two hot spots that must not touch Mongo:
//   · sidecar.ts spawnOnce() — stamps MASQ_NAMESERVERS into the child env at spawn (the sidecar's INITIAL
//     resolver; '' = the OS resolver).
//   · routes/internal.ts — echoes it in every /api/internal/{telemetry,log} response so the Rust data plane
//     retargets its upstream resolver within one flush cycle (no sidecar restart).
//
// ONE setting, TWO resolvers: Node's outbound fetch() (dns.ts) and Rust's upstream fetches must go through the
// SAME servers — the operator sets DNS once on the Settings screen and expects it to govern the whole app, and
// a channel's resolve hop (Node) and its media hops (Rust) landing on different answers is a miserable thing to
// debug. So the value held here is never the raw Settings string: it is normalised by the rule dns.ts's
// parseServers() applies (comma split, trim, blanks dropped, non-IP entries dropped — silently here, dns.ts
// already warns about each once), and it is null exactly when that leaves nothing, i.e. exactly when dns.ts
// resets to the OS resolver. The PUT validator (settings/translate.ts) already refuses a bad entry, so the drop
// only bites on a hand-edited doc or a restored backup — but when it does, Node and Rust drop the same entries.
// The resolution SEMANTICS (custom servers, OS-resolver fallback on ANY failure, IP literals bypass, A then
// AAAA) are mirrored on the Rust side of MASQ_NAMESERVERS; this module only carries the list.
//
// Seeded at boot from the persisted singleton (settings/applyDns.ts, source 'mongo') and updated on every
// Settings PUT or backup restore that re-applies DNS — the same call sites that drive dns.ts and logLevel.ts.
// Kept deliberately Mongo-free (a plain string) so the internal seam reads it with zero latency.

import { isIP } from 'node:net';
import { DEFAULT_NAMESERVERS } from '../settings/translate.js';

// dns.ts parseServers(), valid half — keep the two in lockstep (a drift here is exactly the split-resolver bug
// this module exists to prevent). Joined back with ',' so the wire value is the canonical comma list.
function normalize(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const valid = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isIP(s) !== 0);
  return valid.length > 0 ? valid.join(',') : null;
}

// Default mirrors dns.ts's IMPORT-TIME bootstrap (DEFAULT_NAMESERVERS, applied before Mongo connects), so if the
// boot seed never runs — a failed Settings read leaves dns.ts on that same default — the sidecar still spawns in
// lockstep with Node's fetch() rather than on the OS resolver.
let servers: string | null = normalize(DEFAULT_NAMESERVERS);

/** Normalise + store the current nameserver list (raw Settings value in). Called from the boot seed and each re-apply. */
export function setProxyNameservers(raw: string | null | undefined): void {
  servers = normalize(raw);
}

/** The validated comma-separated IP list in force, or null for the OS resolver — read by the spawn env + seam echo. */
export function getProxyNameservers(): string | null {
  return servers;
}
