// The tag → category map + the resolver, plus the canonical category list (the route validator's copy; the
// SPA keeps its own copy in src/data.ts). This lives in the logs subsystem — NOT in the source-agnostic core
// — so the core never couples to product categories. Existing logger.* calls pass a TAG ('mongo',
// 'dulo:stream', …); the category is DERIVED here, so the overwhelming majority of call sites need zero
// change. See .claude/skills/logs/SKILL.md §2.

import type { LogCategory } from '../models/Log.js';

export const LOG_CATEGORIES: LogCategory[] = [
  'dashboard', 'active', 'playlists', 'epg-sources', 'mapping', 'history',
  'users', 'import', 'settings', 'api', 'core', 'mongodb',
];

export const TAG_CATEGORY: Record<string, LogCategory> = {
  mongo: 'mongodb', db: 'mongodb',
  startup: 'core', shutdown: 'core', boot: 'core', scheduler: 'core', dns: 'core',
  http: 'api', api: 'api',
  seed: 'playlists', sources: 'playlists', sync: 'playlists', m3u: 'playlists', compose: 'playlists',
  playlists: 'playlists',
  dulo: 'playlists', 'dulo:stream': 'playlists', dlhd: 'playlists', 'dlhd:stream': 'playlists', tubi: 'playlists',
  build: 'playlists',
  stats: 'active', telemetry: 'active', proxy: 'active', broll: 'active', ffprobe: 'active',
  stream: 'active', 'stream:probe': 'active', geoip: 'active',
  epg: 'epg-sources', xmltv: 'epg-sources', gracenote: 'epg-sources', epgpw: 'epg-sources',
  auth: 'users', users: 'users',
  mapping: 'mapping', import: 'import', settings: 'settings', history: 'history', dashboard: 'dashboard',
};

// Resolve a tag to a category: exact match → namespace prefix (split(':')[0], so 'dulo:stream' →
// 'dulo' → 'playlists' without enumerating every variant) → the 'core' default.
export function categoryForTag(tag: string): LogCategory {
  return TAG_CATEGORY[tag] ?? TAG_CATEGORY[tag.split(':')[0]] ?? 'core';
}
