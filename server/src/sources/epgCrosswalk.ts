// Shared "committed EPG crosswalk" applier for resolve-on-demand sources (dulo, dlhd). After a sync
// populates the channels, a source can carry an offline crosswalk file (seed-data/<id>-playlist-addon.json,
// rows of { id, tvg_id, epg, confidence }) that links each channel onto an EXISTING external Gracenote EPG
// source. This is the ONE place that apply lives — the generic core never branches per source; an adapter
// just calls applyEpgCrosswalk(sourceId, addonFile) from its afterSync hook.
//
// FILL-ONLY-IF-UNTOUCHED: the per-row filter requires epg == null AND epgState == null, so a channel is
// linked exactly once (right after a sync) and a later user edit is NEVER overwritten — a manual link/remap
// sets epg, and an unlink leaves epgState 'unmatched' (not null), so both are skipped. Only HIGH-confidence
// rows auto-apply; medium rows are left for manual review on the Channel Mapping screen. Non-fatal: a
// missing/unreadable crosswalk must not fail a sync that succeeded.
//
// GUARD (the reason this helper exists): a row is staged epgState:'matched' ONLY when its (epg, tvg_id) pair
// resolves to a real epgchannels doc. The link factors map to EpgChannel as epg == EpgChannel.source and
// tvg_id == EpgChannel.channelId, i.e. the deterministic EpgChannel._id is `${epg}:${tvg_id}`. So a row whose
// target EPG source/channel does not exist yet (e.g. the user hasn't added the Gracenote source) is SKIPPED,
// leaving the channel untouched (epg/tvg_id/epgState null → shown unmatched). Because the filter stays
// fill-only-if-untouched, that same row auto-links on a LATER sync once the real source is present — which is
// exactly the intended "link to EXISTING sources" posture, instead of fabricating a match against nothing.
//
// A second, STATION-ID applier (applyStationCrosswalk, below) serves sources whose rows cannot name a fixed
// target guide. Same file shape, same fill-only-if-untouched filter and guard — the difference is only in how a
// row's target epgchannels doc is found. See its header.

import { readFileSync } from 'node:fs';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import { EpgChannel } from '../models/EpgChannel.js';
import { EpgSource } from '../models/EpgSource.js';
import { logger } from './core/logger.js';

type AddonRow = { id: string; tvg_id: string; epg: string; confidence: 'high' | 'medium' };

/** Read + parse a committed addon file; null (already logged) when it is absent or unreadable. */
function readAddonRows<T>(sourceId: string, addonFile: string, what: string): T[] | null {
  try {
    const parsed = JSON.parse(readFileSync(addonFile, 'utf8'));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (err) {
    // A MISSING addon file is the expected steady state, not a failure: paths.ts declares a crosswalk
    // constant for every source, but only a few have a generated file — the rest are wired ahead of time and
    // documented as "no-ops until the addon lands". Logging that ENOENT at warn made a designed no-op read as a
    // broken sync (and buried the real warnings next to it), so it is an info line. A file that EXISTS but
    // won't read or parse is a genuine problem and still warns.
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      logger.info('seed', `[${sourceId}] no committed ${what} — channels rely on the source's own guide`);
    } else {
      logger.warn('seed', `[${sourceId}] ${what} not applied (unreadable): ${e.message}`);
    }
    return null;
  }
}

/** Apply a source's committed gracenote crosswalk onto its just-synced playlistchannels (guarded). */
export async function applyEpgCrosswalk(sourceId: string, addonFile: string): Promise<void> {
  const rows = readAddonRows<AddonRow>(sourceId, addonFile, 'EPG crosswalk');
  if (!rows) return;

  const candidates = rows.filter((r) => r?.confidence === 'high' && r.id && r.tvg_id && r.epg);
  if (!candidates.length) return;

  // Guard: keep only rows whose (epg, tvg_id) resolves to a real epgchannels doc (deterministic _id). One
  // query — rows whose target EPG source/channel isn't present yet are dropped, not fabricated as matched.
  const wantedIds = candidates.map((r) => `${r.epg}:${r.tvg_id}`);
  const present = new Set(
    (await EpgChannel.find({ _id: { $in: wantedIds } }, { _id: 1 }).lean()).map((d) => d._id),
  );
  const linkable = candidates.filter((r) => present.has(`${r.epg}:${r.tvg_id}`));

  const skipped = candidates.length - linkable.length;
  if (!linkable.length) {
    logger.info(
      'seed',
      `[${sourceId}] EPG crosswalk: linked 0 of ${candidates.length} high-confidence mapping(s) (skipped ${skipped} — target EPG source/channel not present)`,
    );
    return;
  }

  const ops = linkable.map((r) => ({
    updateOne: {
      // Untouched-only: skips user-linked (epg set) AND user-unlinked (epgState 'unmatched') channels.
      filter: { _id: r.id, source: sourceId, epg: null, epgState: null },
      update: { $set: { tvg_id: r.tvg_id, epg: r.epg, epgState: 'matched' as const } },
    },
  }));
  const res = await PlaylistChannel.bulkWrite(ops, { ordered: false });
  logger.info(
    'seed',
    `[${sourceId}] EPG crosswalk: linked ${res.modifiedCount ?? 0} channel(s) of ${candidates.length} high-confidence mapping(s)` +
      (skipped ? ` (skipped ${skipped} — target EPG source/channel not present)` : ''),
  );
}

