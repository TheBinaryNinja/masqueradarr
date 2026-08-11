// Boot-time seed of the (Default) proxy-config singleton (_id:'app'): CHECK the proxyconfigs collection and,
// only if the Default is absent, populate it from the env defaults. Idempotent — uses $setOnInsert so a
// redeploy never clobbers values the operator has since changed in the UI. Called from bootInitSources()
// (non-fatal), right after seedSettings(). Per-playlist Custom rows (app_<playlistId>) are NOT seeded — they
// are created on demand when the operator customizes a playlist. The env->external translation lives in the
// translation layer (proxyconfig/translate.ts); this module is only the boot action that applies it.

import { ProxyConfig, PROXY_CONFIG_DEFAULT_ID } from '../models/ProxyConfig.js';
import { envDefaults } from './translate.js';
import { logger } from '../sources/core/logger.js';

/** Seed the (Default) proxy-config singleton from env defaults ONLY if it does not already exist. */
export async function seedProxyConfig(): Promise<void> {
  const result = await ProxyConfig.updateOne(
    { _id: PROXY_CONFIG_DEFAULT_ID },
    { $setOnInsert: envDefaults() },
    { upsert: true },
  );
  if (result.upsertedCount > 0) {
    logger.ok('seed', 'proxy config: no Default doc — seeded (app) from env defaults');
  } else {
    logger.info('seed', 'proxy config: existing Default found — keeping persisted values');
  }

  // MIGRATION: drop the removed 'Ad Breaks' knob (adPolicy: 'passthrough' | 'replace'). Ad breaks are now
  // always served as the provider sent them; smoothing the seam is spliceNormalize's job. Mongoose's strict
  // mode already hides an unknown path on read, so this is not about correctness — it is about not carrying a
  // dead key through config exports and backup restores forever. Runs on EVERY boot (cheap: a no-op once the
  // field is gone) rather than gated behind a version marker the collection does not have.
  //
  // `strict: false` is LOAD-BEARING, not defensive. `adPolicy` is — correctly — absent from the schema, and
  // Mongoose's strict UPDATE casting deletes unknown paths from the update document: the `$unset` is emptied,
  // the emptied `$unset` operator is then dropped, and `updateMany` returns `{ acknowledged: false }` without
  // ever reaching the database. Worse, that return shape carries no `modifiedCount`, so `undefined > 0` is
  // false and the success log below can never fire either — a migration that silently does nothing and
  // silently says nothing. (mongoose 8: castUpdate.js `skip = isStrict && !schematype …` → `delete obj[key]`,
  // then `isEmptyObject(val)` → `delete ret[op]`, then query.js returns before the driver call.)
  const pruned = await ProxyConfig.updateMany(
    { adPolicy: { $exists: true } },
    { $unset: { adPolicy: '' } },
    { strict: false },
  );
  if (!pruned.acknowledged) {
    // The failure this migration already had once. Named rather than swallowed, so the next person who
    // re-tightens the options learns it from a log line instead of from a stale key in a config export.
    logger.warn('seed', 'proxy config: adPolicy migration was cast away before reaching the database — not applied');
  } else if (pruned.modifiedCount > 0) {
    logger.ok('seed', `proxy config: dropped the removed adPolicy field from ${pruned.modifiedCount} doc(s)`);
  }
}
