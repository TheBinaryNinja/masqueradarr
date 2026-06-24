// Seed-time transform: project a canonical SourceChannel doc (the pristine, seed-only reference store)
// into the editable, UI-facing PlaylistChannel doc the Vue screens consume 1:1. This is the successor to
// the old request-time translate.ts → toUiChannel projection: the derivation now happens ONCE at seed/sync
// time and is persisted, so the read path is a straight 1:1 (no intermediate projection layer).
//
// Fields with no source equivalent are stored as explicit null (channel/tvg_id/epg/epgState, stream.res) —
// never fabricated. The (tvg_id, epg) pair is the 2-factor EPG link (factor 1 = epgchannels.channelId,
// factor 2 = the owning EPG source id); epgState is the SEPARATE match-status indicator ('matched' |
// 'unmatched' | null) — null at seed (a freshly-seeded channel is unmatched-by-absence). logoColor/initials
// are deterministic derivations (stable across syncs). The top-level `status` is the enable/disable governor
// ('Active'|'Disabled', from isPlayable); realtime phase lives in stream.status (in-memory authority is
// core/streamState.ts; not persisted here). See schemas.md §3.2/§3.10.

import type { SourceChannelDoc } from '../models/SourceChannel.js';
import type { PlaylistChannelDoc } from '../models/PlaylistChannel.js';

// Deterministic hue from a stable string → keeps a channel's fallback logo color stable across syncs.
function hueFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function logoColorFor(id: string): string {
  return `oklch(0.5 0.16 ${hueFromString(id)})`;
}

export function initialsFor(name: string): string {
  const ini = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return ini || '?';
}

export function toPlaylistChannelDoc(src: SourceChannelDoc): PlaylistChannelDoc {
  return {
    _id: src._id, // "<source>:<sourceChannelId>" — same deterministic key as the source doc
    id: src._id, // runtime mirror of _id (matches the legacy UiChannel.id)
    tvg_name: src.name,
    group: src.groupLabel,
    channel: null, // no source channel number — never fabricated
    channelNo: null, // no source channel number — user-editable, displayed everywhere (legacy `channel` is unused)
    tvg_id: null, // no EPG link yet (set together with `epg` when a channel is linked to an EPG source channel)
    epg: null, // no EPG link yet — non-null = owning EPG source id (= epgchannels.source); link factor only
    epgState: null, // no match yet — 'matched' | 'unmatched' | null match-status indicator (distinct from the link)
    status: src.isPlayable ? 'Active' : 'Disabled', // enable/disable governor (m3u inclusion)
    source: src.source,
    origin: null, // a source-playlist channel's proxy source IS its `source` — only clone copies set origin
    logoColor: logoColorFor(src._id),
    logoUrl: src.logoUrl,
    streamEntryUrl: src.streamEntryUrl,
    stream: {
      initials: initialsFor(src.name),
      isPlayable: src.isPlayable,
      res: null, // unknown until probed
      status: null, // realtime phase — in-memory authority (streamState.ts), not persisted at seed
      probe: null, // ffprobe technical details — unknown until first probed at proxy time (streamProbe.ts)
    },
  };
}
