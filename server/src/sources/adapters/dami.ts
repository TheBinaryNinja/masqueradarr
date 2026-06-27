// dami source adapter (Dami.TV). dami-tv.pro is a DaddyLive (dlhd) FRONT-END: its channel ids ARE DaddyLive
// premium ids (catalog `dlhd-302` → vomos.phantemlis.top/premium302/index.m3u8), so this adapter REUSES dlhd's
// proven leaf modules for stream resolution + the HLS proxy (the same rotating mirror/CDN, the same SSRF
// allowlist, the same secure-link Referer handling) and contributes only what dami does BETTER:
//   · a clean JSON catalog with LOGOS + ISO COUNTRY codes (./dami/catalog.ts) — richer than dlhd's bare
//     A–Z directory scrape; grouped BY COUNTRY here.
//   · a documented live-events API (./dami/events.ts → epg/dami.ts) as the playlist-bound self-EPG, plus the
//     dlhd→gracenote crosswalk (re-id'd to dami:) for the linear 24/7 grids.
//
// COUPLING: this adapter hard-depends on ./dlhd/{config,resolveStream,mirrorDirectory}. Those are acyclic leaf
// modules (they never import an adapter), and their module-level state — the active mirror base + the runtime
// SSRF allowlist — is INTENTIONALLY shared (dami + dlhd hit the same upstream). dlhd is therefore no longer
// independently removable; if a third DaddyLive front-end appears, lift these leaves into sources/daddylive/.
// Playback has ZERO runtime dependency on dami-tv.pro: only the catalog + EPG (sync-time, snapshot-guarded)
// touch dami; streams resolve straight from DaddyLive.

import { DAMI_EPG_ADDON_FILE } from '../paths.js';
import { PlaylistChannel } from '../../models/PlaylistChannel.js';
import { logger } from '../core/logger.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { syncDamiEpg, upsertDamiEpgSource } from '../../epg/dami.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
import { fetchDamiCatalog, countryGroup } from './dami/catalog.js';
import {
  getBase,
  getReferer,
  getMirrorHost,
  UA,
  isAllowedHost,
  isPrivateHost,
  allowHost,
  playerReferer,
} from './dlhd/config.js';
import { resolveStreamUrl } from './dlhd/resolveStream.js';
import { getResolution, ensureMirror, reprobeMirror } from './dlhd/mirrorDirectory.js';
import type { SourceAdapter, ArtifactType } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

// Build the dami self-EPG from the live-events API, upsert the 'dami' EpgSource, and self-link the still-
// untouched event channels onto it. Live-only (the caller guards on `live` so a snapshot fallback never
// overwrites a good guide). FILL-ONLY-IF-UNTOUCHED — same posture as dlhd's applyDlhdSelfEpg.
async function applyDamiSelfEpg(sourceId: string): Promise<void> {
  const { offset, defaulted } = await resolveProgramOffset();
  if (defaulted) logger.warn('seed', `[${sourceId}] settings offset unset — guide times stored as UTC (+0000)`);
  const { channels, programs, channelIds } = await syncDamiEpg(sourceId, offset);
  await upsertDamiEpgSource(sourceId, { channels, programs });
  const ops = channelIds.map((cid) => ({
    updateOne: {
      filter: { _id: `${sourceId}:${cid}`, source: sourceId, epg: null, epgState: null },
      update: { $set: { tvg_id: cid, epg: sourceId, epgState: 'matched' as const } },
    },
  }));
  const linked = ops.length
    ? (await PlaylistChannel.bulkWrite(ops, { ordered: false })).modifiedCount ?? 0
    : 0;
  logger.info(
    'seed',
    `[${sourceId}] self-EPG: ${channels} channels / ${programs} programs from live events; linked ${linked} untouched channel(s)`,
  );
}

