import { Readable } from 'node:stream';
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

  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(target, { method: req.method, headers, redirect: 'manual' });
  } catch (err) {
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
  const body = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on('error', (err) => {
    logger.warn('proxy', `sidecar stream error: ${err.message}`);
    res.destroy(err);
  });
  body.pipe(res);
}
