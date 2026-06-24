// Tubi stream resolution — resolve a channel into its freshly-minted HLS master URL. LAYERED, like the
// catalog: the signed uapi (./api/resolveStream.ts) is PRIMARY, the legacy web hop (resolveWebStream below)
// is the fallback (TUBI_USE_API=0 forces the web path).
//
// Tubi mints a short-lived JWT-signed manifest URL PER REQUEST, so (like dlhd) the stored entry URL is
// re-resolved at play time. Either path is one fetch plus a redirect-follow:
//
//   content_id (e.g. 613683)
//     ── GET <programming endpoint>?content_id=613683
//          → rows[0].video_resources[0].manifest.url   (live-manifest.production-public.tubi.io …?token=<JWT>)
//     ── GET that manifest → 302 → apollo → 302 → apollo-eks/live/<slug>.m3u8   (the real MASTER)
//
// We MUST return the FINAL (post-redirect) master URL: the master's variant URIs are RELATIVE, and the core
// proxy resolves a playlist's children against the URL it was handed (the pre-fetch upstreamUrl, not the
// post-redirect one — see core/proxyHandler.ts). So that URL must already be the apollo-eks master, not the
// live-manifest URL (a different host). Node's fetch follows the 302s and exposes the final URL as
// response.url. The JWT is short-lived → re-resolve per play (the proxy does this on each entry hit).

import { UA, TUBI_EPG_URL } from './catalog.js';
import { logger } from '../../core/logger.js';
import { resolveApiStream } from './api/resolveStream.js';
import { TUBI_USE_API } from './api/endpoints.js';

/** Extract the numeric Tubi content id from a number, "613683", or a …?content_id=613683 URL. */
export function contentId(input: string | number): string {
  if (typeof input === 'number' && Number.isInteger(input)) return String(input);
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/[?&]content_id=(\d+)/);
  if (!m) throw new Error(`Cannot determine Tubi content id from: ${input}`);
  return m[1];
}

/** Resolve a content id → the post-redirect apollo-eks master URL via the legacy WEB tier (the fallback path). */
async function resolveWebStream(id: string): Promise<{ masterUrl: string }> {
  // ── hop 1: pull the per-request signed manifest URL from the EPG endpoint ──
  const e = await fetch(`${TUBI_EPG_URL}?content_id=${id}`, { headers: { 'User-Agent': UA } });
  if (!e.ok) throw new Error(`epg fetch failed for ${id}: HTTP ${e.status}`);
  // Tubi's web tier returns a 200 HTML failsafe shell (not JSON) when its origin is erroring; guard the
  // content-type before .json() so a dead upstream reads as "Tubi upstream down" — not an opaque
  // "Unexpected token '<'" parse error (mirrors the ct.includes('json') guard in catalog.ts fetchEpgBatch).
  const ct = e.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    throw new Error(`Tubi EPG returned non-JSON (upstream failsafe/down) for ${id}: HTTP ${e.status} (${ct || 'no content-type'})`);
  }
  const body = (await e.json()) as { rows?: any[] };
  const row = (body.rows || [])[0];
  const manifestUrl: string | undefined = row?.video_resources?.[0]?.manifest?.url;
  if (!manifestUrl) throw new Error(`No manifest for content ${id} — not live or needs login`);

  // ── hop 2: follow the manifest's 302 chain to the real master (apollo-eks); response.url is the final URL ──
  const m = await fetch(manifestUrl, { headers: { 'User-Agent': UA } });
  if (!m.ok) throw new Error(`manifest fetch failed for ${id}: HTTP ${m.status}`);
  const masterUrl = m.url; // final URL after redirects — the apollo-eks master
  const master = await m.text();
  if (!master.startsWith('#EXTM3U')) {
    throw new Error(`Master is not an HLS playlist for ${id} (got: ${master.slice(0, 40)}…)`);
  }
  return { masterUrl };
}

/**
 * Resolve an entry (content id, or a …?content_id= entry URL) → the post-redirect apollo-eks master URL.
 * LAYERED: the signed uapi (primary) → the legacy web hop (fallback). Both key off the bare content id, so the
 * stored entry URL's host is cosmetic and no playlistchannels migration is needed.
 */
export async function resolveTubiStream(input: string | number): Promise<{ masterUrl: string }> {
  const id = contentId(input);
  if (TUBI_USE_API) {
    try {
      return await resolveApiStream(id);
    } catch (err) {
      logger.warn('core', `[tubi] uapi resolve failed for ${id} → web-tier fallback: ${(err as Error).message}`);
    }
  }
  return resolveWebStream(id);
}
