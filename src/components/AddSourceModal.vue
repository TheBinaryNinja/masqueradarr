<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import { PLAYLISTS, SOURCES, reloadPlaylists, reloadCustomPlaylists, reloadChannels } from '../data';
import { useToast } from '../composables/useToast';

// Add playlist — add a BUILT-IN registry source (dulo/dlhd/tubi) on demand, or create a new, named playlist
// and populate it from an M3U (uploaded file or remote URL) or a local HDHomeRun tuner.
//   Built-In  → POST /api/sources/<id>/provision (registers the (Default) source playlist's zero-channel shell
//               row; channels populate on the first "Sync now"). The name derives server-side from the source.
//   M3U       → POST /api/import/m3u (an Import-type playlist, channels via the `direct` proxy).
//   HDHomeRun → POST /api/import/hdhomerun (an HDHomeRun-type playlist whose raw-TS channels remux to HLS via
//               the `hdhomerun` proxy).
// This replaces the standalone /import screen. EPG sources have their own modal (AddEpgSourceModal); this one
// is playlist-only.

const emit = defineEmits<{ (e: 'close'): void }>();
const router = useRouter();
const { banner } = useToast();

// Built-in sources the user can add = the manifest sources NOT already provisioned as a Playlist row (an
// added built-in disappears from the picker). The manifest enumerates the full registry even when no row
// exists yet (built-ins are now user-initiated), so this drives the dropdown directly.
const availableBuiltins = computed(() => {
  const added = new Set(PLAYLISTS.value.map((p) => p.id));
  return SOURCES.value.filter((s) => !added.has(s.id));
});

const name = ref('');
// Default to the Built-In option when there are built-ins left to add; otherwise fall back to file upload.
const mode = ref<'builtin' | 'file' | 'url' | 'hdhr' | 'local'>(availableBuiltins.value.length ? 'builtin' : 'file');
const selectedBuiltin = ref<string>(availableBuiltins.value[0]?.id ?? ''); // chosen source id (builtin mode)
const fileInput = ref<HTMLInputElement | null>(null);
const fileName = ref('');
const content = ref(''); // raw m3u text (file mode)
const url = ref(''); // remote URL (url mode)
const hdhrAddress = ref(''); // HDHomeRun device address (hdhr mode)

// Local Now (local mode): a city/market typeahead against the City/Search proxy + the chosen market that
// gates the Add button. A Local playlist is created per market (POST /api/import/local).
interface LocalMarket {
  label: string;
  dma: string;
  market: string;
}
const cityQuery = ref(''); // the typeahead text
const cityResults = ref<LocalMarket[]>([]); // City/Search matches
const selectedMarket = ref<LocalMarket | null>(null); // the picked market (un-gates Add)
const searchingCities = ref(false);
let cityTimer: ReturnType<typeof setTimeout> | null = null;

// The manifest entry for the currently-picked built-in (drives the summary block below).
const builtinEntry = computed(() => SOURCES.value.find((s) => s.id === selectedBuiltin.value) ?? null);

interface Preview {
  channels: number;
  groups: number;
  sample: { name: string; group: string | null }[];
}
const preview = ref<Preview | null>(null);
// HDHomeRun device test summary (hdhr mode) — the lineup feedback that also gates the Add button.
interface HdhrInfo {
  deviceName: string;
  model: string;
  tunerCount: number;
  channelCount: number;
  sampleChannels: { name: string }[];
}
const hdhrInfo = ref<HdhrInfo | null>(null);
const busy = ref(false); // previewing / fetching / testing
const creating = ref(false);
const error = ref('');

