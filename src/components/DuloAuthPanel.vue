<script setup lang="ts">
// dulo Live TV authentication panel (Settings).
//
// dulo gates Live TV behind a signed-in Supabase session; the server resolves each stream on demand
// (server/src/sources/adapters/dulo/auth.ts). The user signs in through a server-streamed real browser
// (DuloLoginDrawer) on dulo's own login page — their password goes straight to dulo, never to TVApp2 — and
// the server intercepts the session and stores only the tokens (never a password), refreshing them
// automatically. A paste-the-session textarea remains as a no-stream fallback.
//
// The panel also owns the DOMAIN field: dulo rebrands periodically, so which site all of the above talks to
// is Settings.duloDomain rather than a compile-time const. It saves explicitly (not through the debounced
// settings auto-persist) because a changed domain signs the session out server-side.

import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import StatusDot from './StatusDot.vue';
import DuloLoginDrawer from './DuloLoginDrawer.vue';
import { bus } from '../composables/bus';
import { duloDomain, saveDuloDomain } from '../composables/useSettings';

interface DuloStatus {
  signedIn: boolean;
  status: string;
  deviceActive: boolean;
  deviceBound: boolean;
  deviceName: string | null;
  expiresAt: number | null;
  hasRefreshToken: boolean;
  nextRefreshAt: number | null;
  sharedFamily: boolean;
  refreshBackoffUntil: number | null;
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
const now = ref(Date.now()); // ticks so the token countdown stays live without a refetch
let poll: ReturnType<typeof setInterval> | null = null;

// Browser-handoff pairing (the durable Google/social path).
interface Pairing {
  code: string;
  expiresAt: number;
  callbackUrl: string;
  duloUrl: string;
  bookmarklet: string;
  snippet: string;
}
const pairing = ref<Pairing | null>(null);
const pairFound = ref(false);
const advancedOpen = ref(false);
let pairPoll: ReturnType<typeof setInterval> | null = null;

// ── Domain ────────────────────────────────────────────────────────────────────
// dulo REBRANDS periodically, so the site every dulo hop derives from (catalog, sign-in, stream resolution,
// Supabase key discovery, SSRF apex) is an operator setting rather than a compile-time const. Saving a
// CHANGED domain signs the session out server-side — a captured session belongs to the site it came from —
// so this is an EXPLICIT-save field: never the debounced auto-persist the other settings refs use, which
// would sign the operator out mid-keystroke.
const domainInput = ref(duloDomain.value);
const domainState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
const probing = ref(false);
const detecting = ref(false);
const domainMsg = ref<{ tone: 'good' | 'warn' | 'bad'; text: string } | null>(null);

// Mirror what the server's normalizer does (strip scheme/path/port, lowercase) so "https://Dulo.TV/" does
// not read as a change and arm a pointless sign-out. The server is still the authority — it re-normalizes.
const cleanedInput = computed(() =>
  domainInput.value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, ''),
);
const domainDirty = computed(() => !!cleanedInput.value && cleanedInput.value !== duloDomain.value);
// Settings hydrate asynchronously at app boot; adopt the real value if it lands after this panel mounted.
watch(duloDomain, (v) => {
  if (!domainDirty.value) domainInput.value = v;
});

function resetDomain(): void {
  domainInput.value = duloDomain.value;
  domainMsg.value = null;
  domainState.value = 'idle';
}

// Probe a candidate WITHOUT saving it: does it serve dulo's catalog, and is it a dulo frontend build?
async function testDomain(): Promise<void> {
  probing.value = true;
  domainMsg.value = null;
  error.value = null;
  try {
    const res = await fetch('/api/sources/dulo/domain/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domainInput.value }),
    });
    const b = (await res.json().catch(() => ({}))) as {
      domain?: string; ok?: boolean; channelCount?: number | null; supabaseFound?: boolean; error?: string | null;
    };
    if (!res.ok) {
      domainMsg.value = { tone: 'bad', text: b.error || `HTTP ${res.status}` };
      return;
    }
    if (b.ok) {
      domainMsg.value = {
        tone: b.supabaseFound ? 'good' : 'warn',
        text: `${b.domain} — ${b.channelCount} channels${b.supabaseFound ? ', dulo build confirmed' : ' (no dulo bundle found — double-check this is dulo)'}`,
      };
    } else {
      domainMsg.value = {
        tone: 'bad',
        text: `${b.domain} — catalog unavailable${b.error ? `: ${b.error}` : ''}${b.supabaseFound ? ' (it does look like a dulo build, though)' : ''}`,
      };
    }
  } catch (e) {
    domainMsg.value = { tone: 'bad', text: (e as Error).message };
  } finally {
    probing.value = false;
  }
}

