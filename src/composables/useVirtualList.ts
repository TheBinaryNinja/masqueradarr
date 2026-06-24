// Fixed-height list virtualization (no dependency — the repo has no virtual-scroll lib).
//
// The scroll container holds a spacer sized to the FULL list height (count * rowH) and renders only
// the rows intersecting the viewport plus an overscan buffer, shifted into place with translateY.
// Row height MUST be fixed (locked in CSS) so the index <-> scrollTop relationship is pure
// arithmetic — which is also what lets a caller jump to a row by setting scrollTop = index * rowH and
// read the row at the top as floor(scrollTop / rowH). That arithmetic replaces the old
// container.children[index] / offsetTop measurement the Mapping jump bar used (which can't work once
// the DOM no longer holds every row).
//
// Template shape:
//   <div class="list" ref="elRef" @scroll="vl.onScroll">
//     <div :style="{ height: vl.totalHeight + 'px', position: 'relative' }">
//       <div :style="{ transform: `translateY(${vl.padTop}px)` }">
//         <div v-for="item in items.slice(vl.start, vl.end)" :key="...">…</div>
//       </div>
//     </div>
//   </div>

import { ref, computed, type Ref, type ComputedRef } from 'vue';

export interface VirtualList {
  start: ComputedRef<number>;        // first rendered index (inclusive)
  end: ComputedRef<number>;          // last rendered index (exclusive) — use items.slice(start, end)
  padTop: ComputedRef<number>;       // px to translateY the rendered slice into position
  totalHeight: ComputedRef<number>;  // px height of the spacer (full list)
  onScroll: () => void;              // bind to the container's @scroll
  measure: () => void;               // re-read scrollTop + viewport height (call on mount / data change / resize)
  topIndex: () => number;            // index of the row currently at the top of the viewport
  scrollToIndex: (index: number) => void; // jump so `index` sits at the top
}

export function useVirtualList(
  container: Ref<HTMLElement | null>,
  count: (() => number) | Ref<number>,
  rowH: number,
  overscan = 8,
): VirtualList {
  const scrollTop = ref(0);
  const viewportH = ref(600); // corrected on the first measure()
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
    measure(); // reflect the jump immediately (the @scroll event also fires, but don't rely on its timing)
  }

  return { start, end, padTop, totalHeight, onScroll: measure, measure, topIndex, scrollToIndex };
}
