<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { marked } from 'marked';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import { currentUser } from '../composables/useAuth';
import { DOC_SECTIONS, DOC_GROUPS, defaultSectionFor, sectionVisibleTo, type DocSection } from '../docs';

// An optional section id to open to (deep-link via the tvapp:docs-open bus event); when absent the panel
// defaults to the section that documents the current screen.
const props = defineProps<{ section?: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const route = useRoute();
const isAdmin = computed(() => currentUser.value?.role === 'admin');

// Sections this role may see (panel order), grouped for the TOC — mirrors the SPA's own role gating.
const sections = computed<DocSection[]>(() => DOC_SECTIONS.filter((s) => sectionVisibleTo(s, isAdmin.value)));
const groups = computed(() =>
  DOC_GROUPS
    .map((g) => ({ group: g, items: sections.value.filter((s) => s.group === g) }))
    .filter((g) => g.items.length > 0),
);

marked.setOptions({ gfm: true, breaks: false });
function render(md: string): string {
  return marked.parse(md) as string;
}

const body = ref<HTMLDivElement | null>(null);
const activeId = ref<string>('');

function scrollToSection(id: string, smooth = true) {
  const el = body.value?.querySelector<HTMLElement>(`#doc-${id}`);
  if (!el || !body.value) return;
  body.value.scrollTo({ top: el.offsetTop - 8, behavior: smooth ? 'smooth' : 'auto' });
  activeId.value = id;
}

// Scroll-spy: the active TOC entry is the last section whose top has passed the scroll line.
function onScroll() {
  const el = body.value;
  if (!el) return;
  const line = el.scrollTop + 24;
  let current = sections.value[0]?.id ?? '';
  for (const s of sections.value) {
    const node = el.querySelector<HTMLElement>(`#doc-${s.id}`);
    if (node && node.offsetTop <= line) current = s.id;
  }
  activeId.value = current;
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  await nextTick();
  const target = props.section && sections.value.some((s) => s.id === props.section)
    ? props.section
    : defaultSectionFor(route.name as string | undefined, isAdmin.value);
  scrollToSection(target, false);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="drawer-wrap">
    <div class="glass-bg drawer-backdrop" @click="emit('close')" />
    <div class="glass drawer-panel docs-panel">
      <div class="drawer-hd">
        <Icon name="book" :size="16" />
        <span style="font-weight: 600; font-size: 14px;">Documentation</span>
        <span style="flex: 1;" />
        <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" title="Close (Esc)" />
      </div>
      <div class="docs-cols">
        <nav class="docs-toc">
          <template v-for="g in groups" :key="g.group">
            <div class="docs-toc-group">{{ g.group }}</div>
            <button v-for="s in g.items" :key="s.id"
                    :class="['docs-toc-item', { active: activeId === s.id }]"
                    @click="scrollToSection(s.id)">
              {{ s.title }}
            </button>
          </template>
        </nav>
        <div class="docs-body" ref="body" @scroll="onScroll">
          <section v-for="s in sections" :key="s.id" :id="`doc-${s.id}`" class="docs-section">
            <div class="doc-prose" v-html="render(s.body)" />
          </section>
        </div>
      </div>
    </div>
  </div>
</template>
