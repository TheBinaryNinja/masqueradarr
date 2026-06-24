<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';
import Pill from '../components/Pill.vue';
import PublishedUrlGroups from '../components/PublishedUrlGroups.vue';
import { PLAYLISTS, reloadPlaylists } from '../data';
import { currentUser } from '../composables/useAuth';
import { usePublishedUrls, globalMemberIds, nonGlobalPlaylists, type PublishedUrlUser } from '../composables/usePublishedUrls';

interface User {
    _id: string;
    username: string;
    role: 'admin' | 'user';
    streamToken: string;
    streamTokenEnabled: boolean;
    slug: string;
    allowedPlaylists: string[];
    allowedCustomPlaylists: string[];
    createdAt: string;
}

const users = ref<User[]>([]);
const loading = ref(false);
const error = ref('');
const successMsg = ref('');

// Drawer state
const drawerOpen = ref(false);
const editUserId = ref<string | null>(null);
// The full row being edited — drives the right-hand published-URL / token-validation column. Null on Add
// (a brand-new user has no slug/streamToken yet, so those read-outs only appear once the row exists).
const editingUser = ref<User | null>(null);
const formUsername = ref('');
const formPassword = ref('');
const formRole = ref<'admin' | 'user'>('user');
const formTokenEnabled = ref(true);
const formPlaylists = ref<string[]>([]);
const formCustomPlaylists = ref<string[]>([]);

// "Global access" is not a single playlist row — the Global playlist is the UNION of every
// endpoint:'Global' source playlist (dulo/dlhd/tubi/…). The access model keys on `allowedPlaylists`
// holding those source ids (the read filter, the stream gate, and the per-user compose visibility all
// check allowedPlaylists.includes(<sourceId>)), so granting Global = putting every Global-member id into
// allowedPlaylists. `globalMemberIds` + `nonGlobalPlaylists` are shared (usePublishedUrls) so the access
// checklists and the published-URL derivation key off the SAME computed sets.

// The single Global toggle: ON when the user already has every Global member id in allowedPlaylists.
const hasGlobalAccess = computed(() =>
    globalMemberIds.value.length > 0 && globalMemberIds.value.every((id) => formPlaylists.value.includes(id)),
);
function toggleGlobalAccess() {
    if (hasGlobalAccess.value) {
        // Drop every Global member id, keeping any non-Global entries already in the list untouched.
        const members = new Set(globalMemberIds.value);
        formPlaylists.value = formPlaylists.value.filter((id) => !members.has(id));
    } else {
        // Add every Global member id (dedup against whatever is already there).
        formPlaylists.value = Array.from(new Set([...formPlaylists.value, ...globalMemberIds.value]));
    }
}

async function fetchUsers() {
    loading.value = true;
    try {
        const res = await fetch('/api/users');
        if (!res.ok) throw new Error();
        users.value = await res.json() as User[];
    } catch (err) {
        error.value = 'Failed to load user list';
    } finally {
        loading.value = false;
    }
}

onMounted(() => {
    fetchUsers();
    // Ensure playlists and custom playlists are loaded
    if (!PLAYLISTS.value.length) {
        reloadPlaylists().catch(() => {});
    }
});

function openAdd() {
    editUserId.value = null;
    editingUser.value = null;
    formUsername.value = '';
    formPassword.value = '';
    formRole.value = 'user';
    formTokenEnabled.value = true;
    formPlaylists.value = [];
    formCustomPlaylists.value = [];
    error.value = '';
    successMsg.value = '';
    drawerOpen.value = true;
}

function openEdit(user: User) {
    editUserId.value = user._id;
    editingUser.value = user;
    formUsername.value = user.username;
    formPassword.value = '';
    formRole.value = user.role;
    formTokenEnabled.value = user.streamTokenEnabled;
    formPlaylists.value = [...(user.allowedPlaylists || [])];
    formCustomPlaylists.value = [...(user.allowedCustomPlaylists || [])];
    error.value = '';
    successMsg.value = '';
    drawerOpen.value = true;
}

async function saveUser() {
    error.value = '';
    successMsg.value = '';

    if (!formUsername.value.trim()) {
        error.value = 'Username is required';
        return;
    }

    const payload: any = {
        username: formUsername.value.trim(),
        role: formRole.value,
        allowedPlaylists: formPlaylists.value,
        allowedCustomPlaylists: formCustomPlaylists.value,
        streamTokenEnabled: formTokenEnabled.value,
    };

    if (formPassword.value) {
        if (formPassword.value.length < 6) {
            error.value = 'Password must be at least 6 characters';
            return;
        }
        payload.password = formPassword.value;
    }

    const isEdit = !!editUserId.value;
    const url = isEdit ? `/api/users/${editUserId.value}` : '/api/users';
    const method = isEdit ? 'PUT' : 'POST';

    if (!isEdit && !formPassword.value) {
        error.value = 'Password is required for new users';
        return;
    }

    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const data = await res.json() as { error?: string };
            error.value = data.error || 'Failed to save user';
            return;
        }

        successMsg.value = isEdit ? 'User updated successfully' : 'User created successfully';
        await fetchUsers();
        setTimeout(() => {
            drawerOpen.value = false;
        }, 800);
    } catch (err) {
        error.value = 'Network error saving user';
    }
}

