<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
const props = defineProps<{ value: string; placeholder?: string; width?: number | string; debounce?: number }>();
const emit = defineEmits<{ (e: 'change', v: string): void }>();

const local = ref(props.value);
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
  <div class="input search-input" :style="{ width: props.width == null ? '260px' : typeof props.width === 'number' ? props.width + 'px' : props.width }">
    <Icon name="search" :size="14" />
    <input :value="local" :placeholder="placeholder || 'Search'" @input="onInput" />
    <button v-if="local" type="button" class="search-clear" title="Clear" @click="clear">
      <Icon name="x" :size="13" />
    </button>
  </div>
</template>
