<script setup lang="ts">
// masqueradarr horizontal lockup — mark + lowercase wordmark.
// Wordmark is always lowercase, weight 600, tracking -0.03em.
// See .claude/skills/masqueradarr-logotype §2/§3.
import MasqMark from './MasqMark.vue';
defineProps<{
  size?: number;
  color?: string;
}>();
</script>

<template>
  <span class="masq-lockup" :style="{ color: color ?? 'var(--accent)', fontSize: (size ?? 28) + 'px' }">
    <MasqMark :size="size ?? 28" />
    <span class="masq-word">masqueradarr</span>
  </span>
</template>

<style scoped>
.masq-lockup {
  display: inline-flex;
  align-items: center;
  gap: 0.42em;
  font-family: var(--mq-font-sans);
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1;
}
.masq-word { display: inline-block; }
</style>
