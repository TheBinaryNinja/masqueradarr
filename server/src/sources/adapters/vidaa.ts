// vidaa source adapter (Vidaa Free TV — Hisense). The fourth FastChannels FAST source ported onto makeFastSource,
// and a DIRECT-HLS one like vizio: each station's primary liveStream `url` IS the real HLS master (cleaned of ad-DI
// macros at catalog time), so resolveStream is identity (pre-allow the host; no per-play work, unlike LG). Two
// twists vs vizio: (1) a BOOTSTRAP step — the catalog + guide calls are built from the client-config's BOURL +
// tenant (config.ts bootstrap()); (2) GEO-QUALIFIED channel ids — the catalog is region-fed (env VIDAA_GEO, default
// 'us,ca') and the same uid recurs across regions, so the source-channel id is '<GEO_UPPER>:<uid>'. DRM / DASH
// (mpd) streams are DROPPED at normalize (HLS-only proxy). EPG is a SEPARATE /epg/grid fetch keyed by bare station
// uid (afterSync → buildVidaaEpg → writeFastEpg); a gracenote crosswalk call is wired but no-ops until a
// vidaa-playlist-addon.json is committed (a follow-up, derivable from the catalog's tva-stationId).

import { readFileSync } from 'node:fs';
import { makeFastSource } from './_fast/template.js';
import { createDynamicAllow } from './_fast/dynamicAllow.js';
import { UA, VIDAA_SUFFIXES, fetchVidaaRows, type VidaaRow } from './vidaa/config.js';
import { VIDAA_EPG_ADDON_FILE, snapshotFile } from '../paths.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { logger } from '../core/logger.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
import { writeFastEpg, linkFastSelfEpg, upsertFastEpgSource } from '../../epg/fastSelfEpg.js';
import { buildVidaaEpg, VIDAA_EPG_NAME, VIDAA_EPG_URL } from '../../epg/vidaa.js';
import type { RawListing } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SOURCE_ID = 'vidaa';
const SNAPSHOT = snapshotFile(SOURCE_ID);

// A per-source SSRF allow-set seeded with the Vidaa CDN suffixes. Because vidaa is a direct source (no redirect),
// resolveStream pre-allows each stored master host at play time, and the proxy's onPlaylistChildHost learns the
// variant/segment child hosts seen inside the resolved master — so a new CDN that appears in the catalog is covered
// without a code change (private IPs always blocked).
const allow = createDynamicAllow(VIDAA_SUFFIXES);

// LIVE: the trimmed catalog rows (across the requested geos). OFFLINE: the committed snapshot (buildSource flips
// status to 'warn' on meta.live:false). Snapshot shape is { channels: <VidaaRow[]> } so rebuild-source-seed.ts
// round-trips it.
async function listChannels(): Promise<RawListing> {
  try {
    const raw = await fetchVidaaRows();
    return { raw, meta: { live: true, count: raw.length, endpoint: 'vtvapp-ovp.vidaahub.com', fetchedAt: new Date().toISOString() } };
  } catch (err) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: VidaaRow[] };
    return {
      raw: snap.channels || [],
      meta: { live: false, fallback: 'vidaa.snapshot.json', reason: (err as Error).message },
    };
  }
}

// One catalog row → one SourceChannel. DRM / DASH channels are DROPPED (HLS-only proxy); a row whose cleaned master
// isn't http(s) is also dropped. The stream entry is the already-cleaned master (served as an .m3u8 entry → B-Roll
// slate + telemetry + ffprobe). `_id`/sourceChannelId carry the GEO-QUALIFIED id; grouped by the extracted genre.
function normalize(raw: VidaaRow, { ingestedAt }: { ingestedAt: string }): SourceChannelDoc | null {
  if (!raw || !raw.channelId || !raw.name) return null;
  if (raw.drm) return null; // DASH/DRM — out of scope (HLS-only proxy)
  if (!raw.streamUrl || !/^https?:\/\//i.test(raw.streamUrl)) return null; // non-HTTP master — drop
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
    streamEntryUrl: raw.streamUrl,
    isPlayable: true, // liveness is request-time; optimistic at sync time
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    ingestedAt,
  };
}

// Direct source: the stored master needs no resolution, but pre-allow its host so the proxy's SSRF gate passes at
// play time regardless of process restart (the catalog is adapter-curated, the same trust level as the static
// suffix seed). The proxy then learns the master's variant/segment child hosts via onPlaylistChildHost.
async function resolveStream(entryUrl: string): Promise<{ masterUrl: string }> {
  try {
    allow.allow(new URL(entryUrl).hostname);
  } catch {
    /* ignore malformed */
  }
  return { masterUrl: entryUrl };
}

// Build the vidaa self-EPG from the separate /epg/grid schedule (keyed off the same `raw` catalog rows buildSource
// consumed), upsert the 'vidaa' EpgSource, and self-link the still-untouched channels onto it. Live-only (the
// caller guards on `live` so a snapshot fallback never overwrites a good guide). FILL-ONLY-IF-UNTOUCHED — same
// posture as dlhd/dami/samsung/vizio/lg.
async function applyVidaaSelfEpg(sourceId: string, raw: VidaaRow[]): Promise<void> {
  const { offset, defaulted } = await resolveProgramOffset();
  if (defaulted) logger.warn('seed', `[${sourceId}] settings offset unset — guide times stored as UTC (+0000)`);
  const { channelDocs, programDocs } = await buildVidaaEpg(raw, offset);
  const counts = await writeFastEpg(sourceId, channelDocs, programDocs);
  await upsertFastEpgSource(sourceId, counts, { name: VIDAA_EPG_NAME, url: VIDAA_EPG_URL });
  const linked = await linkFastSelfEpg(sourceId, counts.channelIds);
  logger.info(
    'seed',
    `[${sourceId}] self-EPG: ${counts.channels} channels / ${counts.programs} programs; linked ${linked} untouched channel(s)`,
  );
}

const vidaaAdapter = makeFastSource({
  id: SOURCE_ID,
  label: 'Vidaa Free TV',

  // Vidaa carries a genre per station (extracted from taxonomyTerms / ad params); bucket by it, alphabetical.
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. Vidaa carries its OWN self-built guide (afterSync writes a 'vidaa' EpgSource
  // from the /epg/grid schedule, playlistBinding:true) → Playlist-bound EPG is true.
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

  // ── proxy / resolution overrides (direct HLS; identity resolve + dynamic CDN allow-set) ──
  allowedSuffixes: VIDAA_SUFFIXES,
  upstreamHeaders: () => ({ 'User-Agent': UA }),
  isAllowedUpstream: (url: string) => allow.isAllowedUpstream(url),
  onPlaylistChildHost: (host: string) => allow.onPlaylistChildHost(host),
  resolveStream, // identity + pre-allow the entry host (isEntryUrl stays the default .m3u8 test)

  // ── post-sync: gracenote crosswalk (wired; no-ops until the addon lands) THEN vidaa self-EPG (live-only) ──
  async afterSync({ sourceId, live, raw }) {
    await applyEpgCrosswalk(sourceId, VIDAA_EPG_ADDON_FILE).catch((err) =>
      logger.warn('seed', `[${sourceId}] EPG crosswalk failed (continuing): ${(err as Error).message}`),
    );
    if (live) {
      await applyVidaaSelfEpg(sourceId, raw as VidaaRow[]).catch((err) =>
        logger.warn('seed', `[${sourceId}] self-EPG (grid) failed (continuing): ${(err as Error).message}`),
      );
    }
  },
});

export default vidaaAdapter;
