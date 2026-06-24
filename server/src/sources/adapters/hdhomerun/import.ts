// HDHomeRun catalog import/sync — turn a local tuner's lineup into a real, playable custom playlist. An
// HDHomeRun playlist is a user-composed playlist of TYPE 'hdhomerun' (a sibling of 'clone'/'import'): a
// Playlist row (`source:'hdhomerun'`, `endpoint:'custom'`, `interval:'none'`, plus the device fields) whose
// channels are PlaylistChannel docs keyed by the playlist's own id, each with `origin:'hdhomerun'` so it
// streams through the hdhomerun remux adapter (/api/v1/hdhomerun/…). UNLIKE a static 'import', an HDHomeRun
// playlist has a LIVE re-syncable upstream (the device), so this module is shared by create AND the manual
// "Sync now" (POST /api/custom-playlists/:id/sync). Management (rename / delete) rides the shared
// /api/custom-playlists routes (it matches the 'hdhomerun' type tag). See restapi-sources/SKILL.md.

import { Playlist } from '../../../models/Playlist.js';
import { PlaylistChannel, type PlaylistChannelDoc } from '../../../models/PlaylistChannel.js';
import { composeM3u } from '../../../m3u/compose.js';
import { logoColorFor, initialsFor } from '../../toPlaylistChannel.js';
import { logger } from '../../core/logger.js';
import { fetchDiscover, fetchLineup, type HdhrLineupEntry } from './lineup.js';
import { registerDevice } from './remux.js';

export const HDHR_SOURCE = 'hdhomerun'; // Playlist.source TYPE TAG (channels keyed by the playlist id, like 'clone'/'import')
export const HDHR_ORIGIN = 'hdhomerun'; // PlaylistChannel.origin → routes the stream through the hdhomerun remux adapter

// One device lineup entry → a PlaylistChannel doc. Mirrors sources/toPlaylistChannel.ts (explicit nulls for
// fields the device has no equivalent for; deterministic logoColor/initials). Standardized for reliable
// playback: GuideNumber → the displayed channel number; DRM channels are seeded Disabled (unplayable, but
// kept visible + reversible); the device gives no EPG/group/logo, so those stay explicit null (the OTA
// channel can be linked to a Gracenote EPG source later via Channel Mapping). `_id` is keyed by the canonical
// GuideNumber so a re-sync is idempotent and preserves the operator's edits on a survivor.
function toHdhrChannel(e: HdhrLineupEntry, importId: string): PlaylistChannelDoc {
  const _id = `${importId}:${e.guideNumber}`;
  return {
    _id,
    id: _id,
    tvg_name: e.guideName,
    group: null,
    channel: null,
    channelNo: e.guideNumber,
    tvg_id: null,
    epg: null,
    epgState: null,
    status: e.drm ? 'Disabled' : 'Active',
    source: importId,
    origin: HDHR_ORIGIN,
    logoColor: logoColorFor(_id),
    logoUrl: null,
    streamEntryUrl: e.url,
    stream: { initials: initialsFor(e.guideName), isPlayable: !e.drm, res: null, status: null, probe: null },
  };
}

// Upsert the device's channels with the SAME merge split as a source sync (seed.ts) / the m3u import
// (routes/import.ts): device-owned routing/display fields go in $set (refreshed every sync); user-editable
// fields ($setOnInsert) are written once and PRESERVED across re-syncs. Then PRUNE channels that vanished
// from the lineup (a survivor keeps its edits; a removed channel is dropped) — mirrors syncLive's prune.
async function upsertHdhrChannels(entries: HdhrLineupEntry[], importId: string): Promise<void> {
  const seen = new Set<string>();
  const ops: unknown[] = [];
  for (const e of entries) {
    const pc = toHdhrChannel(e, importId);
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
            streamEntryUrl: pc.streamEntryUrl,
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
            logoUrl: pc.logoUrl,
            'stream.initials': pc.stream.initials,
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
  if (ops.length) await PlaylistChannel.bulkWrite(ops as any[]);
  // Prune channels no longer in the device lineup (preserve edits on the survivors).
  await PlaylistChannel.deleteMany({ source: importId, _id: { $nin: [...seen] } });
}

// Re-fetch a device's lineup and reconcile its playlist's channels. Shared by create + the manual "Sync now".
// Refreshes the persisted device identity (name/tuner count) too — a firmware change can alter them. Throws on
// a missing device url, an unreachable device, or a bad lineup (the caller maps it to 4xx/502). Recomposes the
// playlist's per-user m3u files (best-effort).
export async function syncHdhrPlaylist(id: string): Promise<{ channels: number; groups: number }> {
  // Case-insensitive `source` match so a pre-normalization 'HDHomeRun' doc still resolves (the boot
  // migration normalizes it to 'hdhomerun', but the /sync route may run before that on a stale DB).
  const pl = (await Playlist.findOne(
    { id, source: { $regex: `^${HDHR_SOURCE}$`, $options: 'i' } },
    { _id: 0, deviceUrl: 1, name: 1 },
  ).lean()) as { deviceUrl?: string | null; name?: string } | null;
  if (!pl) throw new Error('not_an_hdhomerun_playlist');
  const base = pl.deviceUrl ?? '';
  if (!base) throw new Error('missing_device_url');

  const disc = await fetchDiscover(base);
  registerDevice(base, disc.tunerCount); // keep the remux per-device tuner cap current
  const lineup = await fetchLineup(base);
  await upsertHdhrChannels(lineup, id);

  const channels = (await PlaylistChannel.find({ source: id }, { group: 1 }).lean()) as Array<{
    group: string | null;
  }>;
  const groups = new Set(channels.map((c) => c.group).filter((g): g is string => g != null)).size;
  await Playlist.updateOne(
    { id },
    {
      $set: {
        deviceTunerCount: disc.tunerCount,
        deviceName: disc.friendlyName,
        groups,
        lastSync: new Date().toISOString(),
      },
    },
  );

  await composeM3u(id).catch((err) =>
    logger.warn('m3u', `compose after HDHomeRun sync failed: ${(err as Error).message}`),
  );
  logger.info('import', `synced HDHomeRun "${pl.name ?? id}" (${id}) · ${channels.length} channel(s)`);
  return { channels: channels.length, groups };
}
