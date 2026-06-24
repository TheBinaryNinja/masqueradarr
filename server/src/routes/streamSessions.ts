import { Router } from 'express';
import { StreamSession } from '../models/StreamSession.js';

export const streamSessionsRouter = Router();

// streamsessions holds one latest-ffprobe row per channel (1:1, keyed by _id = PlaylistChannel._id;
// StreamSessionDoc). Return the rows newest-probed first (each carries channelId; _id is projected out).
streamSessionsRouter.get('/', async (_req, res, next) => {
  try {
    const docs = await StreamSession.find({}, { _id: 0 }).sort({ capturedAt: -1 }).limit(500).lean();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});
