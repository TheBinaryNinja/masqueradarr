<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
// `value` stays the controlled source of truth (parent owns the filter ref). `debounce` is opt-in
// (ms, default 0 = off → emit on every keystroke, the instant-filter contract every existing consumer
// relies on). When > 0 the displayed text is held in a local model so typing stays responsive while the
// `change` emit is deferred — the EPG screens use this; the other five pass no debounce and are unchanged.
const props = defineProps<{ value: string; placeholder?: string; width?: number; debounce?: number }>();
const emit = defineEmits<{ (e: 'change', v: string): void }>();

const local = ref(props.value);
// Keep the visible text in sync when the parent resets/changes `value` externally (e.g. props.id change
// reset on the EPG detail screen). Guard against clobbering mid-type: only adopt when it actually differs.
watch(() => props.value, (v) => { if (v !== local.value) local.value = v; });

let timer: ReturnType<typeof setTimeout> | null = null;
function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }
onBeforeUnmount(clearTimer);

function onInput(e: Event) {
  const v = (e.target as HTMLInputElement).value;
  local.value = v;
  const ms = props.debounce || 0;
  clearTimer();
  if (ms > 0) {
    timer = setTimeout(() => { timer = null; emit('change', v); }, ms);
  } else {
    emit('change', v);
  }
}

function clear() {
  clearTimer();
  local.value = '';
  emit('change', '');
}
</script>
<template>
  <div class="input search-input" :style="{ width: (props.width || 260) + 'px' }">
    <Icon name="search" :size="14" />
    <input :value="local" :placeholder="placeholder || 'Search'" @input="onInput" />
    <button v-if="local" type="button" class="search-clear" title="Clear" @click="clear">
      <Icon name="x" :size="13" />
    </button>
  </div>
</template>
