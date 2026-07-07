// The authoritative CURRENT proxy-engine log level (the global `settings.logLevel`, 1|2|3), held in a tiny
// module singleton so it can be read synchronously in two hot spots that must not touch Mongo:
//   · sidecar.ts spawnOnce() — stamps MASQ_LOG_LEVEL into the child env at spawn (the sidecar's INITIAL level).
//   · routes/internal.ts — echoes it in every /api/internal/{telemetry,log} response so the Rust flushers
//     learn a live level change within one flush cycle (no sidecar restart; see proxy/src/log.rs).
//
// Seeded at boot from the persisted singleton (settings/applyDns.ts, source 'mongo') and updated on every
// Settings PUT that changes logLevel (routes/settings.ts) — the same two call sites that drive dns.ts. Kept
// deliberately Mongo-free (a plain number) so the internal seam can read it with zero latency on the byte path.

let level = 2; // default matches SettingsDoc.logLevel + envDefaults(); overwritten by the boot seed

/** Clamp + store the current global log level (1..3). Called from the boot seed and each Settings PUT. */
export function setProxyLogLevel(n: number): void {
  level = Math.min(3, Math.max(1, Math.trunc(n) || 2));
}

/** The current global log level (1..3) — read by the sidecar spawn env + the internal seam's echo-back. */
export function getProxyLogLevel(): number {
  return level;
}
