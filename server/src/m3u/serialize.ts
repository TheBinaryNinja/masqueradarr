import type { PlaylistChannelDoc } from '../models/PlaylistChannel.js';

// Pure EXTM3U serialization — the Channel → #EXTINF field mapping, with NO DB or fs access (so it stays
// trivially testable). LF discipline + the trailing newline are the caller's concern (compose.ts joins
// entries with '\n'). See .claude/skills/m3u/SKILL.md §1–§4 for the wire format and field rules.

// Strip characters that would corrupt an EXTINF line (embedded double-quotes / CR / LF). Source data
// almost never contains these; this keeps one bad value from breaking the whole playlist.
function clean(v: string): string {
  return v.replace(/[\r\n"]/g, '');
}

/** The playlist header line. `guideUrl` adds x-tvg-url= when an EPG guide is configured (deferred today → null). */
export function m3uHeader(guideUrl: string | null): string {
  return guideUrl ? `#EXTM3U x-tvg-url="${clean(guideUrl)}"` : '#EXTM3U';
}

// The DERIVED per-channel stream URL — the single source of truth for the /api/ext/v1 path, shared by the
// M3U serializer (below) and the HDHomeRun lineup builder (routes/hdhrServe.ts) so a tuner's lineup can
// never drift from the exported playlist. Returns null when the channel has no stream entry / provider.
// Shape: <domain>/api/ext/v1/<origin ?? source>/<enc(streamEntryUrl)>?token=<streamToken>&pl=<source>.
// `?token` is the owning user's streamToken (the proxy gate credential); `?pl` selects the per-playlist
// videoconfig (app / app_<id>) — it is the channel's OWNING playlist id (ch.source), correct even in the
// global union. The externalPlayer mount is LIVE (Rust sidecar) — these URLs resolve and stream.
export function deriveStreamUrl(ch: PlaylistChannelDoc, domain: string, token?: string): string | null {
  const streamSource = ch.origin ?? ch.source;
  if (!ch.streamEntryUrl || !streamSource) return null;
  const base = domain.replace(/\/+$/, '');
  let url = `${base}/api/ext/v1/${streamSource}/${encodeURIComponent(ch.streamEntryUrl)}`;
  if (token) url += `?token=${encodeURIComponent(token)}`;
  url += `${url.includes('?') ? '&' : '?'}pl=${encodeURIComponent(ch.source)}`;
  return url;
}

// The DERIVED per-channel TUNER stream URL — the HDHomeRun-tuner sibling of deriveStreamUrl. A wired tuner's
// lineup.json points Plex/Emby at this dedicated /hdhr/<tunerId>/stream/… route (served by the Node ffmpeg
// copy-remux engine, a continuous video/mp2t) INSTEAD of the shared /api/ext/v1 mount — so the tuner's video
// path is fully separate from the production Rust data plane. Returns null when the channel has no stream
// entry / provider. Shape: <domain>/hdhr/<tunerId>/stream/<origin ?? source>/<enc(streamEntryUrl)>?pl=<source>.
// NO ?token: the tuner's unguessable :tunerId slug is the access secret (same posture as discover/lineup),
// and the /stream route re-checks the owner's stream access server-side. `?pl` is the channel's OWNING
// playlist id (ch.source) — the /stream route threads it into buildGrant for proxyConfig + failover lookup.
export function deriveTunerStreamUrl(ch: PlaylistChannelDoc, domain: string, tunerId: string): string | null {
  const streamSource = ch.origin ?? ch.source;
  if (!ch.streamEntryUrl || !streamSource) return null;
  const base = domain.replace(/\/+$/, '');
  return (
    `${base}/hdhr/${encodeURIComponent(tunerId)}/stream/${streamSource}/${encodeURIComponent(ch.streamEntryUrl)}` +
    `?pl=${encodeURIComponent(ch.source)}`
  );
}

// One channel → its 2-line "#EXTINF:-1 …,<name>\n<url>" entry, or null when the channel can't be composed
// (not Active, or no stream entry). `domain` is the absolute origin used to build the derived proxy URL.
export function channelToExtinf(ch: PlaylistChannelDoc, domain: string, token?: string): string | null {
  // §5 inclusion governor — only Active, non-failover-child channels (callers already filter; this is
  // defensive). A failover child is a hidden backup served through its parent's line — never exported.
  // Undefined-safe: pre-feature docs lack failoverRole entirely.
  if (ch.status !== 'Active' || ch.failoverRole === 'child') return null;

  // §4 URL line — DERIVED, never stored (see deriveStreamUrl above for the full shape + rationale). This M3U
  // is consumed by EXTERNAL IPTV clients (TiviMate/Kodi/VLC/…); it targets the LIVE externalPlayer mount
  // /api/ext/v1 → streamGate → proxyRelay → Rust sidecar. For dulo, streamEntryUrl is the `dulo://channel/<id>`
  // sentinel; the proxy mints the real playbackUrl per play, so the m3u references the proxy path, never a
  // resolved (expiring) upstream.
  const url = deriveStreamUrl(ch, domain, token);
  if (url == null) return null;

  // §3 attribute mapping — order matches the SKILL §13 worked example. Each optional attr is OMITTED
  // (never fabricated) when its source field is null.
  const attrs: string[] = [];
  // tvg-id ONLY when a real 2-factor EPG link exists (tvg_id present AND epg set) — never bind a phantom guide.
  if (ch.tvg_id != null && ch.epg != null) attrs.push(`tvg-id="${clean(ch.tvg_id)}"`);
  attrs.push(`tvg-name="${clean(ch.tvg_name)}"`); // drives both the attr and the trailing display name
  if (ch.channelNo != null) attrs.push(`tvg-chno="${clean(ch.channelNo)}"`);
  if (ch.logoUrl != null) attrs.push(`tvg-logo="${clean(ch.logoUrl)}"`);
  if (ch.group != null) attrs.push(`group-title="${clean(ch.group)}"`);

  return `#EXTINF:-1 ${attrs.join(' ')},${clean(ch.tvg_name)}\n${url}`;
}
