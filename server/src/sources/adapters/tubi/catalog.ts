// Tubi catalog fetch — the SINGLE place that returns the Tubi listing, now LAYERED:
//   1. the signed backend API (./api/catalog.ts — uapi.production-public.tubi.io) — PRIMARY,
//   2. the legacy web-tier scrape (fetchWebCatalog, below) — FALLBACK,
//   3. the committed offline snapshot (tubi.snapshot.json) — last resort.
// fetchTubiCatalog auto-fails-over: the uapi survives the web tier's CloudFront failsafe shell, and the web
// scrape survives a uapi/signing outage. Set TUBI_USE_API=0 to force the web path.
//
// The legacy web tier (kept as the fallback) lives in two endpoints:
//   1. GET https://tubitv.com/live  — HTML; embeds `window.__data = {…}` whose
//      epg.contentIdsByContainer maps each genre container → categories → channel content ids.
//   2. GET https://tubitv.com/oz/epg/programming?content_id=<csv up to 150>
//      — { rows:[…] }: per channel the title, logos, the signed HLS manifest URL, AND the full programs[]
//        guide. This is the public proxy in front of the same backend the uapi path hits directly.
//
// Tubi live is US-only — every path must run from US egress (the same constraint dlhd's mirror has). BOTH
// consumers share these rows: the source adapter (listChannels → normalize, ignores programs) and the EPG
// provider (epg/tubi.ts → writeTubiEpg, reads programs). The uapi and web rows are the SAME shape.

import { readFileSync } from 'node:fs';
import { snapshotFile } from '../../paths.js';
import { logger } from '../../core/logger.js';
import type { RawListing } from '../../types.js';
import { fetchApiCatalog } from './api/catalog.js';
import { TUBI_USE_API } from './api/endpoints.js';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export const TUBI_LIVE_URL = process.env.TUBI_LIVE_URL || 'https://tubitv.com/live';
export const TUBI_EPG_URL = process.env.TUBI_EPG_URL || 'https://tubitv.com/oz/epg/programming';

const SNAPSHOT = snapshotFile('tubi');
const EPG_BATCH = 150; // Tubi accepts up to ~150 content_ids per /oz/epg/programming call.
// Cross-cutting buckets that shouldn't win as a channel's primary group — a real genre beats these.
const META_GROUPS = new Set(['Recommended', 'Featured', 'Favorites', 'Recently Added', 'Popular']);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Pull the `window.__data = {…}` object out of the /live HTML and JSON-parse it. */
export function parseWindowData(html: string): any {
  const m = html.match(/window\.__data\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
  if (!m) throw new Error('window.__data not found in /live page (Tubi layout changed?)');
  // The embed has a couple of JS-isms that aren't valid JSON — normalize them first.
  const raw = m[1].replace(/\bundefined\b/g, 'null').replace(/new Date\("([^"]*)"\)/g, '"$1"');
  return JSON.parse(raw);
}

/**
 * From parsed window.__data, build an ordered unique channel-id list and an id→group map. A channel can
 * appear under several categories; a real genre overrides a generic meta bucket.
 */
export function buildGroupIndex(data: any): { groupById: Record<string, string>; ids: string[] } {
  const cibc = data?.epg?.contentIdsByContainer || {};
  const groupById: Record<string, string> = {};
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const categories of Object.values(cibc) as any[]) {
    if (!Array.isArray(categories)) continue;
    for (const cat of categories) {
      const name = cat?.name || 'Other';
      for (const cid of cat?.contents || []) {
        const id = String(cid);
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
        if (!(id in groupById) || (META_GROUPS.has(groupById[id]) && !META_GROUPS.has(name))) {
          groupById[id] = name;
        }
      }
    }
  }
  return { groupById, ids };
}

/**
 * Fetch one batch of EPG rows (channel metadata + manifest URL + programs) for up to 150 ids. Tubi
 * soft-rate-limits rapid callers by returning an HTML page on a 200, so a non-JSON 200 is retried with
 * backoff rather than failing the whole catalog.
 */
