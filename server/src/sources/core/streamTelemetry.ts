// Per-channel + per-client live stream telemetry — the in-memory authority for Active Streams, viewer
// connections, and bandwidth. Pure in-memory (like metrics.ts / streamState.ts / streamProbe.ts): it
// resets on restart, never throws to the proxy, and never touches the byte pipe.
//
// HLS has no long-lived per-viewer connection (the way Dispatcharr's MPEG-TS proxy does), so a viewer is
// recognised by RECENCY: a connection — keyed by ip|user-agent|username|channel — is "active" if it has
// polled that channel's composed entry playlist within CLIENT_TTL_MS. Keying per channel means one client
// watching two channels at once (picture-in-picture / multi-view) counts as two connections, not one that
// flips between them. The entry-poll IS the heartbeat — the proxy calls noteViewer() on every poll
// (upserting that client's per-channel connection), and proxyHandler calls noteBytes() after each
// segment/playlist send (attributing egress to the channel the client polled most recently — a direct-hop
// segment carries no channel id, but the same ip|ua polled an entry moments earlier). A
// periodic tick() computes rolling rates, observes streamState phase transitions as buffering events, and
// sweeps stale clients — emitting a closed ViewSession to the injected persistence sink. Channel id
// resolution + DB persistence live in the route/stats layer (the onSessionClose seam), so this core stays
// source-agnostic and DB-free.

import { streamKey, phaseFor, type StreamPhase } from './streamState.js';

// How long after a client's last request we still count it as watching. The entry playlist reloads on the
// HLS target-duration cadence (typically ~2–6s), so 30s tolerates several missed polls — the Masqueradarr
// analog of Dispatcharr's 60s client TTL (its heartbeat thread refreshed a Redis TTL; here the client's
// own HLS reload refreshes lastSeen).
const CLIENT_TTL_MS = 30_000;
// Rolling-rate + sweep cadence.
const TICK_MS = 2_000;
// Window the per-client rate over several HLS segments rather than a single tick. A client pulls a whole
// segment (~6s of video) as one burst then idles, so a 2s instantaneous delta swings between a spike (a
// full segment landed) and 0 (the client was idle). Averaging over ~15s (2–3 segments) yields the true
// sustained throughput — the meaningful "bitrate"/"bandwidth" figure.
const RATE_WINDOW_MS = 15_000;
// Idle backstop for raw-TS socket-bound clients (externalTsEngine.ts). Unlike HLS poll clients (reaped by
// the 30s recency TTL), a held-open TS socket is reaped PRIMARILY on socket-close (noteSocketViewerClose);
// this longer no-byte backstop only fires for a half-open socket whose close never arrives — the confirmed
// Dispatcharr 60s client TTL. `lastSeen` is refreshed on every byte write, so a steadily-streaming socket
// never hits it.
const SOCKET_IDLE_MS = 60_000;
// Client-side buffering inference (BUF): a viewer whose SMOOTHED download rate (currentRate) sustains below
// this fraction of the channel's DECLARED bitrate can't keep up → a client-experienced rebuffer. Conservative
// (a live HLS client pulls ≈ the bitrate; a real shortfall drops well under) with a debounce to ignore a
// single slow segment. Skipped entirely when the channel declares no bandwidth (media-playlist-only upstream).
const CLIENT_SHORTFALL_RATIO = 0.85;
const CLIENT_BUFFER_MIN_MS = 6_000; // shortfall must persist at least this long before it counts as buffering

export interface BufferEvent {
  at: number; // ms epoch when the buffering interval began
  phase: 'buffer' | 'failed';
  ms: number; // duration of the interval (filled in when it clears; 0 while open)
  // Which edge the interval was observed on: 'upstream' = phase-derived (the Rust data plane's upstream
  // outcome, streamState); 'client' = Node edge-inferred (this viewer's download rate fell below the declared
  // bitrate). Both count toward bufferCount/rebufferMs/QoE; History renders them as two series.
  side: 'upstream' | 'client';
}

// Which player produced a stream session: the in-app slide-out HLS player (appPlayer, the /api/v1 mount) or a
// third-party IPTV client app — TiviMate/Kodi/VLC/… (externalPlayer, the /api/ext mount served by the Rust
// proxy). The proxy derives it from the request mount and threads it here so Active
// Streams / History can classify every viewer + session.
export type PlayerType = 'appPlayer' | 'externalPlayer';

