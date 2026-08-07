<script setup lang="ts">
import Icon from './Icon.vue';
export interface SegOpt { value: string; label: string; icon?: string; cls?: string }
// `disabled` is optional and defaults to false, so every existing call site is unchanged. It mirrors the
// posture of the number inputs in ProxyConfigPanel, where a knob that depends on another one is greyed
// rather than hidden — the setting stays discoverable, it just cannot be changed yet.
const props = defineProps<{ value: string; options: SegOpt[]; disabled?: boolean }>();
const emit = defineEmits<{ (e: 'change', v: string): void }>();
</script>
<template>
  <div class="segmented" :class="{ 'is-disabled': props.disabled }">
    <button v-for="o in props.options" :key="o.value"
            :class="[o.cls, value === o.value ? 'active' : '']"
            :disabled="props.disabled"
            @click="emit('change', o.value)">
      <Icon v-if="o.icon" :name="o.icon" :size="13" />
      {{ o.label }}
    </button>
  </div>
</template>
<style scoped>
/* Match the disabled affordance of the inputs beside it rather than inventing a new one. */
.segmented.is-disabled { opacity: 0.5; }
.segmented.is-disabled button { cursor: not-allowed; }
</style>
