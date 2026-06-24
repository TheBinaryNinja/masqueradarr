// Restore a full-system backup into MongoDB, then re-orchestrate the subsystems that depend on the restored
// data. DB-writing, source-agnostic. The default mode is an AUTHORITATIVE REPLACE: for each collection
// present in the envelope (in dependency order), drop all docs then re-insert from the backup, preserving
// `_id`. A backup can therefore rebuild a system from a completely blank Mongo. (A non-default 'merge' mode
// upserts by _id without deleting — the documented alternative seam.)

import { gunzipSync } from 'node:zlib';
import { backupSpecs } from './registry.js';
import { BACKUP_FORMAT_VERSION, type BackupEnvelope } from './buildBackup.js';
import { bootInitSources } from '../sources/seed.js';
import { startScheduler, removeAllCronjobs } from '../scheduler/index.js';
import { applyDnsFromSettings } from '../settings/applyDns.js';
import { logger } from '../sources/core/logger.js';

// Thrown when an uploaded/stored buffer is not a recognizable backup — the routes map it to 400 bad_backup.
export class BadBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadBackupError';
  }
}

export interface RestoreReport {
  restored: Record<string, number>; // collection name → docs inserted
  skipped: string[]; // in-scope collections absent from the envelope
  errors: string[]; // per-collection failures (best-effort: one failure does not abort the rest)
}

// Parse a backup buffer (gzip — magic bytes 0x1f 0x8b — or plain JSON) into a validated envelope.
export function parseBackupBuffer(buf: Buffer): BackupEnvelope {
  let text: string;
  try {
    text = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
      ? gunzipSync(buf).toString('utf8')
      : buf.toString('utf8');
  } catch {
    throw new BadBackupError('could not gunzip backup');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadBackupError('backup is not valid JSON');
  }
  const env = parsed as BackupEnvelope;
  if (
    !env ||
    typeof env !== 'object' ||
    typeof env.formatVersion !== 'number' ||
    typeof env.collections !== 'object' ||
    env.collections === null
  ) {
    throw new BadBackupError('missing formatVersion or collections');
  }
  if (env.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BadBackupError(`unsupported backup formatVersion ${env.formatVersion}`);
  }
  return env;
}

// Write the envelope's collections into Mongo. Iterates the full (core + heavy) spec list in restoreOrder
// and acts only on collections actually present in the envelope, so a lean backup leaves the heavy
// collections untouched. Best-effort per collection — a failure is recorded and the rest still run.
export async function restoreFromEnvelope(
  env: BackupEnvelope,
  opts: { mode?: 'replace' | 'merge' } = {},
): Promise<RestoreReport> {
  const mode = opts.mode ?? 'replace';
  const report: RestoreReport = { restored: {}, skipped: [], errors: [] };

  for (const spec of backupSpecs({ includeHeavy: true })) {
    const docs = env.collections[spec.name];
    if (!Array.isArray(docs)) {
      report.skipped.push(spec.name);
      continue;
    }
    try {
      if (mode === 'merge') {
        if (docs.length) {
          await spec.model.bulkWrite(
            docs.map((d) => {
              const { _id, ...rest } = d as { _id: unknown } & Record<string, unknown>;
              return { updateOne: { filter: { _id }, update: { $set: rest }, upsert: true } };
            }),
            { ordered: false },
          );
        }
      } else {
        await spec.model.deleteMany({});
        if (docs.length) await spec.model.insertMany(docs, { ordered: false });
      }
      report.restored[spec.name] = docs.length;
    } catch (err) {
      report.errors.push(`${spec.name}: ${(err as Error).message}`);
    }
  }
  return report;
}

// After an authoritative restore, re-run the boot-time reconciliation the restored data depends on. Every
// step is best-effort/non-fatal (mirrors the boot sequence's posture): drop stale in-memory cron instances,
// reconcile indexes + run idempotent migrations + re-seed the settings singleton, re-apply outbound DNS
// (restored settings.nameservers may differ), then re-register the scheduler from the restored cronjobs.
export async function applyPostRestore(): Promise<void> {
  try {
    removeAllCronjobs();
  } catch (err) {
    logger.warn('settings', `post-restore: removeAllCronjobs failed (continuing): ${(err as Error).message}`);
  }
  try {
    await bootInitSources();
  } catch (err) {
    logger.warn('settings', `post-restore: bootInitSources failed (continuing): ${(err as Error).message}`);
  }
  try {
    await applyDnsFromSettings('update');
  } catch (err) {
    logger.warn('settings', `post-restore: dns re-apply failed (continuing): ${(err as Error).message}`);
  }
  try {
    await startScheduler();
  } catch (err) {
    logger.warn('settings', `post-restore: scheduler re-register failed (continuing): ${(err as Error).message}`);
  }
}
