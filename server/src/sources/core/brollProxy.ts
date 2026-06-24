// B-Roll stream composer — the server-driven half of the placeholder-stream feature.
//
// When a client opens a channel through the proxy, the channel ENTRY URL itself becomes a LIVE HLS
// media playlist that THIS module composes on every poll. It serves one of:
//   · establishing / buffer  → the rendered B-Roll card segments (looping, live)
//   · live                    → the mirrored real upstream variant (rewritten back through the proxy)
//   · failed                  → the "failed" card + EXT-X-ENDLIST (client stops)
// The status + 2-retry budget are decided server-side (streamState.ts) so a dumb IPTV client gets the
// right behavior with zero client logic. Resolving the real stream is cached per channel (a fresh
// dulo playback session is expensive/stateful), so we re-resolve only while not-live or on failure —
// never on every poll. The card text (Display Name / channel name) is injected by the route layer via
// `cardLookup` so this core stays DB-free.

import type { Response } from 'express';
import { logger } from './logger.js';
import type { Metrics } from './metrics.js';
import { looksLikePlaylist, rewritePlaylist } from './playlist.js';
import { renderBroll, readBrollSegment, BROLL_SEG_SECONDS, type BrollStatus } from './broll.js';
import {
  streamKey,
  phaseFor,
  noteSuccess,
  noteFailure,
  noteFailed,
  MAX_RETRIES,
} from './streamState.js';
import { ensureProbe, resetProbe } from './streamProbe.js';
import { noteViewer, type PlayerType } from './streamTelemetry.js';
import type { StreamProbe } from '../../models/StreamSession.js';

// A non-2xx upstream RESPONSE (distinct from a transport/parse error, which throws a plain Error). It
// carries the HTTP status so the catch sites can treat it as an immediate failure: a non-200 stream
// means the upstream has nothing to serve, so we skip the establishing/buffer retry budget and drop
// straight to the `failed` card (see noteFailed in streamState.ts).
class UpstreamStatusError extends Error {
  constructor(public readonly status: number, kind: string) {
    super(`${kind} HTTP ${status}`);
  }
}

export interface CardInfo {
  title: string; // operator Display Name
  channel: string; // channel name
}

// The viewing client behind an entry-playlist poll (ip + user-agent), threaded in from proxyHandler so
// the telemetry layer can count viewers + attribute bandwidth without the core knowing about Express.
export interface ProxyClient {
  ip: string;
  ua: string;
  username?: string;
  // Which player this session belongs to — derived by the proxy from the request mount (/api/v1 ⇒ appPlayer,
  // /api/ext ⇒ externalPlayer). Threaded into the telemetry so Active Streams / History classify the session.
  playerType: PlayerType;
  // The token this request authenticated with — re-appended to every composed child URL (mirrored live
  // variant + B-Roll segments) so each subsequent player hop stays authed against the proxy gate.
  token?: string;
}

export interface BrollComposerOptions {
  source: string;
  prefix: string; // "/api/v1/<id>/"
  tag: string; // log tag
  metrics: Metrics;
  resolveStream: (entryUrl: string) => Promise<{ masterUrl: string }>;
  upstreamHeaders: (url: string) => Record<string, string>;
  onPlaylistChildHost: ((host: string) => void) | null;
  cardLookup: (entryUrl: string) => Promise<CardInfo>;
  // Optional DB-backed sink for a fresh ffprobe result (the route layer persists it — streamsessions row +
  // the channel's stream.probe snapshot). Kept injected so this composer stays DB-free / source-agnostic.
  persistProbe?: (entryUrl: string, probe: StreamProbe) => void;
  // Whether THIS composer drives the streamState phase machine (noteSuccess/noteFailure/noteFailed). Default
  // true — the /api/v1 in-app path owns it. The /api/ext external path passes a predicate that returns FALSE
  // while the ffmpeg engine is active, so the engine's `-progress` parser is the SOLE streamState writer:
  // two writers would race — the composer's optimistic noteSuccess on a still-present-but-STALE loopback
  // playlist would mask an ffmpeg stall the engine caught. When the engine is OFF (direct relay) the
  // predicate returns true and the composer owns state exactly as /api/v1 does.
  driveStreamState?: () => boolean;
}

