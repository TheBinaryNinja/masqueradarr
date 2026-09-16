<script setup lang="ts">
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import StatusDot from './StatusDot.vue';
import { playlistScheduleLabel, tagNames, type Playlist } from '../data';

const props = defineProps<{
  playlist: Playlist;
  grouped?: boolean;
  compact?: boolean;
  reorderable?: boolean;
}>();

defineEmits<{ (e: 'open'): void }>();

const SOURCE_CHIP_ICON: Record<string, string> = {
  clone: 'copy',
  file: 'file',
  url: 'link',
  hdhomerun: 'tv',
  local: 'map',
  import: 'import',
};

function sourceChip(p: Playlist): { label: string; tone: string; icon: string } {
  if (p.builtin) return { label: 'built-in', tone: 'system', icon: 'check' };
  if (p.source) return { label: p.source, tone: 'system', icon: SOURCE_CHIP_ICON[p.source] ?? 'playlist' };
  return { label: 'manual', tone: 'system', icon: 'list' };
}
</script>

<template>
  <div
    class="src-row pl-row"
    :class="{ 'pl-grouped': grouped, 'pl-row-compact': compact }"
    @click="$emit('open')"
  >
    <span v-if="reorderable" class="drag-grip" title="Drag to reorder" @click.stop>
      <Icon name="grip" :size="16" />
    </span>
    <div :class="['src-ico', { builtin: playlist.builtin }]">
      <Icon :name="playlist.builtin ? 'tv' : 'playlist'" :size="18" />
    </div>
    <div class="pl-row-head">
      <div class="src-name">
        <div class="pl-name-row">
          <StatusDot :status="playlist.status" :pulse="playlist.status === 'good'" />
          <span class="pl-name" :title="playlist.name">{{ playlist.name }}</span>
        </div>
        <div class="pl-chip-row">
          <Pill :tone="sourceChip(playlist).tone"><Icon :name="sourceChip(playlist).icon" :size="10" />{{ sourceChip(playlist).label }}</Pill>
          <Pill tone="cyan"><Icon name="refresh" :size="10" />Sync: {{ playlistScheduleLabel(playlist.id, 'playlist') }}</Pill>
          <Pill tone="cyan"><Icon name="file" :size="10" />M3U: {{ playlistScheduleLabel(playlist.id, 'playlist-m3u') }}</Pill>
          <Pill :tone="playlist.endpoint === 'custom' ? 'warn' : 'good'">
            <Icon :name="playlist.endpoint === 'custom' ? 'file' : 'globe'" :size="10" />
            {{ playlist.endpoint === 'custom' ? 'custom' : 'global' }}
          </Pill>
          <Pill v-if="playlist.authentication" :tone="playlist.isAuthenticated ? 'good' : 'warn'">
            <Icon :name="playlist.isAuthenticated ? 'check' : 'lock'" :size="10" />
            {{ playlist.isAuthenticated ? 'Authenticated' : 'Sign-in needed' }}
          </Pill>
          <Pill v-for="n in tagNames(playlist.tags)" :key="n" tone="magenta">{{ n }}</Pill>
        </div>
      </div>
    </div>
    <Pill :tone="playlist.state !== false ? 'cyan' : 'disabled'">
      {{ playlist.state !== false ? 'Active' : 'Inactive' }}
    </Pill>
    <div class="stat-mini"><b>{{ playlist.channels }}</b>channels</div>
    <div class="stat-mini"><b>{{ playlist.groups }}</b>groups</div>
    <div class="stat-mini">
      <b style="font-size: 12px; font-weight: 500; color: var(--text-1);">{{ playlist.lastSync }}</b>
      last sync
    </div>
    <div class="row pl-row-actions" @click.stop>
      <slot name="actions">
        <Btn variant="ghost" size="sm" icon="chevron-r" @click="$emit('open')" />
      </slot>
    </div>
  </div>
</template>
