<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import { PLAYLISTS, reloadPlaylists, type Playlist } from '../data';
import { useToast } from '../composables/useToast';
import { globalMemberIds, hasGlobalAccess, toggleGlobal, toggleCustom } from '../composables/useUserAccess';
import { USERS, ensureUsers, saveUserAccess, type User } from '../composables/useUsers';

// ── Per-playlist "Assign access" ────────────────────────────────────────────────────────────────────────
// Scoped to ONE playlist (opened from that row's waffle menu): a list of users, each with a single
// grant/revoke toggle for THIS playlist. The semantics follow the playlist's type:
//   • Global playlist  → the toggle is the Global UNION (hasGlobalAccess / toggleGlobal): granting it puts
//     every endpoint:'global' member id into allowedPlaylists, so the user gains access to EVERY global
//     playlist at once — the shared "cross access". Opening this from any global row shows the same set.
//   • Custom playlist  → the toggle maps to this one allowedCustomPlaylists id.
// Each click IMMEDIATELY writes through saveUserAccess() (no batch/commit "Done" step — Done just closes),
// which patches the SHARED USERS singleton in place, so the admin Users screen and this modal stay in
// lockstep automatically. Admins always hold every playlist (backend materialization + role gate), so their
// row renders a locked all-access marker rather than a toggle.

const props = defineProps<{ playlist: Playlist }>();
const emit = defineEmits<{ (e: 'close'): void }>();
const { banner } = useToast();

const isGlobal = computed(() => props.playlist.endpoint === 'global');
const globalAvailable = computed(() => globalMemberIds.value.length > 0);

const loading = ref(false);
const search = ref('');
// Per-user in-flight ids so one row's save never disables/spins the others. saveUserAccess sends the user's
// FULL allow-lists, so locking the row while its toggle saves serializes that user's writes (last-write-wins
// avoided); different users still save in parallel (independent docs).
const savingIds = ref(new Set<string>());

const filteredUsers = computed<User[]>(() => {
    const q = search.value.trim().toLowerCase();
    const list = USERS.value;
    if (!q) return list;
    return list.filter((u) => u.username.toLowerCase().includes(q));
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
    // globalMemberIds / hasGlobalAccess derive from PLAYLISTS — make sure it's loaded.
    if (!PLAYLISTS.value.length) reloadPlaylists().catch(() => {});
});

function isChecked(user: User): boolean {
    if (user.role === 'admin') return true; // unfiltered — full access
    return isGlobal.value ? hasGlobalAccess(user) : (user.allowedCustomPlaylists || []).includes(props.playlist.id);
}

function rowDisabled(user: User): boolean {
    if (user.role === 'admin') return true; // editing an admin's arrays is meaningless
    if (isGlobal.value && !globalAvailable.value) return true; // nothing to grant
    return savingIds.value.has(user._id);
}

async function toggleUser(user: User): Promise<void> {
    if (rowDisabled(user)) return;
    savingIds.value = new Set(savingIds.value).add(user._id);

    let allowedPlaylists = [...(user.allowedPlaylists || [])];
    let allowedCustomPlaylists = [...(user.allowedCustomPlaylists || [])];
    if (isGlobal.value) {
        allowedPlaylists = toggleGlobal(allowedPlaylists, !hasGlobalAccess(user));
    } else {
        const on = !allowedCustomPlaylists.includes(props.playlist.id);
        allowedCustomPlaylists = toggleCustom(allowedCustomPlaylists, props.playlist.id, on);
    }

    try {
        // saveUserAccess patches USERS in place on success → the toggle's checked state updates reactively.
        await saveUserAccess(user._id, { allowedPlaylists, allowedCustomPlaylists });
    } catch (err) {
        banner({ text: `Could not update access: ${(err as Error).message}`, tone: 'bad', icon: 'warn' });
    } finally {
        const n = new Set(savingIds.value);
        n.delete(user._id);
        savingIds.value = n;
    }
}
</script>

