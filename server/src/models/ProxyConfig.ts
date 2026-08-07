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
//   · streamInfRedux     — SIR: opt-in, non-destructive reorder of the HLS MASTER (ext mount only) so the first
//                          #EXT-X-STREAM-INF lands within a strict player's manifest probe window (e.g. VLC's
//                          ~8 KiB peek). LIVE; off = today's byte-identical output. See proxy/src/manifest.rs.
//   · failoverEnabled    — play-time failover groups: on an establish failure the data plane walks the
//                          channel's ordered failover children (attempt=1,2,… against /api/internal/resolve).
//                          Default ON — configuring a group is the real opt-in; ungrouped channels behave as
//                          before either way. LIVE (see proxy/resolveSeam.ts + proxy/src/proxy.rs).
//   · failoverOnDefiniteError — also treat a DEFINITIVE upstream non-2xx (4xx/5xx, normally forwarded
//                          verbatim) as a failover trigger. Default OFF — it changes long-standing
//                          forward-verbatim semantics, so the operator opts in. LIVE.
//   · segmentCacheTtlSec — segment cache TTL. RESERVED — the ONE knob still shipped but not yet applied.
// The reserved knob is stored + surfaced + shipped in the grant but not yet applied — an explicit `null`
// default marks a not-yet-wired numeric knob (the repo convention).

export interface ProxyConfigDoc {
  _id: string; // 'app' (Default) or 'app_<playlistId>' (Custom per-playlist override)
  connectTimeoutMs: number; // upstream connect-handshake timeout (ms). LIVE in P2.
  readTimeoutMs: number | null; // idle/read timeout (ms); null = none. LIVE (P3.1/RSL).
  bufferSizeKb: number | null; // bounded upstream→client read-ahead buffer (KiB); null = minimal pipeline. LIVE (P3.1/RSL).
  maxRedirects: number; // upstream redirect-follow cap. LIVE in P2.
  headerOverrides: Record<string, string>; // operator upstream-header overrides; merged into the grant. LIVE in P2.
  outputFormat: string; // distribution shape 'hls' (segmented) | 'ts' (continuous raw MPEG-TS, ext mount). LIVE (P3.2/DST); enc/fMP4→HLS.
  streamInfRedux: boolean; // SIR: opt-in HLS master reorder (ext mount) so the first #EXT-X-STREAM-INF fits a strict player's manifest probe window. LIVE; off = today's output.
  failoverEnabled: boolean; // play-time failover groups: walk the ordered children on an establish failure. Default ON (group config is the opt-in). LIVE.
  failoverOnDefiniteError: boolean; // also fail over on a definitive upstream 4xx/5xx (normally forwarded verbatim). Default OFF. LIVE.
  segmentCacheTtlSec: number | null; // segment cache TTL (s); null = no-store (today's behavior). RESERVED (only unapplied knob).
  // S3/ORIGIN — serve from a LOCAL ORIGIN instead of proxying the upstream manifest: one refcounted ingest per
  // channel decrypts + rings segments, and the client gets a masqueradarr-authored stream (our sequence, our
  // paths, no keys, no vendor tags). Default OFF = today's behavior byte-for-byte.
  originEnabled: boolean; // S3 Phase 1: INGEST only (fills the ring; output still the proxy path). Phase 2 adds the renderers.
  originRingMb: number; // per-channel ring cap (MiB). A 3-segment floor still wins over it — the data plane logs an `iop` warn when it does.
  // S3/ORIGIN: republish every ingested segment onto ONE timeline with canonical pids, so an upstream that
  // moves its video pid between ads (pluto: 258 → 256 → 258 in a single pod) cannot make a demuxer register
  // a second stream and stop rendering the first. A KILL SWITCH, not an opt-in: default ON, because the
  // un-normalised alternative is the bug it fixes and `originEnabled` is already the opt-in above it.
  spliceNormalize: boolean;
}

export const PROXY_CONFIG_DEFAULT_ID = 'app'; // the (Default) singleton row id
export const CUSTOM_PROXY_CONFIG_PREFIX = 'app_'; // per-playlist Custom rows: `app_<playlistId>`

const ProxyConfigSchema = new Schema<ProxyConfigDoc>(
  {
    _id: { type: String, required: true },
    connectTimeoutMs: { type: Number, required: true, default: 15000 },
    readTimeoutMs: { type: Number, default: null },
    bufferSizeKb: { type: Number, default: 1024 }, // envDefaults() is the operative seed; kept in sync here
    maxRedirects: { type: Number, required: true, default: 10 },
    headerOverrides: { type: Schema.Types.Mixed, default: {} },
    outputFormat: { type: String, required: true, default: 'hls' },
    streamInfRedux: { type: Boolean, required: true, default: false },
    failoverEnabled: { type: Boolean, required: true, default: true },
    failoverOnDefiniteError: { type: Boolean, required: true, default: false },
    segmentCacheTtlSec: { type: Number, default: null },
    originEnabled: { type: Boolean, required: true, default: false },
    originRingMb: { type: Number, required: true, default: 25 }, // envDefaults() is the operative seed
    spliceNormalize: { type: Boolean, required: true, default: true },
  },
  { versionKey: false },
);

export const ProxyConfig = model<ProxyConfigDoc>('ProxyConfig', ProxyConfigSchema);
