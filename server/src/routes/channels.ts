import { Router } from 'express';
import { PlaylistChannel } from '../models/PlaylistChannel.js';

export const channelsRouter = Router();

// GET /api/channels?source=<id> → the editable PlaylistChannel docs for a (Default) source playlist — the
// UI channel store, 1:1 with the runtime Channel shape (no projection). `source` is required. (The UI never
// reads the pristine SourceChannel reference store directly; this returns the same shape as
// GET /api/playlists/:id/channels.)
channelsRouter.get('/', async (req, res, next) => {
  try {
    const source = typeof req.query.source === 'string' ? req.query.source : null;
    if (!source) {
      return res.status(400).json({ error: 'source query parameter required' });
    }
    const docs = await PlaylistChannel.find({ source }, { _id: 0 })
      .sort({ group: 1, tvg_name: 1 })
      .lean();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});
