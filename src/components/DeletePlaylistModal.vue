<script setup lang="ts">
import { ref, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import { reloadPlaylists, reloadCustomPlaylists, reloadChannels, reloadEpgSources, type Playlist } from '../data';
import { useToast } from '../composables/useToast';

// Delete-confirm for a playlist — user-composed (clone/file/url/hdhomerun/local/legacy import) AND built-in
// (Default) source playlists are deletable. The backend cascades: a custom playlist drops its channels +
// per-user m3u files + access-list refs; a built-in additionally prunes its copies out of every clone (by
// `origin`) and removes its playlist-bound EPG source. For a built-in we first fetch a real affected-areas
// report (GET /:id/delete-impact) and show it so the operator sees exactly what is removed before confirming.
// Extracted from the detail screen so the Playlists LIST and DETAIL carry the SAME impact-aware confirm.
interface DeleteImpact {
  playlist: { id: string; name: string; channels: number };
  affectedClones: { id: string; name: string; channelsRemoved: number }[];
  boundEpgSource: { id: string; name: string } | null;
}

const props = defineProps<{ playlist: Playlist }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'deleted', id: string): void }>();
const { banner } = useToast();

const deleting = ref(false);
const impact = ref<DeleteImpact | null>(null);
const impactLoading = ref(false);
const impactError = ref(false);

// The modal only mounts when a delete is opened, so fetch the built-in impact report here (a brief spinner
// while it loads); a clone/custom uses the generic checklist (no fetch). A failed/non-ok preview flags
// impactError (+ a toast) and the template renders an explicit "preview unavailable" notice — the Delete
// button stays gated so the operator can never confirm the destructive cascade blind.
onMounted(async () => {
  if (!props.playlist.builtin) return;
  impactLoading.value = true;
  try {
    const res = await fetch(`/api/playlists/${encodeURIComponent(props.playlist.id)}/delete-impact`);
    if (res.ok) impact.value = await res.json();
    else impactError.value = true; // a non-ok (400/403/404) never enters catch — flag it here
  } catch {
    impactError.value = true;
  } finally {
    impactLoading.value = false;
    if (impactError.value) banner({ text: 'Could not calculate affected areas', tone: 'bad', icon: 'warn' });
  }
});

async function deletePlaylist() {
  const p = props.playlist;
  if (!p.id || deleting.value) return;
  deleting.value = true;
  const wasBuiltin = !!p.builtin;
  try {
    const res = await fetch(`/api/playlists/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    // A built-in delete prunes clone copies + drops a bound EPG source — refresh the channel union and EPG
    // store too so other screens reflect the cascade without a full reload.
    await Promise.all([
      reloadPlaylists(),
      reloadCustomPlaylists(),
      wasBuiltin ? reloadChannels().catch(() => {}) : Promise.resolve(),
      wasBuiltin ? reloadEpgSources().catch(() => {}) : Promise.resolve(),
    ]);
    banner({ text: `Deleted "${p.name}"`, tone: 'good', icon: 'trash' });
    emit('deleted', p.id);
  } catch (e) {
    banner({ text: `Delete failed: ${(e as Error).message}`, tone: 'bad', icon: 'warn' });
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="modal-bg" @click="deleting || emit('close')">
    <div class="modal" @click.stop style="width: 520px; max-width: 92vw;">
      <div class="modal-hd">
        <span style="color: var(--bad);"><Icon name="trash" :size="18" /></span>
        <h2>Delete playlist?</h2>
        <span class="spacer" />
        <Btn variant="ghost" size="sm" icon="x" :disabled="deleting" @click="emit('close')" />
      </div>
      <div class="modal-body">
        <div style="font-size: var(--fs-base); color: var(--text-1); line-height: 1.5;">
          This permanently removes <strong>{{ playlist.name }}</strong> and everything in it.
          This cannot be undone.
        </div>

        <!-- Built-in: real affected-areas summary from GET /:id/delete-impact. -->
        <template v-if="playlist.builtin">
          <div v-if="impactLoading" class="row" style="gap: 8px; padding: 12px 0; color: var(--text-2); font-size: var(--fs-sm);">
            <Icon name="refresh" :size="13" />
            <span>Calculating affected areas…</span>
          </div>
          <template v-else-if="impact">
            <!-- Playlist Channels -->
            <div class="impact-block">
              <div class="impact-hd"><Icon name="list" :size="13" />Playlist Channels</div>
              <div class="impact-row">
                <span class="impact-name">{{ impact.playlist.name }}</span>
                <span class="spacer" />
                <span class="impact-lbl">Channels Deleted:</span>
                <span class="impact-val bad">everything</span>
              </div>
              <div v-for="c in impact.affectedClones" :key="c.id" class="impact-row">
                <span class="impact-name">{{ c.name }}</span>
                <span class="spacer" />
                <span class="impact-lbl">Channels Deleted:</span>
                <span class="impact-val warn">{{ c.channelsRemoved }}</span>
              </div>
              <div v-if="!impact.affectedClones.length" class="impact-row muted" style="font-size: var(--fs-xs);">
                No cloned playlists include this source's channels.
              </div>
            </div>
            <!-- Playlist EPG -->
            <div class="impact-block">
              <div class="impact-hd"><Icon name="grid" :size="13" />Playlist EPG</div>
              <div class="impact-row">
                <span class="impact-lbl">Playlist-bound:</span>
                <span class="spacer" />
                <span class="impact-val" :class="impact.boundEpgSource ? 'warn' : 'muted'">
                  {{ impact.boundEpgSource ? impact.boundEpgSource.name : 'None' }}
                </span>
              </div>
            </div>
          </template>
          <!-- Preview failed (non-ok / network error): no affected-areas data — say so explicitly and keep
               the Delete button gated (see modal-ft below) so the cascade is never confirmed blind. -->
          <div v-else class="impact-block">
            <div class="impact-row warn" style="gap: 8px;">
              <Icon name="warn" :size="14" />
              <span><b>Affected-areas preview unavailable.</b> Could not calculate what this delete will
                remove. Close this dialog and try again.</span>
            </div>
          </div>
        </template>

        <!-- Clone / custom: the generic checklist (no impact fetch needed). -->
        <div v-else style="display: grid; gap: 8px;">
          <div v-for="it in [
            { icon: 'list', text: `${playlist.channels} channel${playlist.channels === 1 ? '' : 's'} are removed` },
            { icon: 'file', text: 'Its per-user M3U files + guide sibling are deleted' },
            { icon: 'tv', text: 'It is removed from every user\'s allowed playlists' },
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
        <button class="btn ghost danger" :disabled="deleting || impactLoading || (playlist.builtin && !impact)" @click="deletePlaylist">
          <Icon name="trash" :size="14" />{{ deleting ? 'Deleting…' : 'Delete playlist' }}
        </button>
      </div>
    </div>
  </div>
</template>
