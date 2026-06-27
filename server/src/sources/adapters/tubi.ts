// tubi source adapter. Ported from ../d-combine/sources/tubi/adapter.mjs.
//
// Tubi has no catalog API: channels + groups are scraped from the /live page's `window.__data`, and a
// second endpoint (/oz/epg/programming) yields each channel's logos, the full EPG programs[], and a
// short-lived JWT-signed HLS manifest URL. Because that manifest URL is minted PER REQUEST, the stored
// entry URL is RE-RESOLVED at play time (dlhd-style) — see ./tubi/resolveStream.ts. The streams are
// AES-128 encrypted and the manifest 302-chains to a stitcher (apollo-eks) before the master; the resolver
// returns the post-redirect master so the core proxy rewrites its relative variants correctly, and the
// shared rewriter (core/playlist.ts) routes the #EXT-X-KEY URI back through the proxy so the key decrypts.
//
// tubi is UNIQUE in that it carries its OWN EPG inline: afterSync (the source-agnostic post-sync hook)
// attaches EPG the dlhd/dami TWO-TIER way — (1) a committed gracenote crosswalk (TUBI_EPG_ADDON_FILE, ported
// from FastChannels' exact per-content_id tmsid map) links the curated US linear channels to a real Gracenote
// guide so they share a standard grid + cross-source-dedupe, then (2) tubi's own inline guide
// (epgchannels/programs from this same listing) is written, the 'tubi' EpgSource upserted, and the REMAINING
// untouched playlistchannels self-linked to it. SSRF is a clean STATIC suffix allowlist of
// Tubi's corporate domains (no runtime growth); that strict match inherently excludes private/loopback hosts.
// tubi is ANONYMOUS — no auth (requiresAuth unset → its (Default) playlist seeds authentication:false).

import { fetchTubiCatalog, UA } from './tubi/catalog.js';
import { resolveTubiStream } from './tubi/resolveStream.js';
import { writeTubiEpg, upsertTubiEpgSource } from '../../epg/tubi.js';
import { PlaylistChannel } from '../../models/PlaylistChannel.js';
import { applyEpgCrosswalk } from '../epgCrosswalk.js';
import { TUBI_EPG_ADDON_FILE } from '../paths.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
import { logger } from '../core/logger.js';
import type { SourceAdapter, ArtifactType } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

// Every stream artifact (manifest, master, variant, segment, AES key) lives under one of these.
const ALLOWED_SUFFIXES = ['tubi.io', 'tubi.video', 'tubitv.com'];

/** Prefer the small thumbnail logo, then landscape/poster; null if the channel has no images. */
function pickLogo(images: any): string | null {
  if (!images) return null;
  const first = (arr: any): string | null => (Array.isArray(arr) && arr.length ? arr[0] : null);
  return first(images.thumbnail) || first(images.landscape) || first(images.poster) || null;
}

