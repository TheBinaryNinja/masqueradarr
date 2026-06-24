<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';
import Toggle from '../components/Toggle.vue';
import SettingsRow from '../components/SettingsRow.vue';
import EndpointField from '../components/EndpointField.vue';
import DuloAuthPanel from '../components/DuloAuthPanel.vue';
import VideoConfigPanel from '../components/VideoConfigPanel.vue';
import EncoderDiagramPanel from '../components/EncoderDiagramPanel.vue';
import Segmented from '../components/Segmented.vue';
import FrequencyBuilder from '../components/FrequencyBuilder.vue';
import RestoreBackupModal from '../components/RestoreBackupModal.vue';
import { PROBE_STATUS, type CronFrequency } from '../data';
import { buildCron } from '../composables/useSchedule';
import { useToast } from '../composables/useToast';
import {
  displayName, domain, epgPath,
  timezone, darkMode,
  nameservers, dnsLogLevel,
  maxmindAccountId, maxmindLicenseKeySet,
  saveMaxmindLicenseKey, clearMaxmindLicenseKey,
  backupLocation,
} from '../composables/useSettings';

const toast = useToast();

// Settings is split into two tabs: General (General + Data cards) and Advanced (Geolocation, Channel
// Probing, Dulo.tv Authentication, Video Configuration).
const activeTab = ref<'general' | 'advanced'>('general');

// Encoder Diagram split-pane (Advanced tab only) — opened from the Video Configuration card header button.
// When open, the settings column shares the row with the diagram panel; leaving Advanced closes it.
const diagramOpen = ref(false);
watch(activeTab, (t) => { if (t !== 'advanced') diagramOpen.value = false; });

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

// ── Channel probing ────────────────────────────────────────────────────────
// The recurring ffprobe sweep schedule is a single cronjob row (targetType:'probe-all', targetId:'app')
// managed via /api/cronjobs — the SAME FrequencyBuilder the playlists use, but with the modes restricted to
// hourly/daily/weekly so the once-per-hour minimum is structural. "Run probe now" fires POST /api/probe/run.
const PROBE_MODES = [
  { value: 'hourly', label: 'Hourly', icon: 'refresh' },
  { value: 'daily', label: 'Daily', icon: 'sync' },
  { value: 'weekly', label: 'Weekly', icon: 'sync' },
];
const probeAuto = ref(false);
const probeFreq = reactive<CronFrequency>({ mode: 'hourly', every: 1, atHour: null, atMinute: 0, daysOfWeek: null });
const probeRawCron = ref('0 * * * *');
const probeSaving = ref(false);
const probeSaveState = ref<'idle' | 'saved' | 'error'>('idle');
const probeStarting = ref(false);

onMounted(async () => {
  // Hydrate from the persisted probe-all cronjob, if one exists (else the hourly defaults stand).
  try {
    const res = await fetch('/api/cronjobs/app?targetType=probe-all');
    if (res.ok) {
      const job = await res.json();
      probeAuto.value = !!job.enabled;
      if (job.frequency && typeof job.frequency === 'object') Object.assign(probeFreq, job.frequency);
      if (typeof job.cron === 'string' && job.cron) probeRawCron.value = job.cron;
    }
  } catch {
    /* no schedule yet — defaults stand */
  }
});

async function saveProbeSchedule() {
  probeSaving.value = true;
  probeSaveState.value = 'idle';
  try {
    const path = '/api/cronjobs/app?targetType=probe-all';
    if (probeAuto.value) {
      const res = await fetch(path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: 'probe-all',
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

async function runProbeNow() {
  probeStarting.value = true;
  try {
    const res = await fetch('/api/probe/run', { method: 'POST' });
    if (res.status === 202) {
      toast.lowerRight({ tone: 'good', icon: 'refresh', title: 'Probe started', text: 'Sweeping every Active channel — watch the sidebar for progress.' });
    } else if (res.status === 409) {
      toast.lowerRight({ tone: 'warn', icon: 'refresh', title: 'Probe already running', text: 'A sweep is in progress — let it finish first.' });
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch {
    toast.lowerRight({ tone: 'bad', icon: 'warn', title: 'Could not start probe', text: 'Please try again.' });
  } finally {
    probeStarting.value = false;
  }
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
    const name = match?.[1] || 'tvapp2-backup.json.gz';
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
  <div :class="diagramOpen ? 'settings-split' : ''">
    <div class="col settings-col" :style="diagramOpen ? undefined : { maxWidth: '760px' }">
    <Segmented :value="activeTab" @change="(v) => activeTab = v as any" :options="[
      { value: 'general', label: 'General' },
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
            <input v-model="domain" placeholder="https://tvapp2.example.com" />
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
            <select v-model.number="dnsLogLevel">
              <option :value="1">1 — Minimal (lifecycle + issues)</option>
              <option :value="2">2 — Standard (deduped per-call)</option>
              <option :value="3">3 — Verbose (every lookup)</option>
            </select>
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            Detail of the DNS / outbound-fetch trace shown in the View logs drawer (core category).
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
        The public origin TVApp2 serves from and the EPG guide URL. Read-only — set by the DOMAIN env on
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
        Comma-separated resolver IP(s) for TVApp2's outbound fetches (playlist, EPG, mirror scrapes, the HLS
        proxy). Leave blank to use the system resolver. Applied live on save.
      </div>

      <EndpointField label="Nameserver" icon="globe"
        v-model="nameservers"
        placeholder="e.g. 1.1.1.1, 8.8.8.8"
        mono />
    </div>

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
      <h3 class="section-title">Channel Probing</h3>
      <div class="muted" style="font-size: var(--fs-xs); margin-top: -6px; margin-bottom: 14px;">
        Run ffprobe across every Active channel — one playlist at a time — to refresh each channel's
        Live/Down status, resolution pill, and video details. Minimum frequency is once per hour.
      </div>
      <FrequencyBuilder :freq="probeFreq" v-model:auto="probeAuto" v-model:rawCron="probeRawCron"
                        :modes="PROBE_MODES" label="Probe schedule" icon="refresh"
                        manualHint="Probes run only when triggered manually. Switch to Automatic to run them on a schedule." />
      <div class="row" style="gap: 8px; margin-top: 14px; align-items: center;">
        <Btn variant="primary" icon="check" :disabled="probeSaving" @click="saveProbeSchedule">
          {{ probeSaving ? 'Saving…' : 'Save schedule' }}
        </Btn>
        <Btn variant="ghost" icon="refresh" :disabled="probeStarting || PROBE_STATUS?.running" @click="runProbeNow">
          {{ PROBE_STATUS?.running ? 'Probe running…' : 'Run probe now' }}
        </Btn>
        <span v-if="probeSaveState === 'saved'" style="color: var(--good); font-size: var(--fs-xs);">Saved</span>
        <span v-else-if="probeSaveState === 'error'" style="color: var(--bad); font-size: var(--fs-xs);">Failed</span>
      </div>
    </div>

    <DuloAuthPanel v-if="activeTab === 'advanced'" />

    <VideoConfigPanel v-if="activeTab === 'advanced'"
                      :diagram-open="diagramOpen" @toggle-diagram="diagramOpen = !diagramOpen" />

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
        <Btn variant="primary" icon="import" :disabled="generating" @click="generateBackup">
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
    <EncoderDiagramPanel v-if="diagramOpen && activeTab === 'advanced'" @close="diagramOpen = false" />
  </div>
</template>
