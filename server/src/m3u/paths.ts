// Export-path helpers for the per-user m3u files. There is NO canonical playlist.m3u anymore — the
// compose subsystem writes ONLY per-user files (one per users-collection account with access). The two
// reserved bases live under composeDir:
//   _global/m3u/<username>-<slug>.m3u            the Global union, per user (scoped to allowedPlaylists)
//   custom/<customPath>/<username>-<slug>.m3u    one Custom playlist, per user (gated by allowedCustomPlaylists)
// where <customPath> is normalizeEndpointPath() applied to the Custom playlist's stored url pathname.
// Both `_global` and `custom` are RESERVED top-level path segments a Custom playlist url may never claim
// (isReservedEndpointPath). See .claude/skills/m3u/SKILL.md §7.

// ── Custom (user-composed) playlist type tags ───────────────────────────────
// A user-composed playlist carries a literal `source` TYPE TAG (not a real adapter id): 'clone' (channels
// COPIED from existing source channels), 'file' (channels PARSED from an UPLOADED .m3u), 'url' (channels
// PARSED from a REMOTE-URL .m3u fetch), 'hdhomerun' (channels SYNCED from a local HDHomeRun tuner's
// lineup; each carries origin:'hdhomerun' so its stream routes through the hdhomerun remux adapter), or 'local'
// (channels SYNCED from a Local Now market; each carries origin:'local' so its `localnow://` sentinel resolves
// through the synthetic local adapter). The
// legacy tag 'import' (pre-file/url split) is still RECOGNIZED for existing rows but is no longer assigned to
// new playlists. All TYPE TAGS are stored LOWERCASE (the repo-wide source-type normalization). For all, the
// channels live under the playlist's OWN id (source === <playlistId>), so the channel-store key is the
// playlist id, not the type tag. A real (Default) source playlist instead has id === source (a registry id),
// so its channels are keyed by `source` directly. This helper centralizes that distinction — used by the
// channels read (routes/playlists.ts), the compose key (m3u/compose.ts), and the custom-playlist management
// routes (routes/customPlaylists.ts). See .claude/skills/{schemas,m3u}/SKILL.md.
export const CUSTOM_PLAYLIST_TYPES = ['clone', 'file', 'url', 'hdhomerun', 'local', 'import'] as const;

/**
 * True when `source` is a custom-playlist TYPE TAG ('clone' | 'file' | 'url' | 'hdhomerun', or legacy
 * 'import') — i.e. channels are keyed by the playlist id. Compared CASE-INSENSITIVELY so a pre-normalization
 * doc that still stores a capitalized 'Clone'/'Import'/'HDHomeRun' continues to match until the boot
 * migration rewrites it.
 */
export function isCustomPlaylistType(source?: string | null): boolean {
  return source != null && (CUSTOM_PLAYLIST_TYPES as readonly string[]).includes(source.toLowerCase());
}

/** The PlaylistChannel `source` key that holds a playlist's channels: its id for a custom type, else its `source`. */
export function channelSourceKey(p: { id: string; source?: string | null }): string | null {
  if (!p.source) return null;
  return isCustomPlaylistType(p.source) ? p.id : p.source;
}

// ── Reserved Custom-endpoint path prefixes (deconfliction) ──────────────────
// A normalized Custom endpoint path may not begin with either of these segments: `_global` is owned by the
// Global export tree, and `custom` is the base the per-user Custom files are nested under.
const RESERVED_ENDPOINT_PREFIXES = ['custom', '_global'] as const;

/**
 * The reserved URL-path prefix a Custom playlist url may not use (the legacy single-prefix guard that
 * routes/playlists.ts still applies). Kept for that caller until it migrates to isReservedEndpointPath()
 * next wave (which also reserves `custom`). See .claude/skills/m3u/SKILL.md §7.
 */
export const RESERVED_M3U_PREFIX = '/_global/';

/**
 * Normalize a raw endpoint path (typically a Custom playlist's url pathname) into a clean directory path:
 *  - strips the FINAL segment IFF it contains a `.` (so a `…/playlist.m3u` filename collapses to its dir):
 *      'MyList/playlist.m3u' → 'MyList'   ·   'a/b.x' → 'a'   ·   'MyList' → 'MyList'
 *      'My.Folder' → ''  (the sole segment contains a dot — accepted tradeoff; the only `.` we keep on disk
 *                         is the per-user file's `.m3u` extension)
 *  - collapses duplicate slashes and drops empty segments
 *  - returns a path with NO leading slash and NO trailing slash (the chosen convention — `<customPath>` is a
 *    relative directory joined under the `custom/` base, e.g. 'MyList' or 'tv/sports')
 * The route agent applies this on PUT /api/playlists/:id next wave to derive the stored/served custom path.
 */
export function normalizeEndpointPath(raw: string): string {
  const segs = (raw ?? '').split('/').filter(Boolean);
  if (segs.length && segs[segs.length - 1].includes('.')) segs.pop();
  return segs.join('/');
}

/**
 * True when a normalized endpoint path begins with a reserved top-level segment (`custom` or `_global`) —
 * i.e. the path's first segment is reserved. Used (next wave, by the route) to reject a Custom playlist url
 * that would collide with the reserved export trees.
 */
export function isReservedEndpointPath(path: string): boolean {
  const first = normalizeEndpointPath(path).split('/').filter(Boolean)[0];
  return first != null && (RESERVED_ENDPOINT_PREFIXES as readonly string[]).includes(first);
}
