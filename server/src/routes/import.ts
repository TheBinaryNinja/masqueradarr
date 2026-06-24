import { Router } from 'express';
import { createHash } from 'node:crypto';
import { Playlist } from '../models/Playlist.js';
import { PlaylistChannel, type PlaylistChannelDoc } from '../models/PlaylistChannel.js';
import { parseM3u, type ParsedM3uEntry } from '../m3u/parse.js';
import { composeM3u } from '../m3u/compose.js';
import { normalizeEndpointPath, isReservedEndpointPath } from '../m3u/paths.js';
import { logoColorFor, initialsFor } from '../sources/toPlaylistChannel.js';
import { logger } from '../sources/core/logger.js';
import { cascadeDeleteCustomPlaylist, sanitizeName, resolveDomain, groupCount } from './customPlaylists.js';
import {
  normalizeDeviceBase,
  fetchDiscover,
  fetchLineupM3uText,
} from '../sources/adapters/hdhomerun/lineup.js';
import { syncHdhrPlaylist, HDHR_SOURCE } from '../sources/adapters/hdhomerun/import.js';

// M3U IMPORT — turn an uploaded (or remotely-fetched) `.m3u`/`.m3u8` into a real, playable playlist. An
// imported playlist is a user-composed playlist tagged by its ORIGIN (a sibling of a 'clone'): a Playlist row
// (`source:'file'` for an uploaded .m3u or `source:'url'` for a remote-URL fetch, `endpoint:'custom'`,
// `interval:'none'`) whose channels are PlaylistChannel docs keyed by the import's own id, each with
// `origin:'direct'` so it streams through the synthetic `direct` proxy adapter (/api/v1/direct/…) — the SSRF
// gate stays centralized and the raw upstream is never emitted. Management (rename / append / remove / delete)
// rides the shared /api/custom-playlists routes (it matches the file/url — and legacy 'import' — type tags).
// Admin-only (mounted under adminOnlyRoutes). See .claude/skills/{restapi,schemas,m3u}/SKILL.md.

export const importRouter = Router();

// Playlist.source TYPE TAG for an imported playlist (channels keyed by the playlist id, like 'clone'): 'file'
// when the body carried inline `content` (an upload), 'url' when it carried a remote `url` to fetch. The
// legacy 'import' tag (pre-split) is no longer assigned but is still recognized for existing rows.
const importSourceTag = (body: Record<string, unknown>): 'file' | 'url' =>
  typeof body.url === 'string' && body.url.trim() ? 'url' : 'file';
const DIRECT_ORIGIN = 'direct'; // PlaylistChannel.origin → routes through the synthetic `direct` adapter
const MAX_REMOTE_BYTES = 25 * 1024 * 1024; // cap a remote-URL fetch (mirrors the route's 25mb body limit)

// Deterministic, stable per-URL channel key → idempotent re-import + de-dupe of repeated URLs in one file.
function channelKey(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 16);
}

// One parsed EXTINF entry → a PlaylistChannel doc. Mirrors sources/toPlaylistChannel.ts (explicit nulls for
// fields the file has no equivalent for; deterministic logoColor/initials) but for an imported channel:
// `source` = the import id, `origin` = 'direct' (stream routing), `streamEntryUrl` = the raw .m3u URL.
function toImportChannel(e: ParsedM3uEntry, importId: string): PlaylistChannelDoc {
  const _id = `${importId}:${channelKey(e.url)}`;
  return {
    _id,
    id: _id,
    tvg_name: e.name,
    group: e.groupTitle,
    channel: null,
    channelNo: e.tvgChno,
    tvg_id: e.tvgId, // EPG link factor 1 (carried from tvg-id); `epg` stays null until mapped in Channel Mapping
    epg: null,
    epgState: null,
    status: 'Active',
    source: importId,
    origin: DIRECT_ORIGIN,
    logoColor: logoColorFor(_id),
    logoUrl: e.tvgLogo,
    streamEntryUrl: e.url,
    stream: { initials: initialsFor(e.name), isPlayable: true, res: null, status: null, probe: null },
  };
}

