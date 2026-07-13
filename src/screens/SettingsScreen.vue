<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';
import Toggle from '../components/Toggle.vue';
import SettingsRow from '../components/SettingsRow.vue';
import EndpointField from '../components/EndpointField.vue';
import DuloAuthPanel from '../components/DuloAuthPanel.vue';
import ProxyConfigPanel from '../components/ProxyConfigPanel.vue';
import Segmented from '../components/Segmented.vue';
import FrequencyBuilder from '../components/FrequencyBuilder.vue';
import RestoreBackupModal from '../components/RestoreBackupModal.vue';
import TagManager from '../components/TagManager.vue';
import { type CronFrequency } from '../data';
import { buildCron } from '../composables/useSchedule';
import { useToast } from '../composables/useToast';
import {
  displayName, domain, epgPath,
  timezone, darkMode, videoPlayer, dlhdPlayer,
  nameservers, logLevel,
  maxmindAccountId, maxmindLicenseKeySet,
  saveMaxmindLicenseKey, clearMaxmindLicenseKey,
  backupLocation,
} from '../composables/useSettings';

const toast = useToast();

// Settings is split into three tabs: General (General + Data), Video Config (Channel Probe Scheduler,
// In-app Video Player, Video Proxy Engine) and Advanced (Geolocation, DaddyLive Player Source,
// Dulo.tv Authentication, Custom Tags).
const activeTab = ref<'general' | 'video' | 'advanced'>('general');

// Time zone dropdown — the full IANA zone list at runtime (Intl.supportedValuesOf, no dependency), grouped by
// the region prefix for the <optgroup>s. Falls back to a small common set on the rare runtime without the API.
// The persisted value is always force-included so the <select> never renders blank on a custom TZ (e.g. one
// seeded from a non-listed TZ env var). This is the operator's default scheduling zone (croner cronjobs).
const FALLBACK_TZS = [
  'UTC',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Moscow',
  'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Asia/Dubai',
  'Australia/Sydney',
];

const timezoneGroups = computed(() => {
  // Access via a cast so we don't depend on the TS lib shipping the (newer) Intl.supportedValuesOf typing.
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const all = typeof supported === 'function' ? supported('timeZone') : FALLBACK_TZS;
  const zones = all.includes(timezone.value) ? all : [timezone.value, ...all];
  const groups = new Map<string, string[]>();
  for (const z of zones) {
    const slash = z.indexOf('/');
    const region = slash === -1 ? 'Other' : z.slice(0, slash);
    let list = groups.get(region);
    if (!list) { list = []; groups.set(region, list); }
    list.push(z);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([region, list]) => ({ region, zones: list.sort((a, b) => a.localeCompare(b)) }));
});

// The DST-aware UTC offset ('±HHMM') of the selected zone right now — shown next to the dropdown so the
// operator sees what gets stored (the server derives + persists the same value on save, and stamps it onto
// synced programs). Mirrors server/src/settings/zoneOffset.ts. Recomputes only on selection (not per render),
// so the one Intl.DateTimeFormat construction is negligible.
const tzOffsetLabel = computed(() => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone.value, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date());
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    const offMin = Math.round((asUtc - Date.now()) / 60000);
    const sign = offMin < 0 ? '-' : '+';
    const abs = Math.abs(offMin);
    return sign + String(Math.floor(abs / 60)).padStart(2, '0') + String(abs % 60).padStart(2, '0');
  } catch {
    return '+0000';
  }
});

// MaxMind GeoIP credentials. accountId binds to the auto-persist ref; the license key is write-only — typed
// into a local field and PUT explicitly on Save (the API never returns it, only `maxmindLicenseKeySet`).
const licenseKeyInput = ref('');
const keySaveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
async function saveLicenseKey() {
  if (!licenseKeyInput.value.trim()) return;
  keySaveState.value = 'saving';
  const ok = await saveMaxmindLicenseKey(licenseKeyInput.value.trim());
  keySaveState.value = ok ? 'saved' : 'error';
  if (ok) licenseKeyInput.value = '';
  setTimeout(() => (keySaveState.value = 'idle'), 2200);
}
async function clearLicenseKey() {
  keySaveState.value = 'saving';
  const ok = await clearMaxmindLicenseKey();
  keySaveState.value = ok ? 'saved' : 'error';
  if (ok) licenseKeyInput.value = '';
  setTimeout(() => (keySaveState.value = 'idle'), 2200);
}

