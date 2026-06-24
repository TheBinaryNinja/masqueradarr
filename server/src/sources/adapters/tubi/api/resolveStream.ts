// Tubi uapi stream resolution — the backend equivalent of ../resolveStream.ts's web hop. Tubi mints a
// short-lived JWT-signed manifest URL per request, so we re-resolve at play time:
//
//   content_id
//     ── GET epg-cdn …/content/epg/programming?content_id=<id>  (Bearer)
//          → rows[0].video_resources[0].manifest.url   (live-manifest.production-public.tubi.io …?token=<JWT>)
//     ── GET that manifest → 302 → apollo → 302 → apollo-eks/live/<slug>.m3u8   (the real MASTER)
//
// We return the FINAL (post-redirect) apollo-eks master URL so the core proxy resolves the master's relative
// variant URIs against the right host (same invariant as the web path). All hosts are under *.tubi.io, already
// covered by the adapter's static SSRF allowlist — no allowlist growth needed.

import { BROWSER_UA } from './endpoints.js';
import { epgProgrammingUrl } from './endpoints.js';
import { tubiApiGet } from './client.js';
import { getDeviceId } from './deviceToken.js';

/** Resolve a numeric content id → the post-redirect apollo-eks master URL via the uapi programming endpoint. */
export async function resolveApiStream(id: string): Promise<{ masterUrl: string }> {
  // ── hop 1: programming endpoint (single id) → per-request signed manifest URL ──
  const e = await tubiApiGet(epgProgrammingUrl(getDeviceId(), id));
  if (!e.ok) throw new Error(`uapi programming fetch failed for ${id}: HTTP ${e.status}`);
  const body = (await e.json()) as { rows?: any[] };
  const manifestUrl: string | undefined = (body.rows || [])[0]?.video_resources?.[0]?.manifest?.url;
  if (!manifestUrl) throw new Error(`No manifest for content ${id} — not live or needs login`);

  // ── hop 2: follow the manifest's 302 chain to the real master (apollo-eks); response.url is the final URL ──
  const m = await fetch(manifestUrl, { headers: { 'User-Agent': BROWSER_UA } });
  if (!m.ok) throw new Error(`manifest fetch failed for ${id}: HTTP ${m.status}`);
  const masterUrl = m.url;
  const master = await m.text();
  if (!master.startsWith('#EXTM3U')) {
    throw new Error(`Master is not an HLS playlist for ${id} (got: ${master.slice(0, 40)}…)`);
  }
  return { masterUrl };
}
