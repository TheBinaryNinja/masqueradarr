// dami EPG provider — builds the dami SELF-EPG from dami-tv.pro's documented live-events API, then the
// per-source replace + the EpgSource upsert the dami playlist-sync hook uses. Mirrors epg/dlhd.ts (a discrete
// live-event guide, NOT a 24/7 grid — the always-on linear channels keep their Gracenote crosswalk guide), but
// SIMPLER: the events feed carries REAL end times (ev.stop), so there is no UK-wall-clock parse and no
// duration heuristic except as a fallback when an event has no end.
//
// ⚠️ Same COMPOSITE guide-key convention as every provider (composeGuide.ts): EpgChannel._id and
// Program.channelId are "<source>:<channelId>", joined to a PlaylistChannel by `${epg}:${tvg_id}`. The
// EpgSource.source field is the sync DISCRIMINATOR ('dami'); EpgSource.id is the composite-key namespace
// (also 'dami'). See restapi.md + schemas.md §3.4/§3.5.

import { EpgSource } from '../models/EpgSource.js';
import { EpgChannel, type EpgChannelDoc } from '../models/EpgChannel.js';
import { Program, type ProgramDoc } from '../models/Program.js';
import { fetchDamiEvents, type DamiEvent } from '../sources/adapters/dami/events.js';

// An event with no end time blocks DEFAULT_DURATION_MS unless the next airing on that channel starts sooner.
const DEFAULT_DURATION_MS = Number(process.env.DAMI_EPG_DEFAULT_DURATION_MS || 7_200_000); // 2 h

/**
 * Map dami's live events into the local guide shapes and REPLACE the per-source stores (epgchannels +
 * programs, both scoped by `source`). Returns the new counts PLUS the bare channelIds present in the events
 * (the dami playlist-sync hook self-links those). Used by BOTH the playlist hook (afterSync) and the
 * standalone EPG sync (syncDamiEpg).
 */
export async function writeDamiEpg(
  events: DamiEvent[],
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const channels = new Map<string, EpgChannelDoc>(); // bare channelId → guide channel doc
  const airings = new Map<string, Array<{ start: number; stop: number | null; title: string; cat: string }>>();

  for (const ev of events) {
    for (const ch of ev.channels) {
      const cid = String(ch.id || '');
      if (!cid) continue;
      if (!channels.has(cid)) {
        channels.set(cid, {
          _id: `${sourceId}:${cid}`, // EpgChannel._id == Program.channelId (the composite join key)
          callSign: null,
          affiliateName: ch.name || cid,
          channelId: cid, // bare id — the 2-factor link target (= PlaylistChannel.tvg_id when linked)
          channelNo: null,
          source: sourceId,
        });
      }
      if (!airings.has(cid)) airings.set(cid, []);
      airings.get(cid)!.push({ start: ev.start, stop: ev.stop, title: ev.title, cat: ev.cat });
    }
  }

  const programDocs: ProgramDoc[] = [];
  for (const [cid, list] of airings) {
    list.sort((a, b) => a.start - b.start);
    const seen = new Set<number>(); // collapse exact-start collisions (one channel shows one thing at a time)
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (seen.has(a.start)) continue;
      seen.add(a.start);
      const nextStart = list[i + 1]?.start; // sorted, so the next item is the next airing (or undefined)
      // Prefer the event's REAL end (ev.stop); else block the default duration. Either way, shorten to the
      // next airing on this channel if it starts sooner (no overlap).
      let end = a.stop != null && a.stop > a.start ? a.stop : a.start + DEFAULT_DURATION_MS;
      if (nextStart != null && nextStart > a.start && nextStart < end) end = nextStart;
      programDocs.push({
        channelId: `${sourceId}:${cid}`,
        start: a.start,
        end,
        offset,
        title: a.title,
        cat: a.cat,
        source: sourceId,
        callSign: null,
        channelNo: null,
        shortDesc: null,
        rating: null,
        seriesId: null,
        season: null,
        episode: null,
        episodeTitle: null,
      });
    }
  }

  const channelDocs = [...channels.values()];

  // Per-source replace (the same pattern Gracenote / EPG-PW / tubi / dlhd use).
  await EpgChannel.deleteMany({ source: sourceId });
  if (channelDocs.length) await EpgChannel.insertMany(channelDocs, { ordered: false });

  await Program.deleteMany({ source: sourceId });
  if (programDocs.length) await Program.insertMany(programDocs, { ordered: false });

  return { channels: channelDocs.length, programs: programDocs.length, channelIds: [...channels.keys()] };
}

/**
 * Standalone EPG sync (the EPG Sources "Sync" button + scheduler path, dispatched from syncEpgSource on
 * src.source === 'dami'). Fetches the events LIVE-ONLY (no snapshot fallback: a transient outage fails loudly →
 * status 'error' → the existing guide is preserved, never replaced with half-empty data) and replaces the
 * per-source guide. EPG-ONLY: never touches the dami playlist or its channel links (that direction is the
 * playlist sync's afterSync hook).
 */
export async function syncDamiEpg(
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const { events } = await fetchDamiEvents();
  return writeDamiEpg(events, sourceId, offset);
}

export const DAMI_EPG_NAME = 'Dami.TV Schedule';
export const DAMI_EPG_URL = 'https://dami-tv.pro/';

/**
 * Create-or-update the 'dami' EpgSource row — called by the dami playlist-sync hook so the EPG source appears
 * (and its counts refresh) whenever the playlist syncs. Refreshed fields → $set; user-owned/lifetime fields →
 * $setOnInsert. builtin is FALSE; playlistBinding is TRUE (the dami *playlist* is the builtin object — a
 * different row — and the binding hides the redundant sync/schedule controls in the EPG UI). A re-sync
 * re-creates it if deleted. Mirrors upsertDlhdEpgSource / upsertTubiEpgSource.
 */
export async function upsertDamiEpgSource(
  sourceId: string,
  counts: { channels: number; programs: number },
): Promise<void> {
  await EpgSource.updateOne(
    { id: sourceId },
    {
      $set: {
        name: DAMI_EPG_NAME,
        url: DAMI_EPG_URL,
        source: 'dami', // sync discriminator + the SOURCE chip; the (separate) id is the composite namespace
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
