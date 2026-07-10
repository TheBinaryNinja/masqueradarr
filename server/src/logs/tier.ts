// Tier-gated logging against the GLOBAL 1|2|3 log verbosity (settings.logLevel, held live in
// proxy/logLevel.ts). The source-agnostic core logger (sources/core/logger.ts) deliberately never reads
// the level — it's DB-free and product-agnostic, and always console-prints + forwards. So callers that
// want the 2/3 verbosity tiers gate HERE, the same way dns.ts gates its per-host resolution chatter and
// the Rust engine gates each log:: line. This lives in the logs subsystem (which already bridges the core
// logger ↔ product concerns via categories.ts/logStore.ts), so importing the level holder is in-layer.
//
// The tier ladder mirrors settings.logLevel exactly:
//   1 = lifecycle + issues only  → warn/error, ALWAYS emitted (call logger.warn/error directly, ungated).
//   2 = + milestones             → logMilestone (info, gated at ≥2): notable state changes an operator
//                                   watches (a failover group created/reordered/disbanded, a backup served).
//   3 = + full lineage           → logTrace (info, gated at 3): per-step detail (EPG cascades, reconcile
//                                   tallies, per-candidate attempts) that's noise at the default level.
//
// Strings are built eagerly (as everywhere else in the Node code) rather than via a closure — the paths
// that use these are per-establish/per-mutation, never the per-segment byte hot path, so the interpolation
// cost on a suppressed line is negligible.

import { logger, type LogOpts } from '../sources/core/logger.js';
import { getProxyLogLevel } from '../proxy/logLevel.js';

/** Milestone (info) — emitted at log level ≥ 2. Suppressed at level 1 (issues-only). */
export function logMilestone(tag: string, msg: string, opts?: LogOpts): void {
  if (getProxyLogLevel() >= 2) logger.info(tag, msg, opts);
}

/** Full-lineage detail (info) — emitted only at log level 3. Suppressed at levels 1 and 2. */
export function logTrace(tag: string, msg: string, opts?: LogOpts): void {
  if (getProxyLogLevel() >= 3) logger.info(tag, msg, opts);
}
