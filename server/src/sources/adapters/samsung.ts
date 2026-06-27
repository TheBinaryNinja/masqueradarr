// samsung source adapter (Samsung TV Plus). The first FastChannels FAST source ported onto the makeFastSource
// factory. Catalog + per-region XMLTV guide come from Matt Huisman's public mirror (i.mjh.nz) — no auth. The
// one wrinkle: a channel's stream is a jmp2.uk SHORT LINK that 302-redirects to the real (token-bearing,
// rotating) CDN master, so this is NOT a pure identity-resolve direct source — resolveStream follows the
// redirect per play and learns the resolved host into a per-source dynamic SSRF allow-set (the proxy then learns
// the variant/segment child hosts during playlist rewrite). DRM channels (those carrying a license_url) are
// DROPPED at normalize (the HLS-only proxy can't serve them). EPG is the source's OWN per-region XMLTV self-EPG
// (afterSync → fetchSamsungEpg → writeFastEpg); a gracenote crosswalk call is wired but no-ops until a
// samsung-playlist-addon.json is committed (a follow-up, once US Gracenote lineups are present).

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { makeFastSource } from './_fast/template.js';
import { createDynamicAllow } from './_fast/dynamicAllow.js';
import { CHANNELS_URL, STREAM_URL, UA, SAMSUNG_SUFFIXES, samsungRegions } from './samsung/config.js';
import { SAMSUNG_EPG_ADDON_FILE, snapshotFile } from '../paths.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { logger } from '../core/logger.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
import { writeFastEpg, linkFastSelfEpg, upsertFastEpgSource } from '../../epg/fastSelfEpg.js';
import { fetchSamsungEpg, SAMSUNG_EPG_NAME, SAMSUNG_EPG_URL } from '../../epg/samsung.js';
import type { RawListing } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SOURCE_ID = 'samsung';
const SNAPSHOT = snapshotFile(SOURCE_ID);

// A per-source SSRF allow-set seeded with the Samsung CDN suffixes; grown at runtime by resolveStream (the
// resolved master host) + the proxy's onPlaylistChildHost (variant/segment hosts seen in a resolved playlist).
const allow = createDynamicAllow(SAMSUNG_SUFFIXES);

// Fetch + gunzip the gzip JSON catalog (magic-byte 1f 8b sniff; the mirror serves it gzipped).
async function fetchGzJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const body = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
  return JSON.parse(body.toString('utf8'));
}

// LIVE: flatten the requested regions' channels into raw rows (dedupe ids across regions). OFFLINE: the committed
// snapshot (buildSource flips status to 'warn' on meta.live:false). Snapshot shape is { channels: <flat rows> }
// so rebuild-source-seed.ts round-trips it.
async function listChannels(): Promise<RawListing> {
  const regions = samsungRegions();
  try {
    const data = await fetchGzJson(CHANNELS_URL);
    const raw: any[] = [];
    const seen = new Set<string>();
    for (const region of regions) {
      const channels = data?.regions?.[region]?.channels as Record<string, any> | undefined;
      if (!channels) continue;
      for (const [id, ch] of Object.entries(channels)) {
        if (seen.has(id)) continue;
        seen.add(id);
        // Keep only the catalog fields normalize needs (+ chno for the future channel-number follow-up). The
        // mirror's inline `programs[]` and `description` are DROPPED here: the guide is the richer separate
        // per-region XMLTV (epg/samsung.ts), so carrying them would only bloat the committed snapshot.
        raw.push({
          id,
          region,
          name: ch.name,
          chno: ch.chno ?? null,
          logo: ch.logo ?? null,
          group: ch.group ?? null,
          license_url: ch.license_url ?? null,
        });
      }
    }
    if (!raw.length) throw new Error(`catalog had no channels for region(s): ${regions.join(',')}`);
    return { raw, meta: { live: true, regions, endpoint: CHANNELS_URL, fetchedAt: new Date().toISOString() } };
  } catch (err) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: any[] };
    return {
      raw: snap.channels || [],
      meta: { live: false, fallback: 'samsung.snapshot.json', reason: (err as Error).message },
    };
  }
}