// Ask the server where the old domain redirects to. Only finds a rebrand that left a 301 behind; a hard
// cut-over is undetectable, and we say so rather than pretending.
async function detectDomain(): Promise<void> {
  detecting.value = true;
  domainMsg.value = null;
  error.value = null;
  try {
    const res = await fetch('/api/sources/dulo/domain/detect', { method: 'POST' });
    const b = (await res.json().catch(() => ({}))) as {
      detected?: string | null; from?: string; sameAsCurrent?: boolean; error?: string;
    };
    if (!res.ok) {
      domainMsg.value = { tone: 'bad', text: b.error || `HTTP ${res.status}` };
      return;
    }
    if (b.detected) {
      domainInput.value = b.detected;
      domainMsg.value = b.sameAsCurrent
        ? { tone: 'good', text: `${b.from} redirects to ${b.detected} — already the configured domain.` }
        : { tone: 'warn', text: `${b.from} redirects to ${b.detected}. Test it, then save.` };
    } else {
      domainMsg.value = {
        tone: 'warn',
        text: 'No redirect found — the old domain may simply be dead. Enter the new one manually.',
      };
    }
  } catch (e) {
    domainMsg.value = { tone: 'bad', text: (e as Error).message };
  } finally {
    detecting.value = false;
  }
}

async function saveDomain(): Promise<void> {
  if (!domainDirty.value) return;
  domainState.value = 'saving';
  domainMsg.value = null;
  error.value = null;
  const r = await saveDuloDomain(domainInput.value);
  if (!r.ok) {
    domainState.value = 'error';
    domainMsg.value = { tone: 'bad', text: r.error || 'Save failed' };
    setTimeout(() => (domainState.value = 'idle'), 2200);
    return;
  }
  domainState.value = 'saved';
  domainInput.value = duloDomain.value; // adopt the server's normalized form
  // The server signed the session out as part of the change — re-read it, and tell the Playlists view its
  // dulo row's isAuthenticated flipped (same contract as signOut() below).
  await refresh();
  bus.emit('tvapp:auth-changed', { source: 'dulo' });
  setTimeout(() => (domainState.value = 'idle'), 2200);
}

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
  const diff = ms - now.value;
  // The server's keepalive rotates the token ahead of expiry, so a past-due token means a refresh is
  // imminent (or briefly backing off) — say "refreshing…" rather than alarming "expired".
  if (diff <= 0) return 'refreshing…';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `token valid ~${mins}m`;
  return `token valid ~${Math.round(mins / 60)}h`;
}

// A recent transient refresh failure is backing off — a soft, self-healing state (not a hard re-auth).
const refreshing = computed(() => {
  const u = status.value?.refreshBackoffUntil;
  return !!u && u > now.value;
});
// The server's proactive keepalive: when the next scheduled token rotation lands (null = disarmed).
const nextRefreshLabel = computed(() => {
  const at = status.value?.nextRefreshAt;
  if (!at || at <= now.value) return '';
  const mins = Math.max(1, Math.round((at - now.value) / 60000));
  return mins < 60 ? `auto-refresh in ~${mins}m` : `auto-refresh in ~${Math.round(mins / 60)}h`;
});
// A capture that omitted refresh_token cannot be kept alive — flag it so the user re-captures a full session.
const noRefreshToken = computed(() => !!status.value?.signedIn && status.value?.hasRefreshToken === false);
// dulo is single-active-device: another device can evict our slot (device_mismatch). Offer a one-click
// reclaim when we're signed in but no longer hold the device.
const deviceNeedsReactivate = computed(() => !!status.value?.signedIn && !status.value?.deviceBound);

