<script setup lang="ts">
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
