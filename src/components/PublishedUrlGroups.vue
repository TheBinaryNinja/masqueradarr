<script setup lang="ts">
import Icon from './Icon.vue';
import Pill from './Pill.vue';
import CopyConfirmModal from './CopyConfirmModal.vue';
import { useCopyConfirm } from '../composables/useCopyConfirm';
import type { PublishedGroup } from '../composables/usePublishedUrls';

// Self-contained "Published URLs" renderer: one grouped .url-card per playlist (header = name + Global/Custom
// badge; two compact rows labelled "M3U" / "EPG / Guide", each an input + copy button), PLUS the shared
// copy-confirmation modal. A consumer drops in `<PublishedUrlGroups :groups :layout />` and gets cards + copy
// + modal for free — the copy state machine (clipboard write, XMLTV note, in-modal EPG follow-up, Esc/overlay/
// OK dismissal) lives in useCopyConfirm and is owned here, not duplicated per screen.
//
//   layout='stack' — the admin vertical layout EXACTLY (cards stacked top-to-bottom). Default.
//   layout='grid'  — a responsive horizontal grid of cards (the Dashboard layout).
withDefaults(
    defineProps<{
        groups: PublishedGroup[];
        layout?: 'stack' | 'grid';
    }>(),
    { layout: 'stack' },
);

const { copyModal, copyFailed, copyPublishedUrl, copyModalEpg, closeCopyModal } = useCopyConfirm();
</script>

<template>
    <div :class="['url-groups', layout]">
        <div v-for="group in groups" :key="group.key" class="url-card">
            <div class="url-card-hdr">
                <Icon name="list" :size="13" />
                <span class="url-card-name">{{ group.name }}</span>
                <Pill :tone="group.kind === 'Global' ? 'cyan' : 'default'">{{ group.kind }}</Pill>
            </div>
            <div class="url-field">
                <span class="url-field-label">M3U</span>
                <div class="url-row">
                    <div class="input mono url-input">
                        <Icon name="link" :size="13" />
                        <input readonly :value="group.m3u.url" @focus="(e) => (e.target as HTMLInputElement).select()" />
                    </div>
                    <button class="action-btn" :title="`Copy ${group.m3u.copyLabel} URL`" @click="copyPublishedUrl(group, 'm3u')">
                        <Icon name="copy" :size="13" />
                    </button>
                </div>
                <span class="muted font-xs">{{ group.m3u.hint }}</span>
            </div>
            <div class="url-field">
                <span class="url-field-label">EPG / Guide</span>
                <div class="url-row">
                    <div class="input mono url-input">
                        <Icon name="link" :size="13" />
                        <input readonly :value="group.epg.url" @focus="(e) => (e.target as HTMLInputElement).select()" />
                    </div>
                    <button class="action-btn" :title="`Copy ${group.epg.copyLabel} URL`" @click="copyPublishedUrl(group, 'epg')">
                        <Icon name="copy" :size="13" />
                    </button>
                </div>
                <span class="muted font-xs">{{ group.epg.hint }}</span>
            </div>
        </div>

        <CopyConfirmModal
            v-if="copyModal"
            :modal="copyModal"
            :failed="copyFailed"
            @close="closeCopyModal"
            @copy-epg="copyModalEpg"
        />
    </div>
</template>

<style scoped>
/* stack: the admin vertical layout — cards top-to-bottom with the same 12px gutter the drawer used. */
.url-groups.stack {
    display: flex;
    flex-direction: column;
    gap: 12px;
}
/* grid: a responsive horizontal grid — cards flow into as many columns as fit (min 280px each). */
.url-groups.grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
    align-items: start;
}
.url-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
}
.url-input {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    background: var(--bg-2);
    overflow: hidden;
}
.url-input input {
    width: 100%;
    border: none;
    background: transparent;
    color: var(--text-1);
    text-overflow: ellipsis;
}
/* One grouped card per published playlist — surface + border + padding separate it from its siblings, so the
   header (name + kind badge) is the grouping cue and its two short-labelled rows read as a single block. */
.url-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: var(--bg-2);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-s);
    padding: 12px;
}
.url-card-hdr {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--hairline);
    color: var(--text-2);
}
.url-card-name {
    font-weight: 600;
    font-size: var(--fs-sm);
    color: var(--text-1);
    margin-right: auto;
}
.url-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.url-field-label {
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-2);
    text-transform: uppercase;
    letter-spacing: 0.04em;
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
</style>