interface ClientConn {
  clientKey: string;
  ip: string;
  userAgent: string;
  username?: string;
  playerType: PlayerType;
  source: string;
  entryUrl: string;
  channelKey: string; // = streamKey(source, entryUrl) — the channel this connection is bound to (fixed for its lifetime)
  connectedAt: number;
  lastSeen: number;
  bytes: number; // cumulative egress attributed to this client
  rateSamples: { t: number; bytes: number }[]; // (timestamp, cumulative bytes) ring over RATE_WINDOW_MS
  currentRate: number; // smoothed bytes/sec over the rate window (see RATE_WINDOW_MS)
  segments: number;
  bufferEvents: BufferEvent[];
  bufferCount: number;
  rebufferMs: number;
  // Open-interval pointers so a two-sided close fills the RIGHT event (not a fragile "last with ms 0"):
  upstreamOpen: BufferEvent | null; // the client's currently-open UPSTREAM interval (set while its channel buffers)
  clientOpen: BufferEvent | null; // the client's currently-open CLIENT-side interval (its own rate shortfall)
  clientShortfallSince: number | null; // when the current sustained-shortfall streak began (client-side debounce)
  // True for a raw-TS socket-bound client (externalTsEngine.ts): its lifetime is bound to the held-open HTTP
  // socket, not to poll recency. tick() exempts it from the 30s recency sweep — it is reaped on socket-close
  // (noteSocketViewerClose) with a 60s no-byte backstop (SOCKET_IDLE_MS). Undefined ⇒ a normal HLS poll client.
  socketBound?: boolean;
}

interface ChannelAgg {
  source: string;
  entryUrl: string;
  firstSeen: number;
  peakViewers: number;
  lastPhase: StreamPhase;
  bufferingSince: number | null; // start of the current buffer/failed interval (null = not buffering)
}

const clients = new Map<string, ClientConn>(); // clientKey → connection
const channels = new Map<string, ChannelAgg>(); // channelKey → aggregate

// ── Injection seams (the route/stats layer wires these; the core stays DB-free) ──────────────────────

/** A viewer watch-session that has just ended (client went stale past the TTL) — ready to persist. */
export interface ClosedSession {
  source: string;
  entryUrl: string;
  channelKey: string;
  ip: string;
  userAgent: string;
  username?: string;
  playerType: PlayerType;
  connectedAt: number;
  endedAt: number;
  durationMs: number;
  bytesTotal: number;
  segments: number;
  bufferEvents: BufferEvent[];
  bufferCount: number;
  rebufferMs: number;
}

type SessionCloseCb = (s: ClosedSession) => void;
type BufferEventCb = (
  channelKey: string,
  source: string,
  entryUrl: string,
  phase: 'buffer' | 'failed',
  at: number,
  side: 'upstream' | 'client',
) => void;

const sessionCloseCbs: SessionCloseCb[] = [];
const bufferEventCbs: BufferEventCb[] = [];

/** Subscribe to closed viewer sessions (the persistence layer writes a ViewSession row). */
export function onSessionClose(cb: SessionCloseCb): void {
  sessionCloseCbs.push(cb);
}
/** Subscribe to the start of a buffering interval on a channel (the stats hub pushes a live event). */
export function onBufferEvent(cb: BufferEventCb): void {
  bufferEventCbs.push(cb);
}

// ── Hooks called from the proxy (hot path — cheap, never throw) ──────────────────────────────────────

// The bare client identity (ip|ua|username). Byte attribution keys off this: a direct-hop segment request
// carries the identity but no channel id, so noteBytes resolves the channel via the side-map below.
function identityKeyOf(ip: string, ua: string, username?: string): string {
  return `${ip}|${ua}|${username || ''}`;
}

// The full connection key: identity + channel. Keying per channel makes two concurrent streams from the
// same client (e.g. a picture-in-picture / multi-view IPTV client watching two channels at once) two
// distinct ClientConns instead of one connection that ping-pongs between them — so each channel keeps its
// own viewer count and its own Active Streams row.
function clientKeyOf(ip: string, ua: string, username: string | undefined, channelKey: string): string {
  return `${identityKeyOf(ip, ua, username)}|${channelKey}`;
}

// identity (ip|ua|username) → the channelKey it most recently polled. noteViewer records it on every
// heartbeat; noteBytes reads it to attribute egress (a segment request has no channel id of its own). For
// a multi-view client this flips between its channels as their polls interleave, so per-channel bandwidth
// for such a client is an accepted approximation — viewer counts and the per-channel rows stay exact.
// Bounded by the (small) set of distinct client identities; entries are overwritten on re-poll and need no
// sweep — a stale entry just resolves to an already-swept connection and is ignored by noteBytes.
const lastChannelByIdentity = new Map<string, string>();

/**
 * Heartbeat + presence + per-channel connection — called on every composed entry-playlist poll. Upserts
 * the connection for this (client, channel) pair and refreshes lastSeen. This is what makes a viewer
 * "active". A client polling two channels at once upserts two connections (no rebinding between them).
 */
