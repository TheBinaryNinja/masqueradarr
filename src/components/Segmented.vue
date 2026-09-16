<script setup lang="ts">
import Icon from './Icon.vue';
export interface SegOpt { value: string; label: string; icon?: string; cls?: string }
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
.segmented.is-disabled { opacity: 0.5; }
.segmented.is-disabled button { cursor: not-allowed; }
</style>
