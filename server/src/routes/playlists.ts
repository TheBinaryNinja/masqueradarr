import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { Playlist } from '../models/Playlist.js';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import { SourceChannel } from '../models/SourceChannel.js';
import { EpgSource, type EpgSourceDoc } from '../models/EpgSource.js';
import { PlaylistAuth } from '../models/PlaylistAuth.js';
import { ProxyConfig } from '../models/ProxyConfig.js';
import { User } from '../models/User.js';
import { Cronjob, cronjobId } from '../models/Cronjob.js';
import { removeCronjob } from '../scheduler/index.js';
import { AuthRequest, requireAdmin } from '../middleware/auth.js';
import { composeM3u, composeGlobal, pruneCustomFile, reconcilePlaylistExport, recomposeAllExports } from '../m3u/compose.js';
import { normalizeEndpointPath, isReservedEndpointPath, isCustomPlaylistType } from '../m3u/paths.js';
import { cascadeDeleteCustomPlaylist } from './customPlaylists.js';
import { cascadeDeleteEpgSource } from './epgSources.js';
import { cascadeFailoverEpg, reconcileFailoverGroups, inheritedEpgState } from '../services/failover.js';
import { reconcileGroupRegistry, groupsWithCounts } from '../services/groups.js';
import { Settings, SETTINGS_ID } from '../models/Settings.js';
import { logger } from '../sources/core/logger.js';
import { logMilestone, logTrace } from '../logs/tier.js';

export const playlistsRouter = Router();

// Resolve the operator domain (settings singleton) as a bare origin with no trailing slash — the same
// source the compose subsystem reads. A Global-endpoint playlist's stored `url` is exactly this value.
async function resolveDomain(): Promise<string> {
  const s = await Settings.findOne({ _id: SETTINGS_ID }, { domain: 1 }).lean();
  return (s?.domain ?? '').replace(/\/+$/, '');
}

// Channels live in the PlaylistChannel store, queried by `source` (a (Default) playlist's id === source).
// Source-unset (legacy/mock) playlists have no channels in the current model.
async function channelCountFor(doc: { id: string; source?: string | null }): Promise<number> {
  if (!doc.source) return 0;
  // A custom-type playlist's channel copies are keyed by its id ('clone'/'file'/'url'/'hdhomerun' are only type tags); others by `source`.
  return PlaylistChannel.countDocuments({ source: isCustomPlaylistType(doc.source) ? doc.id : doc.source });
}

// Swap the origin (scheme + host + port) of a stored http(s) url to `domain`, preserving path/search/hash.
// Returns null for values that aren't real http(s) URLs (e.g. the `source://<id>` seed sentinel, or an
// unparseable value) so the caller leaves them untouched.
//
// The WHATWG `host` SETTER is a trap here: assigning a value WITHOUT a port (e.g. 'tv.host.com') leaves the
// URL's existing port intact — so `parsed.host = base.host` would turn http://localhost:3000/x into
// http://tv.host.com:3000/x, retaining the stale :3000 when the new domain dropped it. We therefore adopt
// the COMPLETE new origin field-by-field: protocol, hostname, and port (base.port is '' when the new domain
// omits a port or uses the scheme default, which CLEARS the old port; non-empty when it specifies one).
function swapOrigin(url: string, domain: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  let base: URL;
  try {
    base = new URL(domain);
  } catch {
    return null;
  }
  parsed.protocol = base.protocol;
  parsed.hostname = base.hostname;
  parsed.port = base.port;
  return parsed.toString();
}

// Settings→playlists cascade: when the global domain changes, rewrite every playlist's persisted `url`
// (HOSTED AT) to the new domain, keeping each one's path. Both Global- and Custom-endpoint playlists
// prepend the global domain, so both follow the cascade. Sentinel/unparseable urls are skipped. This is
// the one sanctioned settings→playlists write cascade — invoked from PUT /api/settings (routes/settings.ts).
export async function cascadePlaylistUrls(nextDomain: string): Promise<void> {
  const playlists = await Playlist.find({}, { id: 1, url: 1 }).lean();
  const ops = [];
  for (const p of playlists) {
    const rewritten = swapOrigin(p.url, nextDomain);
    if (rewritten && rewritten !== p.url) {
      ops.push({ updateOne: { filter: { id: p.id }, update: { $set: { url: rewritten } } } });
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (ops.length) await Playlist.bulkWrite(ops as any[]);
  logger.info('settings', `domain changed → ${nextDomain} · cascaded ${ops.length} playlist url(s)`);

  // The new domain changes every absolutized channel URL inside the exports, so the on-disk m3u files
  // (canonical + per-user) are now stale — recompose them all. Best-effort: a compose hiccup must not fail
  // the settings write (it mirrors reconcilePlaylistExport's best-effort contract).
  await recomposeAllExports().catch((err) =>
    logger.error('settings', `recomposeAllExports (domain cascade) failed: ${(err as Error).message}`),
  );
}

playlistsRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    let filter = {};
    if (req.user?.role === 'user') {
      // A non-admin's effective read set is the UNION of their Global grants (allowedPlaylists) and their
      // custom-playlist grants (allowedCustomPlaylists). The compose path already treats a custom grant as
      // access, so the list/detail/channels reads must too — otherwise a user can be granted a clone they
      // can never list or stream.
      const allowedIds = [
        ...(req.user.allowedPlaylists || []),
        ...(req.user.allowedCustomPlaylists || []),
      ];
      filter = { id: { $in: allowedIds } };
    }
    const docs = await Playlist.find(filter, { _id: 0 }).lean();
    const sourceCounts = await PlaylistChannel.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]);
    const bySource = new Map(sourceCounts.map((c) => [c._id, c.count]));
    res.json(
      docs.map((d) => ({
        ...d,
        // A custom-type playlist's copies are grouped under its id ('clone'/'file'/'url'/'hdhomerun' are type tags); others by `source`.
        channels: d.source ? bySource.get(isCustomPlaylistType(d.source) ? d.id : d.source) ?? 0 : 0,
      })),
    );
  } catch (err) {
    next(err);
  }
});

playlistsRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    if (req.user?.role === 'user') {
      // Effective read set = allowedPlaylists ∪ allowedCustomPlaylists (see GET / above).
      const allowed = [
        ...(req.user.allowedPlaylists || []),
        ...(req.user.allowedCustomPlaylists || []),
      ];
      if (!allowed.includes(req.params.id as string)) {
        return res.status(403).json({ error: 'forbidden' });
      }
    }
    const doc = await Playlist.findOne({ id: req.params.id }, { _id: 0 }).lean();
    if (!doc) return res.status(404).json({ error: 'not_found' });
    res.json({ ...doc, channels: await channelCountFor(doc) });
  } catch (err) {
    next(err);
  }
});

// Update a playlist's operator-editable fields: name (display name), state (Active/Inactive), endpoint
// (Global/Custom), and the hosted url. The server CANONICALIZES `url` against the effective endpoint (Global →
// the bare operator domain; Custom → <domain>/<normalizeEndpointPath(path)>, rejecting the reserved
// `_global`/`custom` prefixes) rather than trusting the client value. A later global-domain change re-derives
// it via the settings cascade (cascadePlaylistUrls). The schedule label + auto flag (interval/auto) are
// operator-editable here too (mirrored from PlaylistStatusDrawer when a sync schedule is saved). `name` is
// operator-editable (a display rename — it does NOT affect the playlist id/source/url); the remaining
// sync-managed fields (source/groups/lastSync/status) are not.
playlistsRouter.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    // Read the prior state first (findOneAndUpdate gives only the new doc) so the export reconcile can act
    // on the endpoint/state/url transition (SKILL §8).
    const before = await Playlist.findOne(
      { id: req.params.id },
      { _id: 0, endpoint: 1, url: 1, state: 1, source: 1 },
    ).lean();
    if (!before) return res.status(404).json({ error: 'not_found' });

    const $set: Record<string, unknown> = {};
    // `name` is a free-text display rename (does not touch the id/source/url). Trimmed + non-empty.
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return res.status(400).json({ error: 'name (non-empty string) required' });
      }
      $set.name = body.name.trim();
    }
    if (body.state !== undefined) {
      if (typeof body.state !== 'boolean') {
        return res.status(400).json({ error: 'state (boolean) required' });
      }
      $set.state = body.state;
    }
    if (body.endpoint !== undefined) {
      // Accept either casing (an older SPA build may still send 'Global'/'Custom') but normalize to the
      // canonical LOWERCASE value before storing — the repo-wide source-type normalization.
      const ep = typeof body.endpoint === 'string' ? body.endpoint.toLowerCase() : '';
      if (ep !== 'global' && ep !== 'custom') {
        return res.status(400).json({ error: "endpoint ('global' | 'custom') required" });
      }
      $set.endpoint = ep;
    }
    if (body.url !== undefined) {
      if (typeof body.url !== 'string' || body.url.trim() === '') {
        return res.status(400).json({ error: 'url (non-empty string) required' });
      }
      $set.url = body.url.trim();
    }
    // The schedule label + auto flag — operator-owned (mirrored from PlaylistStatusDrawer when a sync
    // schedule is saved), the same posture as PUT /api/epg-sources/:id. A re-sync no longer resets them.
    if (body.interval !== undefined) {
      if (typeof body.interval !== 'string' || body.interval.trim() === '') {
        return res.status(400).json({ error: 'interval (non-empty string) required' });
      }
      $set.interval = body.interval.trim();
    }
    if (body.auto !== undefined) {
      if (typeof body.auto !== 'boolean') {
        return res.status(400).json({ error: 'auto (boolean) required' });
      }
      $set.auto = body.auto;
    }
    if (!Object.keys($set).length) {
      return res
        .status(400)
        .json({ error: 'no editable fields provided (name, state, endpoint, url, interval, auto)' });
    }

    // Canonicalize the persisted `url` against the effective endpoint (defense-in-depth — the filename and
    // origin are decided server-side regardless of what the client sent):
    //   • Global → the bare operator domain (origin only). The Global union is served per-user at a FLAT
    //     <domain>/<username>-<slug>.m3u path, so the playlist row stores just the domain.
    //   • Custom → <domain>/<normalizedPath>, where normalizeEndpointPath() strips any trailing dotted
    //     filename segment (so a `…/playlist.m3u` collapses to its directory). The `_global`/`custom`
    //     reserved top-level segments are rejected (isReservedEndpointPath) before persisting.
    // Lowercased so a pre-normalization `before.endpoint` ('Global'/'Custom') still classifies correctly
    // ($set.endpoint is already canonical lowercase from the validation above).
    const effectiveEndpoint = ((($set.endpoint as string) ?? before.endpoint) || 'global').toLowerCase();
    if (effectiveEndpoint === 'custom') {
      if (typeof $set.url === 'string') {
        // Extract the pathname from whatever the client sent (full URL or bare path), normalize it.
        let rawPath = $set.url;
        try {
          rawPath = new URL($set.url).pathname;
        } catch {
          /* not an absolute URL — treat the value as a bare path */
        }
        const normalized = normalizeEndpointPath(rawPath);
        if (isReservedEndpointPath(normalized)) {
          return res.status(400).json({ error: 'reserved_path' });
        }
        const domain = await resolveDomain();
        $set.url = normalized ? `${domain}/${normalized}` : domain;
      }
    } else if (effectiveEndpoint === 'global') {
      // Global is the bare domain — recompute it whenever endpoint/url is being written so a stale or
      // client-supplied path can never leak into a Global row.
      if ($set.endpoint !== undefined || $set.url !== undefined) {
        $set.url = await resolveDomain();
      }
    }

    const doc = await Playlist.findOneAndUpdate(
      { id: req.params.id },
      { $set },
      { new: true, projection: { _id: 0 } },
    ).lean();
    if (!doc) return res.status(404).json({ error: 'not_found' });

    // Re-derive the m3u exports on an endpoint/state/url change for a source playlist. Best-effort — a
    // compose/prune hiccup must never fail the API write.
    if (
      doc.source &&
      (before.endpoint !== doc.endpoint || before.state !== doc.state || before.url !== doc.url)
    ) {
      try {
        await reconcilePlaylistExport(
          { endpoint: before.endpoint, url: before.url },
          { id: doc.id, url: doc.url, endpoint: doc.endpoint, state: doc.state, source: doc.source },
        );
      } catch (err) {
        logger.warn('m3u', `reconcile after playlist edit failed: ${(err as Error).message}`);
      }
    }

    res.json({ ...doc, channels: await channelCountFor(doc) });
  } catch (err) {
    next(err);
  }
});