// Upsert imported channels with the SAME merge split as a source sync (seed.ts upsertPlaylistChannels):
// file-owned routing/display fields go in $set (refreshed on a re-import into the same id); user-editable
// fields ($setOnInsert) are written once and preserved. De-dupes repeated URLs within the file by _id.
async function upsertImportChannels(entries: ParsedM3uEntry[], importId: string): Promise<void> {
  if (!entries.length) return;
  const seen = new Set<string>();
  const ops: unknown[] = [];
  for (const e of entries) {
    const pc = toImportChannel(e, importId);
    if (seen.has(pc._id)) continue;
    seen.add(pc._id);
    ops.push({
      updateOne: {
        filter: { _id: pc._id },
        update: {
          $set: {
            source: pc.source,
            origin: pc.origin,
            logoColor: pc.logoColor,
            logoUrl: pc.logoUrl,
            streamEntryUrl: pc.streamEntryUrl,
            'stream.initials': pc.stream.initials,
            'stream.isPlayable': pc.stream.isPlayable,
          },
          $setOnInsert: {
            id: pc.id,
            tvg_name: pc.tvg_name,
            group: pc.group,
            channel: pc.channel,
            channelNo: pc.channelNo,
            tvg_id: pc.tvg_id,
            epg: pc.epg,
            epgState: pc.epgState,
            status: pc.status,
            'stream.res': pc.stream.res,
            'stream.status': pc.stream.status,
            'stream.probe': pc.stream.probe,
          },
        },
        upsert: true,
      },
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await PlaylistChannel.bulkWrite(ops as any[]);
}

// Re-fetch a remote-URL import's stored upstream and reconcile its channels — the manual "Sync now" (and the
// scheduled sync) twin of POST /api/import/m3u, for a playlist of TYPE 'url'. Reads the persisted `remoteUrl`
// (NOT a transient body value), re-parses, upserts (preserving the operator's per-channel edits via
// $setOnInsert) and PRUNES channels whose URL vanished upstream (mirrors syncLive / syncHdhrPlaylist), then
// recomputes groups, advances lastSync, and recomposes the per-user m3u files. A 'url' playlist with no stored
// remoteUrl (a pre-field legacy row) → throws 'missing_remote_url' (the caller maps it to a 4xx/5xx).
export async function syncUrlPlaylist(id: string): Promise<{ channels: number; groups: number }> {
  // Case-insensitive `source` match so a pre-normalization 'Url' doc still resolves before the boot migration.
  const pl = (await Playlist.findOne(
    { id, source: { $regex: '^url$', $options: 'i' } },
    { _id: 0, remoteUrl: 1, name: 1 },
  ).lean()) as { remoteUrl?: string | null; name?: string } | null;
  if (!pl) throw new Error('not_a_url_playlist');
  const remote = (pl.remoteUrl ?? '').trim();
  if (!remote) throw new Error('missing_remote_url');

  const loaded = await readM3uText({ url: remote });
  if (!loaded.ok) throw new Error(loaded.error);
  const { entries } = parseM3u(loaded.text);
  if (!entries.length) throw new Error('no_channels');

  await upsertImportChannels(entries, id);
  // Prune channels that vanished from the upstream m3u (a survivor keeps its edits; a removed channel is
  // dropped) — the live ids are this run's deterministic per-URL keys.
  const liveIds = [...new Set(entries.map((e) => `${id}:${channelKey(e.url)}`))];
  await PlaylistChannel.deleteMany({ source: id, _id: { $nin: liveIds } });

  const channels = (await PlaylistChannel.find({ source: id }, { group: 1 }).lean()) as Array<{
    group: string | null;
  }>;
  const groups = groupCount(channels);
  await Playlist.updateOne({ id }, { $set: { groups, lastSync: new Date().toISOString() } });

  await composeM3u(id).catch((err) =>
    logger.warn('m3u', `compose after remote-url sync failed: ${(err as Error).message}`),
  );
  logger.info('import', `synced remote-url "${pl.name ?? id}" (${id}) · ${channels.length} channel(s)`);
  return { channels: channels.length, groups };
}

// Resolve the raw m3u text from the request body: inline `content`, else an SSRF-gated remote `url` fetch.
// Returns a discriminated result so the handler maps a bad input to 400 (never a 500).
type TextResult = { ok: true; text: string } | { ok: false; status: number; error: string };
async function readM3uText(body: Record<string, unknown>): Promise<TextResult> {
  const content = typeof body.content === 'string' ? body.content : '';
  if (content.trim()) return { ok: true, text: content };

  const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
  if (!rawUrl) return { ok: false, status: 400, error: 'content (string) or url (string) required' };

  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, status: 400, error: 'invalid_url' };
  }
  // Protocol gate only. Private/loopback/link-local M3U URLs are intentionally allowed: import is an
  // admin-only, self-hosted feature and the source list often lives on the LAN (an HDHomeRun tuner, a local
  // Channels/Plex/xTeVe server, another box on 192.168/10.x). This mirrors the `direct` proxy, which now
  // also reaches private hosts for the per-channel stream hops.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, status: 400, error: 'url_not_allowed' };
  }
  try {
    const resp = await fetch(rawUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'Masqueradarr-import/1.0', Accept: '*/*' },
    });
    if (!resp.ok) return { ok: false, status: 400, error: `fetch_failed_${resp.status}` };
    const len = Number(resp.headers.get('content-length') || 0);
    if (len > MAX_REMOTE_BYTES) return { ok: false, status: 400, error: 'remote_too_large' };
    const text = await resp.text();
    if (text.length > MAX_REMOTE_BYTES) return { ok: false, status: 400, error: 'remote_too_large' };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, status: 400, error: `fetch_failed: ${(err as Error).message}` };
  }
}

