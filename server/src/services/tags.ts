// Custom-tags shared logic — the validate + cascade helpers used by the tags CRUD router AND by every
// edit route that accepts a `tags` assignment (playlists, channels, epg-sources). Kept here (not in a route
// file) so multiple routers import it without a route→route cycle, matching services/groups.ts.
//
// Records reference a tag by opaque Tag.id (a `tags: string[]` array). Assignment is validated against the
// registry so no dangling id is ever stored; a tag delete cascades a `$pull` of the id from all three record
// collections (the "one source of truth" cascade convention, like cascadeDeleteEpgSource).

import { Tag } from '../models/Tag.js';
import { Playlist } from '../models/Playlist.js';
import { EpgSource } from '../models/EpgSource.js';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import { logger } from '../sources/core/logger.js';

export type ValidateTagsResult = { ok: true; ids: string[] } | { ok: false; error: string };

/**
 * Validate a `tags` assignment body: must be an array of strings, is de-duplicated, and every id must exist
 * in the Tag registry (rejects a dangling/unknown id). An empty array is valid (clears all tags). Returns the
 * cleaned id list on success, or a 400-ready error string.
 */
export async function validateTagIds(input: unknown): Promise<ValidateTagsResult> {
  if (!Array.isArray(input)) return { ok: false, error: 'tags (string[]) required' };
  if (!input.every((x) => typeof x === 'string')) return { ok: false, error: 'tags must be an array of strings' };
  const ids = [...new Set(input as string[])];
  if (ids.length === 0) return { ok: true, ids };
  const found = await Tag.find({ id: { $in: ids } }, { _id: 0, id: 1 }).lean();
  if (found.length !== ids.length) return { ok: false, error: 'unknown_tag' };
  return { ok: true, ids };
}

/**
 * Delete a tag and CASCADE the removal to every referencing record: `$pull` the id from Playlist / EpgSource /
 * PlaylistChannel, then drop the registry doc. Idempotent + safe for a tag referenced by zero records. The
 * caller is responsible for the not-found guard before calling this. Exported as the one source of truth for
 * tag deletion (mirrors cascadeDeleteEpgSource).
 */
export async function cascadeDeleteTag(id: string): Promise<void> {
  await Playlist.updateMany({ tags: id }, { $pull: { tags: id } });
  await EpgSource.updateMany({ tags: id }, { $pull: { tags: id } });
  await PlaylistChannel.updateMany({ tags: id }, { $pull: { tags: id } });
  await Tag.deleteOne({ id });
  logger.info('settings', `deleted tag ${id} (cascade)`);
}
