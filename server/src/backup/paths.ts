// On-disk backup directory helpers — used by the scheduled backup (write), GET /api/backup/list, and
// POST /api/backup/restore/:filename (read). The directory is settings.backupLocation (default '/backups',
// seeded from the BACKUPS_DIR env on the standard image, redirected to /data/backups on the AIO image).
// Writes go through the shared atomic-write primitive so a concurrent reader never sees a half-written file.

import { readdir, stat, readFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { Settings, SETTINGS_ID } from '../models/Settings.js';
import { withPathLock, atomicWriteBytes } from '../m3u/atomicFile.js';

export const DEFAULT_BACKUP_DIR = '/backups';

// The configured backup directory (settings.backupLocation), falling back to the default. Absolute paths
// are used as-is; a blank/missing value resets to the default.
export async function backupDir(): Promise<string> {
  const doc = (await Settings.findById(SETTINGS_ID, { backupLocation: 1, _id: 0 }).lean()) as
    | { backupLocation?: string }
    | null;
  const loc = doc?.backupLocation?.trim();
  return loc && loc.length ? loc : DEFAULT_BACKUP_DIR;
}

// Reject anything that isn't a bare filename (no directory separators, no '..') — the only names ever
// passed in come from listBackupFiles(), but :filename is user-controlled, so this blocks path traversal.
function safeName(filename: string): string {
  const base = basename(filename);
  if (base !== filename || base === '' || base === '.' || base === '..' || base.includes('..')) {
    throw new Error('invalid_filename');
  }
  return base;
}

// Atomically write a gzip backup into the backup directory. Returns the absolute path written.
export async function writeBackupFile(filename: string, gzip: Buffer): Promise<string> {
  const full = resolve(await backupDir(), safeName(filename));
  await withPathLock(full, () => atomicWriteBytes(full, gzip));
  return full;
}

export interface BackupFileInfo {
  filename: string;
  createdAt: string; // file mtime, ISO
  size: number; // bytes
}

// List *.json.gz backups in the backup directory, newest first. A missing directory → [].
export async function listBackupFiles(): Promise<BackupFileInfo[]> {
  const dir = await backupDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const infos: BackupFileInfo[] = [];
  for (const name of names) {
    if (!name.endsWith('.json.gz')) continue;
    try {
      const s = await stat(resolve(dir, name));
      if (!s.isFile()) continue;
      infos.push({ filename: name, createdAt: s.mtime.toISOString(), size: s.size });
    } catch {
      // skip unreadable entries
    }
  }
  infos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return infos;
}

// Read a saved backup file's bytes (gzip). Throws on a bad name or a missing file.
export async function readBackupFile(filename: string): Promise<Buffer> {
  return readFile(resolve(await backupDir(), safeName(filename)));
}
