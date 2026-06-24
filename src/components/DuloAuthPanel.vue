<script setup lang="ts">
// dulo Live TV authentication panel (Settings).
//
// dulo.tv gates Live TV behind a signed-in Supabase session; the server resolves each stream on demand
// (server/src/sources/adapters/dulo/auth.ts). The user signs in through a server-streamed real browser
// (DuloLoginDrawer) on dulo's own login page — their password goes straight to dulo, never to TVApp2 — and
// the server intercepts the session and stores only the tokens (never a password), refreshing them
// automatically. A paste-the-session textarea remains as a no-stream fallback.

import { ref, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import StatusDot from './StatusDot.vue';
import DuloLoginDrawer from './DuloLoginDrawer.vue';
import { bus } from '../composables/bus';

interface DuloStatus {
  signedIn: boolean;
  status: string;
  deviceActive: boolean;
  deviceName: string | null;
  expiresAt: number | null;
  blockReason: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

const status = ref<DuloStatus | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const loginOpen = ref(false);
const pasteOpen = ref(false);
const pasteText = ref('');

const tone = computed(() => {
  const s = status.value?.status;
  if (s === 'active') return 'good';
  if (s === 'reauth_required') return 'warn';
  if (s === 'blocked' || s === 'error') return 'bad';
  return 'idle';
});

const statusLabel = computed(() => {
  const s = status.value;
  if (!s || !s.signedIn) return 'Not connected';
  if (s.status === 'active') return 'Connected';
  if (s.status === 'reauth_required') return 'Re-authentication needed';
  if (s.status === 'blocked') return 'Blocked';
  if (s.status === 'error') return 'Error';
  return s.status;
});

function fmtExpiry(ms: number | null): string {
  if (!ms) return '';
  const diff = ms - Date.now();
  if (diff <= 0) return 'token expired';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `token valid ~${mins}m`;
  return `token valid ~${Math.round(mins / 60)}h`;
}

async function refresh() {
  try {
    const res = await fetch('/api/sources/dulo/status');
    if (!res.ok) throw new Error(`status ${res.status}`);
    status.value = (await res.json()) as DuloStatus;
  } catch {
    // status endpoint always exists; a failure here is a transient network issue — don't surface loudly.
    status.value = null;
  }
}

// The streamed-login drawer captures the session server-side; on success it emits 'captured' and we just
// re-read the status. The paste fallback POSTs the tokens directly.
async function onCaptured() {
  loginOpen.value = false;
  await refresh();
  // Tell the Playlists view its dulo row's isAuthenticated may have flipped (server wrote it on capture).
  bus.emit('tvapp:auth-changed', { source: 'dulo' });
}

async function submit(payload: Record<string, unknown>) {
  busy.value = true;
  error.value = null;
  try {
    const res = await fetch('/api/sources/dulo/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    status.value = (await res.json()) as DuloStatus;
    pasteOpen.value = false;
    pasteText.value = '';
    bus.emit('tvapp:auth-changed', { source: 'dulo' });
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function submitPaste() {
  error.value = null;
  let parsed: any;
  try {
    parsed = JSON.parse(pasteText.value.trim());
  } catch {
    error.value = 'Paste the dulo session JSON value (it must be valid JSON).';
    return;
  }
  const sess = parsed?.currentSession ?? parsed?.session ?? parsed;
  if (!sess?.access_token) {
    error.value = 'No access_token found in the pasted session.';
    return;
  }
  submit({
    accessToken: sess.access_token,
    refreshToken: sess.refresh_token ?? null,
    expiresAt: sess.expires_at ?? null,
  });
}

async function signOut() {
  busy.value = true;
  try {
    await fetch('/api/sources/dulo/auth', { method: 'DELETE' });
    await refresh();
    bus.emit('tvapp:auth-changed', { source: 'dulo' });
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  refresh();
});
</script>

<template>
  <div class="card">
    <div class="row" style="align-items: center; gap: 10px;">
      <Icon name="tv" :size="16" />
      <h3 class="section-title" style="margin: 0;">Dulo.tv Authentication</h3>
      <span class="spacer" style="flex: 1;" />
      <StatusDot :status="tone" />
      <span class="muted" style="font-size: var(--fs-xs);">{{ statusLabel }}</span>
    </div>

    <div class="muted" style="font-size: var(--fs-xs); margin: 6px 0 14px;">
      dulo.tv now streams Live TV only to signed-in accounts and mints each stream on demand. Connect a
      dulo account once — TVApp2 stores only the session tokens (never your password) and refreshes them
      automatically.
    </div>

    <!-- Connected state -->
    <div v-if="status && status.signedIn" class="col" style="gap: 10px;">
      <div class="row" style="gap: 8px; align-items: center; flex-wrap: wrap;">
        <Pill :tone="tone">
          <Icon :name="tone === 'good' ? 'check' : 'refresh'" :size="10" />{{ statusLabel }}
        </Pill>
        <span v-if="status.deviceName" class="muted" style="font-size: var(--fs-xs);">
          device: <b style="color: var(--text-1);">{{ status.deviceName }}</b>
        </span>
        <span v-if="status.expiresAt" class="muted" style="font-size: var(--fs-xs);">· {{ fmtExpiry(status.expiresAt) }}</span>
      </div>
      <div v-if="status.blockReason" class="row" style="gap: 8px; padding: 8px 10px; background: var(--bg-2); border-radius: 8px; align-items: flex-start;">
        <span style="color: var(--bad); margin-top: 1px;"><Icon name="x" :size="13" /></span>
        <span style="font-size: var(--fs-xs); color: var(--text-1);">{{ status.blockReason }}</span>
      </div>
      <div class="row" style="gap: 8px;">
        <Btn variant="ghost" icon="refresh" :disabled="busy" @click="loginOpen = true">Re-authenticate</Btn>
        <Btn variant="ghost" icon="trash" :disabled="busy" @click="signOut"><span style="color: var(--bad);">Sign out</span></Btn>
      </div>
    </div>

    <!-- Connect flow -->
    <div v-else class="col" style="gap: 12px;">
      <ol style="margin: 0; padding-left: 18px; font-size: var(--fs-sm); color: var(--text-1); line-height: 1.7;">
        <li>Click <b>Sign in to dulo</b> — a secure browser opens right here on dulo.tv's login page.</li>
        <li>Sign in with your dulo account (email or a social provider). Your password goes only to dulo.</li>
        <li>TVApp2 captures the session automatically and connects — only tokens are stored, never a password.</li>
      </ol>

      <div class="row" style="gap: 8px; flex-wrap: wrap; align-items: center;">
        <Btn variant="primary" icon="globe" :disabled="busy" @click="loginOpen = true">Sign in to dulo</Btn>
        <Btn variant="ghost" size="sm" @click="pasteOpen = !pasteOpen">
          {{ pasteOpen ? 'Hide manual paste' : 'Paste session' }}
        </Btn>
      </div>

      <div v-if="pasteOpen" class="col" style="gap: 8px;">
        <div class="muted" style="font-size: var(--fs-xs);">
          Fallback (use this if Google won't sign you in inside the streamed browser): sign in on dulo.tv in
          your own browser, then open DevTools → Application → Local Storage → copy the value of the key
          starting with <code class="mono">amri-</code> (any key whose value contains
          <code class="mono">access_token</code>) and paste it here.
        </div>
        <textarea v-model="pasteText" rows="4" placeholder='{"access_token":"…","refresh_token":"…","expires_at":…}'
                  class="input mono" style="width: 100%; font-size: 11px; padding: 8px; resize: vertical;" />
        <div class="row"><Btn variant="primary" icon="check" :disabled="busy || !pasteText" @click="submitPaste">Connect with pasted session</Btn></div>
      </div>
    </div>

    <div v-if="error" class="row" style="gap: 8px; margin-top: 10px; padding: 8px 10px; background: var(--bg-2); border-radius: 8px; align-items: flex-start;">
      <span style="color: var(--bad); margin-top: 1px;"><Icon name="x" :size="13" /></span>
      <span style="font-size: var(--fs-xs); color: var(--text-1);">{{ error }}</span>
    </div>

    <DuloLoginDrawer v-if="loginOpen" @close="loginOpen = false" @captured="onCaptured" />
  </div>
</template>
