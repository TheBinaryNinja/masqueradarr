<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';
import Pill from '../components/Pill.vue';
import StatusDot from '../components/StatusDot.vue';
import SearchInput from '../components/SearchInput.vue';
import PlaylistStatusDrawer from '../components/PlaylistStatusDrawer.vue';
import ProgressBar from '../components/ProgressBar.vue';
import { playlistScheduleLabel, reloadEpgSources, type Playlist, type Channel } from '../data';
import { bus } from '../composables/bus';
import { useToast } from '../composables/useToast';
import { usePlaylistActions } from '../composables/usePlaylistActions';

const emit = defineEmits<{ (e: 'add', k: 'playlist' | 'epg'): void }>();
const router = useRouter();
const { banner } = useToast();
const { syncingGlobal, composingGlobal, globalSyncProgress, globalComposeProgress, syncAllGlobal, composeAllGlobal } = usePlaylistActions();

const playlists = ref<Playlist[]>([]);
async function reloadList(): Promise<void> {
  const res = await fetch('/api/playlists');
  if (res.ok) playlists.value = await res.json();
}
onMounted(() => {
  void reloadList();
  // A sign-in/out on Settings flips a playlist's isAuthenticated — re-read so the badge updates live.
  bus.on('tvapp:auth-changed', reloadList);
});
onBeforeUnmount(() => bus.off('tvapp:auth-changed', reloadList));

// Per-row actions mirror the detail header (Sync / Compose / Edit). In-flight state is tracked per
// playlist id (Sets) so one row's request never disables or spins the others.
const syncingIds = ref(new Set<string>());
const composingIds = ref(new Set<string>());

async function syncRow(p: Playlist): Promise<void> {
  const src = p.source;
  if (!src || syncingIds.value.has(p.id)) return;
  syncingIds.value = new Set(syncingIds.value).add(p.id);
  try {
    const res = await fetch(`/api/sources/${encodeURIComponent(src)}/sync`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    // Reload the local playlist list AND the shared EPG store — a source sync's afterSync hook can
    // create/refresh EPG sources (dlhd/tubi self-EPG), which otherwise stay invisible until a page refresh.
    await Promise.all([reloadList(), reloadEpgSources().catch(() => {})]);
    banner({ text: `Synced ${result.count ?? ''} channels${result.live === false ? ' (snapshot)' : ''}`.trim(), tone: 'good', icon: 'sync' });
  } catch (err) {
    banner({ text: `Sync failed: ${(err as Error).message}`, tone: 'bad', icon: 'warn' });
  } finally {
    const n = new Set(syncingIds.value); n.delete(p.id); syncingIds.value = n;
  }
}

async function composeRow(p: Playlist): Promise<void> {
  if (!p.source || composingIds.value.has(p.id)) return;
  composingIds.value = new Set(composingIds.value).add(p.id);
  try {
    const res = await fetch(`/api/playlists/${encodeURIComponent(p.id)}/compose`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    const n = result.channels ?? 0;
    banner({ text: `Composed ${n} channel${n === 1 ? '' : 's'} → ${result.endpoint}`, tone: 'good', icon: 'file' });
  } catch (err) {
    banner({ text: `Compose failed: ${(err as Error).message}`, tone: 'bad', icon: 'warn' });
  } finally {
    const n = new Set(composingIds.value); n.delete(p.id); composingIds.value = n;
  }
}

// Global cohort: "Sync Global" / "Compose Global" on a Global row fan out across EVERY Global playlist
// (shared singleton state, so all Global buttons disable together and all Global rows show one bar).
// Custom rows keep the per-id behavior above. `isCustom` selects which busy source a row reads.
const isCustom = (p: Playlist): boolean => p.endpoint === 'custom';

// Per-source-type chip icon (label itself comes straight from the stored `source`).
const SOURCE_CHIP_ICON: Record<string, string> = {
  clone: 'copy',
  file: 'file',
  url: 'link',
  hdhomerun: 'tv',
  import: 'import', // legacy pre-file/url-split rows
};

// Leading source-type chip — ALWAYS rendered so every row shows what kind of playlist it is. Labels are
// LOWERCASE (the repo-wide source-type normalization). The label comes STRAIGHT FROM the stored `source`
// (clone / file / url / hdhomerun, or legacy import) — EXCEPT a registry built-in (p.builtin, i.e. id ===
// source), which keeps its dedicated "built-in" chip. A source-unset legacy/mock row → "manual". Distinct
// from the global/custom *endpoint* chip (where the m3u is hosted, not origination).
function sourceChip(p: Playlist): { label: string; tone: string; icon: string } {
  if (p.builtin) return { label: 'built-in', tone: 'system', icon: 'check' };
  if (p.source) return { label: p.source, tone: 'system', icon: SOURCE_CHIP_ICON[p.source] ?? 'playlist' };
  return { label: 'manual', tone: 'system', icon: 'list' };
}

// Rows grouped by source TYPE, headers shown alphabetically (built-in / clone / file / hdhomerun / url, plus
// legacy 'import' only if such rows exist). The group key mirrors sourceChip(): a registry built-in (id ===
// source) → "built-in", otherwise the stored `source` (a source-unset row falls into "other"). Only
// non-empty groups are emitted.
const groupedPlaylists = computed<{ key: string; items: Playlist[] }[]>(() => {
  const m = new Map<string, Playlist[]>();
  for (const p of playlists.value) {
    const key = p.builtin ? 'built-in' : p.source ?? 'other';
    let bucket = m.get(key);
    if (!bucket) m.set(key, (bucket = []));
    bucket.push(p);
  }
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, items]) => ({ key, items }));
});

