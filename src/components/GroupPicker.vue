<script setup lang="ts">
// Shared channel-group picker — a registry-backed <select> plus an optional "create new group" affordance,
// used by BOTH the single-channel drawer (ChannelDrawer) and the bulk editor (ChannelBulkDrawer). Because it
// reads/writes the shared GROUPS_BY_PLAYLIST registry, a group created here in one editor immediately appears
// in the other. Creating a group PERSISTS it (an empty first-class group), so the taxonomy is durable rather
// than a transient string. `modelValue` is the selected group name ('' = no group / leave unchanged).
import { ref, computed, watch, onMounted } from 'vue';
import Icon from './Icon.vue';
import { GROUPS_BY_PLAYLIST, reloadGroups, createGroup, type GroupDef } from '../data';

const props = defineProps<{
  modelValue: string; // selected group name, or '' (no group / leave unchanged)
  playlistId: string;
  allowCreate?: boolean; // show the inline "create a new group" input
  allowUnchanged?: boolean; // bulk editor: the '' option means "leave unchanged" rather than "no group"
  unchangedLabel?: string; // custom label for the '' option in the bulk editor
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const groups = computed<GroupDef[]>(() => GROUPS_BY_PLAYLIST.value[props.playlistId] ?? []);

// Load the registry for this playlist the first time it's needed (idempotent — cached in the store).
function ensureLoaded(id: string) {
  if (id && !GROUPS_BY_PLAYLIST.value[id]) reloadGroups(id).catch(() => {});
}
onMounted(() => ensureLoaded(props.playlistId));
watch(() => props.playlistId, (id) => ensureLoaded(id));

const selectVal = computed({
  get: () => props.modelValue,
  set: (v: string) => emit('update:modelValue', v),
});

// The current value can be a legacy channel group not (yet) in the registry — surface it so the select shows it.
const showOrphan = computed(() => !!props.modelValue && !groups.value.some((g) => g.name === props.modelValue));

const newName = ref('');
const creating = ref(false);
const createError = ref('');

async function commitNew() {
  const name = newName.value.trim();
  if (!name || creating.value) return;
  createError.value = '';
  creating.value = true;
  try {
    await createGroup(props.playlistId, name);
    emit('update:modelValue', name);
    newName.value = '';
  } catch (e) {
    // A duplicate is not really an error here — just select the existing group.
    if ((e as Error).message === 'group_exists') {
      emit('update:modelValue', name);
      newName.value = '';
    } else {
      createError.value = 'Could not create group';
    }
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div>
    <div class="select">
      <select v-model="selectVal">
        <option value="">{{ allowUnchanged ? (unchangedLabel || 'Leave unchanged') : 'No group' }}</option>
        <option v-if="showOrphan" :value="modelValue">{{ modelValue }}</option>
        <option v-for="g in groups" :key="g.name" :value="g.name">
          {{ g.name }}<template v-if="g.channels != null"> ({{ g.channels }})</template>
        </option>
      </select>
    </div>
    <div v-if="allowCreate" class="input" style="margin-top: 8px;">
      <button type="button" class="gp-add" :disabled="!newName.trim() || creating"
              title="Create group" @click="commitNew">
        <Icon name="plus" :size="14" />
      </button>
      <input v-model="newName" placeholder="…or type a new group name" @keydown.enter.prevent="commitNew" />
    </div>
    <div v-if="createError" class="muted" style="font-size: var(--fs-xs); margin-top: 4px; color: var(--bad);">
      {{ createError }}
    </div>
  </div>
</template>

<style scoped>
.gp-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--text-2);
  cursor: pointer;
  padding: 0;
}
.gp-add:disabled {
  opacity: 0.4;
  cursor: default;
}
.gp-add:not(:disabled):hover {
  color: var(--accent-hi);
}
</style>
