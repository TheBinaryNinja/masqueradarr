<script setup lang="ts">
// Half-screen slide-out schedule editor, shared by the EPG detail screen's two schedule cards
// (the "Sync schedule" and "EPG-XML compose" cards). It edits a single cronjobs doc keyed
// `<targetType>:<targetId>` — Auto upserts it (PUT /api/cronjobs/<enc(targetId)>?targetType=<t>),
// Manual deletes it. When `syncEpgInterval` is true (the sync card) it ALSO mirrors the friendly
// interval label + auto flag onto the EpgSource row (PUT /api/epg-sources/:id) so the header pill
// stays in sync. The frequency builder is the same useSchedule.ts logic the rest of the app uses.
import { ref, reactive, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import FrequencyBuilder from './FrequencyBuilder.vue';
import { type CronFrequency, type CronJob } from '../data';
import { timezone } from '../composables/useSettings';
import { defaultFrequency, buildCron, summarizeFrequency } from '../composables/useSchedule';

const props = defineProps<{
  title: string;        // drawer + card label, e.g. 'Sync schedule'
  icon: string;         // header icon name
  sourceId: string;     // the cronjob targetId (the EpgSource id)
  sourceName: string;   // subtitle in the drawer header
  targetType: string;   // 'epg-source' | 'epg-xml'
  job: CronJob | null;  // the current paired cron job (null = manual)
  auto: boolean;        // current interval-type (Automatic when true)
  disabled?: boolean;   // builtin sources can't edit
  // When true, also persist the friendly interval label + auto flag to the EpgSource row.
  syncEpgInterval?: boolean;
}>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>();

const isAuto = ref(props.auto);
const freq = reactive<CronFrequency>(defaultFrequency());
const rawCron = ref('0 */6 * * *');
const saving = ref(false);
const error = ref('');

const cron = computed(() => buildCron(freq, rawCron.value));
const summary = computed(() => summarizeFrequency(freq, rawCron.value));

// Hydrate the builder from the existing job (so re-opening shows the saved schedule).
onMounted(() => {
  const job = props.job;
  if (job) {
    isAuto.value = true;
    if (job.frequency && typeof job.frequency.mode === 'string') Object.assign(freq, job.frequency);
    if (typeof job.cron === 'string') rawCron.value = job.cron;
  } else {
    isAuto.value = props.auto;
  }
});

async function save() {
  if (props.disabled || saving.value) return;
  error.value = '';
  if (isAuto.value && !cron.value.trim()) { error.value = 'Enter a schedule.'; return; }
  saving.value = true;
  const path = `/api/cronjobs/${encodeURIComponent(props.sourceId)}?targetType=${encodeURIComponent(props.targetType)}`;
  try {
    if (props.syncEpgInterval) {
      const epgRes = await fetch(`/api/epg-sources/${encodeURIComponent(props.sourceId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interval: isAuto.value ? summary.value : 'manual', auto: isAuto.value }),
      });
      if (!epgRes.ok) throw new Error('epg update failed');
    }
    if (isAuto.value) {
      const jobRes = await fetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: props.targetType,
          cron: cron.value,
          frequency: { ...freq },
          timezone: timezone.value || null,
          enabled: true,
        }),
      });
      if (!jobRes.ok) throw new Error('schedule save failed');
    } else {
      await fetch(path, { method: 'DELETE' });
    }
    emit('saved');
    emit('close');
  } catch {
    error.value = 'Could not save — please try again.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="drawer-wrap">
    <div class="glass-bg drawer-backdrop" @click="emit('close')" />
    <div class="glass drawer-panel" style="width: 50vw; max-width: 50vw; min-width: 440px;">
      <div class="drawer-hd">
        <div class="src-ico" style="width: 44px; height: 44px; border-radius: 10px; color: var(--accent);">
          <Icon :name="icon" :size="20" />
        </div>
        <div style="flex: 1;">
          <div style="font-weight: 600; font-size: 15px;">{{ title }}</div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px;">{{ sourceName }}</div>
        </div>
        <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
      </div>

      <div class="drawer-body">
        <FrequencyBuilder :freq="freq" v-model:auto="isAuto" v-model:rawCron="rawCron"
                          label="Interval type" :icon="icon"
                          manualHint="Runs manually only. Switch to Automatic to run it on a schedule." />

        <div v-if="error" class="muted" style="color: var(--bad); font-size: var(--fs-sm);">{{ error }}</div>

        <div class="row" style="margin-top: auto; padding-top: 8px;">
          <span class="spacer" />
          <Btn variant="ghost" :disabled="saving" @click="emit('close')">Cancel</Btn>
          <Btn variant="primary" icon="check" :disabled="saving || disabled" @click="save">
            {{ saving ? 'Saving…' : 'Save schedule' }}
          </Btn>
        </div>
      </div>
    </div>
  </div>
</template>
