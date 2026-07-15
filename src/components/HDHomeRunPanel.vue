<script setup lang="ts">
// HDHomeRun tuner manager (Settings → HDHomeRun). Create / edit / delete emulated tuners over the shared
// HDHOMERUN_TUNERS registry (server: HdhrTuner collection + /api/hdhomerun-tuners). Each tuner wires one
// Playlist and is discovered by Plex/Emby (UDP + the /hdhr/<id> serving surface). Modeled on TagManager.vue's
// store-CRUD pattern, but a card per tuner (a tuner has several fields). The Stream-format control writes the
// wired playlist's proxy config (app_<playlistId>) — MPEG-TS is what an HDHomeRun DVR app expects.
import { ref, reactive, computed, onMounted } from 'vue';
import Btn from './Btn.vue';
import Icon from './Icon.vue';
import Toggle from './Toggle.vue';
import Segmented from './Segmented.vue';
import EndpointField from './EndpointField.vue';
import {
  HDHOMERUN_TUNERS,
  PLAYLISTS,
  reloadTuners,
  reloadPlaylists,
  createTuner,
  updateTuner,
  deleteTuner,
  type HdhrTuner,
  type TunerPatch,
} from '../data';
import { USERS, ensureUsers } from '../composables/useUsers';

const opError = ref('');
const loading = ref(false);
// Bumped after any inline edit (blur/@change) to force the one-way :value controls to re-sync to the store,
// so a rejected or no-op edit reverts to the persisted value instead of leaving the field visually diverged.
const rev = ref(0);

onMounted(async () => {
  loading.value = true;
  try {
    await Promise.all([reloadTuners(), reloadPlaylists(), ensureUsers().catch(() => {})]);
    await Promise.all(HDHOMERUN_TUNERS.value.map(loadFormat));
  } catch (e) {
    opError.value = `Failed to load: ${(e as Error).message}`;
  } finally {
    loading.value = false;
  }
});

const playlistOptions = computed(() => [...PLAYLISTS.value].sort((a, b) => a.name.localeCompare(b.name)));
const userOptions = computed(() => [...USERS.value].sort((a, b) => a.username.localeCompare(b.username)));

const origin = window.location.origin;
function tunerBase(t: HdhrTuner): string {
  return `${origin}/hdhr/${t.id}`;
}