// POST /api/import/m3u/preview — parse only (NO persist): the honest channel/group counts the screen shows
// before the user confirms. Accepts the same { content | url } body as the create route.
importRouter.post('/m3u/preview', async (req, res, next) => {
  try {
    const loaded = await readM3uText(req.body ?? {});
    if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.error });
    const { entries } = parseM3u(loaded.text);
    res.json({
      channels: entries.length,
      groups: groupCount(entries.map((e) => ({ group: e.groupTitle }))),
      sample: entries.slice(0, 8).map((e) => ({ name: e.name, group: e.groupTitle })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/import/m3u — parse + persist an imported playlist (Playlist row + its channels) + compose its
// per-user m3u files. Body: { name, content? , url? }.
importRouter.post('/m3u', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name (non-empty string) required' });

    const loaded = await readM3uText(body);
    if (!loaded.ok) return res.status(loaded.status).json({ error: loaded.error });
    const { entries } = parseM3u(loaded.text);
    if (!entries.length) return res.status(400).json({ error: 'no_channels' });

    // Derive a filesystem/url-safe id from the name; reject the reserved export-tree prefixes; disambiguate
    // against any existing Playlist id (mirrors the clone-create contract in customPlaylists.ts).
    const base = sanitizeName(name);
    if (isReservedEndpointPath(base)) return res.status(400).json({ error: 'reserved_path' });
    let id = base;
    for (let n = 2; await Playlist.exists({ id }); n++) id = `${base}${n}`;

    const domain = await resolveDomain();
    const path = normalizeEndpointPath(id);
    const url = path ? `${domain}/${path}` : domain;
    const now = new Date().toISOString();

    // Persist the channels FIRST (so groups can be counted), then the Playlist row.
    await upsertImportChannels(entries, id);
    const channels = (await PlaylistChannel.find({ source: id }, { group: 1 }).lean()) as Array<{
      group: string | null;
    }>;

    const tag = importSourceTag(body);
    await Playlist.create({
      id,
      name,
      source: tag,
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
      // Persist the upstream URL ONLY for a remote-URL import (source:'url') so a later manual/scheduled Sync
      // can re-fetch from it; a file (inline content) upload has no re-fetchable source → explicit null.
      remoteUrl: tag === 'url' ? (typeof body.url === 'string' ? body.url.trim() : null) : null,
    });

    // Best-effort: fan the import's per-user m3u files + guide sibling out now (non-fatal, mirrors clone create).
    await composeM3u(id).catch((err) =>
      logger.warn('m3u', `compose after import create failed: ${(err as Error).message}`),
    );

    logger.info('import', `imported "${name}" (${id}) · ${channels.length} channel(s)`);
    res.status(201).json({
      id,
      name,
      slug: id,
      channels: channels.length,
      groups: groupCount(channels),
      updated: now,
    });
  } catch (err) {
    next(err);
  }
});

// ── HDHomeRun import ─────────────────────────────────────────────────────────
// A local HDHomeRun tuner is imported as a custom playlist of TYPE 'HDHomeRun' (channels keyed by the
// playlist id, each origin:'hdhomerun' so its raw MPEG-TS streams through the hdhomerun remux adapter at
// /api/v1/hdhomerun/…). UNLIKE a static m3u Import it has a LIVE upstream (the device), re-syncable via
// POST /api/custom-playlists/:id/sync. The fetch/parse + channel reconcile live in
// sources/adapters/hdhomerun/{lineup,import}.ts. Admin-only (this router is mounted under adminOnlyRoutes).

// POST /api/import/hdhomerun/test — the modal's "Test" button: a reachability + lineup check (NO persist).
// Pings discover.json (device identity + tuner count), then fetches lineup.m3u and parses it (shared m3u
// parser) for a human-readable summary. A user-supplied device that's offline/unreachable/garbage is a 400
// (bad input), never a server 500.
importRouter.post('/hdhomerun/test', async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const base = normalizeDeviceBase(typeof body.address === 'string' ? body.address : '');
    if (!base) return res.status(400).json({ error: 'invalid_address' });
    const disc = await fetchDiscover(base);
    const { entries } = parseM3u(await fetchLineupM3uText(base));
    res.json({
      deviceName: disc.friendlyName,
      model: disc.modelNumber,
      tunerCount: disc.tunerCount,
      channelCount: entries.length,
      sampleChannels: entries.slice(0, 8).map((e) => ({ name: e.name })),
    });
  } catch (err) {
    res.status(400).json({ error: `device_unreachable: ${(err as Error).message}` });
  }
});

