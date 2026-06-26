<script lang="ts">
// The scope + operation this modal visualizes. Exported from a plain <script> block (a <script setup> cannot
// contain ES module exports) so both Playlist screens can type the values they hand in.
//
// `OpMode` selects WHICH instrument view renders inside the shared masqueradarr HUD scaffold:
//   - 'compose' → users grouped ACCESS / NO-ACCESS, per-user compose progress (who receives a composed file).
//   - 'sync'    → the list of playlists being synced + each one's per-playlist sync progress/status.
//
// `OpScope` is the target the operation runs against (same shape for both modes):
//   - { kind: 'global' }            → the Global union (every endpoint:'global' source playlist).
//   - { kind: 'custom', id, name }  → a single playlist (a custom/clone for compose; one source row for sync).
//
// `OpRunResult` is the optional value the `run` thunk may resolve with so the modal can flag per-target
// FAILURES without the thunk throwing: `failed` is the list of target NAMES whose op errored. Compose thunks
// resolve void (no per-user failure surface) → every access user settles "done"; sync thunks resolve
// { failed } so failed playlists settle red (red-risk), the rest teal/green (teal-signal).
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

// ── Playlist op (compose / sync) preview + progress modal ───────────────────────────────────────────────
// One component, two modes, one masqueradarr HUD scaffold (corner brackets, deterministic barcode, MasqMark,
// teal-signal / red-risk status chip). Opened the moment the operator triggers the op.
//
//   COMPOSE — "what is being composed, and for whom": every app user is grouped ACCESS vs NO-ACCESS for the
//   scope (the SAME access semantics the Assign/Get-access modals use — admins unfiltered = full access),
//   with a per-user animated indicator under each access user.
//
//   SYNC — "which playlists are being pulled, and how each is doing": the scoped playlist list (the Global
//   cohort for Sync Global, the single row for a per-row Sync), each with its own progress/status row.
//
// Progress wiring (shared shape): the modal kicks the single real op (`props.run`, the screen's existing
// composeRow/composeNow/onComposeGlobal · syncRow/syncNow/onSyncGlobal handler — unchanged, toasts + reloads
// preserved) and shows an honest indeterminate bar per row WHILE it is in flight, then settles each row the
// instant the op resolves. A thrown op flips the WHOLE modal to a red FAULT state; the op still completes
// server-side even if the modal is dismissed early. Two extra real signals are used in sync mode: the shared
// `globalSyncProgress` (a genuine sequential per-playlist completion signal — Sync Global processes one
// playlist at a time) marks playlists done incrementally as the sync reaches them, and the run thunk's
// resolved `{ failed }` (from syncAllGlobal / a single syncRow) flips the named playlists to red.

