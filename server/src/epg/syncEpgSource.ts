// Shared EPG-source sync — extracted from routes/epgSources.ts so the on-demand
// POST /api/epg-sources/:id/sync route AND the scheduler (scheduler/index.ts) run ONE code path.
// `syncPrograms` is the low-level Gracenote grid-fetch + Program replace (also used at create time, before
// the EpgSource doc exists); `syncEpgpwSource` is the EPG-PW equivalent (channel list → per-channel guide);
// `syncEpgSource` is the source-level wrapper that dispatches on src.source. See restapi.md + schemas.md §3.4/§3.13.

import { logger } from '../sources/core/logger.js';
import { EpgSource, type EpgSourceDoc } from '../models/EpgSource.js';
import { EpgChannel, type EpgChannelDoc } from '../models/EpgChannel.js';
import { Program, type ProgramDoc } from '../models/Program.js';
import {
  fetchGrid,
  fillTime,
  gridWindowTimes,
  mapGridToPrograms,
  mapGridToEpgChannels,
} from './gracenote.js';
import { fetchRegionChannels, fetchChannelXml, mapEventsToPrograms, todayYmd } from './epgpw.js';
import { syncTubiEpg } from './tubi.js';
import { syncDlhdEpg } from './dlhd.js';
import { syncDamiEpg } from './dami.js';
import { syncSamsungEpg } from './samsung.js';
import { syncVizioEpg } from './vizio.js';
import { syncXmltvUrl, type ImportProgress } from './xmltvIngest.js';
import { toEpgChannelDoc } from './toEpgChannel.js';
import { resolveProgramOffset } from '../settings/programOffset.js';

const EPGPW_CONCURRENCY = 10; // bounded per-channel guide fetches (kind to epg.pw's rate limits)

