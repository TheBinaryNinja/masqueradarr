// dulo.tv source adapter. Originally ported from ../d-combine/sources/dulo/adapter.mjs.
//
// CHANGED (2026-06): dulo.tv reworked Live TV. The catalog (`/api/live-tv/channels`) no longer carries a
// stream URL — `source_url`/`direct_source` were removed, a `playable` boolean was added — and streams are
// now minted per play behind a Supabase-authenticated, device-bound, expiring "playback session". So dulo
// is no longer a token-free identity source: it is a STATEFUL, AUTHENTICATED, resolve-on-demand source
// (structurally the dlhd model). All session/device/token state lives in ./dulo/auth.ts; this adapter just
// wires it into the generic SourceAdapter contract:
//   · normalize()      → a `dulo://channel/<id>` sentinel as streamEntryUrl (no static URL exists)
//   · isEntryUrl()     → true for that sentinel
//   · resolveStream()  → duloAuth.resolvePlayback(channelId) → the fresh playbackUrl (the real master)
//
// The resolved playbackUrl is served through dulo's own proxy (/proxy/hls/, gotcha.dulo.tv / live-gateway)
// or an external host (tstrm.org / vixproxy). Its exact host can't be known until resolved, so the SSRF
// gate allows *.dulo.tv plus any host LEARNED from a playlist we legitimately resolved/fetched
// (onPlaylistChildHost), the same dynamic-allow approach dlhd uses. Auth is established out-of-band by the
// SPA capture flow → POST /api/sources/dulo/auth (see routes/sources.ts).

import { readFileSync } from 'node:fs';
import { snapshotFile, DULO_EPG_ADDON_FILE } from '../paths.js';
import { PlaylistChannel } from '../../models/PlaylistChannel.js';
import { logger } from '../core/logger.js';
import { duloAuth } from './dulo/auth.js';
import type { SourceAdapter } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SNAPSHOT = snapshotFile('dulo');
const DULO_ORIGIN = 'https://dulo.tv';
const DULO_API = process.env.DULO_API || 'https://dulo.tv/api/live-tv/channels';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ENTRY_PREFIX = 'dulo://channel/';

// Hosts allowed for direct (non-entry) proxy hops. *.dulo.tv is static; additional playbackUrl hosts are
// learned at runtime from playlists we resolved/fetched (trust roots at dulo's authenticated response).
const EXTRA_HOSTS = new Set(
  (process.env.DULO_EXTRA_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);
const dynamicHosts = new Set<string>();

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'dulo.tv' || h.endsWith('.dulo.tv') || EXTRA_HOSTS.has(h) || dynamicHosts.has(h);
}