export function noteViewer(
  source: string,
  entryUrl: string,
  ip: string,
  ua: string,
  username?: string,
  playerType: PlayerType = 'appPlayer',
): void {
  const now = Date.now();
  const channelKey = streamKey(source, entryUrl);
  const key = clientKeyOf(ip, ua, username, channelKey);
  lastChannelByIdentity.set(identityKeyOf(ip, ua, username), channelKey);
  let c = clients.get(key);
  if (!c) {
    c = {
      clientKey: key,
      ip,
      userAgent: ua,
      username,
      playerType,
      source,
      entryUrl,
      channelKey,
      connectedAt: now,
      lastSeen: now,
      bytes: 0,
      rateSamples: [{ t: now, bytes: 0 }],
      currentRate: 0,
      segments: 0,
      bufferEvents: [],
      bufferCount: 0,
      rebufferMs: 0,
      upstreamOpen: null,
      clientOpen: null,
      clientShortfallSince: null,
    };
    clients.set(key, c);
  } else {
    // A client's mount (in-app /api/v1 vs external /api/ext) is fixed for a session, but refresh defensively
    // so a re-poll that carries a definite playerType keeps the connection's label current.
    c.playerType = playerType;
  }
  // No channel-switch branch: the key is per-channel, so a poll for a different channel upserts its own
  // connection above rather than rebinding this one. A genuine A→B switch leaves A's connection
  // unrefreshed; tick() sweeps it after CLIENT_TTL_MS and closes its session — the same recency model as a
  // viewer simply leaving.
  c.lastSeen = now;

  let ch = channels.get(channelKey);
  if (!ch) {
    ch = { source, entryUrl, firstSeen: now, peakViewers: 0, lastPhase: phaseFor(channelKey).phase, bufferingSince: null };
    channels.set(channelKey, ch);
  }
}

/**
 * Attribute egress bytes to the channel the client most recently polled — called after a segment/playlist
 * send. Bytes ride the entry-poll binding (a direct-hop segment URL has no channel identity of its own).
 */
export function noteBytes(ip: string, ua: string, bytes: number, username?: string): void {
  // A segment/playlist request carries the client identity but no channel id, so resolve the channel via
  // the identity's most-recently-polled entry (recorded by noteViewer). For a multi-view client this
  // attributes the bytes to whichever of its channels it polled last — an accepted approximation.
  const channelKey = lastChannelByIdentity.get(identityKeyOf(ip, ua, username));
  if (!channelKey) return; // bytes from a client that never polled an entry URL — ignore (defensive)
  const c = clients.get(clientKeyOf(ip, ua, username, channelKey));
  if (!c) return; // its per-channel connection was already swept — ignore (defensive)
  c.bytes += bytes;
  c.segments += 1;
  c.lastSeen = Date.now();
}

// ── Manifest-declared decode metadata (DEC) ────────────────────────────────────────────────────────────
// The Rust data plane parses each proxied manifest for its declared decode metadata (master
// #EXT-X-STREAM-INF resolution/codecs/frame-rate; media-playlist container hint) — parsed from the manifest,
// not an external probe — the successor to the removed streamProbe monitor. A master poll and a variant/media poll are SEPARATE fetches,
// each carrying only what it declares, so we MERGE per channel (non-null overwrite): the master fills
// resolution/codecs/frame-rate, the variant fills the container. statsHub reads + humanizes this for the
// Active Streams "Technical // Decode" card. Bounded by distinct channels + in-memory like streamState.states
// (no sweep; resets on restart).

export interface MediaInfo {
  resolution: string | null; // raw "1920x1080" (humanized to "1080p" by statsHub)
  codecs: string | null; // raw HLS CODECS list e.g. "avc1.640028,mp4a.40.2" (split + humanized by statsHub)
  frameRate: string | null; // raw "60" / "29.970"
  container: string | null; // 'fmp4' | 'ts'
  bandwidth: number | null; // declared BANDWIDTH (bits/sec) — the client-side buffering reference (BUF)
}

const mediaByChannel = new Map<string, MediaInfo>(); // channelKey → merged decode metadata

/** Merge manifest-declared decode metadata for a channel (only the non-null fields of this poll overwrite). */
export function noteMedia(source: string, entryUrl: string, m: MediaInfo): void {
  const key = streamKey(source, entryUrl);
  const cur = mediaByChannel.get(key);
  if (!cur) {
    mediaByChannel.set(key, { ...m });
    return;
  }
  if (m.resolution !== null) cur.resolution = m.resolution;
  if (m.codecs !== null) cur.codecs = m.codecs;
  if (m.frameRate !== null) cur.frameRate = m.frameRate;
  if (m.container !== null) cur.container = m.container;
  if (m.bandwidth !== null) cur.bandwidth = m.bandwidth;
}