// ── Data card ──────────────────────────────────────────────────────────────
// Maintenance, full-workspace backup (generate/restore + a scheduled write to disk), and the danger-zone
// reset. The backup schedule is the SAME cronjob mechanism the probe sweep uses (targetType:'backup',
// targetId:'app'), managed via /api/cronjobs with the daily/weekly/hourly modes.

// Rebuild MongoDB indexes across every collection.
const rebuildingIndex = ref(false);
async function rebuildIndex() {
  rebuildingIndex.value = true;
  try {
    const res = await fetch('/api/system/rebuild-indexes', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = (await res.json()) as { rebuilt: string[]; errors: string[] };
    if (result.errors?.length) {
      toast.lowerRight({ tone: 'warn', icon: 'warn', title: 'Indexes rebuilt with errors', text: `${result.rebuilt?.length ?? 0} OK · ${result.errors.length} failed.` });
    } else {
      toast.lowerRight({ tone: 'good', icon: 'check', title: 'Indexes rebuilt', text: `Reconciled ${result.rebuilt?.length ?? 0} collection(s).` });
    }
  } catch {
    toast.lowerRight({ tone: 'bad', icon: 'warn', title: 'Could not rebuild indexes', text: 'Please try again.' });
  } finally {
    rebuildingIndex.value = false;
  }
}

// Generate + download a full backup. The server streams a gzip file with a Content-Disposition filename.
const generating = ref(false);
async function generateBackup() {
  generating.value = true;
  try {
    const res = await fetch('/api/backup/generate');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') ?? '';
    const match = /filename="?([^"]+)"?/i.exec(cd);
    const name = match?.[1] || 'masqueradarr-backup.json.gz';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    toast.lowerRight({ tone: 'good', icon: 'check', title: 'Backup downloaded', text: name });
  } catch {
    toast.lowerRight({ tone: 'bad', icon: 'warn', title: 'Could not generate backup', text: 'Please try again.' });
  } finally {
    generating.value = false;
  }
}

const restoreModalOpen = ref(false);
function onRestored() { window.location.reload(); }

// Scheduled on-disk backup — mirrors the probe schedule (cronjob targetType:'backup'), modes limited to
// hourly/daily/weekly (no minutes/custom).
const BACKUP_MODES = [
  { value: 'hourly', label: 'Hourly', icon: 'refresh' },
  { value: 'daily', label: 'Daily', icon: 'sync' },
  { value: 'weekly', label: 'Weekly', icon: 'sync' },
];
const backupAuto = ref(false);
const backupFreq = reactive<CronFrequency>({ mode: 'daily', every: null, atHour: 3, atMinute: 0, daysOfWeek: null });
const backupRawCron = ref('0 3 * * *');
const backupSaving = ref(false);
const backupSaveState = ref<'idle' | 'saved' | 'error'>('idle');

onMounted(async () => {
  // Hydrate from the persisted backup cronjob, if one exists (else the daily-at-03:00 defaults stand).
  try {
    const res = await fetch('/api/cronjobs/app?targetType=backup');
    if (res.ok) {
      const job = await res.json();
      backupAuto.value = !!job.enabled;
      if (job.frequency && typeof job.frequency === 'object') Object.assign(backupFreq, job.frequency);
      if (typeof job.cron === 'string' && job.cron) backupRawCron.value = job.cron;
    }
  } catch {
    /* no schedule yet — defaults stand */
  }
});

