// Local Now catalog import/sync — turn a market's lineup into a real, playable custom playlist. A Local Now
// playlist is a user-composed playlist of TYPE 'local' (a sibling of 'hdhomerun'): a Playlist row
// (`source:'local'`, `endpoint:'custom'`, `interval:'none'`, plus the market fields) whose channels are
// PlaylistChannel docs keyed by the playlist's own id, each with `origin:'local'` so it resolves-on-demand
// through the synthetic `local` adapter (/api/v1/local/<enc localnow://…>). UNLIKE a static m3u import it has
// a LIVE re-syncable upstream (the market endpoint) AND a playlist-bound guide, so a sync refreshes BOTH the
// channels and the EPG in one pass. Shared by create AND the manual "Sync now"
// (POST /api/custom-playlists/:id/sync) + the auto-provisioned hourly schedule. See restapi-sources/SKILL.md.

import { Playlist } from '../../../models/Playlist.js';
import { PlaylistChannel, type PlaylistChannelDoc } from '../../../models/PlaylistChannel.js';
import { composeM3u } from '../../../m3u/compose.js';
import { logoColorFor, initialsFor } from '../../toPlaylistChannel.js';
import { logger } from '../../core/logger.js';
import { resolveProgramOffset } from '../../../settings/programOffset.js';
import { writeLocalEpg, upsertLocalEpgSource } from '../../../epg/local.js';
import { fetchMarket, selectChannels, type LocalRawChannel } from './api.js';

export const LOCAL_SOURCE = 'local'; // Playlist.source TYPE TAG (channels keyed by the playlist id, like 'hdhomerun')
export const LOCAL_ORIGIN = 'local'; // PlaylistChannel.origin → routes the stream through the synthetic `local` adapter

// US broadcast call sign (W/K + 2-4 letters) → tag a channel as Local News. Mirrors localnow.py _CALL_SIGN_RE.
const CALL_SIGN = /^[WK][A-Z]{2,4}\b/;

// Channel grouping (the displayed group), ported from localnow.py fetch_channels: local broadcast stations →
// "Local News"; otherwise the first IAB/genre, else a generic bucket.
function categoryFor(ch: LocalRawChannel): string {
  const name = (ch.name ?? '').trim();
  const slug = (ch.slug ?? '').toLowerCase();
  const genres = ch.genres ?? [];
  if (genres.includes('My City') || slug.includes('hyperlocal') || slug.startsWith('epg-local-now') || CALL_SIGN.test(name)) {
    return 'Local News';
  }
  return (ch.iab_genres && ch.iab_genres[0]) || (ch.genres && ch.genres[0]) || 'Local';
}

// One market channel → a PlaylistChannel doc. Mirrors sources/toPlaylistChannel.ts (explicit nulls for fields
// the source has no equivalent for; deterministic logoColor/initials). The stream entry is the opaque
// `localnow://<id>?slug=<slug>` sentinel — resolved per play by the synthetic `local` adapter.
function toLocalChannel(ch: LocalRawChannel, id: string, playlistId: string): PlaylistChannelDoc {
  const _id = `${playlistId}:${id}`;
  const name = (ch.name ?? '').trim() || id;
  const slug = (ch.slug ?? '').trim();
  const entry = slug ? `localnow://${id}?slug=${encodeURIComponent(slug)}` : `localnow://${id}`;
  return {
    _id,
    id: _id,
    tvg_name: name,
    group: categoryFor(ch),
    channel: null,
    channelNo: ch.channel_number != null && ch.channel_number !== '' ? String(ch.channel_number) : null,
    tvg_id: null, // EPG link filled by the self-link after the guide is written
    epg: null,
    epgState: null,
    status: 'Active',
    source: playlistId,
    origin: LOCAL_ORIGIN,
    logoColor: logoColorFor(_id),
    logoUrl: ch.logo || null,
    streamEntryUrl: entry,
    stream: { initials: initialsFor(name), isPlayable: true, res: null, status: null, probe: null },
  };
}

