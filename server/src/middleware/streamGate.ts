import type { Response, NextFunction } from 'express';
import type { AuthRequest } from './auth.js';

// The per-request stream-token gate — rebuilt from the ladder the video-engine teardown removed (users.md §5).
// Applied to the reverse-proxied /api/v1 (appPlayer) + /api/ext/v1 (externalPlayer) stream mounts, AFTER the
// global `authenticate` (which populates req.user from EITHER a session token or a streamToken; the in-app
// player also streams with ?token=<streamToken>, so the ladder applies uniformly). Errors are PLAIN TEXT — the
// HLS-proxy deviation from the JSON resource API, so a media player surfaces the message.
//
// `:source` is the PROVIDER source (the path segment after /v1/) the proxy resolves against — dulo/dlhd/…,
// never a clone id (a clone channel's proxy URL keys on its `origin` provider). Step 3 is intentionally
// `allowedPlaylists`-only (NOT unioned with allowedCustomPlaylists) — see users.md §5.
export function streamGate(req: AuthRequest, res: Response, next: NextFunction): void {
  // req.path is the remainder AFTER the matched mount (/api/v1 or /api/ext/v1) → "/<source>/<rest>".
  const source = req.path.split('/').filter(Boolean)[0] ?? '';

  if (!req.user) {
    res.status(401).type('text/plain').send('Unauthorized: stream token required');
    return;
  }
  if (!req.user.streamTokenEnabled) {
    res.status(403).type('text/plain').send('Forbidden: stream token is disabled');
    return;
  }
  if (req.user.role === 'user' && !(req.user.allowedPlaylists ?? []).includes(source)) {
    res.status(403).type('text/plain').send('Forbidden: you do not have access to this source');
    return;
  }
  next();
}
