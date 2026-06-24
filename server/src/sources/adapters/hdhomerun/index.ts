// HDHomeRun stream adapter — remuxes a local tuner's raw MPEG-TS into browser-playable HLS so the in-app
// player, the B-Roll slate, ffprobe, and live telemetry all work through the EXISTING composer with zero
// core changes. Channels imported from a device carry origin:'hdhomerun', so their derived proxy URL is
// /api/v1/hdhomerun/<enc device-TS-url> and this adapter binds that route.
//
// The trick (see remux.ts): the device TS URL is treated as an ENTRY (isEntryUrl → true) → the composer
// calls resolveStream, which starts/locates a per-channel ffmpeg remux and returns a 127.0.0.1 loopback HLS
// master. The composer then mirrors that loopback playlist exactly as it mirrors any upstream variant; the
// rewritten seg<N>.ts child URIs come back as direct hops, which the SSRF gate allows ONLY for the loopback
// origin (ffmpeg — not the proxy — reaches the private device IP, so this gate never needs to allow LAN
// hosts). `synthetic`: proxy-only, no catalog → boot init skips its shell row and the manifest omits it; its
// channels live under each HDHomeRun import Playlist's id (adapters/hdhomerun/import.ts). See restapi-sources/SKILL.md.

import type { SourceAdapter, ArtifactType } from '../../types.js';
import { ensureMaster, isLoopbackRemuxUrl } from './remux.js';

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

  // ── stream resolution ──
  isEntryUrl(url: string) {
    // The device TS URL (the stored streamEntryUrl) is the channel ENTRY → route it through the B-Roll
    // composer + remux. The composer's rewritten children are loopback seg<N>.ts URLs — NOT entries, so they
    // fall through to the direct hop (and the SSRF gate). Everything that isn't our loopback is an entry.
    return !isLoopbackRemuxUrl(url);
  },
  async resolveStream(entryUrl: string) {
    // entryUrl = the device TS URL. ensureMaster starts/finds its ffmpeg remux and returns the loopback
    // HLS master the composer then fetches + mirrors. Throws (→ retry + B-Roll card) on tuner-cap / failure.
    return ensureMaster(entryUrl);
  },

  // ── proxy behavior: the tightest possible gate — ONLY the loopback remux origin. ──
  proxy: {
    upstreamHeaders() {
      return {}; // loopback needs no headers; ffmpeg fetches the device with its own UA
    },
    isAllowedUpstream(url: string) {
      // The ONLY direct hops for this source are the loopback segment URLs. The device's private LAN IP is
      // reached by ffmpeg (the entry path skips this gate), so — unlike `direct` — we never allow LAN hosts
      // here. This is the opposite of dlhd's private-IP block and far tighter than `direct`'s any-http(s).
      return isLoopbackRemuxUrl(url);
    },
    onPlaylistChildHost: null, // loopback URLs are deterministic — nothing to learn at runtime
    relabelSegmentContentType(_url: string, contentType: string) {
      return contentType || 'video/mp2t'; // the loopback server already labels segments video/mp2t
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
