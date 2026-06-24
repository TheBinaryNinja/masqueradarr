<script setup lang="ts">
// Toast Upper-Right host — renders upper-right-positioned toasts (below the topbar). Mounted once in
// App.vue; reads the shared useToast queue. See styles.css `.toasts-tr`.
import { computed } from 'vue';
import ToastCard from './ToastCard.vue';
import { useToast } from '../composables/useToast';

const { toasts } = useToast();
const items = computed(() => toasts.value.filter((t) => t.position === 'upper-right'));
</script>

<template>
  <div class="toasts toasts-tr">
    <ToastCard v-for="t in items" :key="t.id" :toast="t" />
  </div>
</template>
