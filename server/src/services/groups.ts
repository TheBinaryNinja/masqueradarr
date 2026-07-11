// Channel-group registry — the persisted, first-class group taxonomy for a playlist (Playlist.groupDefs).
//
// A "group" used to be only the free-text PlaylistChannel.group string, so a group could not exist without a
// member and there was no add/remove/rename operation. The registry makes groups first-class: they persist
// (an empty group survives with zero channels), carry a UI `order` ordinal, and are managed by the group CRUD
// routes (routes/playlists.ts). Channel MEMBERSHIP still rides the free-text `group` string on each channel
// (no PlaylistChannel schema change) — the registry is the set of NAMES + order layered on top.
//
// `sourceKey` is the channel `source` value = the owning Playlist `id` for both Default and custom playlists.

import { Playlist } from '../models/Playlist.js';
import { PlaylistChannel } from '../models/PlaylistChannel.js';

export interface GroupDef {
  name: string;
  order: number;
}

export interface GroupWithCount extends GroupDef {
  channels: number;
}

/**
 * Reconcile the registry against the channels currently in the playlist and persist it. UNION-ONLY: every
 * existing registry name is KEPT (this is how an operator-created empty group survives a re-sync), and any
 * group name present on a channel but missing from the registry is appended (next ordinal). A name is NEVER
 * removed here — the only path that drops a name is the explicit DELETE group route. Also writes the derived
 * scalar `Playlist.groups = groupDefs.length` so the header "Groups" stat counts empty groups too. Returns
 * the reconciled registry (sorted by order, then name). No-ops (returns []) if the playlist row is absent.
 */
export async function reconcileGroupRegistry(sourceKey: string): Promise<GroupDef[]> {
  const pl = (await Playlist.findOne(
    { id: sourceKey },
    { groupDefs: 1, _id: 0 },
  ).lean()) as { groupDefs?: GroupDef[] } | null;
  if (!pl) return [];

  const existing: GroupDef[] = (pl.groupDefs ?? []).map((g) => ({ name: g.name, order: g.order ?? 0 }));
  const known = new Set(existing.map((g) => g.name));

  const liveNames = (await PlaylistChannel.distinct('group', {
    source: sourceKey,
    group: { $ne: null },
  })) as string[];

  let nextOrder = existing.reduce((m, g) => Math.max(m, g.order), -1) + 1;
  for (const name of liveNames) {
    if (!name || known.has(name)) continue;
    known.add(name);
    existing.push({ name, order: nextOrder++ });
  }

  existing.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  await Playlist.updateOne(
    { id: sourceKey },
    { $set: { groupDefs: existing, groups: existing.length } },
  );
  return existing;
}

/**
 * The registry joined with a live per-group channel count (a registry name with no members reports 0). Backs
 * GET /:id/groups. Reconciles first so a freshly-synced playlist always reports a complete, consistent set.
 */
export async function groupsWithCounts(sourceKey: string): Promise<GroupWithCount[]> {
  const defs = await reconcileGroupRegistry(sourceKey);
  const counts = await PlaylistChannel.aggregate<{ _id: string | null; count: number }>([
    { $match: { source: sourceKey, group: { $ne: null } } },
    { $group: { _id: '$group', count: { $sum: 1 } } },
  ]);
  const byName = new Map(counts.map((c) => [c._id, c.count]));
  return defs.map((g) => ({ ...g, channels: byName.get(g.name) ?? 0 }));
}
