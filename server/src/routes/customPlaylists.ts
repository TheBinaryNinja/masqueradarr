import { Router } from 'express';
import { Playlist } from '../models/Playlist.js';
import { PlaylistChannel, type PlaylistChannelDoc } from '../models/PlaylistChannel.js';
import { User } from '../models/User.js';
import { Settings, SETTINGS_ID } from '../models/Settings.js';
import { composeM3u, pruneCustomFile } from '../m3u/compose.js';
import { grantPlaylistToAdmins } from '../security/adminAccess.js';
import { normalizeEndpointPath, isReservedEndpointPath, CUSTOM_PLAYLIST_TYPES } from '../m3u/paths.js';
import { logger } from '../sources/core/logger.js';
import { syncHdhrPlaylist, HDHR_SOURCE } from '../sources/adapters/hdhomerun/import.js';
import { syncUrlPlaylist } from './import.js';
import { VideoConfig } from '../models/VideoConfig.js';
import { invalidateVideoConfig, invalidatePlaylistConfig } from '../videoconfig/runtime.js';

// "Clone" playlists — the user-composed custom playlists. A clone is a Playlist row with the literal
// sentinel `source: 'clone'` (the discriminator), `endpoint: 'custom'`, `interval: 'none'` (scheduling
// disabled). Its channels are INDEPENDENT COPIES of selected source channels, stored as PlaylistChannel
// docs keyed by `source === <cloneId>` (deterministic `_id` "<cloneId>:<originalId>", `origin` = the
// provider source so streams still route through the real adapter). Clones ride the SAME Endpoint Url
// machinery as every other Custom playlist — composeM3u() fans out per-user m3u files + the guide sibling,
// streams are token-gated. Admin-only (mounted under adminOnlyRoutes in index.ts). The retired metadata-only
// `CustomPlaylist` model/collection is gone; GET here projects the clone Playlist rows into the same runtime
// shape the SPA already reads. See .claude/skills/{restapi,schemas,m3u}/SKILL.md.

export const customPlaylistsRouter = Router();

const CLONE_SOURCE = 'clone';
const URL_SOURCE = 'url'; // remote-URL import TYPE TAG — re-syncable via the stored remoteUrl (syncUrlPlaylist)
// Every user-composed playlist TYPE ('clone' + 'file' + 'url' + 'hdhomerun', plus legacy 'import') — the
// management routes here (list/update/delete) operate on all of them; only CREATE is type-specific (this
// router tags 'clone'; routes/import.ts tags 'file'/'url'). The `$in` membership queries below also include
// the legacy CAPITALIZED tags so any pre-normalization doc is still matched until the boot migration rewrites it.
const CUSTOM_SOURCES = [
  ...CUSTOM_PLAYLIST_TYPES,
  ...CUSTOM_PLAYLIST_TYPES.map((t) => t.charAt(0).toUpperCase() + t.slice(1)),
  'HDHomeRun',
];

// Resolve the operator domain as a bare origin (the same source compose reads) — used to build a custom url.
// Exported so the import route reuses the exact same derivation.
export async function resolveDomain(): Promise<string> {
  const s = await Settings.findOne({ _id: SETTINGS_ID }, { domain: 1 }).lean();
  return (s?.domain ?? '').replace(/\/+$/, '');
}

// name → a filesystem/url-safe id: strip every non-alphanumeric (spaces, punctuation). Empty → 'clone'.
// Exported for reuse by the import route (same id-derivation contract).
export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '') || 'clone';
}

// Distinct non-null group count over a playlist's channels — the stored Playlist.groups value. Exported for the import route.
export function groupCount(channels: Array<{ group: string | null }>): number {
  return new Set(channels.map((c) => c.group).filter((g): g is string => g != null)).size;
}

// Project a clone Playlist row into the CustomPlaylist runtime shape the SPA reads. `slug` is the clone id
// (its custom path); `channels` is the live count of its copied channels; `updated` is its lastSync.
interface CustomPlaylistView {
  id: string;
  name: string;
  slug: string;
  channels: number;
  updated: string;
}
function toView(p: { id: string; name: string; lastSync: string }, channels: number): CustomPlaylistView {
  return { id: p.id, name: p.name, slug: p.id, channels, updated: p.lastSync };
}

// Live count of a clone's channels (its copies, keyed by source === clone id).
async function channelCount(cloneId: string): Promise<number> {
  return PlaylistChannel.countDocuments({ source: cloneId });
}

