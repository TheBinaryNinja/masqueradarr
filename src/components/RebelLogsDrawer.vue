<script setup lang="ts">
import { ref, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Segmented from './Segmented.vue';
import { useToast } from '../composables/useToast';

const props = defineProps<{ fetchLogs: (tail: number) => Promise<string> }>();
const emit = defineEmits<{ (e: 'close'): void }>();
const toast = useToast();

const tail = ref<string>('200');
const text = ref('');
const loading = ref(false);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    text.value = await props.fetchLogs(Number(tail.value));
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

async function copyAll(): Promise<void> {
  try {
    await navigator.clipboard.writeText(text.value);
    toast.lowerRight({ tone: 'good', icon: 'check', title: 'Copied', text: 'Rebel IPTV logs' });
  } catch {
    toast.lowerRight({ tone: 'warn', icon: 'warn', title: 'Copy failed', text: 'Select the text and copy it manually.' });
  }
}

onMounted(load);
</script>

<template>
  <div class="drawer-wrap">
    <div class="glass-bg drawer-backdrop" @click="emit('close')" />
    <div class="glass drawer-panel" style="width: 60vw; max-width: 60vw; min-width: 440px;">
      <div class="drawer-hd">
        <Icon name="file" :size="16" />
        <div style="flex: 1;">
          <div style="font-weight: 600; font-size: 15px;">Rebel IPTV logs</div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px;">Container stdout/stderr (Docker)</div>
        </div>
        <Segmented :value="tail" @change="(v) => { tail = v as string; load(); }" :options="[
          { value: '200', label: '200' },
          { value: '1000', label: '1000' },
          { value: '5000', label: '5000' },
        ]" />
        <Btn variant="ghost" size="sm" icon="refresh" :disabled="loading" @click="load" />
        <Btn variant="ghost" size="sm" icon="copy" :disabled="!text" @click="copyAll" />
        <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
      </div>
      <div class="drawer-body" style="padding: 0; overflow: auto; flex: 1;">
        <div v-if="error" style="padding: 14px 18px; color: var(--bad); font-size: var(--fs-sm);">{{ error }}</div>
        <pre v-else class="mono" style="margin: 0; padding: 14px 18px; font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;">{{ loading && !text ? 'Loading…' : text || '(no output)' }}</pre>
      </div>
    </div>
  </div>
</template>
