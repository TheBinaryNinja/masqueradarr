// xumo source adapter (Xumo Play — Comcast's FAST service, the play.xumo.com web client). The SIXTH FastChannels
// FAST source ported onto makeFastSource, and the FIRST of the family that is SENTINEL + RESOLVE rather than
// direct-HLS: the Valencia catalog yields only channel ids, so each channel's stream is minted on demand. The
// stored entry is a broadcast.json ENTRY url (the dlhd posture — a real-looking URL whose channel id is all that
// matters); resolveStream does a 3-hop resolve PER PLAY (broadcast → asset → HLS source → macro-fill, all in
// xumo/config.ts) and learns the resolved CDN host into a per-source dynamic SSRF allow-set (the proxy then
// learns the variant/segment child hosts during playlist rewrite). DRM channels (callsign …-DRM / DRM-CMS) and
// VOD-only shells are DROPPED at catalog time (the HLS-only proxy can't serve them). EPG is the source's OWN
// paginated market guide (afterSync → buildXumoEpg → writeFastEpg); a gracenote crosswalk call is wired but
// no-ops until a xumo-playlist-addon.json is committed. Ported from FastChannels xumo.py (602 LOC).

import { readFileSync } from 'node:fs';
import { makeFastSource } from './_fast/template.js';
import { createDynamicAllow } from './_fast/dynamicAllow.js';
import {
  XUMO_SUFFIXES,
  XUMO_STREAM_HEADERS,
  channelEntryUrl,
  isXumoEntry,
  channelIdFromEntry,
  resolveXumoMaster,
  fetchXumoRows,
  type XumoRow,
} from './xumo/config.js';
import { XUMO_EPG_ADDON_FILE, snapshotFile } from '../paths.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { logger } from '../core/logger.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
import { writeFastEpg, linkFastSelfEpg, upsertFastEpgSource } from '../../epg/fastSelfEpg.js';
import { buildXumoEpg, XUMO_EPG_NAME, XUMO_EPG_URL } from '../../epg/xumo.js';
import type { RawListing } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SOURCE_ID = 'xumo';
const SNAPSHOT = snapshotFile(SOURCE_ID);

// A per-source SSRF allow-set seeded with the Xumo CDN suffixes; grown at runtime by resolveStream (the resolved
// per-distribution cloudfront master host) + the proxy's onPlaylistChildHost (the SSAI variant/segment hosts seen
// inside a resolved playlist). Matters here because Xumo's masters are per-distribution cloudfront hosts and the
// ad-stitched child hops land on a long tail of FreeWheel/Publica hosts a static suffix list can't enumerate.
const allow = createDynamicAllow(XUMO_SUFFIXES);

// LIVE: the trimmed catalog rows. OFFLINE: the committed snapshot (buildSource flips status to 'warn' on
// meta.live:false). Snapshot shape is { channels: XumoRow[] } so rebuild-source-seed.ts round-trips it.
async function listChannels(): Promise<RawListing> {
  try {
    const raw = await fetchXumoRows();
    return { raw, meta: { live: true, count: raw.length, fetchedAt: new Date().toISOString() } };
  } catch (err) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: XumoRow[] };
    return {
      raw: snap.channels || [],
      meta: { live: false, fallback: 'xumo.snapshot.json', reason: (err as Error).message },
    };
  }
}

// One catalog row → one SourceChannel. The stream entry is the broadcast.json ENTRY url (resolved per play);
// served as an entry (→ B-Roll slate + telemetry + ffprobe). Grouped by Xumo's genre bucket.
function normalize(raw: XumoRow, { ingestedAt }: { ingestedAt: string }): SourceChannelDoc | null {
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

// The broadcast.json sentinel is the channel ENTRY → resolveStream does the 3-hop resolve to a fresh master.
function isEntryUrl(url: string): boolean {
  return isXumoEntry(url);
}

// 3-hop resolve (broadcast → asset → HLS source → macro-fill, in xumo/config.ts) keyed off the channel id parsed
// from the entry sentinel. Pre-allow the resolved host so the proxy's SSRF gate passes the master's same-host
// child hops (the proxy also learns variant/segment hosts via onPlaylistChildHost during rewrite).
async function resolveStream(entryUrl: string): Promise<{ masterUrl: string }> {
  const channelId = channelIdFromEntry(entryUrl);
  if (!channelId) throw new Error(`xumo: not a channel entry url: ${entryUrl}`);
  const masterUrl = await resolveXumoMaster(channelId);
  try {
    allow.allow(new URL(masterUrl).hostname);
  } catch {
    /* ignore malformed */
  }
  return { masterUrl };
}

// Build the xumo self-EPG from the SEPARATE paginated market guide (the asset metadata rides along in each page
// response, so no per-program asset fetch), upsert the 'xumo' EpgSource, and self-link the still-untouched
// channels onto it. Live-only (the caller guards on `live` so a snapshot fallback never overwrites a good guide).
// FILL-ONLY-IF-UNTOUCHED — same posture as dlhd/dami/samsung/vizio/lg/vidaa/whale.
async function applyXumoSelfEpg(sourceId: string, raw: XumoRow[]): Promise<void> {
  const { offset, defaulted } = await resolveProgramOffset();
  if (defaulted) logger.warn('seed', `[${sourceId}] settings offset unset — guide times stored as UTC (+0000)`);
  const { channelDocs, programDocs } = await buildXumoEpg(raw, offset);
  const counts = await writeFastEpg(sourceId, channelDocs, programDocs);
  await upsertFastEpgSource(sourceId, counts, { name: XUMO_EPG_NAME, url: XUMO_EPG_URL });
  const linked = await linkFastSelfEpg(sourceId, counts.channelIds);
  logger.info(
    'seed',
    `[${sourceId}] self-EPG: ${counts.channels} channels / ${counts.programs} programs; linked ${linked} untouched channel(s)`,
  );
}

const xumoAdapter = makeFastSource({
  id: SOURCE_ID,
  label: 'Xumo Play',

  // Xumo's catalog carries a genre per channel (mostly clean linear buckets); bucket by it, alphabetical.
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. Xumo carries its OWN self-built guide (afterSync writes a 'xumo' EpgSource
  // from the paginated market EPG, playlistBinding:true) → Playlist-bound EPG is true.
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

  // ── proxy / resolution overrides (sentinel entry + 3-hop resolve + dynamic CDN allow-set) ──
  allowedSuffixes: XUMO_SUFFIXES,
  upstreamHeaders: () => ({ ...XUMO_STREAM_HEADERS }),
  isAllowedUpstream: (url: string) => allow.isAllowedUpstream(url),
  onPlaylistChildHost: (host: string) => allow.onPlaylistChildHost(host),
  isEntryUrl,
  resolveStream,

  // ── post-sync: gracenote crosswalk (wired; no-ops until the addon lands) THEN xumo self-EPG (live-only) ──
  async afterSync({ sourceId, live, raw }) {
    await applyEpgCrosswalk(sourceId, XUMO_EPG_ADDON_FILE).catch((err) =>
      logger.warn('seed', `[${sourceId}] EPG crosswalk failed (continuing): ${(err as Error).message}`),
    );
    if (live) {
      await applyXumoSelfEpg(sourceId, raw as XumoRow[]).catch((err) =>
        logger.warn('seed', `[${sourceId}] self-EPG (market) failed (continuing): ${(err as Error).message}`),
      );
    }
  },
});

export default xumoAdapter;
