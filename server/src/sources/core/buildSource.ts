// The generic "standard function" pipeline, run once per source for a LIVE sync:
//   listChannels() → raw upstream records  → normalize(raw) → one SourceChannel doc each
//   → dedupe by deterministic _id (last wins, idempotent) → return docs for upsert.
//
// Ported from d-combine/lib/core/build-source.mjs, but returns the docs instead of writing files —
// the seed module upserts them into Mongo. The whole file is source-agnostic.

import { logger } from './logger.js';
import type { SourceAdapter } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

export interface BuildResult {
  id: string;
  count: number;
  docs: SourceChannelDoc[];
  // The untyped upstream listing this build consumed, passed through verbatim so a post-sync hook
  // (adapter.afterSync — e.g. tubi's embedded EPG) can reuse it without re-fetching the upstream.
  raw: any[];
  live: boolean;
  meta: Record<string, unknown>;
}

export async function buildSource(adapter: SourceAdapter): Promise<BuildResult> {
  const startedAt = Date.now();
  logger.info('build', `[${adapter.id}] fetching channel listings…`);

  const { raw, meta = {} } = await adapter.listChannels();
  if (meta.live === false) {
    // Live fetch failed → snapshot fallback. This is exactly what flips the playlist to 'warn', so log WHY
    // (meta.reason) at warn level — an unexplained "offline snapshot" line is what made a Tubi upstream
    // outage look like a local/DNS bug. Source-agnostic: every adapter that sets meta.reason benefits.
    logger.warn(
      'build',
      `[${adapter.id}] got ${raw.length} raw records (offline snapshot)` +
        (meta.reason ? ` — live fetch failed: ${String(meta.reason)}` : ''),
    );
  } else {
    logger.info('build', `[${adapter.id}] got ${raw.length} raw records (live)`);
  }

  const ingestedAt = new Date().toISOString();
  const normalized: SourceChannelDoc[] = [];
  for (const record of raw) {
    try {
      const doc = adapter.normalize(record, { ingestedAt });
      if (doc) normalized.push(doc);
    } catch (err) {
      logger.warn('build', `[${adapter.id}] skipped a record: ${(err as Error).message}`);
    }
  }

  // Dedupe by deterministic _id (last wins) — guards against duplicate upstream rows.
  const byId = new Map<string, SourceChannelDoc>();
  for (const doc of normalized) byId.set(doc._id, doc);
  const docs = [...byId.values()];

  logger.ok('build', `[${adapter.id}] normalized ${docs.length} docs`);
  return {
    id: adapter.id,
    count: docs.length,
    docs,
    raw,
    live: meta.live !== false,
    meta: { ...meta, buildMs: Date.now() - startedAt },
  };
}
