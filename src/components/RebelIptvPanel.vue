<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Toggle from './Toggle.vue';
import Pill from './Pill.vue';
import StatusDot from './StatusDot.vue';
import SettingsRow from './SettingsRow.vue';
import FrequencyBuilder from './FrequencyBuilder.vue';
import RebelLogsDrawer from './RebelLogsDrawer.vue';
import { useRebelIptv } from '../composables/useRebelIptv';
import { openRebelIptv } from '../composables/rebelLaunch';
import { useToast } from '../composables/useToast';
import { buildCron } from '../composables/useSchedule';
import { type CronFrequency } from '../data';

const toast = useToast();
const rebel = useRebelIptv();
const { status, busy, opRunning, dockerAccess, dockerReady } = rebel;

const DOCKER_OFF_REASON = 'Needs Docker socket access (DOCKER_SOCK_ACCESS=1)';

const container = computed(() => status.value?.container ?? null);
const op = computed(() => status.value?.op ?? null);
const lastOp = computed(() => status.value?.lastOp ?? null);
const update = computed(() => status.value?.update ?? null);
const catalog = computed(() => status.value?.catalog ?? null);
const viewers = computed(() => status.value?.viewers ?? { streams: 0, clients: 0, channels: [] });

const healthTone = computed(() => {
  const s = status.value;
  if (!s) return 'idle';
  if (s.configError) return 'bad';
  if (op.value) return 'warn';
  if (container.value) {
    if (container.value.state !== 'running') return 'bad';
    if (container.value.health === 'unhealthy') return 'bad';
    if (container.value.health === 'starting') return 'warn';
  }
  return s.reachability.ok ? 'good' : 'bad';
});

const healthLabel = computed(() => {
  const s = status.value;
  if (!s) return 'Loading…';
  if (s.configError) return 'Configuration error';
  if (op.value) return `${opKindLabel(op.value.kind)} — ${op.value.phase}`;
  if (container.value) {
    const h = container.value.health ? ` · ${container.value.health}` : '';
    return `${container.value.state}${h}`;
  }
  return s.reachability.ok ? 'Reachable' : 'Unreachable';
});

function opKindLabel(kind: string): string {
  return ({ update: 'Updating', restart: 'Restarting', start: 'Starting', provision: 'Provisioning', recover: 'Recovering' } as Record<string, string>)[kind] ?? kind;
}

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function shortDigest(d: string | null | undefined): string {
  if (!d) return '—';
  return d.replace(/^sha256:/, '').slice(0, 12);
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.lowerRight({ tone: 'good', icon: 'check', title: 'Copied', text: what });
  } catch {
    toast.lowerRight({ tone: 'warn', icon: 'warn', title: 'Copy failed', text: text });
  }
}

async function run(label: string, fn: () => Promise<unknown>, okText?: string): Promise<void> {
  try {
    await fn();
    if (okText) toast.lowerRight({ tone: 'good', icon: 'check', title: label, text: okText });
  } catch (err) {
    toast.lowerRight({ tone: 'bad', icon: 'warn', title: `${label} failed`, text: (err as Error).message });
  }
}

const confirmUpdate = ref(false);
async function doUpdate(): Promise<void> {
  confirmUpdate.value = false;
  await run('Update', () => rebel.update(), 'Update started — Rebel IPTV will be back in a minute.');
}

const checking = computed(() => busy.value === 'check');
async function checkNow(): Promise<void> {
  await run('Update check', () => rebel.checkNow());
}

const apiKeyInput = ref('');
async function saveKey(): Promise<void> {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  await run('API key', () => rebel.saveConfig({ apiKey: key }), 'Saved.');
  apiKeyInput.value = '';
}
async function clearKey(): Promise<void> {
  await run('API key', () => rebel.saveConfig({ apiKey: null }), 'Cleared.');
}

