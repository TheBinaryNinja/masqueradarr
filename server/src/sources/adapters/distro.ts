// distro source adapter (Distro TV — the jsrdn `tv_v5` FAST aggregator). The EIGHTH FastChannels FAST source
// ported onto makeFastSource, and a TIER-B (macro-expansion) port architecturally like LG/FreeLiveSports: each
// live show's seasons[0].episodes[0].content.url IS the real HLS master (pathname ends .m3u8) but carries jsrdn
// VAST ad macros (the DOUBLE-underscore `__MACRO__` vocab) that need PER-PLAY freshness — so resolveStream fills
// them at play time (the FastChannels distro.py `resolve()` posture) rather than baking a subset in at normalize.
// TWO twists vs FreeLiveSports: (1) GEO-QUALIFIED channel ids ('<GEO>:<tvg_id>' — env DISTRO_GEO, default 'US';
// the SAME tvg_id recurs across regions); (2) the guide is a SEPARATE epg/query.php fetch keyed by the BARE
// tvg_id (afterSync → buildDistroEpg → writeFastEpg), not inline. The catalog fetch uses an Android-TV UA; the
// STREAM proxy needs the browser UA + distro.tv Origin/Referer (the cloudfront/publica CDNs are Origin-gated) —
// DISTRO_STREAM_HEADERS, fed to upstreamHeaders. A gracenote crosswalk call is wired but no-ops until a
// distro-playlist-addon.json is committed (a follow-up, like vidaa/whale). Ported from FastChannels distro.py
// (589 LOC).

import { readFileSync } from 'node:fs';
import { makeFastSource } from './_fast/template.js';
import { createDynamicAllow } from './_fast/dynamicAllow.js';
import {
  DISTRO_SUFFIXES,
  DISTRO_STREAM_HEADERS,
  fillStreamMacros,
  fetchDistroRows,
  type DistroRow,
} from './distro/config.js';
import { DISTRO_EPG_ADDON_FILE, snapshotFile } from '../paths.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { logger } from '../core/logger.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
import { writeFastEpg, linkFastSelfEpg, upsertFastEpgSource } from '../../epg/fastSelfEpg.js';
import { buildDistroEpg, DISTRO_EPG_NAME, DISTRO_EPG_URL } from '../../epg/distro.js';
import type { RawListing } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SOURCE_ID = 'distro';
const SNAPSHOT = snapshotFile(SOURCE_ID);

// A per-source SSRF allow-set seeded with the Distro CDN suffixes. Because distro is a direct source (the stored
// master needs only macro fill, no redirect), resolveStream pre-allows the filled master host at play time, and
// the proxy's onPlaylistChildHost learns the variant/segment child hosts seen inside the resolved master — so a
// new CDN that appears in the catalog is covered without a code change (private IPs always blocked). Matters here:
// Distro fronts cloudfront/publica/amagi/caton/cdn01 plus a long CDN tail.
const allow = createDynamicAllow(DISTRO_SUFFIXES);

// LIVE: the trimmed catalog rows (across the requested geos). OFFLINE: the committed snapshot (buildSource flips
// status to 'warn' on meta.live:false). Snapshot shape is { channels: <DistroRow[]> } so rebuild-source-seed.ts
// round-trips it.
async function listChannels(): Promise<RawListing> {
  try {
    const raw = await fetchDistroRows();
    return { raw, meta: { live: true, count: raw.length, endpoint: 'tv.jsrdn.com', fetchedAt: new Date().toISOString() } };
  } catch (err) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: DistroRow[] };
    return {
      raw: snap.channels || [],
      meta: { live: false, fallback: 'distro.snapshot.json', reason: (err as Error).message },
    };
  }
}

// One catalog row → one SourceChannel. The stream entry is the RAW (macro-laden) master, served as an .m3u8 entry
// (→ B-Roll slate + telemetry + ffprobe); resolveStream fills the macros per play. `_id`/sourceChannelId carry the
// GEO-QUALIFIED id; grouped by the parsed genre category (language tags split off).
function normalize(raw: DistroRow, { ingestedAt }: { ingestedAt: string }): SourceChannelDoc | null {
  if (!raw || !raw.channelId || !raw.name || !raw.streamUrl) return null;
  if (!/^https?:\/\//i.test(raw.streamUrl)) return null; // non-HTTP master — drop
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
    isPlayable: true, // liveness is request-time (resolve); optimistic at sync time
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    ingestedAt,
  };
}

