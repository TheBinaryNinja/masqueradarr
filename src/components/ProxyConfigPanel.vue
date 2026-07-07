<script setup lang="ts">
// Shared durable video-engine proxy-config panel. Mounted twice with the same shape:
//   · (Default)  Settings → Advanced      → <ProxyConfigPanel config-id="app" />
//   · (Custom)   playlist drawer          → <ProxyConfigPanel :config-id="'app_' + playlist.id" flat />
// Auto-saves every edit (no save button) via useProxyConfig(configId) — the useSettings hydrate-guard + 500 ms
// debounce, scoped per config id. The knobs split into ACTIVE-NOW (applied by the Rust data plane today —
// connect/read timeout, max redirects, buffer size, header overrides, and the output format incl. P3.2 raw-TS)
// and RESERVED (persisted + shipped in the grant, applied when a later phase gains the capability — segment
// cache). See src/composables/useProxyConfig.ts + .claude/plans/durable-iptv-proxy.md.

import { ref, onMounted, watch } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Segmented from './Segmented.vue';
import { useProxyConfig } from '../composables/useProxyConfig';

const props = defineProps<{ configId: string; title?: string; flat?: boolean }>();

const { state, loading, saveState, load } = useProxyConfig(props.configId);

// headerOverrides is edited as an ordered key/value row list, written back into the reactive state (whose deep
// watcher fires the auto-save). state is the source of truth; rows are a view rebuilt whenever the id reloads.
const rows = ref<{ key: string; value: string }[]>([]);
function syncRowsFromState() {
  rows.value = Object.entries(state.headerOverrides).map(([key, value]) => ({ key, value }));
}
function syncStateFromRows() {
  const map: Record<string, string> = {};
  for (const r of rows.value) {
    const k = r.key.trim();
    if (k) map[k] = r.value;
  }
  state.headerOverrides = map;
}
function addHeader() {
  rows.value.push({ key: '', value: '' });
}
function removeHeader(i: number) {
  rows.value.splice(i, 1);
  syncStateFromRows();
}

// Numeric coercion. Required ints clamp to a floor; reserved knobs accept a blank → null.
function setNum(field: 'connectTimeoutMs' | 'maxRedirects', raw: string, min: number) {
  const n = Math.round(Number(raw));
  state[field] = Number.isFinite(n) ? Math.max(min, n) : min;
}
function setNullableNum(
  field: 'readTimeoutMs' | 'bufferSizeKb' | 'segmentCacheTtlSec',
  raw: string,
  min = 0,
) {
  const t = raw.trim();
  if (t === '') {
    state[field] = null;
    return;
  }
  const n = Math.round(Number(t));
  state[field] = Number.isFinite(n) ? Math.max(min, n) : null;
}

onMounted(async () => {
  await load();
  syncRowsFromState();
});
// The drawer reuses one panel instance across playlists — reload + rebuild the header rows when the id changes.
watch(
  () => props.configId,
  async () => {
    await load();
    syncRowsFromState();
  },
);
</script>

