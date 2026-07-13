import { Program } from '../models/Program.js';

const HOUR_MS = 3_600_000;
export const MAX_CHANNEL_IDS = 500; // per-request cap; the SPA batches larger sets (see fetchProgramsFor)

export type GroupedProgram = { start: number; end: number; title: string; cat: string };

// Programs for a SCOPED set of composite channel keys ("<epg>:<tvg_id>") within a time window, grouped by
// channelId — matches the EPG_PROGRAMS shape the SPA expects. Overlap test (not containment) so a program
// straddling a window edge still appears. Covered by the {channelId:1, start:1} index. Shared by the
// admin /api/epg-programs route and the user-scoped /api/playlists/:id/programs route. `from`/`to` are
// epoch-ms; a non-finite value falls back to a bounded now-relative span (now-2h .. now+24h).
export async function fetchProgramsGrouped(
  ids: string[],
  from?: number,
  to?: number,
): Promise<Record<string, GroupedProgram[]>> {
  const now = Date.now();
  const lo = Number.isFinite(from) ? (from as number) : now - 2 * HOUR_MS;
  const hi = Number.isFinite(to) ? (to as number) : now + 24 * HOUR_MS;
  const docs = await Program.find(
    { channelId: { $in: ids }, start: { $lt: hi }, end: { $gt: lo } },
    { _id: 0 },
  ).sort({ channelId: 1, start: 1 }).lean();
  const grouped: Record<string, GroupedProgram[]> = {};
  for (const d of docs) {
    const list = grouped[d.channelId] ?? (grouped[d.channelId] = []);
    list.push({ start: d.start, end: d.end, title: d.title, cat: d.cat });
  }
  return grouped;
}
