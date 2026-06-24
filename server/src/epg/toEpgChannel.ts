// Sync-time transform: project an upstream EPG channel record into the editable-store-agnostic EpgChannelDoc
// (the toPlaylistChannel.ts analogue for guide channels). This is the per-source translation hub — each EPG
// source with its own raw channel shape adds its own mapper here, while the EpgChannelDoc target stays one
// canonical shape. Today EPG-PW (region channel table) and Gracenote (grid channels, depth=1) feed it. Fields
// with no upstream equivalent are explicit null, never fabricated. See models/EpgChannel.ts + schemas.md (epgchannels).

import type { EpgChannelDoc } from '../models/EpgChannel.js';
import type { EpgpwRawChannel } from './epgpw.js';

// Null-coerce an upstream value (empty string / the literal 'null' → null), mirroring gracenote.ts's `str`.
function str(v: unknown): string | null {
  return v == null || v === '' || v === 'null' ? null : String(v);
}

// EPG-PW: { channelId, affiliateName } → EpgChannelDoc. callSign/channelNo have no source equivalent → null.
export function toEpgChannelDoc(raw: EpgpwRawChannel, sourceId: string): EpgChannelDoc {
  return {
    _id: `${sourceId}:${raw.channelId}`,
    callSign: null,
    affiliateName: raw.affiliateName,
    channelId: raw.channelId,
    channelNo: null,
    source: sourceId,
  };
}

// Gracenote: a grid channel object (depth=1) → EpgChannelDoc. The Gracenote fields align 1:1 with the model;
// affiliateName falls back (affiliateName → affiliateCallSign → callSign → channelId) so the required field is
// never empty. Returns null when there's no channelId (the row can't be keyed/linked without one).
export function toEpgChannelDocFromGracenote(
  c: Record<string, unknown>,
  sourceId: string,
): EpgChannelDoc | null {
  const channelId = str(c.channelId);
  if (!channelId) return null;
  const affiliateName =
    str(c.affiliateName) ?? str(c.affiliateCallSign) ?? str(c.callSign) ?? channelId;
  return {
    _id: `${sourceId}:${channelId}`,
    callSign: str(c.callSign),
    affiliateName,
    channelId,
    channelNo: str(c.channelNo),
    source: sourceId,
  };
}
