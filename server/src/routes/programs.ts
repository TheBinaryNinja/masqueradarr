import { Router } from 'express';
import { Program } from '../models/Program.js';

export const programsRouter = Router();

const HOUR_MS = 3_600_000;
const MAX_CHANNEL_IDS = 500; // per-request cap; the SPA batches larger sets (see fetchProgramsFor)

// Programs for a SCOPED set of channels within a time window, grouped by channelId — matches the
// EPG_PROGRAMS shape the SPA expects. This deliberately REFUSES an unscoped request (it used to dump
// the entire collection, which blew up boot for large guides like Jesmann). Callers pass exactly the
// channels they're about to render. Covered by the {channelId:1, start:1} index.
//   ?channelIds=<csv of "<source>:<id>">   (required)
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
    const now = Date.now();
    const fromRaw = Number((req.query as Record<string, unknown>).from);
    const toRaw = Number((req.query as Record<string, unknown>).to);
    const from = Number.isFinite(fromRaw) ? fromRaw : now - 2 * HOUR_MS;
    const to = Number.isFinite(toRaw) ? toRaw : now + 24 * HOUR_MS;
    // Overlap test (not containment) so a program straddling a window edge still appears.
    const docs = await Program.find(
      { channelId: { $in: ids }, start: { $lt: to }, end: { $gt: from } },
      { _id: 0 },
    ).sort({ channelId: 1, start: 1 }).lean();
    const grouped: Record<string, Array<{ start: number; end: number; title: string; cat: string }>> = {};
    for (const d of docs) {
      const list = grouped[d.channelId] ?? (grouped[d.channelId] = []);
      list.push({ start: d.start, end: d.end, title: d.title, cat: d.cat });
    }
    res.json(grouped);
  } catch (err) {
    next(err);
  }
});
