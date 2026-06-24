// Cron job resource — CRUD over the `cronjobs` collection (models/Cronjob.ts). A job is keyed by a
// deterministic _id = "<targetType>:<targetId>" (composed server-side via cronjobId); the URL param is the
// `:targetId` (the client percent-encodes it). PUT upserts + (re)registers with the scheduler; DELETE
// removes + unschedules. Today targetType defaults to 'epg-source'. See restapi.md + schemas.md §3.13.

import { Router } from 'express';
import { Cronjob, cronjobId, type CronjobDoc, type CronFrequency } from '../models/Cronjob.js';
import { isValidCron, applyCronjob, removeCronjob } from '../scheduler/index.js';

export const cronjobsRouter = Router();

const DEFAULT_TARGET_TYPE = 'epg-source';

function targetTypeFrom(v: unknown): string {
  return typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_TARGET_TYPE;
}

// List all cron jobs.
cronjobsRouter.get('/', async (_req, res, next) => {
  try {
    const docs = await Cronjob.find({}, { _id: 0 }).lean();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// One target's cron job (targetType defaults to epg-source via ?targetType=).
cronjobsRouter.get('/:targetId', async (req, res, next) => {
  try {
    const id = cronjobId(targetTypeFrom(req.query.targetType), req.params.targetId);
    const doc = (await Cronjob.findById(id, { _id: 0 }).lean()) as CronjobDoc | null;
    if (!doc) return res.status(404).json({ error: 'not_found' });
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// Create or update (upsert) a target's cron job, then (re)register it with the scheduler.
cronjobsRouter.put('/:targetId', async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const targetType = targetTypeFrom(b.targetType);
    const targetId = req.params.targetId;

    const cron = typeof b.cron === 'string' ? b.cron.trim() : '';
    if (!cron || !isValidCron(cron)) {
      return res.status(400).json({ error: 'cron (valid 5-field expression) required' });
    }
    if (typeof b.frequency !== 'object' || b.frequency === null || typeof (b.frequency as CronFrequency).mode !== 'string') {
      return res.status(400).json({ error: 'frequency (object with a mode) required' });
    }
    const frequency = b.frequency as CronFrequency;
    // The channel-probe sweep has a once-per-hour minimum (a full ffprobe pass is heavy) — reject the
    // sub-hourly 'minutes' mode. Defense-in-depth: the Settings UI only offers hourly/daily/weekly.
    if (targetType === 'probe-all' && frequency.mode === 'minutes') {
      return res.status(400).json({ error: 'probe schedule minimum frequency is hourly' });
    }
    const timezone = typeof b.timezone === 'string' && b.timezone ? b.timezone : null;
    const enabled = typeof b.enabled === 'boolean' ? b.enabled : true;

    const _id = cronjobId(targetType, targetId);
    const now = new Date().toISOString();
    const doc = (await Cronjob.findOneAndUpdate(
      { _id },
      {
        $set: { targetType, targetId, cron, frequency, timezone, enabled, updatedAt: now },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true, new: true },
    ).lean()) as CronjobDoc;

    await applyCronjob(doc); // (re)schedule + persist nextRun
    const fresh = (await Cronjob.findById(_id, { _id: 0 }).lean()) as CronjobDoc;
    res.json(fresh);
  } catch (err) {
    next(err);
  }
});

// Delete a target's cron job + unschedule it.
cronjobsRouter.delete('/:targetId', async (req, res, next) => {
  try {
    const _id = cronjobId(targetTypeFrom(req.query.targetType), req.params.targetId);
    const result = await Cronjob.deleteOne({ _id });
    removeCronjob(_id);
    if (result.deletedCount === 0) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