const ready = computed(() => {
  // Built-In: no name required (it derives server-side) — just a chosen, not-yet-added built-in.
  if (mode.value === 'builtin') {
    return !!selectedBuiltin.value && availableBuiltins.value.some((s) => s.id === selectedBuiltin.value);
  }
  if (name.value.trim().length === 0) return false;
  // HDHomeRun: keep the Add button disabled until a successful Test returns a non-empty lineup.
  if (mode.value === 'hdhr') return hdhrInfo.value != null && hdhrInfo.value.channelCount > 0;
  // Local Now: a market must be picked (typeahead or auto-detect) before Add is allowed.
  if (mode.value === 'local') return selectedMarket.value != null;
  return preview.value != null && preview.value.channels > 0;
});

function resetSource() {
  fileName.value = '';
  content.value = '';
  url.value = '';
  hdhrAddress.value = '';
  cityQuery.value = '';
  cityResults.value = [];
  selectedMarket.value = null;
  preview.value = null;
  hdhrInfo.value = null;
  error.value = '';
  if (fileInput.value) fileInput.value.value = '';
}
function switchMode(m: 'builtin' | 'file' | 'url' | 'hdhr' | 'local') {
  if (mode.value === m) return;
  mode.value = m;
  resetSource();
}

// Parse-only preview → honest channel/group counts before the user commits.
async function runPreview(payload: Record<string, string>) {
  busy.value = true;
  error.value = '';
  preview.value = null;
  try {
    const res = await fetch('/api/import/m3u/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    preview.value = (await res.json()) as Preview;
    if (!preview.value.channels) error.value = 'No channels found in this playlist.';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function defaultName(from: string) {
  if (!name.value.trim()) name.value = from.replace(/\.[^.]+$/, '') || from;
}

async function onFileChange(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  fileName.value = f.name;
  content.value = await f.text();
  defaultName(f.name);
  await runPreview({ content: content.value });
}

async function checkUrl() {
  if (!url.value.trim() || busy.value) return;
  defaultName(url.value.split('/').pop() || 'Imported');
  await runPreview({ url: url.value.trim() });
}

// HDHomeRun "Test": ping the device (discover.json) + fetch its lineup.m3u, then show a summary. A successful
// test (non-empty lineup) is what un-gates the Add button (see `ready`). Any failure surfaces in `error`.
async function testHdhr() {
  if (!hdhrAddress.value.trim() || busy.value) return;
  busy.value = true;
  error.value = '';
  hdhrInfo.value = null;
  try {
    const res = await fetch('/api/import/hdhomerun/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: hdhrAddress.value.trim() }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    hdhrInfo.value = (await res.json()) as HdhrInfo;
    defaultName(hdhrInfo.value.deviceName || 'HDHomeRun');
    if (!hdhrInfo.value.channelCount) error.value = 'Device reachable, but its channel lineup is empty.';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

// Local Now city/market typeahead (debounced) → the City/Search proxy. Typing clears any prior pick so the
// Add button only arms once the user re-selects a concrete market.
function onCityInput() {
  selectedMarket.value = null;
  if (cityTimer) clearTimeout(cityTimer);
  const q = cityQuery.value.trim();
  if (q.length < 2) {
    cityResults.value = [];
    return;
  }
  cityTimer = setTimeout(() => void searchCities(q), 300);
}
async function searchCities(q: string) {
  searchingCities.value = true;
  error.value = '';
  try {
    const res = await fetch(`/api/import/local/cities?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    cityResults.value = (await res.json()) as LocalMarket[];
    if (!cityResults.value.length) error.value = 'No markets found for that search.';
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    searchingCities.value = false;
  }
}
function pickMarket(m: LocalMarket) {
  selectedMarket.value = m;
  cityResults.value = [];
  cityQuery.value = m.label;
  defaultName(m.label);
}
// "Use my detected market" — Local Now's geo-detected default DMA/market (US-located servers only).
async function detectLocalMarket() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/import/local/detect');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    pickMarket((await res.json()) as LocalMarket);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

// Add a built-in source: provision its (Default) playlist shell row (no sync — channels populate on the first
// "Sync now"), refresh stores, then open it. The name derives server-side from the source's adapter label.
async function provisionBuiltin() {
  const entry = builtinEntry.value;
  if (!entry) return;
  const res = await fetch(`/api/sources/${encodeURIComponent(entry.id)}/provision`, { method: 'POST' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  const out = (await res.json()) as { id: string };
  await reloadPlaylists();
  await reloadChannels();
  banner({ text: `Added "${entry.label}"`, tone: 'good', icon: 'playlist' });
  emit('close');
  router.push(`/playlists/${encodeURIComponent(out.id)}`);
}

// Create the named playlist (M3U import or HDHomeRun device), then refresh stores + open it.
async function create() {
  if (!ready.value || creating.value) return;
  creating.value = true;
  try {
    if (mode.value === 'builtin') {
      await provisionBuiltin();
      return;
    }
    const endpoint =
      mode.value === 'hdhr'
        ? '/api/import/hdhomerun'
        : mode.value === 'local'
          ? '/api/import/local'
          : '/api/import/m3u';
    const payload: Record<string, string> = { name: name.value.trim() };
    if (mode.value === 'hdhr') payload.address = hdhrAddress.value.trim();
    else if (mode.value === 'local') {
      payload.dma = selectedMarket.value!.dma;
      payload.market = selectedMarket.value!.market;
      payload.label = selectedMarket.value!.label;
    } else if (mode.value === 'file') payload.content = content.value;
    else payload.url = url.value.trim();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    const out = (await res.json()) as { id: string; channels: number };
    await Promise.all([reloadCustomPlaylists(), reloadPlaylists()]);
    banner({
      text: `Added "${name.value.trim()}" · ${out.channels} channel${out.channels === 1 ? '' : 's'}`,
      tone: 'good',
      icon: 'playlist',
    });
    emit('close');
    router.push(`/playlists/${encodeURIComponent(out.id)}`);
  } catch (e) {
    banner({ text: `Add failed: ${(e as Error).message}`, tone: 'bad', icon: 'warn' });
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="modal-bg" @click="emit('close')">
    <div class="modal" @click.stop>
      <div class="modal-hd">
        <Icon name="playlist" :size="18" />
        <h2>Add playlist</h2>
        <span class="spacer" />
        <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
      </div>
      <div class="modal-body">
        <!-- Built-In derives its name from the source — only the import modes ask for one. -->
        <div v-if="mode !== 'builtin'" class="form-row">
          <div class="field-lbl">Playlist name</div>
          <div class="input"><input v-model="name" placeholder="My Playlist" /></div>
        </div>

        <div class="field-lbl">Import channels from</div>
        <div class="segmented" style="margin-bottom: 12px;">
          <button :class="mode === 'builtin' ? 'active' : ''" @click="switchMode('builtin')">
            <Icon name="check" :size="13" />Built-In
          </button>
          <button :class="mode === 'file' ? 'active' : ''" @click="switchMode('file')">
            <Icon name="upload" :size="13" />Upload m3u
          </button>
          <button :class="mode === 'url' ? 'active' : ''" @click="switchMode('url')">
            <Icon name="link" :size="13" />Remote URL
          </button>
          <button :class="mode === 'hdhr' ? 'active' : ''" @click="switchMode('hdhr')">
            <Icon name="tv" :size="13" />HDHomeRun
          </button>
          <button :class="mode === 'local' ? 'active' : ''" @click="switchMode('local')">
            <Icon name="map" :size="13" />Local Now
          </button>
        </div>

        <input
          ref="fileInput"
          type="file"
          accept=".m3u,.m3u8,audio/x-mpegurl,application/x-mpegurl"
          style="display: none;"
          @change="onFileChange"
        />

        <!-- BUILT-IN MODE -->
        <template v-if="mode === 'builtin'">
          <template v-if="availableBuiltins.length">
            <div class="field-lbl">Built-in playlist</div>
            <div class="select fill">
              <select v-model="selectedBuiltin">
                <option v-for="s in availableBuiltins" :key="s.id" :value="s.id">{{ s.label }}</option>
              </select>
            </div>

            <!-- Summary of what's included with the selected built-in (from the manifest builtinMeta). -->
            <div v-if="builtinEntry" class="builtin-summary">
              <div class="bs-head">Playlist Channels</div>
              <div class="bs-kv">
                <span class="bs-k">Global Playlist</span>
                <code class="bs-v">{{ builtinEntry.builtinMeta.globalPlaylist }}</code>
                <span class="bs-k">Clone Playlist</span>
                <code class="bs-v">{{ builtinEntry.builtinMeta.clonePlaylist }}</code>
                <span class="bs-k">Sync Schedules</span>
                <code class="bs-v">{{ builtinEntry.builtinMeta.syncSchedules }}</code>
                <span class="bs-k">Video Engine Customization</span>
                <code class="bs-v">{{ builtinEntry.builtinMeta.videoEngineCustomization }}</code>
              </div>
              <div class="bs-head">Playlist EPG</div>
              <div class="bs-kv">
                <span class="bs-k">Playlist-bound</span>
                <code class="bs-v">{{ builtinEntry.builtinMeta.playlistBoundEpg }}</code>
              </div>
              <blockquote class="bs-note">
                Playlist-bound EPG data is updated directly from the Playlist. Executing a sync from the
                Playlist will automatically update the Playlist-bound EPG data. When a Playlist-bound =
                <code>false</code> the user is responsible for matching playlists channels that do not have a
                pre-determined match.
              </blockquote>
              <div class="bs-kv">
                <span class="bs-k">Sync Schedules</span>
                <code class="bs-v">{{ builtinEntry.builtinMeta.epgSyncSchedules }}</code>
              </div>
            </div>
          </template>
          <div v-else class="muted" style="display: flex; align-items: center; gap: 8px;">
            <Icon name="check" :size="14" /> All built-in playlists have already been added.
          </div>
        </template>

        <!-- FILE MODE -->
        <template v-if="mode === 'file'">
          <div v-if="!fileName" class="dropzone" @click="fileInput?.click()">
            <div class="icon-circle"><Icon name="upload" :size="20" /></div>
            <div>
              <h3>Choose an M3U / M3U8 file</h3>
              <p>click to browse — up to 25 MB</p>
            </div>
          </div>
          <div v-else class="row">
            <Icon name="file" :size="16" />
            <div style="flex: 1; font-weight: 600;">{{ fileName }}</div>
            <Pill v-if="busy" tone="cyan">parsing…</Pill>
            <Btn variant="ghost" size="sm" icon="x" @click="resetSource" />
          </div>
        </template>

        <!-- URL MODE -->
        <template v-else-if="mode === 'url'">
          <div class="row">
            <div class="input" style="flex: 1;">
              <Icon name="link" :size="14" />
              <input v-model="url" placeholder="https://provider.example.com/playlist.m3u" @keyup.enter="checkUrl" />
            </div>
            <Btn variant="primary" icon="import" :disabled="busy || !url.trim()" @click="checkUrl">
              {{ busy ? 'Fetching…' : 'Check' }}
            </Btn>
          </div>
        </template>

        <!-- HDHOMERUN MODE -->
        <template v-else-if="mode === 'hdhr'">
          <div class="field-lbl">HDHomeRun Address</div>
          <div class="row">
            <div class="input" style="flex: 1;">
              <Icon name="tv" :size="14" />
              <input v-model="hdhrAddress" placeholder="192.168.1.100" @keyup.enter="testHdhr" />
            </div>
            <Btn variant="primary" icon="refresh" :disabled="busy || !hdhrAddress.trim()" @click="testHdhr">
              {{ busy ? 'Testing…' : 'Test' }}
            </Btn>
          </div>
          <div v-if="hdhrInfo" style="margin-top: 12px; display: flex; flex-direction: column; gap: 8px;">
            <div class="row" style="flex-wrap: wrap; gap: 6px;">
              <Pill tone="good"><Icon name="check" :size="11" />{{ hdhrInfo.deviceName }}</Pill>
              <Pill v-if="hdhrInfo.model">{{ hdhrInfo.model }}</Pill>
              <Pill tone="cyan">{{ hdhrInfo.tunerCount }} tuner{{ hdhrInfo.tunerCount === 1 ? '' : 's' }}</Pill>
              <Pill tone="good">{{ hdhrInfo.channelCount }} channel{{ hdhrInfo.channelCount === 1 ? '' : 's' }}</Pill>
            </div>
            <div v-if="hdhrInfo.sampleChannels.length" class="muted" style="font-size: var(--fs-xs);">
              e.g. {{ hdhrInfo.sampleChannels.map((s) => s.name).join(' · ') }}
            </div>
          </div>
        </template>

        <!-- LOCAL NOW MODE -->
        <template v-else-if="mode === 'local'">
          <div class="field-lbl">City / Market</div>
          <div class="row">
            <div class="input" style="flex: 1;">
              <Icon name="map" :size="14" />
              <input v-model="cityQuery" placeholder="Search a city — e.g. New York, NY" @input="onCityInput" />
            </div>
            <Btn variant="ghost" icon="globe" :disabled="busy" @click="detectLocalMarket">
              {{ busy ? 'Detecting…' : 'Detect' }}
            </Btn>
          </div>
          <div v-if="searchingCities" class="muted" style="margin-top: 8px; font-size: var(--fs-xs);">
            <Icon name="refresh" :size="11" /> Searching…
          </div>
          <div v-if="cityResults.length" class="city-results">
            <button v-for="m in cityResults" :key="m.dma + m.market" type="button" class="city-opt" @click="pickMarket(m)">
              <Icon name="map" :size="13" />
              <span class="city-lbl">{{ m.label }}</span>
              <span class="city-dma">DMA {{ m.dma }}</span>
            </button>
          </div>
          <div v-if="selectedMarket" class="row" style="margin-top: 12px; flex-wrap: wrap; gap: 6px;">
            <Pill tone="good"><Icon name="check" :size="11" />{{ selectedMarket.label }}</Pill>
            <Pill tone="cyan">DMA {{ selectedMarket.dma }}</Pill>
          </div>
        </template>

        <div v-if="error" class="muted" style="margin-top: 10px; color: var(--bad);">
          <Icon name="warn" :size="12" /> {{ error }}
        </div>
        <div v-if="preview && preview.channels" style="margin-top: 12px; display: flex; flex-direction: column; gap: 8px;">
          <div class="row">
            <Pill tone="good">{{ preview.channels }} channel{{ preview.channels === 1 ? '' : 's' }} detected</Pill>
            <Pill>{{ preview.groups }} group{{ preview.groups === 1 ? '' : 's' }}</Pill>
          </div>
          <div v-if="preview.sample.length" class="muted" style="font-size: var(--fs-xs);">
            e.g. {{ preview.sample.map((s) => s.name).join(' · ') }}
          </div>
        </div>
      </div>
      <div class="modal-ft">
        <Btn variant="ghost" @click="emit('close')">Cancel</Btn>
        <Btn variant="primary" icon="check" :disabled="!ready || creating" @click="create">
          {{ creating ? 'Adding…' : 'Add playlist' }}
        </Btn>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Local Now City/Market typeahead results — a scrollable, hoverable pick list under the search box. */
.city-results {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-m);
  padding: 4px;
  background: var(--bg-2);
}
.city-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-s);
  cursor: pointer;
  text-align: left;
  color: var(--text-1);
  font: inherit;
}
.city-opt:hover {
  background: var(--bg-3);
}
.city-lbl {
  flex: 1;
  font-weight: 600;
}
.city-dma {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
</style>
