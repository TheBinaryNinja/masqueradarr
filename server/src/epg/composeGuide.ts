// XMLTV guide composition — the DB+fs orchestrator that turns ONE composed M3U surface's channel set into a
// stream-ready <tv> guide on disk. The EPG analogue of m3u/compose.ts, but PLAYLIST-scoped: the guide is the
// sibling of an M3U file (the Global union, or one Custom playlist) and merges programme data from EVERY EPG
// source the playlist's channels link to. Called FROM the m3u compose pipeline (composeGlobal/composeCustom)
// off the same channel set, so a guide never drifts from its M3U; the M3U advertises it via x-tvg-url.
// Token-free, NOT per-user (a guide may be a superset of any one user's channels — harmless). See
// .claude/skills/xmltv/SKILL.md (the wire format + the (tvg_id,epg) join) and the m3u skill (the M3U half).

import { logger } from '../sources/core/logger.js';
import { EpgChannel, type EpgChannelDoc } from '../models/EpgChannel.js';
import { Program, type ProgramDoc } from '../models/Program.js';
import { EpgSource } from '../models/EpgSource.js';
import type { PlaylistChannelDoc } from '../models/PlaylistChannel.js';
import { withPathLock, atomicWrite, pruneFile } from '../m3u/atomicFile.js';
import { channelEl, programmeEl, xmltvDocument } from './xmltv.js';
import { guideDiskPath } from './guidePaths.js';

export interface GuideComposeResult {
  path: string; // the served path (under composeDir)
  channelCount: number;
  programmeCount: number;
}

// Compose one playlist guide from the SAME Active channel set its M3U used. Resolves each linked channel's
// epgchannels row (display-name/callSign/channelNo) + its programs by the composite key '<epg>:<tvg_id>',
// re-tagging each <programme channel=> to the bare tvg_id so it matches its <channel id>. De-dupes the bare
// <channel id> (first-wins; two sources can publish the same bare id — a player can't disambiguate anyway).
// Stats: every contributing EPG source gets lastXmlAt set + xmlGeneratedCount++ (xmlFailCount++ on failure).
export async function composeGuide(
  channels: PlaylistChannelDoc[],
  servedPath: string,
): Promise<GuideComposeResult> {
  const disk = guideDiskPath(servedPath);

  // The M3U inclusion rule: Active channels with a 2-factor EPG link (tvg_id AND epg). Index by the composite
  // key (== EpgChannel._id == Program.channelId); first-wins so a re-linked dup doesn't double-count.
  const byKey = new Map<string, PlaylistChannelDoc>();
  for (const c of channels) {
    if (c.status !== 'Active' || c.tvg_id == null || c.epg == null) continue;
    const key = `${c.epg}:${c.tvg_id}`;
    if (!byKey.has(key)) byKey.set(key, c);
  }

  const sources = new Set<string>(); // contributing EPG source ids (for the run-stats credit)
  try {
    // epgchannels rows for the linked keys (display-name / callSign / channelNo).
    const epgChans = byKey.size
      ? await EpgChannel.find({ _id: { $in: [...byKey.keys()] } }).lean<EpgChannelDoc[]>()
      : [];
    const epgByKey = new Map(epgChans.map((e) => [e._id, e]));

    // Build the <channel> set, de-duped by bare id; remember each included composite key → bare id.
    const seenBare = new Set<string>();
    const keyToBare = new Map<string, string>();
    const channelEls: string[] = [];
    for (const [key, pc] of byKey) {
      const epg = epgByKey.get(key);
      if (!epg) continue; // linked but the epgchannels row isn't synced (yet) → skip, never orphan a programme
      const bare = pc.tvg_id as string;
      if (seenBare.has(bare)) {
        logger.warn('xmltv', `${servedPath}: dropped duplicate bare channel id "${bare}" (${key})`);
        continue;
      }
      seenBare.add(bare);
      keyToBare.set(key, bare);
      sources.add(pc.epg as string);
      channelEls.push(channelEl(epg, bare, pc.logoUrl));
    }

    // <programme>s for the included channels, grouped+sorted by the covering { channelId, start } index,
    // re-tagged to the bare id. NaN-timed airings are dropped by programmeEl (§5).
    const programmeEls: string[] = [];
    if (keyToBare.size) {
      const programs = await Program.find({ channelId: { $in: [...keyToBare.keys()] } })
        .sort({ channelId: 1, start: 1 })
        .lean<ProgramDoc[]>();
      for (const p of programs) {
        const bare = keyToBare.get(p.channelId);
        if (!bare) continue;
        const el = programmeEl(p, bare);
        if (el) programmeEls.push(el);
      }
    }

    const body = xmltvDocument(channelEls, programmeEls);
    await withPathLock(disk, () => atomicWrite(disk, body));

    // Credit every source that contributed channels to this guide (the reinterpreted xml* run-stats).
    if (sources.size) {
      await EpgSource.updateMany(
        { id: { $in: [...sources] } },
        { $set: { lastXmlAt: new Date().toISOString() }, $inc: { xmlGeneratedCount: 1 } },
      );
    }
    return { path: servedPath, channelCount: channelEls.length, programmeCount: programmeEls.length };
  } catch (err) {
    // Best-effort failure accounting for whatever sources we'd resolved before the throw.
    if (sources.size) {
      await EpgSource.updateMany({ id: { $in: [...sources] } }, { $inc: { xmlFailCount: 1 } }).catch(
        () => undefined,
      );
    }
    throw err;
  }
}

// Prune a guide file (+ empty parent dirs) — mirrors the M3U prune when a Custom surface is paused/deleted/
// renamed. Idempotent.
export async function pruneGuide(servedPath: string): Promise<void> {
  const disk = guideDiskPath(servedPath);
  await withPathLock(disk, () => pruneFile(disk));
}
