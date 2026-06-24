import { Router } from 'express';
import { Settings, SETTINGS_ID, type SettingsDoc } from '../models/Settings.js';
import { envDefaults, toRuntimeSettings, toExternalPatch } from '../settings/translate.js';
import { applyDnsFromSettings } from '../settings/applyDns.js';
import { cascadePlaylistUrls } from './playlists.js';
import { logger } from '../sources/core/logger.js';

// Singleton operator settings. Every read and write crosses the internal<->external boundary through the
// translation layer (settings/translate.ts): GET projects the stored doc into the runtime shape
// (toRuntimeSettings), PUT validates the body into a whitelisted $set patch (toExternalPatch), and both
// seed missing fields from env defaults (envDefaults). GET creates the row from those defaults on first
// read; the boot path seeds it earlier (sources/seedSettings.ts). The server-rendered B-Roll stream reads
// `displayName`; every hosted endpoint derives from `domain` — so the SPA persists them (no longer
// frontend-only refs). See restapi-client.md / useSettings.ts.
//
// Changing `domain` cascades to every playlist's persisted `url` (HOSTED AT) — both Global- and
// Custom-endpoint playlists prepend the global domain — so the stored urls always reflect the current
// domain. This is the one sanctioned settings->playlists write cascade (see cascadePlaylistUrls).

export const settingsRouter = Router();

settingsRouter.get('/', async (_req, res, next) => {
  try {
    const doc = (await Settings.findOneAndUpdate(
      { _id: SETTINGS_ID },
      { $setOnInsert: envDefaults() },
      { upsert: true, new: true },
    ).lean()) as SettingsDoc | null;
    if (!doc) return next(new Error('settings upsert returned no document'));
    res.json(toRuntimeSettings(doc));
  } catch (err) {
    next(err);
  }
});

settingsRouter.put('/', async (req, res, next) => {
  try {
    const patch = toExternalPatch(req.body);
    if (!patch.ok) return res.status(400).json({ error: patch.error });
    const $set = patch.$set;

    // Read the current domain before the write so a domain change can cascade to playlist urls.
    const prevDomain =
      typeof $set.domain === 'string'
        ? (await Settings.findOne({ _id: SETTINGS_ID }, { domain: 1 }).lean())?.domain ?? null
        : null;

    // Seed defaults only for fields not being $set this call — $set and $setOnInsert may not touch the
    // same path (Mongo rejects the conflict).
    const $setOnInsert: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(envDefaults())) {
      if (!(k in $set)) $setOnInsert[k] = v;
    }
    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($setOnInsert).length) update.$setOnInsert = $setOnInsert;

    const doc = (await Settings.findOneAndUpdate({ _id: SETTINGS_ID }, update, {
      upsert: true,
      new: true,
    }).lean()) as SettingsDoc | null;
    if (!doc) return next(new Error('settings upsert returned no document'));

    // Cascade: rewrite every playlist's persisted url to the new domain (path preserved).
    if (typeof $set.domain === 'string' && prevDomain !== $set.domain) {
      await cascadePlaylistUrls($set.domain);
    }

    // Re-apply the outbound-fetch DNS dispatcher when the nameserver(s) or trace level changed.
    // Best-effort — a re-apply hiccup must NOT fail the write (same contract as the domain cascade).
    if ('nameservers' in $set || 'dnsLogLevel' in $set) {
      try {
        await applyDnsFromSettings('update');
      } catch (err) {
        logger.error('settings', `dns re-apply after settings update failed (continuing): ${(err as Error).message}`);
      }
    }

    res.json(toRuntimeSettings(doc));
  } catch (err) {
    next(err);
  }
});
