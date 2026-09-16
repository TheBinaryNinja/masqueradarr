<script setup lang="ts">
import { ref, reactive, computed, onMounted, nextTick, watch } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import FrequencyBuilder from './FrequencyBuilder.vue';
import TagPicker from './TagPicker.vue';
import {
  type CronFrequency, type CronJob, type EpgSource,
  CRON_JOBS, reloadEpgSources, reloadCronjobs,
} from '../data';
import { timezone } from '../composables/useSettings';
import { defaultFrequency, buildCron, summarizeFrequency } from '../composables/useSchedule';

const props = defineProps<{ source: EpgSource }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const isXmlFile = computed(() => props.source.source === 'xml file');
const isPlaylistBound = computed(() => !!props.source.playlistBinding);
const builtin = computed(() => !!props.source.builtin);
const showSchedule = computed(() => !isXmlFile.value && !isPlaylistBound.value);

async function putEpg(patch: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`/api/epg-sources/${encodeURIComponent(props.source.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) void reloadEpgSources();
    return res.ok;
  } catch {
    return false;
  }
}

const name = ref(props.source.name);
let nameTimer: ReturnType<typeof setTimeout> | null = null;
function onName(v: string): void {
  name.value = v;
  if (nameTimer) clearTimeout(nameTimer);
  nameTimer = setTimeout(() => {
    const trimmed = name.value.trim();
    if (trimmed && trimmed !== props.source.name) void putEpg({ name: trimmed });
  }, 400);
}

const tags = ref<string[]>([...(props.source.tags ?? [])]);
function onTags(v: string[]): void {
  tags.value = v;
  void putEpg({ tags: v });
}

const job = computed<CronJob | null>(() =>
  CRON_JOBS.value.find((j) => j.targetType === 'epg-source' && j.targetId === props.source.id) || null,
);
const isAuto = ref(!!props.source.auto);
const freq = reactive<CronFrequency>(defaultFrequency());
const rawCron = ref('0 */6 * * *');
const cron = computed(() => buildCron(freq, rawCron.value));
const summary = computed(() => summarizeFrequency(freq, rawCron.value));

const hydrated = ref(false);
onMounted(async () => {
  const j = job.value;
  if (j) {
    isAuto.value = true;
    if (j.frequency && typeof j.frequency.mode === 'string') Object.assign(freq, j.frequency);
    if (typeof j.cron === 'string') rawCron.value = j.cron;
  } else {
    isAuto.value = !!props.source.auto;
  }
  await nextTick();
  hydrated.value = true;
});

async function saveSchedule(): Promise<void> {
  if (!showSchedule.value || builtin.value) return;
  if (isAuto.value && !cron.value.trim()) return;
  const path = `/api/cronjobs/${encodeURIComponent(props.source.id)}?targetType=epg-source`;
  try {
    await putEpg({ interval: isAuto.value ? summary.value : 'manual', auto: isAuto.value });
    if (isAuto.value) {
      await fetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: 'epg-source',
          cron: cron.value,
          frequency: { ...freq },
          timezone: timezone.value || null,
          enabled: true,
        }),
      });
    } else {
      await fetch(path, { method: 'DELETE' });
    }
    await reloadCronjobs();
  } catch {
  }
}

let schedTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => [isAuto.value, rawCron.value, JSON.stringify(freq)],
  () => {
    if (!hydrated.value) return;
    if (schedTimer) clearTimeout(schedTimer);
    schedTimer = setTimeout(() => void saveSchedule(), 500);
  },
);
</script>

<template>
  <div class="drawer-wrap">
    <div class="glass-bg drawer-backdrop" @click="emit('close')" />
    <div class="glass drawer-panel" style="width: 50vw; max-width: 50vw; min-width: 440px;">
      <div class="drawer-hd">
        <div class="src-ico" style="width: 44px; height: 44px; border-radius: 10px; color: var(--good);">
          <Icon :name="builtin ? 'tv' : 'epg'" :size="20" />
        </div>
        <div style="flex: 1;">
          <div style="font-weight: 600; font-size: 15px;">Edit EPG source</div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px;">{{ source.name }}</div>
        </div>
        <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
      </div>

      <div class="drawer-body">
        <div class="form-row">
          <div class="field-lbl">Name</div>
          <div class="input">
            <Icon name="epg" :size="14" />
            <input :value="name" @input="onName(($event.target as HTMLInputElement).value)" placeholder="EPG source name" />
          </div>
        </div>

        <template v-if="showSchedule">
          <div class="divider" />
          <div :style="builtin ? 'opacity: 0.55; pointer-events: none;' : ''">
            <FrequencyBuilder :freq="freq" v-model:auto="isAuto" v-model:rawCron="rawCron"
                              label="Sync schedule" icon="sync"
                              manualHint="Synced manually only. Switch to Automatic to run it on a schedule." />
          </div>
          <div v-if="builtin" class="muted" style="font-size: var(--fs-xs);">
            The built-in source is auto-updated with the app — its schedule can't be changed.
          </div>
        </template>

        <div class="divider" />

        <div class="form-row">
          <div class="field-lbl">Tags</div>
          <div class="muted" style="font-size: var(--fs-xs); margin: 0 0 8px;">
            Tags are searchable and shared across the app.
          </div>
          <TagPicker :model-value="tags" @update:model-value="onTags" />
        </div>

        <div class="row" style="margin-top: auto; padding-top: 8px;">
          <span class="muted" style="font-size: var(--fs-xs);">
            <Icon name="check" :size="11" /> Changes save automatically
          </span>
          <span class="spacer" />
          <Btn variant="ghost" @click="emit('close')">Done</Btn>
        </div>
      </div>
    </div>
  </div>
</template>
