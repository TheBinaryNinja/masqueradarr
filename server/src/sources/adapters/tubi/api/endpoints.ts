// Tubi backend API (uapi) endpoint catalog + env-tunable config. This is the ONLY place the uapi hosts,
// platform params, and the kill-switch live; everything else in tubi/api/ reads from here (mirrors the
// TUBI_LIVE_URL/TUBI_EPG_URL pattern in ../catalog.ts for the legacy web tier).
//
// Discovered by a live capture of tubitv.com's web client (see .claude/docs/tubi-datasource.md):
//   · account.production-public.tubi.io  — anonymous device-token bootstrap (signed, TUBI-HMAC-SHA256)
//   · tensor-cdn.production-public.tubi.io/api/v2/epg  — the linear channel list + group containers
//   · epg-cdn.production-public.tubi.io/content/epg/programming  — per-channel meta + manifest + programs[]
// The catalog/programming calls are NOT signed — they carry an Authorization: Bearer <access_token> minted
// by the bootstrap. Only the token request itself is signed (see ./sign.ts).

const ACCOUNT_BASE = process.env.TUBI_ACCOUNT_BASE || 'https://account.production-public.tubi.io';
const TENSOR_BASE = process.env.TUBI_TENSOR_BASE || 'https://tensor-cdn.production-public.tubi.io';
const EPG_BASE = process.env.TUBI_EPG_API_BASE || 'https://epg-cdn.production-public.tubi.io';

/** Web origin we present as (the uapi is the tubitv.com web client's backend). */
export const TUBI_WEB_ORIGIN = 'https://tubitv.com';

export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ── account / token bootstrap ──────────────────────────────────────────────────────
export const SIGNING_KEY_URL = `${ACCOUNT_BASE}/device/anonymous/signing_key`;
export const TOKEN_URL = `${ACCOUNT_BASE}/device/anonymous/token`;
/** The path used inside the signature's canonical request — must match TOKEN_URL's pathname exactly. */
export const TOKEN_SIGN_PATH = '/device/anonymous/token';
export const SIGNING_KEY_VERSION = '1.0.0';

// ── platform params ─────────────────────────────────────────────────────────────────
export const TUBI_PLATFORM = process.env.TUBI_PLATFORM || 'web';
export const TUBI_EPG_MODE = process.env.TUBI_EPG_MODE || 'tubitv_us_linear';

// ── orchestration knobs ─────────────────────────────────────────────────────────────
/** Master kill-switch: TUBI_USE_API=0 forces the legacy web-tier path (catalog + resolve). Default on. */
export const TUBI_USE_API = process.env.TUBI_USE_API !== '0';
/** content_ids per /content/epg/programming batch. The web client uses ~20; 50 is a safe server default. */
export const EPG_API_BATCH = Number(process.env.TUBI_EPG_API_BATCH) || 50;

// ── URL builders ─────────────────────────────────────────────────────────────────────
/** The linear channel list + group containers (one call → all channels + groups). */
export function tensorEpgUrl(deviceId: string): string {
  const p = new URLSearchParams({ mode: TUBI_EPG_MODE, platform: TUBI_PLATFORM, device_id: deviceId });
  return `${TENSOR_BASE}/api/v2/epg?${p.toString()}`;
}

/** Per-channel programming (meta + signed manifest URL + programs[]) for a CSV of content_ids. */
export function epgProgrammingUrl(deviceId: string, contentIdsCsv: string): string {
  const p = new URLSearchParams({ platform: TUBI_PLATFORM, device_id: deviceId, lookahead: '1' });
  p.append('limit_resolutions[]', 'h264_1080p');
  p.append('limit_resolutions[]', 'h265_1080p');
  p.append('content_id', contentIdsCsv);
  return `${EPG_BASE}/content/epg/programming?${p.toString()}`;
}

// ── header helpers ───────────────────────────────────────────────────────────────────
/** Headers for the signed bootstrap calls. content-type is the SIGNED header — send it verbatim. */
export function jsonHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'user-agent': BROWSER_UA,
    origin: TUBI_WEB_ORIGIN,
    referer: `${TUBI_WEB_ORIGIN}/`,
  };
}

/** Headers for the token-authenticated catalog/programming GETs. */
export function bearerHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    'user-agent': BROWSER_UA,
    origin: TUBI_WEB_ORIGIN,
    referer: `${TUBI_WEB_ORIGIN}/`,
    'accept-language': 'en-US',
    'x-capability': '{"program_title_differ_with_episode_title": true}',
  };
}
