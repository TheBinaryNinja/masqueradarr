<script setup lang="ts">
// ZLive panel (Settings → Advanced).
//
// Three things an operator needs for the zlive built-in (server/src/sources/adapters/zlive.ts):
//   · the DOMAIN its public catalog (cast.<domain>) and stream resolver (iptv.<domain>) live under — an explicit-
//     save field, like dulo's, because a changed domain retargets the live adapter and resets its resolver cache;
//     Test checks a candidate's CATALOG only (the server never spends a resolver request on a settings probe);
//   · the STREAM CAP — how many distinct zlive channels may play at once (0 = unlimited);
//   · a live readout of the resolver (GET /api/sources/zlive/status): cap usage, the upstream host, and — the reason
//     this exists — a suspected leech-list DECOY or a refusal (and the back-off during which nothing contacts zlive),
//     which the server detects and surfaces but never tries to route around.

import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import StatusDot from './StatusDot.vue';
import SettingsRow from './SettingsRow.vue';
import { zliveDomain, zliveMaxStreams, saveZliveDomain } from '../composables/useSettings';

type ZliveErrorClass = 'refusal-403' | 'dns-connect' | 'decoy' | 'shape';

interface ZliveStatus {
  domain: string;
  catalogUrl: string;
  resolverBase: string;
  maxStreams: number;
  streamCap: { cap: number; live: string[]; refusals: number; lastRefusal: { at: number; entry: string } | null };
  resolver: {
    cacheSize: number;
    lastLocationHost: string | null;
    lastLifetimeMs: number | null;
    decoyLatches: Array<{ file: string; since: number; until: number; slugs: string[] }>;
    /** Active only: the resolver refused this server, so no channel contacts zlive until `until`. */
    coolDown: { since: number; until: number; step: number; httpStatus: number; retryAfterMs: number | null } | null;
    negative: Array<{ slug: string; until: number; errorClass: ZliveErrorClass }>;
    lastError: { errorClass: ZliveErrorClass; message: string; slug: string; at: number; httpStatus: number | null } | null;
    lastOkAt: number | null;
    counts: { minted: number; reused: number; failed: number; suppressed: number; retired: number };
  };
}

const MAX_STREAMS_LIMIT = 100; // mirrors the server validator (settings/translate.ts)

const status = ref<ZliveStatus | null>(null);
const now = ref(Date.now());
let poll: ReturnType<typeof setInterval> | null = null;

// ── Domain ────────────────────────────────────────────────────────────────────
const domainInput = ref(zliveDomain.value);
const domainState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
const probing = ref(false);
const domainMsg = ref<{ tone: 'good' | 'warn' | 'bad'; text: string } | null>(null);

// Mirror the server normalizer (strip scheme/path/port, lowercase) so "https://ZLive.st/" does not read as a change.
// The server stays the authority — it re-normalizes and validates on save.
const cleanedInput = computed(() =>
  domainInput.value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, ''),
);
const domainDirty = computed(() => !!cleanedInput.value && cleanedInput.value !== zliveDomain.value);
// Settings hydrate asynchronously at app boot; adopt the real value if it lands after this panel mounted.
watch(zliveDomain, (v) => {
  if (!domainDirty.value) domainInput.value = v;
});

function resetDomain(): void {
  domainInput.value = zliveDomain.value;
  domainMsg.value = null;
  domainState.value = 'idle';
}

// Probe a candidate WITHOUT saving it: does it serve zlive's channel catalog? (One catalog GET, nothing else.)
async function testDomain(): Promise<void> {
  probing.value = true;
  domainMsg.value = null;
  try {
    const res = await fetch('/api/sources/zlive/domain/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domainInput.value }),
    });
    const b = (await res.json().catch(() => ({}))) as {
      domain?: string; ok?: boolean; channelCount?: number | null; redirectTo?: string | null; error?: string | null;
    };
    if (!res.ok) {
      domainMsg.value = { tone: 'bad', text: b.error || `HTTP ${res.status}` };
      return;
    }
    if (b.ok) {
      domainMsg.value = { tone: 'good', text: `${b.domain} — catalog lists ${b.channelCount} channels` };
    } else if (b.redirectTo) {
      domainMsg.value = { tone: 'warn', text: `${b.domain} — ${b.error}. If zlive moved, test that domain instead.` };
    } else {
      domainMsg.value = { tone: 'bad', text: `${b.domain} — catalog unavailable${b.error ? `: ${b.error}` : ''}` };
    }
  } catch (e) {
    domainMsg.value = { tone: 'bad', text: (e as Error).message };
  } finally {
    probing.value = false;
  }
}

