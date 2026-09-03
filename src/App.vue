<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, provide, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import Icon from './components/Icon.vue';
import Btn from './components/Btn.vue';
import MasqMark from './components/MasqMark.vue';
import TweaksPanel from './components/TweaksPanel.vue';
import TweakSection from './components/TweakSection.vue';
import TweakRadio from './components/TweakRadio.vue';
import ChannelDrawer from './components/ChannelDrawer.vue';
import AddSourceModal from './components/AddSourceModal.vue';
import AddEpgSourceModal from './components/AddEpgSourceModal.vue';
import LogsDrawer from './components/LogsDrawer.vue';
import DocsDrawer from './components/DocsDrawer.vue';
import SearchInput from './components/SearchInput.vue';
import SearchResults from './components/SearchResults.vue';
import { runSearch, type SearchResponse, type SearchRow } from './composables/useSearch';
import ToastBanner from './components/ToastBanner.vue';
import ToastUpperRight from './components/ToastUpperRight.vue';
import ToastLowerRight from './components/ToastLowerRight.vue';
import { PLAYLISTS, EPG_SOURCES, ACTIVE_STREAMS, bootstrapData, reloadPlaylists, reloadUserChannels, type Channel } from './data';
import { useTweaks } from './composables/useTweaks';
import { useStreamStats } from './composables/useStreamStats';
import { loadSettings } from './composables/useSettings';
import { startCronWatch, stopCronWatch } from './composables/useCronWatch';
import { bus, type RestoreItem } from './composables/bus';
import { currentUser, logout } from './composables/useAuth';

const { tweaks, setTweak } = useTweaks();
const { subscribe, release } = useStreamStats();
const router = useRouter();
const route = useRoute();

// App version — the Docker image tag baked in at SPA build time (VITE_APP_VERSION); 'dev' locally.
const appVersion = import.meta.env.VITE_APP_VERSION || 'dev';

// Non-failed active streams — the population that drives the nav pulse dot + breadcrumb.
const activeCount = computed(() => ACTIVE_STREAMS.value.filter((s) => s.status !== 'bad').length);

// Scroll-engaged glass: the topbar is a transparent overlay over the .screen scroll container; once
// the user scrolls past a small threshold it gains the frosted `.is-stuck` glass that backdrop-filters
// the content scrolling under it. .screen persists across routes, so navigation resets both.
const screenEl = ref<HTMLElement | null>(null);
const stuck = ref(false);
function onScreenScroll() {
  stuck.value = (screenEl.value?.scrollTop ?? 0) > 4;
}
watch(() => route.fullPath, () => {
  if (screenEl.value) screenEl.value.scrollTop = 0;
  stuck.value = false;
  closeSearch();
});

// ── Global search (topbar, admin-only) ──────────────────────────────────
// Debounced 1.5s by SearchInput; the results dropdown deep-links to the matched resource on click. A channel
// / EPG-channel result carries a `?focus=<id>` so the detail screen scrolls to + flashes the row.
const searchQ = ref('');
const searchResults = ref<SearchResponse | null>(null);
const searchOpen = ref(false);
const searching = ref(false);
let searchSeq = 0;

async function onSearch(v: string) {
  searchQ.value = v;
  const q = v.trim();
  if (q.length < 2) {
    searchResults.value = null;
    searchOpen.value = false;
    searching.value = false;
    return;
  }
  const seq = ++searchSeq;
  searching.value = true;
  searchOpen.value = true;
  try {
    const r = await runSearch(q);
    if (seq === searchSeq) searchResults.value = r; // ignore a stale response beaten by a newer query
  } catch {
    if (seq === searchSeq) searchResults.value = { groups: [], topLevel: { playlists: [], epgSources: [] } };
  } finally {
    if (seq === searchSeq) searching.value = false;
  }
}

function closeSearch() {
  searchOpen.value = false;
}

function onSearchSelect(row: SearchRow) {
  if (row.type === 'playlist') router.push(`/playlists/${encodeURIComponent(row.id)}`);
  else if (row.type === 'epg-source') router.push(`/epg-sources/${encodeURIComponent(row.id)}`);
  else if (row.type === 'channel' && row.playlistId)
    router.push({ path: `/playlists/${encodeURIComponent(row.playlistId)}`, query: { focus: row.id } });
  else if (row.type === 'epg-channel' && row.epgSourceId)
    router.push(`/epg-sources/${encodeURIComponent(row.epgSourceId)}`);
  // Clear the box + close the panel (the SearchInput adopts the reset `value` via its watch).
  searchQ.value = '';
  searchResults.value = null;
  searchOpen.value = false;
  channel.value = null;
}

