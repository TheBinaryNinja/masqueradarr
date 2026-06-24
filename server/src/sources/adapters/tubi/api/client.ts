// Thin token-authenticated GET wrapper for the Tubi uapi catalog/programming endpoints. Injects the
// Authorization: Bearer <access_token> (minted/cached by ./deviceToken.ts) and, on a 401/403 (expired or
// rejected token), re-bootstraps ONCE and retries — the only auth-failure recovery the catalog/resolve
// callers need. Everything else (SSRF, playlist rewrite, telemetry) stays in the source-agnostic core.

import { getAccessToken, invalidateToken } from './deviceToken.js';
import { bearerHeaders } from './endpoints.js';

/** GET `url` with a Bearer token; on 401/403 re-mint the token once and retry. Returns the final Response. */
export async function tubiApiGet(url: string): Promise<Response> {
  const token = await getAccessToken();
  let res = await fetch(url, { headers: bearerHeaders(token) });
  if (res.status === 401 || res.status === 403) {
    invalidateToken();
    const fresh = await getAccessToken(true);
    res = await fetch(url, { headers: bearerHeaders(fresh) });
  }
  return res;
}
