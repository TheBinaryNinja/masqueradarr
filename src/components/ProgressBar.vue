<script setup lang="ts">
// Thin progress-bar primitive over the global .progress classes (styles.css), matching the
// Btn/Pill/Stat house pattern (no scoped styles). `value` 0..1 renders a determinate bar; a null /
// undefined value renders an indeterminate (animated) sliver. Used by the Playlists screens to show
// a per-row Sync/Compose busy bar between the name and the action buttons.
import { computed } from 'vue';

const props = defineProps<{
  value?: number | null;
  tone?: 'accent' | 'good' | 'warn';
}>();

const indeterminate = computed(() => props.value == null);
const pct = computed(() => Math.round(Math.min(1, Math.max(0, props.value ?? 0)) * 100));
</script>
<template>
  <div
    class="progress"
    :class="[tone && tone !== 'accent' ? `progress-${tone}` : '', { 'progress-indeterminate': indeterminate }]"
    role="progressbar"
    :aria-valuemin="0"
    :aria-valuemax="100"
    :aria-valuenow="indeterminate ? undefined : pct"
  >
    <div class="progress-fill" :style="indeterminate ? undefined : { width: pct + '%' }" />
  </div>
</template>
