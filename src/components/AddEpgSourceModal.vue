<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import Segmented from './Segmented.vue';
import ProgressBar from './ProgressBar.vue';
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

// Live size-probe state. A region's variant URLs are HEAD-probed on the SERVER (the SPA can't reach
// epg.jesmann.com directly — CORS + the outbound DNS override lives server-side) so the picker can list every
// download with its real size and grey out ones that aren't available. Keyed by the absolute variant URL.
const jesmannProbing = ref(false);
const jesmannProbeError = ref('');
const jesmannProbe = ref<Record<string, { available: boolean; size: number | null; gzip: boolean }>>({});
const jesmannProbed = computed(() => Object.keys(jesmannProbe.value).length > 0);

// Shared live execution feedback for EVERY Add tab, driven by the streaming NDJSON response. `importPhase`
// advances idle → downloading → importing → error (a `done` line closes the modal); `importPercent` is the
// 0..100 completion when the server can compute it, else null (indeterminate bar). `jesmannError` stays a
// DEDICATED error ref — the Jesmann tab shows its failure in the footer; the other tabs use their body refs.
const importPhase = ref<'idle' | 'downloading' | 'importing' | 'error'>('idle');
const importPercent = ref<number | null>(null);
const jesmannError = ref('');

// Shared success tail: every tab does the same thing once a source is created — surface the UTC-offset
// warning, refresh the (lazily-loaded) source list, close the modal, and open the EPG Sources screen.
async function finishImport(source: unknown) {
  warnIfOffsetDefaulted(source);
  await reloadEpgSources();
  emit('close');
  router.push('/epg-sources');
}

// Shared streaming-import engine behind EVERY Add tab. POSTs with `Accept: application/x-ndjson` so the
// server streams `{ phase, percent }` lines (one JSON object per line); updates the shared importPhase /
// importPercent as they arrive. Returns the `done` payload's source on success, or throws a mapped message
// on a pre-stream failure / an `{ phase:'error' }` line. (Generalized from the original Jesmann-only reader.)
async function runNdjsonImport(
  input: string,
  init: RequestInit,
  mapError: (code: unknown) => string,
): Promise<unknown> {
  importPhase.value = 'downloading';
  importPercent.value = null;
  const res = await fetch(input, {
    ...init,
    headers: { ...((init.headers as Record<string, string>) || {}), Accept: 'application/x-ndjson' },
  });
  // A pre-stream failure (e.g. a 400 validation / 502 before the NDJSON body opens) arrives as a JSON error.
  if (!res.ok || !res.body) {
    const code = (await res.json().catch(() => ({}))).error;
    throw new Error(mapError(code));
  }
  // Read the NDJSON stream line by line: phase/percent drive the footer + bar; the done payload carries the
  // created source; an error line yields a mapped failure message thrown after the stream ends.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let donePayload: { source?: unknown } | null = null;
  let failMessage = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: { phase?: string; source?: unknown; percent?: number; error?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.phase === 'downloading' || msg.phase === 'importing') {
        importPhase.value = msg.phase;
        if (typeof msg.percent === 'number') importPercent.value = msg.percent;
      } else if (msg.phase === 'done') {
        donePayload = { source: msg.source };
      } else if (msg.phase === 'error') {
        failMessage = mapError(msg.error);
      }
    }
  }
  if (failMessage) throw new Error(failMessage);
  if (!donePayload) throw new Error('Could not add the source — please try again.');
  return donePayload.source;
}

// Per-tab error-code → friendly message mappers (the precedent set by jesmannErrorMessage). An unmapped /
// unknown code falls back to the generic add failure.
function gracenoteErrorMessage(code: unknown): string {
  if (code === 'gracenote_unreachable') return 'Could not reach Gracenote — please try again.';
  return 'Could not add the source — please try again.';
}
function epgpwErrorMessage(code: unknown): string {
  if (code === 'epgpw_unreachable') return 'Could not reach EPG-PW — please try again.';
  return 'Could not add the source — please try again.';
}
function customErrorMessage(code: unknown): string {
  if (code === 'xmltv_unreachable') return 'Could not fetch the XMLTV file from that URL.';
  return 'Could not add the source — please try again.';
}

const jesmannSelectedRegion = computed<JesmannRegion | null>(() => jesmannRegion(jesmannRegionId.value));
// EVERY download-type variant this region offers (14d / 7d / 3d × Standard / IPTV, plus the specials — Team
// Sports image variants, Individual Markets 14d-only, Legacy). No client-side filtering: the picker lists all
// available downloads and lets the user pick by size.
const jesmannTypes = computed<JesmannType[]>(() => jesmannSelectedRegion.value?.types || []);
const jesmannSelectedType = computed<JesmannType | null>(
  () => jesmannTypes.value.find((t) => t.id === jesmannTypeId.value) || null,
);