/** The merged decode metadata for a channel (null until its first manifest declares anything). */
export function mediaFor(channelKey: string): MediaInfo | null {
  return mediaByChannel.get(channelKey) ?? null;
}

// ── Failover attribution ───────────────────────────────────────────────────────────────────────────────
// When play-time failover serves a CHILD under its parent's stream identity, every telemetry event still
// keys on (parent source, parent entry) — so without this note Active Streams would show the parent as
// live with no hint a backup is carrying it. The resolve seam records the serving candidate at grant-build
// time: attempt >= 1 sets it, a successful attempt-0 (parent) resolve clears it. Same in-memory idiom as
// mediaByChannel; statsHub prunes entries for channels that go cold.

export interface FailoverServing {
  attempt: number; // 1-based candidate attempt (1 = first child)
  candidateId: string; // the serving child's PlaylistChannel id
  candidateName: string; // the serving child's tvg_name (display)
}

const failoverByChannel = new Map<string, FailoverServing>(); // channelKey → serving candidate

/** Record (or clear, with null) which failover candidate a channel's grants currently target. */
export function noteFailoverServing(source: string, entryUrl: string, f: FailoverServing | null): void {
  const key = streamKey(source, entryUrl);
  if (f) failoverByChannel.set(key, f);
  else failoverByChannel.delete(key);
}

/** The serving failover candidate for a channel (null = the parent itself / not a failover stream). */
export function failoverFor(channelKey: string): FailoverServing | null {
  return failoverByChannel.get(channelKey) ?? null;
}

/** Drop failover attribution for channels no longer active (statsHub calls this with the live key set). */
export function pruneFailoverServing(activeKeys: Set<string>): void {
  for (const key of failoverByChannel.keys()) if (!activeKeys.has(key)) failoverByChannel.delete(key);
}

// ── S3/ORIGIN ingest health (the `iop` side) ───────────────────────────────────────────────────────────
// Everything else in this file measures EGRESS — bytes we sent to a viewer. Origin mode adds a second,
// independent quantity: what ONE ingest pulled from upstream on behalf of N viewers. Conflating them would
// over-count upstream bandwidth by a factor of N and make a Side-1 problem indistinguishable from a Side-2
// one, so ingest lands here in its own map and NEVER touches noteBytes. Same in-memory idiom as
// mediaByChannel/failoverByChannel; statsHub prunes cold channels.

export interface IngestHealth {
  status: string; // 'ok' | 'stalled' | 'resolve_failed' | 'closed' — the ingest's last reported state
  subscribers: number; // live leases (viewers sharing this one ingest)
  ringSegments: number;
  ringBytes: number;
  headSeq: number; // our next sequence — monotonic for the life of the ingest
  generation: number; // bumped on a failover ring reset
  ingestedSegments: number;
  ingestedBytes: number; // UPSTREAM bytes — distinct from egress; one of these can serve N viewers
  evictedSegments: number;
  targetDuration: number;
  at: number; // Date.now() of the last iop event — staleness tells you an ingest stopped reporting
}

const ingestByChannel = new Map<string, IngestHealth>(); // channelKey → last ingest snapshot

/** Record the data plane's latest `iop` snapshot for a channel. */
export function noteIngest(source: string, entryUrl: string, h: IngestHealth): void {
  ingestByChannel.set(streamKey(source, entryUrl), h);
}

/** The ingest health for a channel (null = not origin-backed, or nothing reported yet). */
export function ingestFor(channelKey: string): IngestHealth | null {
  return ingestByChannel.get(channelKey) ?? null;
}

/** Drop ingest health for channels no longer active (statsHub calls this with the live key set). */
export function pruneIngest(activeKeys: Set<string>): void {
  for (const key of ingestByChannel.keys()) if (!activeKeys.has(key)) ingestByChannel.delete(key);
}

// ── S3/CUE: ad-break state (per channel) ────────────────────────────────────────────────────────────────
// An EVENT stream, not a health snapshot: the sidecar sends exactly two frames per break (open/close), so
// this map holds "what is happening on this channel right now" plus a small rolling tally the operator can
// read a duty cycle off. Kept beside ingest health (same key, same prune) because a break is an INGEST-side
// observation — it is never allowed to touch an egress sink, same rule as `iop`.

