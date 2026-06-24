<script setup lang="ts">
// Toast Banner host — renders banner-positioned toasts centered at the top-middle of the window.
// Mounted once in App.vue; reads the shared useToast queue. See styles.css `.toasts-banner`.
import { computed } from 'vue';
import ToastCard from './ToastCard.vue';
import { useToast } from '../composables/useToast';

const { toasts } = useToast();
const items = computed(() => toasts.value.filter((t) => t.position === 'banner'));
</script>

<template>
  <div class="toasts toasts-banner">
    <ToastCard v-for="t in items" :key="t.id" :toast="t" />
  </div>
</template>