// Re-fetch a Gracenote grid for a url TEMPLATE across MULTIPLE time windows (~3 days of guide) and REPLACE
// the owning source's channels (epgchannels) AND programs (both scoped by `source`). Fetches each
// `timespan=6` window SEQUENTIALLY (kind to Gracenote's AWS WAF), BEST-EFFORT: a failed window is logged +
// skipped, and only an all-windows-failed run throws (→ the caller maps it to a 502 / records lastError).
// Returns the new counts. The same per-source replace pattern syncEpgpwSource uses.
export async function syncPrograms(
  sourceId: string,
  urlTemplate: string,
  offset: string,
  onProgress?: ImportProgress,
): Promise<{ channels: number; programs: number }> {
  const times = gridWindowTimes(Date.now());

  // Sequential, best-effort: fetch each 6-hour window in order; a failed window is logged + skipped. A
  // streaming caller gets a per-window % (windows attempted / total) as each round-trip completes.
  const grids: any[] = [];
  for (let i = 0; i < times.length; i++) {
    try {
      grids.push(await fetchGrid(fillTime(urlTemplate, times[i])));
    } catch (err) {
      logger.warn('epg', `gracenote window time=${times[i]} failed: ${(err as Error).message}`);
    }
    onProgress?.({ phase: 'importing', percent: Math.min(99, Math.floor(((i + 1) / times.length) * 100)) });
  }
  if (!grids.length) throw new Error(`gracenote grid: all ${times.length} windows failed`);

  // Merge channels across windows (dedupe by _id — channel info is identical per window).
  const channelById = new Map<string, EpgChannelDoc>();
  for (const grid of grids) {
    for (const doc of mapGridToEpgChannels(grid, sourceId)) {
      if (!channelById.has(doc._id)) channelById.set(doc._id, doc);
    }
  }
  const channelDocs = [...channelById.values()];

  // Stitch programs across windows; dedupe by (channelId, start, end) for any boundary-straddling event.
  const seen = new Set<string>();
  const docs: ProgramDoc[] = [];
  for (const grid of grids) {
    for (const p of mapGridToPrograms(grid, sourceId, offset)) {
      const key = `${p.channelId}|${p.start}|${p.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      docs.push(p);
    }
  }

  // Replace the per-source channel store (the guide channels the mapping screen + programs hang off).
  await EpgChannel.deleteMany({ source: sourceId });
  if (channelDocs.length) await EpgChannel.insertMany(channelDocs, { ordered: false });

  // Replace the per-source programs.
  await Program.deleteMany({ source: sourceId });
  if (docs.length) await Program.insertMany(docs, { ordered: false });

  return { channels: channelDocs.length, programs: docs.length };
}

// Bounded-concurrency map; a single item's rejection is caught + skipped (its result is undefined) so one
// channel's guide failure can't abort the whole sync.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<R | undefined>> {
  const results = new Array<R | undefined>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        results[i] = undefined; // skip-on-failure
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Re-fetch an EPG-PW region (channel table → each channel's guide XML) and REPLACE the owning source's
// channels (epgchannels) AND programs (scoped by `source`). Per-channel guide failures are logged + skipped.
// Throws only when the region channel table itself can't be fetched (the caller maps that to a 502).
export async function syncEpgpwSource(
  sourceId: string,
  areaHref: string,
  offset: string,
  onProgress?: ImportProgress,
): Promise<{ channels: number; programs: number }> {
  const channels = await fetchRegionChannels(areaHref);

  // Replace the per-source channel store.
  await EpgChannel.deleteMany({ source: sourceId });
  if (channels.length) {
    await EpgChannel.insertMany(
      channels.map((c) => toEpgChannelDoc(c, sourceId)),
      { ordered: false },
    );
  }

  // Fetch every channel's guide under bounded concurrency, accumulating program rows. A streaming caller
  // gets a per-channel % (guides fetched / total) — incremented in `finally` so a skipped channel still
  // advances the bar. The lastPct guard collapses the concurrent emits to one line per whole percent.
  const date = todayYmd();
  const docs: ProgramDoc[] = [];
  const total = channels.length;
  let done = 0;
  let lastPct = -1;
  await mapLimit(channels, EPGPW_CONCURRENCY, async (c) => {
    try {
      const events = await fetchChannelXml(c.channelId, date);
      for (const d of mapEventsToPrograms(`${sourceId}:${c.channelId}`, events, sourceId, offset)) docs.push(d);
    } catch (err) {
      logger.warn('epg', `epgpw channel ${c.channelId} guide failed: ${(err as Error).message}`);
      throw err; // mapLimit swallows it → this channel is skipped
    } finally {
      done++;
      if (onProgress && total) {
        const pct = Math.min(99, Math.floor((done / total) * 100));
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress({ phase: 'importing', percent: pct });
        }
      }
    }
  });

  // Replace the per-source programs.
  await Program.deleteMany({ source: sourceId });
  if (docs.length) await Program.insertMany(docs, { ordered: false });

  return { channels: channels.length, programs: docs.length };
}

// Source-level: load the EpgSource, re-sync its programs (dispatched on src.source), persist the new
// counts/lastSync/status. Increments the lifetime sync outcome counters (syncSuccessCount on success,
// syncFailCount on failure). Marks the source status 'error' and rethrows on failure so the scheduler can
// record lastError (and the route can map it to the right 502 code).
export async function syncEpgSource(
  id: string,
): Promise<{ source: EpgSourceDoc; offsetDefaulted: boolean }> {
  const src = (await EpgSource.findOne({ id }).lean()) as EpgSourceDoc | null;
  if (!src) throw new Error(`epg source not found: ${id}`);
  // The operator's UTC offset stamped onto every program written this sync (settings.offset; '+0000' when
  // unset — the caller surfaces `offsetDefaulted` as a warn toast / log line). See settings/programOffset.ts.
  const { offset, defaulted: offsetDefaulted } = await resolveProgramOffset();
  // Lowercase the stored kind for dispatch. The canonical values are all lowercase ('gracenote'/'epg-pw'/
  // 'tubi'/'dlhd'/'remote url'); lowercasing here keeps legacy capitalized rows ('Gracenote'/'EPG-PW') that
  // pre-date the normalization dispatching correctly even before the boot migration rewrites them.
  const kind = (src.source ?? '').toLowerCase();
  let counts: { channels: number; programs: number };
  try {
    if (kind === 'epg-pw') {
      if (!src.location) throw new Error(`epg-pw source missing area href (location): ${id}`);
      counts = await syncEpgpwSource(src.id, src.location, offset);
    } else if (kind === 'gracenote' && src.url) {
      counts = await syncPrograms(src.id, src.url, offset);
    } else if (kind === 'tubi') {
      // tubi carries its guide inline with its catalog — a live-only refetch + per-source replace. EPG-ONLY:
      // never touches the tubi playlist (that direction is the playlist sync's afterSync hook). See epg/tubi.ts.
      counts = await syncTubiEpg(src.id, offset);
    } else if (kind === 'dlhd') {
      // dlhd builds its guide from DaddyLive's live-event SCHEDULE (a separate keyless scrape) — live-only,
      // per-source replace. EPG-ONLY: channel self-links are owned by the dlhd playlist afterSync hook (the
      // extra channelIds field is ignored here). See epg/dlhd.ts.
      counts = await syncDlhdEpg(src.id, offset);
    } else if (kind === 'dami') {
      // dami builds its guide from dami-tv.pro's documented live-events API (/papi/api/streams) — live-only,
      // per-source replace. EPG-ONLY: channel self-links are owned by the dami playlist afterSync hook. See epg/dami.ts.
      counts = await syncDamiEpg(src.id, offset);
    } else if (kind === 'samsung') {
      // samsung builds its guide from Matt Huisman's per-region XMLTV mirror — live-only, per-source replace.
      // EPG-ONLY: channel self-links are owned by the samsung playlist afterSync hook. See epg/samsung.ts.
      counts = await syncSamsungEpg(src.id, offset);
    } else if (kind === 'vizio') {
      // vizio builds its guide from the WatchFree+ /api/airings schedule grid — live-only, per-source replace.
      // EPG-ONLY: channel self-links are owned by the vizio playlist afterSync hook. See epg/vizio.ts.
      counts = await syncVizioEpg(src.id, offset);
    } else if ((kind === 'remote url' || kind === 'jesmann') && src.url) {
      // A re-fetchable XMLTV URL — re-download it and per-source replace. 'remote url' = the Custom tab's
      // Remote URL feature; 'jesmann' = the Jesmann guided picker (same machinery, distinct kind). ('xml file'
      // sources are NOT synced here: a static upload has nothing to re-fetch, so it re-imports via POST /:id/upload.)
      counts = await syncXmltvUrl(src.id, src.url, offset);
    } else {
      throw new Error(`sync supported only for gracenote / epg-pw / tubi / dlhd / dami / samsung / vizio / remote url / jesmann sources: ${id}`);
    }
  } catch (err) {
    await EpgSource.updateOne({ id: src.id }, { $set: { status: 'error' }, $inc: { syncFailCount: 1 } });
    throw err;
  }
  const doc = (await EpgSource.findOneAndUpdate(
    { id: src.id },
    {
      $set: {
        channels: counts.channels,
        programs: counts.programs,
        lastSync: new Date().toISOString(),
        status: 'good',
      },
      $inc: { syncSuccessCount: 1 },
    },
    { new: true, projection: { _id: 0 } },
  ).lean()) as EpgSourceDoc | null;
  logger.info('epg', `synced ${src.id}: ${counts.channels} channels, ${counts.programs} programs`);
  return { source: doc as EpgSourceDoc, offsetDefaulted };
}
