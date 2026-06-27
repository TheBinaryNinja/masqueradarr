// vizio source adapter (Vizio WatchFree+). The second FastChannels FAST source ported onto makeFastSource, and
// the first TRUE direct-HLS one: the WatchFree+ guide host (watchfreeplus-epg-prod.smartcasttv.com) serves a
// public, anonymous catalog where each channel's `channelUrls[0]` IS the real HLS master — so resolveStream is
// identity (no jmp2.uk-style redirect hop like Samsung). The one wrinkle is ad-DI MACRO placeholders ({ADID},
// {USPRIVACY}, …) baked into the master query string; normalize substitutes the privacy-neutral subset (config's
// expandMacros) and stores the result as the stream entry. Token-gated (NFL) and DRM channels are DROPPED at
// normalize (HLS-only proxy). EPG is a SEPARATE /api/airings schedule grid (afterSync → buildVizioEpg →
// writeFastEpg); a gracenote crosswalk call is wired but no-ops until a vizio-playlist-addon.json is committed
// (a follow-up, derivable from the catalog's inline tmsStationId once US Gracenote lineups are present).

import { readFileSync } from 'node:fs';
import { makeFastSource } from './_fast/template.js';
import { createDynamicAllow } from './_fast/dynamicAllow.js';
import { UA, VIZIO_SUFFIXES, expandMacros, fetchVizioCatalog, type VizioRow } from './vizio/config.js';
import { VIZIO_EPG_ADDON_FILE, snapshotFile } from '../paths.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { logger } from '../core/logger.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
import { writeFastEpg, linkFastSelfEpg, upsertFastEpgSource } from '../../epg/fastSelfEpg.js';
import { buildVizioEpg, VIZIO_EPG_NAME, VIZIO_EPG_URL } from '../../epg/vizio.js';
import type { RawListing } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SOURCE_ID = 'vizio';
const SNAPSHOT = snapshotFile(SOURCE_ID);

// A per-source SSRF allow-set seeded with the Vizio CDN suffixes. Because vizio is a direct source (no redirect),
// resolveStream pre-allows each stored master host at play time, and the proxy's onPlaylistChildHost learns the
// variant/segment child hosts seen inside the resolved master — so a new CDN that appears in the catalog is
// covered without a code change (private IPs always blocked).
const allow = createDynamicAllow(VIZIO_SUFFIXES);

// LIVE: the trimmed catalog rows. OFFLINE: the committed snapshot (buildSource flips status to 'warn' on
// meta.live:false). Snapshot shape is { channels: <VizioRow[]> } so rebuild-source-seed.ts round-trips it.
async function listChannels(): Promise<RawListing> {
  try {
    const raw = await fetchVizioCatalog();
    return { raw, meta: { live: true, count: raw.length, endpoint: 'watchfreeplus-epg-prod.smartcasttv.com', fetchedAt: new Date().toISOString() } };
  } catch (err) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: VizioRow[] };
    return {
      raw: snap.channels || [],
      meta: { live: false, fallback: 'vizio.snapshot.json', reason: (err as Error).message },
    };
  }
}

// One catalog row → one SourceChannel. Token-gated + DRM channels are DROPPED (HLS-only proxy); a row whose
// macro-expanded master isn't http(s) is also dropped. The stream entry is the macro-expanded master (served as
// an .m3u8 entry → B-Roll slate + telemetry + ffprobe). Grouped by Vizio's catalog category.
function normalize(raw: VizioRow, { ingestedAt }: { ingestedAt: string }): SourceChannelDoc | null {
  if (!raw || !raw.channelId || !raw.name) return null;
  if (raw.tokenUrl || raw.licenseUrl) return null; // token-gated (NFL) / DRM — out of scope
  if (!raw.streamUrl) return null;
  const master = expandMacros(raw.streamUrl);
  if (!/^https?:\/\//i.test(master)) return null; // non-HTTP master after expansion — drop
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
    streamEntryUrl: master,
    isPlayable: true, // liveness is request-time; optimistic at sync time
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    ingestedAt,
  };
}

// Direct source: the stored master needs no resolution, but pre-allow its host so the proxy's SSRF gate passes
// at play time regardless of process restart (the catalog is adapter-curated, the same trust level as the static
// suffix seed). The proxy then learns the master's variant/segment child hosts via onPlaylistChildHost.
async function resolveStream(entryUrl: string): Promise<{ masterUrl: string }> {
  try {
    allow.allow(new URL(entryUrl).hostname);
  } catch {
    /* ignore malformed */
  }
  return { masterUrl: entryUrl };
}

// Build the vizio self-EPG from the airings schedule grid (the same `raw` catalog rows buildSource consumed),
// upsert the 'vizio' EpgSource, and self-link the still-untouched channels onto it. Live-only (the caller guards
// on `live` so a snapshot fallback never overwrites a good guide). FILL-ONLY-IF-UNTOUCHED — same posture as
// dlhd/dami/samsung.
async function applyVizioSelfEpg(sourceId: string, raw: VizioRow[]): Promise<void> {
  const { offset, defaulted } = await resolveProgramOffset();
  if (defaulted) logger.warn('seed', `[${sourceId}] settings offset unset — guide times stored as UTC (+0000)`);
  const { channelDocs, programDocs } = await buildVizioEpg(raw, offset);
  const counts = await writeFastEpg(sourceId, channelDocs, programDocs);
  await upsertFastEpgSource(sourceId, counts, { name: VIZIO_EPG_NAME, url: VIZIO_EPG_URL });
  const linked = await linkFastSelfEpg(sourceId, counts.channelIds);
  logger.info(
    'seed',
    `[${sourceId}] self-EPG: ${counts.channels} channels / ${counts.programs} programs; linked ${linked} untouched channel(s)`,
  );
}

const vizioAdapter = makeFastSource({
  id: SOURCE_ID,
  label: 'Vizio WatchFree+',

  // Vizio's catalog carries a semantic `category` per channel; bucket by it, alphabetical.
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. Vizio carries its OWN self-built guide (afterSync writes a 'vizio'
  // EpgSource from the airings grid, playlistBinding:true) → Playlist-bound EPG is true.
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
  allowedSuffixes: VIZIO_SUFFIXES,
  upstreamHeaders: () => ({ 'User-Agent': UA }),
  isAllowedUpstream: (url: string) => allow.isAllowedUpstream(url),
  onPlaylistChildHost: (host: string) => allow.onPlaylistChildHost(host),
  resolveStream, // identity + pre-allow the entry host (isEntryUrl stays the default .m3u8 test)

  // ── post-sync: gracenote crosswalk (wired; no-ops until the addon lands) THEN vizio self-EPG (live-only) ──
  async afterSync({ sourceId, live, raw }) {
    await applyEpgCrosswalk(sourceId, VIZIO_EPG_ADDON_FILE).catch((err) =>
      logger.warn('seed', `[${sourceId}] EPG crosswalk failed (continuing): ${(err as Error).message}`),
    );
    if (live) {
      await applyVizioSelfEpg(sourceId, raw as VizioRow[]).catch((err) =>
        logger.warn('seed', `[${sourceId}] self-EPG (airings) failed (continuing): ${(err as Error).message}`),
      );
    }
  },
});

export default vizioAdapter;
