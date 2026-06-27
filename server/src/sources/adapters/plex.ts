// plex source adapter (Plex Live TV — Plex's free FAST service, the watch.plex.tv web client). The FOURTEENTH
// FastChannels FAST source ported onto makeFastSource, and the SIXTH of the family (after xumo + stirr + tcl +
// pluto + roku) that is SENTINEL + RESOLVE rather than direct-HLS: the `/lineups/plex/channels` catalog yields
// channel ids/metadata, and the playable master is minted on demand at epg.provider.plex.tv (a signed library/parts
// HLS master → 302 to AWS MediaTailor segments). The TWIST vs the rest of the resolve family is a fully ANONYMOUS
// JWT (no credentials, no cookies, no csrf — simpler than roku's cookie+csrf session): an anon X-Plex-Token gates
// the catalog/EPG/resolve hops (cached in-process with a TTL, NOT a per-user surface). So normalize() stores a
// `plex://<compoundId>` ENTRY sentinel (the dulo/pluto/roku custom-scheme posture — the catalog gives only ids) and
// resolveStream() builds the signed master URL PER PLAY (all in plex/config.ts), pre-allowing the resolved host
// into a per-source dynamic SSRF allow-set (the proxy then learns the MediaTailor/CDN child hosts during playlist
// rewrite). EPG is the source's OWN per-channel per-day grid fanout (afterSync → buildPlexEpg → writeFastEpg). A
// gracenote crosswalk call is wired but no-ops until a plex-playlist-addon.json is committed. Ported from
// FastChannels plex.py (1120 LOC; the in-process token/catalog port is far leaner — see plex/config.ts header).
//
// ⚠️ Two id forms (the catalog `id` is COMPOUND `<serverPrefix>-<channelId>`, the prefix rotates on infra
// migrations; `gridKey` is the STABLE channel part): the deterministic masq `_id` uses the STABLE gridKey (so a
// prefix rotation doesn't churn ids) while the `plex://<compoundId>` sentinel carries the COMPOUND id (the resolve
// manifest path needs it). The EPG grid is keyed by gridKey. See plex/config.ts.

import { readFileSync } from 'node:fs';
import { makeFastSource } from './_fast/template.js';
import { createDynamicAllow } from './_fast/dynamicAllow.js';
import {
  PLEX_SUFFIXES,
  PLEX_STREAM_HEADERS,
  channelEntryUrl,
  isPlexEntry,
  parsePlexEntry,
  resolvePlexMaster,
  fetchPlexRows,
  type PlexRow,
} from './plex/config.js';
import { PLEX_EPG_ADDON_FILE, snapshotFile } from '../paths.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { logger } from '../core/logger.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
import { writeFastEpg, linkFastSelfEpg, upsertFastEpgSource } from '../../epg/fastSelfEpg.js';
import { buildPlexEpg, PLEX_EPG_NAME, PLEX_EPG_URL } from '../../epg/plex.js';
import type { RawListing } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SOURCE_ID = 'plex';
const SNAPSHOT = snapshotFile(SOURCE_ID);

// A per-source SSRF allow-set seeded with the Plex/CDN suffixes; grown at runtime by resolveStream (the resolved
// master host) + the proxy's onPlaylistChildHost (the variant/segment hosts seen inside a resolved playlist).
// Matters here because the master + variants are minted on `epg.provider.plex.tv` and the segments 302 to AWS
// MediaTailor + a long tail of CloudFront/Akamai/Fastly CDN hosts a static suffix list can't fully enumerate
// (learned at play time); private IPs are always blocked.
const allow = createDynamicAllow(PLEX_SUFFIXES);

// LIVE: the trimmed catalog rows. OFFLINE: the committed snapshot (buildSource flips status to 'warn' on
// meta.live:false). Snapshot shape is { channels: PlexRow[] } so rebuild-source-seed.ts round-trips it.
async function listChannels(): Promise<RawListing> {
  try {
    const raw = await fetchPlexRows();
    return { raw, meta: { live: true, count: raw.length, endpoint: 'epg.provider.plex.tv', fetchedAt: new Date().toISOString() } };
  } catch (err) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: PlexRow[] };
    return {
      raw: snap.channels || [],
      meta: { live: false, fallback: 'plex.snapshot.json', reason: (err as Error).message },
    };
  }
}

