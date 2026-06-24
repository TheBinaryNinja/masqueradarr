// tubi EPG provider — pure fetch + map + per-source replace (mirrors gracenote.ts / epgpw.ts), plus the
// EpgSource upsert the tubi playlist-sync hook uses. tubi is UNIQUE: it carries its guide INLINE with its
// catalog (each /oz/epg/programming row embeds programs[]), so this module reuses the source adapter's
// shared fetchTubiCatalog() instead of hitting a separate guide endpoint — one fetch path, no duplication.
//
// ⚠️ Local guide-key convention (composeGuide.ts) is COMPOSITE: EpgChannel._id = "<source>:<channelId>" and
// Program.channelId = "<source>:<channelId>", joined to a PlaylistChannel by the key `${epg}:${tvg_id}`.
// (The d-combine POC wrote a BARE Program.channelId; copying that would compose EMPTY guides here.) The
// EpgSource.source field is the sync DISCRIMINATOR ('tubi'); EpgSource.id is the composite-key namespace
// (also 'tubi'). See restapi.md + schemas.md §3.4/§3.5.

import { EpgSource } from '../models/EpgSource.js';
import { EpgChannel, type EpgChannelDoc } from '../models/EpgChannel.js';
import { Program, type ProgramDoc } from '../models/Program.js';
import { fetchTubiCatalog, TUBI_LIVE_URL } from '../sources/adapters/tubi/catalog.js';

// Tubi has no callsign (Gracenote does). Many Tubi names ARE callsign-like single tokens (NHL, MLB, ION,
// TMZ) — surface those; otherwise null rather than fabricate one. Ported from d-combine tubi-tvapp2-shape.
function deriveCallSign(name: string): string | null {
  const compact = String(name ?? '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/);
  if (compact.length === 1 && compact[0] && compact[0].length <= 6) return compact[0].toUpperCase();
  return null;
}

// ISO 8601 (Tubi's start_time/end_time) → epoch ms, or NaN when unparseable (that airing is then skipped:
// Program.start/end are required numbers).
function toEpoch(iso: unknown): number {
  return Date.parse(String(iso));
}

/**
 * Map the shared Tubi catalog rows (each carrying content_id, title, group, and embedded programs[]) into the
 * local guide shapes and REPLACE the per-source stores (epgchannels + programs, both scoped by `source`).
 * Returns the new counts. Used by BOTH the playlist-sync hook (afterSync, passing its already-fetched live
 * rows) and the standalone EPG sync (syncTubiEpg, which fetches live rows itself).
 */
export async function writeTubiEpg(
  raw: any[],
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number }> {
  const channelDocs: EpgChannelDoc[] = [];
  const programDocs: ProgramDoc[] = [];

  for (const row of raw) {
    if (row?.content_id == null) continue;
    const cid = String(row.content_id);
    const compositeId = `${sourceId}:${cid}`; // EpgChannel._id == Program.channelId (the composite join key)
    const name = String(row.title ?? '');
    const group = row.group || 'Other';
    const callSign = deriveCallSign(name);

    // (A) the guide's channel record — channelId (bare) + source are the 2-factor link targets.
    channelDocs.push({
      _id: compositeId,
      callSign,
      affiliateName: name,
      channelId: cid,
      channelNo: null,
      source: sourceId,
    });

    // (B) this channel's schedule — keyed by the COMPOSITE channelId. NaN-timed airings are skipped.
    for (const p of row.programs ?? []) {
      const start = toEpoch(p.start_time);
      const end = toEpoch(p.end_time);
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      programDocs.push({
        channelId: compositeId,
        start,
        end,
        offset,
        title: String(p.title ?? ''),
        cat: group, // Tubi has no per-program category — fall back to the channel group
        source: sourceId,
        callSign,
        channelNo: null,
        shortDesc: p.description || null,
        rating: p.ratings?.[0]?.code ?? null,
        seriesId: null, // Tubi exposes no series id
        season: p.season_number != null ? String(p.season_number) : null,
        episode: p.episode_number != null ? String(p.episode_number) : null,
        episodeTitle: p.episode_title || null,
      });
    }
  }

  // Per-source replace (the same pattern Gracenote/EPG-PW use).
  await EpgChannel.deleteMany({ source: sourceId });
  if (channelDocs.length) await EpgChannel.insertMany(channelDocs, { ordered: false });

  await Program.deleteMany({ source: sourceId });
  if (programDocs.length) await Program.insertMany(programDocs, { ordered: false });

  return { channels: channelDocs.length, programs: programDocs.length };
}

/**
 * Standalone EPG sync (the EPG Sources "Sync" button + scheduler path). Fetches the Tubi catalog LIVE-ONLY
 * (no snapshot fallback: a transient outage should fail loudly → status 'error' → the existing guide is
 * preserved, never replaced with stale snapshot data) and replaces the per-source guide. Touches ONLY the
 * EPG stores — never the tubi playlist. Dispatched from syncEpgSource on src.source === 'tubi'.
 */
export async function syncTubiEpg(
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number }> {
  const { raw } = await fetchTubiCatalog({ allowSnapshot: false });
  return writeTubiEpg(raw, sourceId, offset);
}

/**
 * Create-or-update the 'tubi' EpgSource row — called by the tubi playlist-sync hook so the EPG source
 * appears (and its counts refresh) whenever the playlist syncs. Refreshed fields go in $set; user-owned /
 * lifetime fields ($setOnInsert) are written once so a user's schedule (auto/interval) and the sync counters
 * survive a re-sync. The standalone syncEpgSource path owns the lifetime $inc thereafter.
 *
 * builtin is deliberately FALSE (matching how the POST /api/epg-sources route creates user sources): the
 * EPG Sources UI hides Sync/Delete and disables Edit/schedule for builtin sources, and the requirement is
 * that the tubi EPG source have the SAME capabilities as any other. (The tubi *playlist* is builtin; that's
 * a separate object.) The source is still system-managed — a re-sync re-creates it if deleted.
 */
export async function upsertTubiEpgSource(
  sourceId: string,
  counts: { channels: number; programs: number },
): Promise<void> {
  await EpgSource.updateOne(
    { id: sourceId },
    {
      $set: {
        name: 'Tubi TV Schedule',
        url: TUBI_LIVE_URL,
        source: 'tubi', // sync discriminator + the SOURCE chip; the (separate) id is the composite namespace
        channels: counts.channels,
        programs: counts.programs,
        lastSync: new Date().toISOString(),
        status: 'good',
        builtin: false,
        playlistBinding: true, // created by the tubi playlist's afterSync — hides sync/schedule controls in the UI
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
