import { Schema, model } from 'mongoose';

// ProxyConfig (proxyconfigs) — the tunable knobs for the durable video data plane (the Rust sidecar), the
// successor to the removed `videoconfig` collection. It reuses that ancestor's proven two-tier keying:
//
//   _id = 'app'                → the (Default) config that applies to EVERY playlist.
//   _id = 'app_<playlistId>'   → a (Custom) per-playlist override (the owning playlist id === the channel's
//                                `source`, which the composed M3U already stamps as `?pl=` — see
//                                m3u/serialize.ts). A Custom doc FULLY overrides the Default for that playlist
//                                (doc-level fallback, mirroring the per-playlist singleton idiom of
//                                PlaylistAuth): the resolve seam reads `app_<pl>` and falls back to `app`.
//
// This is the Settings-singleton pattern applied to a family of docs: the internal<->external boundary lives
// in proxyconfig/translate.ts (envDefaults / toRuntimeProxyConfig / toExternalPatch — the ProxyConfig analogue
// of settings/translate.ts), the Default is seeded once at boot ($setOnInsert, proxyconfig/seed.ts), and the
// route (routes/proxyConfigs.ts) does GET/PUT upserts. The resolved config is delivered to the Rust data plane
// inside the resolve GRANT (proxy/resolveSeam.ts) — Rust never reads Mongo.
//
// P2 config surface (starts SMALL, grows per phase — see .claude/plans/durable-iptv-proxy.md):
//   · connectTimeoutMs   — upstream connect-handshake timeout. LIVE now (Rust builds its client with it).
//   · maxRedirects       — redirect-follow cap on upstream fetches. LIVE now (Rust client redirect policy).
//   · headerOverrides    — operator header overrides merged ON TOP of the adapter's upstreamHeaders. LIVE now
//                          (merged Node-side in the grant, so Rust needs no change).
//   · readTimeoutMs      — idle/read timeout. LIVE (P3.1/RSL — enforced per-stream in the streaming loop).
//   · bufferSizeKb       — bounded upstream→client buffer size. LIVE (P3.1/RSL — bounded mpsc read-ahead).
//   · outputFormat       — distribution shape: 'hls' (segmented) | 'ts' (continuous raw MPEG-TS on the ext
//                          mount). LIVE (P3.2/DST); enc/fMP4/unreachable falls back to HLS, observable as the
//                          `delivery` field on Active Streams.
//   · segmentCacheTtlSec — segment cache TTL. RESERVED — the ONE knob still shipped but not yet applied.
// The reserved knob is stored + surfaced + shipped in the grant but not yet applied — an explicit `null`
// default marks a not-yet-wired numeric knob (the repo convention).

export interface ProxyConfigDoc {
  _id: string; // 'app' (Default) or 'app_<playlistId>' (Custom per-playlist override)
  connectTimeoutMs: number; // upstream connect-handshake timeout (ms). LIVE in P2.
  readTimeoutMs: number | null; // idle/read timeout (ms); null = none. LIVE (P3.1/RSL).
  bufferSizeKb: number | null; // bounded upstream→client buffer (KiB); null = unbounded. LIVE (P3.1/RSL).
  maxRedirects: number; // upstream redirect-follow cap. LIVE in P2.
  headerOverrides: Record<string, string>; // operator upstream-header overrides; merged into the grant. LIVE in P2.
  outputFormat: string; // distribution shape 'hls' (segmented) | 'ts' (continuous raw MPEG-TS, ext mount). LIVE (P3.2/DST); enc/fMP4→HLS.
  segmentCacheTtlSec: number | null; // segment cache TTL (s); null = no-store (today's behavior). RESERVED (only unapplied knob).
}

export const PROXY_CONFIG_DEFAULT_ID = 'app'; // the (Default) singleton row id
export const CUSTOM_PROXY_CONFIG_PREFIX = 'app_'; // per-playlist Custom rows: `app_<playlistId>`

const ProxyConfigSchema = new Schema<ProxyConfigDoc>(
  {
    _id: { type: String, required: true },
    connectTimeoutMs: { type: Number, required: true, default: 15000 },
    readTimeoutMs: { type: Number, default: null },
    bufferSizeKb: { type: Number, default: null },
    maxRedirects: { type: Number, required: true, default: 10 },
    headerOverrides: { type: Schema.Types.Mixed, default: {} },
    outputFormat: { type: String, required: true, default: 'hls' },
    segmentCacheTtlSec: { type: Number, default: null },
  },
  { versionKey: false },
);

export const ProxyConfig = model<ProxyConfigDoc>('ProxyConfig', ProxyConfigSchema);
