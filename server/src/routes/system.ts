// System maintenance resource (admin-only; mounted at /api/system) — the Settings → Data danger-zone /
// maintenance actions: rebuild MongoDB indexes across every collection, and reset the workspace (wipe the
// content collections, keep users/settings/videoconfigs). Thin handlers per restapi.md conventions.

import { Router } from 'express';
import type { Model } from 'mongoose';
import { ALL_MODELS } from '../backup/registry.js';
import { Playlist } from '../models/Playlist.js';
import { EpgSource } from '../models/EpgSource.js';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import { SourceChannel } from '../models/SourceChannel.js';
import { EpgChannel } from '../models/EpgChannel.js';
import { Program } from '../models/Program.js';
import { Cronjob } from '../models/Cronjob.js';
import { PlaylistAuth } from '../models/PlaylistAuth.js';
import { bootInitSources } from '../sources/seed.js';
import { removeAllCronjobs } from '../scheduler/index.js';
import { logger } from '../sources/core/logger.js';

export const systemRouter = Router();

// Reconcile indexes across every registered collection (drops stale indexes, builds current ones). The same
// syncIndexes() bootInitSources runs on a few collections, applied to ALL of them on demand. Best-effort:
// a per-model failure is collected, not fatal.
systemRouter.post('/rebuild-indexes', async (_req, res, next) => {
  try {
    const rebuilt: string[] = [];
    const errors: string[] = [];
    for (const model of ALL_MODELS) {
      try {
        await model.syncIndexes();
        rebuilt.push(model.modelName);
      } catch (err) {
        errors.push(`${model.modelName}: ${(err as Error).message}`);
      }
    }
    logger.info('mongodb', `rebuilt indexes on ${rebuilt.length} collection(s)${errors.length ? `, ${errors.length} error(s)` : ''}`);
    res.json({ rebuilt, errors });
  } catch (err) {
    next(err);
  }
});

// The content collections wiped by a workspace reset. KEEPS users, settings, videoconfigs (and sessions —
// so the admin performing the reset stays logged in). Order is not significant (each is an independent drop).
const RESET_COLLECTIONS: { name: string; model: Model<any> }[] = [
  { name: 'playlists', model: Playlist },
  { name: 'epgsources', model: EpgSource },
  { name: 'playlistchannels', model: PlaylistChannel },
  { name: 'sourcechannels', model: SourceChannel },
  { name: 'epgchannels', model: EpgChannel },
  { name: 'programs', model: Program },
  { name: 'cronjobs', model: Cronjob },
  { name: 'playlistauths', model: PlaylistAuth },
];

// Danger zone: permanently delete all playlists, EPG data, mappings, schedules and auth — back to an empty
// workspace. Keeps users + settings + video configs. Drops in-memory cron instances then re-runs the
// idempotent boot init (reconciles indexes, re-seeds the settings singleton).
systemRouter.post('/reset-workspace', async (_req, res, next) => {
  try {
    const cleared: Record<string, number> = {};
    for (const { name, model } of RESET_COLLECTIONS) {
      const result = await model.deleteMany({});
      cleared[name] = result.deletedCount ?? 0;
    }
    removeAllCronjobs();
    try {
      await bootInitSources();
    } catch (err) {
      logger.warn('settings', `boot init after workspace reset failed (continuing): ${(err as Error).message}`);
    }
    logger.warn('settings', `workspace reset: ${JSON.stringify(cleared)}`);
    res.json({ cleared });
  } catch (err) {
    next(err);
  }
});
