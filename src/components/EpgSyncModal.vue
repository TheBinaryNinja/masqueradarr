<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import MasqMark from './MasqMark.vue';
import ProgressBar from './ProgressBar.vue';
import { EPG_SOURCES, type EpgSource } from '../data';
import { useEpgActions, isEpgSyncTarget } from '../composables/useEpgActions';

// ── EPG "Sync all" progress modal ───────────────────────────────────────────────────────────────────────
// The masqueradarr HUD scaffold (corner brackets, deterministic barcode, MasqMark, teal-signal / red-risk
// status chip) reused from PlaylistOpModal, narrowed to a single concern: "which EPG sources are being synced
// and how each is doing". Playlist-bound sources are excluded (isEpgSyncTarget) — the loop never touches them
// and they never appear here.
//
// Progress wiring: the modal kicks the real op (`props.run`, the screen's onSyncAll handler — toasts + store
// reload preserved) and shows an honest indeterminate bar per row WHILE it is in flight, then settles each row
// the instant the op resolves. The shared `syncAllProgress` (a genuine sequential per-source completion signal
// — the sync runs one source at a time) marks sources done incrementally as the loop reaches them, and the run
// thunk's resolved { failed } (source NAMES) flips the named sources to red. A thrown op flips the WHOLE modal
// to a red FAULT state; the op still completes even if the modal is dismissed early.