// ── Stream format (TS/HLS) per wired-playlist proxy config (app_<playlistId>) ──
const formats = reactive<Record<string, 'ts' | 'hls'>>({});
function cfgPath(playlistId: string): string {
  return `/api/proxy-configs/${encodeURIComponent(`app_${playlistId}`)}`;
}
async function loadFormat(t: HdhrTuner): Promise<void> {
  try {
    // Prefer the per-playlist override; when none exists (404) fall back to the EFFECTIVE Default config, so the
    // control reflects what the tuner actually serves (resolveProxyConfig does the same Custom→Default fallback).
    let res = await fetch(cfgPath(t.playlistId));
    if (!res.ok) res = await fetch('/api/proxy-configs');
    formats[t.id] = res.ok && (await res.json()).outputFormat === 'ts' ? 'ts' : 'hls';
  } catch {
    formats[t.id] = 'hls';
  }
}
async function setFormat(t: HdhrTuner, fmt: string): Promise<void> {
  const v = fmt === 'ts' ? 'ts' : 'hls';
  const prev = formats[t.id] ?? 'hls';
  if (v === prev) return; // no-op: don't write an override just for clicking the already-shown value
  formats[t.id] = v; // optimistic
  try {
    // If a per-playlist override already exists, only change outputFormat. If not, SEED the new override from
    // the effective Default (not env defaults) so the wired playlist inherits the operator's other proxy knobs
    // (timeouts / UA / header overrides) instead of silently reverting them.
    const existing = await fetch(cfgPath(t.playlistId));
    let body: Record<string, unknown>;
    if (existing.ok) {
      body = { outputFormat: v };
    } else {
      const def = await fetch('/api/proxy-configs');
      body = { ...(def.ok ? await def.json() : {}), outputFormat: v };
    }
    const res = await fetch(cfgPath(t.playlistId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    formats[t.id] = prev; // rollback the optimistic toggle so the control matches server state
    opError.value = 'Could not update stream format.';
  }
}

const ERR: Record<string, string> = {
  playlist_already_wired: 'That playlist is already wired to another tuner.',
  playlist_not_found: 'Playlist not found.',
  owner_not_found: 'Owner account not found.',
  owner_stream_token_disabled: 'That account has its stream token disabled.',
};
const friendly = (msg: string): string => ERR[msg] ?? msg;

async function save(t: HdhrTuner, patch: TunerPatch): Promise<void> {
  opError.value = '';
  try {
    const updated = await updateTuner(t.id, patch);
    if (patch.playlistId) await loadFormat(updated);
  } catch (e) {
    opError.value = friendly((e as Error).message);
  } finally {
    rev.value++; // re-sync :value controls (a rejected edit leaves the store unchanged → revert the DOM)
  }
}
function saveName(t: HdhrTuner, raw: string): void {
  const name = raw.trim();
  if (name && name !== t.friendlyName) save(t, { friendlyName: name });
  else rev.value++; // empty or unchanged → revert the field to the stored name
}
function saveCount(t: HdhrTuner, raw: string): void {
  const n = parseInt(raw, 10);
  const clamped = Number.isFinite(n) ? Math.max(1, Math.min(12, n)) : NaN;
  if (Number.isFinite(clamped) && clamped !== t.tunerCount) save(t, { tunerCount: clamped });
  else rev.value++; // invalid or unchanged (incl. clamped-to-same) → revert the field
}

// ── Delete (inline confirm) ──
const confirmDelete = ref<string | null>(null);
async function doDelete(id: string): Promise<void> {
  confirmDelete.value = null;
  try {
    await deleteTuner(id);
  } catch (e) {
    opError.value = `Delete failed: ${(e as Error).message}`;
  }
}

// ── Add ──
const showAdd = ref(false);
const draft = reactive({ friendlyName: 'masqueradarr HDHR', playlistId: '', tunerCount: 2, ownerUsername: '' });
const creating = ref(false);
function resetDraft(): void {
  draft.friendlyName = 'masqueradarr HDHR';
  draft.playlistId = '';
  draft.tunerCount = 2;
  draft.ownerUsername = '';
}
async function add(): Promise<void> {
  if (!draft.playlistId || !draft.friendlyName.trim() || creating.value) return;
  creating.value = true;
  opError.value = '';
  try {
    const t = await createTuner({
      friendlyName: draft.friendlyName.trim(),
      playlistId: draft.playlistId,
      tunerCount: Math.max(1, Math.min(12, draft.tunerCount || 2)),
      ownerUsername: draft.ownerUsername || undefined,
    });
    await loadFormat(t);
    showAdd.value = false;
    resetDraft();
  } catch (e) {
    opError.value = friendly((e as Error).message);
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="card">
    <h3 class="section-title">Tuner Emulator</h3>
    <div class="muted" style="font-size: var(--fs-xs); margin-bottom: 10px;">
      The Tuner Emulator broadcasts the same discovery signal and lineup format as a physical HDHomeRun network
      tuner, making masqueradarr a drop-in, compatible tuner for Plex — and other DVR apps like Emby, Jellyfin,
      and Channels — with no HDHomeRun hardware required. Each emulated tuner exposes a wired playlist — its
      channels and its guide — as MPEG-TS, which is what those DVR apps expect. Tuners are auto-discovered over
      the LAN; you can also add one by its base URL below.
    </div>

    <div v-if="!HDHOMERUN_TUNERS.length && !loading" class="muted" style="font-size: var(--fs-xs);">
      No tuners yet. Add one to make a playlist available to your DVR app.
    </div>

    <div class="tuner-list">
      <div v-for="t in HDHOMERUN_TUNERS" :key="t.id" class="tuner-card">
        <div class="tuner-hd">
          <div class="input" style="flex: 1;">
            <Icon name="tv" :size="14" />
            <input :key="'n' + t.id + rev" :value="t.friendlyName" @change="(e) => saveName(t, (e.target as HTMLInputElement).value)" />
          </div>
          <label class="tuner-enabled" :title="t.enabled ? 'Enabled' : 'Disabled'">
            <Toggle :on="t.enabled" @change="(v: boolean) => save(t, { enabled: v })" />
          </label>
          <template v-if="confirmDelete === t.id">
            <Btn variant="ghost" size="sm" @click="confirmDelete = null">Cancel</Btn>
            <button class="btn ghost danger" @click="doDelete(t.id)"><Icon name="trash" :size="14" />Delete</button>
          </template>
          <Btn v-else variant="ghost" size="sm" icon="trash" title="Delete tuner" @click="confirmDelete = t.id" />
        </div>

        <div class="form-grid-2" style="margin-top: 10px;">
          <div class="form-row">
            <div class="field-lbl">Wired playlist</div>
            <div class="select fill">
              <select :key="'p' + t.id + rev" :value="t.playlistId" @change="(e) => save(t, { playlistId: (e.target as HTMLSelectElement).value })">
                <option v-for="p in playlistOptions" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="field-lbl">Tuner count (1–12)</div>
            <div class="input">
              <input
                :key="'c' + t.id + rev"
                type="number"
                min="1"
                max="12"
                :value="t.tunerCount"
                @change="(e) => saveCount(t, (e.target as HTMLInputElement).value)"
              />
            </div>
          </div>
          <div class="form-row">
            <div class="field-lbl">Owner account (authorizes streams)</div>
            <div class="select fill">
              <select :key="'o' + t.id + rev" :value="t.ownerUsername" @change="(e) => save(t, { ownerUsername: (e.target as HTMLSelectElement).value })">
                <option v-for="u in userOptions" :key="u._id" :value="u.username">{{ u.username }}</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="field-lbl">Stream format</div>
            <Segmented
              :value="formats[t.id] ?? 'hls'"
              @change="(v: string) => setFormat(t, v)"
              :options="[{ value: 'ts', label: 'MPEG-TS' }, { value: 'hls', label: 'HLS' }]"
            />
          </div>
        </div>

        <div class="form-row" style="margin-top: 10px;">
          <div class="field-lbl">Device ID</div>
          <div class="row" style="gap: 8px; align-items: center;">
            <div class="input mono" style="flex: 1;"><input :value="t.deviceId" readonly /></div>
            <Btn variant="ghost" size="sm" icon="refresh" title="Regenerate Device ID" @click="save(t, { regenerateDeviceId: true })">New ID</Btn>
          </div>
        </div>

        <div class="tuner-urls">
          <EndpointField label="Discover URL" icon="globe" mono readonly :model-value="`${tunerBase(t)}/discover.json`" />
          <EndpointField label="Lineup URL" icon="list" mono readonly :model-value="`${tunerBase(t)}/lineup.json`" />
          <EndpointField label="Guide (XMLTV) URL" icon="epg" mono readonly :model-value="`${tunerBase(t)}/epg.xml`" />
        </div>
        <div class="muted" style="font-size: var(--fs-xs); margin-top: 4px;">
          On your LAN, replace the host above with this server's LAN IP if your DVR app can't reach this
          address. Plex auto-discovers the tuner; Emby/Jellyfin can also add it by the base URL
          <code>{{ tunerBase(t) }}</code>.
        </div>
      </div>
    </div>

    <!-- Add tuner -->
    <div v-if="showAdd" class="tuner-card" style="margin-top: 10px;">
      <div class="form-grid-2">
        <div class="form-row">
          <div class="field-lbl">Friendly name</div>
          <div class="input"><input v-model="draft.friendlyName" placeholder="masqueradarr HDHR" /></div>
        </div>
        <div class="form-row">
          <div class="field-lbl">Wired playlist</div>
          <div class="select fill">
            <select v-model="draft.playlistId">
              <option value="" disabled>Select a playlist…</option>
              <option v-for="p in playlistOptions" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="field-lbl">Tuner count (1–12)</div>
          <div class="input"><input type="number" min="1" max="12" v-model.number="draft.tunerCount" /></div>
        </div>
        <div class="form-row">
          <div class="field-lbl">Owner account</div>
          <div class="select fill">
            <select v-model="draft.ownerUsername">
              <option value="">(current admin)</option>
              <option v-for="u in userOptions" :key="u._id" :value="u.username">{{ u.username }}</option>
            </select>
          </div>
        </div>
      </div>
      <div class="row" style="gap: 8px; margin-top: 10px; justify-content: flex-end;">
        <Btn variant="ghost" @click="showAdd = false">Cancel</Btn>
        <Btn variant="primary" :disabled="!draft.playlistId || !draft.friendlyName.trim() || creating" @click="add">Add tuner</Btn>
      </div>
    </div>
    <div v-else class="row" style="margin-top: 10px;">
      <Btn variant="ghost" icon="plus" :disabled="!playlistOptions.length" @click="showAdd = true">Add tuner</Btn>
      <span v-if="!playlistOptions.length" class="muted" style="font-size: var(--fs-xs); margin-left: 8px;">
        Create a playlist first.
      </span>
    </div>

    <div v-if="opError" class="muted" style="font-size: var(--fs-xs); color: var(--bad); margin-top: 8px;">{{ opError }}</div>
  </div>
</template>

<style scoped>
.tuner-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tuner-card {
  border: 1px solid var(--hairline);
  border-radius: var(--radius-m);
  background: var(--bg-2);
  padding: 12px;
}
.tuner-hd {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tuner-enabled {
  display: flex;
  align-items: center;
}
.tuner-urls {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}
</style>
