<script lang="ts">
// One entry in the per-row actions popup. Exported from a plain <script> block (a <script setup> cannot
// contain ES module exports) so the consuming screen can type the items array it builds. `run` is the click
// handler (the screen's existing onSyncGlobal/composeRow/editRow/… — unchanged); `disabled` reflects the
// row's live inflight state.
export interface RowActionItem {
    key: string;
    label: string;
    icon: string;
    disabled?: boolean;
    run: () => void;
}
</script>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from './Icon.vue';

// ── Anchored per-row actions popover ────────────────────────────────────────────────────────────────────
// A small reusable vertical menu (role="menu") rendered inside a position:relative anchor (the row's
// .pl-row-actions cell). The parent decides WHICH row is open (a single openMenuId) and passes the ordered,
// row-scoped items; this component owns only the popup chrome: outside-click + Esc dismissal, arrow-key
// navigation, first-item autofocus, and an upward flip when the row sits near the viewport bottom. Selecting
// an item runs its handler then emits close. Logic/handlers live on the screen — this is presentation only.

const props = defineProps<{ items: RowActionItem[] }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const root = ref<HTMLElement | null>(null);
const itemEls = ref<HTMLButtonElement[]>([]);
const flipUp = ref(false);

function select(item: RowActionItem): void {
    if (item.disabled) return;
    item.run();
    emit('close');
}

// Outside-click closes. The trigger lives in the same .pl-row-actions container (which stops click
// propagation), so re-clicking the trigger toggles via the parent without this listener double-firing.
function onDocClick(e: MouseEvent): void {
    if (root.value && !root.value.contains(e.target as Node)) emit('close');
}

function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
        e.stopPropagation();
        emit('close');
        return;
    }
    const els = itemEls.value.filter(Boolean);
    if (!els.length) return;
    const idx = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        els[(idx + 1 + els.length) % els.length]?.focus();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        els[(idx - 1 + els.length) % els.length]?.focus();
    }
}

onMounted(async () => {
    document.addEventListener('click', onDocClick);
    window.addEventListener('keydown', onKeydown, true);
    await nextTick();
    // Flip above the trigger when the menu would overflow the viewport bottom.
    const r = root.value?.getBoundingClientRect();
    if (r && r.bottom > window.innerHeight - 8) flipUp.value = true;
    itemEls.value.find((el) => el && !el.disabled)?.focus();
});

onBeforeUnmount(() => {
    document.removeEventListener('click', onDocClick);
    window.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
    <div ref="root" class="ram" :class="{ up: flipUp }" role="menu" aria-label="Row actions">
        <button
            v-for="item in items"
            :key="item.key"
            ref="itemEls"
            type="button"
            role="menuitem"
            class="ram-item"
            :disabled="item.disabled"
            @click="select(item)"
        >
            <Icon :name="item.icon" :size="14" />
            <span>{{ item.label }}</span>
        </button>
    </div>
</template>

<style scoped>
.ram {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 60;
    min-width: 180px;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--bg-2);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius-m);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.42), inset 0 1px 0 var(--hairline);
    animation: ram-in .14s ease-out;
}
.ram.up {
    top: auto;
    bottom: calc(100% + 6px);
}
@keyframes ram-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: none; }
}
.ram-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: var(--radius-s);
    background: transparent;
    color: var(--text-1);
    font-size: var(--fs-sm);
    font-weight: 500;
    text-align: left;
    cursor: pointer;
    transition: background .12s, color .12s;
}
.ram-item:hover:not(:disabled),
.ram-item:focus-visible {
    background: var(--bg-3);
    color: var(--text-0);
    outline: none;
}
.ram-item:disabled {
    color: var(--text-3);
    cursor: default;
}
.ram-item :deep(svg) {
    flex: none;
    color: var(--text-2);
}
.ram-item:hover:not(:disabled) :deep(svg),
.ram-item:focus-visible :deep(svg) {
    color: var(--accent-hi);
}
</style>