// Copy the given origin channels into clone copies (idempotent: $setOnInsert keyed by a deterministic _id,
// so a re-append of an already-present channel is a no-op that PRESERVES the clone's independent edits).
// A copy keeps `origin` = the provider source (root provider for a chained clone) for stream routing; its
// `source` becomes the clone id (the membership key). Unknown ids are silently skipped.
async function copyChannelsInto(cloneId: string, originIds: string[]): Promise<void> {
  const ids = [...new Set(originIds)];
  if (!ids.length) return;
  const originals = await PlaylistChannel.find({ _id: { $in: ids } }).lean<PlaylistChannelDoc[]>();
  if (!originals.length) return;
  const ops = originals.map((o) => {
    const copyId = `${cloneId}:${o._id}`;
    // Strip the immutable _id (set from the filter on insert) and the id mirror (re-derived below).
    const { _id: _drop, id: _dropId, ...rest } = o;
    return {
      updateOne: {
        filter: { _id: copyId },
        update: { $setOnInsert: { ...rest, id: copyId, source: cloneId, origin: o.origin ?? o.source } },
        upsert: true,
      },
    };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await PlaylistChannel.bulkWrite(ops as any[]);
}

// GET /api/custom-playlists — every user-composed playlist (clones + imports), projected into the
// CustomPlaylist runtime shape, by name.
customPlaylistsRouter.get('/', async (_req, res, next) => {
  try {
    const clones = (await Playlist.find({ source: { $in: CUSTOM_SOURCES } }, { _id: 0 }).lean()) as Array<{
      id: string;
      name: string;
      lastSync: string;
    }>;
    const counts = await PlaylistChannel.aggregate<{ _id: string; count: number }>([
      { $match: { source: { $in: clones.map((c) => c.id) } } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]);
    const byId = new Map(counts.map((c) => [c._id, c.count]));
    res.json(
      clones.map((c) => toView(c, byId.get(c.id) ?? 0)).sort((a, b) => a.name.localeCompare(b.name)),
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/custom-playlists — create a clone from a set of selected source-channel ids.
customPlaylistsRouter.post('/', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name (non-empty string) required' });
    if (!Array.isArray(body.channelIds) || body.channelIds.some((x: unknown) => typeof x !== 'string')) {
      return res.status(400).json({ error: 'channelIds (string[]) required' });
    }
    const channelIds = body.channelIds as string[];

    // Derive a filesystem/url-safe id from the name; reject the reserved export-tree prefixes; disambiguate
    // against any existing Playlist id (a clone, a source, or a source-hosted-at-custom-path playlist).
    const base = sanitizeName(name);
    if (isReservedEndpointPath(base)) return res.status(400).json({ error: 'reserved_path' });
    let id = base;
    for (let n = 2; await Playlist.exists({ id }); n++) id = `${base}${n}`;

    const domain = await resolveDomain();
    const path = normalizeEndpointPath(id);
    const url = path ? `${domain}/${path}` : domain;
    const now = new Date().toISOString();

    // Copy the selected channels FIRST (so groups can be computed), then create the clone row.
    await copyChannelsInto(id, channelIds);
    const channels = (await PlaylistChannel.find({ source: id }, { group: 1 }).lean()) as Array<{
      group: string | null;
    }>;

    await Playlist.create({
      id,
      name,
      source: CLONE_SOURCE,
      endpoint: 'custom',
      interval: 'none',
      url,
      groups: groupCount(channels),
      state: true,
      status: 'good',
      auto: false,
      builtin: false,
      authentication: false,
      isAuthenticated: false,
      lastSync: now,
    });

    // Auto-grant the new clone to every admin (Custom endpoint → allowedCustomPlaylists). Best-effort —
    // non-fatal; admins still pass the role bypass in the meantime. (compose already treats admin as
    // all-access, so this is pure array bookkeeping; no extra recompose.)
    await grantPlaylistToAdmins(id, 'custom').catch((err) =>
      logger.warn('users', `grantPlaylistToAdmins after clone create (${id}) failed: ${(err as Error).message}`),
    );

    // Best-effort: fan the clone's per-user m3u files + guide sibling out now (non-fatal, mirrors the
    // settings/users compose contract).
    await composeM3u(id).catch((err) =>
      logger.warn('m3u', `compose after clone create failed: ${(err as Error).message}`),
    );

    logger.info('playlists', `created clone "${name}" (${id}) · ${channels.length} channel(s)`);
    res.status(201).json(toView({ id, name, lastSync: now }, channels.length));
  } catch (err) {
    next(err);
  }
});

// PUT /api/custom-playlists/:id — append/remove channels and/or rename a clone.
customPlaylistsRouter.put('/:id', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const clone = await Playlist.findOne({ id: req.params.id, source: { $in: CUSTOM_SOURCES } });
    if (!clone) return res.status(404).json({ error: 'not_found' });

    const toStrings = (v: unknown): string[] =>
      Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as string[]) : [];
    const append = toStrings(body.appendChannelIds);
    const remove = toStrings(body.removeChannelIds);

    if (typeof body.name === 'string' && body.name.trim()) clone.name = body.name.trim();
    if (append.length) await copyChannelsInto(clone.id, append);
    if (remove.length) {
      // removeChannelIds may be original ids ("dulo:ch1") or already-namespaced copy ids ("<id>:dulo:ch1").
      const copyIds = remove.map((r) => (r.startsWith(`${clone.id}:`) ? r : `${clone.id}:${r}`));
      await PlaylistChannel.deleteMany({ source: clone.id, _id: { $in: copyIds } });
    }

    const channels = (await PlaylistChannel.find({ source: clone.id }, { group: 1 }).lean()) as Array<{
      group: string | null;
    }>;
    clone.groups = groupCount(channels);
    clone.lastSync = new Date().toISOString();
    await clone.save();

    await composeM3u(clone.id).catch((err) =>
      logger.warn('m3u', `compose after clone update failed: ${(err as Error).message}`),
    );

    res.json(toView({ id: clone.id, name: clone.name, lastSync: clone.lastSync }, channels.length));
  } catch (err) {
    next(err);
  }
});

// POST /api/custom-playlists/:id/sync — re-fetch a custom playlist's LIVE upstream and reconcile its channels
// (the custom-playlist twin of the Default-source "Sync now"). Two source types have a re-syncable upstream:
// 'hdhomerun' (the device lineup) and 'url' (the stored remoteUrl m3u). A static Clone/file Import has none → 400
// not_syncable. An upstream unreachable now → 502 (the device/url is down).
customPlaylistsRouter.post('/:id/sync', async (req, res) => {
  try {
    const pl = (await Playlist.findOne(
      { id: req.params.id, source: { $in: CUSTOM_SOURCES } },
      { _id: 0, source: 1 },
    ).lean()) as { source?: string | null } | null;
    if (!pl) return res.status(404).json({ error: 'not_found' });
    // Case-insensitive so a pre-normalization capitalized doc is still recognized as syncable.
    const src = (pl.source ?? '').toLowerCase();
    const result =
      src === HDHR_SOURCE
        ? await syncHdhrPlaylist(req.params.id as string)
        : src === URL_SOURCE
          ? await syncUrlPlaylist(req.params.id as string)
          : null;
    if (!result) return res.status(400).json({ error: 'not_syncable' });
    res.json({ ok: true, channels: result.channels, groups: result.groups });
  } catch (err) {
    logger.warn('import', `custom-playlist sync failed for ${req.params.id}: ${(err as Error).message}`);
    res.status(502).json({ error: `sync_failed: ${(err as Error).message}` });
  }
});

// Cascade-delete a user-composed (Clone/Import/HDHomeRun) playlist: its row, its copied/imported/synced
// channels (keyed by the playlist id), its per-user m3u files + guide sibling, and its id from every user's
// allowedCustomPlaylists. Exported so the playlists router's DELETE (which guards built-ins) shares the EXACT
// same cascade — one source of truth. The caller is responsible for the not-found / built-in guard before
// calling this. (For an HDHomeRun playlist, dropping its channels + pruning its m3u stops all polling of its
// loopback remux streams; the remux idle-sweep then reaps the ffmpeg processes — no explicit teardown here,
// which also avoids killing a remux another playlist on the same device may still be using.)
export async function cascadeDeleteCustomPlaylist(id: string, url: string): Promise<void> {
  await Playlist.deleteOne({ id });
  await PlaylistChannel.deleteMany({ source: id });
  await pruneCustomFile(url).catch((err) =>
    logger.warn('m3u', `prune after playlist delete failed: ${(err as Error).message}`),
  );
  await User.updateMany({}, { $pull: { allowedCustomPlaylists: id } });
  // Drop any per-playlist Custom videoconfig doc (orphan cleanup) + its resolver caches.
  await VideoConfig.deleteOne({ _id: `app_${id}` });
  invalidateVideoConfig(`app_${id}`);
  invalidatePlaylistConfig(id);
  logger.info('playlists', `deleted playlist ${id}`);
}

// DELETE /api/custom-playlists/:id — remove a clone/import, its channels, its per-user m3u files + guide
// sibling, and any lingering references in users' allowedCustomPlaylists.
customPlaylistsRouter.delete('/:id', async (req, res, next) => {
  try {
    const clone = (await Playlist.findOne(
      { id: req.params.id, source: { $in: CUSTOM_SOURCES } },
      { _id: 0, url: 1 },
    ).lean()) as { url: string } | null;
    if (!clone) return res.status(404).json({ error: 'not_found' });
    await cascadeDeleteCustomPlaylist(req.params.id, clone.url);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
