// dlhd source adapter. Ported from ../d-combine/sources/dlhd/adapter.mjs.
//
// dlhd has no JSON catalog API, so listings are scraped from a server-rendered 24/7 directory on a mirror
// whose DOMAIN ROTATES (resolved at runtime by ./dlhd/mirrorDirectory.ts). Each channel's entry is
// `…/watch.php?id=N`, which must be RESOLVED server-side (a 3-hop scrape: stream-N.php → daddy<n>.php
// player → base64-embedded signed master — see ./dlhd/resolveStream.ts) before it can be proxied. The
// CDN/player/segment hosts also rotate, so the SSRF allowlist grows at runtime, and segments are MPEG-TS
// disguised as image/pdf and must be relabeled video/mp2t.
//
// Unlike dulo, dlhd is ANONYMOUS — no auth, no login browser, no PlaylistAuth (requiresAuth is unset, so
// its (Default) playlist seeds with authentication:false). All mirror/host/resolution state lives in the
// ./dlhd/ submodules; this adapter just wires that logic into the generic SourceAdapter contract.

import { readFileSync } from 'node:fs';
import { snapshotFile, DLHD_EPG_ADDON_FILE } from '../paths.js';
import { PlaylistChannel } from '../../models/PlaylistChannel.js';
import { logger } from '../core/logger.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { syncDlhdEpg, upsertDlhdEpgSource } from '../../epg/dlhd.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
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
import { parseChannels } from './dlhd/parseDirectory.js';
import { resolveStreamUrl } from './dlhd/resolveStream.js';
import { getResolution, ensureMirror, reprobeMirror } from './dlhd/mirrorDirectory.js';
import type { SourceAdapter, ArtifactType } from '../types.js';
import type { DlhdRawChannel } from './dlhd/parseDirectory.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SNAPSHOT = snapshotFile('dlhd');

// ── post-sync EPG hooks (two complementary guides) ───────────────────────────────────────────────────
// dlhd carries no native guide, so after syncLive populates the channels we attach EPG data two ways, IN
// ORDER so the richer source wins per channel and a channel is linked at most once:
//   (1) the committed dlhd→gracenote crosswalk — links US LINEAR channels to EXISTING Gracenote sources
//       (full grid). Applied via the shared GUARDED helper sources/epgCrosswalk.ts (afterSync below), which
//       stages 'matched' only when the (epg, tvg_id) pair resolves to a real epgchannels doc. See
//       seed-data/dlhd-playlist-addon.json + scripts/dlhd-epg-crosswalk.ts.
//   (2) the dlhd SELF-EPG — a dedicated 'dlhd' EpgSource built from DaddyLive's live-event SCHEDULE
//       (epg/dlhd.ts), self-linking the event/sports channels Gracenote didn't already claim.
// Both are FILL-ONLY-IF-UNTOUCHED (filter requires epg == null AND epgState == null) — a user link sets
// epg, an unlink leaves epgState 'unmatched' (not null), so both are skipped. Both are non-fatal: a guide
// failure must not fail a channel sync that succeeded. Restore Defaults drops the channels, so a re-sync
// re-applies both onto untouched rows.

// (1) The committed gracenote crosswalk is applied by applyEpgCrosswalk(sourceId, DLHD_EPG_ADDON_FILE) —
// see the shared guarded helper in sources/epgCrosswalk.ts (called from afterSync below).

// (2) Build the dlhd self-EPG from the live-event schedule, upsert the 'dlhd' EpgSource, and self-link the
// still-untouched event channels onto it. Live-only (the caller guards on `live` so a snapshot fallback
// never overwrites a good guide).
async function applyDlhdSelfEpg(sourceId: string): Promise<void> {
  // Stamp the operator's UTC offset onto the guide programs (settings.offset; '+0000' when unset). No UI on a
  // playlist sync → log if it defaulted rather than toast. See settings/programOffset.ts.
  const { offset, defaulted } = await resolveProgramOffset();
  if (defaulted) logger.warn('seed', `[${sourceId}] settings offset unset — guide times stored as UTC (+0000)`);
  const { channels, programs, channelIds } = await syncDlhdEpg(sourceId, offset);
  await upsertDlhdEpgSource(sourceId, { channels, programs });
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
    `[${sourceId}] self-EPG: ${channels} channels / ${programs} programs from schedule; linked ${linked} untouched channel(s)`,
  );
}

