<script setup lang="ts">
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import { TAGS, createTag } from '../data';

const props = defineProps<{ modelValue?: string[]; partial?: string[] }>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: string[]): void;
  (e: 'toggle', id: string): void;
  (e: 'create', id: string): void;
}>();

const triState = computed(() => props.partial !== undefined);
const selected = computed(() => new Set(props.modelValue ?? []));
const partialSet = computed(() => new Set(props.partial ?? []));
function isPartial(id: string) {
  return !selected.value.has(id) && partialSet.value.has(id);
}

function onChip(id: string) {
  if (triState.value) {
    emit('toggle', id);
    return;
  }
  const cur = props.modelValue ?? [];
  emit('update:modelValue', cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
}

const newName = ref('');
const creating = ref(false);
const err = ref('');
async function addNew() {
  const name = newName.value.trim();
  if (!name || creating.value) return;
  creating.value = true;
  err.value = '';
  try {
    const existing = TAGS.value.find((t) => t.name.toLowerCase() === name.toLowerCase());
    const tag = existing ?? (await createTag(name));
    newName.value = '';
    if (triState.value) {
      emit('create', tag.id);
    } else if (!(props.modelValue ?? []).includes(tag.id)) {
      emit('update:modelValue', [...(props.modelValue ?? []), tag.id]);
    }
  } catch (e) {
    err.value = (e as Error).message === 'tag_exists' ? '' : 'Could not create tag';
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="tag-picker">
    <div v-if="TAGS.length" class="tag-chip-row">
      <button
        v-for="t in TAGS"
        :key="t.id"
        type="button"
        class="tag-chip"
        :class="{ on: selected.has(t.id), partial: isPartial(t.id) }"
        @click="onChip(t.id)"
      >
        <Icon v-if="selected.has(t.id)" name="check" :size="11" /><span v-else-if="isPartial(t.id)" class="tag-dash" aria-hidden="true" />{{ t.name }}
      </button>
    </div>
    <div v-else class="muted" style="font-size: var(--fs-xs);">No tags yet — create one below.</div>

    <div class="input" style="margin-top: 8px;">
      <Icon name="plus" :size="14" />
      <input v-model="newName" placeholder="Create a tag…" @keydown.enter.prevent="addNew" />
      <Btn v-if="newName.trim()" variant="ghost" size="sm" :disabled="creating" @click="addNew">Add</Btn>
    </div>

    <div v-if="err" class="muted" style="font-size: var(--fs-xs); color: var(--bad); margin-top: 6px;">{{ err }}</div>
  </div>
</template>

<style scoped>
.tag-chip-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-xs);
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--bg-1);
  border: 1px solid var(--hairline);
  color: var(--text-2);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s, color 0.12s;
}
.tag-chip:hover {
  border-color: oklch(0.72 0.18 340 / 0.6);
}
.tag-chip.on {
  background: oklch(0.72 0.18 340 / 0.14);
  border-color: oklch(0.72 0.18 340 / 0.5);
  color: oklch(0.8 0.16 340);
}
.tag-chip.partial {
  background: oklch(0.72 0.18 340 / 0.05);
  border-color: oklch(0.72 0.18 340 / 0.4);
  border-style: dashed;
  color: oklch(0.72 0.12 340);
}
.tag-chip.partial:hover {
  border-color: oklch(0.72 0.18 340 / 0.7);
}
.tag-dash {
  width: 9px;
  height: 2px;
  border-radius: 1px;
  background: currentColor;
  opacity: 0.85;
}
</style>