// POST /api/import/hdhomerun — create an HDHomeRun playlist (Playlist row + device fields) and sync its
// channels from the device lineup. Body: { name, address }.
importRouter.post('/hdhomerun', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name (non-empty string) required' });
    const base = normalizeDeviceBase(typeof body.address === 'string' ? body.address : '');
    if (!base) return res.status(400).json({ error: 'invalid_address' });

    // Confirm the device is reachable BEFORE creating a row (a bad/offline device → 400, not a ghost playlist).
    let disc;
    try {
      disc = await fetchDiscover(base);
    } catch (err) {
      return res.status(400).json({ error: `device_unreachable: ${(err as Error).message}` });
    }

    // Derive a filesystem/url-safe id from the name; reject reserved prefixes; disambiguate (mirrors m3u import).
    const slug = sanitizeName(name);
    if (isReservedEndpointPath(slug)) return res.status(400).json({ error: 'reserved_path' });
    let id = slug;
    for (let n = 2; await Playlist.exists({ id }); n++) id = `${slug}${n}`;

    const domain = await resolveDomain();
    const path = normalizeEndpointPath(id);
    const url = path ? `${domain}/${path}` : domain;
    const now = new Date().toISOString();

    await Playlist.create({
      id,
      name,
      source: HDHR_SOURCE,
      endpoint: 'custom',
      interval: 'none',
      url,
      groups: 0,
      state: true,
      status: 'good',
      auto: false,
      builtin: false,
      authentication: false,
      isAuthenticated: false,
      lastSync: now,
      deviceUrl: base,
      deviceName: disc.friendlyName,
      deviceTunerCount: disc.tunerCount,
    });

    // Pull the lineup into channels (+ recompute groups, refresh device identity, compose). On failure roll
    // back the just-created row so an empty ghost playlist is never left behind.
    let result: { channels: number; groups: number };
    try {
      result = await syncHdhrPlaylist(id);
    } catch (err) {
      await cascadeDeleteCustomPlaylist(id, url).catch(() => {});
      return res.status(400).json({ error: `lineup_failed: ${(err as Error).message}` });
    }

    logger.info('import', `imported HDHomeRun "${name}" (${id}) · ${result.channels} channel(s)`);
    res.status(201).json({ id, name, slug: id, channels: result.channels, groups: result.groups, updated: now });
  } catch (err) {
    next(err);
  }
});