export interface AdBreakState {
  /** True between an `open` and its `close` — the channel is serving ad content right now. */
  inBreak: boolean;
  /** Which signal detected it: 'CueTag' | 'DateRange' | 'UriSignature'. */
  signal: string;
  /** Sidecar-local label, for correlating the open/close pair in the logs. */
  breakId: number;
  /** Segments seen in the CURRENT (or most recent) break. */
  segments: number;
  /** Observed seconds so far in the current break, or the final total once closed. */
  durationSec: number;
  /** What the cue tag announced, when it announced anything (0 = unannounced, e.g. every pluto break). */
  announcedSec: number;
  /** Whether the decoder configuration actually changed at this edge — the Phase 2 gate. */
  profileChanged: boolean;
  /** Breaks completed since this ingest started, and their summed observed duration. */
  breaksSeen: number;
  totalBreakSec: number;
  at: number; // Date.now() of the last cue event
}

const adBreakByChannel = new Map<string, AdBreakState>();

/** Record an ad-break edge from the data plane. `state` is 'open' or 'close'. */
export function noteAdBreak(
  source: string,
  entryUrl: string,
  state: string,
  b: Omit<AdBreakState, 'inBreak' | 'breaksSeen' | 'totalBreakSec' | 'at'>,
): void {
  const key = streamKey(source, entryUrl);
  const prev = adBreakByChannel.get(key);
  const closing = state === 'close';
  adBreakByChannel.set(key, {
    ...b,
    inBreak: !closing,
    // Tally only on close, so a break in progress is never double-counted when it finally ends.
    breaksSeen: (prev?.breaksSeen ?? 0) + (closing ? 1 : 0),
    totalBreakSec: (prev?.totalBreakSec ?? 0) + (closing ? b.durationSec : 0),
    at: Date.now(),
  });
}

/** Ad-break state for a channel (null = no break ever seen — the normal case for most sources). */
export function adBreakFor(channelKey: string): AdBreakState | null {
  return adBreakByChannel.get(channelKey) ?? null;
}

/** Drop ad-break state for channels no longer active (statsHub calls this with the live key set). */
export function pruneAdBreaks(activeKeys: Set<string>): void {
  for (const key of adBreakByChannel.keys()) if (!activeKeys.has(key)) adBreakByChannel.delete(key);
}

// ── S3/ORIGIN aggregate ring footprint (process-wide) ──────────────────────────────────────────────────
// The map above is PER-CHANNEL and is pruned against the active-stream set, so it cannot answer "how much RAM
// are the rings holding" — an origin inside its 30s idle grace still owns its bytes with no active row to hang
// them off, which is exactly the case a memory-pressure reading must not miss. The sidecar therefore sums its
// own registry and reports one `ring` event; this holds the latest. Feeds systemStatsHub → the Dashboard's
// MEMORY PRESSURE tile.

export interface RingFootprint {
  origins: number;
  subscribed: number; // origins with ≥1 viewer; the rest are in their idle grace, still costing RAM
  bytes: number;
  capBytes: number; // Σ of those origins' per-channel caps — headroom before eviction, NOT a global ceiling
  at: number; // Date.now() of the frame
}

let ringFootprint: RingFootprint | null = null;

/** How long a footprint reporting LIVE origins stays trustworthy before we call the sidecar gone. */
const RING_STALE_MS = 15_000; // 6 missed 2.5s reports

/** Record the data plane's latest process-wide `ring` snapshot. */
export function noteRingFootprint(f: RingFootprint): void {
  ringFootprint = f;
}

/**
 * The latest ring footprint, or null when there is nothing trustworthy to show.
 *
 * Staleness applies ONLY to a frame that reported live origins: the sidecar goes deliberately quiet once the
 * last ingest closes, so a trailing `origins: 0` is a standing fact, not a stale reading, and must keep being
 * served. A frame with origins still running that then went silent means the sidecar died — report null and
 * let the tile degrade rather than freeze on a number that is no longer true.
 */
export function getRingFootprint(): RingFootprint | null {
  if (!ringFootprint) return null;
  if (ringFootprint.origins > 0 && Date.now() - ringFootprint.at > RING_STALE_MS) return null;
  return ringFootprint;
}

// ── Socket-liveness hooks (the raw-TS fork) ───────────────────────────────────────────────────────────
// Raw-TS external clients (externalTsEngine.ts) hold ONE long-lived HTTP socket and never poll, so the
// poll-recency model above is blind to them. These three hooks give them a parallel accounting that feeds the
// SAME ClientConn/ClosedSession shape — so Active Streams + History treat TS and HLS sessions uniformly: a
// viewer is counted on socket-open, bytes are attributed by the write stream, and the session is reaped on
// socket-close (with a no-byte backstop in tick()). Health still comes from the engine's -progress (it drives
// phaseFor() exactly as the HLS engine does), observed by tick() step 2 like any other bound client.

