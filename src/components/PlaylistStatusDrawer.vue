<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import Toggle from './Toggle.vue';
import FrequencyBuilder from './FrequencyBuilder.vue';
import ProxyConfigPanel from './ProxyConfigPanel.vue';
import TagPicker from './TagPicker.vue';
import { type Channel, type Playlist, type CronFrequency, type CronJob, CRON_JOBS, reloadCronjobs, reloadPlaylists } from '../data';
import { domain, timezone } from '../composables/useSettings';
import { defaultFrequency, buildCron, summarizeFrequency } from '../composables/useSchedule';
import { customConfigExists, createCustomFromDefault, deleteCustomConfig } from '../composables/useProxyConfig';

const props = defineProps<{ playlist: Playlist; channels: Channel[] }>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'updated', patch: Partial<Playlist>): void;
  (e: 'channelsTagged'): void;
}>();

const baseDomain = computed(() => domain.value.replace(/\/$/, ''));

const isClone = computed(() => props.playlist.source === 'clone');

const proxyConfigId = computed(() => `app_${props.playlist.id}`);
const customProxy = ref(false);
const proxyBusy = ref(false);

async function setCustomProxy(on: boolean): Promise<void> {
  if (proxyBusy.value) return;
  proxyBusy.value = true;
  try {
    const ok = on
      ? await createCustomFromDefault(proxyConfigId.value)
      : await deleteCustomConfig(proxyConfigId.value);
    if (ok) customProxy.value = on;
  } finally {
    proxyBusy.value = false;
  }
}

onMounted(async () => {
  customProxy.value = await customConfigExists(proxyConfigId.value);
});

const CUSTOM_TYPE_TAGS = new Set(['clone', 'file', 'url', 'hdhomerun', 'local', 'import']);
const SCHEDULABLE_CUSTOM = new Set(['url', 'hdhomerun', 'local']);
const cronTarget = computed<string | null>(() => {
  const src = props.playlist.source;
  if (!src) return null;
  if (CUSTOM_TYPE_TAGS.has(src)) return SCHEDULABLE_CUSTOM.has(src) ? props.playlist.id : null;
  return props.playlist.id;
});
const canSchedule = computed(() => !!cronTarget.value);

const composeTarget = computed<string | null>(() => cronTarget.value ?? (isClone.value ? props.playlist.id : null));
const canComposeSchedule = computed(() => !!composeTarget.value);

const existingJob = computed<CronJob | null>(() =>
  cronTarget.value
    ? CRON_JOBS.value.find((j) => j.targetType === 'playlist' && j.targetId === cronTarget.value) || null
    : null,
);
const existingM3uJob = computed<CronJob | null>(() =>
  composeTarget.value
    ? CRON_JOBS.value.find((j) => j.targetType === 'playlist-m3u' && j.targetId === composeTarget.value) || null
    : null,
);

const isAuto = ref(false);
const freq = reactive<CronFrequency>(defaultFrequency());
const rawCron = ref('0 */6 * * *');
const cron = computed(() => buildCron(freq, rawCron.value));

const m3uIsAuto = ref(false);
const m3uFreq = reactive<CronFrequency>(defaultFrequency());
const m3uRawCron = ref('0 */6 * * *');
const m3uCron = computed(() => buildCron(m3uFreq, m3uRawCron.value));

const saving = ref(false);
const error = ref('');

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
    if (!res.ok && res.status !== 404) throw new Error('schedule delete failed');
  }
}

async function saveSchedule(): Promise<boolean> {
  const syncTarget = cronTarget.value;
  const composeTgt = composeTarget.value;
  if (!syncTarget && !composeTgt) return true;
  error.value = '';
  saving.value = true;
  try {
    if (syncTarget) await putOrDeleteJob('playlist', syncTarget, isAuto.value, cron.value, freq);
    if (composeTgt) await putOrDeleteJob('playlist-m3u', composeTgt, m3uIsAuto.value, m3uCron.value, m3uFreq);
    if (syncTarget) {
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
      emit('updated', patch);
    }
    await reloadCronjobs();
    return true;
  } catch {
    error.value = 'Could not save the schedule — please try again.';
    return false;
  } finally {
    saving.value = false;
  }
}

async function done(): Promise<void> {
  if (nameTimer) { clearTimeout(nameTimer); nameTimer = null; }
  if (pathTimer) { clearTimeout(pathTimer); pathTimer = null; }
  const trimmed = name.value.trim();
  if (trimmed && trimmed !== props.playlist.name) await save({ name: trimmed });
  if (await saveSchedule()) emit('close');
}

const active = ref(props.playlist.state !== false);
const mode = ref<'global' | 'custom'>(props.playlist.endpoint === 'custom' ? 'custom' : 'global');
const customPath = ref(initialCustomPath());

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
    if (res.ok) {
      emit('updated', patch);
      void reloadPlaylists();
    }
  } catch {
  }
}

function setActive(v: boolean) {
  active.value = v;
  save({ state: v });
}

const tags = ref<string[]>([...(props.playlist.tags ?? [])]);
function onTags(v: string[]) {
  tags.value = v;
  save({ tags: v });
  if (applyTags.value) emit('channelsTagged');
}

const applyTags = ref(!!props.playlist.applyTagsToChannels);
function setApplyTags(v: boolean) {
  applyTags.value = v;
  save({ applyTagsToChannels: v });
  if (v) emit('channelsTagged');
}

function setMode(m: 'global' | 'custom') {
  mode.value = m;
  save({ endpoint: m, url: hostedUrl.value });
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

        <template v-if="canSchedule">
          <div class="divider" />
          <FrequencyBuilder :freq="freq" v-model:auto="isAuto" v-model:rawCron="rawCron"
                            label="Sync schedule" icon="refresh"
                            manualHint="Synced manually only. Switch to Automatic to refresh this playlist on a schedule." />
        </template>

        <template v-if="canComposeSchedule">
          <div class="divider" />
          <FrequencyBuilder :freq="m3uFreq" v-model:auto="m3uIsAuto" v-model:rawCron="m3uRawCron"
                            label="Compose m3u" icon="file"
                            manualHint="Composed manually only. Switch to Automatic to rebuild the m3u on a schedule." />
        </template>

        <div class="divider" />

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

        <div class="form-row">
          <div class="field-lbl">Tags</div>
          <TagPicker :model-value="tags" @update:model-value="onTags" />
          <div class="row" style="align-items: center; gap: 10px; margin-top: 12px;">
            <div style="flex: 1;">
              <div class="field-lbl" style="margin: 0;">Apply to all channels</div>
              <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px;">
                {{ applyTags
                  ? 'These tags are added to every channel in this playlist, and re-applied whenever you change them.'
                  : 'Tags stay on the playlist only. Turn on to add them to every channel.' }}
              </div>
            </div>
            <Toggle :on="applyTags" @change="setApplyTags" />
          </div>
        </div>

        <div class="divider" />

        <div class="form-row">
          <div class="row" style="align-items: center; gap: 10px;">
            <div style="flex: 1;">
              <div class="field-lbl" style="margin: 0;">Video proxy engine</div>
              <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px;">
                {{ customProxy ? 'Custom engine settings for this playlist.' : 'Using the default engine settings.' }}
              </div>
            </div>
            <Toggle :on="customProxy" @change="setCustomProxy" />
          </div>
          <div v-if="customProxy" style="margin-top: 12px; padding: 12px; border: 1px solid var(--hairline); border-radius: 8px;">
            <ProxyConfigPanel :config-id="proxyConfigId" flat />
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
