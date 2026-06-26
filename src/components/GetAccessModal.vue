<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import AccessUrlTable, { type AccessUserRows } from './AccessUrlTable.vue';
import { PLAYLISTS, reloadPlaylists } from '../data';
import { useToast } from '../composables/useToast';
import {
    globalMemberIds,
    nonGlobalPlaylists,
    buildPublishedGroups,
    type PublishedUrlUser,
} from '../composables/useUserAccess';
import { USERS, ensureUsers, type User } from '../composables/useUsers';

// ── "Get access" modal ──────────────────────────────────────────────────────────────────────────────────
// Surfaces every user's personalized published URLs (M3U + EPG/Guide per playlist) ALL AT ONCE so an operator
// can hand a user their links without opening the Users screen. Each user's rows come from the shared pure
// buildPublishedGroups() (same derivation the Users screen uses), so the URLs match exactly. Admins are
// unfiltered — they're synthesized as full access (every Global member + every custom) so their URLs are
// available too. Reads the shared USERS singleton, so it reflects assignments made in the Assign-access modal
// or the Users screen live.

const emit = defineEmits<{ (e: 'close'): void }>();
const { banner } = useToast();

const loading = ref(false);
const search = ref('');
const onlyWithAccess = ref(true);

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

// One AccessUserRows per user (computed inside the reactive scope so domain/PLAYLISTS changes track).
const allRows = computed<AccessUserRows[]>(() =>
    USERS.value.map((u) => ({
        id: u._id,
        username: u.username,
        role: u.role,
        groups: buildPublishedGroups(toPublishedUser(u)),
    })),
);

const rows = computed<AccessUserRows[]>(() => {
    const q = search.value.trim().toLowerCase();
    return allRows.value.filter((r) => {
        if (onlyWithAccess.value && r.groups.length === 0) return false;
        if (q && !r.username.toLowerCase().includes(q)) return false;
        return true;
    });
});

const withAccessCount = computed(() => allRows.value.filter((r) => r.groups.length > 0).length);

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
                <Icon name="link" :size="18" />
                <h2 id="get-access-title">Get access</h2>
                <span class="spacer" />
                <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
            </div>

            <div class="modal-body get-body">
                <div class="get-tools">
                    <div class="input search-input">
                        <Icon name="search" :size="14" />
                        <input v-model="search" type="text" placeholder="Filter users…" />
                    </div>
                    <label class="toggle-line">
                        <input v-model="onlyWithAccess" type="checkbox" />
                        <span class="muted font-xs">Only users with access</span>
                    </label>
                    <span class="spacer" />
                    <span class="muted font-xs">{{ withAccessCount }} of {{ allRows.length }} users have access</span>
                </div>

                <div v-if="loading" class="muted get-empty">Loading users…</div>
                <div v-else-if="rows.length === 0" class="muted get-empty">
                    No users to show. Assign access first, or clear the filter.
                </div>
                <AccessUrlTable v-else :rows="rows" />
            </div>
        </div>
    </div>
</template>

<style scoped>
.get-modal {
    width: min(1080px, 94vw);
}
.get-body {
    gap: 12px;
    max-height: 78vh;
}
.get-tools {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
}
.search-input {
    width: 260px;
    max-width: 100%;
}
.toggle-line {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
}
.get-empty {
    padding: 28px;
    text-align: center;
}
.font-xs {
    font-size: 10.5px;
}
</style>
