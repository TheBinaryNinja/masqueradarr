<script setup lang="ts">
// Global custom-tag manager (Settings → Custom Tags). Create / rename / delete over the shared TAGS registry
// (server: Tag collection + /api/tags). Modeled on GroupManager.vue but app-wide: no playlistId, no bus events
// — the TAGS store is reactive, so a rename/delete reflects on every row automatically (tagNames() resolves
// ids → names). A per-tag usage count is derived from the three taggable stores; the delete confirm surfaces
// how many records will lose the tag.
import { ref, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import { TAGS, PLAYLISTS, EPG_SOURCES, CHANNELS, reloadTags, createTag, renameTag, deleteTag, type Tag } from '../data';

// Fresh-load on open (cheap; TAGS is also bootstrapped) so concurrent edits from another admin are reflected.
onMounted(() => reloadTags().catch(() => {}));

// Usage count per tag id across every taggable record — one pass, memoized on the stores.
const usage = computed(() => {
  const m = new Map<string, number>();
  const bump = (ids?: string[]) => ids?.forEach((id) => m.set(id, (m.get(id) ?? 0) + 1));
  PLAYLISTS.value.forEach((p) => bump(p.tags));
  EPG_SOURCES.value.forEach((e) => bump(e.tags));
  CHANNELS.value.forEach((c) => bump(c.tags));
  return m;
});

const sorted = computed(() =>
  [...TAGS.value].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name)),
);

const opError = ref('');

// ── Rename (inline, 3-state row) ──
const renaming = ref<string | null>(null);
const renameVal = ref('');
function startRename(t: Tag) {
  renaming.value = t.id;
  renameVal.value = t.name;
  opError.value = '';
}
async function commitRename() {
  const id = renaming.value;
  const name = renameVal.value.trim();
  renaming.value = null;
  if (!id || !name) return;
  try {
    await renameTag(id, name);
  } catch (e) {
    opError.value =
      (e as Error).message === 'tag_exists' ? 'A tag with that name already exists.' : `Rename failed: ${(e as Error).message}`;
  }
}

// ── Delete (inline confirm) — cascades a $pull across all records ──
const confirmDelete = ref<string | null>(null);
async function doDelete(id: string) {
  confirmDelete.value = null;
  try {
    await deleteTag(id);
  } catch (e) {
    opError.value = `Delete failed: ${(e as Error).message}`;
  }
}

// ── Add ──
const newName = ref('');
const creating = ref(false);
async function addTag() {
  const name = newName.value.trim();
  if (!name || creating.value) return;
  creating.value = true;
  opError.value = '';
  try {
    await createTag(name);
    newName.value = '';
  } catch (e) {
    opError.value =
      (e as Error).message === 'tag_exists' ? 'A tag with that name already exists.' : 'Could not create tag';
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="form-row">
    <div class="muted" style="font-size: var(--fs-xs); margin-bottom: 8px;">
      Custom tags are shared across the whole app — assign them to playlists, EPG sources, and channels.
      Renaming updates every tagged record; deleting removes the tag from all of them.
    </div>

    <div v-if="sorted.length" class="grp-list">
      <div v-for="t in sorted" :key="t.id" class="grp-row">
        <template v-if="renaming === t.id">
          <div class="input" style="flex: 1;">
            <input v-model="renameVal" @keydown.enter.prevent="commitRename" @keydown.esc="renaming = null" />
          </div>
          <Btn variant="ghost" size="sm" icon="check" title="Save" @click="commitRename" />
          <Btn variant="ghost" size="sm" icon="x" title="Cancel" @click="renaming = null" />
        </template>
        <template v-else-if="confirmDelete === t.id">
          <span style="flex: 1; font-size: var(--fs-sm);">
            Delete <b>{{ t.name }}</b>? Removes it from {{ usage.get(t.id) ?? 0 }} record(s).
          </span>
          <Btn variant="ghost" size="sm" @click="confirmDelete = null">Cancel</Btn>
          <button class="btn ghost danger" @click="doDelete(t.id)">
            <Icon name="trash" :size="14" />Delete
          </button>
        </template>
        <template v-else>
          <Pill tone="magenta">{{ t.name }}</Pill>
          <span style="flex: 1;" />
          <span class="muted" style="font-size: var(--fs-xs);" :title="`${usage.get(t.id) ?? 0} record(s)`">
            {{ usage.get(t.id) ?? 0 }}
          </span>
          <Btn variant="ghost" size="sm" icon="edit" title="Rename" @click="startRename(t)" />
          <Btn variant="ghost" size="sm" icon="trash" title="Delete tag" @click="confirmDelete = t.id" />
        </template>
      </div>
    </div>
    <div v-else class="muted" style="font-size: var(--fs-xs);">No tags yet.</div>

    <div class="input" style="margin-top: 8px;">
      <Icon name="plus" :size="14" />
      <input v-model="newName" placeholder="Create a tag…" @keydown.enter.prevent="addTag" />
      <Btn v-if="newName.trim()" variant="ghost" size="sm" :disabled="creating" @click="addTag">Add</Btn>
    </div>

    <div v-if="opError" class="muted" style="font-size: var(--fs-xs); color: var(--bad); margin-top: 6px;">{{ opError }}</div>
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