async function saveDomain(): Promise<void> {
  if (!domainDirty.value) return;
  domainState.value = 'saving';
  domainMsg.value = null;
  const r = await saveZliveDomain(domainInput.value);
  if (!r.ok) {
    domainState.value = 'error';
    domainMsg.value = { tone: 'bad', text: r.error || 'Save failed' };
    setTimeout(() => (domainState.value = 'idle'), 2200);
    return;
  }
  domainState.value = 'saved';
  domainInput.value = zliveDomain.value; // adopt the server's normalized form
  domainMsg.value = { tone: 'good', text: 'Saved — sync the ZLive playlist to refresh its channel list from the new domain.' };
  await refresh();
  setTimeout(() => (domainState.value = 'idle'), 2200);
}

// ── Stream cap ────────────────────────────────────────────────────────────────
// Typed into a local string and committed on blur/Enter as a clamped whole number; the shared ref's watcher
// (useSettings.ts) persists it, so a half-typed value never reaches the server.
const capInput = ref(String(zliveMaxStreams.value));
watch(zliveMaxStreams, (v) => {
  capInput.value = String(v);
});
function commitCap(): void {
  const n = Math.trunc(Number(capInput.value));
  if (!Number.isFinite(n) || capInput.value.trim() === '') {
    capInput.value = String(zliveMaxStreams.value);
    return;
  }
  const clamped = Math.min(MAX_STREAMS_LIMIT, Math.max(0, n));
  capInput.value = String(clamped);
  if (clamped !== zliveMaxStreams.value) zliveMaxStreams.value = clamped;
}

// ── Resolver status ───────────────────────────────────────────────────────────
async function refresh(): Promise<void> {
  try {
    const res = await fetch('/api/sources/zlive/status');
    if (!res.ok) throw new Error(`status ${res.status}`);
    status.value = (await res.json()) as ZliveStatus;
  } catch {
    status.value = null; // transient — the readout just hides until the next poll
  }
  now.value = Date.now();
}

const latches = computed(() => (status.value?.resolver.decoyLatches ?? []).filter((l) => l.until > now.value));
const coolDown = computed(() => {
  const c = status.value?.resolver.coolDown;
  return c && c.until > now.value ? c : null;
});
// The last error only matters while it is newer than the last success (a later good resolve supersedes it).
const currentError = computed(() => {
  const r = status.value?.resolver;
  if (!r?.lastError) return null;
  return r.lastOkAt && r.lastOkAt > r.lastError.at ? null : r.lastError;
});

const ERROR_LABEL: Record<ZliveErrorClass, string> = {
  'refusal-403': 'Resolver refused the request',
  'dns-connect': 'Resolver unreachable',
  decoy: 'Decoy suspected',
  shape: 'Unexpected resolver answer',
};

const tone = computed(() => {
  if (!status.value) return 'idle';
  if (latches.value.length || coolDown.value) return 'bad';
  if (currentError.value) return 'warn';
  return status.value.resolver.lastOkAt ? 'good' : 'idle';
});
const toneLabel = computed(() => {
  if (!status.value) return '';
  if (latches.value.length) return 'Decoy suspected';
  if (coolDown.value) return 'Resolver refused — backing off';
  if (currentError.value) return ERROR_LABEL[currentError.value.errorClass];
  return status.value.resolver.lastOkAt ? 'Resolving normally' : 'No streams resolved yet';
});

