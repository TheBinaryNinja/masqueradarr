// Channel-probe resource — the manual trigger + status read for the scheduled channel sweep
// (sources/probeAll.ts, PRB). Admin-only (gated in index.ts's adminOnlyRoutes, like /api/active-streams). The
// recurring schedule itself lives in the cronjobs collection (targetType:'channel-probe', targetId:'app') and
// is managed via /api/cronjobs — this router only fires an immediate run and reports the live run state. See
// restapi.md.

import { Router } from 'express';
import { probeAllChannels, getProbeStatus } from '../sources/probeAll.js';
import { logger } from '../sources/core/logger.js';

export const probeRouter = Router();

// Current sweep state (initial paint / poll while a run is in flight).
probeRouter.get('/status', async (_req, res, next) => {
  try {
    res.json(getProbeStatus());
  } catch (err) {
    next(err);
  }
});

// Trigger a sweep now. 202 when started; 409 when one is already running (the sweep self-guards too).
probeRouter.post('/run', async (_req, res, next) => {
  try {
    if (getProbeStatus().running) return res.status(409).json({ error: 'probe_running' });
    // Fire-and-forget — a sweep can run for a while (resolve is per-channel). Swallow its rejection here (the
    // scheduler path surfaces errors via lastError; there's no request left to fail on a background run).
    void probeAllChannels().catch((err) => logger.error('probe', `sweep error: ${(err as Error).message}`));
    res.status(202).json({ started: true });
  } catch (err) {
    next(err);
  }
});
