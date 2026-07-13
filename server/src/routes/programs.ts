import { Router } from 'express';
import { fetchProgramsGrouped, MAX_CHANNEL_IDS } from '../epg/queryPrograms.js';

export const programsRouter = Router();

// Programs for a SCOPED set of channels within a time window, grouped by channelId — matches the
// EPG_PROGRAMS shape the SPA expects. This deliberately REFUSES an unscoped request (it used to dump
// the entire collection, which blew up boot for large guides like Jesmann). Callers pass exactly the
// channels they're about to render. The query + grouping live in ../epg/queryPrograms (also reused by
// the user-scoped /api/playlists/:id/programs route).
//   ?channelIds=<csv of "<epg>:<tvg_id>">   (required)
//   ?from=<epoch-ms>  ?to=<epoch-ms>        (optional window; defaults to a bounded now-relative span)
programsRouter.get('/', async (req, res, next) => {
  try {
    const raw = typeof req.query.channelIds === 'string' ? req.query.channelIds : '';
    const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length === 0) {
      res.status(400).json({ error: 'channel_ids_required' });
      return;
    }
    if (ids.length > MAX_CHANNEL_IDS) {
      res.status(400).json({ error: 'too_many_channel_ids' });
      return;
    }
    const from = Number((req.query as Record<string, unknown>).from);
    const to = Number((req.query as Record<string, unknown>).to);
    res.json(await fetchProgramsGrouped(ids, from, to));
  } catch (err) {
    next(err);
  }
});