// ── Built-in (Default) source playlist deletion + its affected-areas impact report ─────────────────────
//
// A "(Default)" source playlist is a Playlist row whose `id === source` (e.g. dulo/dlhd/tubi). Deleting one
// is a destructive multi-store cascade. Two endpoints back the UI's confirm-modal flow:
//   • GET /api/playlists/:id/delete-impact — a PREVIEW (no writes) of exactly what the delete will touch.
//   • DELETE /api/playlists/:id            — performs the cascade (built-in branch below).
// Built-in source playlist rows are no longer auto-seeded at boot, so a deleted one stays deleted (re-add it
// via the Add Playlist "Built-In" option → POST /api/sources/:id/provision).

interface PlaylistDeleteImpact {
  // The playlist being deleted: ALL its channels go ("everything"), so we report the count for context.
  playlist: { id: string; name: string; channels: number };
  // Each clone playlist that copied channels FROM this built-in: how many of ITS channels will be pruned
  // (only the copies whose `origin` === this built-in's source — the rest of the clone stays intact).
  affectedClones: Array<{ id: string; name: string; channelsRemoved: number }>;
  // The playlist-bound self-EPG source that will be cascade-deleted, or null (dulo has none — crosswalk-only).
  boundEpgSource: { id: string; name: string } | null;
}

