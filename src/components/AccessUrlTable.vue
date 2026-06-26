<script lang="ts">
import type { PublishedGroup } from '../composables/usePublishedUrls';

// One user's published-URL rows, consumed by the dense "Get access" table. Exported from a plain <script>
// block (a <script setup> cannot contain ES module exports) so GetAccessModal can type the rows it builds.
export interface AccessUserRows {
    id: string;
    username: string;
    role: 'admin' | 'user';
    groups: PublishedGroup[];
}
</script>

<script setup lang="ts">
import Icon from './Icon.vue';
import Pill from './Pill.vue';
import CopyConfirmModal from './CopyConfirmModal.vue';
import { useCopyConfirm } from '../composables/useCopyConfirm';

// ── Dense "all users' published URLs" table ─────────────────────────────────────────────────────────────
// Purpose-built for the "Get access" modal: a compact User | Playlist | M3U | EPG table that fits as many
// users as possible in one view. Each user contributes one row per PublishedGroup (M3U + EPG/Guide pair);
// the username cell is rowspan-merged across the user's groups so the playlist/URL columns stay dense. Copy
// reuses the shared useCopyConfirm state machine (clipboard write + XMLTV note + Esc/overlay dismissal) so it
// is identical to the Users screen — this component just renders compactly and owns the confirmation modal.

defineProps<{ rows: AccessUserRows[] }>();

const { copyModal, copyFailed, copyPublishedUrl, copyModalEpg, closeCopyModal } = useCopyConfirm();
</script>

<template>
    <div class="access-wrap">
        <table class="access-tbl">
            <thead>
                <tr>
                    <th class="c-user">User</th>
                    <th class="c-pl">Playlist</th>
                    <th class="c-url">M3U</th>
                    <th class="c-url">EPG / Guide</th>
                </tr>
            </thead>
            <tbody v-for="r in rows" :key="r.id" class="user-block">
                <!-- No-access user: a single muted row so the admin still sees who lacks URLs. -->
                <tr v-if="r.groups.length === 0" class="no-access">
                    <td class="c-user">
                        <div class="user-cell">
                            <div class="avatar-sm">{{ r.username.slice(0, 2).toUpperCase() }}</div>
                            <span class="uname" :title="r.username">{{ r.username }}</span>
                        </div>
                    </td>
                    <td colspan="3" class="muted">No published playlists — assign access to generate URLs.</td>
                </tr>
                <tr v-for="(g, i) in r.groups" v-else :key="g.key">
                    <td v-if="i === 0" :rowspan="r.groups.length" class="c-user">
                        <div class="user-cell">
                            <div class="avatar-sm">{{ r.username.slice(0, 2).toUpperCase() }}</div>
                            <div class="user-meta">
                                <span class="uname" :title="r.username">{{ r.username }}</span>
                                <Pill v-if="r.role === 'admin'" tone="cyan">admin</Pill>
                            </div>
                        </div>
                    </td>
                    <td class="c-pl">
                        <div class="pl-cell">
                            <span class="pl-name" :title="g.name">{{ g.name }}</span>
                            <Pill :tone="g.kind === 'Global' ? 'cyan' : 'default'">{{ g.kind }}</Pill>
                        </div>
                    </td>
                    <td class="c-url">
                        <div class="url-cell">
                            <span class="url-mono" :title="g.m3u.url">{{ g.m3u.url }}</span>
                            <button class="action-btn" :title="`Copy ${g.m3u.copyLabel}`" @click="copyPublishedUrl(g, 'm3u')">
                                <Icon name="copy" :size="12" />
                            </button>
                        </div>
                    </td>
                    <td class="c-url">
                        <div class="url-cell">
                            <span class="url-mono" :title="g.epg.url">{{ g.epg.url }}</span>
                            <button class="action-btn" :title="`Copy ${g.epg.copyLabel}`" @click="copyPublishedUrl(g, 'epg')">
                                <Icon name="copy" :size="12" />
                            </button>
                        </div>
                    </td>
                </tr>
            </tbody>
        </table>

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
.access-wrap {
    overflow: auto;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-s);
    background: var(--bg-2);
}
.access-tbl {
    border-collapse: separate;
    border-spacing: 0;
    width: 100%;
    font-size: var(--fs-sm);
}
.access-tbl thead th {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--bg-3);
    padding: 9px 12px;
    text-align: left;
    font-weight: 600;
    color: var(--text-2);
    border-bottom: 1px solid var(--hairline);
}
.access-tbl td {
    padding: 7px 12px;
    border-bottom: 1px solid var(--hairline);
    vertical-align: middle;
}
/* A subtle divider between users so blocks read as units. */
.user-block + .user-block td {
    border-top: 2px solid var(--hairline-strong);
}
.c-user { width: 200px; }
.c-pl { width: 220px; }
.c-url { min-width: 280px; }
.user-cell {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}
.user-meta {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
}
.avatar-sm {
    width: 26px;
    height: 26px;
    flex: none;
    border-radius: 50%;
    background: var(--accent-soft);
    color: var(--accent-hi);
    font-weight: 700;
    font-size: 10px;
    display: grid;
    place-items: center;
}
.uname {
    font-weight: 600;
    color: var(--text-0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.pl-cell {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}
.pl-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.url-cell {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}
.url-mono {
    flex: 1;
    min-width: 0;
    font-family: var(--mq-font-mono, ui-monospace, monospace);
    font-size: 11.5px;
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.action-btn {
    border: 0;
    background: var(--bg-3);
    border-radius: 4px;
    width: 22px;
    height: 22px;
    flex: none;
    display: grid;
    place-items: center;
    color: var(--text-1);
    cursor: pointer;
    transition: background .12s, color .12s;
}
.action-btn:hover {
    background: var(--accent-soft);
    color: var(--accent-hi);
}
.no-access td {
    color: var(--text-2);
}
</style>
