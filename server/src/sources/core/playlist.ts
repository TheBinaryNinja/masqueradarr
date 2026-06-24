// Shared HLS playlist helpers. Ported from d-combine/lib/core/playlist.mjs. The only per-source
// difference — whether the rewriter also learns (allowlists) each child host — is the `onChildHost`
// hook param, so one implementation serves every source.

/** True if the upstream URL / content-type looks like an HLS playlist (.m3u8). */
export function looksLikePlaylist(upstreamUrl: string, contentType: string): boolean {
  if (contentType && contentType.includes('mpegurl')) return true; // apple.mpegurl / x-mpegurl
  try {
    return new URL(upstreamUrl).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}

/**
 * Rewrite every child URI in a playlist so it routes back through this proxy.
 *
 * @param text         the raw playlist body
 * @param baseUrl      the upstream URL it was fetched from (for relative→absolute)
 * @param prefix       proxy mount prefix to prepend, e.g. "/api/v1/dulo/"
 * @param onChildHost  per-child-host hook (dlhd dynamic-allow; dulo/common null)
 * @param token        when set, re-append `?token=` to every child URL so each variant/segment hop
 *                     carries the caller's auth token (the proxy gate runs on every request — the player
 *                     resolves child URIs relative to the playlist *path*, dropping any query, so the token
 *                     must be baked into each child line). Empty/omitted → child URLs stay token-free.
 * @param pl           when set, re-append `&pl=` (the owning-playlist selector) to every child URL so a
 *                     segment/variant request resolves the SAME per-playlist videoconfig as its entry on the
 *                     externalPlayer mount. The in-app /api/v1 path passes none (it has no per-playlist config).
 *
 * Both BARE URI lines (variants / segments) AND the `URI="…"` attribute on tag lines (#EXT-X-KEY AES key,
 * #EXT-X-MAP init segment, #EXT-X-MEDIA renditions) are rewritten — without the tag-attribute pass an
 * AES-128 source (tubi) would load but the encryption key would be fetched DIRECT, bypassing the proxy
 * (and the SSRF gate / upstream headers / token), and decryption would silently fail. No-op for sources
 * whose tags carry no URI attribute (dulo/dlhd plain/disguised streams).
 */
export function rewritePlaylist(
  text: string,
  baseUrl: string,
  prefix: string,
  onChildHost: ((host: string) => void) | null,
  token?: string,
  pl?: string,
): string {
  let suffix = token ? `?token=${encodeURIComponent(token)}` : '';
  if (pl) suffix += `${suffix ? '&' : '?'}pl=${encodeURIComponent(pl)}`;
  const rewriteUri = (uri: string): string => {
    const abs = new URL(uri, baseUrl).href; // resolve relative → absolute
    if (onChildHost) {
      try {
        onChildHost(new URL(abs).hostname);
      } catch {
        /* ignore malformed */
      }
    }
    return `${prefix}${encodeURIComponent(abs)}${suffix}`;
  };
  return text
    .split(/\r?\n/)
    .map((rawLine) => {
      const trimmed = rawLine.trim();
      if (!trimmed) return rawLine; // blank → as-is
      // Tag/comment line: rewrite ONLY its URI="…" attribute (key / map / media), pass everything else
      // through untouched.
      if (trimmed.startsWith('#')) {
        return rawLine.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${rewriteUri(uri)}"`);
      }
      return rewriteUri(trimmed); // bare URI line (variant / segment)
    })
    .join('\n');
}