// ── Station-id crosswalk ─────────────────────────────────────────────────────────────────────────────────
// For a source whose channels map to Gracenote STATION ids but whose target guide can't be named ahead of time.
// zlive is the case: most of its foreign channels live in Jesmann country guides, and a Jesmann EpgSource id is
// `jesmann:<slugify(name)>` — operator-named, so a committed row cannot hardcode it. Jesmann's 7-day "Standard"
// XMLTV keys every <channel> by the Gracenote station id (channel id == its <gnid>), so the SAME station id
// reaches a Gracenote lineup and a Jesmann guide alike: the epgchannels _id is `${guideId}:${stationId}` in both.
//
// Resolution per row { id, tvg_id: <station id>, epg?: <preferred guide id>, confidence }:
//   1. the pinned pair `${epg}:${tvg_id}` when that epgchannels doc exists (e.g. DITV for a US cable channel);
//   2. else the best-ranked PRESENT gracenote/jesmann guide carrying the station — DITV › other gracenote ›
//      jesmann (DITV is the market-neutral national lineup the other committed addons target; jesmann last).
// Both come from ONE primary-key $in over the cross product (pinned pairs ∪ present guides × station ids), so no
// new index is needed (a channelId lookup would want one). The first row per channel that resolves wins, so a
// file may list alternates for one channel in priority order.
//
// Everything else is applyEpgCrosswalk's contract: HIGH rows only, the same fill-only-if-untouched filter, and a
// row whose station is in no present guide is skipped — it links on a later call once a guide carrying it is
// added. Idempotent and cheap, so it is safe to re-run after every guide sync, not only a playlist sync; and it
// NEVER throws — a crosswalk problem is logged and swallowed, so no caller's sync can fail on it.
//
// Jesmann's "7d IPTV" variants key channels by name (`Name(CALLSIGN).cc`), not station id, so they never match;
// the guard just leaves those channels untouched (pick the "7d Standard" download for station-id linking).

type StationRow = { id: string; tvg_id: string; epg?: string | null; confidence: 'high' | 'medium' };

// Station-id guide kinds (EpgSource.source). Case-insensitive on purpose: rows created before the lowercase
// kind discriminator stored 'Gracenote' until sources/seed.ts's boot migration normalizes them.
const STATION_GUIDE_KIND = /^(gracenote|jesmann)$/i;

// Lower = preferred: DITV (`gracenote:DITV:…`), then any other gracenote lineup, then jesmann. Ties break on id
// so the pick is deterministic across runs.
function guideRank(g: { id: string; source: string | null }): number {
  if ((g.source ?? '').toLowerCase() === 'gracenote') return /:DITV:/i.test(g.id) ? 0 : 1;
  return 2;
}

/** Apply a source's committed station-id crosswalk onto its playlistchannels (guarded, never throws). */
export async function applyStationCrosswalk(sourceId: string, addonFile: string): Promise<void> {
  const rows = readAddonRows<StationRow>(sourceId, addonFile, 'station EPG crosswalk');
  if (!rows) return;

  const candidates = rows.filter(
    (r) => r?.confidence === 'high' && typeof r.id === 'string' && !!r.id && typeof r.tvg_id === 'string' && !!r.tvg_id,
  );
  if (!candidates.length) return;
  const channelCount = new Set(candidates.map((r) => r.id)).size;
  const pinned = (r: StationRow): string | null => (typeof r.epg === 'string' && r.epg ? r.epg : null);

  try {
    const guides = (
      await EpgSource.find({ source: STATION_GUIDE_KIND }, { _id: 0, id: 1, source: 1 }).lean<
        { id: string; source: string | null }[]
      >()
    ).sort((a, b) => guideRank(a) - guideRank(b) || a.id.localeCompare(b.id));

    // Guard: ONE query for every epgchannels doc a row could land on; anything not returned is not linkable.
    const stations = [...new Set(candidates.map((r) => r.tvg_id))];
    const wanted = new Set<string>();
    for (const r of candidates) {
      const epg = pinned(r);
      if (epg) wanted.add(`${epg}:${r.tvg_id}`);
    }
    for (const g of guides) for (const s of stations) wanted.add(`${g.id}:${s}`);
    const present = new Set(
      (await EpgChannel.find({ _id: { $in: [...wanted] } }, { _id: 1 }).lean()).map((d) => d._id),
    );

    const targetFor = (r: StationRow): string | null => {
      const epg = pinned(r);
      if (epg && present.has(`${epg}:${r.tvg_id}`)) return epg;
      return guides.find((g) => present.has(`${g.id}:${r.tvg_id}`))?.id ?? null;
    };
    const links = new Map<string, { tvg_id: string; epg: string }>();
    for (const r of candidates) {
      if (links.has(r.id)) continue; // an earlier (higher-priority) row already resolved this channel
      const epg = targetFor(r);
      if (epg) links.set(r.id, { tvg_id: r.tvg_id, epg });
    }

    const skipped = channelCount - links.size;
    if (!links.size) {
      logger.info(
        'seed',
        `[${sourceId}] station EPG crosswalk: linked 0 of ${channelCount} high-confidence mapping(s) (skipped ${skipped} — station not in any present gracenote/jesmann guide)`,
      );
      return;
    }

    const ops = [...links].map(([id, l]) => ({
      updateOne: {
        // Untouched-only: skips user-linked (epg set) AND user-unlinked (epgState 'unmatched') channels.
        filter: { _id: id, source: sourceId, epg: null, epgState: null },
        update: { $set: { tvg_id: l.tvg_id, epg: l.epg, epgState: 'matched' as const } },
      },
    }));
    const res = await PlaylistChannel.bulkWrite(ops, { ordered: false });
    logger.info(
      'seed',
      `[${sourceId}] station EPG crosswalk: linked ${res.modifiedCount ?? 0} channel(s) of ${channelCount} high-confidence mapping(s)` +
        (skipped ? ` (skipped ${skipped} — station not in any present gracenote/jesmann guide)` : ''),
    );
  } catch (err) {
    logger.warn('seed', `[${sourceId}] station EPG crosswalk not applied: ${(err as Error).message}`);
  }
}
