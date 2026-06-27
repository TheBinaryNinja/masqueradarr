// stirr source adapter (STIRR — Sinclair's free FAST service, stirr.com). The NINTH FastChannels FAST source
// ported onto makeFastSource, and the SECOND of the family (after xumo) that is SENTINEL + RESOLVE rather than
// direct-HLS: the `videos/list` catalog yields only video ids + provider-EPG pointers, so each channel's stream
// is minted on demand. The stored entry is a `…/playable` ENTRY url (the dlhd/xumo posture — a real-looking URL
// whose video id is all that matters); resolveStream does ONE resolve hop PER PLAY (POST /playable →
// data[0].media[0] → fill the aniview `[vx_nonce]`, all in stirr/config.ts) and learns the resolved CDN host
// into a per-source dynamic SSRF allow-set (the proxy then learns the variant/segment child hosts during
// playlist rewrite). EPG is the source's OWN per-channel TWO-TIER guide (afterSync → buildStirrEpg →
// writeFastEpg): provider `epg_url` (XMLTV/JSON) first, STIRR `/api/epg` fallback. A gracenote crosswalk call is
// wired but no-ops until a stirr-playlist-addon.json is committed. Ported from FastChannels stirr.py (724 LOC).

import { readFileSync } from 'node:fs';
import { makeFastSource } from './_fast/template.js';
import { createDynamicAllow } from './_fast/dynamicAllow.js';
import {
  STIRR_SUFFIXES,
  STIRR_STREAM_HEADERS,
  channelEntryUrl,
  isStirrEntry,
  channelIdFromEntry,
  resolveStirrMaster,
  fetchStirrRows,
  type StirrRow,
} from './stirr/config.js';
import { STIRR_EPG_ADDON_FILE, snapshotFile } from '../paths.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { logger } from '../core/logger.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
import { writeFastEpg, linkFastSelfEpg, upsertFastEpgSource } from '../../epg/fastSelfEpg.js';
import { buildStirrEpg, STIRR_EPG_NAME, STIRR_EPG_URL } from '../../epg/stirr.js';
import type { RawListing } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SOURCE_ID = 'stirr';
const SNAPSHOT = snapshotFile(SOURCE_ID);

// A per-source SSRF allow-set seeded with the STIRR CDN suffixes; grown at runtime by resolveStream (the
// resolved aniview SSAI master host) + the proxy's onPlaylistChildHost (the SSAI variant/segment hosts seen
// inside a resolved playlist). Matters here because STIRR's masters resolve to aniview SSAI hosts and the
// ad-stitched child hops land on a long tail of provider/CDN hosts a static suffix list can't enumerate.
const allow = createDynamicAllow(STIRR_SUFFIXES);

// LIVE: the trimmed catalog rows. OFFLINE: the committed snapshot (buildSource flips status to 'warn' on
// meta.live:false). Snapshot shape is { channels: StirrRow[] } so rebuild-source-seed.ts round-trips it.
async function listChannels(): Promise<RawListing> {
  try {
    const raw = await fetchStirrRows();
    return { raw, meta: { live: true, count: raw.length, endpoint: 'stirr.com', fetchedAt: new Date().toISOString() } };
  } catch (err) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: StirrRow[] };
    return {
      raw: snap.channels || [],
      meta: { live: false, fallback: 'stirr.snapshot.json', reason: (err as Error).message },
    };
  }
}

// One catalog row → one SourceChannel. The stream entry is the `…/playable` ENTRY url (resolved per play);
// served as an entry (→ B-Roll slate + telemetry + ffprobe). Grouped by STIRR's mapped category.
function normalize(raw: StirrRow, { ingestedAt }: { ingestedAt: string }): SourceChannelDoc | null {
  if (!raw || !raw.channelId || !raw.name) return null;
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
    streamEntryUrl: channelEntryUrl(id),
    isPlayable: true, // liveness is request-time (resolve); optimistic at sync time
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    ingestedAt,
  };
}

