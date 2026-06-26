import { ref } from 'vue';
import { bus } from './bus';

// ── Shared, reactive users store ─────────────────────────────────────────────────────────────────────────
// The single source of truth for the app-user list on the client. There is intentionally NO USERS entry in
// src/data.ts bootstrapData() (the admin user list is admin-only and was previously screen-local); this
// module is the shared singleton that closes that gap. Both the admin Users screen and the Playlists-screen
// "Assign access" / "Get access" modals import the SAME `USERS` ref, so a mutation through one surface is
// instantly visible in the other — that bidirectional sync IS the point. Every write also emits
// `tvapp:users-changed`, which (a) lets any non-store consumer react and (b) triggers a debounced background
// fetchUsers() reconcile here so server-derived fields (a recomposed slug, timestamps) catch up.

// The admin User row shape, 1:1 with GET /api/users (the full doc minus passwordHash). Exported so both the
// Users screen and the Phase-2 modals share ONE type.
export interface User {
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

// The complete, valid PUT /api/users/:id body. `username`, `role`, `allowedPlaylists`,
// `allowedCustomPlaylists`, `streamTokenEnabled` are the required identity/role/access fields; `password` is
// OPTIONAL and OMITTED = no change (the server only re-hashes when password is a non-empty string —
// server/src/routes/users.ts). For POST /api/users a non-empty `password` is required.
export interface SaveUserPayload {
    username?: string;
    password?: string;
    role: 'admin' | 'user';
    allowedPlaylists: string[];
    allowedCustomPlaylists: string[];
    streamTokenEnabled: boolean;
}

// The module-scope singleton — imported by every consumer (NOT cloned). Patched in place on each write so all
// consumers update reactively.
export const USERS = ref<User[]>([]);

let loaded = false;
let loadPromise: Promise<void> | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

// Force a refetch of the full list into the singleton (used by the bus reconcile and any "refresh now" path).
export async function fetchUsers(): Promise<void> {
    const res = await fetch('/api/users');
    if (!res.ok) throw new Error(`/api/users failed: ${res.status}`);
    USERS.value = (await res.json()) as User[];
    loaded = true;
}

// Memoized load — fetches /api/users exactly once (idempotent). Subsequent calls resolve immediately against
// the already-populated singleton; a failed load is NOT memoized so a later mount can retry. Use fetchUsers()
// to force a fresh pull.
export function ensureUsers(): Promise<void> {
    if (loaded) return Promise.resolve();
    if (!loadPromise) {
        loadPromise = fetchUsers().catch((err) => {
            loadPromise = null; // allow a retry on failure
            throw err;
        });
    }
    return loadPromise;
}

// Insert-or-replace a user in the singleton by _id (new array identity so the ref re-renders).
function patchUser(user: User): void {
    const idx = USERS.value.findIndex((u) => u._id === user._id);
    if (idx === -1) {
        USERS.value = [...USERS.value, user];
    } else {
        const next = USERS.value.slice();
        next[idx] = user;
        USERS.value = next;
    }
}

function emitChanged(id?: string): void {
    bus.emit('tvapp:users-changed', { id });
}

async function readError(res: Response, fallback: string): Promise<string> {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return data.error || fallback;
}

// Update an existing user. Sends a complete valid PUT body; on success patches the matching USERS entry in
// place (instant reactive update across all consumers) and emits `tvapp:users-changed`. Throws Error(<code>)
// on failure so callers can surface the server's snake_case error.
export async function saveUser(id: string, payload: SaveUserPayload): Promise<User> {
    const res = await fetch(`/api/users/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(await readError(res, 'save_failed'));
    const updated = (await res.json()) as User;
    patchUser(updated);
    emitChanged(id);
    return updated;
}

// Convenience wrapper for the access-only mutation the Phase-2 modals perform: reads the existing user from
// USERS, merges its required identity/role fields (username, role, streamTokenEnabled) with the new access
// arrays, and saves WITHOUT a password (omitted = no change). Throws if the user isn't in the store.
export async function saveUserAccess(
    id: string,
    access: { allowedPlaylists: string[]; allowedCustomPlaylists: string[] },
): Promise<User> {
    const existing = USERS.value.find((u) => u._id === id);
    if (!existing) throw new Error('user_not_found');
    return saveUser(id, {
        username: existing.username,
        role: existing.role,
        streamTokenEnabled: existing.streamTokenEnabled,
        allowedPlaylists: access.allowedPlaylists,
        allowedCustomPlaylists: access.allowedCustomPlaylists,
        // password intentionally omitted — leaves the credential untouched.
    });
}

// Create a user (POST /api/users). `password` is required for create. On success adds the new row to USERS and
// emits the change event.
export async function createUser(payload: SaveUserPayload & { password: string }): Promise<User> {
    const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(await readError(res, 'create_failed'));
    const created = (await res.json()) as User;
    patchUser(created);
    emitChanged(created._id);
    return created;
}

// Delete a user (DELETE /api/users/:id). On success removes the row from USERS and emits the change event.
export async function deleteUser(id: string): Promise<void> {
    const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await readError(res, 'delete_failed'));
    USERS.value = USERS.value.filter((u) => u._id !== id);
    emitChanged(id);
}

// Background reconcile: on any users-changed event, debounce a single fetchUsers() so a burst of mutations
// collapses to one refetch that catches up server-derived fields. fetchUsers() does NOT emit the event, so
// this never loops; the debounce is the self-trigger-loop guard.
bus.on('tvapp:users-changed', () => {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        fetchUsers().catch(() => {});
    }, 150);
});
