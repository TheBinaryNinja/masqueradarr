// Backup/restore resource (admin-only; mounted at /api/backup). Generate downloads a gzipped full-system
// backup; list/restore operate on backups saved in settings.backupLocation; restore (no :filename) takes an
// uploaded backup as a RAW body (the scoped express.raw parser in index.ts). The backup ENGINE is in
// server/src/backup/* (DB logic); these handlers are thin per the restapi.md router conventions. The
// restore handlers re-orchestrate the dependent subsystems via applyPostRestore (boot init + DNS + scheduler).

import { Router } from 'express';
import { buildBackupGzip, backupFilename } from '../backup/buildBackup.js';
import { listBackupFiles, readBackupFile } from '../backup/paths.js';
import {
  parseBackupBuffer,
  restoreFromEnvelope,
  applyPostRestore,
  BadBackupError,
} from '../backup/restoreBackup.js';
import { logger } from '../sources/core/logger.js';

export const backupRouter = Router();

// Generate + stream a full-system backup as a gzip download. Lean scope, secrets included (admin-gated,
// the operator's own data) — enough to restore a system from a blank Mongo.
backupRouter.get('/generate', async (_req, res, next) => {
  try {
    const gzip = await buildBackupGzip({ includeHeavy: false, includeSecrets: true });
    const filename = backupFilename();
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    logger.info('settings', `generated backup (${gzip.length} bytes)`);
    res.send(gzip);
  } catch (err) {
    next(err);
  }
});

// List backups saved on disk (settings.backupLocation), newest first.
backupRouter.get('/list', async (_req, res, next) => {
  try {
    res.json(await listBackupFiles());
  } catch (err) {
    next(err);
  }
});

// Restore from an uploaded backup file (raw gzip or plain JSON body).
backupRouter.post('/restore', async (req, res, next) => {
  try {
    const buf = req.body as unknown;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ error: 'empty_body' });
    }
    const env = parseBackupBuffer(buf);
    const report = await restoreFromEnvelope(env, { mode: 'replace' });
    await applyPostRestore();
    logger.warn('settings', `restore from upload complete: ${JSON.stringify(report.restored)}`);
    res.json(report);
  } catch (err) {
    if (err instanceof BadBackupError) return res.status(400).json({ error: 'bad_backup' });
    next(err);
  }
});

// Restore from a backup saved on disk (settings.backupLocation).
backupRouter.post('/restore/:filename', async (req, res, next) => {
  try {
    let buf: Buffer;
    try {
      buf = await readBackupFile(req.params.filename);
    } catch {
      return res.status(404).json({ error: 'not_found' });
    }
    const env = parseBackupBuffer(buf);
    const report = await restoreFromEnvelope(env, { mode: 'replace' });
    await applyPostRestore();
    logger.warn('settings', `restore from ${req.params.filename} complete: ${JSON.stringify(report.restored)}`);
    res.json(report);
  } catch (err) {
    if (err instanceof BadBackupError) return res.status(400).json({ error: 'bad_backup' });
    next(err);
  }
});
