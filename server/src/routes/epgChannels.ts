import { Router } from 'express';
import { EpgChannel } from '../models/EpgChannel.js';

export const epgChannelsRouter = Router();

// All EPG guide channels (read-only list) — the per-source epgchannels store, surfaced to the SPA's Channel
// Mapping screen (the right-hand "EPG channel IDs" list). Returns the docs verbatim ({ _id: 0 }); an optional
// `?source=<id>` narrows to one EPG source (covered by the { source: 1 } index). Sorted source → affiliateName.
epgChannelsRouter.get('/', async (req, res, next) => {
  try {
    const source = typeof req.query.source === 'string' && req.query.source ? req.query.source : null;
    const filter = source ? { source } : {};
    const docs = await EpgChannel.find(filter, { _id: 0 }).sort({ source: 1, affiliateName: 1 }).lean();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});