interface ResolveCache {
  variantUrl: string | null; // resolved media (variant) playlist URL, mirrored while live
  inflight: Promise<void> | null; // a background resolve in progress
}

const SEG_TARGET = Math.ceil(BROLL_SEG_SECONDS);

export interface BrollComposer {
  /** True if the (still-encoded, query-stripped) path is a B-Roll sub-resource this composer serves. */
  isBrollPath(rawPath: string): boolean;
  /** Serve a B-Roll segment by its `__broll__/s/<hash>/<seg>` path. */
  serveBrollResource(rawPath: string, res: Response): void;
  /** Serve the composed LIVE media playlist for a channel entry URL (B-Roll or mirrored live). */
  serveComposedMedia(entryUrl: string, res: Response, client: ProxyClient): Promise<void>;
}

export function createBrollComposer(opts: BrollComposerOptions): BrollComposer {
  const { source, prefix, tag, metrics, resolveStream, upstreamHeaders, onPlaylistChildHost, cardLookup, persistProbe } =
    opts;

  // streamState ownership (see driveStreamState). Default: this composer owns the phase machine. The
  // external (engine-active) composer passes a predicate so the engine's `-progress` is the sole writer; the
  // cache management (rc.variantUrl clearing, probe, metrics) below stays UNconditional — only the phase
  // transitions are gated.
  const ownsStreamState = opts.driveStreamState ?? (() => true);
  const stSuccess = (k: string): void => {
    if (ownsStreamState()) noteSuccess(k);
  };
  const stFailure = (k: string): void => {
    if (ownsStreamState()) noteFailure(k);
  };
  const stFailed = (k: string): void => {
    if (ownsStreamState()) noteFailed(k);
  };

  // Fire-and-forget ffprobe of a live variant. Guarded in streamProbe.ts to run ONCE per stream-begin (a
  // no-op once captured), with a bounded retry budget on failure — so this is cheap to call per poll. Never
  // blocks the byte stream; on a successful probe the injected sink persists it.
  function probe(key: string, entryUrl: string, variantUrl: string): void {
    ensureProbe(key, variantUrl, upstreamHeaders(variantUrl), (p) => persistProbe?.(entryUrl, p));
  }

  const resolves = new Map<string, ResolveCache>();
  const lastKind = new Map<string, 'broll' | 'live'>(); // for the one-shot transition discontinuity
  const seqCounter = new Map<string, number>(); // monotonic media-sequence for the looping B-Roll

  function cacheFor(key: string): ResolveCache {
    let rc = resolves.get(key);
    if (!rc) {
      rc = { variantUrl: null, inflight: null };
      resolves.set(key, rc);
    }
    return rc;
  }

  // Resolve a channel entry to a single media (variant) playlist URL. dulo mints a fresh session here,
  // so this runs at most once per establish and again only when a live variant fetch fails.
  async function resolveVariant(entryUrl: string): Promise<string> {
    const { masterUrl } = await resolveStream(entryUrl);
    const r = await fetch(masterUrl, { headers: upstreamHeaders(masterUrl) });
    if (!r.ok) throw new UpstreamStatusError(r.status, 'master');
    const text = await r.text();
    if (!looksLikePlaylist(masterUrl, r.headers.get('content-type') || '')) {
      throw new Error('resolved upstream is not an HLS playlist');
    }
    return bestVariantUrl(text, r.url || masterUrl); // resolve relative variants against the post-redirect url; master → highest-resolution variant; media playlist → itself
  }

  function ensureResolve(key: string, entryUrl: string): void {
    const rc = cacheFor(key);
    if (rc.inflight || rc.variantUrl) return; // already resolving or have a live variant
    rc.inflight = (async () => {
      try {
        rc.variantUrl = await resolveVariant(entryUrl);
        stSuccess(key);
        // A fresh resolve is a new "stream begins" → reset the probe budget so this (re)established stream
        // probes from scratch, then kick the one-time probe of the freshly-resolved variant (side-channel).
        resetProbe(key);
        probe(key, entryUrl, rc.variantUrl);
        metrics.upstream.ok++;
        metrics.lastStreamAt = Date.now();
      } catch (err) {
        rc.variantUrl = null;
        // A non-2xx upstream status fails the channel immediately; a transport/parse error spends one retry.
        if (err instanceof UpstreamStatusError) stFailed(key);
        else stFailure(key);
        metrics.upstream.notLive++;
        metrics.lastError = (err as Error).message;
        logger.warn(tag, `resolve failed: ${(err as Error).message}`);
      } finally {
        rc.inflight = null;
      }
    })();
  }

  function isBrollPath(rawPath: string): boolean {
    return rawPath.split('?')[0].startsWith('__broll__/s/');
  }

  function serveBrollResource(rawPath: string, res: Response): void {
    const parts = rawPath.split('?')[0].split('/'); // __broll__ / s / <hash> / <seg>
    const buf = parts.length === 4 ? readBrollSegment(parts[2], parts[3]) : null;
    if (!buf) {
      res.status(404).type('text/plain').send('not found');
      return;
    }
    res.type('video/mp2t').set('Cache-Control', 'no-store').send(buf);
  }

  // Emit a one-shot EXT-X-DISCONTINUITY whenever we flip between B-Roll and live for a channel, so the
  // decoder resets cleanly across the (different codec/timeline) boundary.
  function switching(key: string, kind: 'broll' | 'live'): boolean {
    const prev = lastKind.get(key);
    lastKind.set(key, kind);
    return prev !== undefined && prev !== kind;
  }

  // The card is always served as a LIVE playlist (never EXT-X-ENDLIST) so the client keeps polling —
  // a `failed` channel can then self-heal after the streamState cooldown (the next poll re-resolves)
  // without the viewer re-opening, which matters for headless IPTV clients that can't "retry" on their
  // own.
  async function serveCard(
    entryUrl: string,
    key: string,
    status: BrollStatus,
    retry: number,
    res: Response,
    token?: string,
  ): Promise<void> {
    const { title, channel } = await cardLookup(entryUrl);
    const render = await renderBroll({ title, channel, status, retry });
    if (!render) {
      // ffmpeg unavailable / render failed → B-Roll disabled; surface a plain error (legacy behavior).
      metrics.requests.errors++;
      res.status(503).type('text/plain').send('stream unavailable');
      return;
    }
    const disco = switching(key, 'broll');
    // Advance media-sequence each poll and cache-bust the segment URIs so the client keeps treating the
    // looping slate as fresh "live" content (and stays in playing state showing the card).
    const seq = (seqCounter.get(key) ?? 0) + render.segments.length;
    seqCounter.set(key, seq);
    const cycle = Math.floor(seq / Math.max(1, render.segments.length));

    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${SEG_TARGET}`,
      `#EXT-X-MEDIA-SEQUENCE:${seq}`,
    ];
    let first = true;
    for (const seg of render.segments) {
      if (first && disco) lines.push('#EXT-X-DISCONTINUITY');
      first = false;
      lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
      lines.push(`${prefix}__broll__/s/${render.hash}/${seg.name}?c=${cycle}${token ? `&token=${encodeURIComponent(token)}` : ''}`);
    }
    metrics.requests.master++;
    res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(lines.join('\n') + '\n');
  }

  function serveRealMedia(key: string, mediaText: string, variantUrl: string, res: Response, token?: string): void {
    const rewritten = rewritePlaylist(mediaText, variantUrl, prefix, onPlaylistChildHost, token);
    let body = rewritten;
    if (switching(key, 'live')) {
      // Insert a one-shot discontinuity before the first segment of the mirrored live playlist.
      body = injectDiscontinuity(rewritten);
    }
    metrics.requests.master++;
    metrics.bytesStreamed += Buffer.byteLength(body);
    metrics.lastStreamAt = Date.now();
    res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(body);
  }

  async function serveComposedMedia(entryUrl: string, res: Response, client: ProxyClient): Promise<void> {
    const key = streamKey(source, entryUrl);
    const token = client.token;
    // The entry-playlist poll is the viewer heartbeat: register/refresh this client on this channel.
    noteViewer(source, entryUrl, client.ip, client.ua, client.username, client.playerType);
    metrics.requests.total++;

    if (phaseFor(key).phase === 'failed') {
      return serveCard(entryUrl, key, 'failed', MAX_RETRIES, res, token);
    }

    // If we believe the channel is live, mirror its variant playlist (cheap CDN fetch — no re-mint).
    const rc = cacheFor(key);
    if (rc.variantUrl) {
      try {
        const r = await fetch(rc.variantUrl, { headers: upstreamHeaders(rc.variantUrl) });
        if (!r.ok) throw new UpstreamStatusError(r.status, 'variant');
        const media = await r.text();
        stSuccess(key);
        probe(key, entryUrl, rc.variantUrl); // no-op once captured; drives the spaced retry budget if the begin-probe failed
        metrics.upstream.ok++;
        return serveRealMedia(key, media, r.url || rc.variantUrl, res, token); // rewrite against the post-redirect url
      } catch (err) {
        rc.variantUrl = null; // expired/broken → re-resolve next time
        // A non-2xx upstream status fails the channel immediately; a transport error spends one retry.
        if (err instanceof UpstreamStatusError) stFailed(key);
        else stFailure(key);
        metrics.upstream.failed++;
        metrics.lastError = (err as Error).message;
        logger.warn(tag, `live variant fetch failed: ${(err as Error).message}`);
        // fall through to a card reflecting the new phase
      }
    }

    // Not live yet → kick a background resolve and serve a card now (non-blocking).
    ensureResolve(key, entryUrl);
    const info = phaseFor(key);
    if (info.phase === 'failed') return serveCard(entryUrl, key, 'failed', MAX_RETRIES, res, token);
    const status: BrollStatus = info.phase === 'buffer' ? 'buffer' : 'establishing';
    return serveCard(entryUrl, key, status, info.retry, res, token);
  }

  return { isBrollPath, serveBrollResource, serveComposedMedia };
}