function rowBusy(p: Playlist): boolean {
  if (isCustom(p)) return syncingIds.value.has(p.id) || composingIds.value.has(p.id);
  return syncingGlobal.value || composingGlobal.value;
}
function rowProgress(p: Playlist): number | null {
  if (isCustom(p)) return null; // single op → indeterminate
  if (syncingGlobal.value) return globalSyncProgress.value;
  if (composingGlobal.value) return globalComposeProgress.value;
  return null;
}

async function onSyncGlobal(): Promise<void> {
  if (syncingGlobal.value) return;
  const { total, failed } = await syncAllGlobal();
  await reloadList();
  if (failed.length) banner({ text: `Synced ${total - failed.length}/${total} global playlists · failed: ${failed.join(', ')}`, tone: 'warn', icon: 'warn' });
  else banner({ text: `Synced ${total} global playlist${total === 1 ? '' : 's'}`, tone: 'good', icon: 'sync' });
}

async function onComposeGlobal(): Promise<void> {
  if (composingGlobal.value) return;
  const { total, failed } = await composeAllGlobal();
  if (failed.length) banner({ text: `Composed ${total - failed.length}/${total} global playlists · failed: ${failed.join(', ')}`, tone: 'warn', icon: 'warn' });
  else banner({ text: `Composed ${total} global playlist${total === 1 ? '' : 's'}`, tone: 'good', icon: 'file' });
}

// Edit opens the same PlaylistStatusDrawer the detail screen uses. The list doesn't carry per-row
// channels, so fetch them on demand for the drawer's EPG/category summaries.
const statusOpen = ref(false);
const editPlaylist = ref<Playlist | null>(null);
const editChannels = ref<Channel[]>([]);

async function editRow(p: Playlist): Promise<void> {
  editPlaylist.value = p;
  editChannels.value = [];
  statusOpen.value = true;
  const res = await fetch(`/api/playlists/${encodeURIComponent(p.id)}/channels`);
  if (res.ok) editChannels.value = await res.json();
}

// Merge a persisted edit (drawer PUT) back into the matching list row — no full refetch needed.
function onPlaylistUpdated(patch: Partial<Playlist>): void {
  const id = editPlaylist.value?.id;
  if (!id) return;
  playlists.value = playlists.value.map((p) => p.id === id ? { ...p, ...patch } : p);
  editPlaylist.value = { ...editPlaylist.value!, ...patch };
}
</script>

