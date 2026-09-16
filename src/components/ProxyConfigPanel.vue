<script setup lang="ts">

import { ref, computed, onMounted, watch } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Segmented from './Segmented.vue';
import Toggle from './Toggle.vue';
import { useProxyConfig } from '../composables/useProxyConfig';
import { SOURCES, PLAYLISTS } from '../data';

const props = defineProps<{ configId: string; title?: string; flat?: boolean }>();

const { state, loading, saveState, load } = useProxyConfig(props.configId);

const CUSTOM_PREFIX = 'app_';
const originForcedSources = computed(() => {
  const added = new Set(PLAYLISTS.value.map((p) => p.id));
  return SOURCES.value.filter((s) => s.originRequired === true && added.has(s.id));
});
const panelPlaylist = computed(() =>
  props.configId.startsWith(CUSTOM_PREFIX)
    ? (PLAYLISTS.value.find((p) => p.id === props.configId.slice(CUSTOM_PREFIX.length)) ?? null)
    : null,
);
const originForcedBy = computed(() => {
  const pl = panelPlaylist.value;
  if (!pl?.builtin || !pl.source) return null;
  return originForcedSources.value.find((s) => s.id === pl.source)?.label ?? null;
});
const originForcedFor = computed(() => {
  if (originForcedBy.value) return [];
  if (props.configId.startsWith(CUSTOM_PREFIX) && panelPlaylist.value?.source !== 'clone') return [];
  return originForcedSources.value.map((s) => s.label);
});
const originToggleOn = computed(() => state.originEnabled || !!originForcedBy.value);
const originKnobsLive = computed(() => originToggleOn.value || originForcedFor.value.length > 0);

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

function setNum(field: 'connectTimeoutMs' | 'maxRedirects' | 'originRingMb', raw: string) {
  const n = Math.round(Number(raw));
  if (Number.isFinite(n)) state[field] = n;
}
function setNullableNum(field: 'readTimeoutMs' | 'bufferSizeKb' | 'segmentCacheTtlSec', raw: string) {
  const t = raw.trim();
  if (t === '') {
    state[field] = null;
    return;
  }
  const n = Math.round(Number(t));
  if (Number.isFinite(n)) state[field] = n;
}
function commitNum(field: 'connectTimeoutMs' | 'maxRedirects' | 'originRingMb', min: number, max: number) {
  const v = state[field];
  state[field] = Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
}
function commitNullableNum(
  field: 'readTimeoutMs' | 'bufferSizeKb' | 'segmentCacheTtlSec',
  min: number,
  max: number,
) {
  const v = state[field];
  if (v == null) return;
  state[field] = Math.min(max, Math.max(min, v));
}

onMounted(async () => {
  await load();
  syncRowsFromState();
});
watch(
  () => props.configId,
  async () => {
    await load();
    syncRowsFromState();
  },
);
</script>