const tubiAdapter: SourceAdapter = {
  id: 'tubi',
  label: 'Tubi.TV',

  // ── listings ───────────────────────────────────────────────────────────────────
  // Scrape /live for ids+groups, batch the EPG endpoint; fall back to the snapshot when offline/blocked.
  // The rows also carry each channel's programs[] — consumed by afterSync, ignored by normalize().
  async listChannels() {
    return fetchTubiCatalog();
  },

  // ── normalize: one EPG row (with group) → one SourceChannel document ──────────────
  // programs[] is intentionally NOT carried here (SourceChannel is the streaming reference, not the guide);
  // the EPG side reads programs straight off the raw rows in afterSync → writeTubiEpg.
  normalize(raw: any, { ingestedAt }): SourceChannelDoc | null {
    if (raw == null || raw.content_id == null) return null;
    const sourceChannelId = String(raw.content_id);
    const group = raw.group || 'Other';
    const manifest = raw.video_resources?.[0]?.manifest?.url;
    return {
      _id: `tubi:${sourceChannelId}`,
      source: 'tubi',
      sourceChannelId,
      name: raw.title,
      category: group, // Tubi's genre category doubles as the UI group
      groupKey: group,
      groupLabel: group,
      logoUrl: pickLogo(raw.images),
      // Stable entry URL, RE-RESOLVED per play (the resolver keys off content_id, never this host).
      streamEntryUrl: `https://tubitv.com/oz/epg/programming?content_id=${sourceChannelId}`,
      isPlayable: Boolean(manifest) && !raw.needs_login,
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
      ingestedAt,
    };
  },

  // ── UI grouping descriptor (serializable; read by the generic frontend) ───────────
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. tubi BUNDLES its own guide — its afterSync writes a 'tubi' EpgSource
  // (writeTubiEpg, playlistBinding:true) and self-links its channels — so Playlist-bound EPG is true (a
  // playlist sync also updates the EPG). The rest are the common posture.
  builtinMeta: {
    globalPlaylist: true,
    clonePlaylist: true,
    syncSchedules: true,
    videoEngineCustomization: true,
    playlistBoundEpg: true,
    epgSyncSchedules: false,
  },

  // ── stream resolution ─────────────────────────────────────────────────────────────
  isEntryUrl(url: string) {
    try {
      return /\/oz\/epg\/programming$/i.test(new URL(url).pathname);
    } catch {
      return false;
    }
  },
  async resolveStream(entryUrl: string) {
    try {
      return await resolveTubiStream(entryUrl); // EPG hop + redirect-follow to the apollo-eks master
    } catch (err) {
      const msg = (err as Error).message;
      // Tubi's web tier (tubitv.com) serves a 200 HTML failsafe shell — not stream data — while its origin
      // is erroring. resolveStream guards the content-type for this; also catch a raw JSON-parse error from
      // an older path as the same condition, so the player sees "Tubi is down", not a parser error.
      if (/non-JSON|failsafe|Unexpected token .?<|is not valid JSON/i.test(msg)) {
        throw new Error(
          `Tubi upstream is down (tubitv.com returned a failsafe/error page, not stream data). ` +
            `Underlying: ${msg}`,
        );
      }
      // A bare network failure usually means Tubi is unreachable or we're off US egress (Tubi live is
      // US-only and mints a fresh signed manifest per play). Turn the opaque error into an actionable one.
      if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|UND_ERR/i.test(msg)) {
        throw new Error(
          `cannot reach Tubi (down or non-US egress). Tubi live is US-only and mints a fresh signed ` +
            `manifest per play. Underlying: ${msg}`,
        );
      }
      throw err; // a real "not live" / "needs login" error already carries a clear message
    }
  },

  // ── proxy behavior ─────────────────────────────────────────────────────────────────
  proxy: {
    upstreamHeaders() {
      return { 'User-Agent': UA }; // Tubi/CloudFront gate on the signed URL — no Referer/Origin needed
    },
    isAllowedUpstream(url: string) {
      // STATIC suffix allowlist (Tubi corporate domains only); a strict suffix match inherently blocks any
      // private/loopback/link-local target, so no separate SSRF private-IP check is needed.
      try {
        const u = new URL(url);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
        return ALLOWED_SUFFIXES.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));
      } catch {
        return false;
      }
    },
    onPlaylistChildHost: null, // static allowlist — nothing to learn at runtime
    relabelSegmentContentType(_url: string, contentType: string) {
      // Segments already arrive as video/MP2T and AES keys as octet-stream — pass the type through.
      return contentType || 'application/octet-stream';
    },
    classifyArtifact(url: string): ArtifactType {
      try {
        const p = new URL(url).pathname.toLowerCase();
        if (p.endsWith('.ts')) return 'segment';
        // master = /live/<slug>.m3u8 ; variant = /live/<slug>/<res>.m3u8
        if (p.endsWith('.m3u8')) return /\/live\/[^/]+\.m3u8$/.test(p) ? 'master' : 'variant';
        return 'other'; // AES .key, etc.
      } catch {
        return 'other';
      }
    },
  },

  // ── post-sync hook: tubi carries its own EPG (gracenote crosswalk THEN self-EPG) ─────────────────────
  // Runs after syncLive upserts/prunes the channel stores, off the SAME listing (`raw`) this sync fetched.
  // The dlhd/dami TWO-TIER pattern: a committed gracenote crosswalk claims the curated US linear channels
  // first (so a Tubi "CBS News" shares a STANDARD guide + cross-source-dedupes with the same channel from
  // other sources), then tubi's own inline-program self-EPG fills the remainder. Both are
  // FILL-ONLY-IF-UNTOUCHED (epg == null AND epgState == null), so a user link/unlink/remap always survives.
  async afterSync({ raw, live, sourceId }) {
    // (1) Gracenote crosswalk FIRST. Ported from FastChannels' exact tubi tmsid map (deterministic, not
    //     name-matched). Guarded (epgCrosswalk.ts skips rows whose (epg, tvg_id) isn't a real epgchannels
    //     doc — e.g. the user hasn't added the Gracenote source — and re-links them on a later sync). Runs
    //     live or offline (cheap, idempotent, file-driven); non-fatal so a guide failure never fails the sync.
    await applyEpgCrosswalk(sourceId, TUBI_EPG_ADDON_FILE).catch((err) =>
      logger.warn('seed', `[${sourceId}] EPG crosswalk failed (continuing): ${(err as Error).message}`),
    );

    // (2) Self-link the REMAINING untouched channels, FILL-ONLY-IF-UNTOUCHED. Every tubi channel's own guide
    //     is its content_id, so the 2-factor EPG link is exact: tvg_id = bare content_id, epg = the EPG source
    //     id ('tubi'). The filter requires epg == null AND epgState == null, so a crosswalked channel (step 1
    //     set epg/epgState) is skipped, and a user's deliberate remap (epg set) or unlink (epgState
    //     'unmatched') is preserved. content_id comes straight off the raw row. Runs live or offline.
    const ops = raw
      .filter((r) => r?.content_id != null)
      .map((r) => {
        const cid = String(r.content_id);
        return {
          updateOne: {
            filter: { _id: `${sourceId}:${cid}`, source: sourceId, epg: null, epgState: null },
            update: { $set: { tvg_id: cid, epg: sourceId, epgState: 'matched' as const } },
          },
        };
      });
    if (ops.length) await PlaylistChannel.bulkWrite(ops, { ordered: false });

    // (3) EPG write — only on a LIVE sync. An offline snapshot must not replace a good guide with stale
    //     programs; the standalone EPG "Sync" (syncEpgSource → syncTubiEpg) refreshes it live instead.
    if (!live) return;
    // Stamp the operator's UTC offset onto the guide programs (settings.offset; '+0000' when unset). No UI on
    // a playlist sync → log if it defaulted rather than toast. See settings/programOffset.ts.
    const { offset, defaulted } = await resolveProgramOffset();
    if (defaulted) logger.warn('epg', `${sourceId}: settings offset unset — guide times stored as UTC (+0000)`);
    const counts = await writeTubiEpg(raw, sourceId, offset);
    await upsertTubiEpgSource(sourceId, counts);
  },

  // ── snapshot-only slimming (rebuild:seed) ──────────────────────────────────────────
  // The LIVE catalog now carries per-program artwork (programs[].images) so writeTubiEpg can map Program.icon
  // (U2 — a richer XMLTV guide). That artwork is ~half the offline file's bytes, so strip it from the COMMITTED
  // snapshot only: an offline sync (snapshot fallback) simply yields icon=null, never a broken guide.
  snapshotTransform(raw: any[]): any[] {
    return raw.map((r) =>
      Array.isArray(r?.programs)
        ? { ...r, programs: r.programs.map(({ images, ...rest }: Record<string, unknown>) => rest) }
        : r,
    );
  },
};

export default tubiAdapter;