// One catalog row → one SourceChannel. The stream entry is the `plex://<compoundId>` ENTRY sentinel (resolved per
// play); served as an entry (→ B-Roll slate + telemetry + ffprobe). The masq `_id` uses the STABLE gridKey; the
// sentinel carries the COMPOUND id. Grouped by the channel's derived category.
function normalize(raw: PlexRow, { ingestedAt }: { ingestedAt: string }): SourceChannelDoc | null {
  if (!raw || !raw.channelId || !raw.id || !raw.name) return null;
  const id = String(raw.channelId);
  const group = String(raw.category || 'Live TV');
  return {
    _id: `${SOURCE_ID}:${id}`,
    source: SOURCE_ID,
    sourceChannelId: id,
    name: String(raw.name),
    category: group,
    groupKey: group,
    groupLabel: group,
    logoUrl: raw.logo || null,
    streamEntryUrl: channelEntryUrl(String(raw.id)),
    isPlayable: true, // liveness is request-time (resolve); optimistic at sync time
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    ingestedAt,
  };
}

// The `plex://<compoundId>` sentinel is the channel ENTRY → resolveStream builds a signed master per play.
function isEntryUrl(url: string): boolean {
  return isPlexEntry(url);
}

// Build the signed library/parts master per play (deterministic given the compound id + anon token; all in
// plex/config.ts). Pre-allow the resolved host so the proxy's SSRF gate passes the master + its same-host variant
// hops (the proxy also learns MediaTailor/CDN child hosts via onPlaylistChildHost during rewrite).
async function resolveStream(entryUrl: string): Promise<{ masterUrl: string }> {
  const parsed = parsePlexEntry(entryUrl);
  if (!parsed) throw new Error(`plex: not a channel entry url: ${entryUrl}`);
  const masterUrl = await resolvePlexMaster(parsed.compoundId);
  try {
    allow.allow(new URL(masterUrl).hostname);
  } catch {
    /* ignore malformed */
  }
  return { masterUrl };
}

// Build the plex self-EPG from the per-channel per-day grid fanout, upsert the 'plex' EpgSource, and self-link the
// still-untouched channels onto it. Live-only (the caller guards on `live` so a snapshot fallback never overwrites a
// good guide). FILL-ONLY-IF-UNTOUCHED — same posture as the family.
async function applyPlexSelfEpg(sourceId: string, raw: PlexRow[]): Promise<void> {
  const { offset, defaulted } = await resolveProgramOffset();
  if (defaulted) logger.warn('seed', `[${sourceId}] settings offset unset — guide times stored as UTC (+0000)`);
  const { channelDocs, programDocs } = await buildPlexEpg(raw, offset);
  const counts = await writeFastEpg(sourceId, channelDocs, programDocs);
  await upsertFastEpgSource(sourceId, counts, { name: PLEX_EPG_NAME, url: PLEX_EPG_URL });
  const linked = await linkFastSelfEpg(sourceId, counts.channelIds);
  logger.info(
    'seed',
    `[${sourceId}] self-EPG: ${counts.channels} channels / ${counts.programs} programs; linked ${linked} untouched channel(s)`,
  );
}

const plexAdapter = makeFastSource({
  id: SOURCE_ID,
  label: 'Plex',

  // Plex channels carry a derived category; group by it, alphabetical.
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. Plex carries its OWN self-built guide (afterSync writes a 'plex' EpgSource
  // from the per-channel grid, playlistBinding:true) → Playlist-bound EPG is true.
  builtinMeta: {
    globalPlaylist: true,
    clonePlaylist: true,
    syncSchedules: true,
    videoEngineCustomization: true,
    playlistBoundEpg: true,
    epgSyncSchedules: false,
  },

  listChannels,
  normalize,

  // ── proxy / resolution overrides (sentinel entry + anon-token resolve + dynamic CDN allow-set) ──
  allowedSuffixes: PLEX_SUFFIXES,
  upstreamHeaders: () => ({ ...PLEX_STREAM_HEADERS }), // UA + X-Plex product/client (the token rides in the URL)
  isAllowedUpstream: (url: string) => allow.isAllowedUpstream(url),
  onPlaylistChildHost: (host: string) => allow.onPlaylistChildHost(host),
  isEntryUrl,
  resolveStream,

  // ── post-sync: gracenote crosswalk (wired; no-ops until the addon lands) THEN plex self-EPG (live-only) ──
  async afterSync({ sourceId, live, raw }) {
    await applyEpgCrosswalk(sourceId, PLEX_EPG_ADDON_FILE).catch((err) =>
      logger.warn('seed', `[${sourceId}] EPG crosswalk failed (continuing): ${(err as Error).message}`),
    );
    if (live) {
      await applyPlexSelfEpg(sourceId, raw as PlexRow[]).catch((err) =>
        logger.warn('seed', `[${sourceId}] self-EPG (grid) failed (continuing): ${(err as Error).message}`),
      );
    }
  },
});

export default plexAdapter;
