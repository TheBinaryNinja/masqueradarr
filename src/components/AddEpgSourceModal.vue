<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import Segmented from './Segmented.vue';
import { reloadEpgSources } from '../data';
import { fileToXmltvBody, type XmltvBody } from '../composables/xmltvUpload';
import {
  JESMANN_CATALOG,
  jesmannRegion,
  jesmannDefaultType,
  jesmannUrl,
  jesmannSourceName,
  type JesmannRegion,
  type JesmannType,
} from '../composables/jesmannCatalog';
import { useToast } from '../composables/useToast';

const emit = defineEmits<{ (e: 'close'): void }>();
const router = useRouter();
const toast = useToast();

// The created EpgSource doc rides back with an extra `offsetDefaulted` flag: warn when the operator's Time zone
// offset was unset, so the source's guide times were stamped UTC. See server/src/settings/programOffset.ts.
function warnIfOffsetDefaulted(result: unknown): void {
  if (result && typeof result === 'object' && (result as { offsetDefaulted?: boolean }).offsetDefaulted) {
    toast.lowerRight({
      tone: 'warn',
      title: 'Time zone offset not set',
      text: 'Stored guide times defaulted to UTC (+0000). Set a Time zone in Settings.',
    });
  }
}

const tab = ref<'gracenote' | 'jesmann' | 'epg-pw' | 'custom'>('gracenote');

interface Provider {
  type: string; device: string; lineupId: string; name: string;
  location: string; timezone: string; postalCode: string; headendId: string;
}
interface SampleItem { channelNo: string | null; callSign: string | null; title: string; start: number; end: number }
interface Summary { headendName: string | null; channelCount: number; programCount: number; sample: SampleItem[] }

const country = ref('USA');
const zip = ref('');
const providers = ref<Provider[]>([]);
const selected = ref<Provider | null>(null);
const summary = ref<Summary | null>(null);
const loadingProviders = ref(false);
const loadingPreview = ref(false);
const adding = ref(false);
const error = ref('');

function providerKey(p: Provider) { return `${p.headendId}:${p.lineupId}`; }

// ── EPG-PW tab state (kept separate so the two tabs don't collide) ─────────
interface Region { label: string; href: string; code: string }
interface PwSampleItem { channelNo: string | null; callSign: string | null; title: string; start: number; end: number }
interface PwSummary { regionName: string | null; channelCount: number; sample: PwSampleItem[] }

const regions = ref<Region[]>([]);
const selectedHref = ref('');
const pwSummary = ref<PwSummary | null>(null);
const loadingRegions = ref(false);
const loadingPwPreview = ref(false);
const pwError = ref('');
let regionsLoaded = false;

const selectedRegion = () => regions.value.find((r) => r.href === selectedHref.value) || null;

// ── Jesmann tab state (a guided picker over the hardcoded epg.jesmann.com catalog) ─────────
// The user picks a Region + Download type; the pair resolves to one concrete .xml URL that is created as a
// 'jesmann'-kind XMLTV source. It re-fetches exactly like a 'remote url' source (the backend treats both as
// re-fetchable XMLTV URLs), but carries its own 'jesmann' source type so 'remote url' stays reserved for the
// genuine Remote URL feature in the Custom tab.
const jesmannRegionId = ref('');
const jesmannTypeId = ref('');

// Limit the offered download types to the '3d*' variants only (ids '3d-std' / '3d-iptv' — the 3-day
// Standard / IPTV guides). The catalog itself stays a verbatim mirror of the site; the restriction is
// applied here at the picker so both the dropdown and the default-type selection honor it.
const JESMANN_TYPE_PREFIX = '3d';
const isJesmannAllowedType = (t: JesmannType) => t.id.startsWith(JESMANN_TYPE_PREFIX);

const jesmannSelectedRegion = computed<JesmannRegion | null>(() => jesmannRegion(jesmannRegionId.value));
// Only the '3d*' download-type variants this region actually offers (regions that ship just 14d/image
// variants — Individual Markets, Legacy Guides, Team Sports — yield an empty list and offer no type).
const jesmannTypes = computed<JesmannType[]>(
  () => (jesmannSelectedRegion.value?.types || []).filter(isJesmannAllowedType),
);
const jesmannSelectedType = computed<JesmannType | null>(
  () => jesmannTypes.value.find((t) => t.id === jesmannTypeId.value) || null,
);

