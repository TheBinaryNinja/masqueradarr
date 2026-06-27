<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import Toggle from './Toggle.vue';
import FrequencyBuilder from './FrequencyBuilder.vue';
import VideoConfigPanel from './VideoConfigPanel.vue';
import { type Channel, type Playlist, type CronFrequency, type CronJob, CRON_JOBS, reloadCronjobs } from '../data';
import { domain, timezone } from '../composables/useSettings';
import { defaultFrequency, buildCron, summarizeFrequency } from '../composables/useSchedule';

const props = defineProps<{ playlist: Playlist; channels: Channel[] }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'updated', patch: Partial<Playlist>): void }>();

const baseDomain = computed(() => domain.value.replace(/\/$/, ''));

// A "clone" (user-composed custom playlist, source==='clone') is custom-endpoint only and has no sync/compose
// schedule (interval 'none'): the global endpoint option and the schedule builders are hidden for it.
const isClone = computed(() => props.playlist.source === 'clone');

// ── Automatic cron pickers (the shared FrequencyBuilder, same as the EPG ScheduleEditorDrawer) ──────────
// Two independent jobs for the (Default) source playlist's source id (id === source), distinguished by
// targetType — each is its own cronjobs doc / _id ("<targetType>:<targetId>"), so the cadences never collide:
//   • Sync schedule — targetType 'playlist'; the scheduler runs the source live-sync (the same work as the
//     manual "Sync now").
//   • Compose m3u — targetType 'playlist-m3u'; the scheduler recomposes the playlist's stream-ready m3u
//     export (the same work as the manual "Compose m3u" — mirrors the EPG-XML compose schedule).
// Which playlists can be scheduled, and against WHAT cron targetId:
//   • A (Default) SOURCE playlist (registry-backed; id === source) → its source/id (syncLive + composeM3u).
//   • A custom playlist WITH a live upstream — 'url' (re-fetch the stored remoteUrl) or 'hdhomerun' (re-fetch
//     the device lineup) → its own playlist id (the custom-playlists sync + composeM3u both key by id).
//   • A clone (source==='clone'), a static 'file' import, or a source-unset (legacy/mock) playlist → NO cron
//     target (nothing to live-sync). This guard hides the schedule builders (canSchedule → false) and makes
//     saveSchedule() early-return without writing cron jobs.
// The cron targetId is the playlist ID for every schedulable playlist (for a source playlist id === source,
// so syncLive/composeM3u still receive the source id; for a custom playlist the scheduler resolves its type).
// The custom-playlist source TYPE TAGs ('clone'/'file'/'url'/'hdhomerun'/'local'/legacy 'import') discriminate
// an import from a registry-backed (Default) source playlist; only 'url'/'hdhomerun'/'local' have a re-syncable
// upstream ('local' = a Local Now market re-fetch, which also has an auto-provisioned hourly schedule).
const CUSTOM_TYPE_TAGS = new Set(['clone', 'file', 'url', 'hdhomerun', 'local', 'import']);
const SCHEDULABLE_CUSTOM = new Set(['url', 'hdhomerun', 'local']);
const cronTarget = computed<string | null>(() => {
  const src = props.playlist.source;
  if (!src) return null;
  // A custom-type import → schedulable only if it has a live upstream ('url'/'hdhomerun').
  if (CUSTOM_TYPE_TAGS.has(src)) return SCHEDULABLE_CUSTOM.has(src) ? props.playlist.id : null;
  // A (Default) source playlist (registry-backed, id === source) → always schedulable, regardless of endpoint.
  return props.playlist.id;
});
const canSchedule = computed(() => !!cronTarget.value);
const existingJob = computed<CronJob | null>(() =>
  cronTarget.value
    ? CRON_JOBS.value.find((j) => j.targetType === 'playlist' && j.targetId === cronTarget.value) || null
    : null,
);
const existingM3uJob = computed<CronJob | null>(() =>
  cronTarget.value
    ? CRON_JOBS.value.find((j) => j.targetType === 'playlist-m3u' && j.targetId === cronTarget.value) || null
    : null,
);