const damiAdapter: SourceAdapter = {
  id: 'dami',
  label: 'Dami.TV',

  // ── listings ───────────────────────────────────────────────────────────────────
  // dami's published JSON catalog (logos + country), with the committed snapshot fallback. No mirror probe
  // here — the catalog comes from dami, not the DaddyLive mirror (that's only needed at resolve time).
  async listChannels() {
    return fetchDamiCatalog();
  },

  // ── normalize: one catalog row → one SourceChannel document ──────────────────────
  normalize(raw: any, { ingestedAt }): SourceChannelDoc | null {
    if (raw == null || raw.id == null) return null;
    const sourceChannelId = String(raw.id);
    const group = countryGroup(raw.country);
    return {
      _id: `dami:${sourceChannelId}`,
      source: 'dami',
      sourceChannelId,
      name: raw.name,
      category: null, // grouped by country, not a semantic category
      groupKey: group,
      groupLabel: group,
      logoUrl: raw.image || null, // dami ships channel logos (richer than dlhd)
      // dami channel ids ARE DaddyLive ids → store a dlhd-style watch.php entry against the ACTIVE dlhd mirror.
      // resolveStream keys off the id, so the host is never fetched from this stored value (a stale host is inert).
      streamEntryUrl: `${getBase()}/watch.php?id=${sourceChannelId}`,
      isPlayable: true, // liveness is request-time (resolve), so optimistic at sync time
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
      ingestedAt,
    };
  },

  // First-sync default: hide adult ("18+") channels (a user can re-enable; the choice survives re-syncs).
  defaultDisabled: (ch) => ch.name.includes('18+'),

  // Country buckets, alphabetical (the data-backed grouping dami's catalog supports).
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. dami carries its OWN self-built guide — afterSync writes a 'dami'
  // EpgSource from the live-events API (syncDamiEpg, playlistBinding:true) — so Playlist-bound EPG is true.
  builtinMeta: {
    globalPlaylist: true,
    clonePlaylist: true,
    syncSchedules: true,
    videoEngineCustomization: true,
    playlistBoundEpg: true,
    epgSyncSchedules: false,
  },

  // Runtime provenance: the active DaddyLive mirror dami resolves through (shared with dlhd).
  async status() {
    await ensureMirror().catch(() => undefined);
    return getResolution();
  },

  // ── stream resolution (delegated to dlhd's DaddyLive resolver) ───────────────────
  isEntryUrl(url: string) {
    try {
      const u = new URL(url);
      return /\/watch\.php$/i.test(u.pathname) || /\/stream\/stream-\d+\.php$/i.test(u.pathname);
    } catch {
      return false;
    }
  },
  async resolveStream(entryUrl: string) {
    // Identical 3-hop DaddyLive resolve + mirror-failover as dlhd (same upstream + leaf modules). A
    // connection-level failure means the active mirror is unreachable — force a re-probe and retry once.
    const looksUnreachable = (msg: string): boolean =>
      /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|UND_ERR/i.test(msg);
    try {
      await ensureMirror();
      const { masterUrl } = await resolveStreamUrl(entryUrl);
      return { masterUrl };
    } catch (err) {
      const msg = (err as Error).message;
      if (!looksUnreachable(msg)) throw err; // a real "not live" / layout error already reads clearly

      const deadBase = getBase();
      logger.warn('dami', `resolve failed against ${deadBase} (${msg}) — re-probing mirrors`);
      const res = await reprobeMirror().catch(() => null);
      if (res && !res.degraded) {
        try {
          const { masterUrl } = await resolveStreamUrl(entryUrl);
          if (res.chosen !== deadBase) logger.ok('dami', `mirror failover: ${deadBase} → ${res.chosen}`);
          return { masterUrl };
        } catch (retryErr) {
          if (!looksUnreachable((retryErr as Error).message)) throw retryErr;
        }
      }
      throw new Error(
        `cannot reach any DaddyLive mirror for dami (active: ${getBase()}; down, rotated, or geo-blocked). ` +
          `Mirrors are auto-selected from the DaddyLive directory and re-probed on each failure; pin one with ` +
          `DLHD_BASE=https://<current-mirror> and re-Sync. Underlying: ${msg}`,
      );
    }
  },

  // ── proxy behavior (delegated to dlhd's config — dami shares the mirror/CDN + SSRF allowlist) ────────
  proxy: {
    upstreamHeaders(url: string): Record<string, string> {
      try {
        const host = new URL(url).hostname;
        const referer = host === getMirrorHost() ? getReferer() : playerReferer();
        return { Referer: referer, 'User-Agent': UA };
      } catch {
        return { 'User-Agent': UA };
      }
    },
    isAllowedUpstream(url: string) {
      try {
        const u = new URL(url);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
        if (isPrivateHost(u.hostname)) return false; // SSRF: never proxy a private/loopback/link-local target
        return isAllowedHost(u.hostname);
      } catch {
        return false;
      }
    },
    onPlaylistChildHost: (host: string) => {
      allowHost(host); // dynamic allowlist: trust hosts referenced inside a resolved playlist
    },
    relabelSegmentContentType(_url: string, contentType: string, type?: ArtifactType) {
      // Real segments are MPEG-TS disguised as image/jpeg|png|pdf — relabel so Safari/VLC play them.
      return type === 'segment' ? 'video/mp2t' : contentType || 'application/octet-stream';
    },
    classifyArtifact(url: string): ArtifactType {
      try {
        const p = new URL(url).pathname.toLowerCase();
        if (p.includes('/watch.php') || /\/stream\/stream-\d+\.php$/.test(p)) return 'master'; // entry
        if (p.endsWith('.m3u8')) return p.endsWith('/index.m3u8') ? 'master' : 'variant';
        return 'segment';
      } catch {
        return 'other';
      }
    },
  },

  // ── post-sync hooks: gracenote crosswalk (US linear) THEN dami self-EPG (live events) ────────────
  // Order matters: the crosswalk runs first so a Gracenote-covered channel keeps its full grid; the self-EPG
  // then claims the remaining untouched event channels. Both are FILL-ONLY-IF-UNTOUCHED + non-fatal. The
  // self-EPG is LIVE-ONLY (skipped on a snapshot fallback so a stale/empty payload never replaces a good guide).
  async afterSync({ sourceId, live }) {
    await applyEpgCrosswalk(sourceId, DAMI_EPG_ADDON_FILE).catch((err) =>
      logger.warn('seed', `[${sourceId}] EPG crosswalk failed (continuing): ${(err as Error).message}`),
    );
    if (live) {
      await applyDamiSelfEpg(sourceId).catch((err) =>
        logger.warn('seed', `[${sourceId}] self-EPG (events) failed (continuing): ${(err as Error).message}`),
      );
    }
  },
};

export default damiAdapter;
