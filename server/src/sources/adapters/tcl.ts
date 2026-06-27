// tcl source adapter (TCL TV+ — TCL's free FAST service, the tcltv.plus web client, served from the ideonow.com
// gateway). The ELEVENTH FastChannels FAST source ported onto makeFastSource, and the THIRD of the family (after
// xumo + stirr) that is SENTINEL + RESOLVE rather than direct-HLS: the livetab→programlist catalog yields a
// per-channel `media` url + `source` tag, but the PLAYABLE master is minted on demand by the gateway's
// `format-stream-url` POST (a Roku-style per-play resolve). The stored entry is a `…/format-stream-url?bundle_id=
// …&source=…&media=…` ENTRY url (the dlhd/xumo/stirr posture — a real-looking URL whose query carries the resolve
// inputs); resolveStream does ONE resolve hop PER PLAY (POST format-stream-url → data.stream_url, falling back to
// the catalog `media`; all in tcl/config.ts) and learns the resolved CDN host into a per-source dynamic SSRF
// allow-set (the proxy then learns the variant/segment child hosts during playlist rewrite). EPG is the source's
// OWN heavy guide (afterSync → buildTclEpg → writeFastEpg): a re-walked category schedule enriched by a batched
// program-detail lookup. A gracenote crosswalk call is wired but no-ops until a tcl-playlist-addon.json is
// committed. Ported from FastChannels tcl.py (441 LOC).

import { readFileSync } from 'node:fs';
import { makeFastSource } from './_fast/template.js';
import { createDynamicAllow } from './_fast/dynamicAllow.js';
import {
  TCL_SUFFIXES,
  TCL_STREAM_HEADERS,
  channelEntryUrl,
  isTclEntry,
  parseTclEntry,
  resolveTclMaster,
  fetchTclRows,
  type TclRow,
} from './tcl/config.js';
import { TCL_EPG_ADDON_FILE, snapshotFile } from '../paths.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { logger } from '../core/logger.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
import { writeFastEpg, linkFastSelfEpg, upsertFastEpgSource } from '../../epg/fastSelfEpg.js';
import { buildTclEpg, TCL_EPG_NAME, TCL_EPG_URL } from '../../epg/tcl.js';
import type { RawListing } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SOURCE_ID = 'tcl';
const SNAPSHOT = snapshotFile(SOURCE_ID);

// A per-source SSRF allow-set seeded with the TCL/CDN suffixes; grown at runtime by resolveStream (the resolved
// master host) + the proxy's onPlaylistChildHost (the variant/segment hosts seen inside a resolved playlist).
// Matters here because the gateway mints the master on a TCL/ideonow CDN or an ad/CDN host a static suffix list
// can't fully enumerate (the resolved + child hops are learned at play time); private IPs are always blocked.
const allow = createDynamicAllow(TCL_SUFFIXES);

// LIVE: the trimmed catalog rows. OFFLINE: the committed snapshot (buildSource flips status to 'warn' on
// meta.live:false). Snapshot shape is { channels: TclRow[] } so rebuild-source-seed.ts round-trips it.
async function listChannels(): Promise<RawListing> {
  try {
    const raw = await fetchTclRows();
    return { raw, meta: { live: true, count: raw.length, endpoint: 'gateway-prod.ideonow.com', fetchedAt: new Date().toISOString() } };
  } catch (err) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: TclRow[] };
    return {
      raw: snap.channels || [],
      meta: { live: false, fallback: 'tcl.snapshot.json', reason: (err as Error).message },
    };
  }
}

// One catalog row → one SourceChannel. The stream entry is the `…/format-stream-url?…` ENTRY url (carrying the
// resolve inputs; resolved per play); served as an entry (→ B-Roll slate + telemetry + ffprobe). Grouped by the
// livetab category the channel first appeared under.
function normalize(raw: TclRow, { ingestedAt }: { ingestedAt: string }): SourceChannelDoc | null {
  if (!raw || !raw.channelId || !raw.name) return null;
  const id = String(raw.channelId);
  const group = String(raw.category || 'Entertainment');
  return {
    _id: `${SOURCE_ID}:${id}`,
    source: SOURCE_ID,
    sourceChannelId: id,
    name: String(raw.name),
    category: group,
    groupKey: group,
    groupLabel: group,
    logoUrl: raw.logo || null,
    streamEntryUrl: channelEntryUrl(raw),
    isPlayable: true, // liveness is request-time (resolve); optimistic at sync time
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    ingestedAt,
  };
}

