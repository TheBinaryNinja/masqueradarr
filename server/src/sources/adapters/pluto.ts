// pluto source adapter (Pluto TV — Paramount's free FAST service, the pluto.tv web client). The TWELFTH
// FastChannels FAST source ported onto makeFastSource, and the FOURTH of the family (after xumo + stirr + tcl)
// that is SENTINEL + RESOLVE rather than direct-HLS: the `/v2/guide/channels` catalog yields only channel ids,
// and the playable master is minted on demand by the stitcher CDN (a per-play JWT-stitched HLS master). The ONE
// twist vs the rest of the resolve family is a per-region BOOT/SESSION (boot.pluto.tv → a short-lived
// sessionToken + stitcherParams, cached per region, geo-gated via X-Forwarded-For — NOT a per-user surface, like
// whale's keyless token) that gates BOTH the catalog/EPG fetches AND the resolve. So normalize() stores a
// `pluto://<region>/<id>` ENTRY sentinel (the dulo/local custom-scheme posture — the region rides along because
// resolveStream must boot the SAME region's token) and resolveStream() boots the region (cached) and constructs
// the stitcher master PER PLAY (all in pluto/config.ts), learning the resolved CDN host into a per-source dynamic
// SSRF allow-set (the proxy then learns the variant/segment child hosts during playlist rewrite). EPG is the
// source's OWN per-region timelines guide (afterSync → buildPlutoEpg → writeFastEpg). A gracenote crosswalk call
// is wired but no-ops until a pluto-playlist-addon.json is committed. Ported from FastChannels pluto.py (575 LOC).

import { readFileSync } from 'node:fs';
import { makeFastSource } from './_fast/template.js';
import { createDynamicAllow } from './_fast/dynamicAllow.js';
import {
  PLUTO_SUFFIXES,
  PLUTO_STREAM_HEADERS,
  channelEntryUrl,
  isPlutoEntry,
  parsePlutoEntry,
  resolvePlutoMaster,
  fetchPlutoRows,
  type PlutoRow,
} from './pluto/config.js';
import { PLUTO_EPG_ADDON_FILE, snapshotFile } from '../paths.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { logger } from '../core/logger.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
import { writeFastEpg, linkFastSelfEpg, upsertFastEpgSource } from '../../epg/fastSelfEpg.js';
import { buildPlutoEpg, PLUTO_EPG_NAME, PLUTO_EPG_URL } from '../../epg/pluto.js';
import type { RawListing } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SOURCE_ID = 'pluto';
const SNAPSHOT = snapshotFile(SOURCE_ID);

// A per-source SSRF allow-set seeded with the Pluto/CDN suffixes; grown at runtime by resolveStream (the resolved
// stitcher master host) + the proxy's onPlaylistChildHost (the variant/segment hosts seen inside a resolved
// playlist). Matters here because the stitcher mints the master on a *.prd.pluto.tv host and the ad-stitched child
// hops land on a long tail of Pluto CDN / JW Player hosts a static suffix list can't fully enumerate; private IPs
// are always blocked.
const allow = createDynamicAllow(PLUTO_SUFFIXES);

// LIVE: the trimmed catalog rows. OFFLINE: the committed snapshot (buildSource flips status to 'warn' on
// meta.live:false). Snapshot shape is { channels: PlutoRow[] } so rebuild-source-seed.ts round-trips it.
async function listChannels(): Promise<RawListing> {
  try {
    const raw = await fetchPlutoRows();
    return { raw, meta: { live: true, count: raw.length, endpoint: 'service-channels.clusters.pluto.tv', fetchedAt: new Date().toISOString() } };
  } catch (err) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: PlutoRow[] };
    return {
      raw: snap.channels || [],
      meta: { live: false, fallback: 'pluto.snapshot.json', reason: (err as Error).message },
    };
  }
}

