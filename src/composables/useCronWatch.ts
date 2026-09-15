
import {
  CRON_JOBS,
  EPG_SOURCES,
  reloadCronjobs,
  reloadEpgSources,
  reloadPlaylists,
  reloadChannels,
  type CronJob,
} from '../data';
import { pushToast } from './useToast';

const POLL_MS = 15000;

const seen = new Map<string, string>();
let timer: number | null = null;

function jobKey(j: CronJob): string {
  return `${j.targetType}:${j.targetId}`;
}

function labelFor(j: CronJob): string {
  if (j.targetType === 'epg-source') {
    return EPG_SOURCES.value.find((s) => s.id === j.targetId)?.name ?? j.targetId;
  }
  return j.targetId;
}

function reconcile(jobs: CronJob[], emit: boolean): void {
  let refetchEpg = false;
  let refetchPlaylists = false;
  for (const j of jobs) {
    if (!j.lastRun) continue;
    const key = jobKey(j);
    const prev = seen.get(key);
    if (prev === undefined) {
      seen.set(key, j.lastRun);
      continue;
    }
    if (prev === j.lastRun) continue;
    seen.set(key, j.lastRun);
    if (!emit) continue;
    if (j.targetType === 'epg-source') refetchEpg = true;
    else if (j.targetType === 'playlist' || j.targetType === 'playlist-m3u') refetchPlaylists = true;
    const ok = j.lastStatus === 'success';
    pushToast({
      position: 'lower-right',
      tone: ok ? 'good' : 'bad',
      title: ok ? 'Scheduled sync complete' : 'Scheduled sync failed',
      text: ok ? labelFor(j) : `${labelFor(j)} · ${j.lastError ?? 'error'}`,
    });
  }
  if (refetchEpg) reloadEpgSources().catch(() => {});
  if (refetchPlaylists) {
    reloadPlaylists().catch(() => {});
    reloadChannels().catch(() => {});
  }
}

export function startCronWatch(): void {
  if (timer !== null) return;
  reconcile(CRON_JOBS.value, false);
  timer = window.setInterval(async () => {
    try {
      await reloadCronjobs();
      reconcile(CRON_JOBS.value, true);
    } catch (err) {
      console.error('[cron-watch] poll failed:', (err as Error).message);
    }
  }, POLL_MS);
}

export function stopCronWatch(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
