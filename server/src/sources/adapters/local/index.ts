// Local Now stream adapter — resolves a channel's opaque `localnow://<id>?slug=<slug>` sentinel to a fresh
// signed CDN master per play, so the in-app player, the B-Roll slate, ffprobe, and live telemetry all work
// through the EXISTING composer with zero core changes. Channels imported from a market carry origin:'local'
// (sources/adapters/local/import.ts), so their derived proxy URL is /api/v1/local/<enc localnow://…> and this
// adapter binds that route.
//
// Like dlhd/distro (and UNLIKE hdhomerun's loopback-only remux), the resolved master lives on a ROTATING CDN
// we can't predict, so resolveStream pre-allows the resolved host and the proxy's onPlaylistChildHost learns
// the variant/segment hosts seen inside the resolved playlist (the createDynamicAllow pattern; private/
// loopback targets always blocked). `synthetic`: proxy-only, no catalog → boot init skips its shell row and
// the manifest omits it (so it never appears in the Add Playlist Built-In list); its channels live under each
// Local Now playlist's id. See restapi-sources/SKILL.md + .claude/docs/localnow-datasource.md.

import type { SourceAdapter, ArtifactType } from '../../types.js';
import { createDynamicAllow } from '../_fast/dynamicAllow.js';
import { resolvePlayback, LOCAL_CDN_SUFFIXES, LOCAL_STREAM_HEADERS } from './api.js';

// Per-source SSRF allow-set seeded with the Local Now / DSP suffixes; grown at play time (resolveStream
// pre-allows the resolved master host, onPlaylistChildHost learns variant/segment hosts).
const allow = createDynamicAllow(LOCAL_CDN_SUFFIXES);

const SENTINEL = 'localnow://';

// "localnow://<id>?slug=<slug>" → { id, slug }. URLSearchParams decodes the (encodeURIComponent'd) slug once.
function parseSentinel(entryUrl: string): { id: string; slug: string | null } {
  const rest = entryUrl.slice(SENTINEL.length);
  const qi = rest.indexOf('?');
  if (qi < 0) return { id: rest, slug: null };
  return { id: rest.slice(0, qi), slug: new URLSearchParams(rest.slice(qi + 1)).get('slug') };
}

const localAdapter: SourceAdapter = {
  id: 'local',
  label: 'Local Now',
  synthetic: true, // proxy-only — no shell row, omitted from the manifest / Built-In list

  // ── listings: inert. Channels are synced per-market by import.ts, not a generic catalog. ──
  async listChannels() {
    return { raw: [], meta: { live: false } };
  },
  normalize() {
    return null;
  },

  // Never surfaced (synthetic → omitted from the manifest), but the contract requires it.
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // ── stream resolution ──
  isEntryUrl(url: string) {
    return typeof url === 'string' && url.startsWith(SENTINEL);
  },
  async resolveStream(entryUrl: string) {
    const { id, slug } = parseSentinel(entryUrl);
    const { masterUrl } = await resolvePlayback(id, slug);
    try {
      allow.allow(new URL(masterUrl).hostname); // pre-allow the resolved master host (the proxy gate runs on the children)
    } catch {
      /* ignore malformed */
    }
    return { masterUrl };
  },

  // ── proxy behavior: Origin-gated CDN, dynamic allow-set, normal HLS segments ──
  proxy: {
    upstreamHeaders() {
      return { ...LOCAL_STREAM_HEADERS }; // browser UA + localnow.com Origin/Referer (the CDN is Origin-gated)
    },
    isAllowedUpstream: (url: string) => allow.isAllowedUpstream(url),
    onPlaylistChildHost: (host: string) => allow.onPlaylistChildHost(host),
    relabelSegmentContentType(_url: string, contentType: string) {
      return contentType || 'video/mp2t'; // standard HLS — trust the CDN's content-type, default to TS
    },
    classifyArtifact(url: string): ArtifactType {
      if (typeof url === 'string' && url.startsWith(SENTINEL)) return 'master';
      try {
        const p = new URL(url).pathname.toLowerCase();
        if (p.endsWith('.m3u8')) return 'variant';
        if (/\.(ts|aac|m4s|mp4)$/.test(p)) return 'segment';
        return 'other';
      } catch {
        return 'other';
      }
    },
  },
};

export default localAdapter;
