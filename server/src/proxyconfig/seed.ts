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
}