// The picker rows: each catalog variant joined with its probe result. Before/without a probe a variant is
// assumed available with an unknown size, so the list renders immediately and degrades gracefully if the probe
// fails.
const jesmannOptions = computed(() => {
  const region = jesmannSelectedRegion.value;
  if (!region) return [];
  return jesmannTypes.value.map((t) => {
    const url = jesmannUrl(region, t);
    const p = jesmannProbe.value[url];
    return {
      type: t,
      url,
      probed: !!p,
      available: p ? p.available : true,
      size: p?.size ?? null,
      gzip: p?.gzip ?? false,
    };
  });
});
const jesmannHasAvailable = computed(() => jesmannOptions.value.some((o) => o.available));

// Human-readable byte size (e.g. '412.3 MB'). Local copy — the repo keeps a small per-component formatter
// (HistoryMetricsScreen / RestoreBackupModal / DashboardScreen) rather than a shared util.
function formatBytes(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return 'unknown';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(k)));
  return `${parseFloat((n / k ** i).toFixed(1))} ${units[i]}`;
}

// On region change, probe all of that region's variant URLs for availability + size, then default-select the
// first AVAILABLE variant. The probe is an ENHANCEMENT: if it fails, every variant stays selectable with an
// unknown size so the user can still add a source.
async function onJesmannRegionChange() {
  jesmannTypeId.value = '';
  jesmannProbe.value = {};
  jesmannProbeError.value = '';
  jesmannError.value = '';
  importPhase.value = 'idle';
  const region = jesmannSelectedRegion.value;
  if (!region || !region.types.length) return;
  const urls = region.types.map((t) => jesmannUrl(region, t));
  jesmannProbing.value = true;
  try {
    const res = await fetch('/api/epg-sources/jesmann/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls }),
    });
    if (!res.ok) throw new Error('probe failed');
    const data = (await res.json()) as {
      results: Array<{ url: string; available: boolean; size: number | null; gzip: boolean }>;
    };
    const map: Record<string, { available: boolean; size: number | null; gzip: boolean }> = {};
    for (const r of data.results) map[r.url] = { available: r.available, size: r.size, gzip: r.gzip };
    jesmannProbe.value = map;
  } catch {
    jesmannProbeError.value = 'Could not check sizes — they will show as unknown.';
  } finally {
    jesmannProbing.value = false;
  }
  selectFirstAvailableJesmann();
}

// Default-select the first AVAILABLE variant, preferring the region's usual default type order.
function selectFirstAvailableJesmann() {
  const region = jesmannSelectedRegion.value;
  if (!region) { jesmannTypeId.value = ''; return; }
  const available = jesmannOptions.value.filter((o) => o.available);
  if (!available.length) { jesmannTypeId.value = ''; return; }
  const def = jesmannDefaultType({ ...region, types: available.map((o) => o.type) });
  jesmannTypeId.value = def?.id || available[0].type.id;
}

// Map a tagged server error code to a friendly message (the precedent in runValidate). Jesmann's only
// expected failure is an unreachable / temporarily-missing guide.
function jesmannErrorMessage(code: unknown): string {
  if (code === 'xmltv_unreachable') {
    return 'Could not reach epg.jesmann.com — the guide may be temporarily unavailable.';
  }
  return 'Could not add the source — please try again.';
}

// Create a Jesmann source via the shared NDJSON reader so the footer shows the live status + percent
// (Downloading… → Importing & parsing… N%). On {phase:'done'} we close the modal; on any failure the modal
// stays open, the buttons re-enable, and the reason shows in the footer.
async function addJesmann() {
  const r = jesmannSelectedRegion.value;
  const t = jesmannSelectedType.value;
  if (!r || !t || adding.value) return;
  adding.value = true;
  jesmannError.value = '';
  try {
    const source = await runNdjsonImport(
      '/api/epg-sources/jesmann/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'jesmann', name: jesmannSourceName(r, t), url: jesmannUrl(r, t) }),
      },
      jesmannErrorMessage,
    );
    await finishImport(source);
  } catch (e) {
    jesmannError.value = (e as Error).message || 'Could not add the source — please try again.';
    importPhase.value = 'error';
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
    let input: string;
    let init: RequestInit;
    if (customMode.value === 'file') {
      if (!customBody.value) throw new Error('no file');
      const q = new URLSearchParams({
        source: 'xml file',
        name: customName.value.trim(),
        filename: customFileName.value,
      });
      input = `/api/epg-sources?${q.toString()}`;
      init = { method: 'POST', headers: { 'Content-Type': customBody.value.contentType }, body: customBody.value.body };
    } else {
      input = '/api/epg-sources';
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'remote url', name: customName.value.trim(), url: customUrl.value.trim() }),
      };
    }
    const source = await runNdjsonImport(input, init, customErrorMessage);
    await finishImport(source);
  } catch (e) {
    xmltvError.value = (e as Error).message || 'Could not add the source — please try again.';
    importPhase.value = 'error';
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
  if (adding.value) return; // Segmented is :value-controlled, so a no-op keeps the current tab while busy.
  tab.value = v as 'gracenote' | 'jesmann' | 'epg-pw' | 'custom';
  importPhase.value = 'idle'; // clear any stale status/percent from a prior tab's failed attempt
  importPercent.value = null;
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
    const source = await runNdjsonImport(
      '/api/epg-sources',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'epg-pw', region: r.label, href: r.href }),
      },
      epgpwErrorMessage,
    );
    await finishImport(source);
  } catch (e) {
    pwError.value = (e as Error).message || 'Could not add the source — please try again.';
    importPhase.value = 'error';
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
    const source = await runNdjsonImport(
      '/api/epg-sources',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          headendId: p.headendId, lineupId: p.lineupId, name: p.name, location: p.location,
          type: p.type, device: p.device, timezone: p.timezone, postalCode: p.postalCode,
          country: country.value,
        }),
      },
      gracenoteErrorMessage,
    );
    await finishImport(source);
  } catch (e) {
    error.value = (e as Error).message || 'Could not add the source — please try again.';
    importPhase.value = 'error';
    adding.value = false;
  }
}
</script>

