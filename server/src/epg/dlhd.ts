// dlhd EPG provider — builds the dlhd SELF-EPG from DaddyLive's schedule of live events, then the per-source
// replace + the EpgSource upsert the dlhd playlist-sync hook uses. Mirrors epg/tubi.ts, with ONE structural
// difference: tubi's catalog embeds programs[] (one fetch feeds both channels and guide), but dlhd's 24/7
// catalog has NO program data, so this module fetches a SEPARATE feed — the schedule
// (sources/adapters/dlhd/schedule.ts) — and maps its events into the guide.
//
// ⚠️ Same COMPOSITE guide-key convention as every provider (composeGuide.ts): EpgChannel._id and
// Program.channelId are "<source>:<channelId>", joined to a PlaylistChannel by `${epg}:${tvg_id}`. The
// EpgSource.source field is the sync DISCRIMINATOR ('dlhd'); EpgSource.id is the composite-key namespace
// (also 'dlhd'). See restapi.md + schemas.md §3.4/§3.5.
//
// Event → program mapping notes:
//  · Times are UK-local ("Schedule Time UK GMT") → Europe/London (DST-aware) → epoch ms via Intl.
//  · The feed has NO end time, so each program's end is start + DEFAULT_DURATION_MS, SHORTENED if the same
//    channel's next airing starts sooner. A discrete-event guide (sports/PPV), NOT a 24/7 grid — by design;
//    the always-on linear channels keep their Gracenote crosswalk guide (see adapters/dlhd.ts afterSync).
//  · channelId is the numeric DaddyLive id (= 24/7 catalog id) → links onto dlhd PlaylistChannels.

import { EpgSource } from '../models/EpgSource.js';
import { EpgChannel, type EpgChannelDoc } from '../models/EpgChannel.js';
import { Program, type ProgramDoc } from '../models/Program.js';
import { fetchDlhdSchedule, type DlhdSchedule } from '../sources/adapters/dlhd/schedule.js';

// The schedule is labeled "UK GMT" but follows UK wall-clock (BST in summer), so resolve via a DST-aware
// zone. Override with DLHD_SCHEDULE_TZ. Each discrete event blocks DEFAULT_DURATION_MS unless the next
// airing on that channel starts sooner.
const SCHEDULE_TZ = process.env.DLHD_SCHEDULE_TZ || 'Europe/London';
const DEFAULT_DURATION_MS = Number(process.env.DLHD_EPG_DEFAULT_DURATION_MS || 7_200_000); // 2 h

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

// Offset (ms) of `tz` from UTC at the given instant: format the UTC instant AS `tz` wall-clock, read it back
// as if UTC, and diff. Standard two-step zoned conversion (no tz library; Node 22 ships full ICU).
function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - utcMs; // tz wall-clock = UTC + offset
}

/**
 * "Thursday 18th June 2026 - Schedule Time UK GMT" + "16:00" → epoch ms (interpreting the time as UK-local),
 * or NaN when the date/time can't be parsed (that airing is then skipped — Program.start/end are required).
 */
export function parseScheduleTime(dayKey: string, hhmm: string): number {
  const dm = String(dayKey).match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/);
  const tm = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(hhmm));
  if (!dm || !tm) return NaN;
  const mon = MONTHS[dm[2].toLowerCase()];
  if (mon == null) return NaN;
  const utcGuess = Date.UTC(Number(dm[3]), mon, Number(dm[1]), Number(tm[1]), Number(tm[2]));
  return utcGuess - tzOffsetMs(utcGuess, SCHEDULE_TZ);
}

/**
 * Map the schedule's events into the local guide shapes and REPLACE the per-source stores (epgchannels +
 * programs, both scoped by `source`). Returns the new counts PLUS the bare channelIds present in the schedule
 * (the dlhd playlist-sync hook self-links those). Used by BOTH the playlist hook (afterSync) and the
 * standalone EPG sync (syncDlhdEpg).
 */
export async function writeDlhdEpg(
  schedule: DlhdSchedule,
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const channels = new Map<string, EpgChannelDoc>(); // bare channelId → guide channel doc
  const airings = new Map<string, Array<{ start: number; title: string; cat: string }>>();

  for (const ev of schedule.events) {
    const start = parseScheduleTime(ev.dayKey, ev.time);
    if (Number.isNaN(start)) continue;
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
      airings.get(cid)!.push({ start, title: ev.title, cat: ev.category || 'Live' });
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
      let end = a.start + DEFAULT_DURATION_MS;
      if (nextStart != null && nextStart > a.start && nextStart < end) end = nextStart; // shorten if sooner
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

  // Per-source replace (the same pattern Gracenote / EPG-PW / tubi use).
  await EpgChannel.deleteMany({ source: sourceId });
  if (channelDocs.length) await EpgChannel.insertMany(channelDocs, { ordered: false });

  await Program.deleteMany({ source: sourceId });
  if (programDocs.length) await Program.insertMany(programDocs, { ordered: false });

  return { channels: channelDocs.length, programs: programDocs.length, channelIds: [...channels.keys()] };
}

/**
 * Standalone EPG sync (the EPG Sources "Sync" button + scheduler path, dispatched from syncEpgSource on
 * src.source === 'dlhd'). Fetches the schedule LIVE-ONLY (no snapshot fallback exists: a transient outage
 * fails loudly → status 'error' → the existing guide is preserved, never replaced with half-empty data) and
 * replaces the per-source guide. EPG-ONLY: never touches the dlhd playlist or its channel links (that
 * direction is the playlist sync's afterSync hook).
 */
export async function syncDlhdEpg(
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  return writeDlhdEpg(await fetchDlhdSchedule(), sourceId, offset);
}

export const DLHD_EPG_NAME = 'DaddyLive TV Schedule';
export const DLHD_EPG_URL = 'https://dlhd.pk/';

/**
 * Create-or-update the 'dlhd' EpgSource row — called by the dlhd playlist-sync hook so the EPG source appears
 * (and its counts refresh) whenever the playlist syncs. Refreshed fields → $set; user-owned/lifetime fields →
 * $setOnInsert (written once, so a user's schedule + the counters survive a re-sync). builtin is FALSE so the
 * EPG Sources UI gives it the same Sync/Delete/schedule capabilities as any other source (the dlhd *playlist*
 * is the builtin object — a different row). A re-sync re-creates it if deleted. Mirrors upsertTubiEpgSource.
 */
export async function upsertDlhdEpgSource(
  sourceId: string,
  counts: { channels: number; programs: number },
): Promise<void> {
  await EpgSource.updateOne(
    { id: sourceId },
    {
      $set: {
        name: DLHD_EPG_NAME,
        url: DLHD_EPG_URL,
        source: 'dlhd', // sync discriminator + the SOURCE chip; the (separate) id is the composite namespace
        channels: counts.channels,
        programs: counts.programs,
        lastSync: new Date().toISOString(),
        status: 'good',
        builtin: false,
        playlistBinding: true, // created by the dlhd playlist's afterSync — hides sync/schedule controls in the UI
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
