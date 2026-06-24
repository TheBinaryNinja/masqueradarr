// One Express handler factory per source, bound to GET /api/v1/:source/*. Ported from
// d-combine/lib/core/proxy-handler.mjs. Every per-source difference (resolve, headers, SSRF allow,
// dynamic-allow, segment relabel, artifact classification) is read off `adapter`; the control flow
// below is invariant.
//
//   /api/v1/<source>/<enc entry-or-stream URL>
//     · entry URL (dlhd watch.php / stream-N.php) → adapter.resolveStream() → fresh master, then proxy
//     · master/variant .m3u8                      → rewrite child URIs back through /api/v1/<source>/…
//     · segment                                   → pipe bytes (adapter may relabel the content-type)

import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import { logger } from './logger.js';
import { fmtBytes, type Metrics } from './metrics.js';
import { looksLikePlaylist, rewritePlaylist } from './playlist.js';
import type { BrollComposer } from './brollProxy.js';
import { noteBytes, type PlayerType } from './streamTelemetry.js';
import { extractToken } from '../../middleware/auth.js';
import type { SourceAdapter } from '../types.js';

function label(url: string): { host: string; short: string } {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').pop() || '';
    return { host: u.hostname, short: file.slice(0, 8) || '/' };
  } catch {
    return { host: '?', short: '?' };
  }
}

// Context handed to a serveEntry resolver: the viewing client identity (for telemetry) + the resolved
// per-playlist videoconfig id (drives which engine/args run for THIS request — the per-playlist config).
export interface EntryResolveCtx {
  ip: string;
  ua: string;
  username?: string;
  configId: string;
}

// A composer-free channel-entry resolver — the externalPlayer (/api/ext) HLS path. Given a channel entry
// URL it resolves the upstream master to serve (routing through the ffmpeg/VLC engine → 127.0.0.1 loopback
// HLS, or relaying the adapter master when the engine is off) and performs the entry-time side effects
// (viewer registration, one-shot ffprobe). The handler then fetches+rewrites+serves the returned masterUrl
// through the SAME common path the in-app composer's live mirror uses. A throw becomes a 502 — there is NO
// B-Roll slate on the external path (the "truest path": a failure surfaces as an error, like the raw-TS path).
export type ServeEntry = (entryUrl: string, ctx: EntryResolveCtx) => Promise<{ masterUrl: string }>;

// Per-handler options. The same factory serves BOTH proxy mounts: the in-app /api/v1 (appPlayer) and the
// external /api/ext/v1 (externalPlayer). They differ in (a) the prefix rewritten into child URIs, (b) an
// extra allowlist predicate — /api/ext ORs in the engine's 127.0.0.1 loopback origin (which the adapter's
// own isAllowedUpstream blocks as a private host) so the rewritten loopback segment hops are permitted, and
// (c) serveEntry — when set, channel-entry requests use the composer-free engine resolver instead of the
// B-Roll composer / legacy fallback. The playerType tag is derived from the request mount inside the handler.
export interface ProxyHandlerOptions {
  prefix?: string; // child-URI rewrite prefix; defaults to "/api/v1/<id>/"
  extraAllowed?: (url: string) => boolean; // OR'd with adapter.proxy.isAllowedUpstream on direct hops
  serveEntry?: ServeEntry; // externalPlayer: composer-free, engine-driven, slate-free channel-entry resolver
  // Whether playlist rewrites teach each child host to the adapter's dynamic SSRF allowlist
  // (adapter.proxy.onPlaylistChildHost). Default true (the in-app /api/v1 mount). The externalPlayer mount sets
  // FALSE so the engine's 127.0.0.1 loopback segment hosts are never taught to the shared adapter allowlist
  // (loopback hops are permitted via extraAllowed instead; relay hosts are already taught by resolveStream) —
  // preserving the old external composer's `onPlaylistChildHost: null` posture.
  learnChildHosts?: boolean;
}

