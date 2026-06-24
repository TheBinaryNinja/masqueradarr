// Build a full-system backup — a single gzipped JSON envelope of the in-scope collections (registry.ts).
// DB-reading, source-agnostic; callable from both the GET /api/backup/generate route and the scheduler's
// runBackup. The read keeps each doc's `_id` verbatim (unlike the resource-API reads, which strip it) —
// restore needs it to reinsert with the same key (deterministic ids stay stable; auto ObjectIds round-trip
// through JSON as hex strings and cast back on insert).

import { createRequire } from 'node:module';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { backupSpecs } from './registry.js';

const gzipAsync = promisify(gzip);

// The app version stamped into the envelope (informational; restore does not gate on it). Read from
// server/package.json at runtime so it tracks the build without a hardcoded constant.
const require = createRequire(import.meta.url);
const APP_VERSION: string = (() => {
  try {
    return (require('../../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export const BACKUP_FORMAT_VERSION = 1;

export interface BackupOptions {
  // Include the heavy derived collections (sourcechannels/epgchannels/programs). Default backups are lean.
  includeHeavy: boolean;
  // Include secret fields (password hashes, auth tokens, MaxMind key). Default backups include them so a
  // from-nothing restore yields working logins + streaming.
  includeSecrets: boolean;
}

export interface BackupEnvelope {
  formatVersion: number;
  createdAt: string;
  app: { name: string; version: string };
  options: BackupOptions;
  collections: Record<string, unknown[]>;
}

function stripSecrets(docs: Record<string, unknown>[], secretFields: string[]): void {
  for (const doc of docs) {
    for (const field of secretFields) delete doc[field];
  }
}

// Read every in-scope collection into a plain envelope object (keeps _id; redacts secrets when opted out).
export async function buildBackupEnvelope(opts: BackupOptions): Promise<BackupEnvelope> {
  const collections: Record<string, unknown[]> = {};
  for (const spec of backupSpecs({ includeHeavy: opts.includeHeavy })) {
    const docs = (await spec.model.find({}).lean()) as Record<string, unknown>[];
    if (!opts.includeSecrets && spec.secretFields?.length) stripSecrets(docs, spec.secretFields);
    collections[spec.name] = docs;
  }
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    app: { name: 'tvapp2', version: APP_VERSION },
    options: opts,
    collections,
  };
}

// Serialize + gzip the envelope. Returns the gzip bytes (the download body / the on-disk file content).
export async function buildBackupGzip(opts: BackupOptions): Promise<Buffer> {
  const env = await buildBackupEnvelope(opts);
  return gzipAsync(Buffer.from(JSON.stringify(env)));
}

// Suggested filename for a backup: tvapp2-backup-<ISO>.json.gz, colon-free for filesystem safety.
export function backupFilename(d: Date = new Date()): string {
  const iso = d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  return `tvapp2-backup-${iso}.json.gz`;
}
