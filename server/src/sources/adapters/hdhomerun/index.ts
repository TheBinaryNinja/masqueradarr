// HDHomeRun stream adapter — a synthetic (proxy-only) source. Imported device channels carry
// origin:'hdhomerun' and live under each HDHomeRun import Playlist's id (adapters/hdhomerun/import.ts).
//
// Playback is a LAN passthrough (the same posture as `direct`): a real HDHomeRun device serves continuous
// MPEG-TS at a raw URL (e.g. http://192.168.x.x:5004/auto/vN), so the stored streamEntryUrl IS the master —
// there is nothing to remux (the old ffmpeg TS→HLS remux is gone and unneeded). resolveStream is identity,
// isEntryUrl flags only an .m3u8 device URL for per-play resolution, and the proxy allows any http(s) host
// INCLUDING private/LAN literals. `allowsPrivateUpstream` lets the resolve seam permit private hops in Rust.

import type { SourceAdapter, ArtifactType } from '../../types.js';

const hdhomerunAdapter: SourceAdapter = {
  id: 'hdhomerun',
  label: 'HDHomeRun',
  synthetic: true, // proxy-only — no shell row, omitted from the manifest

  // ── listings: inert. Channels are synced per-device by import.ts, not a generic catalog. ──
  async listChannels() {
    return { raw: [], meta: { live: false } };
  },
  normalize() {
    return null;
  },

  // Never surfaced (synthetic → omitted from the manifest), but the contract requires it.
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // LAN upstreams (device on 192.168/10.x): allow private hops in Rust's SSRF gate for this source.
  allowsPrivateUpstream: true,

  // ── stream resolution: LAN passthrough. Raw-TS device URLs stream verbatim (isEntryUrl false → no
  //    resolution); a rare .m3u8 device URL is the entry, resolved per play as identity. ──
  isEntryUrl(url: string) {
    try {
      return new URL(url).pathname.toLowerCase().endsWith('.m3u8');
    } catch {
      return false;
    }
  },
  async resolveStream(entryUrl: string): Promise<{ masterUrl: string }> {
    return { masterUrl: entryUrl }; // identity — the device URL is already the playable stream
  },

  // ── proxy behavior: permissive-but-SSRF-safe passthrough (private LAN literals allowed). ──
  proxy: {
    upstreamHeaders() {
      return {};
    },
    isAllowedUpstream(url: string) {
      // Allow ANY http(s) host, INCLUDING private/loopback/link-local literals — a HDHomeRun tuner lives on
      // the LAN. Only the protocol is gated; the private-IP block is intentionally not applied (mirrors
      // `direct`). The arbitrary-URL SSRF is closed upstream: the resolve seam gates the ENTRY against a stored
      // channel's streamEntryUrl, so only imported device URLs reach here; allowsPrivateUpstream then lets Rust
      // permit their private child hops.
      try {
        const u = new URL(url);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        return false;
      }
    },
    onPlaylistChildHost: null,
    relabelSegmentContentType(_url: string, contentType: string) {
      return contentType || 'video/mp2t';
    },
    classifyArtifact(url: string): ArtifactType {
      try {
        const p = new URL(url).pathname.toLowerCase();
        if (/\.ts$/.test(p)) return 'segment';
        if (p.endsWith('.m3u8')) return 'variant';
        return 'other';
      } catch {
        return 'other';
      }
    },
  },
};

export default hdhomerunAdapter;
