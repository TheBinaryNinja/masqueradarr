<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import Segmented from './Segmented.vue';

// Restore a full-workspace backup — either a file the operator picks (file mode) or one already saved on
// disk by the scheduled backup job (saved mode). Both POST to /api/backup/restore* and return
// { restored, skipped, errors }. A restore REPLACES the current configuration/mappings/users, so the
// caller reloads the app on success. The file body is sent RAW (the backend reads request bytes): gzip is
// auto-detected from the magic bytes (0x1f 0x8b) so the Content-Type is correct.
const emit = defineEmits<{ (e: 'close'): void; (e: 'restored'): void }>();

interface SavedBackup { filename: string; createdAt: string; size: number }
interface RestoreResult { restored: Record<string, number>; skipped: string[]; errors: string[] }

const mode = ref<'file' | 'saved'>('file');

// ── file mode ────────────────────────────────────────────────────────────
const fileInput = ref<HTMLInputElement | null>(null);
const file = ref<File | null>(null);
const restoring = ref(false);
const error = ref('');

function onFileChange(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  file.value = f;
  error.value = '';
}

function resetFile() {
  file.value = null;
  error.value = '';
  if (fileInput.value) fileInput.value.value = '';
}

async function restoreFromFile() {
  if (!file.value || restoring.value) return;
  restoring.value = true;
  error.value = '';
  try {
    const magic = new Uint8Array(await file.value.slice(0, 2).arrayBuffer());
    const isGzip = magic[0] === 0x1f && magic[1] === 0x8b;
    const res = await fetch('/api/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': isGzip ? 'application/gzip' : 'application/json' },
      body: file.value,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    emit('restored');
    emit('close');
  } catch {
    error.value = 'Could not restore the backup — please check the file and try again.';
    restoring.value = false;
  }
}

// ── saved mode ───────────────────────────────────────────────────────────
const saved = ref<SavedBackup[]>([]);
const loadingList = ref(false);
const listError = ref('');
const restoringName = ref('');

async function loadList() {
  loadingList.value = true;
  listError.value = '';
  try {
    const res = await fetch('/api/backup/list');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    saved.value = (await res.json()) as SavedBackup[];
  } catch {
    listError.value = 'Could not load saved backups.';
    saved.value = [];
  } finally {
    loadingList.value = false;
  }
}

// Lazy-load the saved list whenever the saved tab becomes active (first show + on every switch).
watch(mode, (m) => { if (m === 'saved') loadList(); }, { immediate: false });

async function restoreFromSaved(name: string) {
  if (restoringName.value) return;
  restoringName.value = name;
  listError.value = '';
  try {
    const res = await fetch(`/api/backup/restore/${encodeURIComponent(name)}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    emit('restored');
    emit('close');
  } catch {
    listError.value = `Could not restore "${name}" — please try again.`;
    restoringName.value = '';
  }
}

function fmtSize(bytes: number): string {
  if (!bytes || Number.isNaN(bytes)) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const canRestoreFile = computed(() => !!file.value && !restoring.value);
</script>

<template>
  <div class="modal-bg" @click="emit('close')">
    <div class="modal" @click.stop style="width: 560px; max-width: 92vw;">
      <div class="modal-hd">
        <Icon name="refresh" :size="18" />
        <h2>Restore backup</h2>
        <span class="spacer" />
        <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
      </div>

      <div class="modal-body">
        <Segmented :value="mode" @change="(v) => mode = v as 'file' | 'saved'" :options="[
          { value: 'file', label: 'Restore from file', icon: 'upload' },
          { value: 'saved', label: 'Restore from backup', icon: 'file' },
        ]" />

        <div class="row" style="gap: 8px; padding: 10px 12px; background: var(--accent-soft); border-radius: 8px; align-items: flex-start;">
          <span style="color: var(--bad); margin-top: 1px;"><Icon name="warn" :size="14" /></span>
          <div style="font-size: var(--fs-xs); line-height: 1.5;">
            <div style="color: var(--bad); font-weight: 600;">This replaces your current configuration, mappings, and users.</div>
            <div class="muted" style="margin-top: 2px;">Backups can contain credentials — only restore one you trust.</div>
          </div>
        </div>

        <!-- file mode -->
        <template v-if="mode === 'file'">
          <input
            ref="fileInput"
            type="file"
            accept=".gz,.json,application/gzip,application/json"
            style="display: none;"
            @change="onFileChange"
          />
          <div v-if="!file" class="dropzone" @click="fileInput?.click()">
            <div class="icon-circle"><Icon name="upload" :size="20" /></div>
            <div>
              <h3>Choose a backup file</h3>
              <p>click to browse — .json or .json.gz</p>
            </div>
          </div>
          <div v-else class="row">
            <Icon name="file" :size="16" />
            <div style="flex: 1; font-weight: 600;">{{ file.name }}</div>
            <Pill>{{ fmtSize(file.size) }}</Pill>
            <Btn variant="ghost" size="sm" icon="x" @click="resetFile" />
          </div>
          <div v-if="error" class="muted" style="color: var(--bad); font-size: var(--fs-sm);">{{ error }}</div>
        </template>

        <!-- saved mode -->
        <template v-else>
          <div v-if="loadingList" class="muted" style="font-size: var(--fs-sm);">Loading saved backups…</div>
          <div v-else-if="listError" class="muted" style="color: var(--bad); font-size: var(--fs-sm);">{{ listError }}</div>
          <div v-else-if="!saved.length" class="muted" style="font-size: var(--fs-sm);">
            No saved backups yet. Enable a backup schedule on the Settings screen to write backups to disk.
          </div>
          <div v-else style="display: flex; flex-direction: column; gap: 8px;">
            <div v-for="b in saved" :key="b.filename" class="row"
                 style="gap: 10px; padding: 10px 12px; border: 1px solid var(--hairline); border-radius: 10px; background: var(--bg-2); align-items: center;">
              <Icon name="file" :size="16" />
              <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 600; font-size: var(--fs-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ b.filename }}</div>
                <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px;">{{ fmtDate(b.createdAt) }} · {{ fmtSize(b.size) }}</div>
              </div>
              <Btn variant="ghost" size="sm" icon="refresh" :disabled="!!restoringName" @click="restoreFromSaved(b.filename)">
                {{ restoringName === b.filename ? 'Restoring…' : 'Restore' }}
              </Btn>
            </div>
          </div>
        </template>
      </div>

      <div class="modal-ft">
        <span class="spacer" />
        <Btn variant="ghost" @click="emit('close')">Cancel</Btn>
        <Btn v-if="mode === 'file'" variant="primary" icon="refresh" :disabled="!canRestoreFile" @click="restoreFromFile">
          {{ restoring ? 'Restoring…' : 'Restore' }}
        </Btn>
      </div>
    </div>
  </div>
</template>