const pairCountdown = computed(() => {
  if (!pairing.value) return '';
  const s = Math.max(0, Math.round((pairing.value.expiresAt - now.value) / 1000));
  return `code expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
});

// Mint a pairing code + bookmarklet, then poll fast until the user's browser hands the session back.
async function startPairing() {
  error.value = null;
  pairFound.value = false;
  advancedOpen.value = false;
  try {
    const res = await fetch('/api/sources/dulo/auth/pair', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pairing.value = (await res.json()) as Pairing;
  } catch (e) {
    error.value = `Could not start pairing: ${(e as Error).message}`;
    return;
  }
  if (pairPoll) clearInterval(pairPoll);
  pairPoll = setInterval(async () => {
    now.value = Date.now();
    if (pairing.value && now.value > pairing.value.expiresAt) {
      stopPairing();
      error.value = 'Pairing code expired — click “Pair with my browser” for a fresh one.';
      return;
    }
    await refresh();
    if (status.value?.signedIn) {
      pairFound.value = true;
      bus.emit('tvapp:auth-changed', { source: 'dulo' });
      setTimeout(stopPairing, 1400); // let the success state show, then collapse to Connected
    }
  }, 2500);
}
function stopPairing() {
  if (pairPoll) {
    clearInterval(pairPoll);
    pairPoll = null;
  }
  pairing.value = null;
}
async function copyText(t: string) {
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    /* clipboard blocked — the draggable link / visible snippet is the fallback */
  }
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
  // Carry EVERYTHING the blob offers (previously we dropped supabaseUrl/anonKey/device fields, which broke
  // later refresh). The server also derives supabaseUrl from the JWT and falls back to the committed public
  // anon key, so refresh stays durable even when the blob omits them. Send this browser's UA for coherence.
  submit({
    accessToken: sess.access_token,
    refreshToken: sess.refresh_token ?? null,
    expiresAt: sess.expires_at ?? sess.expiresAt ?? null,
    supabaseUrl: sess.supabaseUrl ?? parsed?.supabaseUrl ?? null,
    anonKey: sess.anonKey ?? parsed?.anonKey ?? null,
    deviceFingerprint: sess.deviceFingerprint ?? parsed?.deviceFingerprint ?? null,
    deviceId: sess.deviceId ?? parsed?.deviceId ?? null,
    deviceName: sess.deviceName ?? parsed?.deviceName ?? null,
    userAgent: navigator.userAgent,
  });
}

async function reactivateDevice() {
  busy.value = true;
  error.value = null;
  try {
    const res = await fetch('/api/sources/dulo/reactivate-device', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status.value = (await res.json()) as DuloStatus;
    bus.emit('tvapp:auth-changed', { source: 'dulo' });
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
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
  // Keep the panel live: re-read status + tick the countdown every 30s and whenever the window refocuses,
  // so an auto-refresh / device eviction / re-auth surfaces without a manual reload.
  poll = setInterval(() => {
    now.value = Date.now();
    void refresh();
  }, 30_000);
  window.addEventListener('focus', refresh);
});

onUnmounted(() => {
  if (poll) clearInterval(poll);
  if (pairPoll) clearInterval(pairPoll);
  window.removeEventListener('focus', refresh);
});
</script>

<template>
  <div class="card">
    <div class="row" style="align-items: center; gap: 10px;">
      <Icon name="tv" :size="16" />
      <h3 class="section-title" style="margin: 0;">Dulo.tv Authentication</h3>
      <code class="mono" style="font-size: var(--fs-xs); color: var(--text-2);">{{ duloDomain }}</code>
      <span class="spacer" style="flex: 1;" />
      <StatusDot :status="tone" />
      <span class="muted" style="font-size: var(--fs-xs);">{{ statusLabel }}</span>
    </div>

    <div class="muted" style="font-size: var(--fs-xs); margin: 6px 0 14px;">
      {{ duloDomain }} streams Live TV only to signed-in accounts and mints each stream on demand. Connect a
      dulo account once — TVApp2 stores only the session tokens (never your password) and refreshes them
      automatically.
    </div>

    <!-- Domain. dulo rebrands periodically; every dulo hop (catalog, sign-in, stream resolution, guide
         crosswalk fetches) derives from this one value. Explicit save — changing it signs the session out. -->
    <div class="form-row" style="margin-bottom: 14px;">
      <div class="field-lbl">Domain</div>
      <div class="input mono" style="font-size: 12px;">
        <Icon name="globe" :size="14" />
        <input
          v-model="domainInput"
          placeholder="dulo.tv"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          @keyup.enter="saveDomain"
        />
      </div>
      <div class="row" style="gap: 8px; margin-top: 8px; align-items: center; flex-wrap: wrap;">
        <Btn variant="ghost" size="sm" icon="search" :disabled="detecting || probing" @click="detectDomain">
          {{ detecting ? 'Detecting…' : 'Auto-detect' }}
        </Btn>
        <Btn variant="ghost" size="sm" icon="sync" :disabled="probing || detecting || !domainInput.trim()" @click="testDomain">
          {{ probing ? 'Testing…' : 'Test' }}
        </Btn>
        <Btn
          variant="primary"
          size="sm"
          icon="check"
          :disabled="!domainDirty || domainState === 'saving'"
          @click="saveDomain"
        >
          {{ domainState === 'saving' ? 'Saving…' : status && status.signedIn ? 'Save & sign out' : 'Save domain' }}
        </Btn>
        <Btn v-if="domainDirty" variant="ghost" size="sm" @click="resetDomain">Cancel</Btn>
        <span v-if="domainState === 'saved'" style="color: var(--good); font-size: var(--fs-xs);">Saved</span>
      </div>

      <!-- Changing the domain is a provider change: the stored session belongs to the old site. -->
      <div
        v-if="domainDirty && status && status.signedIn"
        class="row"
        style="gap: 8px; margin-top: 8px; padding: 8px 10px; background: var(--bg-2); border-radius: 8px; align-items: flex-start;"
      >
        <span style="color: var(--warn, var(--text-2)); margin-top: 1px;"><Icon name="warn" :size="13" /></span>
        <span style="font-size: var(--fs-xs); color: var(--text-1);">
          Saving a new domain signs the current dulo session out — you'll need to pair again.
        </span>
      </div>

      <div
        v-if="domainMsg"
        style="font-size: var(--fs-xs); margin-top: 8px;"
        :style="{ color: domainMsg.tone === 'good' ? 'var(--good)' : domainMsg.tone === 'bad' ? 'var(--bad)' : 'var(--warn, var(--text-2))' }"
      >
        {{ domainMsg.text }}
      </div>
      <div v-else class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
        The site dulo runs on today. Everything dulo-facing derives from it — catalog, sign-in, and stream
        resolution. <b>Test</b> checks a domain without saving it.
      </div>
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
        <span v-if="noRefreshToken" style="font-size: var(--fs-xs); color: var(--warn, var(--text-2));">· no refresh token — re-capture the session (it ends at expiry)</span>
        <span v-else-if="nextRefreshLabel" class="muted" style="font-size: var(--fs-xs);">· {{ nextRefreshLabel }}</span>
        <span v-if="refreshing" class="muted" style="font-size: var(--fs-xs); color: var(--warn, var(--text-2));">· reconnecting…</span>
      </div>
      <div v-if="status.blockReason" class="row" style="gap: 8px; padding: 8px 10px; background: var(--bg-2); border-radius: 8px; align-items: flex-start;">
        <span style="color: var(--bad); margin-top: 1px;"><Icon name="x" :size="13" /></span>
        <span style="font-size: var(--fs-xs); color: var(--text-1);">{{ status.blockReason }}</span>
      </div>
      <!-- dulo allows one active Live-TV device; if another device evicted us, reclaim the slot in one click. -->
      <div v-if="deviceNeedsReactivate" class="row" style="gap: 8px; align-items: center; flex-wrap: wrap;">
        <span class="muted" style="font-size: var(--fs-xs);">This device isn't holding the dulo Live&nbsp;TV slot.</span>
        <Btn variant="ghost" size="sm" icon="refresh" :disabled="busy" @click="reactivateDevice">Re-activate device</Btn>
      </div>
      <div class="row" style="gap: 8px;">
        <Btn variant="ghost" icon="refresh" :disabled="busy || !!pairing" @click="startPairing">Re-authenticate</Btn>
        <Btn variant="ghost" icon="trash" :disabled="busy" @click="signOut"><span style="color: var(--bad);">Sign out</span></Btn>
      </div>
    </div>

    <!-- Connect flow -->
    <div v-else class="col" style="gap: 12px;">
      <div class="muted" style="font-size: var(--fs-sm); color: var(--text-1); line-height: 1.6;">
        Sign in with <b>your own browser</b> — where Google &amp; Discord work normally — then hand the session
        back with one click. This is the most reliable way to connect a social account. Afterwards simply
        <b>close the dulo tab — don't sign out</b>: signing out of {{ duloDomain }} revokes the session you
        just handed over. The server keeps it refreshed automatically from then on.
      </div>

      <div class="row" style="gap: 8px; flex-wrap: wrap; align-items: center;">
        <Btn variant="primary" icon="globe" :disabled="busy || !!pairing" @click="startPairing">Pair with my browser</Btn>
        <Btn variant="ghost" size="sm" @click="pasteOpen = !pasteOpen">
          {{ pasteOpen ? 'Hide manual paste' : 'Paste session' }}
        </Btn>
      </div>

      <div v-if="pasteOpen" class="col" style="gap: 8px;">
        <div class="muted" style="font-size: var(--fs-xs);">
          Manual alternative: sign in on {{ duloDomain }} in your own browser, then open DevTools → Application → Local
          Storage → copy the value of the key starting with <code class="mono">amri-</code> (any key whose value
          contains <code class="mono">access_token</code>) and paste it here. Best captured from a
          <b>private/incognito window</b>; when done, <b>close the window without signing out</b> — signing out
          of {{ duloDomain }} revokes the pasted session. Once pasted, the server keeps the session alive automatically.
        </div>
        <textarea v-model="pasteText" rows="4" placeholder='{"access_token":"…","refresh_token":"…","expires_at":…}'
                  class="input mono" style="width: 100%; font-size: 11px; padding: 8px; resize: vertical;" />
        <div class="row"><Btn variant="primary" icon="check" :disabled="busy || !pasteText" @click="submitPaste">Connect with pasted session</Btn></div>
      </div>

      <!-- Advanced: the server-streamed browser, demoted (Google usually blocks it; kept for email/other logins). -->
      <div class="col" style="gap: 8px; border-top: 1px solid var(--border, var(--bg-2)); padding-top: 10px;">
        <button class="linklike muted" style="font-size: var(--fs-xs); background: none; border: none; padding: 0; cursor: pointer; text-align: left;" @click="advancedOpen = !advancedOpen">
          {{ advancedOpen ? '▾' : '▸' }} Advanced: streamed sign-in
        </button>
        <div v-if="advancedOpen" class="col" style="gap: 8px;">
          <div class="muted" style="font-size: var(--fs-xs);">
            Runs a browser on the server and screencasts it here. Google typically blocks automated browsers, so
            prefer <b>Pair with my browser</b> above — this is kept for email or other providers.
          </div>
          <div class="row"><Btn variant="ghost" size="sm" icon="globe" :disabled="busy" @click="loginOpen = true">Use streamed sign-in</Btn></div>
        </div>
      </div>
    </div>

    <!-- Shared pairing panel — visible in both connected (re-auth) and not-connected states. -->
    <div v-if="pairing" class="col" style="gap: 10px; margin-top: 12px; padding: 12px; background: var(--bg-2); border-radius: 10px;">
      <div class="row" style="align-items: center; gap: 8px;">
        <StatusDot :status="pairFound ? 'good' : 'idle'" :pulse="!pairFound" />
        <b style="font-size: var(--fs-sm);">{{ pairFound ? 'Connected!' : 'Waiting for your browser…' }}</b>
        <span class="spacer" style="flex: 1;" />
        <span v-if="!pairFound" class="muted" style="font-size: var(--fs-xs);">{{ pairCountdown }}</span>
        <Btn variant="ghost" size="sm" icon="x" @click="stopPairing" />
      </div>
      <ol v-if="!pairFound" style="margin: 0; padding-left: 18px; font-size: var(--fs-sm); color: var(--text-1); line-height: 1.8;">
        <li>
          Drag this to your bookmarks bar:
          <a :href="pairing.bookmarklet" class="mono" draggable="true" style="color: var(--accent, var(--text-0)); text-decoration: underline; cursor: grab;" @click.prevent>↧ Connect dulo → masqueradarr</a>
          <Btn variant="ghost" size="sm" @click="copyText(pairing.bookmarklet)">copy</Btn>
        </li>
        <li><a :href="pairing.duloUrl" target="_blank" rel="noopener" style="color: var(--accent, var(--text-0));">Open {{ duloDomain }}</a> and sign in (Google / Discord work in your own browser).</li>
        <li>
          On {{ duloDomain }}, click that bookmark.
          <span class="muted">No bookmarks bar?</span>
          <Btn variant="ghost" size="sm" @click="copyText(pairing.snippet)">Copy console snippet</Btn>
          <span class="muted">and paste it into DevTools → Console.</span>
        </li>
      </ol>
    </div>

    <div v-if="error" class="row" style="gap: 8px; margin-top: 10px; padding: 8px 10px; background: var(--bg-2); border-radius: 8px; align-items: flex-start;">
      <span style="color: var(--bad); margin-top: 1px;"><Icon name="x" :size="13" /></span>
      <span style="font-size: var(--fs-xs); color: var(--text-1);">{{ error }}</span>
    </div>

    <DuloLoginDrawer v-if="loginOpen" @close="loginOpen = false" @captured="onCaptured" />
  </div>
</template>
