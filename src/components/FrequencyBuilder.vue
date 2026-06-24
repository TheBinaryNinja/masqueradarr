<script setup lang="ts">
// Shared Manual/Automatic schedule frequency builder — the single source of truth for the cron-frequency
// UI used by every schedule editor: the EPG ScheduleEditorDrawer (sync + EPG-XML cards) and the Playlist
// status drawer (Sync + Compose m3u). Renders the Manual/Automatic toggle and, when Automatic, the
// frequency-mode picker + per-mode inputs + a live summary/cron preview. State is owned by the parent:
// `freq` is a reactive CronFrequency mutated in place; `auto` and `rawCron` are v-model bindings. The
// parent compiles the cron it persists via buildCron(freq, rawCron). See useSchedule.ts + schemas.md §3.13.
import { computed } from 'vue';
import Icon from './Icon.vue';
import Segmented from './Segmented.vue';
import { type CronFrequency } from '../data';
import { WEEKDAYS, FREQUENCY_MODES, buildCron, summarizeFrequency } from '../composables/useSchedule';

const props = defineProps<{
  freq: CronFrequency; // reactive frequency object, mutated in place
  auto: boolean;       // Automatic (true) vs Manual (false) — v-model:auto
  rawCron: string;     // custom-mode cron string — v-model:rawCron
  label: string;       // toggle-row label, e.g. 'Sync schedule' | 'Interval type'
  icon: string;        // preview-row icon
  manualHint: string;  // muted text shown when Manual
  modes?: { value: string; label: string; icon: string }[]; // override the frequency-mode set (e.g. the
  //                     probe schedule omits 'minutes'/'custom' to enforce its once-per-hour floor). Default: all.
  hideMode?: boolean;  // hide the Manual/Automatic toggle — the PARENT owns enable/disable (e.g. a master
  //                     toggle that mounts this only when enabled), so the cadence editor renders directly.
}>();
const modeOptions = computed(() => props.modes ?? FREQUENCY_MODES);
const emit = defineEmits<{
  (e: 'update:auto', v: boolean): void;
  (e: 'update:rawCron', v: string): void;
}>();

function pad2(n: number): string { return String(n).padStart(2, '0'); }

const cron = computed(() => buildCron(props.freq, props.rawCron));
const summary = computed(() => summarizeFrequency(props.freq, props.rawCron));
const time = computed<string>({
  get: () => `${pad2(props.freq.atHour ?? (props.freq.mode === 'weekly' ? 4 : 3))}:${pad2(props.freq.atMinute ?? 0)}`,
  set: (v: string) => {
    const [h, m] = v.split(':').map(Number);
    props.freq.atHour = Number.isFinite(h) ? h : 0;
    props.freq.atMinute = Number.isFinite(m) ? m : 0;
  },
});
function setEvery(v: string) { const n = Number(v); props.freq.every = Number.isFinite(n) ? n : null; }
function toggleDay(d: number) {
  const cur = props.freq.daysOfWeek ?? [];
  props.freq.daysOfWeek = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d];
}
</script>

<template>
  <div v-if="!hideMode" class="form-row">
    <div class="field-lbl">{{ label }}</div>
    <Segmented :value="auto ? 'auto' : 'manual'" @change="(v) => emit('update:auto', v === 'auto')" :options="[
      { value: 'manual', label: 'Manual', icon: 'pause' },
      { value: 'auto', label: 'Automatic', icon: 'refresh' },
    ]" />
  </div>

  <template v-if="auto || hideMode">
    <div class="divider" />

    <div class="form-row">
      <div class="field-lbl">Frequency</div>
      <Segmented :value="freq.mode" :options="modeOptions"
                 @change="(v) => (freq.mode = v as CronFrequency['mode'])" />
    </div>

    <div v-if="freq.mode === 'minutes'" class="row" style="gap: 8px; align-items: center;">
      <span style="font-size: var(--fs-sm);">Every</span>
      <div class="input" style="width: 90px;">
        <input type="number" min="1" max="59" :value="freq.every ?? 15"
               @input="setEvery(($event.target as HTMLInputElement).value)" />
      </div>
      <span style="font-size: var(--fs-sm);">minutes</span>
    </div>
    <div v-else-if="freq.mode === 'hourly'" class="row" style="gap: 8px; align-items: center;">
      <span style="font-size: var(--fs-sm);">Every</span>
      <div class="input" style="width: 90px;">
        <input type="number" min="1" max="23" :value="freq.every ?? 6"
               @input="setEvery(($event.target as HTMLInputElement).value)" />
      </div>
      <span style="font-size: var(--fs-sm);">hours</span>
    </div>
    <div v-else-if="freq.mode === 'daily'" class="row" style="gap: 8px; align-items: center;">
      <span style="font-size: var(--fs-sm);">At</span>
      <div class="input" style="width: 130px;"><input type="time" v-model="time" /></div>
    </div>
    <div v-else-if="freq.mode === 'weekly'" style="display: grid; gap: 10px;">
      <div class="row" style="gap: 6px; flex-wrap: wrap;">
        <button v-for="d in WEEKDAYS" :key="d.value" type="button"
                class="day-chip" :class="{ on: (freq.daysOfWeek ?? []).includes(d.value) }"
                @click="toggleDay(d.value)">{{ d.label }}</button>
      </div>
      <div class="row" style="gap: 8px; align-items: center;">
        <span style="font-size: var(--fs-sm);">At</span>
        <div class="input" style="width: 130px;"><input type="time" v-model="time" /></div>
      </div>
    </div>
    <div v-else-if="freq.mode === 'custom'" class="form-row">
      <div class="input mono" style="font-size: 12px;">
        <input :value="rawCron" @input="emit('update:rawCron', ($event.target as HTMLInputElement).value)"
               placeholder="0 */6 * * *" />
      </div>
      <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
        Standard 5-field cron expression (minute hour day month weekday).
      </div>
    </div>

    <div class="row" style="gap: 8px; align-items: center; padding: 10px 12px; border: 1px solid var(--hairline); border-radius: 8px; background: var(--bg-2);">
      <Icon :name="icon" :size="14" style="color: var(--accent);" />
      <span style="font-size: var(--fs-sm); font-weight: 500;">{{ summary }}</span>
      <span class="spacer" />
      <code class="cron-chip">{{ cron || '—' }}</code>
    </div>
  </template>
  <div v-else class="muted" style="font-size: var(--fs-sm);">{{ manualHint }}</div>
</template>
