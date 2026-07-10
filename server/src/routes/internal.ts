import { Router } from 'express';
import { checkSecret, PROXY_SECRET_HEADER } from '../proxy/secret.js';
import { buildGrant } from '../proxy/resolveSeam.js';
import { ingestTelemetry } from '../proxy/telemetryIngest.js';
import { ingestProxyLog } from '../proxy/logIngest.js';
import { getProxyLogLevel } from '../proxy/logLevel.js';
import { userFromToken } from '../middleware/auth.js';
import { gateStreamAccess } from '../middleware/streamGate.js';

// The internal Node↔sidecar control channel (loopback + shared-secret). NOT a user-facing API: the SPA never
// calls it; only the Rust data plane does. Mounted under /api/internal so it sits outside the SPA catch-all
// and behind the (non-blocking) global `authenticate`, but its OWN guard is the shared secret (secret.ts) —
// a request without the matching x-masq-secret header is rejected 403 regardless of any user token.
//
//   POST /api/internal/resolve    { source, url, pl?, attempt? } → the per-stream GRANT (resolveSeam.buildGrant;
//                                 attempt N >= 1 targets the channel's Nth failover child, 410 = exhausted)
//   POST /api/internal/authorize  { token, source }      → the stream-token gate decision (EDGE-3)
//   POST /api/internal/telemetry  a viewer/bytes event (or { events:[...] }) → streamTelemetry writers
//   POST /api/internal/log        an engine log event (or { events:[...] }) → logStore (the `proxy` category)
//
// The two batched-flush endpoints (/telemetry + /log) reply { logLevel } — the current global verbosity — so
// the Rust flushers learn a live logLevel change within one flush cycle (no sidecar restart; see
// proxy/logLevel.ts + proxy/src/log.rs). Rust ignores the body on failure; it's advisory, best-effort.

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
    const { source, url, pl, attempt } = req.body ?? {};
    if (typeof source !== 'string' || !source || typeof url !== 'string' || !url) {
      res.status(400).json({ error: 'source_and_url_required' });
      return;
    }
    // attempt: the failover-candidate cursor (0 = the channel itself; N >= 1 = its Nth ordered child).
    // Older sidecars omit it → undefined (identical to today; also keeps probe-style callers inert).
    const att =
      typeof attempt === 'number' && Number.isInteger(attempt) && attempt >= 0 ? attempt : undefined;
    const grant = await buildGrant(source, url, typeof pl === 'string' ? pl : undefined, att);
    if (!grant.ok) {
      res.status(grant.status).json({ error: grant.error });
      return;
    }
    res.json(grant);
  } catch (err) {
    next(err);
  }
});

// EDGE-3 gate: when Rust is the public edge it serves the stream mounts in-process (no Express streamGate in
// front), so it must ask Node — the only place `req.user`/`allowedPlaylists` live — whether a stream token may
// play a source. Rust calls this on every ENTRY and on any HOP whose cached auth decision has expired (bounded
// by Rust's short auth-cache TTL), so revocation of streamTokenEnabled/allowedPlaylists takes effect promptly.
// The gate DECISION is the payload (HTTP stays 200 unless the secret guard/infra fails); a deny is a plain
// { ok:false, status } so Rust forwards the exact 401/403 the sidecar-mode streamGate would have. On allow it
// returns the resolved username so Rust can attribute telemetry (it has no relay-set x-masq-username at the edge).
internalRouter.post('/authorize', async (req, res, next) => {
  try {
    const { token, source } = req.body ?? {};
    if (typeof source !== 'string' || !source) {
      res.status(400).json({ error: 'source_required' });
      return;
    }
    const found = typeof token === 'string' && token ? await userFromToken(token) : null;
    const decision = gateStreamAccess(found?.user, source);
    if (!decision.ok) {
      res.json({ ok: false, status: decision.status, message: decision.message });
      return;
    }
    res.json({ ok: true, username: found!.user.username });
  } catch (err) {
    next(err);
  }
});

internalRouter.post('/telemetry', (req, res, next) => {
  try {
    ingestTelemetry(req.body);
    res.json({ logLevel: getProxyLogLevel() }); // echo the live level so the sidecar tracks changes
  } catch (err) {
    next(err);
  }
});

// The Rust proxy-engine log seam (full resolve→serve lineage, gated in Rust by the global logLevel). Persists
// into the `proxy` log category + fans out on /api/logs-stream (logIngest → logStore.ingestExternalLog).
internalRouter.post('/log', (req, res, next) => {
  try {
    ingestProxyLog(req.body);
    res.json({ logLevel: getProxyLogLevel() }); // echo the live level so the sidecar tracks changes
  } catch (err) {
    next(err);
  }
});
