import { Router } from 'express';
import { checkSecret, PROXY_SECRET_HEADER } from '../proxy/secret.js';
import { buildGrant } from '../proxy/resolveSeam.js';
import { ingestTelemetry } from '../proxy/telemetryIngest.js';

// The internal Node↔sidecar control channel (loopback + shared-secret). NOT a user-facing API: the SPA never
// calls it; only the Rust data plane does. Mounted under /api/internal so it sits outside the SPA catch-all
// and behind the (non-blocking) global `authenticate`, but its OWN guard is the shared secret (secret.ts) —
// a request without the matching x-masq-secret header is rejected 403 regardless of any user token.
//
//   POST /api/internal/resolve    { source, url, pl? } → the per-stream GRANT (resolveSeam.buildGrant)
//   POST /api/internal/telemetry  a viewer/bytes event (or { events:[...] }) → streamTelemetry writers

export const internalRouter = Router();

internalRouter.use((req, res, next) => {
  if (!checkSecret(req.headers[PROXY_SECRET_HEADER])) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
});

internalRouter.post('/resolve', async (req, res, next) => {
  try {
    const { source, url, pl } = req.body ?? {};
    if (typeof source !== 'string' || !source || typeof url !== 'string' || !url) {
      res.status(400).json({ error: 'source_and_url_required' });
      return;
    }
    const grant = await buildGrant(source, url, typeof pl === 'string' ? pl : undefined);
    if (!grant.ok) {
      res.status(grant.status).json({ error: grant.error });
      return;
    }
    res.json(grant);
  } catch (err) {
    next(err);
  }
});

internalRouter.post('/telemetry', (req, res, next) => {
  try {
    ingestTelemetry(req.body);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
