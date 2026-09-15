// Boot-time seed of the singleton settings doc: CHECK the settings collection for the existing singleton
// and, only if it is absent, populate it from the environment-variable defaults. Idempotent — uses
// $setOnInsert so a redeploy never clobbers values the operator has since changed in the UI. Called at the
// top of bootInitSources() (non-fatal). The env->external translation (and the runtime/patch maps) live in
// the translation layer (settings/translate.ts); this module is only the boot action that applies it.
//
// These are APP settings (operator-facing, persisted in Mongo) — distinct from infra config
// (mongoUri/port/logLevel in config.json via MASQUERADARR_CONFIG; see config.ts). The docker-compose `app`
// service passes the env vars.
//
// Also the one-way boot migration of the four per-source fields the playlist configuration replaced (dlhdPlayer,
// duloDomain, zliveDomain, zliveMaxStreams → playlistConfig) for a doc already in Mongo. (An older BACKUP's doc is
// upgraded before it is written instead — backup/registry.ts `upgrade` — because the restore's insert would
// strip the retired fields.)

import { Settings, SETTINGS_ID } from '../models/Settings.js';
import { envDefaults } from '../settings/translate.js';
import { LEGACY_PLAYLIST_FIELDS, playlistConfigFromLegacy } from './core/playlistConfig.js';
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
  await migrateLegacyPlaylistFields();
}

/**
 * Fold a pre-playlistConfig doc's dlhdPlayer / duloDomain / zliveDomain / zliveMaxStreams into playlistConfig
 * (keeping the operator's values; daddylive's domain takes the default — it was never a setting), then drop the
 * legacy fields. A no-op once migrated. The legacy paths are no longer in the schema: the lean read returns them
 * anyway (lean skips the schema), and the write passes `strict: false` — strict mode would silently strip them
 * from the $unset.
 */
async function migrateLegacyPlaylistFields(): Promise<void> {
  const raw = (await Settings.findOne({ _id: SETTINGS_ID }).lean()) as Record<string, unknown> | null;
  if (!raw) return;
  const hasLegacy = LEGACY_PLAYLIST_FIELDS.some((f) => f in raw);
  const needsConfig = raw.playlistConfig === undefined || raw.playlistConfig === null;
  if (!hasLegacy && !needsConfig) return;

  const update: Record<string, unknown> = {};
  if (needsConfig) update.$set = { playlistConfig: playlistConfigFromLegacy(raw) };
  if (hasLegacy) update.$unset = Object.fromEntries(LEGACY_PLAYLIST_FIELDS.map((f) => [f, '']));
  await Settings.updateOne({ _id: SETTINGS_ID }, update, { strict: false });
  logger.ok(
    'seed',
    needsConfig
      ? 'settings: migrated the legacy DaddyLive/dulo/zlive fields into the playlist configuration'
      : 'settings: dropped the legacy DaddyLive/dulo/zlive fields (playlist configuration already present)',
  );
}
