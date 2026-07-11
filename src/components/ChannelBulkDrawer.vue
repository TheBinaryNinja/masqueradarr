<script setup lang="ts">
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import Segmented from './Segmented.vue';
import GroupPicker from './GroupPicker.vue';
import { GROUPS_BY_PLAYLIST, createGroup, type Channel, type GroupDef } from '../data';

const props = defineProps<{
  channels: Channel[]; // the SELECTED channels being bulk-edited
  playlistId: string; // owning playlist id — the group-registry key
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  // status/group/clearEpg apply to the SELECTED channels; clearEpg unlinks the 2-factor EPG link.
  (e: 'apply', payload: { status?: string; group?: string; clearEpg?: boolean }): void;
  // Hard-delete the selected channels (tombstoned server-side; the parent patches its local list).
  (e: 'deleteChannels', ids: string[]): void;
  // Whole-playlist group management (immediate) — the parent runs the data-layer op + patches its local list.
  (e: 'renameGroup', payload: { oldName: string; newName: string }): void;
  (e: 'deleteGroup', name: string): void;
}>();

const statusVal = ref<string>('');
// The group to assign to the SELECTION ('' = leave unchanged). A first-class group, chosen/created via the
// shared GroupPicker (same registry the single-channel editor uses).
const groupVal = ref<string>('');
const clearEpg = ref(false);

const statusMixed = computed(() => new Set(props.channels.map((c) => c.status)).size > 1);
const groupMixed = computed(() => new Set(props.channels.map((c) => c.group)).size > 1);
const commonStatus = computed(() => (statusMixed.value ? '' : (props.channels[0]?.status ?? '')));
const commonGroup = computed(() => (groupMixed.value ? '' : (props.channels[0]?.group ?? '')));

// How many selected channels currently carry an EPG link (the clear-EPG target count).
const linkedCount = computed(() => props.channels.filter((c) => c.epg != null || c.tvg_id != null).length);

// The playlist's group registry (shared store) — backs both the assign picker and the Manage panel below.
const registry = computed<GroupDef[]>(() => GROUPS_BY_PLAYLIST.value[props.playlistId] ?? []);

const unchangedLabel = computed(() =>
  groupMixed.value
    ? 'Leave unchanged (mixed)'
    : `Leave unchanged${commonGroup.value ? ` (${commonGroup.value})` : ''}`,
);

function setStatus(v: string) {
  statusVal.value = v;
}

function apply() {
  const payload: { status?: string; group?: string; clearEpg?: boolean } = {};
  if (statusVal.value && statusVal.value !== commonStatus.value) payload.status = statusVal.value;
  if (groupVal.value && groupVal.value !== commonGroup.value) payload.group = groupVal.value;
  if (clearEpg.value) payload.clearEpg = true;
  emit('apply', payload);
  emit('close');
}

// ── Manage groups (whole-playlist, immediate — not tied to the Apply-to-selection flow) ──
const renaming = ref<string | null>(null); // the group name currently being renamed (inline)
const renameVal = ref('');
function startRename(g: GroupDef) {
  renaming.value = g.name;
  renameVal.value = g.name;
}
function commitRename() {
  const oldName = renaming.value;
  const newName = renameVal.value.trim();
  renaming.value = null;
  if (!oldName || !newName || newName === oldName) return;
  emit('renameGroup', { oldName, newName });
}
const confirmDeleteGroup = ref<string | null>(null); // the group name pending a delete confirm
function doDeleteGroup(name: string) {
  confirmDeleteGroup.value = null;
  emit('deleteGroup', name);
}

// Create an EMPTY group (persists with zero channels) — the explicit "add a group" affordance.
const newGroupName = ref('');
const creatingGroup = ref(false);
async function addEmptyGroup() {
  const name = newGroupName.value.trim();
  if (!name || creatingGroup.value) return;
  creatingGroup.value = true;
  try {
    await createGroup(props.playlistId, name);
    newGroupName.value = '';
  } catch {
    // A duplicate / error leaves the registry as-is; the list below reflects the true state.
  } finally {
    creatingGroup.value = false;
  }
}

// ── Delete channels (destructive, two-step confirm) ──
const confirmDeleteChannels = ref(false);
function doDeleteChannels() {
  confirmDeleteChannels.value = false;
  emit('deleteChannels', props.channels.map((c) => c.id));
}
</script>