async function fetchEpgBatch(ids: string[]): Promise<any[]> {
  const url = `${TUBI_EPG_URL}?content_id=${encodeURIComponent(ids.join(','))}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      const ct = res.headers.get('content-type') || '';
      if (res.ok && ct.includes('json')) return ((await res.json()) as { rows?: any[] }).rows || [];
      lastErr = new Error(`epg HTTP ${res.status} (${ct || 'no content-type'})`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < 4) await sleep(800 * attempt);
  }
  throw lastErr;
}

/**
 * True when /live is Tubi's data-less FAILSAFE shell (served by CloudFront/S3 while the web origin errors).
 * The shell still embeds a window.__data with the normal schema, so it parses cleanly but lists no channels;
 * this marker is what distinguishes "Tubi upstream is down" from an actual page-layout change on our side.
 */
function isFailsafeShell(html: string): boolean {
  return html.includes('__FAILSAFE_DEVICE_ID__');
}

/**
 * Fetch the catalog from the legacy WEB TIER (the fallback path): parse /live for ids + groups, then batch the
 * EPG endpoint. Each returned row is augmented with its primary `group` so a per-record consumer (normalize /
 * writeTubiEpg) is sufficient. Replaced as the primary path by ./api/catalog.ts (fetchApiCatalog).
 */
export async function fetchWebCatalog(): Promise<RawListing> {
  const res = await fetch(TUBI_LIVE_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`live page HTTP ${res.status}`);
  const html = await res.text();
  // Tubi's web tier (tubitv.com via CloudFront/S3) serves a data-less FAILSAFE shell when its origin is
  // erroring (x-cache: Error from cloudfront). The page still parses — window.__data is present — but
  // carries no channel ids, so report "Tubi upstream is down" rather than blaming a markup/layout change.
  if (isFailsafeShell(html)) {
    throw new Error('Tubi web tier returned a failsafe/error shell (tubitv.com upstream down) — not a layout change');
  }
  const { groupById, ids } = buildGroupIndex(parseWindowData(html));
  if (!ids.length) throw new Error('no channel ids in window.__data (Tubi upstream down/failsafe, or layout changed)');

  const rows: any[] = [];
  for (let i = 0; i < ids.length; i += EPG_BATCH) {
    if (i > 0) await sleep(300); // pace batches to stay under Tubi's soft rate limit
    rows.push(...(await fetchEpgBatch(ids.slice(i, i + EPG_BATCH))));
  }
  if (!rows.length) throw new Error('epg returned no rows');

  const raw = rows.map((r) => ({ ...r, group: groupById[String(r.content_id)] || 'Other' }));
  return {
    raw,
    meta: {
      endpoint: TUBI_LIVE_URL,
      epgEndpoint: TUBI_EPG_URL,
      via: 'web',
      live: true,
      channelCount: raw.length,
      groupCount: new Set(Object.values(groupById)).size,
      fetchedAt: new Date().toISOString(),
    },
  };
}

/**
 * The shared entry point — LAYERED: uapi (primary) → web tier (fallback) → snapshot (last resort). Rows carry
 * channel meta, the signed manifest URL, AND the full programs[] guide regardless of which path served them.
 *   - allowSnapshot (default true): if BOTH live paths fail, read tubi.snapshot.json and return meta.live=false
 *     (so the playlist still lists channels offline — same posture as dlhd).
 *   - allowSnapshot=false: rethrow when both live paths fail. The EPG sync path uses this so a transient outage
 *     fails loudly (status 'error') instead of replacing a good guide with stale snapshot programs.
 */
export async function fetchTubiCatalog(opts: { allowSnapshot?: boolean } = {}): Promise<RawListing> {
  const allowSnapshot = opts.allowSnapshot !== false;
  const errors: string[] = [];

  // 1. uapi (primary) — the signed backend survives the web tier's CloudFront failsafe.
  if (TUBI_USE_API) {
    try {
      return await fetchApiCatalog();
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(`api: ${msg}`);
      logger.warn('seed', `[tubi] uapi catalog failed → web-tier fallback: ${msg}`);
    }
  }

  // 2. web tier (legacy scrape).
  try {
    return await fetchWebCatalog();
  } catch (err) {
    const msg = (err as Error).message;
    errors.push(`web: ${msg}`);
    if (!allowSnapshot) throw new Error(`tubi catalog failed (${errors.join(' | ')})`);
    // 3. committed snapshot (offline fallback).
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: any[] };
    return {
      raw: snap.channels || [],
      meta: {
        endpoint: TUBI_LIVE_URL,
        via: 'snapshot',
        live: false,
        fallback: 'tubi.snapshot.json',
        reason: errors.join(' | '),
        fetchedAt: new Date().toISOString(),
      },
    };
  }
}
