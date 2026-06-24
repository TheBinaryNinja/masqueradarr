<script setup lang="ts">
// Toast Lower-Right host — renders lower-right-positioned toasts (newest at the bottom). Mounted once in
// App.vue; reads the shared useToast queue. Also carries the scheduled-sync (cron) toasts. See
// styles.css `.toasts-br`.
import { computed } from 'vue';
import ToastCard from './ToastCard.vue';
import { useToast } from '../composables/useToast';

const { toasts } = useToast();
const items = computed(() => toasts.value.filter((t) => t.position === 'lower-right'));
</script>

<template>
  <div class="toasts toasts-br">
    <ToastCard v-for="t in items" :key="t.id" :toast="t" />
  </div>
</template>