const dlhdAdapter: SourceAdapter = {
  id: 'dlhd',
  label: 'DaddyLive.TV',

  // ── listings ───────────────────────────────────────────────────────────────────
  // Ensure a live mirror is picked (lazy, TTL-gated), scrape the 24/7 directory, and fall back to the
  // committed snapshot when offline / blocked. The snapshot covers the CATALOG only — stream resolution
  // still needs a reachable mirror (resolveStream has no offline path).
  async listChannels() {
    await ensureMirror().catch(() => undefined); // best-effort; getBase() falls back to the last/default base
    const directoryUrl = `${getBase()}/24-7-channels.php`;
    const mirror = getResolution(); // provenance: which mirror was chosen + per-candidate status
    try {
      const res = await fetch(directoryUrl, { headers: { Referer: getReferer(), 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const channels = parseChannels(await res.text());
      if (!channels.length) throw new Error('no channels parsed (layout changed?)');
      return {
        raw: channels,
        meta: { base: getBase(), endpoint: directoryUrl, live: true, mirror, fetchedAt: new Date().toISOString() },
      };
    } catch (err) {
      const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: DlhdRawChannel[] };
      return {
        raw: snap.channels || [],
        meta: {
          base: getBase(),
          endpoint: directoryUrl,
          live: false,
          fallback: 'dlhd.snapshot.json',
          reason: (err as Error).message,
          mirror,
          fetchedAt: new Date().toISOString(),
        },
      };
    }
  },

  // ── normalize: one scraped record → one SourceChannel document ───────────────────
  normalize(raw: any, { ingestedAt }): SourceChannelDoc | null {
    if (raw == null || raw.id == null) return null;
    const sourceChannelId = String(raw.id);
    const group = raw.group || '#';
    return {
      _id: `dlhd:${sourceChannelId}`,
      source: 'dlhd',
      sourceChannelId,
      name: raw.name,
      category: null, // dlhd has no semantic categories — only A–Z buckets
      groupKey: group,
      groupLabel: group,
      logoUrl: null, // dlhd provides no logos
      // Point at the active mirror (read at sync time). resolveStream keys off the channel id, so only the
      // id in this URL matters — the host is never fetched from this stored value (a stale host is inert).
      streamEntryUrl: `${getBase()}/watch.php?id=${sourceChannelId}`,
      isPlayable: true, // liveness is request-time (resolve), so optimistic at sync time
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
      ingestedAt,
    };
  },

  // First-sync default: hide adult ("18+") channels. A user can re-enable any of them in the
  // Playlists screen and that choice survives every later sync (status is $setOnInsert-only).
  defaultDisabled: (ch) => ch.name.includes('18+'),

  // Preserve the directory's source order (A–Z then "#"), like the dlhd PoC frontend.
  grouping: { by: 'groupKey', groupOrder: 'source', channelOrder: 'source' },

  // Add Playlist "Built-In" summary. dlhd carries its OWN self-built guide — its afterSync writes a 'dlhd'
  // EpgSource from DaddyLive's live-event schedule (syncDlhdEpg, playlistBinding:true) — so Playlist-bound
  // EPG is true (a playlist sync also updates the EPG). The rest are the common posture.
  builtinMeta: {
    globalPlaylist: true,
    clonePlaylist: true,
    syncSchedules: true,
    videoEngineCustomization: true,
    playlistBoundEpg: true,
    epgSyncSchedules: false,
  },

  // Runtime provenance: which advertised mirror is active + each candidate's probe result. Pre-flights a
  // resolve so an operator hitting /api/sources/dlhd/status sees fresh data. Null until the first resolve.
  async status() {
    await ensureMirror().catch(() => undefined);
    return getResolution();
  },

  // ── stream resolution ────────────────────────────────────────────────────────────
  isEntryUrl(url: string) {
    try {
      const u = new URL(url);
      return /\/watch\.php$/i.test(u.pathname) || /\/stream\/stream-\d+\.php$/i.test(u.pathname);
    } catch {
      return false;
    }
  },
  async resolveStream(entryUrl: string) {
    // A connection-level failure means the active mirror is unreachable (dlhd domains rotate / get
    // sinkholed) — distinct from a clean "not live" (no player iframe / no signed master in the page).
    const looksUnreachable = (msg: string): boolean =>
      /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|UND_ERR/i.test(msg);
    try {
      await ensureMirror();
      const { masterUrl } = await resolveStreamUrl(entryUrl); // 3-hop scrape; seeds the dynamic allowlist
      return { masterUrl };
    } catch (err) {
      const msg = (err as Error).message;
      if (!looksUnreachable(msg)) throw err; // a real "not live" / layout error already reads clearly

      // The active mirror looks dead. Don't strand the stream until the 30-min mirror TTL lapses: force a
      // fresh directory re-probe NOW and, if a live mirror gets committed, retry the resolve ONCE against it
      // — a mid-stream mirror death then self-heals via failover instead of killing playback.
      const deadBase = getBase();
      logger.warn('dlhd', `resolve failed against ${deadBase} (${msg}) — re-probing mirrors`);
      const res = await reprobeMirror().catch(() => null);
      if (res && !res.degraded) {
        try {
          const { masterUrl } = await resolveStreamUrl(entryUrl);
          if (res.chosen !== deadBase) logger.ok('dlhd', `mirror failover: ${deadBase} → ${res.chosen}`);
          return { masterUrl };
        } catch (retryErr) {
          if (!looksUnreachable((retryErr as Error).message)) throw retryErr;
          // still unreachable after failover → fall through to the actionable error below
        }
      }
      // Nothing reachable (every advertised + seed mirror failed probing), or the failover mirror also
      // refused. Surface an actionable error — getBase() may have changed during the re-probe above.
      throw new Error(
        `cannot reach any dlhd mirror (active: ${getBase()}; down, rotated, or geo-blocked). Mirrors are ` +
          `auto-selected from the DaddyLive directory and re-probed on each failure; pin one with ` +
          `DLHD_BASE=https://<current-mirror> and re-Sync. Underlying: ${msg}`,
      );
    }
  },

  // ── proxy behavior ─────────────────────────────────────────────────────────────────
  proxy: {
    upstreamHeaders(url: string): Record<string, string> {
      // Mirror hops need the dlhd Referer; CDN/segment hops replay the (rotating) player origin.
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

  // ── post-sync hooks: gracenote crosswalk (US linear) THEN dlhd self-EPG (live events) ────────────
  // Both are non-fatal and FILL-ONLY-IF-UNTOUCHED — see applyEpgCrosswalk / applyDlhdSelfEpg above.
  // Order matters: the crosswalk runs first so a Gracenote-covered channel keeps its full grid; the
  // self-EPG then claims the remaining untouched event channels. The self-EPG is LIVE-ONLY (skipped on a
  // snapshot fallback so a stale/empty schedule never replaces a good guide).
  async afterSync({ sourceId, live }) {
    await applyEpgCrosswalk(sourceId, DLHD_EPG_ADDON_FILE).catch((err) =>
      logger.warn('seed', `[${sourceId}] EPG crosswalk failed (continuing): ${(err as Error).message}`),
    );
    if (live) {
      await applyDlhdSelfEpg(sourceId).catch((err) =>
        logger.warn('seed', `[${sourceId}] self-EPG (schedule) failed (continuing): ${(err as Error).message}`),
      );
    }
  },
};

export default dlhdAdapter;
