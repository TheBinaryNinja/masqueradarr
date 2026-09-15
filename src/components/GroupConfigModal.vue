<script setup lang="ts">
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import ChannelLogo from './ChannelLogo.vue';
import { saveFailoverGroup, disbandFailoverGroup, type Channel, type FailoverGroupResult } from '../data';

const props = defineProps<{
  source: string;
  channels: Channel[];
  allChannels: Channel[];
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved', result: FailoverGroupResult): void;
  (e: 'disbanded', groupId: string): void;
}>();

const groupId: string | null = props.channels.find((c) => c.failoverGroupId)?.failoverGroupId ?? null;
const members: Channel[] = (() => {
  const byId = new Map(props.channels.map((c) => [c.id, c]));
  if (groupId) {
    for (const c of props.allChannels) {
      if (c.failoverGroupId === groupId && !byId.has(c.id)) byId.set(c.id, c);
    }
  }
  return [...byId.values()];
})();

function isForeign(c: Channel): boolean {
  return !!c.failoverGroupId && c.failoverGroupId !== groupId;
}
const foreignParent = computed(
  () => members.find((c) => isForeign(c) && c.failoverRole === 'parent') ?? null,
);

const initialParent =
  members.find((c) => c.failoverGroupId === groupId && c.failoverRole === 'parent') ?? members[0];
const parentId = ref(initialParent?.id ?? '');
const parent = computed(() => members.find((c) => c.id === parentId.value) ?? null);

const children = ref<Channel[]>(
  (() => {
    const rest = members.filter((c) => c.id !== parentId.value);
    const inGroup = rest
      .filter((c) => c.failoverGroupId === groupId && c.failoverRole === 'child')
      .sort((a, b) => (a.failoverOrder ?? 0) - (b.failoverOrder ?? 0));
    const others = rest.filter((c) => !inGroup.includes(c));
    return [...inGroup, ...others];
  })(),
);

function setParent(c: Channel) {
  const oldParent = parent.value;
  const idx = children.value.findIndex((x) => x.id === c.id);
  const next = children.value.filter((x) => x.id !== c.id);
  if (oldParent) next.splice(idx, 0, oldParent);
  parentId.value = c.id;
  children.value = next;
}

const dragIndex = ref<number | null>(null);
const overIndex = ref<number | null>(null);

function onDragStart(i: number, e: DragEvent) {
  dragIndex.value = i;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i));
  }
}
function onDragOver(i: number, e: DragEvent) {
  if (dragIndex.value === null) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  if (i !== overIndex.value) overIndex.value = i;
}
function onDrop(i: number) {
  const from = dragIndex.value;
  reset();
  if (from === null || from === i) return;
  const next = [...children.value];
  const [moved] = next.splice(from, 1);
  next.splice(i, 0, moved);
  children.value = next;
}
function reset() {
  dragIndex.value = null;
  overIndex.value = null;
}

const saving = ref(false);
const error = ref('');
const canSave = computed(
  () => !!parent.value && children.value.length >= 1 && !foreignParent.value && !saving.value,
);

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  error.value = '';
  try {
    const result = await saveFailoverGroup(props.source, {
      groupId: groupId ?? undefined,
      parentId: parentId.value,
      childIds: children.value.map((c) => c.id),
    });
    emit('saved', result);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}

async function disband() {
  if (!groupId || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    await disbandFailoverGroup(props.source, groupId);
    emit('disbanded', groupId);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="modal-bg" @click="emit('close')">
    <div class="modal" @click.stop style="width: 560px; max-width: 92vw;">
      <div class="modal-hd">
        <Icon name="link" :size="18" />
        <h2>{{ groupId ? 'Edit failover group' : 'New failover group' }}</h2>
        <span class="spacer" />
        <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
      </div>
      <div class="modal-body">
        <div class="row" style="gap: 8px; padding: 8px 10px; background: var(--accent-soft); border-radius: 8px; align-items: flex-start;">
          <Icon name="link" :size="13" style="color: var(--accent-hi); margin-top: 2px;" />
          <span style="font-size: var(--fs-sm); color: var(--text-1);">
            The <b>parent</b> is exported and served; <b>children</b> are hidden from playlist exports,
            inherit the parent's EPG link, and are tried in order when the parent's stream fails.
          </span>
        </div>

        <div v-if="foreignParent" class="row" style="gap: 8px; padding: 8px 10px; border: 1px solid var(--warn); border-radius: 8px; font-size: var(--fs-sm); color: var(--warn);">
          <Icon name="warn" :size="14" />
          <span>"{{ foreignParent.tvg_name }}" already heads another failover group — disband that group first.</span>
        </div>
        <div v-else-if="parent && parent.status === 'Disabled'" class="row" style="gap: 8px; padding: 8px 10px; border: 1px solid var(--warn); border-radius: 8px; font-size: var(--fs-sm); color: var(--warn);">
          <Icon name="warn" :size="14" />
          <span>The parent is <b>Disabled</b> — the whole group stays out of exports until it's re-enabled.</span>
        </div>

        <div class="form-row">
          <div class="field-lbl">Parent</div>
          <div v-if="parent" class="grp-row" style="padding-left: 10px;">
            <ChannelLogo :ch="parent" />
            <div class="nm">{{ parent.tvg_name }}</div>
            <Pill v-if="parent.status === 'Disabled'" tone="disabled">Disabled</Pill>
            <Pill tone="parent">parent</Pill>
          </div>
        </div>

        <div class="form-row">
          <div class="field-lbl">Children · failover order (drag to reorder)</div>
          <div>
            <div
              v-for="(c, i) in children"
              :key="c.id"
              class="grp-row"
              :class="{ 'drag-source': dragIndex === i, 'drag-over': overIndex === i && dragIndex !== i }"
              draggable="true"
              @dragstart="onDragStart(i, $event)"
              @dragover="onDragOver(i, $event)"
              @drop="onDrop(i)"
              @dragend="reset"
            >
              <span class="drag-grip" title="Drag to reorder"><Icon name="grip" :size="16" /></span>
              <span class="mono muted grp-ord">{{ i + 1 }}</span>
              <ChannelLogo :ch="c" />
              <div class="nm">{{ c.tvg_name }}</div>
              <Pill v-if="isForeign(c)" tone="warn">will be moved</Pill>
              <Pill v-if="c.status === 'Disabled'" tone="disabled" title="Disabled children are skipped at failover">Disabled</Pill>
              <Pill tone="child">child</Pill>
              <Btn variant="ghost" size="sm" title="Make this channel the group's parent" @click="setParent(c)">Set parent</Btn>
            </div>
            <div v-if="!children.length" class="muted" style="font-size: var(--fs-sm); padding: 6px 2px;">
              Select at least two channels — one parent plus one or more backups.
            </div>
          </div>
        </div>

        <div v-if="error" style="color: var(--bad); font-size: var(--fs-sm);">{{ error }}</div>
      </div>
      <div class="modal-ft">
        <button v-if="groupId" class="btn ghost danger" :disabled="saving" @click="disband">
          <Icon name="trash" :size="14" />Disband group
        </button>
        <span class="spacer" />
        <Btn variant="ghost" :disabled="saving" @click="emit('close')">Cancel</Btn>
        <Btn variant="primary" icon="check" :disabled="!canSave" @click="save">
          {{ saving ? 'Saving…' : 'Save group' }}
        </Btn>
      </div>
    </div>
  </div>
</template>
