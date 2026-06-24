<script setup lang="ts">
// The shared visual card rendered by all three positioned toast hosts (ToastBanner / ToastUpperRight /
// ToastLowerRight). Owns the close button, hover-to-pause wiring, and the decrementing timeout progress
// bar. Positioning + entry animation are driven by the host container's class (see styles.css), not here.
import Icon from './Icon.vue';
import { useToast, type ToastItem } from '../composables/useToast';

defineProps<{ toast: ToastItem }>();
const { dismiss, pause, resume } = useToast();
</script>

<template>
  <div :class="['toast-card', toast.tone]" role="status" aria-live="polite"
       @mouseenter="pause(toast.id)" @mouseleave="resume(toast.id)">
    <Icon :name="toast.icon" :size="15" />
    <div class="toast-card-body">
      <div v-if="toast.title" class="toast-card-title">{{ toast.title }}</div>
      <div class="toast-card-text">{{ toast.text }}</div>
    </div>
    <button class="toast-card-x" @click="dismiss(toast.id)" aria-label="Dismiss">
      <Icon name="x" :size="12" />
    </button>
    <div v-if="toast.duration > 0"
         :class="['toast-progress', { paused: toast.paused }]"
         :style="{ animationDuration: toast.duration + 'ms' }" />
  </div>
</template>