async function saveBackupSchedule() {
  backupSaving.value = true;
  backupSaveState.value = 'idle';
  try {
    const path = '/api/cronjobs/app?targetType=backup';
    if (backupAuto.value) {
      const res = await fetch('/api/cronjobs/app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: 'backup',
          cron: buildCron(backupFreq, backupRawCron.value),
          frequency: { ...backupFreq },
          timezone: timezone.value || null,
          enabled: true,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } else {
      // Manual → unschedule (idempotent; a 404 just means there was nothing to remove).
      const res = await fetch(path, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    }
    backupSaveState.value = 'saved';
  } catch {
    backupSaveState.value = 'error';
  } finally {
    backupSaving.value = false;
    setTimeout(() => (backupSaveState.value = 'idle'), 2200);
  }
}

// Scheduled channel probe (PRB) — cronjob targetType:'channel-probe', targetId:'app'. Modes are limited to
// hourly/daily/weekly (a probe resolves + checks EVERY channel upstream, so there's a once-per-hour floor —
// no minutes/custom). Mirrors the backup-schedule pattern; adds a "Run now" one-off (POST /api/probe/run).
const PROBE_MODES = [
  { value: 'hourly', label: 'Hourly', icon: 'refresh' },
  { value: 'daily', label: 'Daily', icon: 'sync' },
  { value: 'weekly', label: 'Weekly', icon: 'sync' },
];
const probeAuto = ref(false);
const probeFreq = reactive<CronFrequency>({ mode: 'hourly', every: 6, atHour: null, atMinute: 0, daysOfWeek: null });
const probeRawCron = ref('0 */6 * * *');
const probeSaving = ref(false);
const probeSaveState = ref<'idle' | 'saved' | 'error'>('idle');
const probeRunning = ref(false);

onMounted(async () => {
  // Hydrate the probe schedule from its cronjob, if one exists (else the every-6-hours defaults stand).
  try {
    const res = await fetch('/api/cronjobs/app?targetType=channel-probe');
    if (res.ok) {
      const job = await res.json();
      probeAuto.value = !!job.enabled;
      if (job.frequency && typeof job.frequency === 'object') Object.assign(probeFreq, job.frequency);
      if (typeof job.cron === 'string' && job.cron) probeRawCron.value = job.cron;
    }
  } catch {
    /* no schedule yet — defaults stand */
  }
  // Reflect an already-running sweep (kicked elsewhere) in the button state.
  try {
    const res = await fetch('/api/probe/status');
    if (res.ok) probeRunning.value = !!(await res.json()).running;
  } catch {
    /* ignore */
  }
});

async function saveProbeSchedule() {
  probeSaving.value = true;
  probeSaveState.value = 'idle';
  try {
    const path = '/api/cronjobs/app?targetType=channel-probe';
    if (probeAuto.value) {
      const res = await fetch('/api/cronjobs/app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: 'channel-probe',
          cron: buildCron(probeFreq, probeRawCron.value),
          frequency: { ...probeFreq },
          timezone: timezone.value || null,
          enabled: true,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } else {
      // Manual → unschedule (idempotent; a 404 just means there was nothing to remove).
      const res = await fetch(path, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    }
    probeSaveState.value = 'saved';
  } catch {
    probeSaveState.value = 'error';
  } finally {
    probeSaving.value = false;
    setTimeout(() => (probeSaveState.value = 'idle'), 2200);
  }
}

// Fire an immediate sweep, then poll status so the button clears when it finishes (no progress WS in P1.3).
async function runProbeNow() {
  probeRunning.value = true;
  try {
    const res = await fetch('/api/probe/run', { method: 'POST' });
    if (res.status === 202 || res.ok) {
      toast.lowerRight({ tone: 'good', icon: 'check', title: 'Probe started', text: 'Checking every active channel…' });
    } else if (res.status === 409) {
      toast.lowerRight({ tone: 'warn', icon: 'warn', title: 'Probe already running', text: 'A sweep is in progress.' });
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch {
    toast.lowerRight({ tone: 'bad', icon: 'warn', title: 'Could not start probe', text: 'Please try again.' });
    probeRunning.value = false;
    return;
  }
  const poll = async () => {
    try {
      const res = await fetch('/api/probe/status');
      if (!res.ok) return void (probeRunning.value = false);
      const s = await res.json();
      probeRunning.value = !!s.running;
      if (s.running) setTimeout(poll, 3000);
    } catch {
      probeRunning.value = false;
    }
  };
  setTimeout(poll, 3000);
}

// Danger zone — wipe the entire workspace, then reload into the fresh state.
const resetting = ref(false);
const resetConfirm = ref(false);
async function fireReset() {
  resetting.value = true;
  try {
    const res = await fetch('/api/system/reset-workspace', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.location.reload();
  } catch {
    resetting.value = false;
    resetConfirm.value = false;
    toast.lowerRight({ tone: 'bad', icon: 'warn', title: 'Could not reset workspace', text: 'Please try again.' });
  }
}
</script>

<template>
  <div>
    <div class="col settings-col" :style="{ maxWidth: '760px' }">
    <Segmented :value="activeTab" @change="(v) => activeTab = v as any" :options="[
      { value: 'general', label: 'General' },
      { value: 'video', label: 'Video Config' },
      { value: 'advanced', label: 'Advanced' },
    ]" style="margin-bottom: 4px;" />

    <div class="card" v-if="activeTab === 'general'">
      <h3 class="section-title">General</h3>
      <div class="form-grid-2">
        <div class="form-row">
          <div class="field-lbl">Display name</div>
          <div class="input"><input v-model="displayName" /></div>
        </div>
        <div class="form-row">
          <div class="field-lbl">Domain</div>
          <div class="input mono" style="font-size: 12px;">
            <Icon name="globe" :size="14" />
            <input v-model="domain" placeholder="https://masqueradarr.example.com" />
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            Base URL used by all hosted endpoints (M3U, EPG, per-playlist custom paths).
          </div>
        </div>
        <div class="form-row">
          <div class="field-lbl">Time zone <span class="mono muted" style="font-weight: 400;">· UTC {{ tzOffsetLabel }}</span></div>
          <div class="select fill">
            <select v-model="timezone">
              <optgroup v-for="g in timezoneGroups" :key="g.region" :label="g.region">
                <option v-for="z in g.zones" :key="z" :value="z">{{ z }}</option>
              </optgroup>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="field-lbl">Log level</div>
          <div class="select fill">
            <select v-model.number="logLevel">
              <option :value="1">1 — Minimal (lifecycle + issues)</option>
              <option :value="2">2 — Standard (milestones)</option>
              <option :value="3">3 — Verbose (full stream lineage)</option>
            </select>
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            Global log verbosity for the whole app and the streaming proxy engine, shown in the View logs
            drawer. Level 3 traces a channel end-to-end (resolve → repackage → output) under the proxy category.
          </div>
        </div>
        <div class="form-row">
          <div class="field-lbl">Dark mode</div>
          <div class="row"><Toggle :on="darkMode" @change="(v) => darkMode = v" /></div>
        </div>
      </div>

      <div class="divider" style="margin: 18px 0 14px;" />

      <div class="field-lbl" style="margin-bottom: 10px;">Hosting endpoints</div>
      <div class="muted" style="font-size: var(--fs-xs); margin-top: -4px; margin-bottom: 12px;">
        The public origin masqueradarr serves from and the EPG guide URL. Read-only — set by the DOMAIN env on
        first provision. Per-account M3U links live on the Users screen.
      </div>

      <EndpointField label="M3U endpoint" icon="playlist"
        :model-value="domain.replace(/\/$/, '')"
        readonly mono />
      <div style="height: 10px;" />
      <EndpointField label="EPG endpoint" icon="epg" icon-color="var(--good)"
        :model-value="`${domain.replace(/\/$/, '')}${epgPath}`"
        readonly mono />

      <div class="divider" style="margin: 18px 0 14px;" />

      <div class="field-lbl" style="margin-bottom: 10px;">Nameserver (DNS)</div>
      <div class="muted" style="font-size: var(--fs-xs); margin-top: -4px; margin-bottom: 12px;">
        Comma-separated resolver IP(s) for masqueradarr's outbound fetches (playlist, EPG, mirror scrapes, the HLS
        proxy). Leave blank to use the system resolver. Applied live on save.
      </div>

      <EndpointField label="Nameserver" icon="globe"
        v-model="nameservers"
        placeholder="e.g. 1.1.1.1, 8.8.8.8"
        mono />
    </div>

    <div class="card" v-if="activeTab === 'video'">
      <h3 class="section-title">Channel Probe Scheduler</h3>
      <div class="muted" style="font-size: var(--fs-xs); margin-top: -6px; margin-bottom: 14px;">
        Periodically check every active channel and refresh its status + resolution, so the Channels and Active
        Streams screens stay accurate even for channels nobody is watching. Each channel is resolved and probed
        through the video engine, so this runs at most once per hour.
      </div>
      <SettingsRow label="Automatic probe" hint="Sweep all channels on a schedule.">
        <template #right>
          <Toggle :on="probeAuto" @change="(v) => { probeAuto = v; saveProbeSchedule(); }" />
        </template>
      </SettingsRow>

      <template v-if="probeAuto">
        <FrequencyBuilder :freq="probeFreq" :auto="probeAuto" v-model:rawCron="probeRawCron"
                          :modes="PROBE_MODES" hideMode label="Schedule" icon="refresh" manualHint="" />
        <div class="row" style="gap: 8px; margin-top: 14px; align-items: center;">
          <Btn variant="primary" icon="check" :disabled="probeSaving" @click="saveProbeSchedule">
            {{ probeSaving ? 'Saving…' : 'Save schedule' }}
          </Btn>
          <span v-if="probeSaveState === 'saved'" style="color: var(--good); font-size: var(--fs-xs);">Saved</span>
          <span v-else-if="probeSaveState === 'error'" style="color: var(--bad); font-size: var(--fs-xs);">Failed</span>
        </div>
      </template>

      <div class="divider" />
      <SettingsRow label="Run a probe now" hint="Immediately check every active channel once.">
        <template #right>
          <Btn variant="ghost" icon="refresh" :disabled="probeRunning" @click="runProbeNow">
            {{ probeRunning ? 'Running…' : 'Run now' }}
          </Btn>
        </template>
      </SettingsRow>
    </div>

    <div class="card" v-if="activeTab === 'video'">
      <h3 class="section-title">In-app Video Player</h3>
      <SettingsRow label="Player"
        hint="Which player the channel slide-out uses. “Debug” swaps in a diagnostic player with a live hls.js status readout + event log for troubleshooting playback.">
        <template #right>
          <Segmented :value="videoPlayer" @change="(v) => videoPlayer = v as any"
            :options="[{ value: 'inapp', label: 'In-app video player' }, { value: 'debug', label: 'Debug video player' }]" />
        </template>
      </SettingsRow>
    </div>

    <!-- Durable video engine — the (Default) proxy config applied to every playlist (per-playlist Custom
         overrides live in the playlist editor drawer). Auto-saves on change. [UICFG] -->
    <ProxyConfigPanel v-if="activeTab === 'video'" config-id="app" title="Video Proxy Engine (Default)" />

    <div class="card" v-if="activeTab === 'advanced'">
      <h3 class="section-title">Geolocation (MaxMind GeoIP)</h3>
      <div class="muted" style="font-size: var(--fs-xs); margin-top: -6px; margin-bottom: 14px;">
        Resolve viewer IP addresses to a location on the Active Streams and History / Metrics screens. Uses
        the free MaxMind GeoLite2 web service — create a MaxMind account, then generate a license key. Leave
        blank to disable.
      </div>
      <div class="form-grid-2">
        <div class="form-row">
          <div class="field-lbl">Account ID</div>
          <div class="input"><input v-model="maxmindAccountId" placeholder="e.g. 1234567" /></div>
        </div>
        <div class="form-row">
          <div class="field-lbl">License key</div>
          <div class="input">
            <Icon name="lock" :size="14" />
            <input v-model="licenseKeyInput" type="password"
              :placeholder="maxmindLicenseKeySet ? '•••••••• (configured)' : 'Enter license key'" />
          </div>
          <div class="row" style="gap: 8px; margin-top: 8px; align-items: center;">
            <Btn variant="primary" size="sm" icon="check"
              :disabled="keySaveState === 'saving' || !licenseKeyInput.trim()"
              @click="saveLicenseKey">
              {{ keySaveState === 'saving' ? 'Saving…' : 'Save key' }}
            </Btn>
            <Btn v-if="maxmindLicenseKeySet" variant="ghost" size="sm" icon="trash" @click="clearLicenseKey">
              <span style="color: var(--bad);">Clear</span>
            </Btn>
            <span v-if="keySaveState === 'saved'" style="color: var(--good); font-size: var(--fs-xs);">Saved</span>
            <span v-else-if="keySaveState === 'error'" style="color: var(--bad); font-size: var(--fs-xs);">Failed</span>
          </div>
        </div>
      </div>
    </div>

    <div class="card" v-if="activeTab === 'advanced'">
      <h3 class="section-title">DaddyLive Player Source (Default)</h3>
      <SettingsRow label="Default player"
        hint="DaddyLive offers several interchangeable players per channel — redundant feeds of the same stream. This is the default for every such channel; “Auto” uses Player 1 and falls back to the others if it’s down. You can override it per channel in the channel editor.">
        <template #right>
          <Segmented :value="String(dlhdPlayer)" @change="(v) => dlhdPlayer = Number(v)"
            :options="[
              { value: '0', label: 'Auto' },
              { value: '1', label: '1' },
              { value: '2', label: '2' },
              { value: '3', label: '3' },
              { value: '4', label: '4' },
              { value: '5', label: '5' },
              { value: '6', label: '6' },
            ]" />
        </template>
      </SettingsRow>
    </div>

    <DuloAuthPanel v-if="activeTab === 'advanced'" />

    <div class="card" v-if="activeTab === 'advanced'">
      <h3 class="section-title">Custom Tags</h3>
      <TagManager />
    </div>

    <div class="card" v-if="activeTab === 'general'">
      <h3 class="section-title">Data</h3>

      <SettingsRow label="Rebuild database index" hint="Reconcile MongoDB indexes across all collections.">
        <template #right>
          <Btn variant="ghost" icon="refresh" :disabled="rebuildingIndex" @click="rebuildIndex">
            {{ rebuildingIndex ? 'Rebuilding…' : 'Rebuild' }}
          </Btn>
        </template>
      </SettingsRow>

      <div class="divider" />
      <h4 style="margin: 4px 0 6px; font-size: var(--fs-base);">Data Backup</h4>
      <div class="muted" style="font-size: var(--fs-xs); margin-bottom: 12px;">
        Download a full backup of your configuration, mappings, and credentials — or restore from one.
      </div>
      <div class="row" style="gap: 8px;">
        <Btn variant="ghost" icon="import" :disabled="generating" @click="generateBackup">
          {{ generating ? 'Generating…' : 'Generate backup' }}
        </Btn>
        <Btn variant="ghost" icon="upload" @click="restoreModalOpen = true">Restore backup</Btn>
      </div>

      <div class="divider" />
      <SettingsRow label="Backup schedule" hint="Write a backup to disk automatically on a schedule.">
        <template #right>
          <Toggle :on="backupAuto" @change="(v) => { backupAuto = v; saveBackupSchedule(); }" />
        </template>
      </SettingsRow>

      <template v-if="backupAuto">
        <FrequencyBuilder :freq="backupFreq" :auto="backupAuto" v-model:rawCron="backupRawCron"
                          :modes="BACKUP_MODES" hideMode label="Schedule" icon="refresh"
                          manualHint="" />
        <div class="form-row" style="margin-top: 12px;">
          <div class="field-lbl">Backup location</div>
          <div class="input"><input v-model="backupLocation" placeholder="/backups" /></div>
        </div>
        <div class="row" style="gap: 8px; margin-top: 14px; align-items: center;">
          <Btn variant="primary" icon="check" :disabled="backupSaving" @click="saveBackupSchedule">
            {{ backupSaving ? 'Saving…' : 'Save schedule' }}
          </Btn>
          <span v-if="backupSaveState === 'saved'" style="color: var(--good); font-size: var(--fs-xs);">Saved</span>
          <span v-else-if="backupSaveState === 'error'" style="color: var(--bad); font-size: var(--fs-xs);">Failed</span>
        </div>
      </template>

      <div class="divider" />
      <h4 style="margin: 4px 0 6px; font-size: var(--fs-base); color: var(--bad);">Danger Zone</h4>
      <div class="muted" style="font-size: var(--fs-xs); margin-bottom: 4px;">
        Irreversible. This permanently deletes data.
      </div>
      <SettingsRow label="Reset workspace" hint="Permanently delete all playlists, EPG data, and mappings.">
        <template #right>
          <Btn variant="ghost" icon="trash" @click="resetConfirm = true"><span style="color: var(--bad);">Reset workspace</span></Btn>
        </template>
      </SettingsRow>

      <div v-if="resetConfirm" class="modal-bg" @click="resetConfirm = false">
        <div class="modal" @click.stop style="width: 480px; max-width: 92vw;">
          <div class="modal-hd">
            <Icon name="trash" :size="18" />
            <h2>Reset workspace?</h2>
            <span class="spacer" />
            <Btn variant="ghost" size="sm" icon="x" @click="resetConfirm = false" />
          </div>
          <div class="modal-body">
            <div class="row" style="gap: 8px; padding: 10px 12px; background: var(--accent-soft); border-radius: 8px; align-items: flex-start;">
              <span style="color: var(--bad); margin-top: 1px;"><Icon name="warn" :size="14" /></span>
              <span style="font-size: var(--fs-sm); line-height: 1.5;">
                This permanently deletes <strong>all</strong> playlists, EPG data, channel mappings, and viewing
                history. This cannot be undone.
              </span>
            </div>
          </div>
          <div class="modal-ft">
            <span class="spacer" />
            <Btn variant="ghost" @click="resetConfirm = false">Cancel</Btn>
            <Btn variant="primary" icon="trash" :disabled="resetting" @click="fireReset">
              {{ resetting ? 'Resetting…' : 'Reset workspace' }}
            </Btn>
          </div>
        </div>
      </div>

      <RestoreBackupModal v-if="restoreModalOpen" @close="restoreModalOpen = false" @restored="onRestored" />
    </div>
    </div>
  </div>
</template>