function toIso(ts: unknown): string | null {
  if (!ts || typeof ts !== 'string') return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const duloAdapter: SourceAdapter = {
  id: 'dulo',
  label: 'Dulo.TV',
  // dulo gates Live TV behind a Supabase session (see ./dulo/auth.ts) → its (Default) playlist requires auth.
  requiresAuth: true,

  // Prefer the live catalog API; fall back to the captured snapshot when offline / region-blocked.
  // (The catalog is metadata-only now — no stream URLs — so this needs no auth; the stream is resolved
  // lazily at play time via resolveStream().)
  async listChannels() {
    try {
      const res = await fetch(DULO_API, { headers: { 'User-Agent': UA, Origin: DULO_ORIGIN, Referer: `${DULO_ORIGIN}/live` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { channels?: any[] };
      const raw = body.channels || [];
      if (!raw.length) throw new Error('empty channel list');
      return { raw, meta: { endpoint: DULO_API, live: true, fetchedAt: new Date().toISOString() } };
    } catch (err) {
      const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: any[] };
      return {
        raw: snap.channels || [],
        meta: {
          endpoint: DULO_API,
          live: false,
          fallback: 'dulo.snapshot.json',
          reason: (err as Error).message,
          fetchedAt: new Date().toISOString(),
        },
      };
    }
  },

  normalize(raw: any, { ingestedAt }): SourceChannelDoc | null {
    if (raw == null || raw.id == null) return null;
    const sourceChannelId = String(raw.id);
    const category = raw.category || null;
    return {
      _id: `dulo:${sourceChannelId}`,
      source: 'dulo',
      sourceChannelId,
      name: raw.name,
      category, // dulo has real semantic categories
      groupKey: category || 'uncategorized',
      groupLabel: category || 'uncategorized',
      logoUrl: raw.logo_url || null,
      // No static stream URL exists anymore — store a sentinel the proxy recognises (isEntryUrl) and
      // resolves on demand. The real (expiring) master is minted per play in resolveStream().
      streamEntryUrl: `${ENTRY_PREFIX}${sourceChannelId}`,
      isPlayable: raw.playable !== false, // new catalog flag; default playable when absent
      sourceCreatedAt: toIso(raw.created_at),
      sourceUpdatedAt: toIso(raw.updated_at),
      ingestedAt,
    };
  },

  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. dulo carries NO self-built guide — its afterSync only crosswalks
  // channels onto EXISTING external Gracenote sources — so Playlist-bound EPG is false (the user is
  // responsible for matching channels without a pre-determined match). The rest are the common posture.
  builtinMeta: {
    globalPlaylist: true,
    clonePlaylist: true,
    syncSchedules: true,
    videoEngineCustomization: true,
    playlistBoundEpg: false,
    epgSyncSchedules: false,
  },

  status: () => duloAuth.status(),

  isEntryUrl(url: string) {
    return typeof url === 'string' && url.startsWith(ENTRY_PREFIX);
  },
  async resolveStream(entryUrl: string) {
    const channelId = entryUrl.slice(ENTRY_PREFIX.length);
    if (!channelId) throw new Error('malformed dulo entry url');
    const { playbackUrl } = await duloAuth.resolvePlayback(channelId);
    return { masterUrl: playbackUrl };
  },

  proxy: {
    upstreamHeaders() {
      // Browser-like headers: dulo is bot-gated and the memfs/proxy hosts check Origin. The Bearer is
      // deliberately NOT sent on CDN hops — the resolved playbackUrl is expected to be self-authenticating
      // (token in the URL). If a real account shows segments need it, add it here.
      return { 'User-Agent': UA, Origin: DULO_ORIGIN, Referer: `${DULO_ORIGIN}/live` };
    },
    isAllowedUpstream(url: string) {
      try {
        const u = new URL(url);
        return (u.protocol === 'https:' || u.protocol === 'http:') && hostAllowed(u.hostname);
      } catch {
        return false;
      }
    },
    // Learn each child host of a playlist we resolved/fetched so its segments pass the SSRF gate.
    onPlaylistChildHost: (host: string) => {
      if (host) dynamicHosts.add(host.toLowerCase());
    },
    relabelSegmentContentType(_url: string, contentType: string) {
      return contentType || 'application/octet-stream'; // plain TS — pass the upstream type through
    },
    classifyArtifact(url: string) {
      try {
        const p = new URL(url).pathname.toLowerCase();
        if (p.endsWith('.ts')) return 'segment';
        if (p.endsWith('.m3u8')) return p.includes('_output_') ? 'variant' : 'master';
        return 'other';
      } catch {
        return 'other';
      }
    },
  },

  // ── post-sync hook: apply the committed dulo→gracenote EPG-link crosswalk ─────────────────────────
  // After syncLive populates the channels, link each dulo channel to its gracenote guide from the offline
  // crosswalk (seed-data/dulo-playlist-addon.json — see scripts/dulo-epg-crosswalk.ts). FILL-ONLY-IF-
  // UNTOUCHED: the filter requires epg == null AND epgState == null, so a channel is linked exactly once
  // (right after its first sync) and a later user edit is NEVER overwritten — a manual link/remap sets epg,
  // and an unlink leaves epgState 'unmatched' (not null), so both are skipped. Only HIGH-confidence rows
  // auto-apply; medium rows are left for manual review in the Channel Mapping screen. Non-fatal: a missing/
  // unreadable crosswalk must not fail a sync that succeeded. Restore Defaults re-applies it (it drops the
  // channels, so the re-synced rows are untouched again).
  async afterSync({ sourceId }) {
    type AddonRow = { id: string; tvg_id: string; epg: string; confidence: 'high' | 'medium' };
    let rows: AddonRow[];
    try {
      const parsed = JSON.parse(readFileSync(DULO_EPG_ADDON_FILE, 'utf8'));
      rows = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      logger.warn('seed', `[${sourceId}] EPG crosswalk not applied (unreadable): ${(err as Error).message}`);
      return;
    }
    const ops = rows
      .filter((r) => r?.confidence === 'high' && r.id && r.tvg_id && r.epg)
      .map((r) => ({
        updateOne: {
          // Untouched-only: skips user-linked (epg set) AND user-unlinked (epgState 'unmatched') channels.
          filter: { _id: r.id, source: sourceId, epg: null, epgState: null },
          update: { $set: { tvg_id: r.tvg_id, epg: r.epg, epgState: 'matched' as const } },
        },
      }));
    if (!ops.length) return;
    const res = await PlaylistChannel.bulkWrite(ops, { ordered: false });
    logger.info(
      'seed',
      `[${sourceId}] EPG crosswalk: linked ${res.modifiedCount ?? 0} channel(s) from ${ops.length} high-confidence mapping(s)`,
    );
  },
};

export default duloAdapter;
