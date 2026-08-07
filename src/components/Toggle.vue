<script setup lang="ts">
const props = defineProps<{ on: boolean; disabled?: boolean }>();
const emit = defineEmits<{ (e: 'change', v: boolean): void }>();
</script>
<template>
  <div :class="['toggle', { on: props.on, disabled: props.disabled }]" role="switch"
       :aria-checked="!!props.on" :aria-disabled="!!props.disabled"
       @click="props.disabled || emit('change', !props.on)" />
</template>
