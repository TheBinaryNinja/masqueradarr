import { ref, computed } from 'vue';
import { domain } from './useSettings';

export interface UserProfile {
    username: string;
    role: 'admin' | 'user';
    streamToken: string;
    streamTokenEnabled: boolean;
    // Stable slug naming this user's per-user playlist file (served FLAT at <domain>/<username>-<slug>.m3u).
    slug: string;
    allowedPlaylists: string[];
    allowedCustomPlaylists: string[];
}

export const currentUser = ref<UserProfile | null>(null);
export const token = ref<string | null>(localStorage.getItem('auth_token'));
export const needsSetup = ref<boolean | null>(null);

export const isAdmin = computed(() => currentUser.value?.role === 'admin');
export const isAuthenticated = computed(() => !!currentUser.value);

// Per-user Global playlist file URL — served FLAT at the operator domain root as
// <domain>/<username>-<slug>.m3u. The download URL is token-free (the random slug is the unguessable
// bearer); the user's streamToken is baked into the channel URLs INSIDE the file, not into this URL.
// <domain> is the configured operator domain from useSettings (same source PlaylistStatusDrawer uses as
// baseDomain). Accepts the minimal { username, slug } so it serves both UserProfile and the admin User.
export function userM3uUrl(user: { username: string; slug: string }): string {
    const baseDomain = domain.value.replace(/\/+$/, '');
    return `${baseDomain}/${user.username}-${user.slug}.m3u`;
}

export async function checkSetup(): Promise<boolean> {
    try {
        const res = await fetch('/api/auth/setup-status');
        if (!res.ok) throw new Error();
        const data = await res.json() as { needsSetup: boolean };
        needsSetup.value = data.needsSetup;
        return data.needsSetup;
    } catch {
        needsSetup.value = false;
        return false;
    }
}

export async function fetchMe(): Promise<boolean> {
    const activeToken = token.value;
    if (!activeToken) {
        currentUser.value = null;
        return false;
    }
    try {
        const res = await fetch('/api/auth/me');
        if (res.status === 401) {
            logoutLocal();
            return false;
        }
        if (!res.ok) throw new Error();
        currentUser.value = await res.json() as UserProfile;
        return true;
    } catch {
        return false;
    }
}

export async function login(username: string, password: string): Promise<{ success: boolean; error?: string }> {
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        const data = await res.json() as { token?: string; error?: string };
        if (!res.ok || !data.token) {
            return { success: false, error: data.error || 'Login failed' };
        }
        token.value = data.token;
        localStorage.setItem('auth_token', data.token);
        await fetchMe();
        return { success: true };
    } catch (err) {
        return { success: false, error: 'Network error occurred' };
    }
}

export async function setupAdmin(username: string, password: string): Promise<{ success: boolean; error?: string }> {
    try {
        const res = await fetch('/api/auth/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        const data = await res.json() as { token?: string; error?: string };
        if (!res.ok || !data.token) {
            return { success: false, error: data.error || 'Setup failed' };
        }
        token.value = data.token;
        localStorage.setItem('auth_token', data.token);
        needsSetup.value = false;
        await fetchMe();
        return { success: true };
    } catch (err) {
        return { success: false, error: 'Network error occurred' };
    }
}

export async function logout(): Promise<void> {
    const activeToken = token.value;
    if (activeToken) {
        try {
            await fetch('/api/auth/logout', { method: 'POST' });
        } catch {
            // ignore
        }
    }
    logoutLocal();
}

function logoutLocal() {
    token.value = null;
    currentUser.value = null;
    localStorage.removeItem('auth_token');
}

export async function regenerateStreamToken(): Promise<boolean> {
    const activeToken = token.value;
    if (!activeToken) return false;
    try {
        const res = await fetch('/api/auth/regenerate-token', { method: 'POST' });
        if (!res.ok) throw new Error();
        const data = await res.json() as { streamToken: string };
        if (currentUser.value) {
            currentUser.value.streamToken = data.streamToken;
        }
        return true;
    } catch {
        return false;
    }
}
