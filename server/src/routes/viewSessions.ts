import { Router } from 'express';
import type { PipelineStage } from 'mongoose';
import { ViewSession } from '../models/ViewSession.js';

export const viewSessionsRouter = Router();

// One per-user rollup row (1:1 with the SPA's UserMetric interface). `username` falls back to
// 'unknown' for sessions with no resolved account. Never includes the user's stream token.
interface UserMetricRow {
  username: string;
  totalSessions: number;
  totalDurationMs: number;
  totalBytes: number;
  avgQoe: number;
  goodSessions: number;
  warnSessions: number;
  badSessions: number;
}

// Aggregate watch stats by username
viewSessionsRouter.get('/user-metrics', async (_req, res, next) => {
  try {
    const pipeline: PipelineStage[] = [
      {
        $group: {
          _id: '$username',
          totalSessions: { $sum: 1 },
          totalDurationMs: { $sum: '$durationMs' },
          totalBytes: { $sum: '$bytesTotal' },
          avgQoe: { $avg: '$qoeScore' },
          goodSessions: { $sum: { $cond: [{ $eq: ['$health', 'good'] }, 1, 0] } },
          warnSessions: { $sum: { $cond: [{ $eq: ['$health', 'warn'] }, 1, 0] } },
          badSessions: { $sum: { $cond: [{ $eq: ['$health', 'bad'] }, 1, 0] } }
        }
      },
      {
        $project: {
          username: { $ifNull: ['$_id', 'unknown'] },
          _id: 0,
          totalSessions: 1,
          totalDurationMs: 1,
          totalBytes: 1,
          avgQoe: { $round: ['$avgQoe', 1] },
          goodSessions: 1,
          warnSessions: 1,
          badSessions: 1
        }
      },
      { $sort: { totalDurationMs: -1 } }
    ];
    const metrics = await ViewSession.aggregate<UserMetricRow>(pipeline);
    res.json(metrics);
  } catch (err) {
    next(err);
  }
});

// viewsessions is the per-viewer watch-session history (ViewSessionDoc) written by the stats layer when a
// client's session ends. Return the most recent rows (newest first) for the History/Metrics screen — its
// session table, buffer histogram, problem-channels, and QoE all derive from these.
viewSessionsRouter.get('/', async (_req, res, next) => {
  try {
    const docs = await ViewSession.find({}, { _id: 0 }).sort({ startedAt: -1 }).limit(500).lean();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});
