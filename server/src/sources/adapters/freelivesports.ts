// freelivesports source adapter (FreeLiveSports — the Unreel/PowR sports FAST pack). The SEVENTH FastChannels
// FAST source ported onto makeFastSource, and the first TIER-B (macro-expansion) port. Like LG it is direct-HLS
// (each channel's `url` IS the real HLS master, pathname ends .m3u8) but the master carries Unreel VAST ad macros
// ([DEVICE_ID]/[CB]/[REF]/[UA]/[GDPR]/…) that need PER-PLAY freshness — so resolveStream fills them at play time
// (the FastChannels freelivesports.py `resolve()` posture) rather than baking a subset in at normalize. The
// catalog AND the guide come from ONE catalog call (epg.entries inline, the LG/Tubi shape): listChannels trims
// the rows (programs ride along), normalize emits the playlist channel, and afterSync builds the self-EPG from
// the SAME rows (no extra fetch). A gracenote crosswalk call is wired but no-ops until a
// freelivesports-playlist-addon.json is committed (a follow-up, like lg/whale).

import { readFileSync } from 'node:fs';
import { makeFastSource } from './_fast/template.js';
import { createDynamicAllow } from './_fast/dynamicAllow.js';
import {
  FLS_SUFFIXES,
  FLS_HEADERS,
  FLS_GROUP,
  CATALOG_URL,
  fillStreamMacros,
  fetchFlsRows,
  type FlsRow,
} from './freelivesports/config.js';
import { FREELIVESPORTS_EPG_ADDON_FILE, snapshotFile } from '../paths.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { logger } from '../core/logger.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
import { writeFastEpg, linkFastSelfEpg, upsertFastEpgSource } from '../../epg/fastSelfEpg.js';
import { buildFreeLiveSportsEpg, FLS_EPG_NAME, FLS_EPG_URL } from '../../epg/freelivesports.js';
import type { RawListing } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SOURCE_ID = 'freelivesports';
const SNAPSHOT = snapshotFile(SOURCE_ID);

// A per-source SSRF allow-set seeded with the FreeLiveSports CDN suffixes. Because freelivesports is a direct
// source (the stored master needs only macro fill, no redirect), resolveStream pre-allows the filled master host
// at play time, and the proxy's onPlaylistChildHost learns the variant/segment child hosts seen inside the
// resolved master — so a new CDN that appears in the catalog is covered without a code change (private IPs always
// blocked). This matters here: FreeLiveSports fronts many per-brand Ottera/Amagi/MediaTailor hosts.
const allow = createDynamicAllow(FLS_SUFFIXES);

// LIVE: the trimmed catalog rows (programs[] inline). OFFLINE: the committed snapshot (buildSource flips status to
// 'warn' on meta.live:false). Snapshot shape is { channels: <FlsRow[]> } so rebuild-source-seed.ts round-trips it.
async function listChannels(): Promise<RawListing> {
  try {
    const raw = await fetchFlsRows();
    return { raw, meta: { live: true, count: raw.length, endpoint: CATALOG_URL, fetchedAt: new Date().toISOString() } };
  } catch (err) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: FlsRow[] };
    return {
      raw: snap.channels || [],
      meta: { live: false, fallback: 'freelivesports.snapshot.json', reason: (err as Error).message },
    };
  }
}

// One catalog row → one SourceChannel. The stream entry is the RAW (macro-laden) master, served as an .m3u8 entry
// (→ B-Roll slate + telemetry + ffprobe); resolveStream fills the macros per play. Single "Sports" group (the
// upstream categories are opaque ids; FreeLiveSports is sports-only — the FastChannels hardcode).
function normalize(raw: FlsRow, { ingestedAt }: { ingestedAt: string }): SourceChannelDoc | null {
  if (!raw || !raw.channelId || !raw.name || !raw.streamUrl) return null;
  const id = String(raw.channelId);
  return {
    _id: `${SOURCE_ID}:${id}`,
    source: SOURCE_ID,
    sourceChannelId: id,
    name: String(raw.name),
    category: FLS_GROUP,
    groupKey: FLS_GROUP,
    groupLabel: FLS_GROUP,
    logoUrl: raw.logo || null,
    streamEntryUrl: raw.streamUrl,
    isPlayable: true, // liveness is request-time (resolve); optimistic at sync time
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    ingestedAt,
  };
}