<template>
  <div class="modal-bg" @click="adding || emit('close')">
    <div class="modal" @click.stop>
      <div class="modal-hd">
        <Icon name="epg" :size="18" />
        <h2>Add EPG Source</h2>
        <span class="spacer" />
        <Btn variant="ghost" size="sm" icon="x" :disabled="adding" @click="emit('close')" />
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
          <div class="form-row">
            <div class="field-lbl">Region</div>
            <div class="select">
              <select v-model="jesmannRegionId" :disabled="adding" @change="onJesmannRegionChange">
                <option value="" disabled>Choose a region</option>
                <optgroup v-for="g in JESMANN_CATALOG" :key="g.group" :label="g.group">
                  <option v-for="r in g.regions" :key="r.id" :value="r.id">{{ r.name }}</option>
                </optgroup>
              </select>
            </div>
          </div>

          <!-- Available downloads for the region, each with its live-probed size — pick by size -->
          <div v-if="jesmannSelectedRegion" style="display: flex; flex-direction: column; gap: 6px;">
            <div class="field-lbl">
              Available downloads
              <span v-if="jesmannProbing" class="muted" style="font-size: var(--fs-xs);"> — checking sizes…</span>
            </div>
            <button
              v-for="o in jesmannOptions"
              :key="o.type.id"
              type="button"
              :disabled="(o.probed && !o.available) || adding"
              :style="{
                display: 'flex', alignItems: 'center', gap: '10px', textAlign: 'left',
                padding: '10px 12px', borderRadius: 'var(--radius-s)',
                cursor: o.probed && !o.available ? 'not-allowed' : 'pointer',
                opacity: o.probed && !o.available ? 0.45 : 1,
                background: jesmannTypeId === o.type.id ? 'var(--accent-soft)' : 'var(--bg-1)',
                border: '1px solid ' + (jesmannTypeId === o.type.id ? 'var(--accent)' : 'var(--hairline)'),
              }"
              @click="(o.available || !o.probed) && (jesmannTypeId = o.type.id)"
            >
              <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 500;">{{ o.type.label }}</div>
                <div class="muted" style="font-size: var(--fs-xs);">
                  {{ o.probed ? (o.available ? formatBytes(o.size) + (o.gzip ? ' · gzip' : '') : 'unavailable') : 'size unknown' }}
                </div>
              </div>
              <Pill v-if="o.probed && o.available" tone="cyan">{{ formatBytes(o.size) }}</Pill>
              <Icon v-if="jesmannTypeId === o.type.id" name="check" :size="14" style="color: var(--accent-hi);" />
            </button>
            <div v-if="!jesmannProbing && jesmannProbed && !jesmannHasAvailable" class="muted" style="color: var(--bad); font-size: var(--fs-sm);">
              No downloads are available for this region right now.
            </div>
            <div v-if="jesmannProbeError" class="muted" style="font-size: var(--fs-xs);">{{ jesmannProbeError }}</div>
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
        <!-- Live execution status (all tabs): phase text + % while importing, pushed to the LEFT of the
             buttons. A Jesmann failure also surfaces here (its tab has no body error slot); the other tabs
             show their failure in-body, so for them this only renders while `adding`. -->
        <span
          v-if="adding || (tab === 'jesmann' && importPhase === 'error' && jesmannError)"
          class="muted"
          :style="{
            marginRight: 'auto', fontSize: 'var(--fs-sm)', display: 'flex', alignItems: 'center', gap: '6px',
            color: importPhase === 'error' ? 'var(--bad)' : undefined,
          }"
        >
          <template v-if="adding">
            <template v-if="importPhase === 'importing'">
              Importing &amp; parsing…<template v-if="importPercent != null"> {{ importPercent }}%</template>
            </template>
            <template v-else>Downloading…</template>
          </template>
          <template v-else><Icon name="warn" :size="12" />{{ jesmannError }}</template>
        </span>
        <Btn variant="ghost" :disabled="adding" @click="adding || emit('close')">Cancel</Btn>
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

      <!-- Thin import progress bar beneath the footer (the shared ProgressBar primitive): determinate when the
           server reports a percent, otherwise indeterminate. Only present while a create/sync is running. -->
      <div v-if="adding" style="padding: 2px 16px 14px;">
        <ProgressBar :value="importPercent != null ? importPercent / 100 : null" />
      </div>
    </div>
  </div>
</template>
