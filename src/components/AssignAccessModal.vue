<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import { PLAYLISTS, reloadPlaylists } from '../data';
import { useToast } from '../composables/useToast';
import {
    globalMemberIds,
    nonGlobalPlaylists,
    hasGlobalAccess,
    toggleGlobal,
    toggleCustom,
} from '../composables/useUserAccess';
import { USERS, ensureUsers, saveUserAccess, type User } from '../composables/useUsers';

// ── "Assign access" matrix ──────────────────────────────────────────────────────────────────────────────
// Users (rows) × access columns (a single "Global" unit + one per custom playlist). This is now the PRIMARY
// control for per-user playlist assignment (the Users screen no longer manages playlists). Each checkbox click
// IMMEDIATELY writes through saveUserAccess() — there is no batch/commit "Done" step; the modal closes via its
// X / backdrop. saveUserAccess patches the SHARED USERS singleton in place, so the admin Users screen and this
// modal stay in lockstep automatically (the bidirectional sync). The model mirrors the Users screen EXACTLY:
// "Global" is the UNION of every endpoint:'global' source playlist (granting it = putting every Global-member
// id into allowedPlaylists), and each custom column maps to one allowedCustomPlaylists id.
//
// Admin rows are NOT individually togglable: an admin account ALWAYS holds every playlist (the backend
// materializes its allow-lists and the role gate grants all access regardless), so every admin cell renders as
// a locked all-access marker rather than a checkbox.

const emit = defineEmits<{ (e: 'close'): void }>();
const { banner } = useToast();

const loading = ref(false);
const search = ref('');
// Per-cell in-flight keys ("<userId>:<colKey>") so one cell's save never disables/spins the others.
const savingKeys = ref(new Set<string>());

interface Col {
    key: string;          // unique column key (and busy-key segment)
    id: string;           // playlist id (custom columns only; '' for Global)
    label: string;
    kind: 'global' | 'custom';
}

// Global first, then one column per custom (non-Global) playlist.
const columns = computed<Col[]>(() => [
    { key: '__global__', id: '', label: 'Global', kind: 'global' },
    ...nonGlobalPlaylists.value.map((p) => ({ key: `c-${p.id}`, id: p.id, label: p.name, kind: 'custom' as const })),
]);

const globalAvailable = computed(() => globalMemberIds.value.length > 0);

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
    if (!PLAYLISTS.value.length) reloadPlaylists().catch(() => {});
});

function cellKey(userId: string, colKey: string): string {
    return `${userId}:${colKey}`;
}

function isChecked(user: User, col: Col): boolean {
    if (user.role === 'admin') return true; // unfiltered — full access
    if (col.kind === 'global') return hasGlobalAccess(user);
    return (user.allowedCustomPlaylists || []).includes(col.id);
}

function isSaving(user: User, col: Col): boolean {
    return savingKeys.value.has(cellKey(user._id, col.key));
}

// Any in-flight save for THIS user (any column). saveUserAccess sends the user's FULL allow-lists, so two
// concurrent toggles on the same row each read the same pre-save base and the second PUT silently clobbers the
// first (last write wins). Locking the whole row while one of its cells saves serializes per-user writes;
// different users still save in parallel (independent docs). _id is colon-free, so the prefix match is exact.
function userBusy(userId: string): boolean {
    for (const k of savingKeys.value) if (k.startsWith(`${userId}:`)) return true;
    return false;
}

function cellDisabled(user: User, col: Col): boolean {
    if (user.role === 'admin') return true; // editing an admin's arrays is meaningless
    if (col.kind === 'global' && !globalAvailable.value) return true; // nothing to grant
    return userBusy(user._id);
}

async function toggleCell(user: User, col: Col): Promise<void> {
    if (cellDisabled(user, col)) return;
    const key = cellKey(user._id, col.key);
    savingKeys.value = new Set(savingKeys.value).add(key);

    let allowedPlaylists = [...(user.allowedPlaylists || [])];
    let allowedCustomPlaylists = [...(user.allowedCustomPlaylists || [])];
    if (col.kind === 'global') {
        allowedPlaylists = toggleGlobal(allowedPlaylists, !hasGlobalAccess(user));
    } else {
        const on = !allowedCustomPlaylists.includes(col.id);
        allowedCustomPlaylists = toggleCustom(allowedCustomPlaylists, col.id, on);
    }

    try {
        // saveUserAccess patches USERS in place on success → the cell's checked state updates reactively.
        await saveUserAccess(user._id, { allowedPlaylists, allowedCustomPlaylists });
    } catch (err) {
        banner({ text: `Could not update access: ${(err as Error).message}`, tone: 'bad', icon: 'warn' });
    } finally {
        const n = new Set(savingKeys.value);
        n.delete(key);
        savingKeys.value = n;
    }
}
</script>

