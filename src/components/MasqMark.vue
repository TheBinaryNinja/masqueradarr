<script setup lang="ts">
defineProps<{
  size?: number | string;
  color?: string;
}>();
</script>

<template>
  <svg viewBox="0 0 120 120" :width="size ?? 32" :height="size ?? 32" fill="none"
       role="img" aria-label="masqueradarr">
    <path d="M26 94 L26 30 L60 64 L94 30 L94 94"
          :stroke="color ?? 'currentColor'" stroke-width="14"
          stroke-linejoin="round" stroke-linecap="round" />
  </svg>
</template>
