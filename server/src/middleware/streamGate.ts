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

export interface GateDecision {
  ok: boolean;
  /** HTTP status + plain-text message to surface on a deny (set only when ok=false). */
  status?: number;
  message?: string;
}

/**
 * The stream-access ladder as a pure function of (user, source), shared by:
 *  · this `streamGate` Express middleware (the sidecar topology, in front of `proxyRelay`), and
 *  · the resolve-seam authorize step (`POST /api/internal/authorize`) — the gate Rust's per-request auth
 *    cache calls once Rust is the public edge (EDGE-3), where no Express middleware sits in front of streams.
 * The token gate ALWAYS lives in Node, where `req.user`/`allowedPlaylists` live, in every topology.
 */
export function gateStreamAccess(user: AuthRequest['user'], source: string, pl?: string): GateDecision {
  if (!user) {
    return { ok: false, status: 401, message: 'Unauthorized: stream token required' };
  }
  if (!user.streamTokenEnabled) {
    return { ok: false, status: 403, message: 'Forbidden: stream token is disabled' };
  }
  if (user.role === 'user' && !(user.allowedPlaylists ?? []).includes(source)) {
    return { ok: false, status: 403, message: 'Forbidden: you do not have access to this source' };
  }
  // `?pl` is the OWNING playlist id, taken verbatim from the client's query. It is not decorative: buildGrant
  // threads it into resolveProxyConfig(pl) — which selects that playlist's headerOverrides, timeouts and
  // outputFormat — and into the failover-parent lookup. Unvalidated, a `user` could borrow another playlist's
  // data-plane config by editing one query param. Absent `pl` stays allowed (the in-app player never sends one
  // and correctly falls back to the Default config).
  //
  // Unlike the `source` rung above, this checks the UNION of both lists: `pl` is a PLAYLIST id, and a clone /
  // imported playlist's id legitimately lives in allowedCustomPlaylists. (`source` is a provider adapter id,
  // which is why that rung is deliberately allowedPlaylists-only — see users.md §5.)
  if (pl && user.role === 'user' && pl !== source) {
    const allowed = [...(user.allowedPlaylists ?? []), ...(user.allowedCustomPlaylists ?? [])];
    if (!allowed.includes(pl)) {
      return { ok: false, status: 403, message: 'Forbidden: you do not have access to this playlist' };
    }
  }
  return { ok: true };
}

export function streamGate(req: AuthRequest, res: Response, next: NextFunction): void {
  // req.path is the remainder AFTER the matched mount (/api/v1 or /api/ext/v1) → "/<source>/<rest>".
  const source = req.path.split('/').filter(Boolean)[0] ?? '';
  const pl = typeof req.query.pl === 'string' ? req.query.pl : undefined;
  const decision = gateStreamAccess(req.user, source, pl);
  if (!decision.ok) {
    res.status(decision.status!).type('text/plain').send(decision.message!);
    return;
  }
  next();
}