let socketConnSeq = 0;
/** A fresh per-socket connection id (the key namespace `socket|<id>` never collides with poll clients). */
export function nextSocketConnId(): number {
  return ++socketConnSeq;
}

/** Register a raw-TS viewer when its socket opens. One ClientConn per socket (each held connection is its own
 *  viewer — unlike poll clients, which collapse ip|ua|channel). */
export function noteSocketViewerOpen(
  source: string,
  entryUrl: string,
  ip: string,
  ua: string,
  username: string | undefined,
  playerType: PlayerType,
  connId: number,
): void {
  const now = Date.now();
  const channelKey = streamKey(source, entryUrl);
  const key = `socket|${connId}`;
  clients.set(key, {
    clientKey: key,
    ip,
    userAgent: ua,
    username,
    playerType,
    source,
    entryUrl,
    channelKey,
    connectedAt: now,
    lastSeen: now,
    bytes: 0,
    rateSamples: [{ t: now, bytes: 0 }],
    currentRate: 0,
    segments: 0,
    bufferEvents: [],
    bufferCount: 0,
    rebufferMs: 0,
    upstreamOpen: null,
    clientOpen: null,
    clientShortfallSince: null,
    socketBound: true,
  });
  // Mirror noteViewer: ensure the channel aggregate exists so phase/peak tracking covers TS-only channels.
  if (!channels.has(channelKey)) {
    channels.set(channelKey, { source, entryUrl, firstSeen: now, peakViewers: 0, lastPhase: phaseFor(channelKey).phase, bufferingSince: null });
  }
}

/** Attribute egress bytes written to a raw-TS socket (called per ring-buffer write). Refreshes lastSeen so the
 *  idle backstop never fires while bytes flow. (`segments` stays 0 — TS has no segment concept.) */
export function noteSocketBytes(connId: number, bytes: number): void {
  const c = clients.get(`socket|${connId}`);
  if (!c) return; // already reaped (socket closed / backstop) — ignore (defensive)
  c.bytes += bytes;
  c.lastSeen = Date.now();
}

/** Close a raw-TS viewer session when its socket closes — emits the same ClosedSession the HLS sweep does. */
export function noteSocketViewerClose(connId: number): void {
  const key = `socket|${connId}`;
  const c = clients.get(key);
  if (!c) return; // backstop already closed it
  closeSession(c, Date.now());
  clients.delete(key);
}

// ── Tick: rolling rates, buffering-event detection, stale sweep ───────────────────────────────────────

function closeSession(c: ClientConn, endedAt: number): void {
  // Finalise any still-open buffering interval against this client (a client swept mid-buffer still records the
  // partial duration) — fill each open event's ms + fold it into rebufferMs before the session is snapshotted.
  if (c.upstreamOpen) {
    c.upstreamOpen.ms = Math.max(0, endedAt - c.upstreamOpen.at);
    c.rebufferMs += c.upstreamOpen.ms;
    c.upstreamOpen = null;
  }
  if (c.clientOpen) {
    c.clientOpen.ms = Math.max(0, endedAt - c.clientOpen.at);
    c.rebufferMs += c.clientOpen.ms;
    c.clientOpen = null;
  }
  const durationMs = Math.max(0, endedAt - c.connectedAt);
  const s: ClosedSession = {
    source: c.source,
    entryUrl: c.entryUrl,
    channelKey: c.channelKey,
    ip: c.ip,
    userAgent: c.userAgent,
    username: c.username,
    playerType: c.playerType,
    connectedAt: c.connectedAt,
    endedAt,
    durationMs,
    bytesTotal: c.bytes,
    segments: c.segments,
    bufferEvents: c.bufferEvents.slice(),
    bufferCount: c.bufferCount,
    rebufferMs: c.rebufferMs,
  };
  for (const cb of sessionCloseCbs) {
    try {
      cb(s);
    } catch {
      /* a persistence sink must never break the sweep */
    }
  }
}

function clientsOnChannel(channelKey: string): ClientConn[] {
  const out: ClientConn[] = [];
  for (const c of clients.values()) if (c.channelKey === channelKey) out.push(c);
  return out;
}

