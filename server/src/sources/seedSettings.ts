// Boot-time seed of the singleton settings doc: CHECK the settings collection for the existing singleton
// and, only if it is absent, populate it from the environment-variable defaults. Idempotent — uses
// $setOnInsert so a redeploy never clobbers values the operator has since changed in the UI. Called at the
// top of bootInitSources() (non-fatal). The env->external translation (and the runtime/patch maps) live in
// the translation layer (settings/translate.ts); this module is only the boot action that applies it.
//
// These are APP settings (operator-facing, persisted in Mongo) — distinct from infra config
// (mongoUri/port/logLevel in config.json via MASQUERADARR_CONFIG; see config.ts). The docker-compose `app`
// service passes the env vars.

import { Settings, SETTINGS_ID } from '../models/Settings.js';
import { envDefaults } from '../settings/translate.js';
import { logger } from './core/logger.js';

/** Seed the singleton settings doc from env defaults ONLY if it does not already exist (idempotent). */
export async function seedSettings(): Promise<void> {
  const result = await Settings.updateOne(
    { _id: SETTINGS_ID },
    { $setOnInsert: envDefaults() },
    { upsert: true },
  );
  if (result.upsertedCount > 0) {
    logger.ok('seed', 'settings: no existing doc — seeded singleton from env defaults');
  } else {
    logger.info('seed', 'settings: existing doc found — keeping persisted values');
  }
}