<template>
  <div class="col">
    <div class="card flush">
      <div class="toolbar">
        <SearchInput :value="''" @change="() => {}" placeholder="Search playlists" />
        <span class="spacer" />
        <Btn variant="primary" icon="plus" @click="emit('add', 'playlist')">Add playlist</Btn>
      </div>
      <template v-for="g in groupedPlaylists" :key="g.key">
        <div class="pl-group-hdr">{{ g.key }}</div>
        <div v-for="p in g.items" :key="p.id" class="src-row pl-row pl-grouped" @click="router.push(`/playlists/${p.id}`)">
        <div :class="['src-ico', { builtin: p.builtin }]">
          <Icon :name="p.builtin ? 'tv' : 'playlist'" :size="18" />
        </div>
        <div class="pl-row-head">
          <div class="src-name">
            <div class="pl-name-row">
              <StatusDot :status="p.status" :pulse="p.status === 'good'" />
              <span class="pl-name" :title="p.name">{{ p.name }}</span>
            </div>
            <div class="pl-chip-row">
              <Pill :tone="sourceChip(p).tone"><Icon :name="sourceChip(p).icon" :size="10" />{{ sourceChip(p).label }}</Pill>
              <Pill tone="cyan"><Icon name="refresh" :size="10" />Sync: {{ playlistScheduleLabel(p.id, 'playlist') }}</Pill>
              <Pill tone="cyan"><Icon name="file" :size="10" />M3U: {{ playlistScheduleLabel(p.id, 'playlist-m3u') }}</Pill>
              <Pill :tone="p.endpoint === 'custom' ? 'warn' : 'good'">
                <Icon :name="p.endpoint === 'custom' ? 'file' : 'globe'" :size="10" />
                {{ p.endpoint === 'custom' ? 'custom' : 'global' }}
              </Pill>
              <Pill v-if="p.authentication" :tone="p.isAuthenticated ? 'good' : 'warn'">
                <Icon :name="p.isAuthenticated ? 'check' : 'lock'" :size="10" />
                {{ p.isAuthenticated ? 'Authenticated' : 'Sign-in needed' }}
              </Pill>
            </div>
          </div>
        </div>
        <template v-if="!rowBusy(p)">
          <Pill :tone="p.state !== false ? 'cyan' : 'disabled'">
            {{ p.state !== false ? 'Active' : 'Inactive' }}
          </Pill>
          <div class="stat-mini"><b>{{ p.channels }}</b>channels</div>
          <div class="stat-mini"><b>{{ p.groups }}</b>groups</div>
          <div class="stat-mini">
            <b style="font-size: 12px; font-weight: 500; color: var(--text-1);">{{ p.lastSync }}</b>
            last sync
          </div>
        </template>
        <ProgressBar v-else class="pl-row-progress" :value="rowProgress(p)" />
        <div class="row pl-row-actions" style="gap: 8px;" @click.stop>
          <template v-if="p.source && !isCustom(p)">
            <Btn variant="ghost" icon="refresh" :disabled="syncingGlobal" @click="onSyncGlobal">
              {{ syncingGlobal ? 'Syncing…' : 'Sync Global' }}
            </Btn>
            <Btn variant="ghost" icon="file" :disabled="composingGlobal" @click="onComposeGlobal">
              {{ composingGlobal ? 'Composing…' : 'Compose Global' }}
            </Btn>
          </template>
          <template v-else-if="p.source === 'clone'">
            <!-- A clone has no source to sync; m3u compose is manual only (interval 'none'). An invisible,
                 non-interactive placeholder holds the Sync slot so Compose lines up with the other rows. -->
            <Btn variant="ghost" icon="refresh" class="pl-row-spacer" disabled aria-hidden="true" tabindex="-1">Sync</Btn>
            <Btn variant="ghost" icon="file" :disabled="composingIds.has(p.id)" @click="composeRow(p)">
              {{ composingIds.has(p.id) ? 'Composing…' : 'Compose' }}
            </Btn>
          </template>
          <template v-else-if="p.source">
            <Btn variant="ghost" icon="refresh" :disabled="syncingIds.has(p.id)" @click="syncRow(p)">
              {{ syncingIds.has(p.id) ? 'Syncing…' : 'Sync' }}
            </Btn>
            <Btn variant="ghost" icon="file" :disabled="composingIds.has(p.id)" @click="composeRow(p)">
              {{ composingIds.has(p.id) ? 'Composing…' : 'Compose' }}
            </Btn>
          </template>
          <Btn variant="primary" icon="edit" @click="editRow(p)">Edit</Btn>
        </div>
        </div>
      </template>
    </div>

    <PlaylistStatusDrawer
      v-if="statusOpen && editPlaylist"
      :playlist="editPlaylist"
      :channels="editChannels"
      @updated="onPlaylistUpdated"
      @close="statusOpen = false"
    />
  </div>
</template>
