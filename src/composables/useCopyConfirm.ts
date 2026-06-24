import { ref, onMounted, onBeforeUnmount } from 'vue';
import type { PublishedGroup } from './usePublishedUrls';

// ── Shared copy-to-clipboard + confirmation-modal state machine ─────────────────────────────────────────
// A factory composable (NOT a module singleton) so every consumer gets its own isolated modal state. After a
// successful copy it opens a small centered confirmation dialog that shows exactly what was copied. For an
// M3U URL it ALSO surfaces the XMLTV-EPG guidance + that same card's EPG/Guide URL (a one-click follow-up);
// for an EPG/Guide URL it's a plain "copied" confirmation. Owns the robust clipboard write (with a non-secure
// context fallback) and the Esc-to-dismiss handler so the modal works identically on every screen.

export interface CopyModalState {
    title: string;
    copiedLabel: string; // human label of what was copied (e.g. "Global Playlist M3U")
    copiedUrl: string; // the value that landed on the clipboard
    kind: 'm3u' | 'epg'; // gates the XMLTV note + the secondary EPG affordance
    epgUrl: string; // the SAME card's guide URL — only surfaced for kind === 'm3u'
    epgLabel: string;
}

// The exact note rendered for M3U copies. Exported so a consumer or test can reference the canonical wording.
export const M3U_EPG_NOTE =
    'The XMLTV-EPG tag + URL is already included in this playlist. If your IPTV client player does not '
    + 'recognize the included XMLTV-EPG tag, then use the link below the playlist to manually add '
    + 'XMLTV-EPG as a source.';

// Robust copy that survives a non-secure context (plain http on a LAN IP): navigator.clipboard only exists in
// secure contexts, so fall back to a hidden-textarea + execCommand('copy') when it's missing or rejects.
// Resolves true on success so the caller can decide whether to surface the confirmation modal.
export async function writeClipboard(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // fall through to the legacy path
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        // Keep it off-screen and non-disruptive to scroll/focus.
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

    // Copy a published-URL row and open the confirmation modal. `kind` comes from the grouped data (m3u vs
    // epg), so the note is gated on data — never on string-matching a label. For an m3u row we thread the
    // SAME card's EPG URL through so the modal can offer it as a one-click follow-up.
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

    // In-modal copy of the secondary EPG URL (the "manually add XMLTV-EPG" follow-up). Re-points the modal to
    // the EPG kind so the note disappears and the heading reflects the new copy, without closing the dialog.
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

    // Esc closes the copy-confirmation modal first (it layers above any drawer). Bound globally so it works
    // regardless of which element holds focus; stopPropagation so a drawer behind it isn't also dismissed.
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
