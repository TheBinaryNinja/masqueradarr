<script setup lang="ts">

import { ref, computed, watch, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import StatusDot from './StatusDot.vue';
import JsonEditor from './JsonEditor.vue';
import {
  playlistConfig,
  savePlaylistConfig,
  testPlaylistConfig,
  type PlaylistConfigTestResult,
} from '../composables/useSettings';

const pretty = (v: unknown): string => JSON.stringify(v, null, 2);

const savedText = computed(() => pretty(playlistConfig.value));
const text = ref(savedText.value);
watch(savedText, (next, prev) => {
  if (text.value === prev) text.value = next;
});

interface ParseState {
  ok: boolean;
  value?: unknown;
  message?: string;
  line: number | null;
  col: number | null;
}

function describeJsonError(src: string, err: Error): ParseState {
  const msg = err.message;
  let line: number | null = null;
  let col: number | null = null;
  const lc = /line (\d+) column (\d+)/i.exec(msg);
  const pos = /position (\d+)/i.exec(msg);
  if (lc) {
    line = Number(lc[1]);
    col = Number(lc[2]);
  } else if (pos) {
    const before = src.slice(0, Number(pos[1]));
    line = before.split('\n').length;
    col = before.length - before.lastIndexOf('\n');
  }
  const message = msg
    .replace(/^JSON\.parse: /, '')
    .replace(/^JSON Parse error: /, '')
    .replace(/,? (in JSON )?at position \d+.*$/, '')
    .replace(/ at line \d+ column \d+ of the JSON data$/, '');
  return { ok: false, message, line, col };
}

const parsed = computed<ParseState>(() => {
  try {
    return { ok: true, value: JSON.parse(text.value), line: null, col: null };
  } catch (e) {
    return describeJsonError(text.value, e as Error);
  }
});

const editorRows = computed(() => Math.min(40, Math.max(10, text.value.split('\n').length + 1)));

const dirty = computed(() =>
  parsed.value.ok ? pretty(parsed.value.value) !== savedText.value : text.value !== savedText.value,
);

const serverErrors = ref<string[]>([]);
const serverError = ref<string | null>(null);
watch(text, () => {
  serverErrors.value = [];
  serverError.value = null;
});

const duloSignedIn = ref(false);
async function refreshDuloStatus(): Promise<void> {
  try {
    const res = await fetch('/api/sources/dulo/status');
    if (res.ok) duloSignedIn.value = !!((await res.json()) as { signedIn?: boolean } | null)?.signedIn;
  } catch {
  }
}
function cleanDomain(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '');
}
const duloDomainChanging = computed(() => {
  if (!parsed.value.ok) return false;
  const d = (parsed.value.value as { dulo?: { domain?: unknown } } | null)?.dulo?.domain;
  return typeof d === 'string' && cleanDomain(d) !== playlistConfig.value.dulo.domain;
});
const signsOutDulo = computed(() => dirty.value && duloDomainChanging.value && duloSignedIn.value);

const saveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
async function save(): Promise<void> {
  if (!parsed.value.ok || !dirty.value || saveState.value === 'saving') return;
  saveState.value = 'saving';
  const r = await savePlaylistConfig(parsed.value.value);
  if (!r.ok) {
    saveState.value = 'error';
    serverErrors.value = r.errors ?? [];
    serverError.value = r.errors?.length ? null : r.error || 'Save failed';
    setTimeout(() => (saveState.value = 'idle'), 2200);
    return;
  }
  text.value = savedText.value;
  saveState.value = 'saved';
  void refreshDuloStatus();
  setTimeout(() => (saveState.value = 'idle'), 2200);
}
function revert(): void {
  text.value = savedText.value;
}

const testing = ref(false);
const results = ref<PlaylistConfigTestResult[] | null>(null);
const testedAt = ref<string | null>(null);
async function runTest(): Promise<void> {
  if (!parsed.value.ok || testing.value) return;
  testing.value = true;
  const r = await testPlaylistConfig(parsed.value.value);
  testing.value = false;
  if (!r.ok) {
    results.value = null;
    serverErrors.value = r.errors ?? [];
    serverError.value = r.errors?.length ? null : r.error;
    return;
  }
  results.value = r.results ?? [];
  testedAt.value = r.testedAt ?? null;
}
const passed = computed(() => results.value?.filter((r) => r.ok).length ?? 0);
function toneOf(r: PlaylistConfigTestResult): 'good' | 'warn' | 'bad' {
  if (r.ok) return 'good';
  return r.redirectTo ? 'warn' : 'bad';
}
function fmtTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