export function tick(): void {
  const now = Date.now();

  // 1. Smoothed per-client rate: average throughput over the byte delta across the last RATE_WINDOW_MS,
  //    not a single tick — so a segment-burst followed by an idle gap reads as the sustained bitrate.
  for (const c of clients.values()) {
    c.rateSamples.push({ t: now, bytes: c.bytes });
    // Drop samples older than the window, but always keep ≥2 so a span (and a rate) still exists.
    while (c.rateSamples.length > 2 && now - c.rateSamples[1].t > RATE_WINDOW_MS) c.rateSamples.shift();
    const oldest = c.rateSamples[0];
    const dt = (now - oldest.t) / 1000;
    c.currentRate = dt > 0 ? Math.max(0, (c.bytes - oldest.bytes) / dt) : 0;
  }

  // 2. UPSTREAM buffering (side:'upstream') — phase-derived. A channel's live→buffer/failed transition opens an
  //    interval on every currently-bound client (tracked by c.upstreamOpen so the close fills the right event);
  //    a return to live closes it and folds the duration into rebufferMs. Observe-only in P1 — it becomes
  //    "corrected" once P3/RSL adds upstream retry/failover.
  for (const [channelKey, ch] of channels) {
    const bound = clientsOnChannel(channelKey);
    if (bound.length === 0 && ch.bufferingSince === null) {
      channels.delete(channelKey); // no viewers, not buffering → drop the aggregate
      continue;
    }
    ch.peakViewers = Math.max(ch.peakViewers, bound.length);
    const phase = phaseFor(channelKey).phase;
    const buffering = phase === 'buffer' || phase === 'failed';
    if (buffering && ch.bufferingSince === null) {
      ch.bufferingSince = now;
      for (const c of bound) {
        c.bufferCount += 1;
        const ev: BufferEvent = { at: now, phase, ms: 0, side: 'upstream' };
        c.bufferEvents.push(ev);
        c.upstreamOpen = ev;
      }
      for (const cb of bufferEventCbs) {
        try {
          cb(channelKey, ch.source, ch.entryUrl, phase, now, 'upstream');
        } catch {
          /* ignore */
        }
      }
    } else if (!buffering && ch.bufferingSince !== null) {
      const dur = now - ch.bufferingSince;
      for (const c of bound) {
        if (c.upstreamOpen) {
          c.upstreamOpen.ms = dur;
          c.rebufferMs += dur;
          c.upstreamOpen = null;
        }
      }
      ch.bufferingSince = null;
    }
    ch.lastPhase = phase;
  }

  // 2b. CLIENT-side buffering (side:'client') — Node edge-inference, per client: a viewer whose smoothed
  //     download rate stays below CLIENT_SHORTFALL_RATIO of its channel's DECLARED bitrate for at least
  //     CLIENT_BUFFER_MIN_MS can't keep up. Skipped when the channel declares no bandwidth (media-playlist-only
  //     upstream) or the client's rate window hasn't warmed (< RATE_WINDOW_MS after connect).
  for (const c of clients.values()) {
    const declared = mediaByChannel.get(c.channelKey)?.bandwidth ?? null; // bits/sec
    const warmed = now - c.connectedAt >= RATE_WINDOW_MS;
    const shortfall =
      declared !== null && declared > 0 && warmed && c.currentRate * 8 < declared * CLIENT_SHORTFALL_RATIO;
    if (shortfall) {
      if (c.clientShortfallSince === null) c.clientShortfallSince = now;
      // Open once the shortfall has persisted past the debounce (dates the interval to when it began).
      if (c.clientOpen === null && now - c.clientShortfallSince >= CLIENT_BUFFER_MIN_MS) {
        c.bufferCount += 1;
        const ev: BufferEvent = { at: c.clientShortfallSince, phase: 'buffer', ms: 0, side: 'client' };
        c.bufferEvents.push(ev);
        c.clientOpen = ev;
        for (const cb of bufferEventCbs) {
          try {
            cb(c.channelKey, c.source, c.entryUrl, 'buffer', c.clientShortfallSince, 'client');
          } catch {
            /* ignore */
          }
        }
      }
    } else {
      // Recovered — close any open client interval and reset the shortfall streak.
      if (c.clientOpen) {
        c.clientOpen.ms = now - c.clientOpen.at;
        c.rebufferMs += c.clientOpen.ms;
        c.clientOpen = null;
      }
      c.clientShortfallSince = null;
    }
  }

  // 3. Sweep stale clients → close their session. HLS poll clients go stale past the 30s recency TTL; raw-TS
  //    socket clients are reaped on socket-close (noteSocketViewerClose) and only swept here as a 60s no-byte
  //    backstop for a half-open socket (lastSeen is refreshed on every byte write).
  for (const [key, c] of clients) {
    const ttl = c.socketBound ? SOCKET_IDLE_MS : CLIENT_TTL_MS;
    if (now - c.lastSeen > ttl) {
      closeSession(c, c.lastSeen);
      clients.delete(key);
    }
  }
}

// ── Read models (consumed by the stats hub / REST snapshot) ───────────────────────────────────────────

