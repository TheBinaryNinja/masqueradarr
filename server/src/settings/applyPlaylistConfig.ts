// Bridge between the persisted `settings` singleton and the playlist configuration (Settings.playlistConfig —
// Settings → Advanced → Playlist Domain / Configuration). Reads the stored config, caches it in
// sources/core/playlistConfig.ts (which pushes each value into its source's Mongo-free config leaf, so the hot
// resolve paths read it with NO DB hit), and mirrors it to playlist-config.json. Called after connect (boot, source
// 'mongo'), on every Settings PUT that carries playlistConfig (source 'update'), and after a backup restore
// ('mongo'). The one bridge for every operator-set source knob — it replaced applyDlhdPlayer, applyDuloDomain and
// applyZlive.
//
// A CHANGED dulo domain on 'update' cascades twice (the old applyDuloDomain contract):
//   · resetSupabaseDiscovery() — the cached Supabase project pair was scraped from the OLD site and its cooldown
//     would otherwise suppress a re-scrape for minutes.
//   · duloAuth.signOut()      — a captured session belongs to the domain it was captured on; rather than letting
//     playback fail opaquely later, drop it and send the operator back through the pairing flow.
// Boot and restore ('mongo') NEVER sign out — they only hydrate the cache from what is already stored. A changed
// zlive domain needs no cascade here: the leaf bumps its domain epoch, and the resolver drops its per-slug cache and
// decoy state on its next call.
//
// The FILE is a mirror, not an input: Mongo stays authoritative (backups carry it), and the file is rewritten from
// it on every apply — a hand edit to the file is overwritten at the next boot. It sits beside the infra config file
// (config.ts configDir(); override with MASQUERADARR_PLAYLIST_CONFIG), never under the publicly served composeDir.
// A failed write is logged, never fatal.

import { join } from 'node:path';
import { Settings, SETTINGS_ID } from '../models/Settings.js';
import { configDir } from '../config.js';
import { atomicWrite, withPathLock } from '../m3u/atomicFile.js';
import {
  applyPlaylistConfig,
  defaultPlaylistConfig,
  serializePlaylistConfig,
  validatePlaylistConfig,
  type PlaylistConfig,
  type PlaylistConfigChanges,
} from '../sources/core/playlistConfig.js';
import { resetSupabaseDiscovery } from '../sources/adapters/dulo/supabaseConfig.js';
import { duloAuth } from '../sources/adapters/dulo/auth.js';
import { logger } from '../sources/core/logger.js';

const tag = 'settings';

/** Where the playlist-config.json mirror is written. */
export function playlistConfigFilePath(): string {
  return process.env.MASQUERADARR_PLAYLIST_CONFIG || join(configDir(), 'playlist-config.json');
}

async function writeMirror(cfg: PlaylistConfig): Promise<void> {
  let path = '';
  try {
    path = playlistConfigFilePath();
    await withPathLock(path, () => atomicWrite(path, serializePlaylistConfig(cfg)));
  } catch (err) {
    logger.warn(tag, `playlist config: could not write the file mirror ${path || '(no path)'}: ${(err as Error).message}`);
  }
}

export async function applyPlaylistConfigFromSettings(
  source: 'mongo' | 'update',
): Promise<{ config: PlaylistConfig; changes: PlaylistConfigChanges }> {
  const doc = (await Settings.findOne({ _id: SETTINGS_ID }, { playlistConfig: 1 }).lean()) as {
    playlistConfig?: unknown;
  } | null;

  let config: PlaylistConfig;
  const parsed = validatePlaylistConfig(doc?.playlistConfig);
  if (parsed.ok) {
    config = parsed.config;
  } else {
    config = defaultPlaylistConfig();
    if (doc?.playlistConfig !== undefined) {
      logger.warn(tag, `playlist config: stored value is invalid (${parsed.errors.join('; ')}) — using the defaults`);
    }
  }

  const changes = applyPlaylistConfig(config);

  if (changes.duloDomain && source === 'update') {
    resetSupabaseDiscovery();
    await duloAuth.signOut();
    logger.warn('dulo:auth', `dulo domain changed to ${config.dulo.domain} — session signed out, re-pair required`);
  } else if (changes.duloDomain) {
    logger.info('dulo:auth', `dulo domain set to ${config.dulo.domain}`);
  }
  if (changes.zliveDomain) {
    logger[source === 'update' ? 'warn' : 'info'](
      'zlive',
      source === 'update'
        ? `zlive domain changed to ${config.zlive.domain} — resolver cache and decoy state reset; re-sync the ZLive playlist to refresh its catalog`
        : `zlive domain set to ${config.zlive.domain}`,
    );
  }
  if (changes.dlhdDomain) {
    logger.info('dlhd', `DaddyLive domain set to ${config.daddylive.domain}`);
  }
  if (source === 'update') {
    if (changes.dlhdPlayer) {
      logger.info('dlhd', `default player set to ${config.daddylive.extendedProperties.defaultPlayer}`);
    }
    if (changes.zliveConcurrency) {
      const cap = config.zlive.extendedProperties.concurrency;
      logger.info('zlive', `zlive stream cap set to ${cap === 0 ? 'unlimited' : cap}`);
    }
    for (const key of changes.enable) {
      logger.info(tag, `playlist config: ${key} ${config[key].enable ? 'enabled' : 'hidden (enable: false)'}`);
    }
  }

  await writeMirror(config);
  return { config, changes };
}