const maxStreamsInput = ref<number | null>(null);
const maxStreams = computed<number>({
  get: () => maxStreamsInput.value ?? status.value?.config.maxStreams ?? 4,
  set: (v) => (maxStreamsInput.value = v),
});
async function saveMaxStreams(): Promise<void> {
  const n = Math.round(Number(maxStreams.value));
  if (!Number.isInteger(n) || n < 1 || n > 32) {
    toast.lowerRight({ tone: 'warn', icon: 'warn', title: 'Max streams', text: 'Enter a whole number from 1 to 32.' });
    return;
  }
  await run('Max streams', () => rebel.saveConfig({ maxStreams: n }), `Set to ${n}.`);
  maxStreamsInput.value = null;
}

const testResult = ref<{ ok: boolean; channels: number | null; ms: number | null; error: string | null } | null>(null);
async function testConnection(): Promise<void> {
  try {
    testResult.value = await rebel.test();
  } catch (err) {
    testResult.value = { ok: false, channels: null, ms: null, error: (err as Error).message };
  }
}

async function toggleAutoUpdate(v: boolean): Promise<void> {
  await run('Auto-update', () => rebel.saveConfig({ autoUpdate: v }));
}
async function toggleIdleOnly(v: boolean): Promise<void> {
  await run('Idle-only updates', () => rebel.saveConfig({ idleOnly: v }));
}

const SCHEDULE_MODES = [
  { value: 'daily', label: 'Daily', icon: 'sync' },
  { value: 'weekly', label: 'Weekly', icon: 'sync' },
];
const schedFreq = reactive<CronFrequency>({ mode: 'daily', every: null, atHour: 4, atMinute: 0, daysOfWeek: null });
const schedRawCron = ref('0 4 * * *');
const schedTimezone = ref<string | null>(null);
const schedSaving = ref(false);
const schedLoaded = ref(false);

async function loadSchedule(): Promise<void> {
  try {
    const res = await fetch('/api/cronjobs/app?targetType=rebel-iptv-update');
    if (res.ok) {
      const job = await res.json();
      if (job.frequency && typeof job.frequency === 'object') Object.assign(schedFreq, job.frequency);
      if (typeof job.cron === 'string' && job.cron) schedRawCron.value = job.cron;
      schedTimezone.value = job.timezone ?? null;
      schedLoaded.value = true;
    }
  } catch {
  }
}

