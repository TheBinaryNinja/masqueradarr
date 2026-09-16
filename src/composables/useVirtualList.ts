
import { ref, computed, type Ref, type ComputedRef } from 'vue';

export interface VirtualList {
  start: ComputedRef<number>;
  end: ComputedRef<number>;
  padTop: ComputedRef<number>;
  totalHeight: ComputedRef<number>;
  onScroll: () => void;
  measure: () => void;
  topIndex: () => number;
  scrollToIndex: (index: number) => void;
}

export function useVirtualList(
  container: Ref<HTMLElement | null>,
  count: (() => number) | Ref<number>,
  rowH: number,
  overscan = 8,
): VirtualList {
  const scrollTop = ref(0);
  const viewportH = ref(600);
  const total = typeof count === 'function' ? computed(count) : count;

  function measure(): void {
    const el = container.value;
    if (!el) return;
    scrollTop.value = el.scrollTop;
    viewportH.value = el.clientHeight;
  }

  const start = computed(() => Math.max(0, Math.floor(scrollTop.value / rowH) - overscan));
  const visibleRows = computed(() => Math.ceil(viewportH.value / rowH) + overscan * 2);
  const end = computed(() => Math.min(total.value, start.value + visibleRows.value));
  const padTop = computed(() => start.value * rowH);
  const totalHeight = computed(() => total.value * rowH);

  function topIndex(): number {
    return Math.min(Math.max(0, total.value - 1), Math.floor((scrollTop.value + 4) / rowH));
  }
  function scrollToIndex(index: number): void {
    const el = container.value;
    if (!el || index < 0) return;
    el.scrollTop = index * rowH;
    measure();
  }

  return { start, end, padTop, totalHeight, onScroll: measure, measure, topIndex, scrollToIndex };
}
