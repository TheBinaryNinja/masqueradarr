// Stream-URL derivation, hoisted out of data.ts so a second Vite entry can import it without pulling in the
// whole SPA data layer. data.ts re-exports appPlayerProxyPath, so every existing caller is unchanged and
// this stays the single source of truth for the (origin ?? source) rule.
//
// Why the split: the Ultimate Player is its own entry (player.html) and only needs the path rule, but
// data.ts is ~1000 lines of app-wide reactive stores and bootstrap fetches. Importing it there would drag
// all of that into the popup's bundle for one three-line function.

// The minimum a channel must expose to be routable. Declared structurally (rather than importing Channel)
// so this module has no dependency on data.ts at all — Channel satisfies it by shape.
export interface StreamRoutableChannel {
  source: string;
  origin?: string | null;
  streamEntryUrl?: string | null;
}

// appPlayer proxy path for a source-playlist channel: /api/v1/<source>/<enc streamEntryUrl>. This is the
// IN-APP player's stream URL (prefixed `appPlayer*` to distinguish it from the externalPlayer /api/ext
// mount the M3U composer writes for third-party IPTV clients). Derived here (not stored) so a proxy-mount /
// dlhd mirror change needs no data rewrite. Null for legacy channels.
//
// NOTE: no `?pl=<playlistId>` is appended, so in-app playback resolves against the (Default) proxy config,
// never a per-playlist Custom one (see server middleware/streamGate.ts). The Ultimate Player deliberately
// keeps that parity so it stays a like-for-like comparison against the in-drawer player.
export function appPlayerProxyPath(ch: StreamRoutableChannel): string | null {
  // A clone copy's proxy source is its provider (`origin`, e.g. 'dulo') — its `source` is the clone id; a
  // source-playlist channel's is its `source` (origin null). Mirrors serialize.ts (channelToExtinf).
  const src = ch.origin || ch.source;
  if (!ch.streamEntryUrl || !src) return null;
  return `/api/v1/${src}/${encodeURIComponent(ch.streamEntryUrl)}`;
}
