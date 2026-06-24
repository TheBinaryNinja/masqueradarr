<script setup lang="ts">
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import Segmented from './Segmented.vue';
import { type Channel } from '../data';

const props = defineProps<{
  channels: Channel[]; // the SELECTED channels being bulk-edited
  groups: string[]; // every group present across the whole playlist (the delete/assign source of truth)
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  // status/group/clearEpg apply to the SELECTED channels; clearEpg unlinks the 2-factor EPG link.
  (e: 'apply', payload: { status?: string; group?: string; clearEpg?: boolean }): void;
  // Delete a group across the WHOLE playlist (clears the group on every channel that has it). Handled by
  // the parent because it spans channels beyond the current selection.
  (e: 'deleteGroup', group: string): void;
}>();

const statusVal = ref<string>('');
const groupVal = ref<string>('');
// New-group entry: a free-text name. When non-empty it takes precedence over the existing-group dropdown.
const newGroup = ref<string>('');
// Clear-EPG toggle: unlink the selected channels' EPG match (tvg_id/epg → null, epgState → unmatched).
const clearEpg = ref(false);
// Delete-group confirmation state.
const confirmGroup = ref<string>('');

const statusMixed = computed(() => new Set(props.channels.map((c) => c.status)).size > 1);
const groupMixed = computed(() => new Set(props.channels.map((c) => c.group)).size > 1);
const commonStatus = computed(() => (statusMixed.value ? '' : (props.channels[0]?.status ?? '')));
const commonGroup = computed(() => (groupMixed.value ? '' : (props.channels[0]?.group ?? '')));

// How many selected channels currently carry an EPG link (the clear-EPG target count).
const linkedCount = computed(() => props.channels.filter((c) => c.epg != null || c.tvg_id != null).length);

// The effective group to assign: a typed new group wins over the dropdown selection.
const effectiveGroup = computed(() => newGroup.value.trim() || groupVal.value);

function setStatus(v: string) {
  statusVal.value = v;
}

function apply() {
  const payload: { status?: string; group?: string; clearEpg?: boolean } = {};
  if (statusVal.value && statusVal.value !== commonStatus.value) payload.status = statusVal.value;
  const g = effectiveGroup.value;
  if (g && g !== commonGroup.value) payload.group = g;
  if (clearEpg.value) payload.clearEpg = true;
  emit('apply', payload);
  emit('close');
}

function deleteGroup() {
  if (!confirmGroup.value) return;
  emit('deleteGroup', confirmGroup.value);
  confirmGroup.value = '';
  emit('close');
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

        <div class="form-row">
          <div class="field-lbl">
            Group
            <span v-if="groupMixed" class="muted" style="font-size: var(--fs-xs); margin-left: 6px;">· mixed — leave unchanged</span>
          </div>
          <div class="select">
            <select v-model="groupVal" :disabled="!!newGroup.trim()">
              <option value="">{{ groupMixed ? 'Leave unchanged (mixed)' : `Leave unchanged (${commonGroup})` }}</option>
              <option v-for="g in groups" :key="g" :value="g">{{ g }}</option>
            </select>
          </div>
          <!-- Add a brand-new group: typing here assigns the selected channels to a group that need not
               already exist. A non-empty value takes precedence over the dropdown above. -->
          <div class="input" style="margin-top: 8px;">
            <Icon name="plus" :size="14" />
            <input v-model="newGroup" placeholder="…or type a new group name" />
          </div>
          <div v-if="newGroup.trim()" class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            Selected channels will be moved to the new group
            <b style="color: var(--accent-hi);">{{ newGroup.trim() }}</b>.
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

        <!-- Delete a group across the WHOLE playlist (not just the selection). Two-step: pick a group, then
             confirm in the caution panel below. -->
        <div class="form-row">
          <div class="field-lbl" style="color: var(--bad);">Delete a group</div>
          <div class="muted" style="font-size: var(--fs-xs); margin-bottom: 8px;">
            Removes the group from <b>every</b> channel in this playlist (the channels are kept, only their
            group is cleared). This cannot be undone.
          </div>
          <div class="select">
            <select v-model="confirmGroup">
              <option value="">Choose a group to delete…</option>
              <option v-for="g in groups" :key="g" :value="g">{{ g }}</option>
            </select>
          </div>
        </div>

        <div v-if="confirmGroup" style="border: 1px solid var(--bad); border-radius: 10px; padding: 12px 14px; background: var(--accent-soft); margin-top: 8px;">
          <div class="row" style="gap: 8px; margin-bottom: 8px;">
            <span style="color: var(--bad);"><Icon name="warn" :size="15" /></span>
            <span style="font-weight: 600; font-size: var(--fs-sm);">Delete group "{{ confirmGroup }}"?</span>
          </div>
          <div class="muted" style="font-size: var(--fs-xs); line-height: 1.5;">
            This clears the group on every channel currently in <b>{{ confirmGroup }}</b> across the whole
            playlist. The channels remain; only their group assignment is removed.
          </div>
          <div class="row" style="gap: 8px; margin-top: 10px;">
            <span class="spacer" />
            <Btn variant="ghost" size="sm" @click="confirmGroup = ''">Cancel</Btn>
            <button class="btn ghost danger" @click="deleteGroup">
              <Icon name="trash" :size="14" />Delete group
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