// When the region changes, default the download type to the first offered '3d*' variant (prefers '3d
// Standard' since jesmannDefaultType orders it ahead of '3d IPTV'), else clear when none is offered.
function onJesmannRegionChange() {
  const allowed = jesmannTypes.value;
  if (!allowed.length) { jesmannTypeId.value = ''; return; }
  const def = jesmannDefaultType({ ...(jesmannSelectedRegion.value as JesmannRegion), types: allowed });
  jesmannTypeId.value = def?.id || allowed[0].id;
}

async function addJesmann() {
  const r = jesmannSelectedRegion.value;
  const t = jesmannSelectedType.value;
  if (!r || !t || adding.value) return;
  adding.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/epg-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'jesmann', name: jesmannSourceName(r, t), url: jesmannUrl(r, t) }),
    });
    if (!res.ok) throw new Error('add failed');
    warnIfOffsetDefaulted(await res.json());
    // Programs + epg-channels are loaded lazily now (the EPG Detail / Mapping screens fetch them on
    // demand), so a new/synced source only needs the source list refreshed here.
    await reloadEpgSources();
    emit('close');
    router.push('/epg-sources');
  } catch {
    error.value = 'Could not add the source — please try again.';
    adding.value = false;
  }
}

// ── Custom tab state (Upload XML / Remote URL — an XMLTV file or a re-fetchable URL) ─────────
interface XmltvSampleItem { channelNo: string | null; callSign: string | null; title: string; start: number; end: number }
interface XmltvValidation { ok: boolean; channelCount: number; programmeCount: number; sample: XmltvSampleItem[]; errors: string[] }

const customMode = ref<'file' | 'url'>('file');
const customName = ref('');
const customFileInput = ref<HTMLInputElement | null>(null);
const customFileName = ref('');
const customBody = ref<XmltvBody | null>(null); // gzipped (or raw) file body, reused for validate + create
const customUrl = ref(''); // remote XMLTV URL (url mode)
const xmltvValid = ref<XmltvValidation | null>(null);
const xmltvError = ref('');
const validating = ref(false);

const customReady = computed(() => customName.value.trim().length > 0 && !!xmltvValid.value?.ok);

function defaultCustomName(from: string) {
  if (!customName.value.trim()) customName.value = from.replace(/\.[^.]+$/, '') || from;
}
function resetCustom() {
  customFileName.value = '';
  customBody.value = null;
  customUrl.value = '';
  xmltvValid.value = null;
  xmltvError.value = '';
  if (customFileInput.value) customFileInput.value.value = '';
}
function switchCustomMode(m: 'file' | 'url') {
  if (customMode.value === m) return;
  customMode.value = m;
  resetCustom();
}

// Validate-only pre-flight against the backend → honest channel/program counts + a sample, or a list of
// specific issues, before the user commits. (The XMLTV analogue of the M3U import preview.) The file path
// POSTs the gzipped body; the url path POSTs a tiny JSON { url } the server re-fetches.
async function runValidate(init: RequestInit) {
  validating.value = true;
  xmltvError.value = '';
  xmltvValid.value = null;
  try {
    const res = await fetch('/api/epg-sources/xmltv/validate', { method: 'POST', ...init });
    if (!res.ok) {
      const code = (await res.json().catch(() => ({}))).error;
      throw new Error(code === 'xmltv_unreachable' ? 'Could not fetch the XMLTV file from that URL.' : `HTTP ${res.status}`);
    }
    xmltvValid.value = (await res.json()) as XmltvValidation;
  } catch (e) {
    xmltvError.value = (e as Error).message;
  } finally {
    validating.value = false;
  }
}