// The `…/playable` sentinel is the channel ENTRY → resolveStream does the 1-hop POST resolve to a fresh master.
function isEntryUrl(url: string): boolean {
  return isStirrEntry(url);
}

// 1-hop POST resolve (POST /playable → data[0].media[0] → `[vx_nonce]` fill, in stirr/config.ts) keyed off the
// video id parsed from the entry sentinel. Pre-allow the resolved host so the proxy's SSRF gate passes the
// master's same-host child hops (the proxy also learns variant/segment hosts via onPlaylistChildHost).
async function resolveStream(entryUrl: string): Promise<{ masterUrl: string }> {
  const videoId = channelIdFromEntry(entryUrl);
  if (!videoId) throw new Error(`stirr: not a channel entry url: ${entryUrl}`);
  const masterUrl = await resolveStirrMaster(videoId);
  try {
    allow.allow(new URL(masterUrl).hostname);
  } catch {
    /* ignore malformed */
  }
  return { masterUrl };
}

// Build the stirr self-EPG from the per-channel TWO-TIER guide (provider epg_url → STIRR /api/epg), upsert the
// 'stirr' EpgSource, and self-link the still-untouched channels onto it. Live-only (the caller guards on `live`
// so a snapshot fallback never overwrites a good guide). FILL-ONLY-IF-UNTOUCHED — same posture as the family.
async function applyStirrSelfEpg(sourceId: string, raw: StirrRow[]): Promise<void> {
  const { offset, defaulted } = await resolveProgramOffset();
  if (defaulted) logger.warn('seed', `[${sourceId}] settings offset unset — guide times stored as UTC (+0000)`);
  const { channelDocs, programDocs } = await buildStirrEpg(raw, offset);
  const counts = await writeFastEpg(sourceId, channelDocs, programDocs);
  await upsertFastEpgSource(sourceId, counts, { name: STIRR_EPG_NAME, url: STIRR_EPG_URL });
  const linked = await linkFastSelfEpg(sourceId, counts.channelIds);
  logger.info(
    'seed',
    `[${sourceId}] self-EPG: ${counts.channels} channels / ${counts.programs} programs; linked ${linked} untouched channel(s)`,
  );
}

const stirrAdapter = makeFastSource({
  id: SOURCE_ID,
  label: 'STIRR',

  // STIRR's catalog carries a category per channel (mapped to a normalized bucket); group by it, alphabetical.
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. STIRR carries its OWN self-built guide (afterSync writes a 'stirr' EpgSource
  // from the per-channel two-tier guide, playlistBinding:true) → Playlist-bound EPG is true.
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

  // ── proxy / resolution overrides (sentinel entry + 1-hop POST resolve + dynamic CDN allow-set) ──
  allowedSuffixes: STIRR_SUFFIXES,
  upstreamHeaders: () => ({ ...STIRR_STREAM_HEADERS }), // UA only (aniview SSAI ignores Origin)
  isAllowedUpstream: (url: string) => allow.isAllowedUpstream(url),
  onPlaylistChildHost: (host: string) => allow.onPlaylistChildHost(host),
  isEntryUrl,
  resolveStream,

  // ── post-sync: gracenote crosswalk (wired; no-ops until the addon lands) THEN stirr self-EPG (live-only) ──
  async afterSync({ sourceId, live, raw }) {
    await applyEpgCrosswalk(sourceId, STIRR_EPG_ADDON_FILE).catch((err) =>
      logger.warn('seed', `[${sourceId}] EPG crosswalk failed (continuing): ${(err as Error).message}`),
    );
    if (live) {
      await applyStirrSelfEpg(sourceId, raw as StirrRow[]).catch((err) =>
        logger.warn('seed', `[${sourceId}] self-EPG (two-tier) failed (continuing): ${(err as Error).message}`),
      );
    }
  },
});

export default stirrAdapter;
