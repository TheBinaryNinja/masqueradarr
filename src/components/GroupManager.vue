<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import { GROUPS_BY_PLAYLIST, reloadGroups, createGroup, renameGroup, deleteGroup, type GroupDef } from '../data';
import { bus } from '../composables/bus';

// Whole-playlist group manager: rename / delete / add-empty over the shared first-class group registry
// (GROUPS_BY_PLAYLIST). Shared by BOTH the bulk editor (ChannelBulkDrawer) and the single-channel editor
// (ChannelDrawer, App-level). It calls the data layer directly (which patches the global CHANNELS union +
// the registry store) and announces a rename/delete on the bus (`tvapp:group-changed`) so a screen holding
// a LOCAL channel list (PlaylistDetailScreen) can relabel/clear its rows + fix its active group filter
// without a refetch.
const props = defineProps<{ playlistId: string }>();

// The playlist's group registry (shared store). Self-load it (like GroupPicker) so this works standalone.
const registry = computed<GroupDef[]>(() => GROUPS_BY_PLAYLIST.value[props.playlistId] ?? []);
function ensureLoaded(id: string) {
  if (id && !GROUPS_BY_PLAYLIST.value[id]) reloadGroups(id).catch(() => {});
}
onMounted(() => ensureLoaded(props.playlistId));
watch(() => props.playlistId, (id) => ensureLoaded(id));

// Inline error (rename/delete/create) — surfaced right at the panel rather than via a parent banner, so the
// component stays self-contained (mirrors GroupPicker's createError).
const opError = ref('');

// ── Rename (inline, 3-state row) ──
const renaming = ref<string | null>(null);
const renameVal = ref('');
function startRename(g: GroupDef) {
  renaming.value = g.name;
  renameVal.value = g.name;
  opError.value = '';
}
async function commitRename() {
  const oldName = renaming.value;
  const newName = renameVal.value.trim();
  renaming.value = null;
  if (!oldName || !newName || newName === oldName) return;
  try {
    await renameGroup(props.playlistId, oldName, newName);
    bus.emit('tvapp:group-changed', { source: props.playlistId, kind: 'rename', oldName, newName });
  } catch (e) {
    opError.value = `Rename failed: ${(e as Error).message}`;
  }
}

// ── Delete (inline confirm) ── Deleting keeps the channels; only their group assignment is cleared.
const confirmDeleteGroup = ref<string | null>(null);
async function doDeleteGroup(name: string) {
  confirmDeleteGroup.value = null;
  try {
    await deleteGroup(props.playlistId, name);
    bus.emit('tvapp:group-changed', { source: props.playlistId, kind: 'delete', name });
  } catch (e) {
    opError.value = `Delete failed: ${(e as Error).message}`;
  }
}

// ── Add an EMPTY group (persists with zero channels). No bus event — no channel label changes, and the
// registry-derived filter surfaces it reactively via GROUPS_BY_PLAYLIST. ──
const newGroupName = ref('');
const creatingGroup = ref(false);
async function addEmptyGroup() {
  const name = newGroupName.value.trim();
  if (!name || creatingGroup.value) return;
  creatingGroup.value = true;
  opError.value = '';
  try {
    await createGroup(props.playlistId, name);
    newGroupName.value = '';
  } catch (e) {
    // A duplicate already exists in the list below — treat as benign; other errors surface inline.
    if ((e as Error).message === 'group_exists') newGroupName.value = '';
    else opError.value = 'Could not create group';
  } finally {
    creatingGroup.value = false;
  }
}
</script>

<template>
  <!-- Manage the playlist's groups (immediate, whole-playlist). Same registry the assign picker and the
       single-channel editor read — rename/delete/add here reflect everywhere. -->
  <div class="form-row">
    <div class="field-lbl">Manage groups</div>
    <div class="muted" style="font-size: var(--fs-xs); margin-bottom: 8px;">
      Rename or delete a group across the <b>whole playlist</b>, or add an empty group. Deleting keeps the
      channels — only their group assignment is cleared.
    </div>

    <div v-if="registry.length" class="grp-list">
      <div v-for="g in registry" :key="g.name" class="grp-row">
        <template v-if="renaming === g.name">
          <div class="input" style="flex: 1;">
            <input v-model="renameVal" @keydown.enter.prevent="commitRename" @keydown.esc="renaming = null" />
          </div>
          <Btn variant="ghost" size="sm" icon="check" title="Save" @click="commitRename" />
          <Btn variant="ghost" size="sm" icon="x" title="Cancel" @click="renaming = null" />
        </template>
        <template v-else-if="confirmDeleteGroup === g.name">
          <span style="flex: 1; font-size: var(--fs-sm);">Delete <b>{{ g.name }}</b>?</span>
          <Btn variant="ghost" size="sm" @click="confirmDeleteGroup = null">Cancel</Btn>
          <button class="btn ghost danger" @click="doDeleteGroup(g.name)">
            <Icon name="trash" :size="14" />Delete
          </button>
        </template>
        <template v-else>
          <span style="flex: 1; font-weight: 500; font-size: var(--fs-sm);">{{ g.name }}</span>
          <Pill tone="cyan">{{ g.channels ?? 0 }}</Pill>
          <Btn variant="ghost" size="sm" icon="edit" title="Rename" @click="startRename(g)" />
          <Btn variant="ghost" size="sm" icon="trash" title="Delete group" @click="confirmDeleteGroup = g.name" />
        </template>
      </div>
    </div>
    <div v-else class="muted" style="font-size: var(--fs-xs);">No groups yet.</div>

    <div class="input" style="margin-top: 8px;">
      <Icon name="plus" :size="14" />
      <input v-model="newGroupName" placeholder="Add an empty group…"
             @keydown.enter.prevent="addEmptyGroup" />
      <Btn v-if="newGroupName.trim()" variant="ghost" size="sm" :disabled="creatingGroup" @click="addEmptyGroup">Add</Btn>
    </div>

    <div v-if="opError" class="muted" style="font-size: var(--fs-xs); color: var(--bad); margin-top: 6px;">{{ opError }}</div>
  </div>
</template>

<style scoped>
.grp-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.grp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: var(--bg-2);
}
</style>