// One catalog row → one SourceChannel. The stream entry is the `pluto://<region>/<id>` ENTRY sentinel (carrying
// the region; resolved per play); served as an entry (→ B-Roll slate + telemetry + ffprobe). Grouped by Pluto's
// guide category.
function normalize(raw: PlutoRow, { ingestedAt }: { ingestedAt: string }): SourceChannelDoc | null {
  if (!raw || !raw.channelId || !raw.name || !raw.region) return null;
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
    streamEntryUrl: channelEntryUrl(raw.region, id),
    isPlayable: true, // liveness is request-time (resolve); optimistic at sync time
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    ingestedAt,
  };
}

// The `pluto://<region>/<id>` sentinel is the channel ENTRY → resolveStream boots the region + constructs a master.
function isEntryUrl(url: string): boolean {
  return isPlutoEntry(url);
}

// Boot + construct resolve (per play; all in pluto/config.ts) keyed off the region + channel id parsed from the
// entry sentinel. Pre-allow the resolved host so the proxy's SSRF gate passes the master's same-host child hops
// (the proxy also learns variant/segment hosts via onPlaylistChildHost during rewrite).
async function resolveStream(entryUrl: string): Promise<{ masterUrl: string }> {
  const parsed = parsePlutoEntry(entryUrl);
  if (!parsed) throw new Error(`pluto: not a channel entry url: ${entryUrl}`);
  const masterUrl = await resolvePlutoMaster(parsed.region, parsed.channelId);
  try {
    allow.allow(new URL(masterUrl).hostname);
  } catch {
    /* ignore malformed */
  }
  return { masterUrl };
}

// Build the pluto self-EPG from the per-region timelines guide, upsert the 'pluto' EpgSource, and self-link the
// still-untouched channels onto it. Live-only (the caller guards on `live` so a snapshot fallback never overwrites
// a good guide). FILL-ONLY-IF-UNTOUCHED — same posture as the family.
async function applyPlutoSelfEpg(sourceId: string, raw: PlutoRow[]): Promise<void> {
  const { offset, defaulted } = await resolveProgramOffset();
  if (defaulted) logger.warn('seed', `[${sourceId}] settings offset unset — guide times stored as UTC (+0000)`);
  const { channelDocs, programDocs } = await buildPlutoEpg(raw, offset);
  const counts = await writeFastEpg(sourceId, channelDocs, programDocs);
  await upsertFastEpgSource(sourceId, counts, { name: PLUTO_EPG_NAME, url: PLUTO_EPG_URL });
  const linked = await linkFastSelfEpg(sourceId, counts.channelIds);
  logger.info(
    'seed',
    `[${sourceId}] self-EPG: ${counts.channels} channels / ${counts.programs} programs; linked ${linked} untouched channel(s)`,
  );
}

const plutoAdapter = makeFastSource({
  id: SOURCE_ID,
  label: 'Pluto TV',

  // Pluto's catalog carries a guide category per channel; group by it, alphabetical.
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. Pluto carries its OWN self-built guide (afterSync writes a 'pluto' EpgSource
  // from the per-region timelines, playlistBinding:true) → Playlist-bound EPG is true.
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

  // ── proxy / resolution overrides (sentinel entry + boot-and-construct resolve + dynamic CDN allow-set) ──
  allowedSuffixes: PLUTO_SUFFIXES,
  upstreamHeaders: () => ({ ...PLUTO_STREAM_HEADERS }), // UA only (the stitcher CDN ignores the pluto.tv Origin)
  isAllowedUpstream: (url: string) => allow.isAllowedUpstream(url),
  onPlaylistChildHost: (host: string) => allow.onPlaylistChildHost(host),
  isEntryUrl,
  resolveStream,

  // ── post-sync: gracenote crosswalk (wired; no-ops until the addon lands) THEN pluto self-EPG (live-only) ──
  async afterSync({ sourceId, live, raw }) {
    await applyEpgCrosswalk(sourceId, PLUTO_EPG_ADDON_FILE).catch((err) =>
      logger.warn('seed', `[${sourceId}] EPG crosswalk failed (continuing): ${(err as Error).message}`),
    );
    if (live) {
      await applyPlutoSelfEpg(sourceId, raw as PlutoRow[]).catch((err) =>
        logger.warn('seed', `[${sourceId}] self-EPG (timelines) failed (continuing): ${(err as Error).message}`),
      );
    }
  },
});

export default plutoAdapter;
