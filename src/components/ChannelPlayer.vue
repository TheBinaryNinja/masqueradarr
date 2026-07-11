<script setup lang="ts">
// ChannelPlayer — the slide-out's player switch. Reads the global `videoPlayer` setting and mounts either the
// normal in-app player or the diagnostic DebugHlsPlayer. Used ONLY in the channel slide-out (ChannelDrawer) —
// the Dashboard preview always uses the in-app player directly, so the debug player stays an operator-only
// diagnostic. Both players share the same { src } prop + `resolution` emit contract, so this is a transparent
// swap. Async components keep each player's chunk (especially the heavier Vidstack one, once P3 lands) out of
// the initial bundle — loaded only when the drawer actually shows a player. `:key="src"` forces a full remount
// on channel change so the media engine tears down and re-establishes cleanly.
import { defineAsyncComponent } from 'vue';
import { videoPlayer } from '../composables/useSettings';

// The in-app branch is the Vidstack player; the debug branch is the diagnostic hls.js HUD.
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
