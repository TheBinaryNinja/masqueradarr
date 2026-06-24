import { resolve, sep } from 'node:path';
import { composeDir } from '../paths.js';
import { normalizeEndpointPath } from '../m3u/paths.js';

// Guide (XMLTV) export paths — the EPG analogue of m3u/paths.ts. A guide is the SIBLING of a composed M3U
// SURFACE (the Global union, or one Custom playlist), NOT of any single per-user .m3u file: there is ONE
// shared guide per surface (token-free, never fanned out per user). Each guide's served path is therefore
// anchored to the SURFACE, mirroring the surface's M3U export base under composeDir so the two never drift:
//   Global  →  _global/m3u/<user>-<slug>.m3u   ⇒  guide at  _global/epg/playlist.xml
//   Custom  →  custom/<customPath>/<user>-<slug>.m3u   ⇒  guide at  custom/<customPath>/epg/playlist.xml
// (<customPath> = normalizeEndpointPath(url.pathname), the SAME derivation m3u/compose.ts customPathOf uses,
// so a Custom guide always lands beside its Custom playlist's per-user files.) The .xml vs .m3u extensions
// keep the guide namespace from ever colliding with the per-user files in the same directory.
// Served 1:1, token-free, by express.static(composeDir) — no dedicated route. See .claude/skills/xmltv/SKILL.md.

// Served path of the consolidated Global guide — the XMLTV sibling of the Global per-user M3U tree
// (_global/m3u/…). Inside the reserved /_global/ namespace (Custom urls can never collide).
export const GLOBAL_GUIDE_PATH = '/_global/epg/playlist.xml';

// The Custom-playlist guide served-path, anchored to the Custom SURFACE: derive <customPath> from the
// playlist's stored url exactly as m3u/compose.ts does (normalizeEndpointPath over the url pathname, with the
// same 'unknown' fallback), then place the single shared guide at custom/<customPath>/epg/playlist.xml — the
// /epg/ sibling of that surface's per-user .m3u files at custom/<customPath>/<user>-<slug>.m3u.
export function customGuidePath(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = '';
  }
  const customPath = normalizeEndpointPath(pathname) || 'unknown';
  return `/custom/${customPath}/epg/playlist.xml`;
}

// Absolute disk path under composeDir for a guide served-path, with an anti-traversal guard (defense in
// depth — guide paths are derived from already-guarded surface paths). Layout-agnostic: it resolves whatever
// served path it is given under composeDir, so it is unaffected by where the surface anchors live.
export function guideDiskPath(servedPath: string): string {
  const segs = servedPath.split('/').filter(Boolean);
  const abs = resolve(composeDir, ...segs);
  if (abs !== composeDir && !abs.startsWith(composeDir + sep)) {
    throw new Error('guide_path_escapes_compose_dir');
  }
  return abs;
}
