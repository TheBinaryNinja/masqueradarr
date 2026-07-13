<script setup lang="ts">
// Impact-aware delete confirm for an EPG source, shared by the EPG Sources list + detail waffle menus (the
// "Delete" item). Owns the cascade DELETE /api/epg-sources/:id, the store re-pull, and the outcome toast;
// emits `deleted` so the detail screen can navigate back to the list (the list just lets the reloaded store
// drop the row). Extracted from the old inline confirm on EPGDetailScreen so both screens share one dialog.
import { ref } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import { type EpgSource, reloadEpgSources } from '../data';
import { useToast } from '../composables/useToast';

const props = defineProps<{ source: EpgSource }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'deleted'): void }>();

const toast = useToast();
const deleting = ref(false);

async function del(): Promise<void> {
  if (deleting.value) return;
  deleting.value = true;
  const name = props.source.name;
  try {
    const res = await fetch(`/api/epg-sources/${encodeURIComponent(props.source.id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('delete failed');
    await reloadEpgSources();
    toast.lowerRight({ tone: 'good', title: 'EPG source deleted', text: `"${name}" and its guide data were removed.` });
    emit('deleted');
    emit('close');
  } catch {
    toast.lowerRight({ tone: 'bad', title: 'Delete failed', text: `Could not delete "${name}". Please try again.` });
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="modal-bg" @click="deleting || emit('close')">
    <div class="modal" @click.stop style="width: 480px; max-width: 92vw;">
      <div class="modal-hd">
        <span style="color: var(--bad);"><Icon name="trash" :size="18" /></span>
        <h2>Delete EPG source?</h2>
        <span class="spacer" />
        <Btn variant="ghost" size="sm" icon="x" :disabled="deleting" @click="emit('close')" />
      </div>
      <div class="modal-body">
        <div style="font-size: var(--fs-base); color: var(--text-1); line-height: 1.5;">
          This permanently removes <strong>{{ source.name }}</strong> and all of its guide data.
          This cannot be undone.
        </div>
        <div style="display: grid; gap: 8px;">
          <div v-for="it in [
            { icon: 'tv', text: 'Channel mappings to this guide are unlinked' },
            { icon: 'epg', text: `${source.programs.toLocaleString()} programs are removed` },
            { icon: 'list', text: `${source.channels} guide channels are removed` },
            { icon: 'trash', text: 'The EPG source and its sync schedule are deleted' },
          ]" :key="it.text" class="row"
               style="gap: 8px; padding: 4px 0; font-size: var(--fs-sm); color: var(--text-1);">
            <span style="color: var(--text-2);"><Icon :name="it.icon" :size="13" /></span>
            <span>{{ it.text }}</span>
          </div>
        </div>
      </div>
      <div class="modal-ft">
        <span class="spacer" />
        <Btn variant="ghost" :disabled="deleting" @click="emit('close')">Cancel</Btn>
        <button class="btn ghost danger" :disabled="deleting" @click="del">
          <Icon name="trash" :size="14" />{{ deleting ? 'Deleting…' : 'Delete source' }}
        </button>
      </div>
    </div>
  </div>
</template>
