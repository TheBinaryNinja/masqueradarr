<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import AccessUrlTable, { type AccessUserRows } from './AccessUrlTable.vue';
import { PLAYLISTS, reloadPlaylists, type Playlist } from '../data';
import { useToast } from '../composables/useToast';
import {
    globalMemberIds,
    nonGlobalPlaylists,
    buildPublishedGroups,
    type PublishedUrlUser,
} from '../composables/useUserAccess';
import { USERS, ensureUsers, type User } from '../composables/useUsers';

// ── Per-playlist "Get access" modal ─────────────────────────────────────────────────────────────────────
// Scoped to ONE playlist (opened from that row's waffle menu): the published URLs (M3U + EPG/Guide) for THIS
// playlist, one row per user who has access to it. URLs come from the shared pure buildPublishedGroups()
// (the same derivation the Users screen / Dashboard use), filtered to the single group that matches this
// playlist:
//   • Global playlist → the Global union group (kind:'Global'). Every global playlist shares the SAME URL
//     pair, so opening this from any global row lists the same URLs + everyone who holds global access.
//   • Custom playlist → that playlist's own group (key `custom-<id>`).
// Admins are synthesized as full access so their URLs appear too. Reads the shared USERS singleton, so it
// reflects assignments made in the Assign-access modal or the Users screen live.

const props = defineProps<{ playlist: Playlist }>();
const emit = defineEmits<{ (e: 'close'): void }>();
const { banner } = useToast();

const loading = ref(false);
const search = ref('');

const isGlobal = computed(() => props.playlist.endpoint === 'global');

// Expand an admin to full access; a normal user maps 1:1 to its stored allow-lists.
function toPublishedUser(u: User): PublishedUrlUser {
    if (u.role === 'admin') {
        return {
            username: u.username,
            slug: u.slug,
            allowedPlaylists: globalMemberIds.value,
            allowedCustomPlaylists: nonGlobalPlaylists.value.map((p) => p.id),
        };
    }
    return {
        username: u.username,
        slug: u.slug,
        allowedPlaylists: u.allowedPlaylists || [],
        allowedCustomPlaylists: u.allowedCustomPlaylists || [],
    };
}

// One AccessUserRows per user who has access to THIS playlist, carrying only the matching group so the table
// shows a single URL pair per user. Users without the group (no access) are skipped.
const rows = computed<AccessUserRows[]>(() => {
    const q = search.value.trim().toLowerCase();
    const out: AccessUserRows[] = [];
    for (const u of USERS.value) {
        const groups = buildPublishedGroups(toPublishedUser(u));
        const g = isGlobal.value
            ? groups.find((x) => x.kind === 'Global')
            : groups.find((x) => x.key === `custom-${props.playlist.id}`);
        if (!g) continue; // no access to this playlist
        if (q && !u.username.toLowerCase().includes(q)) continue;
        out.push({ id: u._id, username: u.username, role: u.role, groups: [g] });
    }
    return out;
});

onMounted(async () => {
    loading.value = true;
    try {
        await ensureUsers();
    } catch {
        banner({ text: 'Failed to load user list', tone: 'bad', icon: 'warn' });
    } finally {
        loading.value = false;
    }
    if (!PLAYLISTS.value.length) reloadPlaylists().catch(() => {});
});
</script>

<template>
    <div class="modal-bg" role="dialog" aria-modal="true" aria-labelledby="get-access-title" @click="emit('close')">
        <div class="modal get-modal" @click.stop>
            <div class="modal-hd">
                <Icon :name="isGlobal ? 'globe' : 'link'" :size="18" />
                <h2 id="get-access-title">Get access · {{ isGlobal ? 'Global' : playlist.name }}</h2>
                <span class="spacer" />
                <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
            </div>

            <div class="modal-body get-body">
                <div class="get-tools">
                    <div class="input search-input">
                        <Icon name="search" :size="14" />
                        <input v-model="search" type="text" placeholder="Filter users…" />
                    </div>
                    <span class="muted font-xs get-hint">
                        <template v-if="isGlobal">Shared <b>Global</b> URLs — the same across every global playlist.</template>
                        <template v-else>Published URLs for <b>{{ playlist.name }}</b>.</template>
                    </span>
                    <span class="spacer" />
                    <span class="muted font-xs">{{ rows.length }} user{{ rows.length === 1 ? '' : 's' }} with access</span>
                </div>

                <div v-if="loading" class="muted get-empty">Loading users…</div>
                <div v-else-if="rows.length === 0" class="muted get-empty">
                    No users have access to this playlist yet. Assign access first.
                </div>
                <AccessUrlTable v-else :rows="rows" />
            </div>

            <div class="modal-ft">
                <Btn variant="primary" icon="check" @click="emit('close')">Done</Btn>
            </div>
        </div>
    </div>
</template>

<style scoped>
.get-modal {
    width: min(920px, 94vw);
}
/* Header/search/footer sit OUTSIDE the scroll region; only the URL table scrolls (bounded below). */
.get-body {
    gap: 12px;
    max-height: 76vh;
    min-height: 0;
}
.get-tools {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    flex: none;
}
.search-input {
    width: 260px;
    max-width: 100%;
}
.get-hint {
    min-width: 0;
}
.get-empty {
    padding: 28px;
    text-align: center;
}
/* Bound the table's OWN scroll container (where its sticky <thead> is anchored) so the sticky header keeps
   working and the modal header/footer stay in view. */
.get-body :deep(.access-wrap) {
    max-height: 60vh;
}
.font-xs {
    font-size: 10.5px;
}
</style>
