// Local Now playlist-bound self-EPG. Unlike a registry source (dlhd/dami) whose afterSync hook writes its
// guide, a Local Now playlist is a CUSTOM playlist (one per market) so its guide is written INSIDE the
// playlist's own sync (../sources/adapters/local/import.ts → syncLocalPlaylist). This module owns the guide
// shapes + the per-source replace + the EpgSource upsert, shared by that sync AND the standalone EPG sync
// (syncEpgSource dispatch on src.source === 'local').
//
// ⚠️ Per-playlist namespacing: every Local playlist has its OWN EpgSource (id === the playlist id), and its
// epgchannels/programs are scoped by `source === <playlistId>`. The composite guide key is
// "<playlistId>:<video_id>" (EpgChannel._id == Program.channelId), joined to a PlaylistChannel by
// `${epg}:${tvg_id}` — exactly the dlhd/dami convention, just keyed by the playlist instead of a source id.
// Programs come INLINE with the catalog (~5 per channel), so the guide refreshes on every market fetch.

import { EpgSource } from '../models/EpgSource.js';
import { EpgChannel, type EpgChannelDoc } from '../models/EpgChannel.js';
import { Program, type ProgramDoc } from '../models/Program.js';
import { Playlist } from '../models/Playlist.js';
import { fetchMarket, selectChannels, type LocalRawChannel } from '../sources/adapters/local/api.js';

export const LOCAL_EPG_URL = 'https://localnow.com/';

// Local Now composite-title vocab (ported from localnow.py _parse_localnow_title): split "Series: S## E## -
// Episode Title" (+ rating / "Episode N" variants) into XMLTV-friendly fields. Season/episode are stored as
// strings (ProgramDoc) or null; never fabricated.
const COMPOSITE_TITLE = /^(.+):\s+S(\d+)\s+E(\d+)\s*-\s*(.+?)\s*$/i;
const SE_RATING = /^(.+):\s+S(\d+)\s+E(\d+)\s*\([^)]*\)\s*$/i;
const EP_SUBTITLE = /^(.+?)\s[-–]\sEpisode\s(\d+)\s[-–]\s(.+?)\s*$/i;
const EP_ONLY = /^(.+?)(?::\s*|,\s*|\s[-–]\s)Episode\s(\d+)\s*$/i;

interface ParsedTitle {
  title: string;
  season: string | null;
  episode: string | null;
  episodeTitle: string | null;
}

function str(v: unknown): string | null {
  if (v == null || v === '') return null;
  return String(v);
}

function parseTitle(raw: string, apiSeason: string | null, apiEpisode: string | null, apiEpisodeTitle: string | null): ParsedTitle {
  const t = (raw ?? '').trim();
  if (!t) return { title: raw ?? '', season: apiSeason, episode: apiEpisode, episodeTitle: apiEpisodeTitle };

  let m = t.match(COMPOSITE_TITLE);
  if (m) return { title: m[1].trim(), season: m[2], episode: m[3], episodeTitle: (apiEpisodeTitle || m[4] || '').trim() || null };

  m = t.match(SE_RATING);
  if (m) return { title: m[1].trim(), season: m[2], episode: m[3], episodeTitle: apiEpisodeTitle };

  m = t.match(EP_SUBTITLE);
  if (m) return { title: m[1].trim(), season: apiSeason, episode: apiEpisode || m[2], episodeTitle: (apiEpisodeTitle || m[3] || '').trim() || null };

  m = t.match(EP_ONLY);
  if (m) return { title: m[1].trim(), season: apiSeason, episode: apiEpisode || m[2], episodeTitle: (apiEpisodeTitle || `Episode ${m[2]}`).trim() || null };

  return { title: t, season: apiSeason, episode: apiEpisode, episodeTitle: apiEpisodeTitle };
}

function categoryFor(ch: LocalRawChannel): string {
  return (ch.iab_genres && ch.iab_genres[0]) || (ch.genres && ch.genres[0]) || 'Live';
}

/**
 * Map a market's (already-selected) channels + their inline programs into the local guide shapes and REPLACE
 * the per-playlist stores (epgchannels + programs, both scoped by `source === playlistId`). Returns the new
 * counts PLUS the bare channelIds present (the playlist sync self-links those). `offset` stamps each program.
 */
