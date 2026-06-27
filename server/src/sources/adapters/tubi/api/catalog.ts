// Tubi uapi catalog — the backend equivalent of ../catalog.ts's web-tier scrape, in two calls:
//   1. GET tensor-cdn …/api/v2/epg?mode=tubitv_us_linear  → { containers:[{name,contents:[ids]}], contents:{} }
//      containers give the ordered channel-id list + each channel's primary group (replaces window.__data's
//      epg.contentIdsByContainer). We ignore `contents` here and re-fetch full rows from epg-cdn so each row
//      carries programs[] (tensor's contents omit the guide).
//   2. GET epg-cdn …/content/epg/programming?content_id=<csv>  → { rows:[…] } — each row carries content_id,
//      title, images, video_resources[0].manifest.url AND programs[]: the SAME shape ../catalog.ts produced,
//      so normalize()/writeTubiEpg() consume it unchanged. This is the public /oz/epg/programming's backend.
//
// Both calls go through tubiApiGet (Bearer + token-refresh). US-only egress, same as the web tier.

import { logger } from '../../../core/logger.js';
import type { RawListing } from '../../../types.js';
import { tubiApiGet } from './client.js';
import { getDeviceId } from './deviceToken.js';
import { tensorEpgUrl, epgProgrammingUrl, EPG_API_BATCH } from './endpoints.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Cross-cutting buckets that shouldn't win as a channel's primary group — a real genre beats these. Mirrors
// META_GROUPS in ../catalog.ts (kept local to avoid a cycle: ../catalog.ts imports this module).
const META_GROUPS = new Set(['Recommended', 'Featured', 'Favorites', 'Recently Added', 'Popular']);

/** From the tensor /api/v2/epg containers, build an ordered unique id list + an id→primary-group map. */
function buildGroupIndex(data: any): { groupById: Record<string, string>; ids: string[] } {
  const containers: any[] = Array.isArray(data?.containers) ? data.containers : [];
  const groupById: Record<string, string> = {};
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const c of containers) {
    const name = c?.name || 'Other';
    for (const cid of c?.contents || []) {
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
  return { groupById, ids };
}

/** Fetch one programming batch (≤ EPG_API_BATCH ids); retry a transient non-OK rather than failing all. */
async function fetchProgrammingBatch(ids: string[]): Promise<any[]> {
  const url = epgProgrammingUrl(getDeviceId(), ids.join(','));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await tubiApiGet(url);
      if (res.ok) return ((await res.json()) as { rows?: any[] }).rows || [];
      lastErr = new Error(`programming HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < 4) await sleep(800 * attempt);
  }
  throw lastErr;
}

/** Fetch the full LIVE catalog from the uapi: tensor for ids+groups, then batch epg-cdn programming for rows. */
export async function fetchApiCatalog(): Promise<RawListing> {
  const tRes = await tubiApiGet(tensorEpgUrl(getDeviceId()));
  if (!tRes.ok) throw new Error(`tensor epg HTTP ${tRes.status}`);
  const { groupById, ids } = buildGroupIndex(await tRes.json());
  if (!ids.length) throw new Error('no channel ids in tensor epg (uapi shape changed?)');

  const rows: any[] = [];
  for (let i = 0; i < ids.length; i += EPG_API_BATCH) {
    if (i > 0) await sleep(300); // pace batches, same posture as the web tier
    rows.push(...(await fetchProgrammingBatch(ids.slice(i, i + EPG_API_BATCH))));
  }
  if (!rows.length) throw new Error('uapi programming returned no rows');

  // Tag each row with its primary group. Per-program artwork (programs[].images) is KEPT here so writeTubiEpg
  // can map it to Program.icon (a richer XMLTV guide, U2); the committed snapshot strips it back out via the
  // adapter's snapshotTransform (it would ~double the offline file), so only the LIVE guide carries artwork.
  const raw = rows.map((r) => ({ ...r, group: groupById[String(r.content_id)] || 'Other' }));
  logger.info('seed', `[tubi] uapi catalog: ${raw.length} channels, ${new Set(Object.values(groupById)).size} groups`);
  return {
    raw,
    meta: {
      endpoint: tensorEpgUrl(getDeviceId()),
      via: 'api',
      live: true,
      channelCount: raw.length,
      groupCount: new Set(Object.values(groupById)).size,
      fetchedAt: new Date().toISOString(),
    },
  };
}
