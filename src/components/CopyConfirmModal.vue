<script setup lang="ts">
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import { M3U_EPG_NOTE, type CopyModalState } from '../composables/useCopyConfirm';

// Presentational copy-to-clipboard confirmation modal. Pure read-out: the open/close state and the copy
// behavior live in useCopyConfirm — this component renders the current state and emits the two user actions
// (dismiss + copy the secondary EPG URL). Layers ABOVE any drawer (copy-modal-bg z-index override); the OK
// button, the header ×, and an overlay click all emit `close`. (Esc is handled by useCopyConfirm globally.)
// For kind === 'm3u' it adds the XMLTV-EPG note + a one-click affordance for that card's EPG/Guide URL; for
// kind === 'epg' it's a plain confirmation. Uses the global .modal* surface classes so it matches the app's
// other modals.
defineProps<{
    modal: CopyModalState;
    failed?: boolean;
}>();

const emit = defineEmits<{
    (e: 'close'): void;
    (e: 'copy-epg'): void;
}>();
</script>

<template>
    <div
        class="modal-bg copy-modal-bg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copy-modal-title"
        @click="emit('close')"
    >
        <div class="modal copy-modal" @click.stop>
            <div class="modal-hd">
                <Icon :name="failed ? 'info' : 'check'" :size="18" />
                <h2 id="copy-modal-title">{{ modal.title }}</h2>
                <span class="spacer" />
                <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
            </div>
            <div class="modal-body">
                <div class="copy-row">
                    <div class="field-lbl">{{ modal.copiedLabel }}</div>
                    <div class="input mono copy-url">
                        <Icon name="link" :size="13" />
                        <input readonly :value="modal.copiedUrl" @focus="(e) => (e.target as HTMLInputElement).select()" />
                    </div>
                </div>

                <div v-if="failed" class="muted font-xs">
                    Automatic copy was blocked by the browser. The URL above is selected — press Ctrl/Cmd+C to copy it manually.
                </div>

                <!-- M3U-only XMLTV-EPG guidance + the card's EPG/Guide URL as a direct grab. Gated on the
                     data-carried kind flag (never on label string-matching). -->
                <template v-if="modal.kind === 'm3u'">
                    <div class="copy-note">
                        <Icon name="info" :size="13" />
                        <span>{{ M3U_EPG_NOTE }}</span>
                    </div>
                    <div class="copy-row">
                        <div class="field-lbl">{{ modal.epgLabel }}</div>
                        <div class="url-row">
                            <div class="input mono copy-url">
                                <Icon name="link" :size="13" />
                                <input readonly :value="modal.epgUrl" @focus="(e) => (e.target as HTMLInputElement).select()" />
                            </div>
                            <button class="action-btn" :title="`Copy ${modal.epgLabel} URL`" @click="emit('copy-epg')">
                                <Icon name="copy" :size="13" />
                            </button>
                        </div>
                    </div>
                </template>
            </div>
            <div class="modal-ft">
                <Btn variant="primary" icon="check" @click="emit('close')">OK</Btn>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* Copy-confirmation modal — reuses the global .modal* surface; only the layering + a couple of compact
   read-out rows are local. It must sit ABOVE the half-window drawer (.drawer-overlay z-index 100), so bump
   the global .modal-bg (90) past it here. */
.copy-modal-bg {
    z-index: 120;
}
.copy-modal {
    width: 480px;
    max-width: 92vw;
}
.copy-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.copy-url {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    background: var(--bg-2);
    overflow: hidden;
}
.copy-url input {
    width: 100%;
    border: none;
    background: transparent;
    color: var(--text-1);
    text-overflow: ellipsis;
}
.url-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
}
.action-btn {
    border: 0;
    background: var(--bg-2);
    border-radius: 4px;
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    color: var(--text-1);
    cursor: pointer;
    transition: background .12s, color .12s;
}
.action-btn:hover {
    background: var(--bg-3);
    color: var(--text-0);
}
.font-xs {
    font-size: 10.5px;
}
/* The XMLTV-EPG guidance block shown only for M3U copies. */
.copy-note {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 10px 12px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-s);
    background: var(--bg-2);
    color: var(--text-2);
    font-size: var(--fs-xs);
    line-height: 1.5;
}
.copy-note :deep(svg) {
    flex-shrink: 0;
    margin-top: 1px;
    color: var(--accent-hi);
}
</style>