async function saveSchedule(): Promise<void> {
  schedSaving.value = true;
  await run(
    'Update schedule',
    async () => {
      const res = await fetch('/api/cronjobs/app', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: 'rebel-iptv-update',
          cron: buildCron(schedFreq, schedRawCron.value),
          frequency: { ...schedFreq },
          timezone: schedTimezone.value,
          enabled: true,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    'Saved.',
  );
  schedSaving.value = false;
}

onMounted(() => {
  void loadSchedule();
});

const logsOpen = ref(false);

const canStart = computed(() => !!container.value && container.value.state !== 'running');
const lastOpTail = computed(() => (op.value ?? lastOp.value)?.log.slice(-6) ?? []);
</script>

<template>
  <div class="col" style="gap: 14px;">
    <div class="card">
      <div class="row" style="align-items: center; gap: 10px;">
        <Icon name="tv" :size="16" />
        <h3 class="section-title" style="margin: 0;">Rebel IPTV</h3>
        <Pill v-if="status">{{ status.mode === 'managed' ? 'managed by masqueradarr' : 'compose / external' }}</Pill>
        <span class="spacer" style="flex: 1;" />
        <StatusDot :status="healthTone" :pulse="opRunning" />
        <span class="muted" style="font-size: var(--fs-xs);">{{ healthLabel }}</span>
      </div>
      <div class="muted" style="font-size: var(--fs-xs); margin: 6px 0 12px;">
        An optional companion server (its own unmodified container, licensed for personal non-commercial use).
        Its channels and guide join your catalog; its dashboard opens here in a pop-up for deeper settings.
      </div>

      <div v-if="status && status.docker.access" class="row" style="gap: 8px; padding: 8px 10px; background: var(--bg-2); border-radius: 8px; align-items: flex-start;">
        <span style="color: var(--text-2); margin-top: 1px;"><Icon name="info" :size="13" /></span>
        <span style="font-size: var(--fs-xs); color: var(--text-1);">
          Docker access enabled — root-equivalent on the host. masqueradarr keeps Rebel IPTV updated and can restart it.
          <span v-if="status.docker.endpoint" class="mono muted">({{ status.docker.endpoint }}<template v-if="status.docker.apiVersion">, API {{ status.docker.apiVersion }}</template>)</span>
        </span>
      </div>
      <div v-else-if="status" class="col" style="gap: 8px; padding: 10px 12px; border: 1px solid var(--warn); border-radius: 8px; background: var(--bg-2);">
        <div class="row" style="gap: 8px; align-items: flex-start;">
          <span style="color: var(--warn); margin-top: 1px;"><Icon name="warn" :size="13" /></span>
          <span style="font-size: var(--fs-xs); color: var(--text-1);">
            Docker access is off (<code class="mono">DOCKER_SOCK_ACCESS=0</code>). masqueradarr can't update, restart or read logs
            for Rebel IPTV — pull new images by hand. Rebel IPTV stops serving channels once it falls too far behind.
          </span>
        </div>
        <div v-if="status.docker.manualUpdateCommand" class="row" style="gap: 8px; align-items: center;">
          <code class="mono" style="flex: 1; font-size: var(--fs-xs); padding: 6px 8px; background: var(--bg-1); border-radius: 6px; overflow-x: auto; white-space: nowrap;">{{ status.docker.manualUpdateCommand }}</code>
          <Btn variant="ghost" size="sm" icon="copy" @click="copy(status.docker.manualUpdateCommand!, 'Manual update command')">Copy</Btn>
        </div>
      </div>

      <div v-if="status?.configError" class="row" style="gap: 8px; margin-top: 10px; padding: 8px 10px; border: 1px solid var(--bad); border-radius: 8px; align-items: flex-start;">
        <span style="color: var(--bad); margin-top: 1px;"><Icon name="x" :size="13" /></span>
        <span style="font-size: var(--fs-xs); color: var(--text-1);">{{ status.configError }}</span>
      </div>
      <div v-if="status?.docker.access && status.docker.error" class="row" style="gap: 8px; margin-top: 10px; padding: 8px 10px; border: 1px solid var(--bad); border-radius: 8px; align-items: flex-start;">
        <span style="color: var(--bad); margin-top: 1px;"><Icon name="x" :size="13" /></span>
        <span style="font-size: var(--fs-xs); color: var(--text-1);">
          Docker unavailable: {{ status.docker.error }} — check that the socket proxy (compose) or the mounted socket (AIO) is running.
        </span>
      </div>
      <div v-if="rebel.error.value && !status" class="muted" style="font-size: var(--fs-xs); color: var(--bad); margin-top: 8px;">{{ rebel.error.value }}</div>
    </div>

    <div class="card" v-if="status">
      <h3 class="section-title">Status</h3>
      <div class="rebel-grid">
        <div class="muted">Container</div>
        <div>
          <template v-if="container">
            <span class="mono">{{ container.name }}</span> · {{ container.state }}<template v-if="container.health"> · {{ container.health }}</template>
            <span v-if="container.failingStreak" style="color: var(--bad);"> · {{ container.failingStreak }} failing check(s)</span>
          </template>
          <span v-else-if="dockerAccess" class="muted">not found</span>
          <span v-else class="muted">unknown without Docker access</span>
        </div>
        <template v-if="container">
          <div class="muted">Uptime</div>
          <div>{{ container.startedAt ? fmtAgo(container.startedAt) : '—' }} · {{ container.restartCount }} restart(s)</div>
          <div class="muted">Image</div>
          <div class="mono" style="font-size: var(--fs-xs);">
            {{ container.image.ref }} · {{ container.image.version ?? '?' }} · {{ shortDigest(container.image.digest) }}
          </div>
        </template>
        <div class="muted">Version</div>
        <div>
          <template v-if="container?.image.version">{{ container.image.version }}</template>
          <span v-else class="muted">unknown — see Rebel IPTV's own dashboard</span>
        </div>
        <div class="muted">Reachability</div>
        <div>
          <span :style="{ color: status.reachability.ok ? 'var(--good)' : 'var(--bad)' }">{{ status.reachability.ok ? 'reachable' : 'unreachable' }}</span>
          <template v-if="status.reachability.ms != null"> · {{ status.reachability.ms }} ms</template>
          <template v-if="status.reachability.status"> · HTTP {{ status.reachability.status }}</template>
          <template v-if="status.reachability.error"> · <span class="mono" style="font-size: var(--fs-xs);">{{ status.reachability.error }}</span></template>
        </div>
        <div class="muted">Viewers</div>
        <div>{{ viewers.streams }} stream(s) · {{ viewers.clients }} client(s)</div>
      </div>
      <div v-if="container?.lastCheck" style="margin-top: 10px;">
        <div class="muted" style="font-size: var(--fs-xs); margin-bottom: 4px;">
          Last healthcheck · {{ fmtWhen(container.lastCheck.at) }} · exit {{ container.lastCheck.exitCode }}
        </div>
        <pre class="mono rebel-pre">{{ container.lastCheck.output || '(no output — healthy)' }}</pre>
      </div>
    </div>

    <div class="card" v-if="status">
      <h3 class="section-title">Updates</h3>
      <div class="rebel-grid">
        <div class="muted">Installed</div>
        <div>{{ update?.current?.version ?? container?.image.version ?? 'unknown' }}</div>
        <div class="muted">Latest release</div>
        <div>
          <template v-if="update?.latest.version">
            {{ update.latest.version }}<span class="muted"> · {{ fmtWhen(update.latest.publishedAt) }}</span>
            <a v-if="update.latest.notesUrl" :href="update.latest.notesUrl" target="_blank" rel="noopener noreferrer" style="margin-left: 6px;">release notes</a>
          </template>
          <span v-else class="muted">not checked yet</span>
        </div>
        <div class="muted">State</div>
        <div>
          <Pill v-if="update?.pinned" tone="warn">pinned tag — info only</Pill>
          <Pill v-else-if="update?.available === true" tone="warn">update available</Pill>
          <Pill v-else-if="update?.available === false" tone="good">up to date</Pill>
          <span v-else class="muted">unknown</span>
          <span v-if="update?.checkedAt" class="muted" style="font-size: var(--fs-xs); margin-left: 6px;">checked {{ fmtAgo(update.checkedAt) }} ago</span>
        </div>
        <template v-if="status.lastUpdate">
          <div class="muted">Last {{ status.lastUpdate.kind }}</div>
          <div style="font-size: var(--fs-xs);">
            <span :style="{ color: status.lastUpdate.ok ? 'var(--good)' : 'var(--bad)' }">{{ status.lastUpdate.ok ? 'ok' : 'failed' }}</span>
            · {{ fmtWhen(status.lastUpdate.at) }}
            <template v-if="status.lastUpdate.from || status.lastUpdate.to"> · {{ status.lastUpdate.from ?? '?' }} → {{ status.lastUpdate.to ?? '?' }}</template>
            <template v-if="status.lastUpdate.error"> · {{ status.lastUpdate.error }}</template>
          </div>
        </template>
      </div>
      <div v-if="update?.pinned" class="muted" style="font-size: var(--fs-xs); margin-top: 8px;">
        <code class="mono">REBEL_IPTV_IMAGE</code> is pinned to a tag — newer releases are shown but never installed. Change the tag to move.
      </div>
      <div v-if="update?.error" class="muted" style="font-size: var(--fs-xs); margin-top: 8px;">{{ update.error }}</div>

      <details v-if="update?.latest.notesText" style="margin-top: 10px;">
        <summary class="muted" style="font-size: var(--fs-xs); cursor: pointer;">Release notes (plain text)</summary>
        <pre class="rebel-pre" style="white-space: pre-wrap;">{{ update.latest.notesText }}</pre>
      </details>

      <div class="row" style="gap: 8px; margin-top: 12px; flex-wrap: wrap;">
        <Btn variant="ghost" icon="refresh" :disabled="checking" @click="checkNow">{{ checking ? 'Checking…' : 'Check now' }}</Btn>
        <Btn :variant="update?.available ? 'primary' : 'ghost'" icon="import" :disabled="!dockerReady || opRunning || update?.pinned === true"
             :title="!dockerAccess ? DOCKER_OFF_REASON : undefined" @click="confirmUpdate = true">Update now</Btn>
        <span v-if="!dockerAccess" class="muted" style="font-size: var(--fs-xs); align-self: center;">{{ DOCKER_OFF_REASON }}</span>
      </div>

      <div v-if="op || lastOp" style="margin-top: 12px;">
        <div class="row" style="gap: 8px; align-items: center; font-size: var(--fs-xs);">
          <StatusDot :status="op ? 'warn' : lastOp?.ok ? 'good' : 'bad'" :pulse="!!op" />
          <span>{{ opKindLabel((op ?? lastOp)!.kind) }} · {{ (op ?? lastOp)!.phase }}</span>
          <span v-if="op?.pull && op.phase === 'pulling'" class="muted">
            · {{ op.pull.percent != null ? `${op.pull.percent}%` : '…' }} ({{ op.pull.layersDone }}/{{ op.pull.layers }} layers)
          </span>
          <span v-if="!op && lastOp?.error" style="color: var(--bad);">· {{ lastOp.error }}</span>
        </div>
        <pre class="mono rebel-pre" style="margin-top: 6px;">{{ lastOpTail.join('\n') }}</pre>
      </div>

      <div class="divider" />
      <SettingsRow label="Auto-update" :hint="dockerAccess ? 'Install new Rebel IPTV releases on a schedule (Rebel stops serving channels when it falls too far behind).' : DOCKER_OFF_REASON">
        <template #right>
          <Toggle :on="!!status.config.autoUpdate && dockerAccess" :disabled="!dockerAccess" @change="toggleAutoUpdate" />
        </template>
      </SettingsRow>
      <template v-if="status.config.autoUpdate && dockerAccess">
        <SettingsRow label="Only when idle" hint="Wait while anyone watches a Rebel IPTV channel. After 3 deferrals the update runs anyway.">
          <template #right>
            <Toggle :on="status.config.idleOnly" @change="toggleIdleOnly" />
          </template>
        </SettingsRow>
        <template v-if="schedLoaded">
          <FrequencyBuilder :freq="schedFreq" :auto="true" v-model:rawCron="schedRawCron"
                            :modes="SCHEDULE_MODES" label="Update window" icon="refresh" manualHint="" />
          <div class="row" style="gap: 8px; margin-top: 12px;">
            <Btn variant="primary" icon="check" :disabled="schedSaving" @click="saveSchedule">{{ schedSaving ? 'Saving…' : 'Save window' }}</Btn>
          </div>
        </template>
      </template>
    </div>

    <div class="card" v-if="status">
      <h3 class="section-title">Connection &amp; catalog</h3>
      <div class="rebel-grid">
        <div class="muted">Internal URL</div>
        <div class="mono" style="font-size: var(--fs-xs);">{{ status.internalUrl ?? '—' }}</div>
        <div class="muted">Channels</div>
        <div>
          <template v-if="catalog?.provisioned">{{ catalog.channels }} · last sync {{ fmtWhen(catalog.lastSync) }}
            <Pill v-if="catalog.status" :tone="catalog.status === 'good' ? 'good' : 'warn'" style="margin-left: 4px;">{{ catalog.status }}</Pill>
          </template>
          <span v-else class="muted">playlist not added yet</span>
        </div>
        <div class="muted">Guide</div>
        <div>
          <template v-if="catalog?.epg">{{ catalog.epg.programs }} programmes · {{ catalog.epg.channels }} channels · {{ fmtWhen(catalog.epg.lastSync) }}</template>
          <span v-else class="muted">—</span>
        </div>
      </div>
      <div v-if="catalog?.lastFetchError" class="row" style="gap: 8px; margin-top: 10px; padding: 8px 10px; background: var(--bg-2); border-radius: 8px; align-items: flex-start;">
        <span style="color: var(--bad); margin-top: 1px;"><Icon name="x" :size="13" /></span>
        <span style="font-size: var(--fs-xs); color: var(--text-1);">{{ catalog.lastFetchError }}</span>
      </div>

      <div class="divider" />
      <div class="form-row">
        <div class="field-lbl">Playlist API key</div>
        <div class="row" style="gap: 8px; align-items: center;">
          <div class="input mono" style="flex: 1;">
            <Icon name="lock" :size="14" />
            <input v-model="apiKeyInput" type="password" autocomplete="off"
                   :placeholder="catalog?.keySet ? '•••••••• (configured)' : 'Only if Rebel IPTV requires one'" @keyup.enter="saveKey" />
          </div>
          <Btn variant="ghost" size="sm" icon="check" :disabled="!apiKeyInput.trim()" @click="saveKey">Save</Btn>
          <Btn v-if="catalog?.keySet" variant="ghost" size="sm" icon="trash" @click="clearKey">Clear</Btn>
        </div>
        <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
          Rebel IPTV → Settings → Security → Playlist key. Leave empty if the key is off.
        </div>
      </div>
      <div class="form-row" style="margin-top: 12px;">
        <div class="field-lbl">Max simultaneous streams</div>
        <div class="row" style="gap: 8px; align-items: center;">
          <div class="input" style="width: 110px;"><input v-model.number="maxStreams" type="number" min="1" max="32" /></div>
          <Btn variant="ghost" size="sm" icon="check" @click="saveMaxStreams">Save</Btn>
        </div>
        <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
          Match Rebel IPTV's own "Simultaneous streams" setting (default 4) so masqueradarr refuses the extra viewer cleanly.
        </div>
      </div>

      <div class="row" style="gap: 8px; margin-top: 14px; flex-wrap: wrap; align-items: center;">
        <Btn variant="ghost" icon="activity" :disabled="busy === 'test'" @click="testConnection">{{ busy === 'test' ? 'Testing…' : 'Test' }}</Btn>
        <Btn v-if="!catalog?.provisioned" variant="primary" icon="plus" :disabled="!!busy" @click="run('Add playlist', () => rebel.addPlaylist(), 'Rebel IPTV playlist added.')">Add Rebel IPTV playlist</Btn>
        <Btn v-else variant="ghost" icon="sync" :disabled="!!busy" @click="run('Sync', () => rebel.syncNow(), 'Synced.')">{{ busy === 'sync' ? 'Syncing…' : 'Sync now' }}</Btn>
        <span v-if="testResult" style="font-size: var(--fs-xs);" :style="{ color: testResult.ok ? 'var(--good)' : 'var(--bad)' }">
          {{ testResult.ok ? `OK — ${testResult.channels} channels in ${testResult.ms} ms` : testResult.error }}
        </span>
      </div>
    </div>

    <div class="card" v-if="status">
      <h3 class="section-title">Actions</h3>
      <div class="row" style="gap: 8px; flex-wrap: wrap;">
        <Btn variant="primary" icon="link" @click="openRebelIptv">Open Rebel IPTV</Btn>
        <Btn variant="ghost" icon="refresh" :disabled="!dockerReady || opRunning || !container" :title="!dockerAccess ? DOCKER_OFF_REASON : undefined"
             @click="run('Restart', () => rebel.restart(), 'Restarting…')">Restart</Btn>
        <Btn v-if="canStart" variant="ghost" icon="play" :disabled="!dockerReady || opRunning" @click="run('Start', () => rebel.start(), 'Starting…')">Start</Btn>
        <Btn v-if="status.mode === 'managed'" variant="ghost" icon="sync" :disabled="!dockerReady || opRunning"
             @click="run('Repair', () => rebel.repair(), 'Re-provisioning…')">Repair</Btn>
        <Btn variant="ghost" icon="file" :disabled="!dockerReady" :title="!dockerAccess ? DOCKER_OFF_REASON : undefined" @click="logsOpen = true">View logs</Btn>
      </div>
      <div v-if="!dockerAccess" class="muted" style="font-size: var(--fs-xs); margin-top: 8px;">
        Restart, Repair and View logs: {{ DOCKER_OFF_REASON.toLowerCase() }}.
      </div>
      <div class="muted" style="font-size: var(--fs-xs); margin-top: 8px;">
        The pop-up is Rebel IPTV's own dashboard, reached through an admin-only gate on port {{ status.ui.port }}. Playlist URLs shown
        inside it are for its internal address — give external players masqueradarr's playlist instead.
      </div>
    </div>

    <div v-if="confirmUpdate" class="modal-bg" @click="confirmUpdate = false">
      <div class="modal" @click.stop style="width: 500px; max-width: 92vw;">
        <div class="modal-hd">
          <Icon name="import" :size="18" />
          <h2>Update Rebel IPTV?</h2>
          <span class="spacer" />
          <Btn variant="ghost" size="sm" icon="x" @click="confirmUpdate = false" />
        </div>
        <div class="modal-body">
          <p style="margin-top: 0;">
            masqueradarr pulls <code class="mono">{{ update?.current?.tag ?? container?.image.ref }}</code>, stops the running container,
            starts the new one on the same data and waits for it to report healthy. If it doesn't, the previous container is restored.
          </p>
          <p class="muted" style="font-size: var(--fs-sm);">Expected downtime: about a minute (Rebel can take up to 3 minutes on a slow first start).</p>
          <div v-if="viewers.streams > 0" class="row" style="gap: 8px; padding: 8px 10px; border: 1px solid var(--warn); border-radius: 8px; align-items: flex-start;">
            <span style="color: var(--warn);"><Icon name="warn" :size="13" /></span>
            <span style="font-size: var(--fs-xs);">
              {{ viewers.streams }} Rebel IPTV stream(s) are playing and will be interrupted:
              <span class="mono">{{ viewers.channels.slice(0, 8).join(', ') }}<template v-if="viewers.channels.length > 8"> …</template></span>
            </span>
          </div>
        </div>
        <div class="modal-ft row" style="gap: 8px; justify-content: flex-end;">
          <Btn variant="ghost" @click="confirmUpdate = false">Cancel</Btn>
          <Btn variant="primary" icon="import" @click="doUpdate">Update now</Btn>
        </div>
      </div>
    </div>

    <RebelLogsDrawer v-if="logsOpen" :fetch-logs="rebel.fetchLogs" @close="logsOpen = false" />
  </div>
</template>

<style scoped>
.rebel-grid {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 6px 14px;
  font-size: var(--fs-sm);
  align-items: baseline;
}
.rebel-pre {
  margin: 0;
  padding: 8px 10px;
  background: var(--bg-2);
  border-radius: 8px;
  font-size: var(--fs-xs);
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