// Compute the affected-areas report for deleting the built-in source playlist `p` (no writes). The numbers
// come straight off the live stores so the confirm modal is accurate, never guessed client-side.
async function buildPlaylistDeleteImpact(p: {
  id: string;
  name: string;
  source: string;
}): Promise<PlaylistDeleteImpact> {
  // 1. The built-in's own channels (keyed by `source`; for a Default playlist id === source).
  const ownChannels = await PlaylistChannel.countDocuments({ source: p.source });

  // 2. Clone copies that originated from this built-in. A clone copy carries `origin` = its provider source
  //    (e.g. 'dulo') and `source` = the clone id; a source-playlist channel has origin:null. So copies of
  //    this built-in are exactly `{ origin: p.source }`. Group the count by clone id (their `source`).
  const cloneCounts = await PlaylistChannel.aggregate<{ _id: string; count: number }>([
    { $match: { origin: p.source } },
    { $group: { _id: '$source', count: { $sum: 1 } } },
  ]);
  const cloneIds = cloneCounts.map((c) => c._id);
  const cloneNames = new Map(
    (await Playlist.find({ id: { $in: cloneIds } }, { _id: 0, id: 1, name: 1 }).lean()).map((c) => [
      c.id,
      c.name,
    ]),
  );
  const affectedClones = cloneCounts
    .map((c) => ({ id: c._id, name: cloneNames.get(c._id) ?? c._id, channelsRemoved: c.count }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // 3. The playlist-bound self-EPG source, if any. The tubi/dlhd afterSync hooks upsert an EpgSource whose
  //    id === the playlist source and playlistBinding:true. dulo is crosswalk-only → no bound source (null).
  const bound = (await EpgSource.findOne(
    { id: p.source, playlistBinding: true },
    { _id: 0, id: 1, name: 1 },
  ).lean()) as Pick<EpgSourceDoc, 'id' | 'name'> | null;

  return {
    playlist: { id: p.id, name: p.name, channels: ownChannels },
    affectedClones,
    boundEpgSource: bound ? { id: bound.id, name: bound.name } : null,
  };
}

// Cascade-delete a built-in (Default) source playlist. Order matters: prune clone copies FIRST (recomposing
// each affected clone), then drop the bound EPG source (its cascade unlinks the built-in's own channels'
// EPG links before we delete those channels), then delete the built-in itself + every owned artifact, then
// rebuild the exports the playlist contributed to so its channels drop out (Global union, or its per-user
// Custom files if it had been switched to a Custom endpoint).
//
// `endpoint`/`url` are load-bearing: PUT /api/playlists/:id lets a source playlist be switched to `custom`
// (the UI exposes the Custom radio for built-ins), which writes per-user files at custom/<customPath>/… and a
// guide sibling, and gates access via allowedCustomPlaylists (NOT allowedPlaylists). So the cleanup must
// branch on the EFFECTIVE endpoint: prune the right disk files AND pull the id from BOTH access lists (a
// built-in id can only be in one, so pulling both is harmless and self-heals a re-provision).
async function cascadeDeleteBuiltinPlaylist(p: {
  id: string;
  name: string;
  source: string;
  endpoint?: string;
  url: string;
}): Promise<void> {
  const src = p.source;
  const endpoint = (p.endpoint ?? 'global').toLowerCase();

  // 1. Prune clone copies that originated from this built-in (only `origin === src`; the rest of each clone
  //    is untouched). Then recompute groups/lastSync + recompose the m3u for each affected clone.
  const affectedCloneIds = await PlaylistChannel.distinct('source', { origin: src });
  await PlaylistChannel.deleteMany({ origin: src });
  for (const cloneId of affectedCloneIds) {
    // The origin-prune can delete a clone-hosted failover group's parent/children — disband degenerates.
    await reconcileFailoverGroups(cloneId).catch((err: Error) =>
      logger.warn('m3u', `failover reconcile after clone prune (${cloneId}) failed: ${err.message}`),
    );
    await Playlist.updateOne({ id: cloneId }, { $set: { lastSync: new Date().toISOString() } });
    // Union-only registry reconcile owns Playlist.groups (preserves operator-created empty groups).
    await reconcileGroupRegistry(cloneId);
    await composeM3u(cloneId).catch((err) =>
      logger.warn('m3u', `compose after clone prune (${cloneId}) failed: ${(err as Error).message}`),
    );
  }

  // 2. The playlist-bound self-EPG source (tubi/dlhd/dami self-EPG; id === src, playlistBinding:true), if any.
  //    cascadeDeleteEpgSource unlinks every playlistchannel linked to it — INCLUDING this built-in's own
  //    channels — and drops its programs/epgchannels/cronjob. dulo has none (crosswalk-only) → no-op.
  const bound = (await EpgSource.findOne(
    { id: src, playlistBinding: true },
    { _id: 0, id: 1 },
  ).lean()) as { id: string } | null;
  if (bound) await cascadeDeleteEpgSource(bound.id);

  // 3. Drop the built-in playlist + every artifact it owns. The channel stores (editable + pristine), its
  //    sync/compose cronjobs, its auth session row,
  //    and its id from every user's access lists. A built-in is hosted Global OR Custom (the endpoint can be
  //    switched), so its id may live in allowedPlaylists (Global) OR allowedCustomPlaylists (Custom) — pull
  //    from BOTH (a built-in id can only be in one; pulling both is harmless and prevents a stale grant from
  //    silently re-applying if the same id is later re-provisioned).
  await Playlist.deleteOne({ id: p.id });
  await PlaylistChannel.deleteMany({ source: src });
  await SourceChannel.deleteMany({ source: src });
  for (const targetType of ['playlist', 'playlist-m3u'] as const) {
    const jobId = cronjobId(targetType, p.id);
    await Cronjob.deleteOne({ _id: jobId });
    removeCronjob(jobId);
  }
  await PlaylistAuth.deleteOne({ _id: src });
  await ProxyConfig.deleteOne({ _id: `app_${p.id}` }); // its Custom proxy override (if any) — same stale-reuse guard as the access lists
  await User.updateMany({}, { $pull: { allowedPlaylists: p.id, allowedCustomPlaylists: p.id } });

  // 4. Rebuild/prune the exports this playlist contributed to (best-effort — a compose hiccup must never fail
  //    the delete), branching on the EFFECTIVE endpoint:
  //    • custom — pruneCustomFile removes the playlist's own per-user Custom files at custom/<customPath>/…
  //      AND its guide sibling (the ONLY pruner of those files; composeGlobal never touches them). Without
  //      this, those files leak on disk and stay served via express.static(composeDir) forever.
  //    • global — recompose the per-user Global union WITHOUT this playlist; its channels just drop out.
  if (endpoint === 'custom') {
    await pruneCustomFile(p.url).catch((err) =>
      logger.warn('m3u', `pruneCustomFile after builtin delete (${p.id}) failed: ${(err as Error).message}`),
    );
  } else {
    await composeGlobal().catch((err) =>
      logger.warn('m3u', `composeGlobal after builtin delete (${p.id}) failed: ${(err as Error).message}`),
    );
  }

  logger.info(
    'playlists',
    `deleted built-in playlist ${p.id} (${endpoint} · cascade: ${affectedCloneIds.length} clone(s) pruned${
      bound ? ', bound EPG source removed' : ''
    })`,
  );
}

// GET /api/playlists/:id/delete-impact — preview the affected-areas report for deleting THIS built-in
// (Default) source playlist, with no writes. Returns the playlist's own channel count (all removed), one
// line per clone that copied channels from it (count to be pruned), and the playlist-bound EPG source (or
// null). 404 if missing; 400 if the playlist isn't a deletable built-in source playlist.
playlistsRouter.get('/:id/delete-impact', requireAdmin, async (req, res, next) => {
  try {
    const p = (await Playlist.findOne(
      { id: req.params.id },
      { _id: 0, id: 1, name: 1, source: 1, builtin: 1 },
    ).lean()) as { id: string; name: string; source?: string | null; builtin?: boolean } | null;
    if (!p) return res.status(404).json({ error: 'not_found' });
    // Only a built-in (Default) source playlist (id === source) supports this cascade. A custom/clone playlist
    // uses its own delete-impact-free flow; a source-unset legacy row has nothing to cascade.
    if (!p.builtin || !p.source) {
      return res.status(400).json({ error: 'not_a_builtin_playlist' });
    }
    res.json(await buildPlaylistDeleteImpact({ id: p.id, name: p.name, source: p.source }));
  } catch (err) {
    next(err);
  }
});

// Delete a playlist and CASCADE its dependents. Two branches:
//   • A user-composed (Clone/Import/HDHomeRun) playlist → cascadeDeleteCustomPlaylist (its channels, per-user
//     m3u files + guide sibling, and allowedCustomPlaylists references — shared with /api/custom-playlists).
//   • A built-in (Default) source playlist → cascadeDeleteBuiltinPlaylist (prune clone copies that originated
//     from it, drop its playlist-bound EPG source, then the playlist + all its artifacts; see GET
//     /:id/delete-impact for the affected-areas preview the confirm modal renders first).
// A source-unset legacy/mock row has no deletable channel store → 400. 404 if missing.
playlistsRouter.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const p = (await Playlist.findOne(
      { id: req.params.id },
      { _id: 0, id: 1, name: 1, source: 1, builtin: 1, endpoint: 1, url: 1 },
    ).lean()) as {
      id: string;
      name: string;
      source?: string | null;
      builtin?: boolean;
      endpoint?: string;
      url: string;
    } | null;
    if (!p) return res.status(404).json({ error: 'not_found' });

    // Built-in (Default) source playlist — id === source. Full cascade (clones + bound EPG + artifacts). The
    // effective endpoint decides which per-user export files are pruned and which access list is cleaned.
    if (p.builtin && p.source) {
      await cascadeDeleteBuiltinPlaylist({
        id: p.id,
        name: p.name,
        source: p.source,
        endpoint: p.endpoint,
        url: p.url,
      });
      return res.status(204).end();
    }

    // User-composed types (Clone/Import/HDHomeRun) own a deletable channel store; a source-unset legacy row
    // does not.
    if (!isCustomPlaylistType(p.source)) {
      return res.status(400).json({ error: 'not_a_custom_playlist' });
    }
    await cascadeDeleteCustomPlaylist(req.params.id as string, p.url);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Manually (re)compose this playlist's stream-ready m3u export now — the on-demand twin of the
// `playlist-m3u` cron tick (both call composeM3u). Source-backed (Default) playlists only.
playlistsRouter.post('/:id/compose', requireAdmin, async (req, res, next) => {
  try {
    const playlist = await Playlist.findOne({ id: req.params.id }, { _id: 0, source: 1 }).lean();
    if (!playlist) return res.status(404).json({ error: 'not_found' });
    if (!playlist.source) return res.status(400).json({ error: 'not_a_source_playlist' });
    const result = await composeM3u(req.params.id as string);
    res.json({ ok: true, endpoint: result.endpoint, path: result.path, channels: result.channelCount });
  } catch (err) {
    next(err);
  }
});

// List a playlist's channels straight from the editable PlaylistChannel store — 1:1 with the runtime
// Channel shape, no projection. Ordered by group then name (the dropped join `order` is no longer used).
// Source-unset (legacy/mock) playlists have no channels in the current model → empty list.
playlistsRouter.get('/:id/channels', async (req: AuthRequest, res, next) => {
  try {
    if (req.user?.role === 'user') {
      // Effective read set = allowedPlaylists ∪ allowedCustomPlaylists (see GET / above) — a user granted a
      // custom playlist must be able to read its channels to stream it.
      const allowed = [
        ...(req.user.allowedPlaylists || []),
        ...(req.user.allowedCustomPlaylists || []),
      ];
      if (!allowed.includes(req.params.id as string)) {
        return res.status(403).json({ error: 'forbidden' });
      }
    }
    const playlist = await Playlist.findOne({ id: req.params.id }).lean();
    if (!playlist) return res.status(404).json({ error: 'not_found' });

    if (!playlist.source) return res.json([]);

    // A custom-type playlist's channel copies are keyed by its id (its `source` is a 'clone'/'file'/'url'/'hdhomerun'
    // type tag, or legacy 'import'); a (Default) source playlist's channels are keyed by its `source`.
    const channelSource = isCustomPlaylistType(playlist.source) ? playlist.id : playlist.source;
    const docs = await PlaylistChannel.find({ source: channelSource }, { _id: 0 })
      .sort({ group: 1, tvg_name: 1 })
      .lean();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// Update one channel's operator-editable fields: status (the 'Active'/'Disabled' enable governor),
// tvg_name (rename), group (regroup), channelNo (displayed channel number), streamEntryUrl (the proxy
// entry url, editable for non-builtin playlists), the 2-factor EPG link tvg_id (= epgchannels.channelId) +
// epg (= epgchannels.source), and epgState (the SEPARATE match-status indicator 'matched'|'unmatched'|null).
// The channel drawer also persists live stream.* detail while open (realtime status, resolution, playability).
// The (tvg_id, epg) pair maps 1:1 to one epgchannels doc — set BOTH together to link a channel to an EPG
// source channel (typically alongside epgState:'matched'), or both null to unlink (epgState:'unmatched').
// Source-derived fields (logo, stream url, playability, derived initials/color) are not editable here — they
// refresh on sync. `channelId` is the deterministic _id ("<source>:<sourceChannelId>"); it must belong to
// this playlist's source.
playlistsRouter.put('/:id/channels/:channelId', requireAdmin, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const $set: Record<string, unknown> = {};
    if (body.status !== undefined) {
      if (body.status !== 'Active' && body.status !== 'Disabled') {
        return res.status(400).json({ error: "status ('Active' | 'Disabled') required" });
      }
      $set.status = body.status;
    }
    // epgState is the match-status indicator — one of three allowed values (distinct from the link factors).
    if (body.epgState !== undefined) {
      if (body.epgState !== 'matched' && body.epgState !== 'unmatched' && body.epgState !== null) {
        return res.status(400).json({ error: "epgState ('matched' | 'unmatched' | null) required" });
      }
      $set.epgState = body.epgState;
    }
    // tvg_id + epg are the 2-factor EPG link (both string | null); set both to link, both null to unlink.
    // channelNo (displayed channel number) and streamEntryUrl are also string | null user edits.
    for (const key of ['tvg_name', 'group', 'channelNo', 'streamEntryUrl', 'tvg_id', 'epg'] as const) {
      if (body[key] !== undefined) {
        if (body[key] !== null && typeof body[key] !== 'string') {
          return res.status(400).json({ error: `${key} (string | null) required` });
        }
        $set[key] = body[key];
      }
    }
    // Live stream.* fields persisted by the channel drawer while open: realtime phase, resolution, playability.
    if (body.stream !== undefined) {
      if (typeof body.stream !== 'object' || body.stream === null) {
        return res.status(400).json({ error: 'stream (object) required' });
      }
      const stream = body.stream as Record<string, unknown>;
      if (stream.status !== undefined) {
        const allowed = ['live', 'establishing', 'buffer', 'failed', null];
        if (!allowed.includes(stream.status as never)) {
          return res
            .status(400)
            .json({ error: "stream.status ('live' | 'establishing' | 'buffer' | 'failed' | null) required" });
        }
        $set['stream.status'] = stream.status;
      }
      if (stream.res !== undefined) {
        if (stream.res !== null && typeof stream.res !== 'string') {
          return res.status(400).json({ error: 'stream.res (string | null) required' });
        }
        $set['stream.res'] = stream.res;
      }
      if (stream.isPlayable !== undefined) {
        if (typeof stream.isPlayable !== 'boolean') {
          return res.status(400).json({ error: 'stream.isPlayable (boolean) required' });
        }
        $set['stream.isPlayable'] = stream.isPlayable;
      }
    }
    if (!Object.keys($set).length) {
      return res.status(400).json({
        error:
          'no editable fields provided (status, tvg_name, group, channelNo, streamEntryUrl, tvg_id, epg, epgState, stream.*)',
      });
    }
    // Failover-group EPG authority: a CHILD mirrors its parent's EPG identity (services/failover.ts), so
    // direct EPG edits on a child are rejected — link/unlink the PARENT instead. (The failover fields
    // themselves are never in the whitelist above; they change only via the /failover-groups routes.)
    const touchesEpg = 'tvg_id' in $set || 'epg' in $set || 'epgState' in $set;
    if (touchesEpg) {
      const target = await PlaylistChannel.findOne(
        { _id: req.params.channelId, source: req.params.id },
        { failoverRole: 1, epg: 1, epgState: 1 },
      ).lean();
      if (target?.failoverRole === 'child') {
        // Issue-level (≥1): the operator tried to edit a failover child's guide directly, but children
        // mirror their parent's EPG — the edit must go to the parent (which cascades).
        logger.warn(
          'failover',
          `rejected EPG edit on failover child ${req.params.channelId} (locked to parent) on ${req.params.id}`,
        );
        return res.status(409).json({ error: 'failover_child_epg_locked' });
      }
      // A grouped PARENT must never land back on the { epg: null, epgState: null } seed state: the
      // fill-only sync writers (fastSelfEpg/crosswalk/adapter self-links) treat that as "untouched" and
      // would re-link the parent directly — bulkWrite, no cascade — silently diverging it from its
      // children. Coerce to 'unmatched' (the same rule inheritedEpgState applies to children).
      if (target?.failoverRole === 'parent') {
        const finalEpg = 'epg' in $set ? $set.epg : target.epg ?? null;
        const finalState = 'epgState' in $set ? $set.epgState : target.epgState ?? null;
        if (finalEpg === null && finalState === null) $set.epgState = 'unmatched';
      }
    }
    const doc = await PlaylistChannel.findOneAndUpdate(
      { _id: req.params.channelId, source: req.params.id },
      { $set },
      { new: true, projection: { _id: 0 } },
    ).lean();
    if (!doc) return res.status(404).json({ error: 'not_found' });
    // EPG link writes (the 2-factor tvg_id/epg pair) surface under the `mapping` category.
    if ('tvg_id' in $set || 'epg' in $set) {
      const linked = $set.tvg_id != null && $set.epg != null;
      logger.info(
        'mapping',
        linked
          ? `linked ${req.params.channelId} → ${String($set.tvg_id)} (${String($set.epg)})`
          : `unlinked ${req.params.channelId}`,
      );
    }
    // A PARENT's EPG edit cascades to its children (any surface — drawer, Mapping, bulk clear — funnels
    // through this route). `_cascadedChildren` rides the response transiently so open screens can merge the
    // children without a refetch; callers that ignore it stay correct (reload() is the safety net).
    if (touchesEpg && doc.failoverRole === 'parent' && doc.failoverGroupId) {
      const children = await cascadeFailoverEpg(String(req.params.id), doc.failoverGroupId, {
        tvg_id: doc.tvg_id,
        epg: doc.epg,
        epgState: doc.epgState ?? null,
      });
      return res.json({ ...doc, _cascadedChildren: children });
    }
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// POST /api/playlists/:id/channels/delete — hard-delete the given channels AND tombstone their ids so a later
// source sync (which re-inserts every still-upstream channel via $setOnInsert) never resurrects them
// (services/tombstones.ts consults Playlist.deletedChannelIds). The tombstone set is cleared only by Restore
// Defaults (resetSource). Deleting a failover parent / last child disbands the degenerate group
// (reconcileFailoverGroups); survivors keep their inherited EPG. Recomposes the exports (best-effort).
// Body { ids: string[] }. requireAdmin (the router is not admin-gated at the mount).
playlistsRouter.post('/:id/channels/delete', requireAdmin, async (req, res, next) => {
  try {
    const source = String(req.params.id);
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.some((c) => typeof c !== 'string' || !c)) {
      return res.status(400).json({ error: 'ids (non-empty string[]) required' });
    }
    const strIds = ids as string[];
    const r = await PlaylistChannel.deleteMany({ source, _id: { $in: strIds } });
    // Tombstone every requested id (even ones that matched nothing this call — a future re-sync must still
    // never re-add them). $addToSet de-dupes against prior deletions.
    await Playlist.updateOne({ id: source }, { $addToSet: { deletedChannelIds: { $each: strIds } } });
    // Deleting a parent or the last child leaves a degenerate failover group — auto-disband (survivors keep
    // inherited EPG). Non-fatal, mirrors the prune reconcile.
    await reconcileFailoverGroups(source).catch((err: Error) =>
      logger.warn('failover', `[${source}] reconcile after channel delete failed (continuing): ${err.message}`),
    );
    // The group registry is union-only, so deleting channels never removes a group name (empty groups persist
    // as first-class). This only refreshes the derived Playlist.groups count.
    await reconcileGroupRegistry(source).catch((err) =>
      logger.warn('playlists', `[${source}] group reconcile after channel delete failed: ${(err as Error).message}`),
    );
    composeM3u(source).catch((err) =>
      logger.warn('m3u', `compose after channel delete (${source}) failed: ${(err as Error).message}`),
    );
    logMilestone('playlists', `deleted ${r.deletedCount ?? 0} channel(s) on ${source}`);
    res.json({ deleted: r.deletedCount ?? 0 });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------
// Channel groups — the first-class, persisted group registry (Playlist.groupDefs, services/groups.ts). A
// group is a NAME + UI `order` that can exist with ZERO channels; channel MEMBERSHIP is the free-text
// PlaylistChannel.group string. These routes are the managed CRUD the SPA's shared GroupPicker + bulk
// "Manage groups" panel drive. Admin-gated inline (the router isn't admin-gated at the mount). Rename/delete
// rewrite channel group labels → recompose; creating an EMPTY group has no export impact → no recompose.
// Compose sorts groups ALPHABETICALLY (m3u/compose.ts), so `order` is a UI ordinal only.
// ---------------------------------------------------------------------------------------------------------

// GET /api/playlists/:id/groups — the registry with a live per-group channel count (empty groups report 0).
// Reconciles on read, which self-heals a legacy playlist whose registry predates this feature.
playlistsRouter.get('/:id/groups', requireAdmin, async (req, res, next) => {
  try {
    res.json(await groupsWithCounts(String(req.params.id)));
  } catch (err) {
    next(err);
  }
});

// POST /api/playlists/:id/groups — create an EMPTY group (no channel assigned). Dedupes case-insensitively
// against the registry. No recompose (an empty group changes no export). Body { name }.
playlistsRouter.post('/:id/groups', requireAdmin, async (req, res, next) => {
  try {
    const source = String(req.params.id);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name (non-empty string) required' });
    const pl = (await Playlist.findOne({ id: source }, { groupDefs: 1, _id: 0 }).lean()) as
      | { groupDefs?: Array<{ name: string; order: number }> }
      | null;
    if (!pl) return res.status(404).json({ error: 'not_found' });
    const defs = pl.groupDefs ?? [];
    if (defs.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: 'group_exists' });
    }
    const order = defs.reduce((m, g) => Math.max(m, g.order ?? 0), -1) + 1;
    await Playlist.updateOne(
      { id: source },
      { $push: { groupDefs: { name, order } }, $set: { groups: defs.length + 1 } },
    );
    res.status(201).json(await groupsWithCounts(source));
  } catch (err) {
    next(err);
  }
});

// PUT /api/playlists/:id/groups/:name — rename a group: relabel every member channel (group old → new) and
// rewrite the registry entry in place (keeping its order, so oldName does NOT linger as an empty group).
// Rejects a collision with an existing name. Recomposes (EXTINF group-title changed). Body { name: newName }.
playlistsRouter.put('/:id/groups/:name', requireAdmin, async (req, res, next) => {
  try {
    const source = String(req.params.id);
    const oldName = String(req.params.name);
    const newName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!newName) return res.status(400).json({ error: 'name (non-empty string) required' });
    const pl = (await Playlist.findOne({ id: source }, { groupDefs: 1, _id: 0 }).lean()) as
      | { groupDefs?: Array<{ name: string; order: number }> }
      | null;
    if (!pl) return res.status(404).json({ error: 'not_found' });
    const defs = pl.groupDefs ?? [];
    if (
      newName.toLowerCase() !== oldName.toLowerCase() &&
      defs.some((g) => g.name.toLowerCase() === newName.toLowerCase())
    ) {
      return res.status(409).json({ error: 'group_exists' });
    }
    await PlaylistChannel.updateMany({ source, group: oldName }, { $set: { group: newName } });
    const renamed = defs.map((g) => (g.name === oldName ? { name: newName, order: g.order } : g));
    await Playlist.updateOne({ id: source }, { $set: { groupDefs: renamed } });
    await reconcileGroupRegistry(source);
    composeM3u(source).catch((err) =>
      logger.warn('m3u', `compose after group rename (${source}) failed: ${(err as Error).message}`),
    );
    res.json(await groupsWithCounts(source));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/playlists/:id/groups/:name — remove a group: clear it on every member channel (group → null;
// the channels stay) and drop the registry entry. The ONLY path that removes a name (sync reconcile never
// does). Recomposes.
playlistsRouter.delete('/:id/groups/:name', requireAdmin, async (req, res, next) => {
  try {
    const source = String(req.params.id);
    const name = String(req.params.name);
    await PlaylistChannel.updateMany({ source, group: name }, { $set: { group: null } });
    await Playlist.updateOne({ id: source }, { $pull: { groupDefs: { name } } });
    await reconcileGroupRegistry(source);
    composeM3u(source).catch((err) =>
      logger.warn('m3u', `compose after group delete (${source}) failed: ${(err as Error).message}`),
    );
    res.json(await groupsWithCounts(source));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------------------------------------
// Failover groups — one 'parent' + ordered 'child' backups per group, stored as three fields on the
// member PlaylistChannel docs (models/PlaylistChannel.ts). These routes are the ONLY writers of those
// fields (they are deliberately absent from the generic edit whitelist above): the multi-doc invariants
// (single parent, parent→child EPG inheritance) must not half-apply from client fan-out. The playlists
// router is NOT admin-gated at the mount (index.ts adminOnlyRoutes), so each route adds requireAdmin.
// Registration order vs :param routes is irrelevant here — these are :id-scoped literal sub-paths that
// collide with nothing (Express matches per segment).
// ---------------------------------------------------------------------------------------------------------

// PUT /api/playlists/:id/failover-groups — create or replace one group. Body { groupId?, parentId,
// childIds: string[] } (child order = array order). Omitted groupId = a new group (opaque randomUUID —
// NEVER parent-derived, so a later parent swap doesn't churn the key). Members must all belong to this
// playlist. A member that is currently the PARENT of a different group → 409 (the client must disband
// that group first); a foreign CHILD is silently moved (its donor group is reconciled below). Children
// inherit the parent's EPG identity at save (services/failover.ts inheritedEpgState — never null on a
// child). Returns { groupId, parent, children } (children failoverOrder-sorted, authoritative post-state).
playlistsRouter.put('/:id/failover-groups', requireAdmin, async (req, res, next) => {
  try {
    const source = String(req.params.id);
    const body = req.body ?? {};
    const parentId: unknown = body.parentId;
    const childIds: unknown = body.childIds;
    if (typeof parentId !== 'string' || !parentId) {
      return res.status(400).json({ error: 'parentId (string) required' });
    }
    if (
      !Array.isArray(childIds) ||
      childIds.length < 1 ||
      childIds.some((c) => typeof c !== 'string' || !c)
    ) {
      return res.status(400).json({ error: 'childIds (non-empty string[]) required' });
    }
    if (new Set(childIds).size !== childIds.length) {
      return res.status(400).json({ error: 'childIds must be unique' });
    }
    if (childIds.includes(parentId)) {
      return res.status(400).json({ error: 'parentId must not appear in childIds' });
    }
    if (body.groupId !== undefined && (typeof body.groupId !== 'string' || !body.groupId)) {
      return res.status(400).json({ error: 'groupId (string) required when provided' });
    }
    const groupId: string = body.groupId ?? randomUUID();

    const memberIds = [parentId, ...(childIds as string[])];
    const members = await PlaylistChannel.find({ _id: { $in: memberIds }, source }).lean();
    if (members.length !== memberIds.length) {
      return res.status(404).json({ error: 'member_not_found' });
    }
    const byId = new Map(members.map((m) => [String(m._id), m]));
    const parent = byId.get(parentId)!;

    // A member that currently HEADS a different group would leave that group silently headless — force the
    // explicit disband first. (Foreign children are fair game; reconcile heals their donor groups below.)
    const foreignParent = members.find(
      (m) => m.failoverRole === 'parent' && m.failoverGroupId && m.failoverGroupId !== groupId,
    );
    if (foreignParent) {
      // Issue-level (≥1): a requested member already heads another group — the operator must disband that
      // group first, so the save is refused rather than silently leaving it headless.
      logger.warn(
        'failover',
        `group ${groupId} save on ${source} refused: member ${String(foreignParent._id)} heads another group`,
      );
      return res
        .status(409)
        .json({ error: 'member_is_foreign_parent', channelId: String(foreignParent._id) });
    }

    const inheritedState = inheritedEpgState({
      tvg_id: parent.tvg_id,
      epg: parent.epg,
      epgState: parent.epgState ?? null,
    });
    // One ORDERED bulkWrite (bulkWrite is NOT transactional — order it so an interrupted write leaves a
    // PARENTLESS group, which reconcileFailoverGroups already knows how to disband): clear members that
    // left this group → write children (EPG inheritance at save) → write the parent LAST.
    const ops: Parameters<typeof PlaylistChannel.bulkWrite>[0] = [
      {
        updateMany: {
          filter: { source, failoverGroupId: groupId, _id: { $nin: memberIds } },
          update: { $set: { failoverGroupId: null, failoverRole: null, failoverOrder: null } },
        },
      },
      ...(childIds as string[]).map((cid, i) => ({
        updateOne: {
          filter: { _id: cid, source },
          update: {
            $set: {
              failoverGroupId: groupId,
              failoverRole: 'child',
              failoverOrder: i,
              tvg_id: parent.tvg_id,
              epg: parent.epg,
              epgState: inheritedState,
            },
          },
        },
      })),
      {
        updateOne: {
          filter: { _id: parentId, source },
          update: {
            $set: {
              failoverGroupId: groupId,
              failoverRole: 'parent',
              failoverOrder: null,
              // A grouped parent never keeps the { epg:null, epgState:null } seed state — the fill-only
              // sync writers would re-link it directly (no cascade) and diverge it from its children.
              // inheritedEpgState is 'matched'/'unmatched' (never null), a no-op for a linked parent.
              epgState: inheritedState,
            },
          },
        },
      },
    ];
    await PlaylistChannel.bulkWrite(ops, { ordered: true });
    // Level-3 lineage: the members were written (children inherit the parent's EPG state at save).
    logTrace(
      'failover',
      `group ${groupId} bulkWrite on ${source}: parent ${parentId}, ${childIds.length} child(ren), epgState '${inheritedState}'`,
    );

    // Self-heal: donor groups that lost children above, plus any race leftovers (two admins saving
    // overlapping groups can violate single-parent — reconcile disbands such groups; groups are
    // source-scoped so one source-wide pass covers every donor).
    await reconcileFailoverGroups(source);

    const after = await PlaylistChannel.find({ source, failoverGroupId: groupId }, { _id: 0 }).lean();
    const parents = after.filter((m) => m.failoverRole === 'parent');
    const children = after
      .filter((m) => m.failoverRole === 'child')
      .sort((a, b) => (a.failoverOrder ?? 0) - (b.failoverOrder ?? 0));
    if (parents.length !== 1 || children.length < 1) {
      // A concurrent mutation raced us and reconcile disbanded the result — surface it rather than
      // returning a half-group the UI would render as authoritative. Issue-level (≥1) — a lost write.
      logger.error(
        'failover',
        `group ${groupId} save on ${source} lost to a concurrent mutation (parents ${parents.length}, children ${children.length})`,
      );
      return res.status(500).json({ error: 'failover_group_write_conflict' });
    }
    // Milestone (≥2): the group was created/replaced.
    logMilestone(
      'failover',
      `group ${groupId} saved on ${source}: parent ${parentId}, ${children.length} child(ren)`,
    );
    // Children just left the export — refresh the playlist's composed files now rather than waiting for
    // the next compose tick (best-effort, mirrors the clone-prune recompose above).
    composeM3u(source).catch((err) =>
      logger.warn('m3u', `compose after failover-group save (${source}) failed: ${(err as Error).message}`),
    );
    res.json({ groupId, parent: parents[0], children });
  } catch (err) {
    next(err);
  }
});

// PUT /api/playlists/:id/failover-groups/:groupId/reorder — rewrite child order to the given array order
// (near-clone of the epgSources reorder). No EPG cascade (order doesn't change identity). The id set must
// equal the group's current children — a stale client list would silently drop/duplicate ordinals.
playlistsRouter.put('/:id/failover-groups/:groupId/reorder', requireAdmin, async (req, res, next) => {
  try {
    const source = String(req.params.id);
    const groupId = String(req.params.groupId);
    const childIds: unknown = req.body?.childIds;
    if (
      !Array.isArray(childIds) ||
      childIds.length < 1 ||
      childIds.some((c) => typeof c !== 'string' || !c) ||
      new Set(childIds).size !== childIds.length
    ) {
      return res.status(400).json({ error: 'childIds (unique non-empty string[]) required' });
    }
    const current = await PlaylistChannel.find(
      { source, failoverGroupId: groupId, failoverRole: 'child' },
      { _id: 1 },
    ).lean();
    const currentIds = new Set(current.map((c) => String(c._id)));
    if (currentIds.size !== childIds.length || (childIds as string[]).some((c) => !currentIds.has(c))) {
      // Level-3 lineage: a stale client child set (someone else mutated the group) — the reorder is refused.
      logTrace('failover', `group ${groupId} reorder on ${source} refused: child set mismatch`);
      return res.status(400).json({ error: 'child_set_mismatch' });
    }
    await PlaylistChannel.bulkWrite(
      (childIds as string[]).map((cid, i) => ({
        updateOne: {
          filter: { _id: cid, source, failoverGroupId: groupId },
          update: { $set: { failoverOrder: i } },
        },
      })),
    );
    // Milestone (≥2): the child backup order changed (the route logged nothing before this).
    logMilestone(
      'failover',
      `group ${groupId} reordered on ${source} (${(childIds as string[]).length} child(ren))`,
    );
    const after = await PlaylistChannel.find({ source, failoverGroupId: groupId }, { _id: 0 }).lean();
    const parent = after.find((m) => m.failoverRole === 'parent') ?? null;
    const children = after
      .filter((m) => m.failoverRole === 'child')
      .sort((a, b) => (a.failoverOrder ?? 0) - (b.failoverOrder ?? 0));
    res.json({ groupId, parent, children });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/playlists/:id/failover-groups/:groupId — disband. Members lose the grouping but KEEP the
// inherited EPG identity (clearing a link is the explicit unlink action, not a side effect). Children
// re-enter the export, so recompose. 404 for an unknown group; 204 on success.
playlistsRouter.delete('/:id/failover-groups/:groupId', requireAdmin, async (req, res, next) => {
  try {
    const source = String(req.params.id);
    const groupId = String(req.params.groupId);
    const r = await PlaylistChannel.updateMany(
      { source, failoverGroupId: groupId },
      { $set: { failoverGroupId: null, failoverRole: null, failoverOrder: null } },
    );
    if (r.matchedCount === 0) return res.status(404).json({ error: 'not_found' });
    // Milestone (≥2): the group was disbanded (members keep inherited EPG, lose only the grouping).
    logMilestone('failover', `group ${groupId} disbanded on ${source} (${r.matchedCount} member(s))`);
    composeM3u(source).catch((err) =>
      logger.warn('m3u', `compose after failover-group disband (${source}) failed: ${(err as Error).message}`),
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
