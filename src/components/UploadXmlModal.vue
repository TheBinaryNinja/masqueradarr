<script setup lang="ts">
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import { fileToXmltvBody, type XmltvBody } from '../composables/xmltvUpload';
import { useToast } from '../composables/useToast';

const toast = useToast();

// Re-upload an XMLTV file for an existing 'xml file' EPG source — the detail-screen Upload action (the Sync
// replacement for a static uploaded guide). Validate-then-commit: the chosen file is validated against the
// backend (channel/program counts + a sample, or a list of specific issues) before POSTing it to
// /api/epg-sources/:id/upload, which replaces the source's channels/programs. Mirrors the Add modal's file
// panel. See AddEpgSourceModal.vue + restapi.md.

const props = defineProps<{ sourceId: string; sourceName: string }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'uploaded'): void }>();

interface XmltvSampleItem { channelNo: string | null; callSign: string | null; title: string; start: number; end: number }
interface XmltvValidation { ok: boolean; channelCount: number; programmeCount: number; sample: XmltvSampleItem[]; errors: string[] }

const fileInput = ref<HTMLInputElement | null>(null);
const fileName = ref('');
const body = ref<XmltvBody | null>(null); // the gzipped (or raw) file body, reused for validate + commit
const valid = ref<XmltvValidation | null>(null);
const error = ref('');
const validating = ref(false);
const uploading = ref(false);

const ready = computed(() => !!valid.value?.ok && !validating.value);

function fmtTime(ms: number) {
  if (!ms || Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function reset() {
  fileName.value = '';
  body.value = null;
  valid.value = null;
  error.value = '';
  if (fileInput.value) fileInput.value.value = '';
}

async function onFileChange(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  fileName.value = f.name;
  validating.value = true;
  error.value = '';
  valid.value = null;
  try {
    body.value = await fileToXmltvBody(f); // gzip in-stream (or pass a .xml.gz through)
    const res = await fetch('/api/epg-sources/xmltv/validate', {
      method: 'POST',
      headers: { 'Content-Type': body.value.contentType },
      body: body.value.body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    valid.value = (await res.json()) as XmltvValidation;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    validating.value = false;
  }
}

async function upload() {
  if (!ready.value || uploading.value || !body.value) return;
  uploading.value = true;
  error.value = '';
  try {
    const res = await fetch(
      `/api/epg-sources/${encodeURIComponent(props.sourceId)}/upload?filename=${encodeURIComponent(fileName.value)}`,
      { method: 'POST', headers: { 'Content-Type': body.value.contentType }, body: body.value.body },
    );
    if (!res.ok) throw new Error('upload failed');
    const result = await res.json().catch(() => null);
    if (result?.offsetDefaulted) {
      toast.lowerRight({
        tone: 'warn',
        title: 'Time zone offset not set',
        text: 'Stored guide times defaulted to UTC (+0000). Set a Time zone in Settings.',
      });
    }
    emit('uploaded');
    emit('close');
  } catch {
    error.value = 'Could not import the file — please try again.';
    uploading.value = false;
  }
}
</script>

<template>
  <div class="modal-bg" @click="emit('close')">
    <div class="modal" @click.stop>
      <div class="modal-hd">
        <Icon name="upload" :size="18" />
        <h2>Upload XMLTV</h2>
        <span class="spacer" />
        <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
      </div>

      <div class="modal-body">
        <div class="muted" style="font-size: var(--fs-sm);">
          Replace the guide data for <strong>{{ sourceName }}</strong> with a new XMLTV file.
        </div>

        <input
          ref="fileInput"
          type="file"
          accept=".xml,.xmltv,.gz,.xml.gz,application/xml,text/xml,application/gzip"
          style="display: none;"
          @change="onFileChange"
        />

        <div v-if="!fileName" class="dropzone" @click="fileInput?.click()">
          <div class="icon-circle"><Icon name="upload" :size="20" /></div>
          <div>
            <h3>Choose an XMLTV file</h3>
            <p>click to browse — .xml or .xml.gz, up to ~150 MB</p>
          </div>
        </div>
        <div v-else class="row">
          <Icon name="file" :size="16" />
          <div style="flex: 1; font-weight: 600;">{{ fileName }}</div>
          <Pill v-if="validating" tone="cyan">validating…</Pill>
          <Btn variant="ghost" size="sm" icon="x" @click="reset" />
        </div>

        <div v-if="validating" class="muted" style="margin-top: 12px; font-size: var(--fs-sm);">Validating XMLTV…</div>
        <div
          v-else-if="valid && valid.ok"
          class="card"
          style="margin-top: 12px; background: var(--bg-2); padding: 14px; display: flex; flex-direction: column; gap: 10px;"
        >
          <div class="row" style="gap: 8px; align-items: center;">
            <Pill tone="good"><Icon name="check" :size="11" />{{ valid.channelCount.toLocaleString() }} channels</Pill>
            <Pill>{{ valid.programmeCount.toLocaleString() }} programs</Pill>
          </div>
          <div v-if="valid.sample.length" style="display: flex; flex-direction: column; gap: 4px;">
            <div v-for="(s, i) in valid.sample" :key="i" class="row" style="gap: 8px; font-size: var(--fs-sm);">
              <span class="mono muted" style="min-width: 64px; max-width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ s.callSign }}</span>
              <span style="flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ s.title }}</span>
              <span class="mono muted" style="font-size: var(--fs-xs);">{{ fmtTime(s.start) }}–{{ fmtTime(s.end) }}</span>
            </div>
          </div>
        </div>
        <div v-else-if="valid && !valid.ok" style="margin-top: 12px; display: flex; flex-direction: column; gap: 4px;">
          <div
            v-for="(e, i) in valid.errors"
            :key="i"
            class="muted"
            style="color: var(--bad); font-size: var(--fs-sm); display: flex; gap: 6px; align-items: flex-start;"
          >
            <Icon name="warn" :size="12" /><span>{{ e }}</span>
          </div>
        </div>
        <div v-if="error" class="muted" style="margin-top: 10px; color: var(--bad); font-size: var(--fs-sm);">{{ error }}</div>
      </div>

      <div class="modal-ft">
        <Btn variant="ghost" @click="emit('close')">Cancel</Btn>
        <Btn variant="primary" icon="check" :disabled="!ready || uploading" @click="upload">
          {{ uploading ? 'Importing…' : 'Import & replace' }}
        </Btn>
      </div>
    </div>
  </div>
</template>
