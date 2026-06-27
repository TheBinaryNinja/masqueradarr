// Scheduler subsystem — runs the persisted `cronjobs` (models/Cronjob.ts) on their cron schedules using
// croner. One in-memory Cron per enabled job, keyed by the job's deterministic _id. Boot calls
// startScheduler() (non-fatal); the /api/cronjobs router calls applyCronjob()/removeCronjob() after a
// write so a created/updated/deleted job takes effect immediately. The tick is source-agnostic on
// `targetType` — one case per (resource, action), each with its own deterministic _id namespace:
//   'epg-source'   → syncEpgSource (the EPG source live-sync, the manual "Sync now")
//   'playlist'     → runPlaylistSync (live-sync, the manual "Sync now"): a registry source → syncLive; a
//                    custom playlist → its upstream re-fetch ('hdhomerun' device / 'url' stored remoteUrl)
//   'playlist-m3u' → composeM3u (recompose the playlist's stream-ready m3u export, the manual "Compose m3u")
//   'probe-all'    → probeAllChannels (the scheduled ffprobe sweep over every Active channel — one global
//                    job, targetId:'app'; the same work as the manual POST /api/probe/run)
// A playlist's sync ('playlist:<id>') and compose ('playlist-m3u:<id>') jobs are independent docs, so the
// two cadences never collide. nextRun/lastRun/lastStatus/lastError are maintained here. See restapi.md
// (the /api/cronjobs resource) + styles-backend.md.

import { Cron } from 'croner';
import { logger } from '../sources/core/logger.js';
import { Cronjob, type CronjobDoc } from '../models/Cronjob.js';
import { syncEpgSource } from '../epg/syncEpgSource.js';
import { syncLive } from '../sources/seed.js';
import { composeM3u } from '../m3u/compose.js';
import { probeAllChannels } from '../sources/probeAll.js';
import { getSource } from '../sources/registry.js';
import { Playlist } from '../models/Playlist.js';
import { syncHdhrPlaylist } from '../sources/adapters/hdhomerun/import.js';
import { syncLocalPlaylist } from '../sources/adapters/local/import.js';
import { syncUrlPlaylist } from '../routes/import.js';
import { buildBackupGzip, backupFilename } from '../backup/buildBackup.js';
import { writeBackupFile } from '../backup/paths.js';

// A 'playlist' sync job's targetId is the playlist ID. Dispatch by what backs it: a registry source (a
// Default source playlist; id === source) → syncLive; a custom playlist with a live upstream → its type's
// re-sync ('hdhomerun' device lineup / 'url' stored remoteUrl). Unknown/un-syncable → throw (logged as a
// failed run). Mirrors the manual dispatch (POST /api/sources/:id/sync vs /api/custom-playlists/:id/sync).
async function runPlaylistSync(targetId: string): Promise<void> {
  if (getSource(targetId)) {
    await syncLive(targetId);
    return;
  }
  const pl = (await Playlist.findOne({ id: targetId }, { _id: 0, source: 1 }).lean()) as {
    source?: string | null;
  } | null;
  const src = (pl?.source ?? '').toLowerCase();
  if (src === 'hdhomerun') await syncHdhrPlaylist(targetId);
  else if (src === 'url') await syncUrlPlaylist(targetId);
  else if (src === 'local') await syncLocalPlaylist(targetId);
  else throw new Error(`playlist ${targetId} is not live-syncable (source: ${pl?.source ?? 'unknown'})`);
}

// Scheduled full-system backup → builds the gzip envelope (lean scope, secrets included — it's the
// operator's own disk) and writes it into settings.backupLocation. One global job (targetId 'app'),
// mirroring probe-all. Throws on failure so runJob records lastStatus 'error' + lastError.
async function runBackup(_targetId: string): Promise<void> {
  const gzip = await buildBackupGzip({ includeHeavy: false, includeSecrets: true });
  await writeBackupFile(backupFilename(), gzip);
}

// _id → live Cron instance. Only enabled, valid jobs are present.
const jobs = new Map<string, Cron>();

// Validate a cron expression without scheduling anything (croner throws on a bad pattern).
export function isValidCron(expr: string): boolean {
  try {
    new Cron(expr).stop();
    return true;
  } catch {
    return false;
  }
}

function nextRunIso(cron: Cron): string | null {
  const d = cron.nextRun();
  return d ? d.toISOString() : null;
}

