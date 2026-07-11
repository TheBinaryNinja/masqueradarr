// Per-playlist channel tombstones — the set of PlaylistChannel `_id`s the operator hard-deleted via the
// bulk-delete route (POST /api/playlists/:id/channels/delete, stored on Playlist.deletedChannelIds).
//
// Why this exists: the sync/import re-insert paths ($setOnInsert upserts run off the LIVE upstream listing —
// seed.ts:upsertPlaylistChannels, import.ts:upsertImportChannels, hdhomerun / local upserts) would otherwise
// resurrect a deleted channel on the next sync, because a channel the user deleted is still present upstream.
// Those paths consult `tombstonedIds` and SKIP the tombstoned ids, so the deletion sticks for every source
// type. `sourceKey` is the channel `source` value, which equals the owning Playlist `id` for both Default and
// custom playlists. The set is cleared wholesale by resetSource (Restore Defaults = clean slate).

import { Playlist } from '../models/Playlist.js';

export async function tombstonedIds(sourceKey: string): Promise<Set<string>> {
  const pl = (await Playlist.findOne(
    { id: sourceKey },
    { deletedChannelIds: 1, _id: 0 },
  ).lean()) as { deletedChannelIds?: string[] } | null;
  return new Set(pl?.deletedChannelIds ?? []);
}
