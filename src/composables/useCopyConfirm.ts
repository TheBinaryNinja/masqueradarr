import { ref, onMounted, onBeforeUnmount } from 'vue';
import type { PublishedGroup } from './usePublishedUrls';


export interface CopyModalState {
    title: string;
    copiedLabel: string;
    copiedUrl: string;
    kind: 'm3u' | 'epg';
    epgUrl: string;
    epgLabel: string;
}

export const M3U_EPG_NOTE =
    'The XMLTV-EPG tag + URL is already included in this playlist. If your IPTV client player does not '
    + 'recognize the included XMLTV-EPG tag, then use the link below the playlist to manually add '
    + 'XMLTV-EPG as a source.';

export async function writeClipboard(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.left = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

export function useCopyConfirm() {
    const copyModal = ref<CopyModalState | null>(null);
    const copyFailed = ref(false);

    async function copyPublishedUrl(group: PublishedGroup, kind: 'm3u' | 'epg') {
        const row = kind === 'm3u' ? group.m3u : group.epg;
        const ok = await writeClipboard(row.url);
        copyFailed.value = !ok;
        copyModal.value = {
            title: ok ? 'Copied to clipboard' : 'Copy failed',
            copiedLabel: row.copyLabel,
            copiedUrl: row.url,
            kind,
            epgUrl: group.epg.url,
            epgLabel: group.epg.copyLabel,
        };
    }

    async function copyModalEpg() {
        const m = copyModal.value;
        if (!m) return;
        const ok = await writeClipboard(m.epgUrl);
        copyFailed.value = !ok;
        copyModal.value = {
            ...m,
            title: ok ? 'Copied to clipboard' : 'Copy failed',
            copiedLabel: m.epgLabel,
            copiedUrl: m.epgUrl,
            kind: 'epg',
        };
    }

    function closeCopyModal() {
        copyModal.value = null;
        copyFailed.value = false;
    }

    function onKeydown(e: KeyboardEvent) {
        if (e.key !== 'Escape') return;
        if (copyModal.value) {
            e.stopPropagation();
            closeCopyModal();
        }
    }

    onMounted(() => window.addEventListener('keydown', onKeydown));
    onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

    return {
        copyModal,
        copyFailed,
        M3U_EPG_NOTE,
        copyPublishedUrl,
        copyModalEpg,
        closeCopyModal,
    };
}