// Sync schedule builder state (compiled to a cron string at save time; the UI lives in FrequencyBuilder).
const isAuto = ref(false);
const freq = reactive<CronFrequency>(defaultFrequency());
const rawCron = ref('0 */6 * * *');
const cron = computed(() => buildCron(freq, rawCron.value));

// Compose-m3u schedule builder state (independent from the sync builder).
const m3uIsAuto = ref(false);
const m3uFreq = reactive<CronFrequency>(defaultFrequency());
const m3uRawCron = ref('0 */6 * * *');
const m3uCron = computed(() => buildCron(m3uFreq, m3uRawCron.value));

// Save lifecycle for the schedule writes — surfaced in the footer so a failed save is visible instead of
// silently swallowed (the drawer stays open on error, mirroring the EPG ScheduleEditorDrawer).
const saving = ref(false);
const error = ref('');

// Only forward a timezone the browser recognizes as a valid IANA zone — an unrecognized string makes
// croner throw on construction server-side, so the job registers as errored and never fires.
function safeTimezone(): string | null {
  const tz = timezone.value;
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

// Hydrate both builders from their existing cron jobs (so re-opening shows the saved schedules).
onMounted(() => {
  const job = existingJob.value;
  if (job) {
    isAuto.value = true;
    if (job.frequency && typeof job.frequency.mode === 'string') Object.assign(freq, job.frequency);
    if (typeof job.cron === 'string') rawCron.value = job.cron;
  }
  const m3u = existingM3uJob.value;
  if (m3u) {
    m3uIsAuto.value = true;
    if (m3u.frequency && typeof m3u.frequency.mode === 'string') Object.assign(m3uFreq, m3u.frequency);
    if (typeof m3u.cron === 'string') m3uRawCron.value = m3u.cron;
  }
});

// Persist one schedule (Automatic upserts the cron job, Manual deletes it). The (targetType, target) pair
// is the job's identity — the sync and compose jobs share the target id but differ by targetType, so each
// is its own cronjobs doc.
async function putOrDeleteJob(targetType: string, target: string, isAuto: boolean, cronExpr: string, frequency: CronFrequency): Promise<void> {
  const path = `/api/cronjobs/${encodeURIComponent(target)}?targetType=${encodeURIComponent(targetType)}`;
  if (isAuto) {
    const res = await fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetType,
        cron: cronExpr,
        frequency: { ...frequency },
        timezone: safeTimezone(),
        enabled: true,
      }),
    });
    if (!res.ok) throw new Error('schedule save failed');
  } else {
    const res = await fetch(path, { method: 'DELETE' });
    // DELETE is idempotent — a 404 (no existing job) is expected when an already-Manual schedule is saved;
    // any other non-2xx is a real failure worth surfacing.
    if (!res.ok && res.status !== 404) throw new Error('schedule delete failed');
  }
}