const headerTone = computed(() => (!parsed.value.ok ? 'bad' : dirty.value ? 'warn' : 'good'));
const headerLabel = computed(() => (!parsed.value.ok ? 'Invalid JSON' : dirty.value ? 'Unsaved changes' : 'Saved'));

onMounted(refreshDuloStatus);
</script>

<template>
  <div class="card">
    <div class="row" style="align-items: center; gap: 10px;">
      <Icon name="globe" :size="16" />
      <h3 class="section-title" style="margin: 0;">Playlist Domain / Configuration</h3>
      <span class="spacer" style="flex: 1;" />
      <StatusDot :status="headerTone" />
      <span class="muted" style="font-size: var(--fs-xs);">{{ headerLabel }}</span>
    </div>

    <div class="muted" style="font-size: var(--fs-xs); margin: 6px 0 14px;">
      The domain and options for each built-in playlist whose provider moves or needs tuning — DaddyLive, Dulo.tv and
      ZLive — as one JSON document. Changes apply live when saved, and are kept with your settings (and backups) and
      mirrored to <code class="mono">playlist-config.json</code> on the server.
    </div>

    <JsonEditor
      v-model="text"
      :rows="editorRows"
      :invalid="!parsed.ok"
      label="Playlist domain and configuration JSON"
      @keydown.meta.s.prevent="save"
      @keydown.ctrl.s.prevent="save"
    />

    <div role="status" aria-live="polite" class="pc-feedback">
      <div v-if="!parsed.ok" class="pc-line bad">
        <Icon name="x" :size="12" />
        <span>
          <template v-if="parsed.line !== null">Line {{ parsed.line }}, col {{ parsed.col }}: </template>{{ parsed.message }}
        </span>
      </div>
      <template v-else>
        <div v-for="e in serverErrors" :key="e" class="pc-line bad">
          <Icon name="x" :size="12" /><span class="mono">{{ e }}</span>
        </div>
        <div v-if="serverError" class="pc-line bad"><Icon name="x" :size="12" /><span>{{ serverError }}</span></div>
      </template>
    </div>

    <div
      v-if="signsOutDulo"
      class="row"
      style="gap: 8px; margin-top: 8px; padding: 8px 10px; background: var(--bg-2); border-radius: 8px; align-items: flex-start;"
    >
      <span style="color: var(--warn, var(--text-2)); margin-top: 1px;"><Icon name="warn" :size="13" /></span>
      <span style="font-size: var(--fs-xs); color: var(--text-1);">
        Saving a new <code class="mono">dulo.domain</code> signs the current dulo session out — you'll need to pair
        again in Dulo.tv Authentication.
      </span>
    </div>

    <div class="row" style="gap: 8px; margin-top: 10px; align-items: center; flex-wrap: wrap;">
      <Btn variant="ghost" size="sm" icon="sync" :disabled="!parsed.ok || testing" @click="runTest">
        {{ testing ? 'Testing…' : 'Test' }}
      </Btn>
      <Btn variant="primary" size="sm" icon="check" :disabled="!parsed.ok || !dirty || saveState === 'saving'" @click="save">
        {{ saveState === 'saving' ? 'Saving…' : signsOutDulo ? 'Save & sign out dulo' : 'Save' }}
      </Btn>
      <Btn v-if="dirty || !parsed.ok" variant="ghost" size="sm" @click="revert">Revert</Btn>
      <span v-if="saveState === 'saved'" style="color: var(--good); font-size: var(--fs-xs);">Saved</span>
      <span v-else-if="saveState === 'error'" style="color: var(--bad); font-size: var(--fs-xs);">Failed</span>
    </div>

    <div v-if="results" class="pc-results" aria-live="polite">
      <div class="muted pc-results-head">
        {{ passed }} of {{ results.length }} domains serving a catalog · tested {{ fmtTime(testedAt) }}
      </div>
      <div v-for="r in results" :key="r.key" class="pc-result">
        <StatusDot :status="toneOf(r)" />
        <div class="pc-result-body">
          <div class="row" style="gap: 8px; align-items: baseline; flex-wrap: wrap;">
            <b style="font-size: var(--fs-sm); color: var(--text-0);">{{ r.label }}</b>
            <code class="mono" style="font-size: var(--fs-xs); color: var(--text-1);">{{ r.domain }}</code>
            <span v-if="r.unsaved" class="pill warn" style="font-size: 10px;">unsaved</span>
            <span v-if="!r.enable" class="pill" style="font-size: 10px;">hidden</span>
            <span class="muted" style="font-size: var(--fs-xs);">
              <template v-if="r.ok">{{ r.channelCount }} channels</template>
              <template v-else>not serving a catalog</template>
            </span>
          </div>
          <div class="muted mono pc-meta">
            <span v-if="r.endpoint">GET {{ r.endpoint }}</span>
            <span>{{ r.httpStatus !== null ? `HTTP ${r.httpStatus}` : 'no response' }}</span>
            <span>{{ r.ms }} ms</span>
          </div>
          <div v-for="n in r.notes" :key="n" class="muted pc-note">{{ n }}</div>
          <div v-if="r.error" class="pc-note" :style="{ color: toneOf(r) === 'warn' ? 'var(--warn)' : 'var(--bad)' }">
            {{ r.error }}
          </div>
        </div>
      </div>
    </div>

    <details class="pc-ref">
      <summary class="muted">What the properties do</summary>
      <dl>
        <dt><code class="mono">enable</code></dt>
        <dd>
          <code class="mono">false</code> hides the playlist: it disappears from Add Playlist and its settings are hidden
          (e.g. Dulo.tv Authentication). A playlist you already added keeps syncing and playing.
        </dd>
        <dt><code class="mono">domain</code></dt>
        <dd>
          The site the provider runs on today, as a bare host (<code class="mono">dlive.sx</code>). When a provider
          moves, change it here and re-Sync the playlist. <b>Test</b> checks domains without saving them.
        </dd>
        <dt><code class="mono">daddylive.extendedProperties.defaultPlayer</code></dt>
        <dd>
          <code class="mono">"auto"</code> or a player number (1–12). DaddyLive's players are independent providers
          that don't all carry every channel; this is the lead for every channel, the rest are tried when it fails,
          and a per-channel choice in the channel editor still wins. <code class="mono">"auto"</code> leads with Player 1.
        </dd>
        <dt><code class="mono">zlive.extendedProperties.concurrency</code></dt>
        <dd>
          How many different ZLive channels may play at once (several viewers of one channel count once); a new
          channel over the limit is refused. <code class="mono">0</code> = no limit. ZLive watches how many streams
          each address pulls, so keep this low.
        </dd>
      </dl>
    </details>
  </div>
</template>

<style scoped>
.pc-feedback { font-size: var(--fs-xs); }
.pc-line {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin-top: 6px;
}
.pc-line.bad { color: var(--bad); }
.pc-line :deep(.ico) { margin-top: 2px; flex: none; }

.pc-results {
  margin-top: 14px;
  border-top: 1px solid var(--hairline);
  padding-top: 10px;
}
.pc-results-head { font-size: var(--fs-xs); margin-bottom: 8px; }
.pc-result {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 0;
}
.pc-result + .pc-result { border-top: 1px dashed var(--hairline); }
.pc-result :deep(.dot) { margin-top: 5px; flex: none; }
.pc-result-body { min-width: 0; flex: 1; }
.pc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: var(--fs-xs);
  margin-top: 3px;
  overflow-wrap: anywhere;
}
.pc-note { font-size: var(--fs-xs); margin-top: 3px; }

.pc-ref { margin-top: 14px; font-size: var(--fs-xs); }
.pc-ref summary { cursor: pointer; }
.pc-ref dl { margin: 8px 0 0; display: grid; gap: 4px 0; }
.pc-ref dt { color: var(--text-0); margin-top: 6px; }
.pc-ref dd { margin: 0; color: var(--text-1); line-height: 1.55; }
</style>
