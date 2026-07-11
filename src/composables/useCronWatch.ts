// Surface a shell toast each time the server-side scheduler executes a cron job (success or failure).
//
// The SPA has no server push for scheduler ticks, so executions are detected by polling the persisted
// cronjobs and diffing each job's `lastRun` timestamp across polls — when it advances, the scheduler ran
// that job and we raise a lower-right toast (useToast.pushToast). `cronjobs` is a tiny collection, so a
// ~15s poll is cheap. The
// first observed value for a job is *seeded* (not toasted) so executions that happened before the page
// loaded never produce a stale toast. Wired in App.vue (start onMounted / stop onBeforeUnmount).

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

// job key → the last `lastRun` we've already accounted for (seeded or toasted).
const seen = new Map<string, string>();
let timer: number | null = null;

function jobKey(j: CronJob): string {
  return `${j.targetType}:${j.targetId}`;
}

// Human label for the toast — the EPG source name when we can resolve it, else the raw target id.
function labelFor(j: CronJob): string {
  if (j.targetType === 'epg-source') {
    return EPG_SOURCES.value.find((s) => s.id === j.targetId)?.name ?? j.targetId;
  }
  return j.targetId;
}

// Diff the current jobs against `seen`. `emit=false` only seeds (used for whatever is already loaded /
// the first poll) so historical runs don't toast; `emit=true` raises a toast on every advance after that.
//
// A scheduled run writes fresh state straight to Mongo with NO client push, so on a real (emit=true) advance
// we ALSO re-surface the matching shared store — otherwise the open EPG Sources / Playlists screen (and the
// Dashboard/nav counts derived from the same stores) show stale data until a full page reload. Deduped so
// several jobs of one kind advancing in a single poll trigger just one refetch. This covers SCHEDULED runs
// only; a manual sync refreshes via its own action handler (usePlaylistActions/useEpgActions).
function reconcile(jobs: CronJob[], emit: boolean): void {
  let refetchEpg = false;
  let refetchPlaylists = false;
  for (const j of jobs) {
    if (!j.lastRun) continue;
    const key = jobKey(j);
    const prev = seen.get(key);
    if (prev === undefined) {
      seen.set(key, j.lastRun); // first sighting — seed, never toast
      continue;
    }
    if (prev === j.lastRun) continue; // no new execution
    seen.set(key, j.lastRun);
    if (!emit) continue;
    // Flag the store this run touched (success OR failure — a failed sync still flips status/failCount).
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
  // Fire once per kind after the diff. Only when a job actually advanced (not on the 15s idle poll), so the
  // per-playlist channel-union rebuild in reloadChannels runs at most once per completed sync. Non-fatal.
  if (refetchEpg) reloadEpgSources().catch(() => {});
  if (refetchPlaylists) {
    reloadPlaylists().catch(() => {});
    reloadChannels().catch(() => {});
  }
}

export function startCronWatch(): void {
  if (timer !== null) return;
  reconcile(CRON_JOBS.value, false); // seed from whatever bootstrap already loaded
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