export function createProxyHandler(adapter: SourceAdapter, metrics: Metrics, broll?: BrollComposer, opts?: ProxyHandlerOptions) {
  // Marker used to slice the raw (still-encoded) upstream URL out of req.originalUrl, independent of
  // where the router is mounted. Keeps embedded ?session=/?md5&expires through ONE decodeURIComponent.
  // "/v1/<id>/" appears in BOTH "/api/v1/<id>/…" and "/api/ext/v1/<id>/…", so one marker serves both mounts.
  const MARKER = `/v1/${adapter.id}/`;
  const PREFIX = opts?.prefix ?? `/api/v1/${adapter.id}/`;
  const extraAllowed = opts?.extraAllowed;
  const serveEntry = opts?.serveEntry;
  const learnChildHosts = opts?.learnChildHosts ?? true;
  const tag = `stream:${adapter.id}`;
  const { proxy } = adapter;

  return async function handler(req: Request, res: Response): Promise<void> {
    const startedAt = Date.now();
    const ms = () => `${Date.now() - startedAt}ms`;
    // Viewer identity for live telemetry (ip|user-agent). The entry poll registers the viewer; segment/
    // playlist bytes below are attributed to whatever channel that same client is currently bound to.
    const ip = req.ip ?? '';
    const ua = (req.headers['user-agent'] as string | undefined) ?? '';
    const username = (req as any).user?.username;
    // appPlayer (in-app slide-out player) vs externalPlayer (third-party IPTV client) — derived from the
    // mount: the in-app player hits /api/v1, the M3U composer writes /api/ext for external clients. This
    // factory serves /api/v1, so it's appPlayer; the /api/ext engine handler tags externalPlayer itself.
    const playerType: PlayerType = req.originalUrl.startsWith('/api/ext') ? 'externalPlayer' : 'appPlayer';
    // The token this request authenticated with — re-embedded into every rewritten child URL so the
    // player's variant/segment hops (which drop the query when resolving relative URIs) stay authed.
    const reqToken = extractToken(req);
    // The owning-playlist selector (externalPlayer mount) — propagated onto child URLs so a segment/variant
    // resolves the same per-playlist videoconfig as its entry. Undefined on the in-app /api/v1 mount.
    const reqPl = typeof req.query.pl === 'string' && req.query.pl ? req.query.pl : undefined;

    // 1. Extract the raw (still-encoded) path after the marker. B-Roll sub-resources are detected here,
    //    BEFORE the single decodeURIComponent, because their own path structure must stay intact.
    //    Strip unencoded query string parameters (like ?token=...) from the original URL so they don't contaminate rawPath.
    const urlPathOnly = req.originalUrl.split('?')[0];
    const idx = urlPathOnly.indexOf(MARKER);
    const rawPath = idx >= 0 ? urlPathOnly.slice(idx + MARKER.length) : '';

    if (broll && broll.isBrollPath(rawPath)) {
      broll.serveBrollResource(rawPath, res);
      return;
    }

    let upstreamUrl: string;
    try {
      upstreamUrl = decodeURIComponent(rawPath);
    } catch {
      logger.warn(tag, `400 malformed encoded URL from ${req.ip}`);
      res.status(400).type('text/plain').send('Bad request: malformed encoded URL');
      return;
    }

    // 2. Channel entry → resolve the upstream master to serve. Three modes, in precedence order:
    if (adapter.isEntryUrl(upstreamUrl)) {
      if (serveEntry) {
        // (a) externalPlayer (/api/ext): composer-free, engine-driven, NO B-Roll slate. The resolver routes
        //     through the ffmpeg/VLC engine (loopback HLS) — or relays the adapter master when the engine is
        //     off — and does the entry side effects (viewer registration + ffprobe). We then fall through to
        //     the common fetch→rewrite→serve below; loopback segment hops are SSRF-allowed via extraAllowed.
        metrics.requests.total++;
        metrics.requests.master++;
        try {
          const resolved = await serveEntry(upstreamUrl, { ip, ua, username, configId: (req as any).videoConfigId ?? 'app' });
          upstreamUrl = resolved.masterUrl;
        } catch (err) {
          metrics.requests.errors++;
          metrics.upstream.notLive++;
          metrics.lastError = (err as Error).message;
          logger.warn(tag, `external resolve failed: ${(err as Error).message} (${ms()})`);
          if (!res.headersSent) res.status(502).type('text/plain').send(`Stream failed: ${(err as Error).message}`);
          return;
        }
      } else if (broll) {
        // (b) in-app appPlayer (/api/v1): the B-Roll composer owns resolve + the establishing/buffer/failed
        //     slate. It handles every failure mode internally; guard an unexpected throw (e.g. a Mongo hiccup
        //     in cardLookup) so we still honour "never call next(err)".
        try {
          await broll.serveComposedMedia(upstreamUrl, res, { ip, ua, username, playerType, token: reqToken });
        } catch (err) {
          metrics.requests.errors++;
          metrics.lastError = (err as Error).message;
          logger.error(tag, `broll composer error: ${(err as Error).message} (${ms()})`);
          if (!res.headersSent) res.status(502).type('text/plain').send('stream composer error');
        }
        return;
      } else {
        // (c) legacy resolve-then-proxy (no composer wired) — keeps the core source-agnostic.
        metrics.requests.total++;
        metrics.requests.master++;
        try {
          const resolved = await adapter.resolveStream(upstreamUrl);
          upstreamUrl = resolved.masterUrl;
        } catch (err) {
          metrics.requests.errors++;
          metrics.upstream.notLive++;
          metrics.lastError = (err as Error).message;
          logger.warn(tag, `resolve failed: ${(err as Error).message} (${ms()})`);
          res.status(502).type('text/plain').send(`Resolve failed: ${(err as Error).message}`);
          return;
        }
      }
    } else {
      // 3. Direct hop (master/variant/segment from a rewritten playlist) → SSRF gate. On /api/ext the engine
      //    loopback origin (127.0.0.1) is additionally allowed via extraAllowed (the adapter blocks it as private).
      if (!proxy.isAllowedUpstream(upstreamUrl) && !(extraAllowed && extraAllowed(upstreamUrl))) {
        logger.warn(tag, `400 blocked upstream: ${String(upstreamUrl).slice(0, 80)}`);
        res.status(400).type('text/plain').send('Bad request: upstream host not in the allowlist');
        return;
      }
      metrics.requests.total++;
      metrics.requests[proxy.classifyArtifact(upstreamUrl)]++;
    }

    const type = proxy.classifyArtifact(upstreamUrl);
    const { host, short } = label(upstreamUrl);

    metrics.active++;
    res.on('close', () => {
      metrics.active--;
    });

    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(upstreamUrl, { headers: proxy.upstreamHeaders(upstreamUrl) });
    } catch (err) {
      metrics.upstream.failed++;
      metrics.requests.errors++;
      metrics.lastError = (err as Error).message;
      logger.error(tag, `${type} ${host} ${short} upstream fetch failed: ${(err as Error).message} (${ms()})`);
      res.status(502).type('text/plain').send(`Upstream fetch failed: ${(err as Error).message}`);
      return;
    }

    // Forward upstream errors verbatim. 404 = not transcoding right now; 403 = origin/referer gate.
    if (!upstream.ok) {
      metrics.requests.errors++;
      if (upstream.status === 404) metrics.upstream.notLive++;
      else if (upstream.status === 403) metrics.upstream.forbidden++;
      else metrics.upstream.failed++;
      const note = upstream.status === 404 ? ' (not live)' : upstream.status === 403 ? ' (gate)' : '';
      metrics.lastError = `HTTP ${upstream.status} ${host}/${short}`;
      logger.warn(tag, `${type} ${host} ${short} status=${upstream.status}${note} (${ms()})`);
      const detail = await upstream.text().catch(() => '');
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') || 'text/plain')
        .send(detail || `Upstream HTTP ${upstream.status}`);
      return;
    }

    const contentType = upstream.headers.get('content-type') || '';

    // 4. Playlist → rewrite child URIs back through this source's proxy prefix
    //    (and let the adapter learn each child host: dlhd dynamic-allow; dulo/common no-op).
    if (looksLikePlaylist(upstreamUrl, contentType)) {
      // Resolve child URIs against the FINAL url after redirects (e.g. a jmp2.uk redirector → the pluto.tv
      // stitcher), not the pre-redirect request URL, so relative variant/segment URIs rebase onto the host
      // that actually served the playlist. `upstream.url` === `upstreamUrl` when no redirect happened.
      const baseUrl = upstream.url || upstreamUrl;
      // The external mount passes learnChildHosts:false → null, so the engine's loopback (or relayed) child
      // hosts are never folded into the adapter's shared SSRF allowlist (see ProxyHandlerOptions).
      const childHost = learnChildHosts ? proxy.onPlaylistChildHost : null;
      const rewritten = rewritePlaylist(await upstream.text(), baseUrl, PREFIX, childHost, reqToken, reqPl);
      const bytes = Buffer.byteLength(rewritten);
      metrics.upstream.ok++;
      metrics.bytesStreamed += bytes;
      metrics.lastStreamAt = Date.now();
      noteBytes(ip, ua, bytes, username);
      logger.ok(tag, `${type} ${host} ${short} status=200 ${fmtBytes(bytes)} (${ms()})`);
      res.set('Cache-Control', 'no-store'); // playlists + tokens are short-lived
      res.type('application/vnd.apple.mpegurl').send(rewritten);
      return;
    }

    // 5. Segment (or anything else) → stream the bytes through, content-type per the adapter.
    res.set('Content-Type', proxy.relabelSegmentContentType(upstreamUrl, contentType, type));
    res.set('Cache-Control', 'no-store');

    if (!upstream.body) {
      metrics.upstream.ok++;
      logger.ok(tag, `${type} ${host} ${short} status=200 0B (${ms()})`);
      res.end();
      return;
    }

    let bytes = 0;
    const body = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    res.on('finish', () => {
      metrics.upstream.ok++;
      metrics.bytesStreamed += bytes;
      metrics.lastStreamAt = Date.now();
      noteBytes(ip, ua, bytes, username);
      logger.ok(tag, `${type} ${host} ${short} status=200 ${fmtBytes(bytes)} (${ms()})`);
    });
    body.on('error', (err: Error) => {
      metrics.upstream.failed++;
      metrics.lastError = err.message;
      logger.error(tag, `${type} ${host} ${short} stream error: ${err.message}`);
      res.destroy(err);
    });
    body.pipe(res);
  };
}