// Fill the per-play VAST ad macros baked into the stored master (the FastChannels distro.py resolve() posture)
// and pre-allow the resolved host so the proxy's SSRF gate passes at play time regardless of process restart (the
// catalog is adapter-curated, the same trust level as the static suffix seed). The proxy then learns the master's
// variant/segment child hosts via onPlaylistChildHost. isEntryUrl stays the default .m3u8 test (Distro masters end
// .m3u8 even with the macro query string).
async function resolveStream(entryUrl: string): Promise<{ masterUrl: string }> {
  const masterUrl = fillStreamMacros(entryUrl);
  try {
    allow.allow(new URL(masterUrl).hostname);
  } catch {
    /* ignore malformed */
  }
  return { masterUrl };
}

// Build the distro self-EPG from the separate epg/query.php schedule (keyed off the same `raw` catalog rows
// buildSource consumed), upsert the 'distro' EpgSource, and self-link the still-untouched channels onto it.
// Live-only (the caller guards on `live` so a snapshot fallback never overwrites a good guide). FILL-ONLY-IF-
// UNTOUCHED — same posture as dlhd/dami/samsung/vizio/lg/vidaa/whale/xumo/freelivesports.
async function applyDistroSelfEpg(sourceId: string, raw: DistroRow[]): Promise<void> {
  const { offset, defaulted } = await resolveProgramOffset();
  if (defaulted) logger.warn('seed', `[${sourceId}] settings offset unset — guide times stored as UTC (+0000)`);
  const { channelDocs, programDocs } = await buildDistroEpg(raw, offset);
  const counts = await writeFastEpg(sourceId, channelDocs, programDocs);
  await upsertFastEpgSource(sourceId, counts, { name: DISTRO_EPG_NAME, url: DISTRO_EPG_URL });
  const linked = await linkFastSelfEpg(sourceId, counts.channelIds);
  logger.info(
    'seed',
    `[${sourceId}] self-EPG: ${counts.channels} channels / ${counts.programs} programs; linked ${linked} untouched channel(s)`,
  );
}

const distroAdapter = makeFastSource({
  id: SOURCE_ID,
  label: 'Distro TV',

  // Distro carries a parsed genre per show; bucket by it, alphabetical.
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. Distro carries its OWN self-built guide (afterSync writes a 'distro'
  // EpgSource from the query.php schedule, playlistBinding:true) → Playlist-bound EPG is true.
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

  // ── proxy / resolution overrides (direct HLS + per-play macro fill + dynamic CDN allow-set) ──
  allowedSuffixes: DISTRO_SUFFIXES,
  upstreamHeaders: () => ({ ...DISTRO_STREAM_HEADERS }), // browser UA + distro.tv Origin/Referer (Origin-gated CDNs)
  isAllowedUpstream: (url: string) => allow.isAllowedUpstream(url),
  onPlaylistChildHost: (host: string) => allow.onPlaylistChildHost(host),
  resolveStream, // macro-fill + pre-allow the resolved host (isEntryUrl stays the default .m3u8 test)

  // ── post-sync: gracenote crosswalk (wired; no-ops until the addon lands) THEN distro self-EPG (live-only) ──
  async afterSync({ sourceId, live, raw }) {
    await applyEpgCrosswalk(sourceId, DISTRO_EPG_ADDON_FILE).catch((err) =>
      logger.warn('seed', `[${sourceId}] EPG crosswalk failed (continuing): ${(err as Error).message}`),
    );
    if (live) {
      await applyDistroSelfEpg(sourceId, raw as DistroRow[]).catch((err) =>
        logger.warn('seed', `[${sourceId}] self-EPG (query.php) failed (continuing): ${(err as Error).message}`),
      );
    }
  },
});

export default distroAdapter;