<template>
  <div :class="flat ? 'col' : 'card'" style="gap: 0;">
    <div class="row" style="align-items: center; gap: 10px;">
      <Icon v-if="!flat" name="tv" :size="16" />
      <h3 v-if="!flat" class="section-title" style="margin: 0;">{{ title ?? 'Video proxy engine' }}</h3>
      <div v-else class="field-lbl">{{ title ?? 'Proxy engine overrides' }}</div>
      <span class="spacer" style="flex: 1;" />
      <span v-if="saveState === 'saving'" class="muted" style="font-size: var(--fs-xs);">Saving…</span>
      <span v-else-if="saveState === 'saved'" style="color: var(--good); font-size: var(--fs-xs);">Saved</span>
      <span v-else-if="saveState === 'error'" style="color: var(--bad); font-size: var(--fs-xs);">Save failed</span>
    </div>

    <div v-if="!flat" class="muted" style="font-size: var(--fs-xs); margin: 6px 0 14px;">
      Tuning for the durable video engine that fetches, rewrites, and pipes every stream. Changes save
      automatically and apply to new streams.
    </div>

    <div :style="loading ? 'opacity: 0.5; pointer-events: none;' : ''">
      <!-- ── Active now ─────────────────────────────────────────────────────────────── -->
      <div class="form-grid-2">
        <div class="form-row">
          <div class="field-lbl">Connect timeout <span class="mono muted" style="font-weight: 400;">· ms</span></div>
          <div class="input">
            <input type="number" min="100" :value="state.connectTimeoutMs"
                   @input="setNum('connectTimeoutMs', ($event.target as HTMLInputElement).value, 100)" />
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            How long to wait for the upstream connection handshake before giving up.
          </div>
        </div>
        <div class="form-row">
          <div class="field-lbl">Max redirects</div>
          <div class="input">
            <input type="number" min="0" max="50" :value="state.maxRedirects"
                   @input="setNum('maxRedirects', ($event.target as HTMLInputElement).value, 0)" />
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            How many upstream redirects to follow when resolving a stream.
          </div>
        </div>
        <div class="form-row">
          <div class="field-lbl">Read timeout <span class="mono muted" style="font-weight: 400;">· ms</span></div>
          <div class="input">
            <input type="number" min="0" :value="state.readTimeoutMs ?? ''" placeholder="none"
                   @input="setNullableNum('readTimeoutMs', ($event.target as HTMLInputElement).value)" />
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            Stall guard: if the upstream goes silent for this long mid-stream, the segment is dropped + retried.
            Blank = never time out a slow segment.
          </div>
        </div>
        <div class="form-row">
          <div class="field-lbl">Buffer size <span class="mono muted" style="font-weight: 400;">· KiB</span></div>
          <div class="input">
            <input type="number" min="16" :value="state.bufferSizeKb ?? ''" placeholder="minimal"
                   @input="setNullableNum('bufferSizeKb', ($event.target as HTMLInputElement).value, 16)" />
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            Read-ahead buffer between the upstream and the viewer that absorbs brief upstream jitter. Blank = a
            minimal pipeline.
          </div>
        </div>
      </div>

      <div class="form-row" style="margin-top: 14px;">
        <div class="field-lbl">Output format</div>
        <Segmented
          :value="state.outputFormat"
          @change="(v) => (state.outputFormat = v)"
          :options="[{ value: 'hls', label: 'HLS' }, { value: 'ts', label: 'Raw TS' }]"
        />
        <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
          How streams reach third-party players (the in-app player is always HLS). <b>HLS</b> rewrites the
          playlist per segment; <b>Raw TS</b> serves one continuous MPEG-TS stream for clients that prefer it
          (pure-TS sources only — encrypted / fMP4 upstreams fall back to HLS automatically).
        </div>
      </div>

      <div class="field-lbl" style="margin: 14px 0 6px;">Upstream header overrides</div>
      <div class="muted" style="font-size: var(--fs-xs); margin: -2px 0 10px;">
        Extra request headers sent to the upstream on every hop (merged over the source's own headers).
      </div>
      <div class="col" style="gap: 8px;">
        <div v-for="(r, i) in rows" :key="i" class="row" style="gap: 8px; align-items: center;">
          <div class="input mono" style="flex: 0 0 40%; font-size: 12px;">
            <input v-model="r.key" placeholder="Header-Name" @input="syncStateFromRows" />
          </div>
          <div class="input mono" style="flex: 1; font-size: 12px;">
            <input v-model="r.value" placeholder="value" @input="syncStateFromRows" />
          </div>
          <Btn variant="ghost" size="sm" icon="trash" @click="removeHeader(i)" />
        </div>
        <div class="row">
          <Btn variant="ghost" size="sm" icon="plus" @click="addHeader">Add header</Btn>
        </div>
      </div>

      <div class="divider" style="margin: 16px 0 12px;" />

      <!-- ── Reserved (persisted now, applied in a later phase) ─────────────────────────── -->
      <div class="row" style="align-items: center; gap: 8px; margin-bottom: 4px;">
        <div class="field-lbl" style="margin: 0;">Reserved</div>
        <span class="muted" style="font-size: var(--fs-xs);">— saved now, applied as the engine gains each capability</span>
      </div>
      <div class="form-grid-2" style="margin-top: 8px;">
        <div class="form-row">
          <div class="field-lbl">Segment cache TTL <span class="mono muted" style="font-weight: 400;">· s</span></div>
          <div class="input">
            <input type="number" min="0" :value="state.segmentCacheTtlSec ?? ''" placeholder="no-store"
                   @input="setNullableNum('segmentCacheTtlSec', ($event.target as HTMLInputElement).value)" />
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            Cache fetched segments this long to serve repeat requests without re-fetching.
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
