import { Router } from 'express';
import { getLatestSystemStats } from '../stats/systemStatsHub.js';

export const systemStatsRouter = Router();

// Latest in-memory system-performance snapshot (no DB read — served from the hub's cache, like
// /api/active-streams). The LIVE feed is the /api/system-stats WebSocket (stats/systemStatsHub.ts); this GET
// gives the Dashboard an instant first paint + a WS-less fallback. Admin-only (operator data). Returns null
// only in the first ~2.5s after boot, before the first tick has run.
systemStatsRouter.get('/', (_req, res) => {
  res.json(getLatestSystemStats());
});
