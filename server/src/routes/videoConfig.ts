import { Router } from 'express';
import { VideoConfig, type VideoConfigDoc } from '../models/VideoConfig.js';
import { VIDEO_CONFIG_ID, toExternalVideoPatch, toRuntimeVideoConfig } from '../videoconfig/translate.js';
import { ensureVideoConfig } from '../videoconfig/provision.js';
import { invalidateVideoConfig } from '../videoconfig/runtime.js';

// Videoconfig for the externalPlayer engine (Settings → Video Configuration + the per-playlist editor). The id
// is 'app' (the global Default) or 'app_<playlistId>' (a per-playlist Custom config). GET ensures the row exists
// — 'app' seeds the default Remux args + the full sub-schema option defaults; 'app_<id>' seeds by copying 'app'
// (see provision.ts) — and returns it; PUT validates the body into a whitelisted $set; DELETE removes a custom
// doc (never 'app'). PUT/DELETE are admin-gated in index.ts (like PUT /api/settings). The /api/ext engine
// handler reads the resolved doc per stream-begin (5s cache), so a write takes effect on the next play (or
// immediately — we invalidate the cache here). `hwAccel.detected` is server-derived (boot hwDetect.ts), read-only.

export const videoConfigRouter = Router();

videoConfigRouter.get('/:id', async (req, res, next) => {
  try {
    const doc = await ensureVideoConfig(req.params.id);
    if (!doc) return next(new Error('videoconfig upsert returned no document'));
    res.json(toRuntimeVideoConfig(doc));
  } catch (err) {
    next(err);
  }
});

videoConfigRouter.put('/:id', async (req, res, next) => {
  try {
    const patch = toExternalVideoPatch(req.body);
    if (!patch.ok) return res.status(400).json({ error: patch.error });
    await ensureVideoConfig(req.params.id); // make sure the (possibly per-playlist) seeded row exists before patching
    const doc = (await VideoConfig.findByIdAndUpdate(
      req.params.id,
      { $set: patch.$set },
      { new: true },
    ).lean()) as VideoConfigDoc | null;
    if (!doc) return next(new Error('videoconfig update returned no document'));
    invalidateVideoConfig(req.params.id); // make the change visible on the next play (not just within the TTL)
    res.json(toRuntimeVideoConfig(doc));
  } catch (err) {
    next(err);
  }
});

// Delete a per-playlist Custom config. The global Default ('app') is never deletable. Idempotent (a missing
// doc is a no-op 204). The playlist lifecycle (routes/playlists.ts) is the normal caller — on switch to
// Default and on a custom-playlist cascade delete.
videoConfigRouter.delete('/:id', async (req, res, next) => {
  try {
    if (req.params.id === VIDEO_CONFIG_ID) return res.status(400).json({ error: 'cannot_delete_default' });
    await VideoConfig.deleteOne({ _id: req.params.id });
    invalidateVideoConfig(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
