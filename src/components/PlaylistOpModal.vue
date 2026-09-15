<script lang="ts">
export type OpMode = 'compose' | 'sync';
export type OpScope =
    | { kind: 'global' }
    | { kind: 'custom'; id: string; name: string };
export interface OpRunResult {
    failed?: string[];
}
</script>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import MasqMark from './MasqMark.vue';
import ProgressBar from './ProgressBar.vue';
import { PLAYLISTS, reloadPlaylists, type Playlist } from '../data';
import { USERS, ensureUsers, type User } from '../composables/useUsers';
import { usePlaylistActions, isGlobalSyncTarget } from '../composables/usePlaylistActions';
import {
    globalMemberIds,
    nonGlobalPlaylists,
    hasGlobalAccess,
    buildPublishedGroups,
    type PublishedUrlUser,
} from '../composables/useUserAccess';


const props = defineProps<{
    mode: OpMode;
    scope: OpScope;
    run: () => Promise<OpRunResult | void> | void;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { globalSyncProgress } = usePlaylistActions();

type Phase = 'running' | 'done' | 'error';
const phase = ref<Phase>('running');
const settled = ref<Set<string>>(new Set());
const loaded = ref(false);

const isGlobal = computed(() => props.scope.kind === 'global');
const isSync = computed(() => props.mode === 'sync');
const scopeName = computed(() => (props.scope.kind === 'custom' ? props.scope.name : 'Global Playlist'));
const scopeCode = computed(() => (props.scope.kind === 'custom' ? props.scope.id : 'global').toUpperCase());

function seedFrom(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}
const barcode = computed(() => {
    const rects: { x: number; w: number }[] = [];
    let s = seedFrom(props.scope.kind === 'custom' ? props.scope.id : 'global');
    let x = 0;
    let ink = true;
    while (x < 360) {
        s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
        const w = 2 + (s % 5);
        if (ink) rects.push({ x, w });
        x += w;
        ink = !ink;
    }
    return { rects, width: x };
});

function toPublishedUser(u: User): PublishedUrlUser {
    if (u.role === 'admin') {
        return {
            username: u.username,
            slug: u.slug,
            allowedPlaylists: globalMemberIds.value,
            allowedCustomPlaylists: nonGlobalPlaylists.value.map((p) => p.id),
        };
    }
    return {
        username: u.username,
        slug: u.slug,
        allowedPlaylists: u.allowedPlaylists || [],
        allowedCustomPlaylists: u.allowedCustomPlaylists || [],
    };
}

function userHasAccess(u: User): boolean {
    if (u.role === 'admin') return true;
    const s = props.scope;
    if (s.kind === 'global') return hasGlobalAccess(u);
    return (u.allowedCustomPlaylists || []).includes(s.id);
}

function fileName(u: User): string {
    const groups = buildPublishedGroups(toPublishedUser(u));
    const s = props.scope;
    const g = s.kind === 'global' ? groups.find((x) => x.kind === 'Global') : groups.find((x) => x.key === `custom-${s.id}`);
    if (!g) return '';
    return g.m3u.url.split('/').filter(Boolean).pop() || g.m3u.url;
}

const accessUsers = computed(() => USERS.value.filter(userHasAccess));
const noAccessUsers = computed(() => USERS.value.filter((u) => !userHasAccess(u)));

const accessTitle = computed(() => `Access (${scopeName.value})`);
const noAccessTitle = computed(() => `No Access (${scopeName.value})`);

function avatar(name: string): string {
    return name.slice(0, 2).toUpperCase();
}
function rowDone(u: User): boolean {
    return phase.value === 'done' || settled.value.has(u._id);
}

const statusLabel = computed(() => {
    if (phase.value === 'error') return 'FAULT';
    if (phase.value === 'done') return 'COMPLETE';
    return isSync.value ? 'SYNCING' : 'COMPOSING';
});

const syncTargets = computed<Playlist[]>(() => {
    if (!isSync.value) return [];
    if (props.scope.kind === 'global') return PLAYLISTS.value.filter(isGlobalSyncTarget);
    const id = props.scope.id;
    const found = PLAYLISTS.value.find((p) => p.id === id);
    return found ? [found] : [{ id, name: props.scope.name, url: '', channels: 0, groups: 0, lastSync: '', status: 'good', auto: false, interval: '', source: null } as Playlist];
});
const syncChannelTotal = computed(() => syncTargets.value.reduce((s, p) => s + (p.channels || 0), 0));

const syncSettled = ref<Set<string>>(new Set());
const syncFailed = ref<Set<string>>(new Set());

const SYNC_ICON: Record<string, string> = { clone: 'copy', file: 'file', url: 'link', hdhomerun: 'tv', import: 'import' };
function syncIcon(p: Playlist): string {
    if (p.builtin) return 'tv';
    return (p.source && SYNC_ICON[p.source]) || 'playlist';
}
function targetState(p: Playlist): 'running' | 'done' | 'fail' {
    if (syncFailed.value.has(p.id)) return 'fail';
    if (phase.value === 'error') return 'fail';
    if (phase.value === 'done' || syncSettled.value.has(p.id)) return 'done';
    return 'running';
}

watch(globalSyncProgress, (pr) => {
    if (!isSync.value || props.scope.kind !== 'global') return;
    const t = syncTargets.value;
    const doneCount = Math.min(t.length, Math.floor(pr * t.length + 1e-6));
    if (doneCount <= 0) return;
    const n = new Set(syncSettled.value);
    for (let i = 0; i < doneCount; i++) n.add(t[i].id);
    syncSettled.value = n;
});

const statusTitle = computed(() => (isSync.value ? 'Sync' : 'Compose'));
const syncSectionTitle = computed(() => `Playlists (${scopeName.value})`);

function settleRows(ids: string[], get: () => Set<string>, set: (s: Set<string>) => void): void {
    if (!ids.length) {
        phase.value = 'done';
        return;
    }
    const step = Math.min(110, Math.max(30, Math.floor(700 / ids.length)));
    ids.forEach((id, i) => {
        window.setTimeout(() => {
            set(new Set(get()).add(id));
        }, i * step);
    });
    window.setTimeout(() => {
        phase.value = 'done';
    }, ids.length * step + 60);
}

async function start(): Promise<void> {
    phase.value = 'running';
    try {
        const runP = Promise.resolve(props.run());
        await Promise.all([
            isSync.value ? Promise.resolve() : ensureUsers().catch(() => {}),
            PLAYLISTS.value.length ? Promise.resolve() : reloadPlaylists().catch(() => {}),
        ]);
        loaded.value = true;
        const result = await runP;

        if (isSync.value) {
            const failedNames = result && typeof result === 'object' && Array.isArray(result.failed) ? result.failed : [];
            const failSet = new Set<string>();
            for (const p of syncTargets.value) if (failedNames.includes(p.name)) failSet.add(p.id);
            syncFailed.value = failSet;
            const pending = syncTargets.value.filter((p) => !failSet.has(p.id) && !syncSettled.value.has(p.id)).map((p) => p.id);
            settleRows(pending, () => syncSettled.value, (s) => { syncSettled.value = s; });
            return;
        }

        const ids = accessUsers.value.map((u) => u._id);
        settleRows(ids, () => settled.value, (s) => { settled.value = s; });
    } catch {
        phase.value = 'error';
    }
}

onMounted(start);
</script>

<template>
    <div class="modal-bg" role="dialog" aria-modal="true" aria-labelledby="op-title" @click="emit('close')">
        <div class="modal compose-modal" @click.stop>
            <span class="corner tl" aria-hidden="true" /><span class="corner tr" aria-hidden="true" />
            <span class="corner bl" aria-hidden="true" /><span class="corner br" aria-hidden="true" />

            <div class="modal-hd cmp-hd">
                <MasqMark :size="18" :color="phase === 'error' ? 'var(--mq-risk)' : 'var(--mq-teal)'" />
                <div class="cmp-titles">
                    <h2 id="op-title">{{ statusTitle }}</h2>
                    <span class="cmp-sub">{{ isGlobal ? 'GLOBAL PLAYLIST' : scopeCode }}</span>
                </div>
                <span class="spacer" />
                <span class="cmp-sig" :class="{ risk: phase === 'error', done: phase === 'done' }">
                    <span class="cmp-sig-dot" />{{ statusLabel }}
                </span>
                <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
            </div>

            <div class="cmp-telemetry" aria-hidden="true">
                <svg class="cmp-barcode" :viewBox="`0 0 ${barcode.width} 26`" preserveAspectRatio="none">
                    <rect v-for="(r, i) in barcode.rects" :key="i" :x="r.x" y="0" :width="r.w" height="26" />
                </svg>
                <div class="cmp-spec">
                    <span><span class="cmp-sp-key">SCOPE</span> {{ isGlobal ? 'GLOBAL' : 'CUSTOM' }}</span>
                    <template v-if="isSync">
                        <span><span class="cmp-sp-key">PLAYLISTS</span> {{ syncTargets.length }}</span>
                        <span><span class="cmp-sp-key">CHANNELS</span> {{ syncChannelTotal }}</span>
                    </template>
                    <template v-else>
                        <span><span class="cmp-sp-key">FILES</span> {{ accessUsers.length }}</span>
                        <span><span class="cmp-sp-key">USERS</span> {{ accessUsers.length }}/{{ USERS.length }}</span>
                    </template>
                </div>
            </div>

            <div v-if="isSync" class="modal-body cmp-body">
                <section class="cmp-sec">
                    <header class="cmp-sec-hd signal">
                        <Icon name="refresh" :size="12" />
                        <span>{{ syncSectionTitle }}</span>
                        <span class="cmp-count">{{ syncTargets.length }}</span>
                    </header>
                    <div v-if="!loaded" class="cmp-empty">Loading playlists…</div>
                    <div v-else-if="syncTargets.length === 0" class="cmp-empty">No playlists to sync for this scope.</div>
                    <div v-for="p in syncTargets" v-else :key="p.id" class="cmp-prow">
                        <div class="cmp-pl">
                            <Icon :name="syncIcon(p)" :size="12" />
                            <span class="cmp-pl-name" :title="p.name">{{ p.name }}</span>
                            <span class="cmp-file">{{ p.channels }} ch</span>
                        </div>
                        <div class="cmp-prog">
                            <template v-if="targetState(p) === 'fail'">
                                <Icon name="warn" :size="13" class="cmp-fault" />
                                <span class="cmp-fail-tag">failed</span>
                            </template>
                            <template v-else-if="targetState(p) === 'done'">
                                <ProgressBar :value="1" tone="good" class="cmp-bar" />
                                <Icon name="check" :size="13" class="cmp-ok" />
                            </template>
                            <ProgressBar v-else :value="null" class="cmp-bar" />
                        </div>
                    </div>
                </section>
            </div>

            <div v-else class="modal-body cmp-body">
                <section class="cmp-sec">
                    <header class="cmp-sec-hd signal">
                        <Icon name="check" :size="12" />
                        <span>{{ accessTitle }}</span>
                        <span class="cmp-count">{{ accessUsers.length }}</span>
                    </header>
                    <div v-if="!loaded" class="cmp-empty">Loading users…</div>
                    <div v-else-if="accessUsers.length === 0" class="cmp-empty">No users have access to this playlist yet.</div>
                    <div v-for="u in accessUsers" v-else :key="u._id" class="cmp-urow">
                        <div class="cmp-user">
                            <div class="cmp-av">{{ avatar(u.username) }}</div>
                            <span class="cmp-uname" :title="u.username">{{ u.username }}</span>
                            <Pill v-if="u.role === 'admin'" tone="cyan">admin</Pill>
                        </div>
                        <div class="cmp-nested">
                            <div class="cmp-pl">
                                <Icon :name="isGlobal ? 'globe' : 'file'" :size="11" />
                                <span class="cmp-pl-name" :title="scopeName">{{ scopeName }}</span>
                                <span v-if="fileName(u)" class="cmp-file" :title="fileName(u)">{{ fileName(u) }}</span>
                            </div>
                            <div class="cmp-prog">
                                <Icon v-if="phase === 'error'" name="warn" :size="13" class="cmp-fault" />
                                <template v-else-if="rowDone(u)">
                                    <ProgressBar :value="1" tone="good" class="cmp-bar" />
                                    <Icon name="check" :size="13" class="cmp-ok" />
                                </template>
                                <ProgressBar v-else :value="null" class="cmp-bar" />
                            </div>
                        </div>
                    </div>
                </section>

                <section class="cmp-sec">
                    <header class="cmp-sec-hd">
                        <Icon name="lock" :size="12" />
                        <span>{{ noAccessTitle }}</span>
                        <span class="cmp-count">{{ noAccessUsers.length }}</span>
                    </header>
                    <div v-if="!loaded" class="cmp-empty">Loading users…</div>
                    <div v-else-if="noAccessUsers.length === 0" class="cmp-empty">Every user has access.</div>
                    <div v-for="u in noAccessUsers" v-else :key="u._id" class="cmp-urow muted-row">
                        <div class="cmp-user">
                            <div class="cmp-av dim">{{ avatar(u.username) }}</div>
                            <span class="cmp-uname" :title="u.username">{{ u.username }}</span>
                        </div>
                        <span class="cmp-noaccess">no file</span>
                    </div>
                </section>
            </div>
        </div>
    </div>
</template>

<style scoped>
.compose-modal {
    position: relative;
    width: min(640px, 94vw);
}
.corner {
    position: absolute;
    width: 14px;
    height: 14px;
    pointer-events: none;
    z-index: 1;
}
.corner.tl { top: 9px; left: 9px; border-top: 1.5px solid var(--bracket); border-left: 1.5px solid var(--bracket); }
.corner.tr { top: 9px; right: 9px; border-top: 1.5px solid var(--bracket); border-right: 1.5px solid var(--bracket); }
.corner.bl { bottom: 9px; left: 9px; border-bottom: 1.5px solid var(--bracket); border-left: 1.5px solid var(--bracket); }
.corner.br { bottom: 9px; right: 9px; border-bottom: 1.5px solid var(--bracket); border-right: 1.5px solid var(--bracket); }

.cmp-hd { align-items: center; }
.cmp-titles { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.cmp-sub {
    font-family: var(--mq-font-mono);
    font-size: 9.5px;
    letter-spacing: 0.18em;
    color: var(--mq-teal);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 320px;
}
.cmp-sig {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--mq-font-mono);
    font-size: 9.5px;
    font-weight: 500;
    letter-spacing: 0.16em;
    color: var(--mq-teal);
    padding: 3px 9px;
    border: 1px solid color-mix(in oklab, var(--mq-teal) 40%, transparent);
    border-radius: 999px;
    background: var(--mq-teal-veil);
}
.cmp-sig.risk {
    color: var(--mq-risk);
    border-color: color-mix(in oklab, var(--mq-risk) 45%, transparent);
    background: color-mix(in oklab, var(--mq-risk) 14%, transparent);
}
.cmp-sig-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 8px currentColor;
}
.cmp-sig:not(.done):not(.risk) .cmp-sig-dot { animation: cmp-pulse 1.1s ease-in-out infinite; }
@keyframes cmp-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.8); }
}
@media (prefers-reduced-motion: reduce) {
    .cmp-sig .cmp-sig-dot { animation: none; }
}

