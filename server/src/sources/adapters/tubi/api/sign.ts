// TUBI-HMAC-SHA256 request signer + PKCE helpers for the anonymous device-token bootstrap.
//
// Reverse-engineered from tubitv.com's web bundle (the `de` token-signing function) and verified
// byte-for-byte against a captured request (see scripts/tubi-sign-check.ts). The scheme is AWS-SigV4-shaped:
//
//   bodyHash      = sha256_hex( JSON body )
//   canonicalReq  = "POST\n" + path + "\n\n" + "content-type:application/json\n" + "\n" + "content-type\n" + bodyHash
//   stringToSign  = "TUBI-HMAC-SHA256\n" + date + "\n" + sha256_hex(canonicalReq)
//   keySeed       = utf8("TUBI") ++ base64decode(serverSigningKey)
//   kDate         = HMAC-SHA256( "YYYYMMDD",      keySeed )
//   kSigning      = HMAC-SHA256( "tubi_request",  kDate   )
//   signature     = HMAC-SHA256( stringToSign,    kSigning ).hex
//
// The signed query string is empty at sign time — the X-Tubi-* params are the OUTPUT, appended afterward; the
// only signed header is content-type. Pure + dependency-free (node:crypto only): unit-verifiable offline.

import { createHash, createHmac, randomBytes } from 'node:crypto';

const ALGORITHM = 'TUBI-HMAC-SHA256';
const SIGNED_HEADERS = 'content-type';
const CONTENT_TYPE = 'application/json';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function hmac(message: string, key: Buffer): Buffer {
  return createHmac('sha256', key).update(message, 'utf8').digest();
}

/** ISO-8601 without millis + 'Z', stripped to alphanumerics → e.g. 2026-06-19T13:53:55.123Z → 20260619T135355Z. */
export function tubiDate(now: Date = new Date()): string {
  return `${now.toISOString().split('.')[0]}Z`.replace(/[^A-Za-z0-9]/g, '');
}

export interface TubiSignature {
  'X-Tubi-Algorithm': string;
  'X-Tubi-Date': string;
  'X-Tubi-Expires': number;
  'X-Tubi-SignedHeaders': string;
  'X-Tubi-Signature': string;
}

/**
 * Sign a `POST <path>` with the already-stringified JSON `bodyJson` using the base64 `signingKeyB64` minted by
 * /device/anonymous/signing_key. Returns the X-Tubi-* params to append to the request query string. `now` is
 * injectable for deterministic tests; production passes the default. IMPORTANT: hash the exact bytes you send —
 * pass the SAME string to fetch()'s body that you pass here.
 */
export function signTubiRequest(
  bodyJson: string,
  signingKeyB64: string,
  path: string,
  now: Date = new Date(),
): TubiSignature {
  const bodyHash = sha256Hex(bodyJson);
  const canonical = `POST\n${path}\n\ncontent-type:${CONTENT_TYPE}\n\n${SIGNED_HEADERS}\n${bodyHash}`;
  const date = tubiDate(now);
  const stringToSign = `${ALGORITHM}\n${date}\n${sha256Hex(canonical)}`;
  const keySeed = Buffer.concat([Buffer.from('TUBI', 'utf8'), Buffer.from(signingKeyB64, 'base64')]);
  const kDate = hmac(date.split('T')[0], keySeed);
  const kSigning = hmac('tubi_request', kDate);
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    'X-Tubi-Algorithm': ALGORITHM,
    'X-Tubi-Date': date,
    'X-Tubi-Expires': 30,
    'X-Tubi-SignedHeaders': SIGNED_HEADERS,
    'X-Tubi-Signature': signature,
  };
}

/** PKCE code verifier: 16 random bytes as lowercase hex (32 chars), per the web client's WordArray.random(16). */
export function pkceVerifier(): string {
  return randomBytes(16).toString('hex');
}

/** PKCE code challenge: base64url(sha256(utf8(verifier))), padding retained (verified against a live request). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
}