async function onCustomFileChange(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  customFileName.value = f.name;
  defaultCustomName(f.name);
  validating.value = true;
  xmltvError.value = '';
  xmltvValid.value = null;
  try {
    customBody.value = await fileToXmltvBody(f); // gzip in-stream (or pass a .xml.gz through)
  } catch (e) {
    xmltvError.value = (e as Error).message;
    validating.value = false;
    return;
  }
  await runValidate({ headers: { 'Content-Type': customBody.value.contentType }, body: customBody.value.body });
}

async function checkXmltvUrl() {
  if (!customUrl.value.trim() || validating.value) return;
  defaultCustomName(customUrl.value.split('/').pop() || 'XMLTV guide');
  await runValidate({
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: customUrl.value.trim() }),
  });
}

// Create the Custom source: 'xml file' (POST the gzipped guide body, metadata in the query) or 'remote url'
// (POST a tiny JSON { url } the server re-fetches). Then refresh the EPG stores + the mapping screen's
// channel list and open the list.
async function addCustom() {
  if (!customReady.value || adding.value) return;
  adding.value = true;
  xmltvError.value = '';
  try {
    let res: Response;
    if (customMode.value === 'file') {
      if (!customBody.value) throw new Error('no file');
      const q = new URLSearchParams({
        source: 'xml file',
        name: customName.value.trim(),
        filename: customFileName.value,
      });
      res = await fetch(`/api/epg-sources?${q.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': customBody.value.contentType },
        body: customBody.value.body,
      });
    } else {
      res = await fetch('/api/epg-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'remote url', name: customName.value.trim(), url: customUrl.value.trim() }),
      });
    }
    if (!res.ok) throw new Error('add failed');
    warnIfOffsetDefaulted(await res.json());
    // Programs + epg-channels are loaded lazily now (the EPG Detail / Mapping screens fetch them on
    // demand), so a new/synced source only needs the source list refreshed here.
    await reloadEpgSources();
    emit('close');
    router.push('/epg-sources');
  } catch {
    xmltvError.value = 'Could not add the source — please try again.';
    adding.value = false;
  }
}

async function loadRegions() {
  if (regionsLoaded || loadingRegions.value) return;
  pwError.value = '';
  loadingRegions.value = true;
  try {
    const res = await fetch('/api/epg-sources/epgpw/regions');
    if (!res.ok) throw new Error('regions failed');
    const data = await res.json();
    regions.value = (data.regions || []) as Region[];
    regionsLoaded = true;
    if (!regions.value.length) pwError.value = 'No regions available right now.';
  } catch {
    pwError.value = 'Could not reach EPG-PW — please try again.';
  } finally {
    loadingRegions.value = false;
  }
}

function onTabChange(v: string) {
  tab.value = v as 'gracenote' | 'jesmann' | 'epg-pw' | 'custom';
  if (tab.value === 'epg-pw') loadRegions();
}

async function previewRegion() {
  const r = selectedRegion();
  pwSummary.value = null;
  pwError.value = '';
  if (!r) { pwError.value = 'Pick a region first.'; return; }
  loadingPwPreview.value = true;
  try {
    const q = new URLSearchParams({ href: r.href, region: r.label });
    const res = await fetch(`/api/epg-sources/epgpw/preview?${q.toString()}`);
    if (!res.ok) throw new Error('preview failed');
    pwSummary.value = (await res.json()) as PwSummary;
  } catch {
    pwError.value = 'Could not load a preview for this region.';
  } finally {
    loadingPwPreview.value = false;
  }
}

async function addEpgpw() {
  const r = selectedRegion();
  if (!r) return;
  adding.value = true;
  pwError.value = '';
  try {
    const res = await fetch('/api/epg-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'epg-pw', region: r.label, href: r.href }),
    });
    if (!res.ok) throw new Error('add failed');
    warnIfOffsetDefaulted(await res.json());
    await reloadEpgSources();
    emit('close');
    router.push('/epg-sources');
  } catch {
    pwError.value = 'Could not add the source — please try again.';
    adding.value = false;
  }
}

async function findProviders() {
  error.value = '';
  selected.value = null;
  summary.value = null;
  providers.value = [];
  const pc = zip.value.trim();
  if (!pc) { error.value = 'Enter a ZIP / postal code first.'; return; }
  loadingProviders.value = true;
  try {
    const res = await fetch(
      `/api/epg-sources/gracenote/providers?postalCode=${encodeURIComponent(pc)}&country=${encodeURIComponent(country.value)}`,
    );
    if (!res.ok) throw new Error('lookup failed');
    const data = await res.json();
    providers.value = (data.providers || []) as Provider[];
    if (!providers.value.length) error.value = 'No providers found for that code.';
  } catch {
    error.value = 'Could not reach Gracenote — please try again.';
  } finally {
    loadingProviders.value = false;
  }
}

async function selectProvider(p: Provider) {
  selected.value = p;
  summary.value = null;
  error.value = '';
  loadingPreview.value = true;
  try {
    const q = new URLSearchParams({
      headendId: p.headendId, lineupId: p.lineupId, device: p.device, postalCode: p.postalCode,
      country: country.value, timezone: p.timezone, type: p.type, name: p.name, location: p.location,
    });
    const res = await fetch(`/api/epg-sources/gracenote/preview?${q.toString()}`);
    if (!res.ok) throw new Error('preview failed');
    summary.value = (await res.json()) as Summary;
  } catch {
    error.value = 'Could not load a preview for this provider.';
  } finally {
    loadingPreview.value = false;
  }
}

function fmtTime(ms: number) {
  if (!ms || Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

async function add() {
  const p = selected.value;
  if (!p) return;
  adding.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/epg-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        headendId: p.headendId, lineupId: p.lineupId, name: p.name, location: p.location,
        type: p.type, device: p.device, timezone: p.timezone, postalCode: p.postalCode,
        country: country.value,
      }),
    });
    if (!res.ok) throw new Error('add failed');
    warnIfOffsetDefaulted(await res.json());
    await reloadEpgSources();
    emit('close');
    router.push('/epg-sources');
  } catch {
    error.value = 'Could not add the source — please try again.';
    adding.value = false;
  }
}
</script>

<template>
  <div class="modal-bg" @click="emit('close')">
    <div class="modal" @click.stop>
      <div class="modal-hd">
        <Icon name="epg" :size="18" />
        <h2>Add EPG Source</h2>
        <span class="spacer" />
        <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
      </div>

      <div class="modal-body" style="gap: 16px;">
        <Segmented
          :value="tab"
          :options="[
            { value: 'gracenote', label: 'Gracenote', icon: 'tv' },
            { value: 'jesmann', label: 'Jesmann', icon: 'epg' },
            { value: 'epg-pw', label: 'EPG-PW', icon: 'globe' },
            { value: 'custom', label: 'Custom', icon: 'upload' },
          ]"
          @change="onTabChange"
        />

        <!-- Gracenote -->
        <div v-if="tab === 'gracenote'" style="display: flex; flex-direction: column; gap: 14px; max-height: 58vh; overflow-y: auto;">
          <div class="form-grid-2">
            <div class="form-row">
              <div class="field-lbl">Country</div>
              <div class="select"><select v-model="country">
                <option value="USA">United States</option>
                <option value="CAN">Canada</option>
              </select></div>
            </div>
            <div class="form-row">
              <div class="field-lbl">ZIP / Postal code</div>
              <div class="input">
                <Icon name="search" :size="14" />
                <input v-model="zip" placeholder="e.g. 23120" @keyup.enter="findProviders" />
              </div>
            </div>
          </div>
          <div>
            <Btn variant="primary" icon="search" :disabled="loadingProviders" @click="findProviders">
              {{ loadingProviders ? 'Searching…' : 'Find providers' }}
            </Btn>
          </div>

          <div v-if="error" class="muted" style="color: var(--bad); font-size: var(--fs-sm);">{{ error }}</div>

          <!-- Provider list -->
          <div v-if="providers.length" style="display: flex; flex-direction: column; gap: 6px;">
            <div class="field-lbl">Choose a provider</div>
            <button
              v-for="p in providers"
              :key="providerKey(p)"
              type="button"
              :style="{
                display: 'flex', alignItems: 'center', gap: '10px', textAlign: 'left',
                padding: '10px 12px', borderRadius: 'var(--radius-s)', cursor: 'pointer',
                background: selected && providerKey(selected) === providerKey(p) ? 'var(--accent-soft)' : 'var(--bg-1)',
                border: '1px solid ' + (selected && providerKey(selected) === providerKey(p) ? 'var(--accent)' : 'var(--hairline)'),
              }"
              @click="selectProvider(p)"
            >
              <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ p.name }}</div>
                <div class="muted" style="font-size: var(--fs-xs);">{{ p.location || '—' }}</div>
              </div>
              <Pill tone="cyan">{{ p.type }}</Pill>
              <Icon
                v-if="selected && providerKey(selected) === providerKey(p)"
                name="check" :size="14" style="color: var(--accent-hi);"
              />
            </button>
          </div>

          <!-- Preview summary -->
          <div v-if="loadingPreview" class="muted" style="font-size: var(--fs-sm);">Loading listings…</div>
          <div v-else-if="summary" class="card" style="background: var(--bg-2); padding: 14px; display: flex; flex-direction: column; gap: 10px;">
            <div class="row" style="gap: 8px; align-items: center;">
              <Pill tone="good">{{ summary.channelCount }} channels</Pill>
              <Pill>{{ summary.programCount.toLocaleString() }} programs</Pill>
              <span class="spacer" />
              <span class="muted mono" style="font-size: var(--fs-xs);">{{ summary.headendName }}</span>
            </div>
            <div v-if="summary.sample.length" style="display: flex; flex-direction: column; gap: 4px;">
              <div v-for="(s, i) in summary.sample" :key="i" class="row" style="gap: 8px; font-size: var(--fs-sm);">
                <span class="mono muted" style="min-width: 42px;">{{ s.channelNo }}</span>
                <span class="mono muted" style="min-width: 64px;">{{ s.callSign }}</span>
                <span style="flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ s.title }}</span>
                <span class="mono muted" style="font-size: var(--fs-xs);">{{ fmtTime(s.start) }}–{{ fmtTime(s.end) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Jesmann (guided picker → a single 'jesmann' XMLTV source) -->
        <div v-else-if="tab === 'jesmann'" style="display: flex; flex-direction: column; gap: 14px; max-height: 58vh; overflow-y: auto;">
          <div class="form-grid-2">
            <div class="form-row">
              <div class="field-lbl">Region</div>
              <div class="select">
                <select v-model="jesmannRegionId" @change="onJesmannRegionChange">
                  <option value="" disabled>Choose a region</option>
                  <optgroup v-for="g in JESMANN_CATALOG" :key="g.group" :label="g.group">
                    <option v-for="r in g.regions" :key="r.id" :value="r.id">{{ r.name }}</option>
                  </optgroup>
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="field-lbl">Download type</div>
              <div class="select">
                <select v-model="jesmannTypeId" :disabled="!jesmannTypes.length">
                  <option value="" disabled>{{ jesmannTypes.length ? 'Choose a type' : 'Pick a region first' }}</option>
                  <option v-for="t in jesmannTypes" :key="t.id" :value="t.id">{{ t.label }}</option>
                </select>
              </div>
            </div>
          </div>

          <div v-if="jesmannSelectedType" class="card" style="background: var(--bg-2); padding: 14px; display: flex; flex-direction: column; gap: 6px;">
            <div class="row" style="gap: 8px; align-items: center;">
              <Pill tone="cyan">{{ jesmannSelectedType.label }}</Pill>
              <span class="spacer" />
              <span class="muted mono" style="font-size: var(--fs-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ jesmannUrl(jesmannSelectedRegion!, jesmannSelectedType) }}</span>
            </div>
            <div class="muted" style="font-size: var(--fs-xs);">Added as an XMLTV source — the URL is stored and re-fetched on Sync.</div>
          </div>

          <div class="muted" style="font-size: var(--fs-xs); display: flex; gap: 6px; align-items: flex-start;">
            <Icon name="epg" :size="13" />
            <span>Guides from <strong>epg.jesmann.com</strong> are for personal use only.</span>
          </div>
        </div>

        <!-- EPG-PW -->
        <div v-else-if="tab === 'epg-pw'" style="display: flex; flex-direction: column; gap: 14px; max-height: 58vh; overflow-y: auto;">
          <div class="form-row">
            <div class="field-lbl">Region</div>
            <div class="select">
              <select v-model="selectedHref" :disabled="loadingRegions">
                <option value="" disabled>{{ loadingRegions ? 'Loading regions…' : 'Choose a region' }}</option>
                <option v-for="r in regions" :key="r.code" :value="r.href">{{ r.label }}</option>
              </select>
            </div>
          </div>
          <div>
            <Btn variant="primary" icon="search" :disabled="!selectedHref || loadingPwPreview" @click="previewRegion">
              {{ loadingPwPreview ? 'Loading…' : 'Preview region' }}
            </Btn>
          </div>

          <div v-if="pwError" class="muted" style="color: var(--bad); font-size: var(--fs-sm);">{{ pwError }}</div>

          <!-- Preview summary -->
          <div v-if="loadingPwPreview" class="muted" style="font-size: var(--fs-sm);">Loading listings…</div>
          <div v-else-if="pwSummary" class="card" style="background: var(--bg-2); padding: 14px; display: flex; flex-direction: column; gap: 10px;">
            <div class="row" style="gap: 8px; align-items: center;">
              <Pill tone="good">{{ pwSummary.channelCount.toLocaleString() }} channels</Pill>
              <span class="spacer" />
              <span class="muted mono" style="font-size: var(--fs-xs);">{{ pwSummary.regionName }}</span>
            </div>
            <div v-if="pwSummary.sample.length" style="display: flex; flex-direction: column; gap: 4px;">
              <div v-for="(s, i) in pwSummary.sample" :key="i" class="row" style="gap: 8px; font-size: var(--fs-sm);">
                <span class="mono muted" style="min-width: 64px;">{{ s.callSign }}</span>
                <span style="flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ s.title }}</span>
                <span class="mono muted" style="font-size: var(--fs-xs);">{{ fmtTime(s.start) }}–{{ fmtTime(s.end) }}</span>
              </div>
            </div>
          </div>

          <div v-if="selectedHref" class="muted" style="font-size: var(--fs-xs); display: flex; gap: 6px; align-items: flex-start;">
            <Icon name="epg" :size="13" />
            <span>Large regions can have thousands of channels — adding fetches every channel's guide and may take a few minutes.</span>
          </div>
        </div>

        <!-- Custom (Upload XML / Remote URL) -->
        <div v-else-if="tab === 'custom'" style="display: flex; flex-direction: column; gap: 14px; max-height: 58vh; overflow-y: auto;">
          <div class="form-row">
            <div class="field-lbl">Source name</div>
            <div class="input"><input v-model="customName" placeholder="My XMLTV guide" /></div>
          </div>

          <div class="field-lbl">Import guide from</div>
          <div class="segmented">
            <button :class="customMode === 'file' ? 'active' : ''" @click="switchCustomMode('file')">
              <Icon name="upload" :size="13" />Upload XML
            </button>
            <button :class="customMode === 'url' ? 'active' : ''" @click="switchCustomMode('url')">
              <Icon name="link" :size="13" />Remote URL
            </button>
          </div>

          <input
            ref="customFileInput"
            type="file"
            accept=".xml,.xmltv,.gz,.xml.gz,application/xml,text/xml,application/gzip"
            style="display: none;"
            @change="onCustomFileChange"
          />

          <!-- Upload XML -->
          <template v-if="customMode === 'file'">
            <div v-if="!customFileName" class="dropzone" @click="customFileInput?.click()">
              <div class="icon-circle"><Icon name="upload" :size="20" /></div>
              <div>
                <h3>Choose an XMLTV file</h3>
                <p>click to browse — .xml or .xml.gz, up to ~150 MB</p>
              </div>
            </div>
            <div v-else class="row">
              <Icon name="file" :size="16" />
              <div style="flex: 1; font-weight: 600;">{{ customFileName }}</div>
              <Pill v-if="validating" tone="cyan">validating…</Pill>
              <Btn variant="ghost" size="sm" icon="x" @click="resetCustom" />
            </div>
          </template>

          <!-- Remote URL -->
          <template v-else>
            <div class="row">
              <div class="input" style="flex: 1;">
                <Icon name="link" :size="14" />
                <input v-model="customUrl" placeholder="https://example.com/guide.xml" @keyup.enter="checkXmltvUrl" />
              </div>
              <Btn variant="primary" icon="import" :disabled="validating || !customUrl.trim()" @click="checkXmltvUrl">
                {{ validating ? 'Checking…' : 'Check' }}
              </Btn>
            </div>
            <div class="muted" style="font-size: var(--fs-xs); display: flex; gap: 6px; align-items: flex-start;">
              <Icon name="epg" :size="13" />
              <span>The URL is stored and re-fetched on Sync. A <strong>.xml</strong> or gzipped <strong>.xml.gz</strong> XMLTV feed.</span>
            </div>
          </template>

          <!-- Validation feedback: success summary or the specific issues found -->
          <div v-if="validating" class="muted" style="font-size: var(--fs-sm);">Validating XMLTV…</div>
          <div
            v-else-if="xmltvValid && xmltvValid.ok"
            class="card"
            style="background: var(--bg-2); padding: 14px; display: flex; flex-direction: column; gap: 10px;"
          >
            <div class="row" style="gap: 8px; align-items: center;">
              <Pill tone="good"><Icon name="check" :size="11" />{{ xmltvValid.channelCount.toLocaleString() }} channels</Pill>
              <Pill>{{ xmltvValid.programmeCount.toLocaleString() }} programs</Pill>
            </div>
            <div v-if="xmltvValid.sample.length" style="display: flex; flex-direction: column; gap: 4px;">
              <div v-for="(s, i) in xmltvValid.sample" :key="i" class="row" style="gap: 8px; font-size: var(--fs-sm);">
                <span class="mono muted" style="min-width: 64px; max-width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ s.callSign }}</span>
                <span style="flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ s.title }}</span>
                <span class="mono muted" style="font-size: var(--fs-xs);">{{ fmtTime(s.start) }}–{{ fmtTime(s.end) }}</span>
              </div>
            </div>
          </div>
          <div v-else-if="xmltvValid && !xmltvValid.ok" style="display: flex; flex-direction: column; gap: 4px;">
            <div
              v-for="(e, i) in xmltvValid.errors"
              :key="i"
              class="muted"
              style="color: var(--bad); font-size: var(--fs-sm); display: flex; gap: 6px; align-items: flex-start;"
            >
              <Icon name="warn" :size="12" /><span>{{ e }}</span>
            </div>
          </div>
          <div v-if="xmltvError" class="muted" style="color: var(--bad); font-size: var(--fs-sm);">{{ xmltvError }}</div>
        </div>
      </div>

      <div class="modal-ft">
        <Btn variant="ghost" @click="emit('close')">Cancel</Btn>
        <Btn
          v-if="tab === 'gracenote'"
          variant="primary"
          icon="check"
          :disabled="!selected || adding"
          @click="add"
        >
          {{ adding ? 'Adding…' : 'Add & sync' }}
        </Btn>
        <Btn
          v-else-if="tab === 'jesmann'"
          variant="primary"
          icon="check"
          :disabled="!jesmannSelectedType || adding"
          @click="addJesmann"
        >
          {{ adding ? 'Syncing…' : 'Add & sync' }}
        </Btn>
        <Btn
          v-else-if="tab === 'epg-pw'"
          variant="primary"
          icon="check"
          :disabled="!selectedHref || adding"
          @click="addEpgpw"
        >
          {{ adding ? 'Syncing channels & programs…' : 'Add & sync' }}
        </Btn>
        <Btn
          v-else
          variant="primary"
          icon="check"
          :disabled="!customReady || adding"
          @click="addCustom"
        >
          {{ adding ? (customMode === 'file' ? 'Importing…' : 'Syncing…') : (customMode === 'file' ? 'Add & import' : 'Add & sync') }}
        </Btn>
      </div>
    </div>
  </div>
</template>
