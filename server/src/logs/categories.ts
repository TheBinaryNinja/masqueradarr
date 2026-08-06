// The tag → category map + the resolver, plus the canonical category list (the route validator's copy; the
// SPA keeps its own copy in src/data.ts). This lives in the logs subsystem — NOT in the source-agnostic core
// — so the core never couples to product categories. Existing logger.* calls pass a TAG ('mongo',
// 'dulo:stream', …); the category is DERIVED here, so the overwhelming majority of call sites need zero
// change. (This previously pointed at `.claude/skills/logs/SKILL.md`, which is not in the repo — the map
// below IS the reference; add a tag here and its category resolves everywhere.)

import type { LogCategory } from '../models/Log.js';

export const LOG_CATEGORIES: LogCategory[] = [
  'dashboard', 'active', 'playlists', 'epg-sources', 'mapping', 'history',
  'users', 'import', 'settings', 'api', 'core', 'mongodb', 'proxy', 'failover',
];

export const TAG_CATEGORY: Record<string, LogCategory> = {
  mongo: 'mongodb', db: 'mongodb',
  startup: 'core', shutdown: 'core', boot: 'core', scheduler: 'core', dns: 'core',
  http: 'api', api: 'api',
  seed: 'playlists', sources: 'playlists', sync: 'playlists', m3u: 'playlists', compose: 'playlists',
  playlists: 'playlists',
  dulo: 'playlists', 'dulo:stream': 'playlists', dlhd: 'playlists', 'dlhd:stream': 'playlists', tubi: 'playlists',
  local: 'playlists',
  build: 'playlists',
  stats: 'active', telemetry: 'active', geoip: 'active',
  // The Rust video DATA PLANE (masq-proxy) + its Node-side supervisor/relay/resolve seam log under the
  // dedicated `proxy` category — the byte engine that resolves→fetches→repackages→serves a stream. Distinct
  // from `active` (the viewer/telemetry cores above) so the engine's full-lineage trace is filterable on its
  // own. The Rust log seam (POST /api/internal/log → logStore.ingestExternalLog) tags every line one of these.
  proxy: 'proxy', stream: 'proxy', tsmux: 'proxy', edge: 'proxy', probe: 'proxy', resolve: 'proxy',
  // S3/ORIGIN two-sided split. `iop` = INPUT operations (Side-1: the per-channel ingest — resolve, playlist
  // poll, segment fetch, decrypt, ring push/evict, stall, failover). `oop` = OUTPUT operations (Side-2: the
  // manifest/TS renderers serving clients from the ring). They live in the same `proxy` category as the rest
  // of the data plane — the point of the split is attribution WITHIN the engine, not a separate UI bucket:
  // once one ingest feeds N viewers, ingress and egress are independent, so "the channel is stuttering" has
  // two possible causes and the tag says which. The resolver's namespace-prefix fallback (below) means any
  // future `iop:*` / `oop:*` sub-tag resolves through these entries without another edit here.
  iop: 'proxy', oop: 'proxy',
  // Failover groups (parent + ordered child backups): the admin group routes + reconcile/cascade service +
  // the Node resolve seam AND the Rust data-plane failover walk all log under `failover` — a cross-boundary
  // tag (Node and Rust both emit it) with its own UI category, so the whole fail-over story is filterable on
  // its own rather than buried in `playlists`/`proxy`. The prefix fallback covers any `failover:*` variant.
  failover: 'failover',
  epg: 'epg-sources', xmltv: 'epg-sources', gracenote: 'epg-sources', epgpw: 'epg-sources',
  auth: 'users', users: 'users',
  mapping: 'mapping', import: 'import', settings: 'settings', history: 'history', dashboard: 'dashboard',
};

// Resolve a tag to a category: exact match → namespace prefix (split(':')[0], so 'dulo:stream' →
// 'dulo' → 'playlists' without enumerating every variant) → the 'core' default.
export function categoryForTag(tag: string): LogCategory {
  return TAG_CATEGORY[tag] ?? TAG_CATEGORY[tag.split(':')[0]] ?? 'core';
}