export async function writeLocalEpg(
  playlistId: string,
  selected: Array<{ ch: LocalRawChannel; id: string }>,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const channelDocs: EpgChannelDoc[] = [];
  const programDocs: ProgramDoc[] = [];

  for (const { ch, id } of selected) {
    channelDocs.push({
      _id: `${playlistId}:${id}`, // EpgChannel._id == Program.channelId (the composite join key)
      callSign: null,
      affiliateName: (ch.name ?? '').trim() || id,
      channelId: id, // bare id — the 2-factor link target (= PlaylistChannel.tvg_id when linked)
      channelNo: str(ch.channel_number),
      source: playlistId,
    });

    const cat = categoryFor(ch);
    for (const p of ch.program ?? []) {
      const start = Number(p.starts_at) * 1000;
      const end = Number(p.ends_at) * 1000;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const parsed = parseTitle(
        (p.program_title ?? ch.name ?? 'Unknown').trim(),
        str(p.season),
        str(p.episode),
        str(p.episode_title),
      );
      programDocs.push({
        channelId: `${playlistId}:${id}`,
        start,
        end,
        offset,
        title: parsed.title || 'Unknown',
        cat,
        source: playlistId,
        callSign: null,
        channelNo: null,
        shortDesc: str(p.program_description) ?? str(ch.description),
        rating: str(p.rating) ?? str(ch.rating),
        seriesId: null,
        season: parsed.season,
        episode: parsed.episode,
        episodeTitle: parsed.episodeTitle,
      });
    }
  }

  // Per-source (per-playlist) replace — the same pattern dlhd/dami/tubi use.
  await EpgChannel.deleteMany({ source: playlistId });
  if (channelDocs.length) await EpgChannel.insertMany(channelDocs, { ordered: false });
  await Program.deleteMany({ source: playlistId });
  if (programDocs.length) await Program.insertMany(programDocs, { ordered: false });

  return { channels: channelDocs.length, programs: programDocs.length, channelIds: selected.map((s) => s.id) };
}

/**
 * Standalone EPG sync (the syncEpgSource dispatch on src.source === 'local'): look up the OWNING Local
 * playlist's market, re-fetch the catalog (inline guide), and per-playlist replace. EPG-ONLY — channel
 * self-links are owned by the playlist sync (import.ts). Throws when the playlist/market is missing.
 */
export async function syncLocalEpg(playlistId: string, offset: string): Promise<{ channels: number; programs: number }> {
  const pl = (await Playlist.findOne(
    { id: playlistId, source: { $regex: '^local$', $options: 'i' } },
    { _id: 0, marketDma: 1, marketSlug: 1 },
  ).lean()) as { marketDma?: string | null; marketSlug?: string | null } | null;
  if (!pl) throw new Error(`not a local playlist: ${playlistId}`);
  if (!pl.marketDma || !pl.marketSlug) throw new Error(`local playlist ${playlistId} has no market`);
  const raw = await fetchMarket(pl.marketDma, pl.marketSlug);
  const { channels, programs } = await writeLocalEpg(playlistId, selectChannels(raw), offset);
  return { channels, programs };
}

/**
 * Create-or-update the per-playlist Local Now EpgSource row — called by the playlist sync so the guide source
 * appears (and its counts refresh) whenever the playlist syncs. Refreshed fields → $set; user/lifetime fields
 * → $setOnInsert. `playlistBinding:true` hides manual sync/schedule controls (the playlist owns the cadence).
 */
export async function upsertLocalEpgSource(
  playlistId: string,
  counts: { channels: number; programs: number; label: string },
): Promise<void> {
  await EpgSource.updateOne(
    { id: playlistId },
    {
      $set: {
        name: `${counts.label} — Local Now`,
        url: LOCAL_EPG_URL,
        source: 'local', // sync discriminator + the SOURCE chip; the (separate) id is the composite namespace
        channels: counts.channels,
        programs: counts.programs,
        lastSync: new Date().toISOString(),
        status: 'good',
        builtin: false,
        playlistBinding: true,
      },
      $setOnInsert: {
        auto: false,
        interval: 'manual',
        syncSuccessCount: 1,
        syncFailCount: 0,
        lastXmlAt: null,
        xmlGeneratedCount: 0,
        xmlFailCount: 0,
      },
    },
    { upsert: true },
  );
}
