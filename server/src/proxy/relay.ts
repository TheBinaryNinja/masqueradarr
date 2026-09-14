import { Readable, pipeline } from 'node:stream';
import type { Response, NextFunction } from 'express';
import type { AuthRequest } from '../middleware/auth.js';
import { PROXY_HOST, PROXY_PORT } from './sidecar.js';
import { PROXY_SECRET, PROXY_SECRET_HEADER } from './secret.js';
import { logger } from '../sources/core/logger.js';

// The Node→sidecar RELAY (P1 sidecar topology). After the stream-token gate, Node reverse-proxies the
// /api/v1 (appPlayer) + /api/ext/v1 (externalPlayer) mounts to the loopback Rust sidecar, preserving the
// single public port + the exact URL scheme. Node stays the front door (auth/gate); Rust does the durable
// fetch/rewrite/pipe. (At P3 Rust becomes the public edge and this relay is retired.)
//
// The relay enriches the forwarded request with the client identity the sidecar can't see behind the relay
// (real client IP/UA from `trust proxy`, the gated username, and the mount→playerType) so the sidecar can
// report faithful telemetry back to Node. The shared secret authenticates the relay to the sidecar.

const SIDECAR_BASE = `http://${PROXY_HOST}:${PROXY_PORT}`;

export async function proxyRelay(req: AuthRequest, res: Response, _next: NextFunction): Promise<void> {
  // originalUrl carries the full stream path + query (/api/(ext/)v1/<source>/<...>?token=&pl=&e=…) verbatim,
  // which the sidecar's router parses exactly like the old in-process proxy's URL marker.
  const target = SIDECAR_BASE + req.originalUrl;
  const playerType = req.baseUrl.startsWith('/api/ext') ? 'externalPlayer' : 'appPlayer';

  const headers: Record<string, string> = {
    [PROXY_SECRET_HEADER]: PROXY_SECRET,
    'x-masq-client-ip': req.ip || '',
    'x-masq-client-ua': (req.headers['user-agent'] as string) || '',
    'x-masq-username': req.user?.username || '',
    'x-masq-player': playerType,
  };
  // Forward Range so seeking / byte-range segment fetches pass through to the sidecar → upstream.
  const range = req.headers['range'];
  if (typeof range === 'string') headers['range'] = range;

  // The viewer can leave at any point — while the sidecar is still answering (an origin join can hold a request
  // for seconds) or mid-body. Closing the loopback request is the ONLY way the sidecar learns of it: a raw-TS
  // socket's producer holds the channel's ring lease, and with it the upstream ingest, until its connection
  // goes. Merely unpiping (what `.pipe()` does on a closed client) leaves that request open and paused, so the
  // ingest kept polling upstream for a viewer long gone. `destroyed` covers a client that left before this ran.
  const gone = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) gone.abort();
  });
  if (res.destroyed) gone.abort();

  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(target, { method: req.method, headers, redirect: 'manual', signal: gone.signal });
  } catch (err) {
    if (gone.signal.aborted) return; // the viewer left before the sidecar answered — nobody to tell
    logger.warn('proxy', `sidecar relay failed (${target.slice(0, 80)}): ${(err as Error).message}`);
    if (!res.headersSent) res.status(502).type('text/plain').send('stream engine unavailable');
    return;
  }

  res.status(upstream.status);
  for (const h of ['content-type', 'cache-control', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) res.set(h, v);
  }
  if (!upstream.body) {
    res.end();
    return;
  }
  // `pipeline`, not `.pipe()`: it destroys BOTH ends when either fails or the client closes early, which cancels
  // the body and so the loopback request (the abort above does the same; either alone would do).
  const body = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  pipeline(body, res, (err) => {
    if (err && !gone.signal.aborted) logger.warn('proxy', `sidecar stream error: ${err.message}`);
  });
}
