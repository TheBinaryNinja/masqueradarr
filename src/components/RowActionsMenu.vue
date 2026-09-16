<script lang="ts">
export interface RowActionItem {
    key: string;
    label: string;
    icon: string;
    disabled?: boolean;
    danger?: boolean;
    run: () => void;
}
</script>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from './Icon.vue';


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
            :class="{ danger: item.danger }"
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
.ram-item.danger,
.ram-item.danger :deep(svg) {
    color: var(--bad);
}
.ram-item.danger:hover:not(:disabled),
.ram-item.danger:focus-visible {
    color: var(--bad);
    background: oklch(0.7 0.18 25 / 0.1);
}
.ram-item.danger:hover:not(:disabled) :deep(svg),
.ram-item.danger:focus-visible :deep(svg) {
    color: var(--bad);
}
</style>
