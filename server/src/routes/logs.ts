// /api/logs — the admin-only read/clear surface over the `logs` collection (append-only application log
// events written by the logger sink, server/src/logs/logStore.ts). Thin router over Log: every handler is
// async (req,res,next) + try/catch(next); reads use .lean() + { _id: 0 }; error bodies are
// { error: '<snake_case>' } with a descriptive 400 sentence. See .claude/skills/logs/SKILL.md §7 + restapi.md.

import { Router } from 'express';
import { Log, type LogLevel, type LogCategory } from '../models/Log.js';
import { LOG_CATEGORIES } from '../logs/categories.js';

export const logsRouter = Router();

const LEVELS: LogLevel[] = ['info', 'warn', 'error'];
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

// Build the Mongo filter from the optional query params, validating category/level. Returns the filter, or
// a string error message for an invalid value (→ 400).
function buildFilter(query: Record<string, unknown>): Record<string, unknown> | string {
  const filter: Record<string, unknown> = {};
  const { category, level, since } = query;
  if (typeof category === 'string' && category) {
    if (!LOG_CATEGORIES.includes(category as LogCategory)) return 'invalid category';
    filter.category = category;
  }
  if (typeof level === 'string' && level) {
    if (!LEVELS.includes(level as LogLevel)) return 'invalid level';
    filter.level = level;
  }
  if (typeof since === 'string' && since) {
    const n = Number(since);
    if (Number.isFinite(n)) filter.ts = { $gt: n };
  }
  return filter;
}

// GET /api/logs — newest-first, filtered by optional category / level / since (epoch-ms) / limit.
logsRouter.get('/', async (req, res, next) => {
  try {
    const filter = buildFilter(req.query as Record<string, unknown>);
    if (typeof filter === 'string') {
      res.status(400).json({ error: filter });
      return;
    }
    const raw = Number((req.query as Record<string, unknown>).limit);
    const limit = Number.isFinite(raw) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(raw))) : DEFAULT_LIMIT;
    const docs = await Log.find(filter, { _id: 0 }).sort({ ts: -1 }).limit(limit).lean();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/logs — admin clear, honoring the same optional category/level/since filter for scoped clears.
logsRouter.delete('/', async (req, res, next) => {
  try {
    const filter = buildFilter(req.query as Record<string, unknown>);
    if (typeof filter === 'string') {
      res.status(400).json({ error: filter });
      return;
    }
    const result = await Log.deleteMany(filter);
    res.json({ deleted: result.deletedCount ?? 0 });
  } catch (err) {
    next(err);
  }
});