async function deleteUser(user: User) {
    if (user._id === (currentUser.value as any)?._id) {
        alert('You cannot delete your own account');
        return;
    }
    if (!confirm(`Are you sure you want to delete user "${user.username}"?`)) {
        return;
    }

    try {
        const res = await fetch(`/api/users/${user._id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error();
        successMsg.value = 'User deleted successfully';
        await fetchUsers();
    } catch (err) {
        error.value = 'Failed to delete user';
    }
}

// The drawer's right column derives its published-URL cards from the SHARED usePublishedUrls() composable.
// IMPORTANT — live-toggle: the card MEMBERSHIP must update as the admin checks/unchecks the access boxes,
// while the URL IDENTITY (username/slug) comes from the row being edited. So we feed usePublishedUrls a
// synthetic user that combines editingUser's identity with the LIVE form refs (formPlaylists /
// formCustomPlaylists). Null until a real row is being edited (a brand-new user has no slug/streamToken yet).
const publishedUrlUser = computed<PublishedUrlUser | null>(() => {
    const u = editingUser.value;
    if (!u) return null;
    return {
        username: u.username,
        slug: u.slug,
        allowedPlaylists: formPlaylists.value,
        allowedCustomPlaylists: formCustomPlaylists.value,
    };
});
const publishedUrls = usePublishedUrls(publishedUrlUser);

// Partial/masked view of the user's IPTV stream token so an admin can confirm it EXISTS without ever
// rendering the full credential. Shows a short prefix + suffix with the middle masked.
function maskToken(tok: string): string {
    if (!tok) return '—';
    if (tok.length <= 12) return `${tok.slice(0, 2)}••••`;
    return `${tok.slice(0, 6)}••••••••${tok.slice(-4)}`;
}

function formatTime(s: string) {
    if (!s) return '—';
    const ms = Date.parse(s);
    if (Number.isNaN(ms)) return s;
    return new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function toggleCustomPlaylistSelection(id: string) {
    const idx = formCustomPlaylists.value.indexOf(id);
    if (idx === -1) {
        formCustomPlaylists.value.push(id);
    } else {
        formCustomPlaylists.value.splice(idx, 1);
    }
}
</script>

<template>
    <div class="users-screen col" style="gap: 18px;">
        <div class="card header-card">
            <div class="row align-center">
                <Icon name="settings" :size="18" />
                <div>
                    <div class="title-text">User Management</div>
                    <div class="muted text-xs">Create, edit, and audit operator credentials and playlists accessibility scope.</div>
                </div>
                <span class="spacer" />
                <Btn variant="primary" icon="plus" @click="openAdd">Add User</Btn>
            </div>
        </div>

        <div v-if="successMsg" class="banner success">
            <Icon name="check" :size="14" />
            <span>{{ successMsg }}</span>
        </div>
        <div v-if="error" class="banner error">
            <Icon name="file" :size="14" />
            <span>{{ error }}</span>
        </div>

        <div class="card flush table-card">
            <table class="tbl">
                <thead>
                    <tr>
                        <th>Username</th>
                        <th>Role</th>
                        <th>Allowed Playlists</th>
                        <th>Created</th>
                        <th style="text-align: right;">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="user in users" :key="user._id">
                        <td>
                            <div class="row align-center" style="gap: 8px;">
                                <div class="avatar-sm">{{ user.username.slice(0,2).toUpperCase() }}</div>
                                <span class="username-text">{{ user.username }}</span>
                            </div>
                        </td>
                        <td>
                            <Pill :tone="user.role === 'admin' ? 'cyan' : 'default'">{{ user.role }}</Pill>
                        </td>
                        <td>
                            <span class="text-sm">
                                {{ (user.allowedPlaylists || []).length }} standard
                                <template v-if="(user.allowedCustomPlaylists || []).length > 0">
                                    , {{ user.allowedCustomPlaylists.length }} custom
                                </template>
                            </span>
                        </td>
                        <td class="muted mono">{{ formatTime(user.createdAt) }}</td>
                        <td>
                            <div class="row justify-end" style="gap: 8px;">
                                <Btn variant="ghost" class="sm" icon="settings" @click="openEdit(user)">Edit</Btn>
                                <Btn v-if="user._id !== (currentUser as any)?._id" variant="ghost" class="sm danger" icon="plus" @click="deleteUser(user)">Delete</Btn>
                            </div>
                        </td>
                    </tr>
                </tbody>
            </table>
            <div v-if="users.length === 0 && !loading" class="empty" style="padding: 40px;">
                <div class="muted">No users found.</div>
            </div>
        </div>

        <!-- Slide-out edit/add user drawer -->
        <div v-if="drawerOpen" class="drawer-overlay" @click="drawerOpen = false">
            <div class="drawer" @click.stop>
                <header class="drawer-hdr">
                    <h3>{{ editUserId ? 'Edit User Context' : 'Register New User' }}</h3>
                    <button class="close-btn" @click="drawerOpen = false">&times;</button>
                </header>

                <div class="drawer-body">
                    <div class="drawer-cols">
                        <!-- Left column: account controls -->
                        <div class="drawer-col">
                            <div class="form-group">
                                <label>Username</label>
                                <div class="input">
                                    <input v-model="formUsername" type="text" placeholder="Enter username" :disabled="!!editUserId" />
                                </div>
                            </div>

                            <div class="form-group">
                                <label>{{ editUserId ? 'Reset Password (optional)' : 'Password' }}</label>
                                <div class="input">
                                    <input v-model="formPassword" type="password" placeholder="At least 6 characters" />
                                </div>
                            </div>

                            <div class="form-group">
                                <label>Account Role</label>
                                <div class="radio-group">
                                    <label class="radio-label">
                                        <input v-model="formRole" type="radio" value="user" />
                                        <span>Standard User</span>
                                    </label>
                                    <label class="radio-label" style="margin-left: 14px;">
                                        <input v-model="formRole" type="radio" value="admin" />
                                        <span>Administrator</span>
                                    </label>
                                </div>
                            </div>

                            <div class="form-group">
                                <label>IPTV Token State</label>
                                <div class="row align-center" style="gap: 10px;">
                                    <button :class="['toggle', { on: formTokenEnabled }]" @click="formTokenEnabled = !formTokenEnabled" />
                                    <span class="text-sm muted">{{ formTokenEnabled ? 'Token is Active and streaming is allowed' : 'Token is Disabled; streaming requests are blocked' }}</span>
                                </div>
                            </div>

                            <!-- IPTV Token (validation) — relocated under the token-state toggle (left column).
                                 Read-only confirmation the credential exists; only meaningful once the row exists. -->
                            <div v-if="editingUser" class="form-group token-validation">
                                <label>IPTV Token (validation)</label>
                                <div class="row align-center" style="gap: 8px;">
                                    <span class="mono token-preview">{{ maskToken(editingUser.streamToken) }}</span>
                                    <Pill :tone="editingUser.streamTokenEnabled ? 'cyan' : 'disabled'">
                                        {{ editingUser.streamTokenEnabled ? 'Active' : 'Disabled' }}
                                    </Pill>
                                </div>
                                <span class="muted font-xs">Masked for security — confirms the token exists without exposing it.</span>
                            </div>

                            <div class="checklist-section">
                                <label class="section-label">Allowed Global Playlist</label>
                                <div class="checklist">
                                    <div class="check-item" @click="toggleGlobalAccess">
                                        <div :class="['cbx', { on: hasGlobalAccess }]" />
                                        <span class="text-sm">Global <span class="muted font-xs">(union of all built-in sources)</span></span>
                                    </div>
                                    <div v-if="globalMemberIds.length === 0" class="muted text-xs">No built-in (Global) playlists available yet.</div>
                                </div>

                                <label class="section-label" style="margin-top: 14px;">Allowed Custom Playlists</label>
                                <div class="checklist">
                                    <div v-for="p in nonGlobalPlaylists" :key="p.id" class="check-item" @click="toggleCustomPlaylistSelection(p.id)">
                                        <div :class="['cbx', { on: formCustomPlaylists.includes(p.id) }]" />
                                        <span class="text-sm">{{ p.name }} <span class="muted font-xs">({{ p.id }})</span></span>
                                    </div>
                                    <div v-if="nonGlobalPlaylists.length === 0" class="muted text-xs">No custom playlists created yet.</div>
                                </div>
                            </div>
                        </div>

                        <!-- Right column: the conditional, ordered published-URL list, GROUPED into one card per
                             playlist. Global card first (only when Global is checked), then one card per checked
                             Custom playlist. Each card's header carries the playlist name + a kind badge so the
                             name is the grouping cue; its two compact rows ("M3U" / "EPG / Guide") share that
                             header instead of repeating the name. Only meaningful once the user row exists (a
                             brand-new user has no slug/streamToken yet). -->
                        <div class="drawer-col">
                            <template v-if="editingUser">
                                <label class="section-label">Published URLs</label>
                                <!-- Shared cards + copy + confirmation modal. Stack layout reproduces the
                                     drawer's vertical column; membership updates live as the access boxes
                                     toggle (publishedUrls is driven by the live form refs). -->
                                <PublishedUrlGroups :groups="publishedUrls" layout="stack" />
                                <div v-if="publishedUrls.length === 0" class="muted text-xs new-user-hint">
                                    No playlists selected — check Global or a custom playlist to publish its M3U and EPG URLs.
                                </div>
                            </template>
                            <div v-else class="muted text-xs new-user-hint">
                                Save this user to generate its published M3U URL and stream token.
                            </div>
                        </div>
                    </div>
                </div>

                <footer class="drawer-ft">
                    <Btn variant="ghost" @click="drawerOpen = false">Cancel</Btn>
                    <Btn variant="primary" @click="saveUser">Save Changes</Btn>
                </footer>
            </div>
        </div>

    </div>
</template>

<style scoped>
.users-screen {
    width: 100%;
}
.header-card {
    padding: 16px var(--pad-card);
}
.title-text {
    font-weight: 600;
    font-size: 15px;
}
.text-xs {
    font-size: 11px;
}
.align-center {
    display: flex;
    align-items: center;
}
.justify-end {
    display: flex;
    justify-content: flex-end;
}
.avatar-sm {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent-hi);
    font-weight: 700;
    font-size: 10px;
    display: grid;
    place-items: center;
}
.username-text {
    font-weight: 500;
}
.token-preview {
    font-size: 12px;
    color: var(--text-2);
    letter-spacing: 0.04em;
}
.token-validation {
    border-top: 1px solid var(--hairline);
    padding-top: 14px;
}
.new-user-hint {
    padding: 14px;
    border: 1px dashed var(--hairline);
    border-radius: var(--radius-s);
    background: var(--bg-2);
}
.banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-radius: var(--radius-m);
    font-size: var(--fs-sm);
}
.banner.success {
    background: oklch(0.78 0.16 150 / 0.12);
    border: 1px solid oklch(0.78 0.16 150 / 0.3);
    color: var(--good);
}
.banner.error {
    background: oklch(0.70 0.18 25 / 0.12);
    border: 1px solid oklch(0.70 0.18 25 / 0.3);
    color: var(--bad);
}

/* Drawer overlays */
.drawer-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(2px);
    z-index: 100;
    display: flex;
    justify-content: flex-end;
}
.drawer {
    /* Half-window panel — matches the established half-window drawer convention
       (PlaylistStatusDrawer / ScheduleEditorDrawer: 50vw, min 440px), capped at 96vw. */
    width: 50vw;
    min-width: 440px;
    max-width: 96vw;
    height: 100%;
    background: var(--bg-1);
    border-left: 1px solid var(--hairline-strong);
    box-shadow: -10px 0 40px rgba(0,0,0,0.3);
    display: flex;
    flex-direction: column;
    animation: slide-in .25s cubic-bezier(.1, .8, .1, 1);
}
@keyframes slide-in {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
}
.drawer-hdr {
    padding: 18px var(--pad-card);
    border-bottom: 1px solid var(--hairline);
    display: flex;
    align-items: center;
    justify-content: space-between;
}
.drawer-hdr h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
}
.close-btn {
    border: 0;
    background: transparent;
    font-size: 22px;
    color: var(--text-2);
    cursor: pointer;
}
.close-btn:hover {
    color: var(--text-0);
}
.drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: 20px var(--pad-card);
    display: flex;
    flex-direction: column;
    gap: 18px;
}
.form-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.form-group label {
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-2);
    text-transform: uppercase;
    letter-spacing: 0.04em;
}
.radio-group {
    display: flex;
    align-items: center;
}
.radio-label {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font-size: var(--fs-sm);
}
.checklist-section {
    border-top: 1px solid var(--hairline);
    padding-top: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.section-label {
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-2);
    text-transform: uppercase;
    letter-spacing: 0.04em;
}
.checklist {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 200px;
    overflow-y: auto;
    background: var(--bg-2);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-s);
    padding: 10px;
}
.check-item {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    transition: background .1s;
}
.check-item:hover {
    background: var(--bg-3);
}
.drawer-ft {
    padding: 14px var(--pad-card);
    border-top: 1px solid var(--hairline);
    display: flex;
    justify-content: flex-end;
    gap: 10px;
}
.font-xs {
    font-size: 10.5px;
}
</style>