// Persist both schedules, mirror the friendly sync label onto the playlist row, then refresh the store.
// Returns true on success; on failure sets `error` and returns false so the caller keeps the drawer open.
async function saveSchedule(): Promise<boolean> {
  const target = cronTarget.value;
  if (!target) return true; // source-less playlist — nothing to schedule
  error.value = '';
  saving.value = true;
  try {
    await putOrDeleteJob('playlist', target, isAuto.value, cron.value, freq);
    await putOrDeleteJob('playlist-m3u', target, m3uIsAuto.value, m3uCron.value, m3uFreq);
    // Mirror the friendly sync-schedule label + auto flag onto the playlist row (the EPG posture) so the
    // stored interval stays accurate. The chip derives live from the cron job, but the persisted field is
    // the document-of-record other consumers read; the source sync no longer owns/clobbers it.
    const patch: Partial<Playlist> = {
      interval: isAuto.value ? summarizeFrequency(freq, cron.value) : 'manual',
      auto: isAuto.value,
    };
    const res = await fetch(`/api/playlists/${encodeURIComponent(props.playlist.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error('playlist update failed');
    await reloadCronjobs();
    emit('updated', patch);
    return true;
  } catch {
    error.value = 'Could not save the schedule — please try again.';
    return false;
  } finally {
    saving.value = false;
  }
}

async function done(): Promise<void> {
  // Flush any pending debounced writes (name / custom path) so a fast Done doesn't drop the last edit.
  if (nameTimer) { clearTimeout(nameTimer); nameTimer = null; }
  if (pathTimer) { clearTimeout(pathTimer); pathTimer = null; }
  const trimmed = name.value.trim();
  if (trimmed && trimmed !== props.playlist.name) await save({ name: trimmed });
  if (await saveSchedule()) emit('close');
}

// Local editable state, seeded from the persisted playlist doc. Changes PUT back to the API and emit
// 'updated' so the parent refreshes. endpoint/state/url are the persisted fields (no more SPA-local store).
const active = ref(props.playlist.state !== false);
// Endpoint hosting mode — canonical LOWERCASE value ('global' | 'custom'), persisted via PUT.
const mode = ref<'global' | 'custom'>(props.playlist.endpoint === 'custom' ? 'custom' : 'global');
const customPath = ref(initialCustomPath());

// Editable display name — a rename that persists via PUT /api/playlists/:id (does NOT change the id/url).
// Debounced like the custom path so each keystroke doesn't fire a write; also flushed on Done.
const name = ref(props.playlist.name);
let nameTimer: ReturnType<typeof setTimeout> | null = null;
function onName(v: string) {
  name.value = v;
  if (nameTimer) clearTimeout(nameTimer);
  nameTimer = setTimeout(() => {
    const trimmed = name.value.trim();
    if (trimmed && trimmed !== props.playlist.name) save({ name: trimmed });
  }, 400);
}

// Strip a trailing dotted filename segment + leading/trailing slashes (mirrors the server's
// normalizeEndpointPath in server/src/m3u/paths.ts): 'MyList/playlist.m3u' → 'MyList', '/a/b/' → 'a/b'.
// Per-user files are served as <domain>/<customPath>/<username>-<slug>.m3u, so the path is a bare directory.
function normalizeCustomSegment(raw: string): string {
  const segs = (raw ?? '').split('/').filter(Boolean);
  if (segs.length && segs[segs.length - 1].includes('.')) segs.pop();
  return segs.join('/');
}

function initialCustomPath(): string {
  if (props.playlist.endpoint === 'custom' && props.playlist.url) {
    try {
      const u = new URL(props.playlist.url);
      const seg = normalizeCustomSegment(u.pathname);
      if (seg) return seg;
    } catch {
      const seg = normalizeCustomSegment(props.playlist.url);
      if (seg) return seg;
    }
  }
  return '';
}

// The hosted url for the current selection: Global = the bare operator domain (the per-user Global files
// are served FLAT at <domain>/<username>-<slug>.m3u); Custom = domain + normalized directory segment.
const hostedUrl = computed(() => {
  if (mode.value === 'custom') {
    const seg = normalizeCustomSegment(customPath.value);
    return seg ? `${baseDomain.value}/${seg}` : baseDomain.value;
  }
  return baseDomain.value;
});

const matched = computed(() => props.channels.filter((c) => c.epgState === 'matched').length);
const unmatched = computed(() => props.channels.length - matched.value);

async function save(patch: Partial<Playlist>): Promise<void> {
  try {
    const res = await fetch(`/api/playlists/${encodeURIComponent(props.playlist.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) emit('updated', patch);
  } catch {
    /* best-effort; the UI keeps the optimistic local value */
  }
}

function setActive(v: boolean) {
  active.value = v;
  save({ state: v });
}

function setMode(m: 'global' | 'custom') {
  mode.value = m;
  save({ endpoint: m, url: hostedUrl.value });
}

// ── Per-playlist Video Configuration (externalPlayer engine) ───────────────────────────────────────────
// Default = use the global 'app' config from Settings; Custom = a per-playlist 'app_<id>' config edited inline
// below (the embedded bare VideoConfigPanel). The SERVER owns the 'app_<id>' doc lifecycle (create on Custom /
// delete on Default) on the playlist PUT, so the field is all the client persists. External IPTV clients only.
const customConfigId = computed(() => `app_${props.playlist.id}`);
const videoConfigMode = ref<'default' | 'custom'>(
  props.playlist.videoconfig && props.playlist.videoconfig !== 'default' ? 'custom' : 'default',
);
function setVideoConfigMode(m: 'default' | 'custom') {
  videoConfigMode.value = m;
  save({ videoconfig: m === 'custom' ? customConfigId.value : 'default' });
}

let pathTimer: ReturnType<typeof setTimeout> | null = null;
function onCustomPath(v: string) {
  customPath.value = v;
  if (mode.value !== 'custom') return;
  if (pathTimer) clearTimeout(pathTimer);
  pathTimer = setTimeout(() => save({ endpoint: 'custom', url: hostedUrl.value }), 400);
}
</script>

<template>
  <div class="drawer-wrap">
    <div class="glass-bg drawer-backdrop" @click="emit('close')" />
    <div class="glass drawer-panel" style="width: 50vw; max-width: 50vw; min-width: 440px;">
      <div class="drawer-hd">
        <div :class="['src-ico', { builtin: playlist.builtin }]" style="width: 44px; height: 44px; border-radius: 10px;">
          <Icon name="globe" :size="20" />
        </div>
        <div style="flex: 1;">
          <div style="font-weight: 600; font-size: 15px;">Playlist status</div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px;">{{ playlist.name }}</div>
        </div>
        <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
      </div>

      <div class="drawer-body">
        <!-- EPG summary (informational) — the matched/unmatched split for this playlist's channels. -->
        <div style="display: grid; gap: 8px;">
          <div class="row" style="gap: 10px; padding: 8px 12px; border: 1px solid var(--hairline); border-radius: 8px; background: var(--bg-2);">
            <Icon name="check" :size="13" style="color: var(--good);" />
            <span style="font-size: var(--fs-sm);">EPG matched</span>
            <span class="spacer" />
            <Pill tone="good">{{ matched }}</Pill>
          </div>
          <div class="row" style="gap: 10px; padding: 8px 12px; border: 1px solid var(--hairline); border-radius: 8px; background: var(--bg-2);">
            <Icon name="warn" :size="13" style="color: var(--warn);" />
            <span style="font-size: var(--fs-sm);">EPG unmatched</span>
            <span class="spacer" />
            <Pill tone="warn">{{ unmatched }}</Pill>
          </div>
        </div>

        <div class="divider" />

        <!-- ① Name + State — side by side on one row. -->
        <div class="form-grid-2">
          <div class="form-row">
            <div class="field-lbl">Name</div>
            <div class="input">
              <Icon name="playlist" :size="14" />
              <input :value="name" @input="onName(($event.target as HTMLInputElement).value)" placeholder="Playlist name" />
            </div>
          </div>
          <div class="form-row">
            <div class="field-lbl">State</div>
            <div class="row" style="gap: 10px; align-items: center;">
              <Toggle :on="active" @change="setActive" />
              <Pill :tone="active ? 'active' : 'disabled'">
                {{ active ? 'Active' : 'Inactive' }}
              </Pill>
            </div>
          </div>
        </div>

        <!-- ② Sync schedule (+ the paired Compose-m3u schedule) — the shared FrequencyBuilder, same as the
             EPG source Edit drawer. Only source-backed playlists can be scheduled (clones/source-unset have
             nothing to do). -->
        <template v-if="canSchedule">
          <div class="divider" />
          <FrequencyBuilder :freq="freq" v-model:auto="isAuto" v-model:rawCron="rawCron"
                            label="Sync schedule" icon="refresh"
                            manualHint="Synced manually only. Switch to Automatic to refresh this playlist on a schedule." />

          <div class="divider" />
          <FrequencyBuilder :freq="m3uFreq" v-model:auto="m3uIsAuto" v-model:rawCron="m3uRawCron"
                            label="Compose m3u" icon="file"
                            manualHint="Composed manually only. Switch to Automatic to rebuild the m3u on a schedule." />
        </template>

        <div class="divider" />

        <!-- ③ Endpoint -->
        <div class="form-row">
          <div class="field-lbl">Endpoint</div>
          <div style="display: grid; gap: 8px;">
            <label v-if="!isClone" class="row" style="gap: 10px; padding: 8px 10px; border: 1px solid var(--hairline); border-radius: 8px; cursor: pointer;"
                   :style="mode === 'global' ? 'border-color: var(--accent); background: var(--accent-soft);' : ''">
              <input type="radio" name="endpoint-mode" :checked="mode === 'global'" @change="setMode('global')" />
              <div style="flex: 1;">
                <div style="font-weight: 500; font-size: var(--fs-sm);">global</div>
                <div class="muted mono" style="font-size: var(--fs-xs); margin-top: 2px;">{{ baseDomain }}</div>
                <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px;">Served per user from the Domain defined in Settings.</div>
              </div>
            </label>
            <label class="row" style="gap: 10px; padding: 8px 10px; border: 1px solid var(--hairline); border-radius: 8px; cursor: pointer; align-items: flex-start;"
                   :style="mode === 'custom' ? 'border-color: var(--accent); background: var(--accent-soft);' : ''">
              <input type="radio" name="endpoint-mode" :checked="mode === 'custom'" @change="setMode('custom')" style="margin-top: 4px;" />
              <div style="flex: 1;">
                <div style="font-weight: 500; font-size: var(--fs-sm);">custom</div>
                <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px; margin-bottom: 6px;">
                  Host this playlist at a custom path on the Domain from Settings.
                </div>
                <div :class="['input', 'mono']" style="font-size: 12px;" :style="mode === 'custom' ? '' : 'opacity: 0.55; pointer-events: none;'">
                  <span class="mono" style="padding: 0 8px 0 10px; color: var(--text-3); font-size: 11px; border-right: 1px solid var(--hairline); align-self: stretch; display: flex; align-items: center;">{{ baseDomain }}/</span>
                  <input :value="customPath" @input="onCustomPath(($event.target as HTMLInputElement).value)" placeholder="MyCustomPlaylist" />
                </div>
              </div>
            </label>
          </div>
        </div>

        <div class="divider" />

        <!-- ④ Per-playlist Video Configuration (externalPlayer engine): Default (global app config) vs Custom. -->
        <div class="form-row">
          <div class="field-lbl">Video Configuration | Playlist</div>
          <div style="display: grid; gap: 8px;">
            <label class="row" style="gap: 10px; padding: 8px 10px; border: 1px solid var(--hairline); border-radius: 8px; cursor: pointer;"
                   :style="videoConfigMode === 'default' ? 'border-color: var(--accent); background: var(--accent-soft);' : ''">
              <input type="radio" name="videoconfig-mode" :checked="videoConfigMode === 'default'" @change="setVideoConfigMode('default')" />
              <div style="flex: 1;">
                <div style="font-weight: 500; font-size: var(--fs-sm);">Default</div>
                <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px;">
                  Uses the app-wide Default video configuration set on the Settings screen (applies to every
                  playlist set to Default). Governs how this playlist's channels are served to <b>external</b>
                  IPTV clients only — the in-app player is unaffected.
                </div>
              </div>
            </label>
            <label class="row" style="gap: 10px; padding: 8px 10px; border: 1px solid var(--hairline); border-radius: 8px; cursor: pointer; align-items: flex-start;"
                   :style="videoConfigMode === 'custom' ? 'border-color: var(--accent); background: var(--accent-soft);' : ''">
              <input type="radio" name="videoconfig-mode" :checked="videoConfigMode === 'custom'" @change="setVideoConfigMode('custom')" style="margin-top: 4px;" />
              <div style="flex: 1;">
                <div style="font-weight: 500; font-size: var(--fs-sm);">Custom</div>
                <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px;">
                  A configuration just for this playlist (seeded from the current Default). For HDHomeRun playlists
                  the engine does not apply, so a custom config is inert there.
                </div>
              </div>
            </label>
          </div>
          <div v-if="videoConfigMode === 'custom'" style="margin-top: 12px;">
            <VideoConfigPanel :config-id="customConfigId" bare />
          </div>
        </div>

        <div v-if="error" class="muted" style="color: var(--bad); font-size: var(--fs-sm); margin-top: 8px;">{{ error }}</div>
        <div class="row" style="margin-top: 6px;">
          <span class="spacer" />
          <Btn variant="primary" icon="check" :disabled="saving" @click="done">{{ saving ? 'Saving…' : 'Done' }}</Btn>
        </div>
      </div>
    </div>
  </div>
</template>
