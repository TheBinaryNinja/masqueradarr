<script setup lang="ts">
import { defineAsyncComponent } from 'vue';
import { videoPlayer } from '../composables/useSettings';

const InAppPlayer = defineAsyncComponent(() => import('./VidstackPlayer.vue'));
const DebugHlsPlayer = defineAsyncComponent(() => import('./DebugHlsPlayer.vue'));

defineProps<{ src: string | null }>();
defineEmits<{ (e: 'resolution', res: string): void }>();
</script>

<template>
  <component
    :is="videoPlayer === 'debug' ? DebugHlsPlayer : InAppPlayer"
    :key="src"
    :src="src"
    @resolution="$emit('resolution', $event)"
  />
</template>
