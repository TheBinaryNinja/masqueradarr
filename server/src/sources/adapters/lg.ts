// lg source adapter (LG Channels). The third FastChannels FAST source ported onto makeFastSource, and the first
// MACRO-EXPANSION one: like Vizio it's direct-HLS (each channel's `mediaStaticUrl` IS the real HLS master), but
// the master carries LG-style VAST ad macros ([DEVICE_ID]/[UA]/[NONCE]/…) that need PER-PLAY freshness — so
// resolveStream expands them at play time (the FastChannels lg_channels.py `resolve()` posture) rather than
// baking a static subset in at normalize like Vizio. The catalog AND the guide come from ONE schedulelist call
// (programs[] inline, the Tubi shape): listChannels trims the rows (programs ride along), normalize emits the
// playlist channel, and afterSync builds the self-EPG from the SAME rows (no extra fetch). EPG is the source's
// OWN inline-program self-EPG (afterSync → buildLgEpg → writeFastEpg); a gracenote crosswalk call is wired but
// no-ops until an lg-playlist-addon.json is committed (a follow-up, like samsung/vizio).

import { readFileSync } from 'node:fs';
import { makeFastSource } from './_fast/template.js';
import { createDynamicAllow } from './_fast/dynamicAllow.js';
import {
  LG_SUFFIXES,
  LG_HEADERS,
  SCHEDULELIST_URL,
  expandStreamMacros,
  fetchLgRows,
  type LgRow,
} from './lg/config.js';
import { LG_EPG_ADDON_FILE, snapshotFile } from '../paths.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { logger } from '../core/logger.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
import { writeFastEpg, linkFastSelfEpg, upsertFastEpgSource } from '../../epg/fastSelfEpg.js';
import { buildLgEpg, LG_EPG_NAME, LG_EPG_URL } from '../../epg/lg.js';
import type { RawListing } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SOURCE_ID = 'lg';
const SNAPSHOT = snapshotFile(SOURCE_ID);

// A per-source SSRF allow-set seeded with the LG CDN suffixes. Because lg is a direct source (the stored master
// needs only macro expansion, no redirect), resolveStream pre-allows the expanded master host at play time, and
// the proxy's onPlaylistChildHost learns the variant/segment child hosts seen inside the resolved master — so a
// new CDN that appears in the catalog is covered without a code change (private IPs always blocked).
const allow = createDynamicAllow(LG_SUFFIXES);

// LIVE: the trimmed catalog rows (programs[] inline). OFFLINE: the committed snapshot (buildSource flips status to
// 'warn' on meta.live:false). Snapshot shape is { channels: <LgRow[]> } so rebuild-source-seed.ts round-trips it.
async function listChannels(): Promise<RawListing> {
  try {
    const raw = await fetchLgRows();
    return { raw, meta: { live: true, count: raw.length, endpoint: SCHEDULELIST_URL, fetchedAt: new Date().toISOString() } };
  } catch (err) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: LgRow[] };
    return {
      raw: snap.channels || [],
      meta: { live: false, fallback: 'lg.snapshot.json', reason: (err as Error).message },
    };
  }
}

// One catalog row → one SourceChannel. The stream entry is the RAW (macro-laden) master, served as an .m3u8 entry
// (→ B-Roll slate + telemetry + ffprobe); resolveStream expands the macros per play. Grouped by LG's category.
function normalize(raw: LgRow, { ingestedAt }: { ingestedAt: string }): SourceChannelDoc | null {
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

// Expand the per-play ad macros baked into the stored master (the FastChannels resolve() posture) and pre-allow
// the resolved host so the proxy's SSRF gate passes at play time regardless of process restart (the catalog is
// adapter-curated, the same trust level as the static suffix seed). The proxy then learns the master's
// variant/segment child hosts via onPlaylistChildHost. isEntryUrl stays the default .m3u8 test (LG masters end
// .m3u8 even with the macro query string).
async function resolveStream(entryUrl: string): Promise<{ masterUrl: string }> {
  const masterUrl = expandStreamMacros(entryUrl);
  try {
    allow.allow(new URL(masterUrl).hostname);
  } catch {
    /* ignore malformed */
  }
  return { masterUrl };
}

// Build the lg self-EPG from the inline programs (the same `raw` catalog rows buildSource consumed), upsert the
// 'lg' EpgSource, and self-link the still-untouched channels onto it. Live-only (the caller guards on `live` so a
// snapshot fallback never overwrites a good guide). FILL-ONLY-IF-UNTOUCHED — same posture as dlhd/dami/samsung/vizio.
async function applyLgSelfEpg(sourceId: string, raw: LgRow[]): Promise<void> {
  const { offset, defaulted } = await resolveProgramOffset();
  if (defaulted) logger.warn('seed', `[${sourceId}] settings offset unset — guide times stored as UTC (+0000)`);
  const { channelDocs, programDocs } = buildLgEpg(raw, offset);
  const counts = await writeFastEpg(sourceId, channelDocs, programDocs);
  await upsertFastEpgSource(sourceId, counts, { name: LG_EPG_NAME, url: LG_EPG_URL });
  const linked = await linkFastSelfEpg(sourceId, counts.channelIds);
  logger.info(
    'seed',
    `[${sourceId}] self-EPG: ${counts.channels} channels / ${counts.programs} programs; linked ${linked} untouched channel(s)`,
  );
}

const lgAdapter = makeFastSource({
  id: SOURCE_ID,
  label: 'LG Channels',

  // LG's schedulelist carries a semantic category per channel (News, Drama, Sports, …); bucket by it, alphabetical.
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. LG carries its OWN self-built guide (afterSync writes an 'lg' EpgSource from
  // the inline programs, playlistBinding:true) → Playlist-bound EPG is true.
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
  allowedSuffixes: LG_SUFFIXES,
  upstreamHeaders: () => ({ ...LG_HEADERS }),
  isAllowedUpstream: (url: string) => allow.isAllowedUpstream(url),
  onPlaylistChildHost: (host: string) => allow.onPlaylistChildHost(host),
  resolveStream, // macro-expand + pre-allow the resolved host (isEntryUrl stays the default .m3u8 test)

  // ── post-sync: gracenote crosswalk (wired; no-ops until the addon lands) THEN lg self-EPG (live-only) ──
  async afterSync({ sourceId, live, raw }) {
    await applyEpgCrosswalk(sourceId, LG_EPG_ADDON_FILE).catch((err) =>
      logger.warn('seed', `[${sourceId}] EPG crosswalk failed (continuing): ${(err as Error).message}`),
    );
    if (live) {
      await applyLgSelfEpg(sourceId, raw as LgRow[]).catch((err) =>
        logger.warn('seed', `[${sourceId}] self-EPG (inline) failed (continuing): ${(err as Error).message}`),
      );
    }
  },
});

export default lgAdapter;
