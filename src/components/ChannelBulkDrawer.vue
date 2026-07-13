<script setup lang="ts">
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import Segmented from './Segmented.vue';
import GroupPicker from './GroupPicker.vue';
import GroupManager from './GroupManager.vue';
import { type Channel } from '../data';

const props = defineProps<{
  channels: Channel[]; // the SELECTED channels being bulk-edited
  playlistId: string; // owning playlist id — the group-registry key
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  // status/group/clearEpg apply to the SELECTED channels; clearEpg unlinks the 2-factor EPG link.
  // playerPref sets the DaddyLive player override (null = clear → inherit the source default).
  // chnoSeed/chnoStep renumber the selection: channelNo = seed, seed+step, seed+2·step, … assigned
  // in the parent's current display order (the parent owns the ordering).
  (e: 'apply', payload: { status?: string; group?: string; clearEpg?: boolean; playerPref?: number | null; chnoSeed?: number; chnoStep?: number }): void;
  // Hard-delete the selected channels (tombstoned server-side; the parent patches its local list).
  (e: 'deleteChannels', ids: string[]): void;
}>();

const statusVal = ref<string>('');
// The group to assign to the SELECTION ('' = leave unchanged). A first-class group, chosen/created via the
// shared GroupPicker (same registry the single-channel editor uses).
const groupVal = ref<string>('');
const clearEpg = ref(false);
// DaddyLive-family (dlhd) player override for the selection. '' = leave unchanged; 0 = Auto (clear the
// override → inherit the source default); 1..6 = a specific player. Shown only when the selection has any.
const supportsPlayer = computed(() => props.channels.some((c) => ['dlhd'].includes(c.origin ?? c.source)));
const playerVal = ref<number | ''>('');

// Channel-number seed + increment. '' seed = leave unchanged; a valid non-negative integer renumbers
// the selection starting at the seed, stepping by chnoStep (default 1), in the parent's display order.
const chnoSeed = ref<string>('');
const chnoStep = ref<number>(1);
// The parsed seed when it is a usable non-negative integer, else null (blank/garbage = leave unchanged).
const chnoSeedNum = computed(() => {
  const n = parseInt(chnoSeed.value, 10);
  return String(n) === chnoSeed.value.trim() && Number.isFinite(n) && n >= 0 ? n : null;
});
// Human preview of the first few assigned numbers (uses the same seed/step math as apply()).
const chnoPreview = computed(() => {
  if (chnoSeedNum.value == null) return '';
  const step = Number(chnoStep.value) || 1;
  const nums = props.channels.slice(0, 3).map((_, i) => chnoSeedNum.value! + i * step);
  return nums.join(', ') + (props.channels.length > 3 ? ' …' : '');
});

const statusMixed = computed(() => new Set(props.channels.map((c) => c.status)).size > 1);
const groupMixed = computed(() => new Set(props.channels.map((c) => c.group)).size > 1);
const commonStatus = computed(() => (statusMixed.value ? '' : (props.channels[0]?.status ?? '')));
const commonGroup = computed(() => (groupMixed.value ? '' : (props.channels[0]?.group ?? '')));

// How many selected channels currently carry an EPG link (the clear-EPG target count).
const linkedCount = computed(() => props.channels.filter((c) => c.epg != null || c.tvg_id != null).length);

const unchangedLabel = computed(() =>
  groupMixed.value
    ? 'Leave unchanged (mixed)'
    : `Leave unchanged${commonGroup.value ? ` (${commonGroup.value})` : ''}`,
);

function setStatus(v: string) {
  statusVal.value = v;
}

function apply() {
  const payload: { status?: string; group?: string; clearEpg?: boolean; playerPref?: number | null; chnoSeed?: number; chnoStep?: number } = {};
  if (statusVal.value && statusVal.value !== commonStatus.value) payload.status = statusVal.value;
  if (groupVal.value && groupVal.value !== commonGroup.value) payload.group = groupVal.value;
  if (clearEpg.value) payload.clearEpg = true;
  // 0 = Auto → clear the override (null); a specific 1..6 is sent verbatim. '' leaves it untouched.
  if (playerVal.value !== '') payload.playerPref = playerVal.value === 0 ? null : playerVal.value;
  // Renumber only when the seed parses to a non-negative integer; otherwise leave channel # untouched.
  if (chnoSeedNum.value != null) {
    payload.chnoSeed = chnoSeedNum.value;
    payload.chnoStep = Number(chnoStep.value) || 1;
  }
  emit('apply', payload);
  emit('close');
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
        <div style="border: 1px solid var(--hairline); border-radius: 10px; padding: 10px 12px; background: var(--bg-2); flex: none;">
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

        <!-- DaddyLive-family only: bulk-set the preferred upstream player for the selected channels. -->
        <div v-if="supportsPlayer" class="form-row">
          <div class="field-lbl">Player source</div>
          <div class="select fill">
            <select v-model.number="playerVal">
              <option value="">Leave unchanged</option>
              <option :value="0">Auto (inherit source default)</option>
              <option :value="1">Player 1</option>
              <option :value="2">Player 2</option>
              <option :value="3">Player 3</option>
              <option :value="4">Player 4</option>
              <option :value="5">Player 5</option>
              <option :value="6">Player 6</option>
            </select>
          </div>
          <div v-if="playerVal !== ''" class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            The selected DaddyLive channels will prefer
            <b style="color: var(--accent-hi);">{{ playerVal === 0 ? 'Auto (source default)' : `Player ${playerVal}` }}</b>.
          </div>
        </div>

        <!-- Renumber the selection: seed the first number and auto-increment by "Increment by" across the
             selection in the current table order (the parent owns the ordering). Blank seed = leave unchanged. -->
        <div class="form-row">
          <div class="field-lbl">Channel number</div>
          <div class="row" style="gap: 10px; align-items: flex-end;">
            <div style="flex: 1;">
              <div class="muted" style="font-size: var(--fs-xs); margin-bottom: 4px;">Start number (seed)</div>
              <div class="input">
                <input v-model="chnoSeed" inputmode="numeric" placeholder="Start #, e.g. 100" />
              </div>
            </div>
            <div style="width: 110px;">
              <div class="muted" style="font-size: var(--fs-xs); margin-bottom: 4px;">Increment by</div>
              <div class="input">
                <input v-model.number="chnoStep" type="number" min="1" placeholder="1" />
              </div>
            </div>
          </div>
          <div v-if="chnoSeedNum != null" class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            Assigns <b style="color: var(--accent-hi);">{{ chnoPreview }}</b>
            across the {{ channels.length }} selected channel{{ channels.length === 1 ? '' : 's' }} in the current sort order.
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

        <!-- Manage the playlist's groups (immediate, whole-playlist) — shared with the single-channel editor. -->
        <GroupManager :playlist-id="playlistId" />

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