.cmp-telemetry {
    padding: 10px 22px 4px;
    display: flex;
    flex-direction: column;
    gap: 7px;
}
.cmp-barcode { display: block; width: 100%; height: 18px; opacity: 0.45; }
.cmp-barcode rect { fill: var(--text-2); }
.cmp-spec {
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
    font-family: var(--mq-font-mono);
    font-size: 9.5px;
    letter-spacing: 0.1em;
    color: var(--text-1);
}
.cmp-sp-key { color: var(--text-3); margin-right: 5px; }

.cmp-body {
    gap: 18px;
    max-height: 64vh;
    overflow-y: auto;
    padding-top: 8px;
}
.cmp-sec { display: flex; flex-direction: column; }
.cmp-sec-hd {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0 8px;
    font-family: var(--mq-font-mono);
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-2);
    border-bottom: 1px solid var(--hairline);
    margin-bottom: 6px;
}
.cmp-sec-hd.signal { color: var(--mq-teal); }
.cmp-sec-hd.signal :deep(svg) { color: var(--mq-teal); }
.cmp-count {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    color: var(--text-3);
}
.cmp-empty {
    padding: 12px 4px;
    color: var(--text-3);
    font-size: var(--fs-sm);
}

.cmp-urow {
    padding: 9px 0;
    border-bottom: 1px solid color-mix(in oklab, var(--hairline) 60%, transparent);
}
.cmp-urow:last-child { border-bottom: 0; }
.cmp-user { display: flex; align-items: center; gap: 9px; min-width: 0; }
.cmp-av {
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
    font-family: var(--mq-font-mono);
}
.cmp-av.dim { background: var(--bg-3); color: var(--text-3); }
.cmp-uname {
    font-weight: 600;
    color: var(--text-0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.cmp-nested {
    display: flex;
    align-items: center;
    gap: 14px;
    margin: 7px 0 0 35px;
}
.cmp-pl { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 0 1 auto; }
.cmp-pl :deep(svg) { color: var(--mq-teal); flex: none; }
.cmp-pl-name {
    font-size: var(--fs-sm);
    color: var(--text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.cmp-file {
    font-family: var(--mq-font-mono);
    font-size: 10px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
}
.cmp-prog {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 150px;
    max-width: 240px;
    min-width: 110px;
}
.cmp-bar { flex: 1; }
.cmp-ok { color: var(--good); flex: none; }
.cmp-fault { color: var(--bad); flex: none; }

.cmp-prow {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 0;
    border-bottom: 1px solid color-mix(in oklab, var(--hairline) 60%, transparent);
}
.cmp-prow:last-child { border-bottom: 0; }
.cmp-prow .cmp-pl { flex: 1 1 auto; }
.cmp-fail-tag {
    font-family: var(--mq-font-mono);
    font-size: 9.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--bad);
    flex: none;
}

.muted-row { padding: 6px 0; display: flex; align-items: center; gap: 9px; }
.muted-row .cmp-user { flex: 1 1 auto; }
.muted-row .cmp-uname { color: var(--text-2); font-weight: 500; }
.cmp-noaccess {
    margin-left: auto;
    font-family: var(--mq-font-mono);
    font-size: 9.5px;
    letter-spacing: 0.1em;
    color: var(--text-3);
}
</style>