<template>
    <div class="modal-bg" role="dialog" aria-modal="true" aria-labelledby="assign-access-title" @click="emit('close')">
        <div class="modal assign-modal" @click.stop>
            <div class="modal-hd">
                <Icon :name="isGlobal ? 'globe' : 'lock'" :size="18" />
                <h2 id="assign-access-title">Assign access · {{ isGlobal ? 'Global' : playlist.name }}</h2>
                <span class="spacer" />
                <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
            </div>

            <div class="modal-body assign-body">
                <div class="assign-tools">
                    <div class="input search-input">
                        <Icon name="search" :size="14" />
                        <input v-model="search" type="text" placeholder="Filter users…" />
                    </div>
                    <span class="muted font-xs assign-hint">
                        <template v-if="isGlobal">Grants the whole <b>Global</b> playlist union — the same cross-access across every global playlist.</template>
                        <template v-else>Grants access to <b>{{ playlist.name }}</b>.</template>
                    </span>
                </div>

                <div v-if="loading" class="muted assign-empty">Loading users…</div>
                <div v-else-if="USERS.length === 0" class="muted assign-empty">No users found.</div>
                <ul v-else class="user-list">
                    <li v-for="user in filteredUsers" :key="user._id" class="user-row">
                        <div class="user-cell">
                            <div class="avatar-sm">{{ user.username.slice(0, 2).toUpperCase() }}</div>
                            <span class="uname" :title="user.username">{{ user.username }}</span>
                            <Pill v-if="user.role === 'admin'" tone="cyan">admin — all access</Pill>
                        </div>
                        <!-- Admin: locked all-access marker (admins always hold every playlist). -->
                        <button
                            v-if="user.role === 'admin'"
                            type="button"
                            class="cell-box locked"
                            disabled
                            :title="`Admins always have access to ${playlist.name}`"
                        >
                            <Icon name="lock" :size="12" />
                        </button>
                        <!-- Standard user: immediate grant/revoke for this playlist. -->
                        <button
                            v-else
                            type="button"
                            class="cell-box"
                            :class="{ saving: savingIds.has(user._id) }"
                            :disabled="rowDisabled(user)"
                            :aria-label="`${isChecked(user) ? 'Revoke' : 'Grant'} access for ${user.username}`"
                            @click="toggleUser(user)"
                        >
                            <span :class="['cbx', { on: isChecked(user) }]" />
                        </button>
                    </li>
                    <li v-if="filteredUsers.length === 0" class="muted assign-empty">No users match "{{ search }}".</li>
                </ul>
            </div>

            <div class="modal-ft">
                <Btn variant="primary" icon="check" @click="emit('close')">Done</Btn>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* Reuse the global .modal surface; a compact single-playlist width. */
.assign-modal {
    width: min(520px, 94vw);
}
/* Header/search/footer sit OUTSIDE the scroll region, so they stay in view; only the user list scrolls. */
.assign-body {
    gap: 12px;
    max-height: 72vh;
    min-height: 0;
}
.assign-tools {
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
.assign-hint {
    flex: 1;
    min-width: 0;
}
.assign-empty {
    padding: 28px;
    text-align: center;
}
.user-list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    min-height: 0;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-s);
    background: var(--bg-2);
}
.user-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--hairline);
}
.user-row:last-child {
    border-bottom: 0;
}
.user-cell {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
}
.avatar-sm {
    width: 26px;
    height: 26px;
    flex: none;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent-hi);
    font-weight: 700;
    font-size: 10px;
    display: grid;
    place-items: center;
}
.uname {
    font-weight: 600;
    color: var(--text-0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
/* Grant/revoke toggle button (reuses the global .cbx checkbox glyph). */
.cell-box {
    margin-left: auto;
    flex: none;
    min-height: 32px;
    padding: 0 6px;
    border: 0;
    background: transparent;
    display: grid;
    place-items: center;
    cursor: pointer;
    border-radius: var(--radius-s);
    transition: background .12s;
}
.cell-box:hover:not(:disabled) {
    background: var(--bg-3);
}
.cell-box:disabled {
    cursor: default;
}
.cell-box.saving {
    opacity: 0.5;
    pointer-events: none;
}
/* Admin rows are locked all-access — a muted lock glyph, never a togglable checkbox. */
.cell-box.locked {
    color: var(--text-2);
    opacity: 0.7;
}
.cell-box.locked:hover {
    background: transparent;
}
.font-xs {
    font-size: 10.5px;
}
</style>