export interface ChannelTelemetry {
  source: string;
  entryUrl: string;
  channelKey: string;
  viewers: number;
  peakViewers: number;
  watchers: string[]; // distinct, sorted usernames among the bound viewers (anonymous viewers omitted)
  viewersByPlayer: { appPlayer: number; externalPlayer: number }; // viewer split by player kind (a channel can be mixed)
  // The EFFECTIVE wire format being served RIGHT NOW (not the requested outputFormat): 'ts' iff a raw-TS
  // socket viewer is bound (tsmux engaged), 'hls' for poll viewers — INCLUDING a Raw-TS request the sidecar
  // couldn't honor (AES/fMP4/unreachable → tsmux fell back to the HLS rewrite), 'mixed' when both are present.
  // Derived from socketBound, so a fallback is directly observable: request 'ts', still see 'hls' ⇒ it fell back.
  delivery: 'hls' | 'ts' | 'mixed';
  egressBps: number; // total bytes/sec across all viewers
  bitrateBps: number; // per-viewer stream bitrate (egress / viewers)
  bytesTotal: number;
  uptimeMs: number;
}

/** One entry per channel that currently has ≥1 active viewer. */
export function snapshotRaw(): ChannelTelemetry[] {
  const byChannel = new Map<string, ClientConn[]>();
  for (const c of clients.values()) {
    const arr = byChannel.get(c.channelKey);
    if (arr) arr.push(c);
    else byChannel.set(c.channelKey, [c]);
  }
  const now = Date.now();
  const out: ChannelTelemetry[] = [];
  for (const [channelKey, group] of byChannel) {
    const ch = channels.get(channelKey);
    const egressBps = group.reduce((s, c) => s + c.currentRate, 0);
    const bytesTotal = group.reduce((s, c) => s + c.bytes, 0);
    // Distinct named viewers — the watching user accounts (anonymous/legacy clients have no username
    // and simply don't appear by name; they're still counted in `viewers`). Never carries the token.
    const watchers = [...new Set(group.map((c) => c.username).filter((u): u is string => !!u))].sort();
    const viewersByPlayer = {
      appPlayer: group.filter((c) => c.playerType === 'appPlayer').length,
      externalPlayer: group.filter((c) => c.playerType === 'externalPlayer').length,
    };
    // Effective delivery: a raw-TS client holds one socket (socketBound); an HLS client polls. A Raw-TS request
    // the sidecar couldn't honor (AES/fMP4/unreachable → tsmux fell back) serves segmented HLS, so its viewer
    // polls and reads 'hls' here — which is exactly what surfaces the fallback in the UI.
    const hasSocket = group.some((c) => c.socketBound);
    const hasPoll = group.some((c) => !c.socketBound);
    const delivery: 'hls' | 'ts' | 'mixed' = hasSocket && hasPoll ? 'mixed' : hasSocket ? 'ts' : 'hls';
    out.push({
      source: group[0].source,
      entryUrl: group[0].entryUrl,
      channelKey,
      viewers: group.length,
      peakViewers: Math.max(ch?.peakViewers ?? 0, group.length),
      watchers,
      viewersByPlayer,
      delivery,
      egressBps,
      bitrateBps: egressBps / group.length,
      bytesTotal,
      uptimeMs: now - (ch?.firstSeen ?? now),
    });
  }
  return out;
}

export interface ClientTelemetry {
  ip: string;
  userAgent: string;
  username: string | null; // the watching user account resolved from the request token (never the token)
  playerType: PlayerType; // in-app slide-out player vs a third-party IPTV client (drives the Active Streams "Player" pill)
  connectedAt: number;
  lastSeen: number;
  bytes: number;
  currentRate: number; // bytes/sec
  segments: number;
  // GeoIP enrichment — left unset by this DB-free core; filled in by the activeStreams route (which owns the
  // geoip lookup) so the response shape stays a single shared type the SPA's StreamClient mirrors.
  location?: string | null;
  countryCode?: string | null;
}

/** The per-client connection list for one channel (drives the "Connected sessions" card). */
export function clientsFor(channelKey: string): ClientTelemetry[] {
  return clientsOnChannel(channelKey).map((c) => ({
    ip: c.ip,
    userAgent: c.userAgent,
    username: c.username ?? null,
    playerType: c.playerType,
    connectedAt: c.connectedAt,
    lastSeen: c.lastSeen,
    bytes: c.bytes,
    currentRate: c.currentRate,
    segments: c.segments,
  }));
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the telemetry tick (rolling rates + buffering detection + stale sweep). Non-fatal at boot. */
export function startStreamTelemetry(): void {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref(); // don't keep the process alive on its own
}

/** Stop the tick (graceful shutdown / tests). */
export function stopStreamTelemetry(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