// Run one job's work now and persist the outcome. Re-reads the doc so a job disabled/deleted between
// ticks is honored. Never throws — a failing job records lastError and keeps ticking.
async function runJob(id: string): Promise<void> {
  let doc: CronjobDoc | null;
  try {
    doc = (await Cronjob.findById(id).lean()) as CronjobDoc | null;
  } catch (err) {
    logger.error('scheduler', `load failed for ${id}: ${(err as Error).message}`);
    return;
  }
  if (!doc || !doc.enabled) return;

  const nextRun = jobs.get(id) ? nextRunIso(jobs.get(id)!) : null;
  const now = new Date().toISOString();
  try {
    switch (doc.targetType) {
      case 'epg-source': {
        // No UI here (scheduled run) — if the operator's Time zone offset is unset, the programs were
        // stamped UTC; log it rather than toast. See settings/programOffset.ts.
        const { offsetDefaulted } = await syncEpgSource(doc.targetId);
        if (offsetDefaulted) {
          logger.warn('scheduler', `${doc.targetId}: settings offset unset — guide times stored as UTC (+0000)`);
        }
        break;
      }
      case 'playlist':
        // Playlist sync schedule — the live-sync behind the playlist's manual "Sync now". targetId is the
        // playlist id; runPlaylistSync dispatches by what backs it (registry source live-sync vs. a custom
        // playlist's upstream re-fetch — 'hdhomerun' device / 'url' remoteUrl).
        await runPlaylistSync(doc.targetId);
        break;
      case 'playlist-m3u':
        // Playlist Compose-m3u schedule — a distinct targetType (own _id namespace) so a playlist can sync
        // + compose on independent cadences. Recomposes the playlist's stream-ready m3u export (the same
        // work as the manual POST /api/playlists/:id/compose). targetId is the (Default) source playlist id.
        await composeM3u(doc.targetId);
        break;
      case 'probe-all':
        // The scheduled ffprobe sweep over every Active channel in every playlist (one global job —
        // targetId is 'app'). Self-guards against overlap, so a tick during a long run is a safe no-op.
        await probeAllChannels();
        break;
      case 'backup':
        // Scheduled full-system backup to disk (one global job — targetId 'app'). Writes a gzip envelope
        // into settings.backupLocation; the same payload as the manual GET /api/backup/generate download.
        await runBackup(doc.targetId);
        break;
      default:
        throw new Error(`unsupported targetType: ${doc.targetType}`);
    }
    await Cronjob.updateOne(
      { _id: id },
      { $set: { lastRun: now, lastStatus: 'success', lastError: null, nextRun, updatedAt: now } },
    );
    logger.info('scheduler', `ran ${id} (${doc.targetType}:${doc.targetId}) → success`);
  } catch (err) {
    const msg = (err as Error).message;
    await Cronjob.updateOne(
      { _id: id },
      { $set: { lastRun: now, lastStatus: 'error', lastError: msg, nextRun, updatedAt: now } },
    );
    logger.warn('scheduler', `ran ${id} → error: ${msg}`);
  }
}

// (Re)register a single job from its doc. Stops any prior instance first. A disabled job or an invalid
// cron expression leaves nothing scheduled (invalid → status 'error' persisted). Persists nextRun.
export async function applyCronjob(doc: CronjobDoc): Promise<void> {
  removeCronjob(doc._id);
  if (!doc.enabled) return;
  let cron: Cron;
  try {
    cron = new Cron(
      doc.cron,
      { timezone: doc.timezone ?? undefined, name: doc._id },
      () => void runJob(doc._id),
    );
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn('scheduler', `invalid cron for ${doc._id} (${doc.cron}): ${msg}`);
    await Cronjob.updateOne(
      { _id: doc._id },
      { $set: { lastStatus: 'error', lastError: `invalid cron: ${msg}`, nextRun: null } },
    );
    return;
  }
  jobs.set(doc._id, cron);
  await Cronjob.updateOne({ _id: doc._id }, { $set: { nextRun: nextRunIso(cron) } });
}

// Stop + drop a job from the active set (used on disable/delete). Idempotent.
export function removeCronjob(id: string): void {
  const cron = jobs.get(id);
  if (cron) {
    cron.stop();
    jobs.delete(id);
  }
}

// Stop + drop EVERY active job. Used before a workspace reset / restore re-registers from fresh DB state,
// so jobs deleted by the wipe stop ticking and startScheduler() rebuilds the map cleanly. Idempotent.
export function removeAllCronjobs(): void {
  for (const id of [...jobs.keys()]) removeCronjob(id);
}

// Boot entry: register every enabled job. Non-fatal — a failure here must not crash boot.
export async function startScheduler(): Promise<void> {
  const docs = (await Cronjob.find({ enabled: true }).lean()) as CronjobDoc[];
  for (const doc of docs) await applyCronjob(doc);
  logger.info('scheduler', `registered ${jobs.size} job(s)`);
}
