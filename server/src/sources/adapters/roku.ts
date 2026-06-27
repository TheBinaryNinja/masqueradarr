// roku source adapter (The Roku Channel — Roku's free FAST service, the therokuchannel.roku.com web client). The
// THIRTEENTH FastChannels FAST source ported onto makeFastSource, and the FIFTH of the family (after xumo + stirr
// + tcl + pluto) that is SENTINEL + RESOLVE rather than direct-HLS: the `/api/v2/epg` catalog yields only channel
// ids/metadata, and the playable master is minted on demand by Roku's OSM CDN (a per-play JWT-signed HLS master).
// The TWIST vs the rest of the resolve family is a stateful, CLOUDFLARE-SENSITIVE anonymous SESSION (the family's
// first cookie-bearing session): a 3-step keyless bootstrap (GET / → cookies; GET /api/v1/csrf → token) gates the
// catalog/EPG/resolve hops, and a 403 from the CloudFront edge trips a 5-minute cooldown (back off, keep the prior
// catalog/guide + serve the B-Roll slate — the plan's resilience mandate, never hammer). So normalize() stores a
// `roku://<id>` ENTRY sentinel (the dulo/pluto custom-scheme posture — the master needs a freshly-minted playback
// JWT) and resolveStream() boots the session (cached), resolves a fresh playId via the content proxy, and POSTs
// `/api/v3/playback` PER PLAY (all in roku/config.ts), learning the resolved OSM host into a per-source dynamic
// SSRF allow-set (the proxy then learns the variant/segment child hosts during playlist rewrite). EPG is the
// source's OWN per-channel guide (afterSync → buildRokuEpg → writeFastEpg): a bounded content-proxy fanout reading
// each station's linearSchedule. A gracenote crosswalk call is wired but no-ops until a roku-playlist-addon.json is
// committed. Ported from FastChannels roku.py (1541 LOC; the in-process session/cache port is far leaner — see
// roku/config.ts header).

import { readFileSync } from 'node:fs';
import { makeFastSource } from './_fast/template.js';
import { createDynamicAllow } from './_fast/dynamicAllow.js';
import {
  ROKU_SUFFIXES,
  ROKU_STREAM_HEADERS,
  channelEntryUrl,
  isRokuEntry,
  parseRokuEntry,
  resolveRokuMaster,
  fetchRokuRows,
  type RokuRow,
} from './roku/config.js';
import { ROKU_EPG_ADDON_FILE, snapshotFile } from '../paths.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { logger } from '../core/logger.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
import { writeFastEpg, linkFastSelfEpg, upsertFastEpgSource } from '../../epg/fastSelfEpg.js';
import { buildRokuEpg, ROKU_EPG_NAME, ROKU_EPG_URL } from '../../epg/roku.js';
import type { RawListing } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SOURCE_ID = 'roku';
const SNAPSHOT = snapshotFile(SOURCE_ID);

// A per-source SSRF allow-set seeded with the Roku/CDN suffixes; grown at runtime by resolveStream (the resolved
// OSM master host) + the proxy's onPlaylistChildHost (the variant/segment hosts seen inside a resolved playlist).
// Matters here because the playback API mints the master on `osm.sr.roku.com` and the ad-stitched variant/segment
// hops land on a long tail of Akamai/CloudFront/Fastly CDN hosts a static suffix list can't fully enumerate (the
// resolved + child hops are learned at play time); private IPs are always blocked.
const allow = createDynamicAllow(ROKU_SUFFIXES);

// LIVE: the trimmed catalog rows. OFFLINE: the committed snapshot (buildSource flips status to 'warn' on
// meta.live:false). Snapshot shape is { channels: RokuRow[] } so rebuild-source-seed.ts round-trips it. A 403
// cooldown (CloudFront) also lands here → snapshot fallback, so a rate-limited boot doesn't wipe the catalog.
async function listChannels(): Promise<RawListing> {
  try {
    const raw = await fetchRokuRows();
    return { raw, meta: { live: true, count: raw.length, endpoint: 'therokuchannel.roku.com', fetchedAt: new Date().toISOString() } };
  } catch (err) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: RokuRow[] };
    return {
      raw: snap.channels || [],
      meta: { live: false, fallback: 'roku.snapshot.json', reason: (err as Error).message },
    };
  }
}

