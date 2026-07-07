// HDHomeRun stream adapter — a synthetic (proxy-only) source. Imported device channels carry
// origin:'hdhomerun' and live under each HDHomeRun import Playlist's id (adapters/hdhomerun/import.ts).
//
// NOTE (video engine teardown): HDHomeRun playback relied on an ffmpeg TS→HLS remux (remux.ts), which was
// REMOVED along with all ffmpeg usage. The adapter stays REGISTERED so imported HDHomeRun channels/catalog
// remain intact and manageable, but stream resolution now throws — HDHomeRun playback is dormant until a new
// playback engine is rebuilt. See restapi-sources/SKILL.md.

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

  // ── stream resolution: dormant (the ffmpeg remux was removed in the video-engine teardown) ──
  isEntryUrl() {
    return true; // every stored device-TS URL is treated as a channel entry
  },
  async resolveStream(): Promise<{ masterUrl: string }> {
    throw new Error('HDHomeRun playback removed — pending video engine rebuild');
  },

  // ── proxy behavior: dormant — nothing is proxied until playback is rebuilt. ──
  proxy: {
    upstreamHeaders() {
      return {};
    },
    isAllowedUpstream() {
      return false; // no upstream hops permitted while playback is torn down
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
