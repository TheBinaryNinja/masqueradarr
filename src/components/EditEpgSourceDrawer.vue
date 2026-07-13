<script setup lang="ts">
// Half-screen slide-out for editing an EPG source's user-owned fields — Name, Sync schedule, and Tags —
// opened from the "Edit" item in the EPG Sources waffle menu (list + detail screens). It supersedes the old
// standalone "Sync Schedule" button (ScheduleEditorDrawer) and the standalone Tags card by folding both into
// one panel. Every field AUTO-SAVES on change (no explicit Save): Name is debounced, Tags persist on toggle,
// and the schedule is debounced — matching the PlaylistStatusDrawer posture. Self-contained like TagPicker:
// it reads CRON_JOBS for the paired sync job and re-pulls the shared stores after each write so the list rows
// and the detail header reflect edits without a page reload.
//
// The Sync schedule section only applies to sources with a re-fetchable upstream: it is HIDDEN for 'xml file'
// (one-shot upload) and playlist-bound sources (their playlist owns the cadence), and DISABLED for the
// built-in source. Name + Tags remain editable for those. See EPGDetailScreen / ScheduleEditorDrawer for the
// original cron write shape (PUT|DELETE /api/cronjobs/:id?targetType=epg-source + the interval/auto mirror).
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

// Source-kind gates (mirror EPGDetailScreen): 'xml file' is a one-shot upload (no sync cadence); a
// playlist-bound row's guide is driven by its playlist; the built-in source ships preconfigured.
const isXmlFile = computed(() => props.source.source === 'xml file');
const isPlaylistBound = computed(() => !!props.source.playlistBinding);
const builtin = computed(() => !!props.source.builtin);
const showSchedule = computed(() => !isXmlFile.value && !isPlaylistBound.value);

// Shared PUT for the EpgSource row's user-owned fields (name / tags / interval / auto). Re-pulls the store so
// every screen derived from EPG_SOURCES refreshes. Best-effort — the local field keeps its optimistic value.
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

// ── Name — debounced rename (like PlaylistStatusDrawer.onName) ─────────────────────────────────────────
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

// ── Tags — persist immediately on toggle (like EPGDetailScreen.saveTags) ───────────────────────────────
const tags = ref<string[]>([...(props.source.tags ?? [])]);
function onTags(v: string[]): void {
  tags.value = v;
  void putEpg({ tags: v });
}

// ── Sync schedule — the shared FrequencyBuilder, auto-saved (debounced) on change ──────────────────────
// The schedule lives in a cronjobs doc keyed epg-source:<id>; Automatic upserts it, Manual deletes it. We
// also mirror the friendly interval label + auto flag onto the EpgSource row (the header pill reads it).
const job = computed<CronJob | null>(() =>
  CRON_JOBS.value.find((j) => j.targetType === 'epg-source' && j.targetId === props.source.id) || null,
);
const isAuto = ref(!!props.source.auto);
const freq = reactive<CronFrequency>(defaultFrequency());
const rawCron = ref('0 */6 * * *');
const cron = computed(() => buildCron(freq, rawCron.value));
const summary = computed(() => summarizeFrequency(freq, rawCron.value));

// `hydrated` guards the auto-save watcher so seeding the builder from the existing job (below) doesn't fire a
// spurious write on open. Flipped true after the initial hydration settles.
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
  // Auto mode needs a compiled cron; a half-typed custom expression writes nothing until it's valid.
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
      // DELETE is idempotent — a 404 (already manual) is fine.
      await fetch(path, { method: 'DELETE' });
    }
    await reloadCronjobs();
  } catch {
    /* best-effort; the builder keeps its local state and the next change retries */
  }
}

// Debounce schedule writes so toggling Manual/Automatic or tweaking the frequency doesn't fire per keystroke.
// Deep-watch `freq` via a serialized snapshot (it's mutated in place by the builder).
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
        <!-- Name -->
        <div class="form-row">
          <div class="field-lbl">Name</div>
          <div class="input">
            <Icon name="epg" :size="14" />
            <input :value="name" @input="onName(($event.target as HTMLInputElement).value)" placeholder="EPG source name" />
          </div>
        </div>

        <!-- Sync schedule — only for sources with a re-fetchable upstream; disabled for the built-in source. -->
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

        <!-- Tags -->
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
