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

// One channel → its 2-line "#EXTINF:-1 …,<name>\n<url>" entry, or null when the channel can't be composed
// (not Active, or no stream entry). `domain` is the absolute origin used to build the derived proxy URL.
export function channelToExtinf(ch: PlaylistChannelDoc, domain: string, token?: string): string | null {
  // §5 inclusion governor — only Active channels (callers already filter; this is defensive).
  if (ch.status !== 'Active') return null;

  // §4 URL line — DERIVED, never stored. This M3U is consumed by EXTERNAL IPTV clients (TiviMate/Kodi/VLC/…),
  // so it targets the externalPlayer mount /api/ext/v1 (not the in-app /api/v1 that src/data.ts
  // appPlayerProxyPath() builds client-side): those sessions route through the always-on server-side ffmpeg
  // engine for transcode + health capture.
  // The URL is FORMAT-NEUTRAL (the encoded entry never ends in .m3u8): the loopback-HLS path serves it as
  // application/vnd.apple.mpegurl and the raw-TS path (videoconfig.output==='ts') as video/mp2t — the served
  // content-type, decided by the runtime global, distinguishes the two, so one URL works for both and never
  // advertises .m3u8 for a TS body (the ExoPlayer OOM guardrail).
  // For dulo, streamEntryUrl is the `dulo://channel/<id>` sentinel; the proxy mints the real playbackUrl
  // per play, so the m3u references the proxy path, never a resolved (expiring) upstream.
  // The proxy source is the channel's PROVIDER: for a clone copy that's `origin` (the real adapter, e.g.
  // "dulo") since its `source` is the clone id; for a source-playlist channel `origin` is null → use `source`.
  const streamSource = ch.origin ?? ch.source;
  if (!ch.streamEntryUrl || !streamSource) return null;
  const base = domain.replace(/\/+$/, '');
  let url = `${base}/api/ext/v1/${streamSource}/${encodeURIComponent(ch.streamEntryUrl)}`;
  if (token) {
    url += `?token=${encodeURIComponent(token)}`;
  }
  // §4b per-playlist videoconfig selector — the OWNING playlist id. `ch.source` IS the owning playlist in every
  // compose case (a source playlist's channel has source===<id>; a clone copy stores source=<cloneId> with
  // origin=provider), so it is correct even in the global/multi-playlist union. The /api/ext route reads ?pl to
  // resolve this playlist's videoconfig (Default 'app' / Custom 'app_<id>') and key the engine; an old M3U
  // without it falls back to the path :source. Independent of the path segment (origin ?? source) above.
  url += `${url.includes('?') ? '&' : '?'}pl=${encodeURIComponent(ch.source)}`;

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