// One catalog row → one SourceChannel. DRM-only channels (license_url present) are DROPPED — the HLS proxy can't
// serve them. The stream entry is the jmp2.uk short link (resolved per play). Samsung's `chno` is dropped (no
// SourceChannelDoc slot — a follow-up); grouped by Samsung's semantic category.
function normalize(raw: any, { ingestedAt }: { ingestedAt: string }): SourceChannelDoc | null {
  if (!raw || raw.id == null) return null;
  if (raw.license_url) return null; // DRM-only — out of scope (HLS-only proxy)
  const id = String(raw.id);
  const group = String(raw.group || 'Live TV');
  return {
    _id: `${SOURCE_ID}:${id}`,
    source: SOURCE_ID,
    sourceChannelId: id,
    name: String(raw.name || id),
    category: group,
    groupKey: group,
    groupLabel: group,
    logoUrl: raw.logo || null,
    streamEntryUrl: STREAM_URL.replace('{id}', id),
    isPlayable: true, // liveness is request-time (resolve); optimistic at sync time
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    ingestedAt,
  };
}

// The jmp2.uk short link is the channel ENTRY → resolveStream follows its redirect to the real CDN master.
function isEntryUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 'jmp2.uk' && u.pathname.startsWith('/stvp-');
  } catch {
    return false;
  }
}

// Follow the jmp2.uk redirect to the real CDN master (per play — the URL carries a short-lived token). Learn the
// resolved host into the SSRF set so the master's same-host child hops pass the gate (the proxy also learns
// variant/segment hosts via onPlaylistChildHost during rewrite). The body is discarded — only the final URL.
async function resolveStream(entryUrl: string): Promise<{ masterUrl: string }> {
  const res = await fetch(entryUrl, { redirect: 'follow', headers: { 'User-Agent': UA } });
  const finalUrl = res.url || entryUrl;
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }
  if (!res.ok) throw new Error(`samsung resolve failed: HTTP ${res.status} for ${entryUrl}`);
  try {
    allow.allow(new URL(finalUrl).hostname);
  } catch {
    /* ignore malformed */
  }
  return { masterUrl: finalUrl };
}

// Build the samsung self-EPG from the per-region XMLTV, upsert the 'samsung' EpgSource, and self-link the still-
// untouched channels onto it. Live-only (the caller guards on `live` so a snapshot fallback never overwrites a
// good guide). FILL-ONLY-IF-UNTOUCHED — same posture as dlhd/dami.
async function applySamsungSelfEpg(sourceId: string): Promise<void> {
  const { offset, defaulted } = await resolveProgramOffset();
  if (defaulted) logger.warn('seed', `[${sourceId}] settings offset unset — guide times stored as UTC (+0000)`);
  const { channelDocs, programDocs } = await fetchSamsungEpg(samsungRegions(), offset);
  const counts = await writeFastEpg(sourceId, channelDocs, programDocs);
  await upsertFastEpgSource(sourceId, counts, { name: SAMSUNG_EPG_NAME, url: SAMSUNG_EPG_URL });
  const linked = await linkFastSelfEpg(sourceId, counts.channelIds);
  logger.info(
    'seed',
    `[${sourceId}] self-EPG: ${counts.channels} channels / ${counts.programs} programs; linked ${linked} untouched channel(s)`,
  );
}

const samsungAdapter = makeFastSource({
  id: SOURCE_ID,
  label: 'Samsung TV Plus',

  // Semantic category buckets, alphabetical (Samsung's catalog carries a `group` per channel).
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. Samsung carries its OWN self-built guide (afterSync writes a 'samsung'
  // EpgSource from the per-region XMLTV, playlistBinding:true) → Playlist-bound EPG is true.
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

  // ── proxy / resolution overrides (jmp2.uk redirect + dynamic CDN allow-set) ──
  allowedSuffixes: SAMSUNG_SUFFIXES,
  upstreamHeaders: () => ({ 'User-Agent': UA }),
  isAllowedUpstream: (url: string) => allow.isAllowedUpstream(url),
  onPlaylistChildHost: (host: string) => allow.onPlaylistChildHost(host),
  isEntryUrl,
  resolveStream,

  // ── post-sync: gracenote crosswalk (wired; no-ops until the addon lands) THEN samsung self-EPG (live-only) ──
  async afterSync({ sourceId, live }) {
    await applyEpgCrosswalk(sourceId, SAMSUNG_EPG_ADDON_FILE).catch((err) =>
      logger.warn('seed', `[${sourceId}] EPG crosswalk failed (continuing): ${(err as Error).message}`),
    );
    if (live) {
      await applySamsungSelfEpg(sourceId).catch((err) =>
        logger.warn('seed', `[${sourceId}] self-EPG (xmltv) failed (continuing): ${(err as Error).message}`),
      );
    }
  },
});

export default samsungAdapter;