const props = defineProps<{
    mode: OpMode;
    scope: OpScope;
    run: () => Promise<OpRunResult | void> | void;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { globalSyncProgress } = usePlaylistActions();

type Phase = 'running' | 'done' | 'error';
const phase = ref<Phase>('running');
const settled = ref<Set<string>>(new Set()); // compose: access user ids that finished
const loaded = ref(false); // user/playlist list resolved — gates the lists so nothing flashes empty

const isGlobal = computed(() => props.scope.kind === 'global');
const isSync = computed(() => props.mode === 'sync');
const scopeName = computed(() => (props.scope.kind === 'custom' ? props.scope.name : 'Global Playlist'));
const scopeCode = computed(() => (props.scope.kind === 'custom' ? props.scope.id : 'global').toUpperCase());

// Deterministic barcode strip seeded from the scope id — the masqueradarr HUD idiom (a given playlist always
// renders the same artwork). FNV-1a → LCG bar walk, mirroring DashboardScreen's brand foot.
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

// Expand an admin to full access (mirrors GetAccessModal.toPublishedUser); a normal user maps 1:1.
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

// Access = this user receives a composed file for the scope. Admins are unfiltered (always access), exactly
// like the access-matrix cell state.
function userHasAccess(u: User): boolean {
    if (u.role === 'admin') return true;
    const s = props.scope;
    if (s.kind === 'global') return hasGlobalAccess(u);
    return (u.allowedCustomPlaylists || []).includes(s.id);
}

// The per-user composed M3U filename for the scope, via the shared published-URL builder (single source of
// truth). Returns '' when the scope produces no file for the user (a no-access user, or PLAYLISTS not loaded).
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
// A row is "done" once the overall phase resolves, or once its staggered settle reached it.
function rowDone(u: User): boolean {
    return phase.value === 'done' || settled.value.has(u._id);
}

const statusLabel = computed(() => {
    if (phase.value === 'error') return 'FAULT';
    if (phase.value === 'done') return 'COMPLETE';
    return isSync.value ? 'SYNCING' : 'COMPOSING';
});

// ── SYNC mode ───────────────────────────────────────────────────────────────────────────────────────────
// The scoped playlist list: Sync Global → every Global cohort row via the shared isGlobalSyncTarget predicate
// (endpoint === 'global' — the EXACT set syncAllGlobal() fans out over, so this displayed list and the
// operation cannot diverge); a per-row Sync → just that one playlist (looked up in PLAYLISTS, with a
// synthetic fallback if absent).
const syncTargets = computed<Playlist[]>(() => {
    if (!isSync.value) return [];
    if (props.scope.kind === 'global') return PLAYLISTS.value.filter(isGlobalSyncTarget);
    const id = props.scope.id;
    const found = PLAYLISTS.value.find((p) => p.id === id);
    return found ? [found] : [{ id, name: props.scope.name, url: '', channels: 0, groups: 0, lastSync: '', status: 'good', auto: false, interval: '', source: null } as Playlist];
});
const syncChannelTotal = computed(() => syncTargets.value.reduce((s, p) => s + (p.channels || 0), 0));

const syncSettled = ref<Set<string>>(new Set()); // playlist ids that finished syncing (done, teal/green)
const syncFailed = ref<Set<string>>(new Set()); // playlist ids whose sync errored (fail, red-risk)

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

// Sync Global advances `globalSyncProgress` 0..1 as it finishes each playlist IN ORDER. Mark the first N
// targets settled as it crosses each step — a genuine per-playlist completion signal (not cosmetic). The set
// only grows (no revert/flicker even when the singleton resets the progress to 0 in its finally block).
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

// ── shared run driver ───────────────────────────────────────────────────────────────────────────────────
// Settle a collection of row-ids to "done" with a short, bounded stagger so completion reads sequentially
// (cosmetic only — the op already finished server-side), then flip the whole modal to COMPLETE.
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
        // Kick the real op immediately; load the lists in parallel so rows render while it runs. Compose needs
        // USERS (the access split); both modes want PLAYLISTS loaded (sync target list / no-flash gating).
        const runP = Promise.resolve(props.run());
        await Promise.all([
            isSync.value ? Promise.resolve() : ensureUsers().catch(() => {}),
            PLAYLISTS.value.length ? Promise.resolve() : reloadPlaylists().catch(() => {}),
        ]);
        loaded.value = true;
        const result = await runP;

        if (isSync.value) {
            // Flag per-playlist failures from the run thunk's resolved { failed } (target NAMES), then settle
            // the remaining playlists "done" with a stagger. Already-progressed rows (via globalSyncProgress)
            // stay settled — a failed row briefly settled mid-run is corrected here to red.
            const failedNames = result && typeof result === 'object' && Array.isArray(result.failed) ? result.failed : [];
            const failSet = new Set<string>();
            for (const p of syncTargets.value) if (failedNames.includes(p.name)) failSet.add(p.id);
            syncFailed.value = failSet;
            const pending = syncTargets.value.filter((p) => !failSet.has(p.id) && !syncSettled.value.has(p.id)).map((p) => p.id);
            settleRows(pending, () => syncSettled.value, (s) => { syncSettled.value = s; });
            return;
        }

        // COMPOSE: settle each access row to "done" with a stagger (no per-user backend signal; op finished).
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
            <!-- HUD corner brackets framing the instrument -->
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

            <!-- brand telemetry: deterministic barcode + mono spec strip -->
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

            <!-- SYNC mode — the scoped playlist list, each with its own per-playlist sync progress/status -->
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

            <!-- COMPOSE mode — users grouped Access / No-Access for the scope -->
            <div v-else class="modal-body cmp-body">
                <!-- ACCESS — users who receive a composed file for this scope -->
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

                <!-- NO ACCESS — users who get nothing for this scope (no nested playlist, no progress) -->
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
/* HUD corner brackets framing the modal (the LoginScreen / ActiveStreams idiom). */
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
/* Teal-signal / red-risk status chip (micrographics two-color rule). */
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
/* Pulse only while live; a settled / faulted chip holds steady. */
.cmp-sig:not(.done):not(.risk) .cmp-sig-dot { animation: cmp-pulse 1.1s ease-in-out infinite; }
@keyframes cmp-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.8); }
}
@media (prefers-reduced-motion: reduce) {
    .cmp-sig .cmp-sig-dot { animation: none; }
}

/* Brand telemetry strip — barcode + mono spec keys. */
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
/* Section header — mono overline, teal for Access / muted for No Access; a hairline rule trails it. */
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

/* Access row: user line on top, the composed playlist + progress nested beneath. */
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
/* Nested playlist + progress — indented under the user, matching the sample layout. */
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

/* SYNC playlist row — single flat line: identity (icon + name + channel count) left, progress/status right. */
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