// Fill the per-play VAST ad macros baked into the stored master (the FastChannels freelivesports.py resolve()
// posture) and pre-allow the resolved host so the proxy's SSRF gate passes at play time regardless of process
// restart (the catalog is adapter-curated, the same trust level as the static suffix seed). The proxy then learns
// the master's variant/segment child hosts via onPlaylistChildHost. isEntryUrl stays the default .m3u8 test
// (FreeLiveSports masters end .m3u8 even with the macro query string).
async function resolveStream(entryUrl: string): Promise<{ masterUrl: string }> {
  const masterUrl = fillStreamMacros(entryUrl);
  try {
    allow.allow(new URL(masterUrl).hostname);
  } catch {
    /* ignore malformed */
  }
  return { masterUrl };
}

// Build the freelivesports self-EPG from the inline epg.entries (the same `raw` catalog rows buildSource
// consumed), upsert the 'freelivesports' EpgSource, and self-link the still-untouched channels onto it. Live-only
// (the caller guards on `live` so a snapshot fallback never overwrites a good guide). FILL-ONLY-IF-UNTOUCHED —
// same posture as dlhd/dami/samsung/vizio/lg/vidaa/whale.
async function applyFlsSelfEpg(sourceId: string, raw: FlsRow[]): Promise<void> {
  const { offset, defaulted } = await resolveProgramOffset();
  if (defaulted) logger.warn('seed', `[${sourceId}] settings offset unset — guide times stored as UTC (+0000)`);
  const { channelDocs, programDocs } = buildFreeLiveSportsEpg(raw, offset);
  const counts = await writeFastEpg(sourceId, channelDocs, programDocs);
  await upsertFastEpgSource(sourceId, counts, { name: FLS_EPG_NAME, url: FLS_EPG_URL });
  const linked = await linkFastSelfEpg(sourceId, counts.channelIds);
  logger.info(
    'seed',
    `[${sourceId}] self-EPG: ${counts.channels} channels / ${counts.programs} programs; linked ${linked} untouched channel(s)`,
  );
}

const freeLiveSportsAdapter = makeFastSource({
  id: SOURCE_ID,
  label: 'FreeLiveSports',

  // Sports-only: one "Sports" group (the upstream categories are opaque ids with no label map).
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. FreeLiveSports carries its OWN self-built guide (afterSync writes a
  // 'freelivesports' EpgSource from the inline programs, playlistBinding:true) → Playlist-bound EPG is true.
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
  allowedSuffixes: FLS_SUFFIXES,
  upstreamHeaders: () => ({ ...FLS_HEADERS }),
  isAllowedUpstream: (url: string) => allow.isAllowedUpstream(url),
  onPlaylistChildHost: (host: string) => allow.onPlaylistChildHost(host),
  resolveStream, // macro-fill + pre-allow the resolved host (isEntryUrl stays the default .m3u8 test)

  // ── post-sync: gracenote crosswalk (wired; no-ops until the addon lands) THEN fls self-EPG (live-only) ──
  async afterSync({ sourceId, live, raw }) {
    await applyEpgCrosswalk(sourceId, FREELIVESPORTS_EPG_ADDON_FILE).catch((err) =>
      logger.warn('seed', `[${sourceId}] EPG crosswalk failed (continuing): ${(err as Error).message}`),
    );
    if (live) {
      await applyFlsSelfEpg(sourceId, raw as FlsRow[]).catch((err) =>
        logger.warn('seed', `[${sourceId}] self-EPG (inline) failed (continuing): ${(err as Error).message}`),
      );
    }
  },
});

export default freeLiveSportsAdapter;
