// whale source adapter (Whale TV+ — the rlaxx/zeasn.tv platform). The fifth FastChannels FAST source ported
// onto makeFastSource, and a MACRO-EXPANSION one like LG: each channel's `chlUrl` IS the real HLS master
// (pathname ends .m3u8) but carries Ottera/SSAI ad macros ([did]/[session_id]/[cachebuster]/…) that need
// PER-PLAY freshness, so resolveStream expands them at play time rather than baking a subset in at normalize.
// ONE twist vs LG: a cheap keyless AUTH BOOTSTRAP (apiToken → short-lived bearer; NOT a per-user auth surface)
// gates the catalog + the /epg fetch — handled entirely in the leaf (whale/config.ts getToken). The guide is a
// SEPARATE /epg fetch keyed by channel id (afterSync → buildWhaleEpg → writeFastEpg), the Vidaa shape (not LG's
// inline programs[]); a gracenote crosswalk call is wired but no-ops until a whale-playlist-addon.json lands.

import { readFileSync } from 'node:fs';
import { makeFastSource } from './_fast/template.js';
import { createDynamicAllow } from './_fast/dynamicAllow.js';
import {
  WHALE_SUFFIXES,
  WHALE_HEADERS,
  CHANNELS_URL,
  fillUrlMacros,
  fetchWhaleRows,
  type WhaleRow,
} from './whale/config.js';
import { WHALE_EPG_ADDON_FILE, snapshotFile } from '../paths.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { logger } from '../core/logger.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
import { writeFastEpg, linkFastSelfEpg, upsertFastEpgSource } from '../../epg/fastSelfEpg.js';
import { buildWhaleEpg, WHALE_EPG_NAME, WHALE_EPG_URL } from '../../epg/whale.js';
import type { RawListing } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SOURCE_ID = 'whale';
const SNAPSHOT = snapshotFile(SOURCE_ID);

// A per-source SSRF allow-set seeded with the Whale CDN suffixes. Because whale is a direct source (the stored
// master needs only macro expansion, no redirect), resolveStream pre-allows the expanded master host at play
// time, and the proxy's onPlaylistChildHost learns the variant/segment child hosts seen inside the resolved
// master — so a new per-brand SSAI host that appears in the catalog is covered without a code change (private
// IPs always blocked). This matters more here than for lg: Whale fronts many api-ott.<brand>.tv hosts.
const allow = createDynamicAllow(WHALE_SUFFIXES);

// LIVE: the trimmed catalog rows (currentProgram rides along for the guide). OFFLINE: the committed snapshot
// (buildSource flips status to 'warn' on meta.live:false). Snapshot shape is { channels: <WhaleRow[]> } so
// rebuild-source-seed.ts round-trips it.
async function listChannels(): Promise<RawListing> {
  try {
    const raw = await fetchWhaleRows();
    return { raw, meta: { live: true, count: raw.length, endpoint: CHANNELS_URL, fetchedAt: new Date().toISOString() } };
  } catch (err) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: WhaleRow[] };
    return {
      raw: snap.channels || [],
      meta: { live: false, fallback: 'whale.snapshot.json', reason: (err as Error).message },
    };
  }
}

// One catalog row → one SourceChannel. The stream entry is the RAW (macro-laden) master, served as an .m3u8
// entry (→ B-Roll slate + telemetry + ffprobe); resolveStream fills the macros per play. Grouped by Whale's
// canonicalized genre.
function normalize(raw: WhaleRow, { ingestedAt }: { ingestedAt: string }): SourceChannelDoc | null {
  if (!raw || !raw.channelId || !raw.name || !raw.streamUrl) return null;
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

// Fill the per-play ad macros baked into the stored master (the FastChannels whale.py `_fill_url_macros`
// posture) and pre-allow the resolved host so the proxy's SSRF gate passes at play time regardless of process
// restart (the catalog is adapter-curated, the same trust level as the static suffix seed). The proxy then
// learns the master's variant/segment child hosts via onPlaylistChildHost. isEntryUrl stays the default .m3u8
// test (Whale masters end .m3u8 even with the macro query string).
async function resolveStream(entryUrl: string): Promise<{ masterUrl: string }> {
  const masterUrl = fillUrlMacros(entryUrl);
  try {
    allow.allow(new URL(masterUrl).hostname);
  } catch {
    /* ignore malformed */
  }
  return { masterUrl };
}

// Build the whale self-EPG from the SEPARATE /epg fetch (keyed off the same `raw` catalog rows buildSource
// consumed — currentProgram descriptions ride along), upsert the 'whale' EpgSource, and self-link the
// still-untouched channels onto it. Live-only (the caller guards on `live` so a snapshot fallback never
// overwrites a good guide). FILL-ONLY-IF-UNTOUCHED — same posture as dlhd/dami/samsung/vizio/lg/vidaa.
async function applyWhaleSelfEpg(sourceId: string, raw: WhaleRow[]): Promise<void> {
  const { offset, defaulted } = await resolveProgramOffset();
  if (defaulted) logger.warn('seed', `[${sourceId}] settings offset unset — guide times stored as UTC (+0000)`);
  const { channelDocs, programDocs } = await buildWhaleEpg(raw, offset);
  const counts = await writeFastEpg(sourceId, channelDocs, programDocs);
  await upsertFastEpgSource(sourceId, counts, { name: WHALE_EPG_NAME, url: WHALE_EPG_URL });
  const linked = await linkFastSelfEpg(sourceId, counts.channelIds);
  logger.info(
    'seed',
    `[${sourceId}] self-EPG: ${counts.channels} channels / ${counts.programs} programs; linked ${linked} untouched channel(s)`,
  );
}

const whaleAdapter = makeFastSource({
  id: SOURCE_ID,
  label: 'Whale TV+',

  // Whale's rlaxx catalog carries a genre per channel (canonicalized from the category bucket); bucket by it, alphabetical.
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. Whale carries its OWN self-built guide (afterSync writes a 'whale'
  // EpgSource from the /epg schedule, playlistBinding:true) → Playlist-bound EPG is true.
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

  // ── proxy / resolution overrides (direct HLS + per-play macro expansion + dynamic CDN allow-set) ──
  allowedSuffixes: WHALE_SUFFIXES,
  upstreamHeaders: () => ({ ...WHALE_HEADERS }),
  isAllowedUpstream: (url: string) => allow.isAllowedUpstream(url),
  onPlaylistChildHost: (host: string) => allow.onPlaylistChildHost(host),
  resolveStream, // macro-fill + pre-allow the resolved host (isEntryUrl stays the default .m3u8 test)

  // ── post-sync: gracenote crosswalk (wired; no-ops until the addon lands) THEN whale self-EPG (live-only) ──
  async afterSync({ sourceId, live, raw }) {
    await applyEpgCrosswalk(sourceId, WHALE_EPG_ADDON_FILE).catch((err) =>
      logger.warn('seed', `[${sourceId}] EPG crosswalk failed (continuing): ${(err as Error).message}`),
    );
    if (live) {
      await applyWhaleSelfEpg(sourceId, raw as WhaleRow[]).catch((err) =>
        logger.warn('seed', `[${sourceId}] self-EPG (grid) failed (continuing): ${(err as Error).message}`),
      );
    }
  },
});

export default whaleAdapter;
