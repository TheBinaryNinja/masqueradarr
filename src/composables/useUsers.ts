import { ref } from 'vue';
import { bus } from './bus';


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

export interface SaveUserPayload {
    username?: string;
    password?: string;
    role: 'admin' | 'user';
    allowedPlaylists: string[];
    allowedCustomPlaylists: string[];
    streamTokenEnabled: boolean;
}

export const USERS = ref<User[]>([]);

let loaded = false;
let loadPromise: Promise<void> | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

export async function fetchUsers(): Promise<void> {
    const res = await fetch('/api/users');
    if (!res.ok) throw new Error(`/api/users failed: ${res.status}`);
    USERS.value = (await res.json()) as User[];
    loaded = true;
}

export function ensureUsers(): Promise<void> {
    if (loaded) return Promise.resolve();
    if (!loadPromise) {
        loadPromise = fetchUsers().catch((err) => {
            loadPromise = null;
            throw err;
        });
    }
    return loadPromise;
}

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
    });
}

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

export async function deleteUser(id: string): Promise<void> {
    const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await readError(res, 'delete_failed'));
    USERS.value = USERS.value.filter((u) => u._id !== id);
    emitChanged(id);
}

bus.on('tvapp:users-changed', () => {
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        fetchUsers().catch(() => {});
    }, 150);
});