// The `format-stream-url?…` sentinel is the channel ENTRY → resolveStream does the 1-hop POST resolve to a master.
function isEntryUrl(url: string): boolean {
  return isTclEntry(url);
}

// 1-hop POST resolve (POST format-stream-url → data.stream_url, falling back to the catalog `media`; in
// tcl/config.ts) keyed off the bundle id + source + media parsed from the entry sentinel. Pre-allow the resolved
// host so the proxy's SSRF gate passes the master's same-host child hops (the proxy also learns variant/segment
// hosts via onPlaylistChildHost during rewrite).
async function resolveStream(entryUrl: string): Promise<{ masterUrl: string }> {
  const parsed = parseTclEntry(entryUrl);
  if (!parsed) throw new Error(`tcl: not a channel entry url: ${entryUrl}`);
  const masterUrl = await resolveTclMaster(parsed.bundleId, parsed.source, parsed.media);
  try {
    allow.allow(new URL(masterUrl).hostname);
  } catch {
    /* ignore malformed */
  }
  return { masterUrl };
}

// Build the tcl self-EPG from the SEPARATE heavy schedule (re-walked category programs + batched detail lookup),
// upsert the 'tcl' EpgSource, and self-link the still-untouched channels onto it. Live-only (the caller guards on
// `live` so a snapshot fallback never overwrites a good guide). FILL-ONLY-IF-UNTOUCHED — same posture as the family.
async function applyTclSelfEpg(sourceId: string, raw: TclRow[]): Promise<void> {
  const { offset, defaulted } = await resolveProgramOffset();
  if (defaulted) logger.warn('seed', `[${sourceId}] settings offset unset — guide times stored as UTC (+0000)`);
  const { channelDocs, programDocs } = await buildTclEpg(raw, offset);
  const counts = await writeFastEpg(sourceId, channelDocs, programDocs);
  await upsertFastEpgSource(sourceId, counts, { name: TCL_EPG_NAME, url: TCL_EPG_URL });
  const linked = await linkFastSelfEpg(sourceId, counts.channelIds);
  logger.info(
    'seed',
    `[${sourceId}] self-EPG: ${counts.channels} channels / ${counts.programs} programs; linked ${linked} untouched channel(s)`,
  );
}

const tclAdapter = makeFastSource({
  id: SOURCE_ID,
  label: 'TCL TV+',

  // TCL's catalog carries a category per channel (the livetab bucket); group by it, alphabetical.
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. TCL carries its OWN self-built guide (afterSync writes a 'tcl' EpgSource from
  // the per-category schedule, playlistBinding:true) → Playlist-bound EPG is true.
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
  allowedSuffixes: TCL_SUFFIXES,
  upstreamHeaders: () => ({ ...TCL_STREAM_HEADERS }), // UA only (the resolved CDN ignores the gateway Origin)
  isAllowedUpstream: (url: string) => allow.isAllowedUpstream(url),
  onPlaylistChildHost: (host: string) => allow.onPlaylistChildHost(host),
  isEntryUrl,
  resolveStream,

  // ── post-sync: gracenote crosswalk (wired; no-ops until the addon lands) THEN tcl self-EPG (live-only) ──
  async afterSync({ sourceId, live, raw }) {
    await applyEpgCrosswalk(sourceId, TCL_EPG_ADDON_FILE).catch((err) =>
      logger.warn('seed', `[${sourceId}] EPG crosswalk failed (continuing): ${(err as Error).message}`),
    );
    if (live) {
      await applyTclSelfEpg(sourceId, raw as TclRow[]).catch((err) =>
        logger.warn('seed', `[${sourceId}] self-EPG (schedule) failed (continuing): ${(err as Error).message}`),
      );
    }
  },
});

export default tclAdapter;
