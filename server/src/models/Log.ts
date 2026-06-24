import { Schema, model } from 'mongoose';

// logs — the application log store (append-only events). Written by the injected logger sink
// (server/src/logs/logStore.ts ← server/src/sources/core/logger.ts), read by GET /api/logs, and tailed live
// over the /api/logs-stream WebSocket. The source-agnostic core logger never imports this model; the logs/
// subsystem injects persistence so the core stays DB-free (the same cardLookup/makePersistProbe pattern).
// See .claude/skills/logs/SKILL.md (the contract) + schemas.md.
//
// Two load-bearing invariants:
//   1. Default ObjectId _id. Logs are append-only events, NOT sync-upserted docs — so they use Mongoose's
//      default ObjectId, the deliberate exception to the repo's deterministic-_id rule (which applies only to
//      synced collections like sourcechannels/playlistchannels).
//   2. Dual ts / createdAt. A MongoDB TTL index needs a BSON Date, but the rest of the app speaks epoch-ms
//      (ViewSession.startedAt, Program.start/end). So `ts` (number) is the field the route filters/sorts on
//      and the SPA renders; `createdAt` (Date) exists ONLY to anchor the 14-day TTL and is never read by
//      application code. Both are written together at insert time.

export type LogLevel = 'info' | 'warn' | 'error';
export type LogCategory =
  | 'dashboard' | 'active' | 'playlists' | 'epg-sources' | 'mapping' | 'history'
  | 'users' | 'import' | 'settings' | 'api' | 'core' | 'mongodb';

export interface LogDoc {
  ts: number; // epoch ms — the UI/sort/filter field (mirrors ViewSession.startedAt)
  createdAt: Date; // BSON Date — the TTL anchor ONLY; never read by the app
  category: LogCategory;
  level: LogLevel;
  tag: string; // the original console tag, preserved verbatim ('mongo', 'dulo:stream', …)
  message: string;
  meta?: Record<string, unknown> | null; // Schema.Types.Mixed — optional structured context
}

const LogSchema = new Schema<LogDoc>(
  {
    ts: { type: Number, required: true },
    createdAt: { type: Date, default: () => new Date() },
    category: { type: String, required: true },
    level: { type: String, required: true },
    tag: { type: String, required: true },
    message: { type: String, required: true },
    meta: { type: Schema.Types.Mixed, default: null },
  },
  { versionKey: false },
);

// Covers the filtered list + sort (GET /api/logs?category=&level=, newest-first).
LogSchema.index({ category: 1, level: 1, ts: -1 });
// Covers the unfiltered newest-first listing.
LogSchema.index({ ts: -1 });
// 14-day TTL — prunes by age off the createdAt Date anchor (the repo's TTL precedent is Session.ts).
LogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 14 });

export const Log = model<LogDoc>('Log', LogSchema);