<template>
  <div class="drawer-wrap">
    <div class="glass-bg drawer-backdrop" @click="emit('close')" />
    <div class="glass drawer-panel">
      <div class="drawer-hd">
        <div class="src-ico" style="width: 44px; height: 44px; border-radius: 10px;">
          <Icon name="edit" :size="20" />
        </div>
        <div style="flex: 1;">
          <div style="font-weight: 600; font-size: 15px;">Edit {{ channels.length }} channels</div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px;">
            Apply changes to all selected channels
          </div>
        </div>
        <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
      </div>

      <div class="drawer-body">
        <div style="border: 1px solid var(--hairline); border-radius: 10px; padding: 10px 12px; background: var(--bg-2); max-height: 168px; overflow: auto;">
          <div class="row" style="gap: 8px; margin-bottom: 8px;">
            <Icon name="check" :size="13" style="color: var(--good);" />
            <span style="font-weight: 600; font-size: var(--fs-sm);">Channels being edited</span>
            <span class="spacer" />
            <Pill tone="cyan">{{ channels.length }}</Pill>
          </div>
          <div v-for="c in channels.slice(0, 8)" :key="c.id" class="row" style="gap: 8px; padding: 3px 0; font-size: var(--fs-sm);">
            <span class="mono muted" style="font-size: var(--fs-xs); min-width: 32px;">#{{ c.channelNo ?? '—' }}</span>
            <span style="font-weight: 500;">{{ c.tvg_name }}</span>
            <span class="muted" style="font-size: var(--fs-xs);">· {{ c.group }}</span>
          </div>
          <div v-if="channels.length > 8" class="muted" style="font-size: var(--fs-xs); padding-top: 6px;">
            + {{ channels.length - 8 }} more
          </div>
        </div>

        <div class="divider" />

        <div class="form-row">
          <div class="field-lbl">
            Status
            <span v-if="statusMixed" class="muted" style="font-size: var(--fs-xs); margin-left: 6px;">· mixed — leave unchanged</span>
          </div>
          <div class="row" style="gap: 10px;">
            <Segmented :value="statusVal || commonStatus" @change="setStatus" :options="[
              { value: 'Active', label: 'Active', icon: 'check' },
              { value: 'Disabled', label: 'Disabled', icon: 'x' },
            ]" />
            <Pill v-if="statusVal" :tone="statusVal === 'Active' ? 'active' : 'disabled'">
              {{ statusVal }}
            </Pill>
            <Pill v-else-if="!statusMixed" :tone="commonStatus === 'Active' ? 'active' : 'disabled'">
              {{ commonStatus }}
            </Pill>
          </div>
        </div>

        <!-- Assign the selection to a group. The picker reads the SAME registry the Manage panel edits and the
             single-channel editor uses, so the taxonomy is one shared, persisted set. -->
        <div class="form-row">
          <div class="field-lbl">
            Group
            <span v-if="groupMixed" class="muted" style="font-size: var(--fs-xs); margin-left: 6px;">· mixed — leave unchanged</span>
          </div>
          <GroupPicker v-model="groupVal" :playlist-id="playlistId" allow-create allow-unchanged :unchanged-label="unchangedLabel" />
          <div v-if="groupVal" class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            The selected channels will be assigned to
            <b style="color: var(--accent-hi);">{{ groupVal }}</b>.
          </div>
        </div>

        <div class="form-row">
          <div class="field-lbl">EPG match</div>
          <label class="row" style="gap: 10px; padding: 8px 10px; border: 1px solid var(--hairline); border-radius: 8px; cursor: pointer;"
                 :style="clearEpg ? 'border-color: var(--warn); background: var(--accent-soft);' : ''">
            <input type="checkbox" v-model="clearEpg" />
            <div style="flex: 1;">
              <div style="font-weight: 500; font-size: var(--fs-sm);">Remove EPG match</div>
              <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px;">
                Clears the EPG link (tvg_id + guide source) on the selected channels.
                <template v-if="linkedCount">
                  <b style="color: var(--warn);">{{ linkedCount }}</b>
                  of {{ channels.length }} currently linked.
                </template>
                <template v-else>None of the selected channels are linked.</template>
              </div>
            </div>
          </label>
        </div>

        <div class="row" style="margin-top: 6px;">
          <span class="spacer" />
          <Btn variant="ghost" @click="emit('close')">Cancel</Btn>
          <Btn variant="primary" icon="check" @click="apply">
            Apply to {{ channels.length }} channels
          </Btn>
        </div>

        <div class="divider" />

        <!-- Manage the playlist's groups (immediate, whole-playlist). Same registry the assign picker above and
             the single-channel editor read — rename/delete/add here reflect everywhere. -->
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
        </div>

        <div class="divider" />

        <!-- Delete the SELECTED channels (destructive, tombstoned so a re-sync won't re-add them). -->
        <div class="form-row">
          <div class="field-lbl" style="color: var(--bad);">Delete channels</div>
          <div v-if="!confirmDeleteChannels" class="row">
            <div class="muted" style="font-size: var(--fs-xs); flex: 1;">
              Permanently removes the {{ channels.length }} selected channel{{ channels.length === 1 ? '' : 's' }}.
              A later source sync will not re-add them.
            </div>
            <button class="btn ghost danger" @click="confirmDeleteChannels = true">
              <Icon name="trash" :size="14" />Delete {{ channels.length }}
            </button>
          </div>
          <div v-else style="border: 1px solid var(--bad); border-radius: 10px; padding: 12px 14px; background: var(--accent-soft);">
            <div class="row" style="gap: 8px; margin-bottom: 8px;">
              <span style="color: var(--bad);"><Icon name="warn" :size="15" /></span>
              <span style="font-weight: 600; font-size: var(--fs-sm);">Delete {{ channels.length }} channel{{ channels.length === 1 ? '' : 's' }}?</span>
            </div>
            <div class="muted" style="font-size: var(--fs-xs); line-height: 1.5;">
              This cannot be undone. The channels are removed and tombstoned so a re-sync will not restore them
              (use Restore Defaults to bring them back).
            </div>
            <div class="row" style="gap: 8px; margin-top: 10px;">
              <span class="spacer" />
              <Btn variant="ghost" size="sm" @click="confirmDeleteChannels = false">Cancel</Btn>
              <button class="btn ghost danger" @click="doDeleteChannels">
                <Icon name="trash" :size="14" />Delete channels
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
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