const props = defineProps<{
    run: () => Promise<{ failed?: string[] } | void> | void;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { syncAllProgress } = useEpgActions();

type Phase = 'running' | 'done' | 'error';
const phase = ref<Phase>('running');
const loaded = ref(false); // EPG list resolved — gates the list so nothing flashes empty

// The sync cohort, same predicate the loop fans out over (so this displayed list and the operation cannot
// diverge). Store-driven for display; the loop fetches live — they match in practice (same persisted order).
const syncTargets = computed<EpgSource[]>(() => EPG_SOURCES.value.filter(isEpgSyncTarget));
const channelTotal = computed(() => syncTargets.value.reduce((s, p) => s + (p.channels || 0), 0));
const programTotal = computed(() => syncTargets.value.reduce((s, p) => s + (p.programs || 0), 0));

const syncSettled = ref<Set<string>>(new Set()); // source ids that finished syncing (done, teal/green)
const syncFailed = ref<Set<string>>(new Set()); // source ids whose sync errored (fail, red-risk)

const statusLabel = computed(() => {
    if (phase.value === 'error') return 'FAULT';
    if (phase.value === 'done') return 'COMPLETE';
    return 'SYNCING';
});

// Deterministic barcode strip (the masqueradarr HUD idiom). Fixed seed — this modal always represents the same
// scope (all EPG sources), so the artwork is stable. FNV-1a → LCG bar walk, mirroring PlaylistOpModal.
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
    let s = seedFrom('epg-all');
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

function sourceIcon(p: EpgSource): string {
    return p.builtin ? 'tv' : 'epg';
}
function targetState(p: EpgSource): 'running' | 'done' | 'fail' {
    if (syncFailed.value.has(p.id)) return 'fail';
    if (phase.value === 'error') return 'fail';
    if (phase.value === 'done' || syncSettled.value.has(p.id)) return 'done';
    return 'running';
}

// The sync advances `syncAllProgress` 0..1 as it finishes each source IN ORDER. Mark the first N targets settled
// as it crosses each step — a genuine per-source completion signal (not cosmetic). The set only grows (no
// revert/flicker even when the singleton resets the progress to 0 in its finally block).
watch(syncAllProgress, (pr) => {
    const t = syncTargets.value;
    const doneCount = Math.min(t.length, Math.floor(pr * t.length + 1e-6));
    if (doneCount <= 0) return;
    const n = new Set(syncSettled.value);
    for (let i = 0; i < doneCount; i++) n.add(t[i].id);
    syncSettled.value = n;
});

// ── run driver ──────────────────────────────────────────────────────────────────────────────────────────
// Settle a collection of row-ids to "done" with a short, bounded stagger so completion reads sequentially
// (cosmetic only — the op already finished), then flip the whole modal to COMPLETE.
function settleRows(ids: string[]): void {
    if (!ids.length) {
        phase.value = 'done';
        return;
    }
    const step = Math.min(110, Math.max(30, Math.floor(700 / ids.length)));
    ids.forEach((id, i) => {
        window.setTimeout(() => {
            syncSettled.value = new Set(syncSettled.value).add(id);
        }, i * step);
    });
    window.setTimeout(() => {
        phase.value = 'done';
    }, ids.length * step + 60);
}

async function start(): Promise<void> {
    phase.value = 'running';
    try {
        // The EPG store is loaded at bootstrap; rows render immediately. Kick the real op, then settle on resolve.
        loaded.value = true;
        const result = await Promise.resolve(props.run());

        // Flag per-source failures from the run thunk's resolved { failed } (source NAMES), then settle the
        // remaining sources "done" with a stagger. Already-progressed rows (via syncAllProgress) stay settled.
        const failedNames = result && typeof result === 'object' && Array.isArray(result.failed) ? result.failed : [];
        const failSet = new Set<string>();
        for (const p of syncTargets.value) if (failedNames.includes(p.name)) failSet.add(p.id);
        syncFailed.value = failSet;
        const pending = syncTargets.value.filter((p) => !failSet.has(p.id) && !syncSettled.value.has(p.id)).map((p) => p.id);
        settleRows(pending);
    } catch {
        phase.value = 'error';
    }
}

onMounted(start);
</script>

<template>
    <div class="modal-bg" role="dialog" aria-modal="true" aria-labelledby="epg-op-title" @click="emit('close')">
        <div class="modal compose-modal" @click.stop>
            <!-- HUD corner brackets framing the instrument -->
            <span class="corner tl" aria-hidden="true" /><span class="corner tr" aria-hidden="true" />
            <span class="corner bl" aria-hidden="true" /><span class="corner br" aria-hidden="true" />

            <div class="modal-hd cmp-hd">
                <MasqMark :size="18" :color="phase === 'error' ? 'var(--mq-risk)' : 'var(--mq-teal)'" />
                <div class="cmp-titles">
                    <h2 id="epg-op-title">Sync</h2>
                    <span class="cmp-sub">EPG SOURCES</span>
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
                    <span><span class="cmp-sp-key">SOURCES</span> {{ syncTargets.length }}</span>
                    <span><span class="cmp-sp-key">CHANNELS</span> {{ channelTotal.toLocaleString() }}</span>
                    <span><span class="cmp-sp-key">PROGRAMS</span> {{ programTotal.toLocaleString() }}</span>
                </div>
            </div>

            <!-- the EPG source list, each with its own per-source sync progress/status -->
            <div class="modal-body cmp-body">
                <section class="cmp-sec">
                    <header class="cmp-sec-hd signal">
                        <Icon name="refresh" :size="12" />
                        <span>EPG Sources</span>
                        <span class="cmp-count">{{ syncTargets.length }}</span>
                    </header>
                    <div v-if="!loaded" class="cmp-empty">Loading EPG sources…</div>
                    <div v-else-if="syncTargets.length === 0" class="cmp-empty">No EPG sources to sync.</div>
                    <div v-for="p in syncTargets" v-else :key="p.id" class="cmp-prow">
                        <div class="cmp-pl">
                            <Icon :name="sourceIcon(p)" :size="12" />
                            <span class="cmp-pl-name" :title="p.name">{{ p.name }}</span>
                            <span class="cmp-file">{{ p.channels }} ch · {{ p.programs.toLocaleString() }} prog</span>
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
/* Section header — mono overline, teal signal; a hairline rule trails it. */
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

/* Source row — single flat line: identity (icon + name + counts) left, progress/status right. */
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
</style>