// ── helpers ──────────────────────────────────────────────────────────────

// Highest-resolution variant URI from a master playlist, resolved to an absolute URL. A master lists its
// variants in NO guaranteed order (e.g. Tubi interleaves and puts the best LAST), so selection is by parsed
// RESOLUTION (width*height), tie-broken by BANDWIDTH — never by position. Audio-only / subtitle renditions
// (#EXT-X-MEDIA, or #EXT-X-STREAM-INF carrying BANDWIDTH but no RESOLUTION) are deprioritized: we prefer a
// variant that declares a video RESOLUTION, fall back to the max-BANDWIDTH entry only when none do, and
// return the URL unchanged when there are no variant streams at all (already a media playlist).
function bestVariantUrl(text: string, baseUrl: string): string {
  const lines = text.split(/\r?\n/);

  // The URI on the first non-comment, non-blank line after a #EXT-X-STREAM-INF tag.
  const uriAfter = (i: number): string | null => {
    for (let j = i + 1; j < lines.length; j++) {
      const uri = lines[j].trim();
      if (uri && !uri.startsWith('#')) return uri;
    }
    return null;
  };

  // RESOLUTION=WxH → width*height (comparable pixel area), or 0 when absent/garbage.
  const pixels = (inf: string): number => {
    const m = /RESOLUTION=(\d+)x(\d+)/i.exec(inf);
    return m ? Number(m[1]) * Number(m[2]) : 0;
  };
  // BANDWIDTH=<bps> → number, or 0 when absent (tie-break only; guard against AVERAGE-BANDWIDTH).
  const bandwidth = (inf: string): number => {
    const m = /[^-]BANDWIDTH=(\d+)/i.exec(` ${inf}`);
    return m ? Number(m[1]) : 0;
  };

  let best: { uri: string; px: number; bw: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('#EXT-X-STREAM-INF')) continue;
    const uri = uriAfter(i);
    if (!uri) continue;
    const px = pixels(lines[i]);
    const bw = bandwidth(lines[i]);
    // Prefer higher resolution; among equal/absent resolution prefer higher bandwidth. A variant that HAS a
    // resolution always beats a resolution-less (audio-only) entry because px=0 loses the tie.
    if (!best || px > best.px || (px === best.px && bw > best.bw)) best = { uri, px, bw };
  }

  return best ? new URL(best.uri, baseUrl).href : baseUrl; // no variant streams → already a media playlist
}

// Insert a single EXT-X-DISCONTINUITY before the first segment line of a media playlist.
function injectDiscontinuity(playlist: string): string {
  const lines = playlist.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('#EXTINF')) {
      lines.splice(i, 0, '#EXT-X-DISCONTINUITY');
      break;
    }
  }
  return lines.join('\n');
}
