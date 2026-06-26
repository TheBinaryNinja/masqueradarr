<script setup lang="ts">
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import StatusDot from './StatusDot.vue';
import { playlistScheduleLabel, type Playlist } from '../data';

// Shared playlist row — the 7-column `.src-row.pl-row` used by the Playlists list AND the Dashboard
// Playlists panel, so the two never drift. Presentational only: the row's data comes in via `playlist`,
// the click navigation is left to the parent (`open`), and the trailing action cell is a SLOT so each
// host supplies its own affordance — the Playlists screen drops in its waffle actions menu, the
// Dashboard falls back to a decorative chevron (visual-only preview).
const props = defineProps<{
  playlist: Playlist;
  // Source-type group indent (the Playlists list groups rows under built-in/clone/file/… headers).
  grouped?: boolean;
  // Always-on wrapping layout for narrow embeds (the Dashboard's narrow panel column), independent of
  // the viewport-width `@media (max-width: 1500px)` breakpoint the full Playlists list relies on.
  compact?: boolean;
}>();

defineEmits<{ (e: 'open'): void }>();

// Per-source-type chip icon (label itself comes straight from the stored `source`).
const SOURCE_CHIP_ICON: Record<string, string> = {
  clone: 'copy',
  file: 'file',
  url: 'link',
  hdhomerun: 'tv',
  import: 'import', // legacy pre-file/url-split rows
};

// Leading source-type chip — ALWAYS rendered so every row shows what kind of playlist it is. Labels are
// LOWERCASE (the repo-wide source-type normalization). The label comes STRAIGHT FROM the stored `source`
// (clone / file / url / hdhomerun, or legacy import) — EXCEPT a registry built-in (p.builtin, i.e. id ===
// source), which keeps its dedicated "built-in" chip. A source-unset legacy/mock row → "manual". Distinct
// from the global/custom *endpoint* chip (where the m3u is hosted, not origination).
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
    <!-- Trailing action cell. The host fills #actions (Playlists → the waffle menu); the default is a
         decorative chevron (Dashboard preview). @click.stop keeps an interactive action from navigating. -->
    <div class="row pl-row-actions" @click.stop>
      <slot name="actions">
        <Btn variant="ghost" size="sm" icon="chevron-r" @click="$emit('open')" />
      </slot>
    </div>
  </div>
</template>