// One catalog row → one SourceChannel. The stream entry is the `roku://<id>` ENTRY sentinel (resolved per play);
// served as an entry (→ B-Roll slate + telemetry + ffprobe). Grouped by the station's derived category.
function normalize(raw: RokuRow, { ingestedAt }: { ingestedAt: string }): SourceChannelDoc | null {
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

// The `roku://<id>` sentinel is the channel ENTRY → resolveStream boots the session + resolves a master per play.
function isEntryUrl(url: string): boolean {
  return isRokuEntry(url);
}

// Boot + content→playback resolve (per play; all in roku/config.ts) keyed off the station id parsed from the entry
// sentinel. Pre-allow the resolved host so the proxy's SSRF gate passes the master's same-host child hops (the
// proxy also learns variant/segment hosts via onPlaylistChildHost during rewrite).
async function resolveStream(entryUrl: string): Promise<{ masterUrl: string }> {
  const parsed = parseRokuEntry(entryUrl);
  if (!parsed) throw new Error(`roku: not a channel entry url: ${entryUrl}`);
  const masterUrl = await resolveRokuMaster(parsed.channelId);
  try {
    allow.allow(new URL(masterUrl).hostname);
  } catch {
    /* ignore malformed */
  }
  return { masterUrl };
}

// Build the roku self-EPG from the per-channel linearSchedule fanout, upsert the 'roku' EpgSource, and self-link
// the still-untouched channels onto it. Live-only (the caller guards on `live` so a snapshot fallback never
// overwrites a good guide). FILL-ONLY-IF-UNTOUCHED — same posture as the family.
async function applyRokuSelfEpg(sourceId: string, raw: RokuRow[]): Promise<void> {
  const { offset, defaulted } = await resolveProgramOffset();
  if (defaulted) logger.warn('seed', `[${sourceId}] settings offset unset — guide times stored as UTC (+0000)`);
  const { channelDocs, programDocs } = await buildRokuEpg(raw, offset);
  const counts = await writeFastEpg(sourceId, channelDocs, programDocs);
  await upsertFastEpgSource(sourceId, counts, { name: ROKU_EPG_NAME, url: ROKU_EPG_URL });
  const linked = await linkFastSelfEpg(sourceId, counts.channelIds);
  logger.info(
    'seed',
    `[${sourceId}] self-EPG: ${counts.channels} channels / ${counts.programs} programs; linked ${linked} untouched channel(s)`,
  );
}

const rokuAdapter = makeFastSource({
  id: SOURCE_ID,
  label: 'The Roku Channel',

  // Roku's stations carry a derived category; group by it, alphabetical.
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. Roku carries its OWN self-built guide (afterSync writes a 'roku' EpgSource
  // from the per-channel linearSchedule, playlistBinding:true) → Playlist-bound EPG is true.
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

  // ── proxy / resolution overrides (sentinel entry + boot-and-resolve + dynamic CDN allow-set) ──
  allowedSuffixes: ROKU_SUFFIXES,
  upstreamHeaders: () => ({ ...ROKU_STREAM_HEADERS }), // UA only (the OSM CDN ignores the csrf/Origin envelope)
  isAllowedUpstream: (url: string) => allow.isAllowedUpstream(url),
  onPlaylistChildHost: (host: string) => allow.onPlaylistChildHost(host),
  isEntryUrl,
  resolveStream,

  // ── post-sync: gracenote crosswalk (wired; no-ops until the addon lands) THEN roku self-EPG (live-only) ──
  async afterSync({ sourceId, live, raw }) {
    await applyEpgCrosswalk(sourceId, ROKU_EPG_ADDON_FILE).catch((err) =>
      logger.warn('seed', `[${sourceId}] EPG crosswalk failed (continuing): ${(err as Error).message}`),
    );
    if (live) {
      await applyRokuSelfEpg(sourceId, raw as RokuRow[]).catch((err) =>
        logger.warn('seed', `[${sourceId}] self-EPG (linearSchedule) failed (continuing): ${(err as Error).message}`),
      );
    }
  },
});

export default rokuAdapter;