// Cross-screen UI state
const channel = ref<Channel | null>(null);
const addOpen = ref<'playlist' | 'epg' | null>(null);
const logsOpen = ref(false);
const docsOpen = ref(false);
const docsSection = ref<string | undefined>(undefined);
const restoreJob = ref<{ items: RestoreItem[]; idx: number; percent: number; label: string; kind: string } | null>(null);

provide('openChannel', (c: Channel) => { channel.value = c; });

const NAV = computed(() => {
  if (currentUser.value?.role === 'user') {
    return [
      { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', path: '/dashboard' },
    ];
  }
  return [
    { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', path: '/dashboard' },
    { id: 'active', label: 'Active Streams', icon: 'tv', path: '/active', live: activeCount.value > 0 },
    { id: 'history', label: 'History / Metrics', icon: 'file', path: '/history' },
    { id: 'playlists', label: 'Playlists', icon: 'playlist', path: '/playlists', count: PLAYLISTS.value.length },
    { id: 'epg-sources', label: 'EPG Sources', icon: 'epg', iconClass: 'epg-glow', path: '/epg-sources', count: EPG_SOURCES.value.length },
    { id: 'mapping', label: 'Channel Mapping', icon: 'map', path: '/mapping' },
    { id: 'users', label: 'Users', icon: 'settings', path: '/users' },
    { id: 'settings', label: 'Settings', icon: 'settings', path: '/settings' },
  ];
});

function isActive(id: string) {
  const name = route.name as string | undefined;
  if (!name) return false;
  if (id === 'playlists' && name === 'playlist') return true;
  if (id === 'epg-sources' && name === 'epg-detail') return true;
  return id === name;
}

const crumbs = computed(() => {
  const name = route.name as string | undefined;
  switch (name) {
    case 'dashboard': return { title: 'Dashboard', crumb: 'Overview' };
    case 'active': return { title: 'Active Streams', crumb: `${activeCount.value} live now` };
    case 'playlists': return { title: 'Playlists', crumb: `${PLAYLISTS.value.length} sources` };
    case 'epg-sources': return { title: 'EPG Sources', crumb: `${EPG_SOURCES.value.length} sources` };
    case 'mapping': return { title: 'Channel Mapping', crumb: 'M3U ↔ EPG' };
    case 'history': return { title: 'History / Metrics', crumb: 'Streaming history' };
    case 'users': return { title: 'Users', crumb: 'User Management' };
    case 'settings': return { title: 'Settings', crumb: 'Workspace' };
    case 'playlist': {
      const p = PLAYLISTS.value.find((x) => x.id === route.params.id) || PLAYLISTS.value[0];
      return { title: p?.name ?? '', parent: 'Playlists', parentPath: '/playlists', crumb: p?.name ?? '' };
    }
    case 'epg-detail': {
      const e = EPG_SOURCES.value.find((x) => x.id === route.params.id) || EPG_SOURCES.value[0];
      return { title: e?.name ?? '', parent: 'EPG Sources', parentPath: '/epg-sources', crumb: e?.name ?? '' };
    }
    default: return { title: '', crumb: '' };
  }
});

const screenFlex = computed(() =>
  (route.name === 'active')
    ? { display: 'flex', flexDirection: 'column' as const } : null);

// Routes that adopt the masqueradarr brand stage background (the full-bleed
// teal-aurora + vignette field shared with LoginScreen). On a stage route the
// gradient runs edge-to-edge: .screen drops its own inset padding and the routed
// component is wrapped in .mq-stage-content, which carries the inset above the field.
const stageRoute = computed(() => route.name === 'dashboard' || route.name === 'active');

function go(path: string) { router.push(path); channel.value = null; }

// Any screen can deep-link into the Docs panel via the bus (e.g. a contextual "?"); the header button
// opens it without a section, defaulting to the current screen.
function onDocsOpen(payload: { section?: string }) {
  docsSection.value = payload?.section;
  docsOpen.value = true;
}

function onRestoreStart(payload: { items: RestoreItem[] }) {
  const items = payload.items || [];
  if (!items.length) return;
  const ticksPerItem = 5;
  const totalTicks = items.length * ticksPerItem;
  let tick = 0;
  restoreJob.value = { items, idx: 0, percent: 0, label: items[0].text, kind: items[0].kind };
  const id = window.setInterval(() => {
    tick++;
    const pct = Math.min(100, Math.round((tick / totalTicks) * 100));
    const idx = Math.min(items.length - 1, Math.floor(tick / ticksPerItem));
    const item = items[idx];
    restoreJob.value = { items, idx, percent: pct, label: item.text, kind: item.kind };
    if (tick >= totalTicks) {
      clearInterval(id);
      setTimeout(() => { restoreJob.value = null; bus.emit('tvapp:restore-done'); }, 520);
    }
  }, 220);
}

const userInitials = computed(() => {
  const name = currentUser.value?.username || '';
  if (!name) return '';
  return name.slice(0, 2).toUpperCase();
});

async function onLogout() {
  await logout();
  go('/login');
}

let initialized = false;
async function loadAppData() {
  if (!currentUser.value || initialized) return;
  initialized = true;

  if (currentUser.value.role === 'admin') {
    bootstrapData().catch((err) => console.error('[bootstrap] failed:', err));
    loadSettings().catch((err) => console.error('[settings] load failed:', err));
    startCronWatch();
    subscribe(); // keep /api/stream-stats live app-wide so the nav dot reflects real-time sessions
  } else {
    // Scoped boot for standard users
    loadSettings().catch((err) => console.error('[settings] load failed:', err));
    try {
      await reloadPlaylists();
      await reloadUserChannels();
    } catch (err) {
      console.error('[user bootstrap] failed:', err);
    }
  }
}

watch(currentUser, (user) => {
  if (user) {
    loadAppData();
  } else {
    initialized = false;
    stopCronWatch();
    release();
  }
}, { immediate: true });

onMounted(() => {
  bus.on('tvapp:restore-start', onRestoreStart);
  bus.on('tvapp:docs-open', onDocsOpen);
  loadAppData();
});

onBeforeUnmount(() => {
  bus.off('tvapp:restore-start', onRestoreStart);
  bus.off('tvapp:docs-open', onDocsOpen);
  stopCronWatch();
  release(); // symmetric teardown
});
</script>

<template>
  <div class="app" :style="!currentUser ? { gridTemplateColumns: '1fr', minWidth: '100%' } : undefined">
    <aside v-if="currentUser" class="sidebar">
      <div class="brand">
        <span class="brand-badge" aria-hidden="true">
          <MasqMark class="brand-mark" :size="21" />
        </span>
        <div class="brand-text">
          <span class="brand-word">masqueradarr</span>
          <span class="brand-version">{{ appVersion }}</span>
        </div>
      </div>
      <div class="nav-group-label">Workspace</div>
      <div v-for="n in (currentUser?.role === 'user' ? NAV : NAV.slice(0, 6))" :key="n.id"
           :class="['nav-item', { active: isActive(n.id) }]" @click="go(n.path)">
        <Icon :name="n.icon" :class="n.iconClass" />
        <span>{{ n.label }}</span>
        <span v-if="n.live" class="dot good pulse" style="width: 6px; height: 6px;" />
        <span v-if="n.count !== undefined" class="count">{{ n.count }}</span>
      </div>
      <div v-if="currentUser?.role === 'admin'" class="nav-group-label">Actions</div>
      <div v-for="n in (currentUser?.role === 'user' ? [] : NAV.slice(6))" :key="n.id"
           :class="['nav-item', { active: isActive(n.id) }]" @click="go(n.path)">
        <Icon :name="n.icon" :class="n.iconClass" />
        <span>{{ n.label }}</span>
      </div>

      <div class="sidebar-foot-stack">
        <button v-if="currentUser?.role === 'admin'" class="logs-btn" @click="logsOpen = true">
          <span class="logs-btn-ico">
            <Icon name="file" :size="14" />
            <span class="dot good pulse" style="width: 6px; height: 6px;" />
          </span>
          <span style="flex: 1; text-align: left;">View logs</span>
          <span class="mono" style="font-size: 10px; color: var(--text-3);">live</span>
        </button>
        <button class="logs-btn" style="margin-top: 6px;" @click="onLogout">
          <span class="logs-btn-ico">
            <Icon name="import" :size="14" />
          </span>
          <span style="flex: 1; text-align: left;">Logout</span>
        </button>
        <div class="sidebar-foot">
          <div class="avatar">{{ userInitials }}</div>
          <div style="min-width: 0;">
            <div class="name" style="text-transform: capitalize;">{{ currentUser?.username }}</div>
            <div class="plan">{{ currentUser?.role === 'admin' ? 'Administrator' : 'Standard User' }}</div>
          </div>
        </div>
      </div>
    </aside>

    <main class="main">
      <header v-if="currentUser" class="topbar" :class="{ 'is-stuck': stuck }">
        <h1>{{ crumbs.title }}</h1>
        <template v-if="restoreJob">
          <div class="restore-strip" role="status" aria-live="polite">
            <div class="restore-strip-line">
              <Icon :name="restoreJob.kind || 'refresh'" :size="12" />
              <span class="restore-strip-action">Restoring</span>
              <span class="restore-strip-label">{{ restoreJob.label }}</span>
            </div>
            <div class="restore-strip-bar">
              <div class="restore-strip-fill" :style="{ width: restoreJob.percent + '%' }" />
            </div>
            <span class="restore-strip-pct mono">{{ restoreJob.percent }}%</span>
          </div>
        </template>
        <template v-else>
          <span class="crumb" style="margin-left: 6px;">
            <template v-if="crumbs.parent">
              <span style="cursor: default;" @click="go(crumbs.parentPath!)">{{ crumbs.parent }}</span>
              <span style="color: var(--text-3); margin: 0 6px;">›</span>
            </template>
            {{ crumbs.crumb }}
          </span>
          <span class="topbar-spacer" />
        </template>
        <div v-if="currentUser?.role === 'admin'" class="topbar-search">
          <SearchInput :value="searchQ" :debounce="1500" width="100%"
                       placeholder="Search everything…" @change="onSearch" />
          <SearchResults v-if="searchOpen" :results="searchResults" :loading="searching"
                         :query="searchQ" @select="onSearchSelect" @close="closeSearch" />
        </div>
        <Btn variant="ghost" size="sm" icon="book" title="Documentation"
             @click="docsSection = undefined; docsOpen = true">Docs</Btn>
        <button class="theme-toggle"
                @click="setTweak('theme', tweaks.theme === 'dark' ? 'light' : 'dark')"
                :title="tweaks.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
                aria-label="Toggle theme">
          <span :class="['theme-toggle-thumb', tweaks.theme === 'dark' ? 'is-dark' : 'is-light']">
            <Icon :name="tweaks.theme === 'dark' ? 'moon' : 'sun'" :size="13" />
          </span>
          <span class="theme-toggle-ico"><Icon name="sun" :size="13" /></span>
          <span class="theme-toggle-ico"><Icon name="moon" :size="13" /></span>
        </button>
        <Btn v-slot:default v-if="route.name === 'dashboard' && currentUser?.role === 'admin'" variant="primary" icon="plus" @click="addOpen = 'playlist'">Add playlist</Btn>
      </header>

      <div class="screen" ref="screenEl" @scroll.passive="onScreenScroll"
           :class="{ 'mq-stage': stageRoute, 'mq-stage-screen': stageRoute }" :style="screenFlex || undefined">
        <router-view v-slot="{ Component }">
          <div v-if="stageRoute" class="mq-stage-content"
               :class="{ 'mq-stage-content-fill': route.name === 'active' }">
            <component :is="Component" @add="(k) => addOpen = k" />
          </div>
          <component v-else :is="Component" @add="(k) => addOpen = k" />
        </router-view>
      </div>
    </main>

    <ChannelDrawer v-if="channel" :ch="channel" @close="channel = null" />
    <AddEpgSourceModal v-if="addOpen === 'epg'" @close="addOpen = null" />
    <AddSourceModal v-else-if="addOpen === 'playlist'" @close="addOpen = null" />
    <LogsDrawer v-slot:default v-if="logsOpen" @close="logsOpen = false" />
    <DocsDrawer v-if="docsOpen" :section="docsSection" @close="docsOpen = false" />
    <ToastBanner />
    <ToastUpperRight />
    <ToastLowerRight />

    <TweaksPanel title="Tweaks">
      <TweakSection label="Theme" />
      <TweakRadio label="Mode" :value="tweaks.theme" :options="['light', 'dark']"
                  @change="(v) => setTweak('theme', v as any)" />
      <TweakSection label="Layout" />
      <TweakRadio label="Density" :value="tweaks.density" :options="['compact', 'regular', 'spacious']"
                  @change="(v) => setTweak('density', v as any)" />
      <TweakSection label="EPG view" />
      <TweakRadio label="Style" :value="tweaks.epgMode" :options="['timeline', 'list']"
                  @change="(v) => setTweak('epgMode', v as any)" />
    </TweaksPanel>
  </div>
</template>

<style scoped>
/* Absolutely centers the search box in the topbar (dead-center on every screen, independent of the
   title/crumb on the left and the Docs/theme/Add cluster on the right). Also anchors the
   absolute-positioned SearchResults dropdown directly under the box.

   Centered with a negative half-width margin, NOT `transform: translateX(-50%)`. A transform makes an
   element the containing block for its position:fixed descendants, which collapsed SearchResults'
   `.sr-backdrop` (position:fixed; inset:0) from the viewport down to this 480x36 box — so clicking
   anywhere outside the search box never dismissed the results. Keep this transform-free. */
.topbar-search {
  --sr-w: min(480px, 90vw);  /* the shared width: the input fills it, the results panel stretches to it */
  position: absolute;
  left: 50%;
  margin-left: calc(var(--sr-w) / -2);
  width: var(--sr-w);
  display: flex;
  align-items: center;
  z-index: 1;               /* keep the centered box above the flex siblings if they ever meet */
}
/* The input outranks the click-away backdrop (.sr-backdrop, z-index 90, a sibling in this same
   stacking context) so clicking back into the box to edit the query moves the caret instead of
   dismissing the results. Every other click still lands on the backdrop and closes them. */
.topbar-search > .search-input {
  position: relative;
  z-index: 92;
}
</style>
