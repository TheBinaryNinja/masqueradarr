// `direct` — the generic passthrough adapter for IMPORTED playlists. It is the long-anticipated "common /
// direct-URL" source the SourceAdapter contract already describes (types.ts: isEntryUrl false, resolveStream
// identity, isAllowedUpstream allows any http(s) host — private IPs included, so LAN sources work). An
// imported .m3u line carries a real upstream stream URL,
// so there is nothing to resolve: the stored streamEntryUrl IS the master. Imported channels set
// origin:'direct' so proxyPath()/channelToExtinf route them through THIS adapter's proxy (/api/v1/direct/…),
// keeping the SSRF gate, upstream headers, and child-URL rewriting centralized — the raw upstream is never
// emitted.
//
// It is `synthetic`: a proxy-only pseudo-source with no catalog. It is NOT a syncable (Default) playlist —
// boot init skips its shell row and the manifest omits it (see seed.ts / routes/sources.ts). Its channels
// live under each import Playlist's own id (routes/import.ts), not under 'direct'. listChannels/normalize
// exist only to satisfy the contract and are inert.

import type { SourceAdapter, ArtifactType } from '../types.js';

const directAdapter: SourceAdapter = {
  id: 'direct',
  label: 'Imported',
  synthetic: true, // proxy-only — no shell row, not in the manifest

  // ── listings: inert. `direct` has no catalog; channels are created by the import route, not a sync. ──
  async listChannels() {
    return { raw: [], meta: { live: false } };
  },
  normalize() {
    return null;
  },

  // Never surfaced (synthetic → omitted from the manifest), but the contract requires it.
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // ── stream resolution: an .m3u8 entry composes (B-Roll/telemetry/ffprobe); resolveStream is identity. ──
  isEntryUrl(url: string) {
    // An imported HLS playlist (.m3u8) is the channel ENTRY → route it through serveComposedMedia so it gets
    // the B-Roll slate + viewer telemetry + ffprobe (like dulo/dlhd). Its rewritten children are segments/keys
    // (.ts/.key) — never .m3u8 through the proxy, since the composer resolves master→variant server-side — so
    // they fall through to the direct hop. Non-HLS imports (raw .ts/.mp4) stay direct-hop (no compose).
    try {
      return new URL(url).pathname.toLowerCase().endsWith('.m3u8');
    } catch {
      return false;
    }
  },
  async resolveStream(entryUrl: string) {
    return { masterUrl: entryUrl }; // identity — the (decoded) entry is already the playable master URL
  },

  // ── proxy behavior: a permissive-but-SSRF-safe passthrough. ──
  proxy: {
    upstreamHeaders() {
      return {}; // imported streams are public URLs; no Referer/Origin/UA handshake (v1)
    },
    isAllowedUpstream(url: string) {
      // Allow ANY http(s) host, INCLUDING private/loopback/link-local literals. Imported playlists are an
      // admin-curated, self-hosted feature: a user's .m3u commonly points at LAN devices (an HDHomeRun tuner,
      // a local Channels/Plex/xTeVe server, another box on 192.168/10.x), so the proxy must reach them. The
      // only gate left is the protocol — the private-IP SSRF guard is deliberately NOT applied here. (The
      // dlhd/dulo adapters, which proxy untrusted scraped/learned hosts, keep their own private-IP block.)
      try {
        const u = new URL(url);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        return false;
      }
    },
    onPlaylistChildHost: null, // host-class gate (not an allowlist) — nothing to learn at runtime
    relabelSegmentContentType(_url: string, contentType: string) {
      return contentType || 'application/octet-stream'; // trust the upstream type (no disguised segments)
    },
    classifyArtifact(url: string): ArtifactType {
      try {
        const p = new URL(url).pathname.toLowerCase();
        if (/\.(ts|aac|mp4|m4s)$/.test(p)) return 'segment';
        if (p.endsWith('.m3u8')) return 'master'; // arbitrary imports: master vs variant isn't distinguishable
        return 'other';
      } catch {
        return 'other';
      }
    },
  },
};

export default directAdapter;