<template>
    <div class="modal-bg" role="dialog" aria-modal="true" aria-labelledby="assign-access-title" @click="emit('close')">
        <div class="modal assign-modal" @click.stop>
            <div class="modal-hd">
                <Icon name="lock" :size="18" />
                <h2 id="assign-access-title">Assign access</h2>
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
                        Toggle a cell to grant or revoke. "Global" is the union of every built-in source.
                    </span>
                </div>

                <div v-if="loading" class="muted assign-empty">Loading users…</div>
                <div v-else-if="USERS.length === 0" class="muted assign-empty">No users found.</div>
                <div v-else class="matrix-wrap">
                    <table class="matrix">
                        <thead>
                            <tr>
                                <th class="corner">User</th>
                                <th v-for="col in columns" :key="col.key" class="col-hd">
                                    <div class="col-hd-inner">
                                        <Icon :name="col.kind === 'global' ? 'globe' : 'file'" :size="11" />
                                        <span :title="col.label">{{ col.label }}</span>
                                    </div>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="user in filteredUsers" :key="user._id">
                                <th class="row-hd">
                                    <div class="row-hd-inner">
                                        <div class="avatar-sm">{{ user.username.slice(0, 2).toUpperCase() }}</div>
                                        <div class="row-hd-meta">
                                            <span class="uname" :title="user.username">{{ user.username }}</span>
                                            <Pill v-if="user.role === 'admin'" tone="cyan">admin — all access</Pill>
                                        </div>
                                    </div>
                                </th>
                                <td v-for="col in columns" :key="col.key" class="cell">
                                    <!-- Admin: locked all-access marker (admins always hold every playlist). -->
                                    <button
                                        v-if="user.role === 'admin'"
                                        type="button"
                                        class="cell-box locked"
                                        disabled
                                        :aria-label="`${user.username} is an admin — always has access to ${col.label}`"
                                        :title="`Admins always have access to ${col.label}`"
                                    >
                                        <Icon name="lock" :size="12" />
                                    </button>
                                    <!-- Standard user: immediate per-cell grant/revoke. -->
                                    <button
                                        v-else
                                        type="button"
                                        class="cell-box"
                                        :class="{ saving: isSaving(user, col) }"
                                        :disabled="cellDisabled(user, col)"
                                        :aria-label="`${isChecked(user, col) ? 'Revoke' : 'Grant'} ${col.label} for ${user.username}`"
                                        @click="toggleCell(user, col)"
                                    >
                                        <span :class="['cbx', { on: isChecked(user, col) }]" />
                                    </button>
                                </td>
                            </tr>
                            <tr v-if="filteredUsers.length === 0">
                                <td :colspan="columns.length + 1" class="muted assign-empty">No users match "{{ search }}".</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* Reuse the global .modal surface; widen it for the matrix. */
.assign-modal {
    width: min(1080px, 94vw);
}
.assign-body {
    gap: 12px;
    max-height: 78vh;
}
.assign-tools {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
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
/* Scroll container: sticky header row + sticky first column live inside it. */
.matrix-wrap {
    overflow: auto;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-s);
    background: var(--bg-2);
}
.matrix {
    border-collapse: separate;
    border-spacing: 0;
    width: 100%;
    font-size: var(--fs-sm);
}
.matrix th,
.matrix td {
    border-bottom: 1px solid var(--hairline);
    border-right: 1px solid var(--hairline);
}
.matrix thead th {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--bg-3);
    padding: 10px 8px;
    font-weight: 600;
    color: var(--text-2);
    text-align: center;
    vertical-align: bottom;
}
.matrix thead th.corner {
    left: 0;
    z-index: 3;
    text-align: left;
    min-width: 180px;
}
.col-hd-inner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    max-width: 150px;
    margin: 0 auto;
}
.col-hd-inner span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
/* Sticky first column (username). */
.matrix .row-hd {
    position: sticky;
    left: 0;
    z-index: 1;
    background: var(--bg-2);
    padding: 8px 10px;
    text-align: left;
    min-width: 180px;
}
.row-hd-inner {
    display: flex;
    align-items: center;
    gap: 8px;
}
.row-hd-meta {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
}
.uname {
    font-weight: 600;
    color: var(--text-0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
.cell {
    padding: 0;
    text-align: center;
}
.cell-box {
    width: 100%;
    height: 100%;
    min-height: 42px;
    border: 0;
    background: transparent;
    display: grid;
    place-items: center;
    cursor: pointer;
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
/* Admin cells are locked all-access — a muted lock glyph, never a togglable checkbox. */
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
