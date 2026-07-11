<script setup lang="ts">
// Global-search results dropdown — grouped result tables rendered under the topbar search box. Owns its own
// click-away backdrop + Escape handling; App.vue owns the query/fetch and the navigation on select.
import { computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import Pill from './Pill.vue';
import { type SearchResponse, type SearchRow, searchIsEmpty } from '../composables/useSearch';

const props = defineProps<{
  results: SearchResponse | null;
  loading?: boolean;
  query: string;
}>();
const emit = defineEmits<{ (e: 'select', row: SearchRow): void; (e: 'close'): void }>();

const isEmpty = computed(() => !props.loading && searchIsEmpty(props.results));

function rowIcon(type: SearchRow['type']): string {
  if (type === 'playlist') return 'playlist';
  if (type === 'epg-source') return 'grid';
  if (type === 'epg-channel') return 'link';
  return 'tv';
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="sr-backdrop" @click="emit('close')" />
  <div class="sr-panel glass">
    <div v-if="loading" class="sr-empty">Searching…</div>
    <div v-else-if="isEmpty" class="sr-empty">No matches for "{{ query }}"</div>
    <template v-else-if="results">
      <!-- Direct playlist / EPG-source name matches. -->
      <div v-if="results.topLevel.playlists.length" class="sr-group">
        <div class="sr-group-hd"><span>Playlists</span></div>
        <button v-for="r in results.topLevel.playlists" :key="'p:' + r.id" type="button" class="sr-row" @click="emit('select', r)">
          <Icon :name="rowIcon(r.type)" :size="14" />
          <span class="sr-label">{{ r.label }}</span>
          <span class="sr-sub muted">{{ r.sublabel }}</span>
        </button>
      </div>
      <div v-if="results.topLevel.epgSources.length" class="sr-group">
        <div class="sr-group-hd"><span>EPG Sources</span></div>
        <button v-for="r in results.topLevel.epgSources" :key="'e:' + r.id" type="button" class="sr-row" @click="emit('select', r)">
          <Icon :name="rowIcon(r.type)" :size="14" />
          <span class="sr-label">{{ r.label }}</span>
          <span class="sr-sub muted">{{ r.sublabel }}</span>
        </button>
      </div>

      <!-- Channel / EPG-channel matches, grouped by their owning parent resource. -->
      <div v-for="g in results.groups" :key="g.kind + ':' + g.id" class="sr-group">
        <div class="sr-group-hd">
          <span>{{ g.label }}</span>
          <Pill :tone="g.kind === 'playlist' ? 'cyan' : 'active'">{{ g.kind === 'playlist' ? 'playlist' : 'epg source' }}</Pill>
        </div>
        <button v-for="r in g.rows" :key="r.id" type="button" class="sr-row" @click="emit('select', r)">
          <Icon :name="rowIcon(r.type)" :size="14" />
          <span class="sr-label">{{ r.label }}</span>
          <span class="sr-sub muted">{{ r.sublabel }}</span>
        </button>
        <div v-if="g.total > g.rows.length" class="sr-more muted">+{{ g.total - g.rows.length }} more</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.sr-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
}
.sr-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: min(480px, 90vw);
  max-height: 66vh;
  overflow-y: auto;
  z-index: 91;
  border-radius: 12px;
  border: 1px solid var(--hairline);
  padding: 6px;
  box-shadow: var(--shadow-2, 0 12px 40px rgba(0, 0, 0, 0.4));
}
.sr-empty {
  padding: 18px 14px;
  font-size: var(--fs-sm);
  color: var(--text-2);
  text-align: center;
}
.sr-group + .sr-group {
  border-top: 1px solid var(--hairline);
  margin-top: 4px;
  padding-top: 4px;
}
.sr-group-hd {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 4px;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.sr-group-hd > span:first-child {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-transform: none;
  letter-spacing: 0;
  font-size: var(--fs-sm);
  color: var(--text-1);
}
.sr-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  color: var(--text-1);
}
.sr-row:hover {
  background: var(--bg-2);
}
.sr-label {
  font-size: var(--fs-sm);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sr-sub {
  margin-left: auto;
  font-size: var(--fs-xs);
  white-space: nowrap;
}
.sr-more {
  padding: 4px 10px 8px;
  font-size: var(--fs-xs);
}
</style>