const capUsage = computed(() => {
  const c = status.value?.streamCap;
  if (!c) return '';
  return c.cap > 0 ? `${c.live.length} of ${c.cap}` : `${c.live.length} (no cap)`;
});

function ago(ms: number): string {
  const s = Math.max(0, Math.round((now.value - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}
function until(ms: number): string {
  const m = Math.max(1, Math.round((ms - now.value) / 60_000));
  return `${m}m`;
}

onMounted(() => {
  void refresh();
  poll = setInterval(() => void refresh(), 30_000);
  window.addEventListener('focus', refresh);
});
onUnmounted(() => {
  if (poll) clearInterval(poll);
  window.removeEventListener('focus', refresh);
});
</script>

<template>
  <div class="card">
    <div class="row" style="align-items: center; gap: 10px;">
      <Icon name="tv" :size="16" />
      <h3 class="section-title" style="margin: 0;">ZLive</h3>
      <code class="mono" style="font-size: var(--fs-xs); color: var(--text-2);">{{ zliveDomain }}</code>
      <span class="spacer" style="flex: 1;" />
      <template v-if="status">
        <StatusDot :status="tone" />
        <span class="muted" style="font-size: var(--fs-xs);">{{ toneLabel }}</span>
      </template>
    </div>

    <div class="muted" style="font-size: var(--fs-xs); margin: 6px 0 14px; line-height: 1.6;">
      zlive watches how many different streams each address pulls, and answers addresses on its leech list with a
      decoy stream. So ZLive channels always play through the local origin (one upstream connection per channel,
      however many people watch), are never checked in bulk by the channel probe, and are capped below. A decoy
      answer is detected and shown here — it is not worked around.
    </div>

    <!-- Domain. zlive's catalog and stream resolver both derive from it. Explicit save. -->
    <div class="form-row" style="margin-bottom: 14px;">
      <div class="field-lbl">Domain</div>
      <div class="input mono" style="font-size: 12px;">
        <Icon name="globe" :size="14" />
        <input
          v-model="domainInput"
          aria-label="ZLive domain"
          placeholder="zlive.st"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          @keyup.enter="saveDomain"
        />
      </div>
      <div class="row" style="gap: 8px; margin-top: 8px; align-items: center; flex-wrap: wrap;">
        <Btn variant="ghost" size="sm" icon="sync" :disabled="probing || !domainInput.trim()" @click="testDomain">
          {{ probing ? 'Testing…' : 'Test' }}
        </Btn>
        <Btn
          variant="primary"
          size="sm"
          icon="check"
          :disabled="!domainDirty || domainState === 'saving'"
          @click="saveDomain"
        >
          {{ domainState === 'saving' ? 'Saving…' : 'Save domain' }}
        </Btn>
        <Btn v-if="domainDirty" variant="ghost" size="sm" @click="resetDomain">Cancel</Btn>
      </div>
      <!-- The Test / Save result. The live region stays mounted (empty when there is no message) so a screen
           reader already knows it when the text lands, and announces the result; the static hint sits outside it
           so it is not re-read on every change. -->
      <div
        role="status"
        aria-live="polite"
        style="font-size: var(--fs-xs);"
        :style="domainMsg
          ? { marginTop: '8px', color: domainMsg.tone === 'good' ? 'var(--good)' : domainMsg.tone === 'bad' ? 'var(--bad)' : 'var(--warn, var(--text-2))' }
          : undefined"
      >
        <template v-if="domainMsg">{{ domainMsg.text }}</template>
      </div>
      <div v-if="!domainMsg" class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
        The site zlive runs on. Its channel list is read from <code class="mono">cast.{{ zliveDomain }}</code> and
        streams from <code class="mono">iptv.{{ zliveDomain }}</code>. <b>Test</b> reads a domain's channel list
        without saving it.
      </div>
    </div>

    <SettingsRow
      label="Concurrent channels"
      hint="How many different ZLive channels may play at the same time. Several people watching one channel count once. A new channel over the limit is refused until one stops. 0 = no limit."
    >
      <template #right>
        <div class="input" style="width: 84px;">
          <input
            type="number"
            aria-label="Concurrent ZLive channels"
            min="0"
            :max="MAX_STREAMS_LIMIT"
            :value="capInput"
            @input="capInput = ($event.target as HTMLInputElement).value"
            @blur="commitCap"
            @keyup.enter="commitCap"
          />
        </div>
      </template>
    </SettingsRow>

    <!-- Live resolver readout -->
    <div
      v-if="status"
      class="col"
      style="gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border, var(--bg-2));"
    >
      <div class="row" style="gap: 14px; flex-wrap: wrap; align-items: center; font-size: var(--fs-xs);">
        <span class="muted">Playing now: <b style="color: var(--text-1);">{{ capUsage }}</b></span>
        <span v-if="status.streamCap.refusals" class="muted">
          Refused at the limit: <b style="color: var(--text-1);">{{ status.streamCap.refusals }}</b>
        </span>
        <span v-if="status.resolver.lastLocationHost" class="muted">
          Upstream: <code class="mono" style="color: var(--text-1);">{{ status.resolver.lastLocationHost }}</code>
        </span>
        <span class="muted">Reused links: <b style="color: var(--text-1);">{{ status.resolver.cacheSize }}</b></span>
        <span
          v-if="status.resolver.counts.suppressed"
          class="muted"
          title="Resolves answered here without contacting zlive — during a refusal back-off, a decoy latch, or shortly after a channel's last attempt failed"
        >
          Retries held back: <b style="color: var(--text-1);">{{ status.resolver.counts.suppressed }}</b>
        </span>
        <span class="spacer" style="flex: 1;" />
        <Btn variant="ghost" size="sm" icon="refresh" @click="refresh">Refresh</Btn>
      </div>

      <div
        v-for="l in latches"
        :key="l.file"
        class="row"
        style="gap: 8px; padding: 8px 10px; background: var(--bg-2); border-radius: 8px; align-items: flex-start;"
      >
        <span style="color: var(--bad); margin-top: 1px;"><Icon name="warn" :size="13" /></span>
        <span style="font-size: var(--fs-xs); color: var(--text-1); line-height: 1.6;">
          zlive answered the same stream (<code class="mono">{{ l.file }}</code>) for {{ l.slugs.length }} different
          channels — {{ l.slugs.join(', ') }}. That is what zlive serves to addresses on its leech list, so these
          channels are not being requested from zlive for the next {{ until(l.until) }}.
        </span>
      </div>

      <div
        v-if="coolDown"
        class="row"
        style="gap: 8px; padding: 8px 10px; background: var(--bg-2); border-radius: 8px; align-items: flex-start;"
      >
        <span style="color: var(--bad); margin-top: 1px;"><Icon name="warn" :size="13" /></span>
        <span style="font-size: var(--fs-xs); color: var(--text-1); line-height: 1.6;">
          zlive's resolver refused this server (HTTP {{ coolDown.httpStatus
          }}{{ coolDown.step > 1 ? `, ${coolDown.step} times in a row` : '' }}), so no ZLive channel is being requested
          from it for the next {{ until(coolDown.until) }}. Channels already playing keep the links they have.
        </span>
      </div>

      <div
        v-if="currentError && currentError.errorClass !== 'decoy' && !(coolDown && currentError.errorClass === 'refusal-403')"
        class="row"
        style="gap: 8px; padding: 8px 10px; background: var(--bg-2); border-radius: 8px; align-items: flex-start;"
      >
        <span style="color: var(--warn, var(--text-2)); margin-top: 1px;"><Icon name="warn" :size="13" /></span>
        <span style="font-size: var(--fs-xs); color: var(--text-1); line-height: 1.6;">
          <b>{{ ERROR_LABEL[currentError.errorClass] }}</b> for <code class="mono">{{ currentError.slug }}</code>
          · {{ ago(currentError.at) }}<br />
          <span class="mono muted" style="word-break: break-all;">{{ currentError.message }}</span>
        </span>
      </div>
    </div>
  </div>
</template>