<template>
  <div :class="['pcp', flat ? 'col' : 'card']" style="gap: 0;">
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

    <div class="pcp-body" :style="loading ? 'opacity: 0.5; pointer-events: none;' : ''">
      <div class="form-grid-2">
        <div class="form-row">
          <div class="field-lbl">Connect timeout <span class="mono muted" style="font-weight: 400;">· ms</span></div>
          <div class="input">
            <input type="number" min="100" :value="state.connectTimeoutMs"
                   @input="setNum('connectTimeoutMs', ($event.target as HTMLInputElement).value)"
                   @blur="commitNum('connectTimeoutMs', 100, 120000)" />
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            How long to wait for the upstream connection handshake before giving up.
          </div>
        </div>
        <div class="form-row">
          <div class="field-lbl">Max redirects</div>
          <div class="input">
            <input type="number" min="0" max="50" :value="state.maxRedirects"
                   @input="setNum('maxRedirects', ($event.target as HTMLInputElement).value)"
                   @blur="commitNum('maxRedirects', 0, 50)" />
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            How many upstream redirects to follow when resolving a stream.
          </div>
        </div>
        <div class="form-row">
          <div class="field-lbl">Read timeout <span class="mono muted" style="font-weight: 400;">· ms</span></div>
          <div class="input">
            <input type="number" min="0" :value="state.readTimeoutMs ?? ''" placeholder="none"
                   @input="setNullableNum('readTimeoutMs', ($event.target as HTMLInputElement).value)"
                   @blur="commitNullableNum('readTimeoutMs', 0, 600000)" />
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
                   @input="setNullableNum('bufferSizeKb', ($event.target as HTMLInputElement).value)"
                   @blur="commitNullableNum('bufferSizeKb', 16, 1048576)" />
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            Read-ahead buffer that absorbs brief upstream jitter. Allocated in ~64 KiB chunks — under ~128 KiB
            behaves minimal; ≈512 KiB+ (8+ chunks) is where it meaningfully helps. Blank = minimal pipeline.
          </div>
        </div>
      </div>

      <div class="form-grid-2" style="margin-top: 17px;">
        <div class="form-row">
          <div class="field-lbl">Local origin</div>
          <div class="row" style="align-items: center; gap: 10px;">
            <Toggle :on="originToggleOn" :disabled="!!originForcedBy" @change="(v) => (state.originEnabled = v)" />
            <span class="muted" style="font-size: var(--fs-xs);">
              {{ originForcedBy ? `On · forced by ${originForcedBy}` : state.originEnabled ? 'On' : 'Off' }}
            </span>
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            Re-publish streams from masqueradarr instead of passing the provider's playlist through. One
            ingest per channel decrypts and caches segments in memory, and players receive a stream we
            authored — our own numbering, no encryption keys, no provider URLs. Extra viewers of the same
            channel then cost <b>no additional upstream bandwidth</b>. Off is exactly today's behaviour.
          </div>
          <div v-if="originForcedBy" class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            <b>{{ originForcedBy }}</b> can only be served through the local origin, so it is always on for this
            playlist.
          </div>
          <div v-else-if="originForcedFor.length" class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            Always on for <b>{{ originForcedFor.join(', ') }}</b> —
            {{ originForcedFor.length === 1 ? 'that source' : 'those sources' }} can only be served through the
            local origin, whatever this is set to.
            <template v-if="!state.originEnabled">
              <b>Ring size</b> and <b>Smooth ad transitions</b> below still apply to
              {{ originForcedFor.length === 1 ? 'its' : 'their' }} streams.
            </template>
          </div>
        </div>
        <div class="form-row">
          <div class="field-lbl">
            Ring size <span class="mono muted" style="font-weight: 400;">· MiB per channel</span>
          </div>
          <div class="input">
            <input type="number" min="1" max="4096" :value="state.originRingMb"
                   :disabled="!originKnobsLive"
                   @input="setNum('originRingMb', ($event.target as HTMLInputElement).value)"
                   @blur="commitNum('originRingMb', 1, 4096)" />
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            How much memory one channel's live window may hold — bigger means a longer buffer against
            upstream hiccups. 25&nbsp;MiB is roughly a minute at 3.3&nbsp;Mbps. A minimum of 3 segments is
            always kept even if that exceeds the cap, and the engine logs a warning when it has to.
          </div>
        </div>
      </div>

      <div class="form-grid-2" style="margin-top: 17px;">
        <div class="form-row">
          <div class="field-lbl">Smooth ad transitions</div>
          <div class="row" style="align-items: center; gap: 10px;">
            <Toggle
              :on="state.spliceNormalize"
              :disabled="!originKnobsLive"
              @change="(v) => (state.spliceNormalize = v)"
            />
            <span class="muted" style="font-size: var(--fs-xs);">{{ state.spliceNormalize ? 'On' : 'Off' }}</span>
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            Republishes the channel as one continuous stream, so a provider that switches encoder between ads
            cannot stall the player. Some providers change the stream's internal layout at every ad boundary,
            which many players cannot follow — they freeze until the layout happens to change back. Leave this
            <b>on</b>; turn it off only to check whether it is involved in a playback problem.
          </div>
        </div>
      </div>

      <div class="form-grid-2" style="margin-top: 17px;">
        <div class="form-row">
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
        <div class="form-row">
          <div class="field-lbl">STREAM-INF Redux</div>
          <div class="row" style="align-items: center; gap: 10px;">
            <Toggle :on="state.streamInfRedux" @change="(v) => (state.streamInfRedux = v)" />
            <span class="muted" style="font-size: var(--fs-xs);">{{ state.streamInfRedux ? 'On' : 'Off' }}</span>
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            Reorders the HLS master so the first <span class="mono">#EXT-X-STREAM-INF</span> lands in the first
            few KB, letting strict third-party players (e.g. VLC's 8&nbsp;KB probe) detect it as HLS.
            External-player mount only; keeps every variant &amp; rendition. No effect on the in-app player or Raw TS.
          </div>
        </div>
      </div>

      <div class="form-grid-2" style="margin-top: 17px;">
        <div class="form-row">
          <div class="field-lbl">Failover groups</div>
          <div class="row" style="align-items: center; gap: 10px;">
            <Toggle :on="state.failoverEnabled" @change="(v) => (state.failoverEnabled = v)" />
            <span class="muted" style="font-size: var(--fs-xs);">{{ state.failoverEnabled ? 'On' : 'Off' }}</span>
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            When a channel's stream fails to establish, fall through to its configured failover backups in
            order (set up per channel on the playlist detail screen). Off = fail like an ungrouped channel.
          </div>
        </div>
        <div class="form-row">
          <div class="field-lbl">Failover on upstream error</div>
          <div class="row" style="align-items: center; gap: 10px;">
            <Toggle :on="state.failoverOnDefiniteError" @change="(v) => (state.failoverOnDefiniteError = v)" />
            <span class="muted" style="font-size: var(--fs-xs);">{{ state.failoverOnDefiniteError ? 'On' : 'Off' }}</span>
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            Also treat a definitive upstream error response (404 / 403 / 5xx — normally passed through to the
            player) as a failover trigger. Off keeps the long-standing pass-through behavior.
          </div>
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

      <div class="divider" style="margin: 20px 0 12px;" />

      <div class="row" style="align-items: center; gap: 8px; margin-bottom: 4px;">
        <div class="field-lbl" style="margin: 0;">Reserved</div>
        <span class="muted" style="font-size: var(--fs-xs);">— saved now, applied as the engine gains each capability</span>
      </div>
      <div class="form-grid-2" style="margin-top: 12px;">
        <div class="form-row">
          <div class="field-lbl">Segment cache TTL <span class="mono muted" style="font-weight: 400;">· s</span></div>
          <div class="input">
            <input type="number" min="0" :value="state.segmentCacheTtlSec ?? ''" placeholder="no-store"
                   @input="setNullableNum('segmentCacheTtlSec', ($event.target as HTMLInputElement).value)"
                   @blur="commitNullableNum('segmentCacheTtlSec', 0, 86400)" />
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            Cache fetched segments this long to serve repeat requests without re-fetching.
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pcp .form-grid-2 {
  gap: 20px 24px;
}
.pcp .form-row .muted {
  line-height: 1.45;
  max-width: 62ch;
}
.pcp .field-lbl {
  margin-bottom: 5px;
}
</style>
