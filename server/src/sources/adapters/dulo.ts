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
// The resolved playbackUrl is served through dulo's own proxy (/proxy/hls/, gotcha.<domain> / live-gateway)
// or an external host (tstrm.org / vixproxy). Its exact host can't be known until resolved, so the SSRF
// gate allows the active dulo domain (and its subdomains) plus any host LEARNED from a playlist we
// legitimately resolved/fetched (onPlaylistChildHost) — the shared _fast/dynamicAllow set, owned by
// ./dulo/config.ts. Auth is established out-of-band by the SPA capture flow → POST /api/sources/dulo/auth
// (see routes/sources.ts).
//
// dulo REBRANDS periodically, so no dulo URL is a const here: the domain is an operator setting
// (Settings.duloDomain) and every endpoint/header is derived from ./dulo/config.ts at use time.

import { readFileSync } from 'node:fs';
import { snapshotFile, DULO_EPG_ADDON_FILE } from '../paths.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { duloAuth } from './dulo/auth.js';
import { getCatalogUrl, browserHeaders, duloAllow } from './dulo/config.js';
import type { SourceAdapter } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SNAPSHOT = snapshotFile('dulo');
const ENTRY_PREFIX = 'dulo://channel/';

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
    const endpoint = getCatalogUrl(); // follows Settings.duloDomain — reported in meta so a sync shows it
    try {
      const res = await fetch(endpoint, { headers: browserHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { channels?: any[] };
      const raw = body.channels || [];
      if (!raw.length) throw new Error('empty channel list');
      return { raw, meta: { endpoint, live: true, fetchedAt: new Date().toISOString() } };
    } catch (err) {
      const reason = (err as Error).message;
      // Offline fallback. UNLIKE every other source, dulo has no committed snapshot, so this read normally
      // throws ENOENT — which turned a wrong/dead domain into an opaque file error. Compose a message that
      // names the endpoint actually tried and points at the setting. Deliberately NOT an empty channel
      // list: a sync with zero rows would wipe the catalog. `npm run rebuild:seed` commits a snapshot and
      // restores the intended soft (warn, not fail) fallback.
      let snap: { channels?: any[] };
      try {
        snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: any[] };
      } catch (snapErr) {
        throw new Error(
          `dulo catalog unreachable at ${endpoint} (${reason}), and no offline snapshot is available ` +
            `(${(snapErr as Error).message}). If dulo has changed domain, set the new one under ` +
            `Settings → Advanced → Dulo.tv Authentication.`,
        );
      }
      return {
        raw: snap.channels || [],
        meta: {
          endpoint,
          live: false,
          fallback: 'dulo.snapshot.json',
          reason,
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
      // Browser-like headers: dulo is bot-gated and the memfs/proxy hosts check Origin. Built from the
      // ACTIVE domain at call time. The Bearer is deliberately NOT sent on CDN hops — the resolved
      // playbackUrl is expected to be self-authenticating (token in the URL). If a real account shows
      // segments need it, add it here.
      return browserHeaders();
    },
    isAllowedUpstream: (url: string) => duloAllow.isAllowedUpstream(url),
    // Learn each child host of a playlist we resolved/fetched so its segments pass the SSRF gate.
    onPlaylistChildHost: (host: string) => duloAllow.onPlaylistChildHost(host),
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
  // crosswalk (seed-data/dulo-playlist-addon.json — see scripts/dulo-epg-crosswalk.ts). The apply is the
  // shared, GUARDED helper (sources/epgCrosswalk.ts): a row is staged epgState:'matched' only when its
  // (epg, tvg_id) pair resolves to a real epgchannels doc, so a target Gracenote source the user hasn't
  // added yet is left unmatched (and auto-links on a later sync once present). FILL-ONLY-IF-UNTOUCHED and
  // non-fatal — Restore Defaults drops the channels, so a re-sync re-applies onto untouched rows.
  async afterSync({ sourceId }) {
    await applyEpgCrosswalk(sourceId, DULO_EPG_ADDON_FILE);
  },
};

export default duloAdapter;