// Upsert the market's channels with the SAME merge split as the m3u import (routes/import.ts): source-owned
// routing/display fields go in $set (refreshed each sync); user-editable fields ($setOnInsert) are written
// once and PRESERVED across re-syncs. Then PRUNE channels that vanished from the market (survivors keep edits).
async function upsertLocalChannels(selected: Array<{ ch: LocalRawChannel; id: string }>, playlistId: string): Promise<void> {
  const seen = new Set<string>();
  const ops: unknown[] = [];
  for (const { ch, id } of selected) {
    const pc = toLocalChannel(ch, id, playlistId);
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
  if (ops.length) await PlaylistChannel.bulkWrite(ops as any[]);
  // Prune channels no longer in the market (preserve edits on the survivors).
  await PlaylistChannel.deleteMany({ source: playlistId, _id: { $nin: [...seen] } });
}

// Re-fetch a market's catalog + inline guide and reconcile its playlist's channels AND its playlist-bound EPG
// in one pass. Shared by create + the manual "Sync now" + the hourly schedule. Throws on a missing market or
// an unreachable upstream (the caller maps it to 4xx/502). Recomposes the per-user m3u files (best-effort).
export async function syncLocalPlaylist(id: string): Promise<{ channels: number; groups: number }> {
  // Case-insensitive `source` match so a pre-normalization 'Local' doc still resolves before the boot migration.
  const pl = (await Playlist.findOne(
    { id, source: { $regex: `^${LOCAL_SOURCE}$`, $options: 'i' } },
    { _id: 0, marketDma: 1, marketSlug: 1, marketLabel: 1, name: 1 },
  ).lean()) as { marketDma?: string | null; marketSlug?: string | null; marketLabel?: string | null; name?: string } | null;
  if (!pl) throw new Error('not_a_local_playlist');
  if (!pl.marketDma || !pl.marketSlug) throw new Error('missing_market');

  const raw = await fetchMarket(pl.marketDma, pl.marketSlug);
  const selected = selectChannels(raw);
  await upsertLocalChannels(selected, id);

  // Playlist-bound EPG (same fetched rows → no extra upstream hit). Stamp the operator's UTC offset.
  const { offset, defaulted } = await resolveProgramOffset();
  if (defaulted) logger.warn('local', `[${id}] settings offset unset — guide times stored as UTC (+0000)`);
  const { channels: epgChannels, programs: epgPrograms, channelIds } = await writeLocalEpg(id, selected, offset);
  await upsertLocalEpgSource(id, { channels: epgChannels, programs: epgPrograms, label: pl.marketLabel || pl.name || 'Local Now' });

  // Self-link the still-untouched channels onto the playlist's own guide (FILL-ONLY-IF-UNTOUCHED).
  const ops = channelIds.map((cid) => ({
    updateOne: {
      filter: { _id: `${id}:${cid}`, source: id, epg: null, epgState: null },
      update: { $set: { tvg_id: cid, epg: id, epgState: 'matched' as const } },
    },
  }));
  const linked = ops.length ? (await PlaylistChannel.bulkWrite(ops, { ordered: false })).modifiedCount ?? 0 : 0;

  const channels = (await PlaylistChannel.find({ source: id }, { group: 1 }).lean()) as Array<{ group: string | null }>;
  const groups = new Set(channels.map((c) => c.group).filter((g): g is string => g != null)).size;
  await Playlist.updateOne({ id }, { $set: { groups, lastSync: new Date().toISOString() } });

  await composeM3u(id).catch((err) => logger.warn('m3u', `compose after local sync failed: ${(err as Error).message}`));
  logger.info(
    'local',
    `synced Local Now "${pl.name ?? id}" (${id}) · ${channels.length} channel(s); EPG ${epgChannels}/${epgPrograms} linked ${linked}`,
  );
  return { channels: channels.length, groups };
}
