// Failover-group propagation core. Groups live as three fields on PlaylistChannel docs (failoverGroupId /
// failoverRole / failoverOrder — see models/PlaylistChannel.ts); there are no Mongoose hooks in this
// codebase, so group invariants are maintained by explicit calls from the write sites:
//  · cascadeFailoverEpg — parent → children EPG-identity mirror (group-save + the generic channel edit route)
//  · reconcileFailoverGroups — self-heal after ANY playlistchannels delete/prune (sync prunes, custom
//    remove-channels, built-in cascade delete) and after group saves move members between groups.

import { PlaylistChannel, type PlaylistChannelDoc } from '../models/PlaylistChannel.js';
import { logger } from '../sources/core/logger.js';

export interface FailoverEpgSnapshot {
  tvg_id: string | null;
  epg: string | null;
  epgState: 'matched' | 'unmatched' | null;
}

// A grouped child's epgState is NEVER null: the fill-only sync writers (epg/fastSelfEpg.ts,
// sources/epgCrosswalk.ts, the dlhd/dami/tubi/local afterSync self-links) all match
// { epg: null, epgState: null } as "untouched" — a child inheriting an unlinked parent's nulls would be
// independently re-linked to its OWN guide id on the next sync, silently diverging from the parent.
export function inheritedEpgState(snap: FailoverEpgSnapshot): 'matched' | 'unmatched' {
  return snap.epgState ?? 'unmatched';
}

// Mirror the parent's EPG identity onto every child of the group. Pass `parentSnapshot` when the caller
// already holds the parent's post-write values (the edit route); omit it to load the group's parent (no
// parent → no-op). Returns the updated children (failoverOrder-sorted, _id-less — the same verbatim shape
// the channel read routes return) so callers can hand them to the SPA.
export async function cascadeFailoverEpg(
  source: string,
  failoverGroupId: string,
  parentSnapshot?: FailoverEpgSnapshot,
): Promise<PlaylistChannelDoc[]> {
  let snap = parentSnapshot;
  if (!snap) {
    const parent = await PlaylistChannel.findOne(
      { source, failoverGroupId, failoverRole: 'parent' },
      { tvg_id: 1, epg: 1, epgState: 1 },
    ).lean();
    if (!parent) return [];
    snap = { tvg_id: parent.tvg_id, epg: parent.epg, epgState: parent.epgState };
  }
  await PlaylistChannel.updateMany(
    { source, failoverGroupId, failoverRole: 'child' },
    { $set: { tvg_id: snap.tvg_id, epg: snap.epg, epgState: inheritedEpgState(snap) } },
  );
  return PlaylistChannel.find({ source, failoverGroupId, failoverRole: 'child' }, { _id: 0 })
    .sort({ failoverOrder: 1 })
    .lean<PlaylistChannelDoc[]>();
}

// Disband every degenerate group on a source: a group whose parent vanished (pruned/deleted), whose last
// child left, or that somehow ended up with two parents (bulkWrite is not transactional — this is the
// repair path). Members keep their inherited EPG (clearing it is the explicit unlink action); they only
// lose the grouping. Cheap (one indexed find + at most one updateMany); callers wrap it non-fatal.
export async function reconcileFailoverGroups(source: string): Promise<void> {
  const members = await PlaylistChannel.find(
    { source, failoverGroupId: { $type: 'string' } },
    { failoverGroupId: 1, failoverRole: 1 },
  ).lean();
  if (!members.length) return;
  const tally = new Map<string, { parents: number; children: number }>();
  for (const m of members) {
    const g = m.failoverGroupId as string;
    const t = tally.get(g) ?? { parents: 0, children: 0 };
    if (m.failoverRole === 'parent') t.parents++;
    else if (m.failoverRole === 'child') t.children++;
    tally.set(g, t);
  }
  const degenerate = [...tally.entries()]
    .filter(([, t]) => t.parents !== 1 || t.children < 1)
    .map(([g]) => g);
  if (!degenerate.length) return;
  await PlaylistChannel.updateMany(
    { source, failoverGroupId: { $in: degenerate } },
    { $set: { failoverGroupId: null, failoverRole: null, failoverOrder: null } },
  );
  logger.info('failover', `disbanded ${degenerate.length} degenerate failover group(s) on ${source}`);
}
