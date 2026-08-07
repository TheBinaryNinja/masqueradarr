import { Program } from '../models/Program.js';

const HOUR_MS = 3_600_000;
export const MAX_CHANNEL_IDS = 500; // per-request cap; the SPA batches larger sets (see fetchProgramsFor)

export type GroupedProgram = { start: number; end: number; title: string; cat: string };

// The `rich` add-on fields. Stored on every program but projected away by default: the guide grid and
// Dashboard fetch hundreds of channels at a time, and shortDesc alone would multiply those payloads. Opt in
// only for a NARROW set of channels (the Ultimate Player asks for the one channel being watched). All of
// these are already declared optional on the SPA's Program type (src/data.ts), so widening needs no client
// type change; they are null/absent on non-Gracenote sources.
export type RichProgramFields = {
  shortDesc: string | null;
  episodeTitle: string | null;
  season: string | null;
  episode: string | null;
  rating: string | null;
};

// Programs for a SCOPED set of composite channel keys ("<epg>:<tvg_id>") within a time window, grouped by
// channelId — matches the EPG_PROGRAMS shape the SPA expects. Overlap test (not containment) so a program
// straddling a window edge still appears. Covered by the {channelId:1, start:1} index. Shared by the
// admin /api/epg-programs route and the user-scoped /api/playlists/:id/programs route. `from`/`to` are
// epoch-ms; a non-finite value falls back to a bounded now-relative span (now-2h .. now+24h).
// `rich` additionally returns RichProgramFields — see the type's note on why it is opt-in.
export async function fetchProgramsGrouped(
  ids: string[],
  from?: number,
  to?: number,
  rich = false,
): Promise<Record<string, (GroupedProgram & Partial<RichProgramFields>)[]>> {
  const now = Date.now();
  const lo = Number.isFinite(from) ? (from as number) : now - 2 * HOUR_MS;
  const hi = Number.isFinite(to) ? (to as number) : now + 24 * HOUR_MS;
  const docs = await Program.find(
    { channelId: { $in: ids }, start: { $lt: hi }, end: { $gt: lo } },
    { _id: 0 },
  ).sort({ channelId: 1, start: 1 }).lean();
  const grouped: Record<string, (GroupedProgram & Partial<RichProgramFields>)[]> = {};
  for (const d of docs) {
    const list = grouped[d.channelId] ?? (grouped[d.channelId] = []);
    const p: GroupedProgram & Partial<RichProgramFields> = {
      start: d.start, end: d.end, title: d.title, cat: d.cat,
    };
    if (rich) {
      p.shortDesc = d.shortDesc ?? null;
      p.episodeTitle = d.episodeTitle ?? null;
      p.season = d.season ?? null;
      p.episode = d.episode ?? null;
      p.rating = d.rating ?? null;
    }
    list.push(p);
  }
  return grouped;
}
