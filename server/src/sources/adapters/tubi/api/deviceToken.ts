// Anonymous device-token bootstrap for the Tubi backend API. Two hops, both ported from the web client:
//
//   1. POST /device/anonymous/signing_key  { challenge, version, platform, device_id }  → { id, key }
//        challenge = PKCE base64url(sha256(verifier)); `key` is the base64 HMAC secret bound to `id`.
//   2. POST /device/anonymous/token?X-Tubi-*  { verifier, id, platform, device_id }  → { access_token, … }
//        signed with `key` (TUBI-HMAC-SHA256); the verifier proves possession of the challenge.
//
// The access_token (a ~24h JWT) is the Bearer for every catalog/programming call. We cache it in a module
// singleton and re-bootstrap when it's within 30s of expiry or on a 401/403 (see ./client.ts). The device_id
// is stable per process (TUBI_DEVICE_ID overrides) so we don't churn Tubi's anonymous-device registry.

import { randomUUID } from 'node:crypto';
import { logger } from '../../../core/logger.js';
import { pkceVerifier, pkceChallenge, signTubiRequest } from './sign.js';
import {
  SIGNING_KEY_URL,
  TOKEN_URL,
  TOKEN_SIGN_PATH,
  SIGNING_KEY_VERSION,
  TUBI_PLATFORM,
  jsonHeaders,
} from './endpoints.js';

const DEVICE_ID = process.env.TUBI_DEVICE_ID || randomUUID();

interface Cached {
  accessToken: string;
  exp: number; // epoch seconds
}
let cached: Cached | null = null;
let inflight: Promise<string> | null = null;

/** The stable per-process anonymous device id (TUBI_DEVICE_ID override, else a generated uuid). */
export function getDeviceId(): string {
  return DEVICE_ID;
}

/** Run the full signing_key → token handshake and return the fresh access token (+ its expiry). */
async function bootstrap(): Promise<Cached> {
  const verifier = pkceVerifier();
  const challenge = pkceChallenge(verifier);

  // ── hop 1: signing_key (unsigned; PKCE challenge) → { id, key } ──
  const skBody = JSON.stringify({
    challenge,
    version: SIGNING_KEY_VERSION,
    platform: TUBI_PLATFORM,
    device_id: DEVICE_ID,
  });
  const skRes = await fetch(SIGNING_KEY_URL, { method: 'POST', headers: jsonHeaders(), body: skBody });
  if (!skRes.ok) throw new Error(`signing_key HTTP ${skRes.status}`);
  const sk = (await skRes.json()) as { id?: string; key?: string };
  if (!sk.id || !sk.key) throw new Error('signing_key response missing id/key');

  // ── hop 2: token (signed with `key`; proves possession via `verifier`) → { access_token, expires_in } ──
  const tokenBody = JSON.stringify({ verifier, id: sk.id, platform: TUBI_PLATFORM, device_id: DEVICE_ID });
  const sig = signTubiRequest(tokenBody, sk.key, TOKEN_SIGN_PATH);
  const qs = new URLSearchParams({
    'X-Tubi-Algorithm': sig['X-Tubi-Algorithm'],
    'X-Tubi-Date': sig['X-Tubi-Date'],
    'X-Tubi-Expires': String(sig['X-Tubi-Expires']),
    'X-Tubi-SignedHeaders': sig['X-Tubi-SignedHeaders'],
    'X-Tubi-Signature': sig['X-Tubi-Signature'],
  });
  const tRes = await fetch(`${TOKEN_URL}?${qs.toString()}`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: tokenBody,
  });
  if (!tRes.ok) throw new Error(`token HTTP ${tRes.status}`);
  const t = (await tRes.json()) as { access_token?: string; expires_in?: number };
  if (!t.access_token) throw new Error('token response missing access_token');

  const exp = Date.now() / 1000 + (t.expires_in || 86400);
  logger.info('seed', `[tubi] uapi device token minted (expires in ${Math.round((t.expires_in || 86400) / 3600)}h)`);
  return { accessToken: t.access_token, exp };
}

/**
 * Return a valid access token, minting one if absent / near-expiry. `force` discards the cache (used after a
 * 401/403). Concurrent callers share one in-flight bootstrap so a burst of plays mints a single token.
 */
export async function getAccessToken(force = false): Promise<string> {
  if (!force && cached && Date.now() / 1000 + 30 < cached.exp) return cached.accessToken;
  if (!inflight) {
    inflight = bootstrap()
      .then((c) => {
        cached = c;
        return c.accessToken;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Drop the cached token (next getAccessToken re-bootstraps). */
export function invalidateToken(): void {
  cached = null;
}
