<script setup lang="ts">
import Icon from './Icon.vue';
import Pill from './Pill.vue';
import CopyConfirmModal from './CopyConfirmModal.vue';
import { useCopyConfirm } from '../composables/useCopyConfirm';
import type { PublishedGroup } from '../composables/usePublishedUrls';

withDefaults(
    defineProps<{
        groups: PublishedGroup[];
        layout?: 'stack' | 'grid';
        showUrls?: boolean;
    }>(),
    { layout: 'stack', showUrls: true },
);

const { copyModal, copyFailed, copyPublishedUrl, copyModalEpg, closeCopyModal } = useCopyConfirm();
</script>

<template>
    <div :class="['url-groups', layout]">
        <div v-for="group in groups" :key="group.key" class="url-card" :class="{ 'header-only': !showUrls }">
            <div class="url-card-hdr">
                <Icon name="list" :size="13" />
                <span class="url-card-name">{{ group.name }}</span>
                <Pill :tone="group.kind === 'Global' ? 'cyan' : 'default'">{{ group.kind }}</Pill>
            </div>
            <div v-if="showUrls" class="url-field">
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
            <div v-if="showUrls" class="url-field">
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
.url-groups.stack {
    display: flex;
    flex-direction: column;
    gap: 12px;
}
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
.url-card.header-only {
    gap: 0;
}
.url-card.header-only .url-card-hdr {
    padding-bottom: 0;
    border-bottom: 0;
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
