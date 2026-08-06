<script setup lang="ts">
// UplApp — the Ultimate Player window's shell. Owns the URL params, the current channel, the single keymap,
// and the layout: picture on top, "what's on" strip beneath it, channel rail overlaid on the right.
//
// It is launched by ChannelDrawer as `player.html#pl=<playlistId>&ch=<channelId>` with a FIXED window name,
// so relaunching from the drawer re-navigates this same window. Only the hash changes in that case, which
// means no reload fires — hence the `hashchange` listener, which re-tunes (and reloads the channel list if
// the playlist itself changed).
//
// There is no vue-router and no App.vue shell here on purpose: no role guard to amend, no chrome to
// suppress, no `.app { min-width: 1100px }` to escape, and no second bootstrapData()/stats WebSocket.
// Auth comes from the same-origin localStorage token via authFetch.ts; every endpoint used re-checks the
// caller's playlist grant server-side.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import type { Channel } from '../data';
import { appPlayerProxyPath } from '../streamPath';
import Icon from '../components/Icon.vue';
import ChannelLogo from '../components/ChannelLogo.vue';
import UplVideoJsPlayer from './UplVideoJsPlayer.vue';
import UplEpgStrip from './UplEpgStrip.vue';
import UplChannelRail from './UplChannelRail.vue';
import {
  parseHash, loadChannels, orderedChannels, channelsError, loading,
  railPrograms, ensureRailPrograms, stripPrograms, loadStripPrograms,
  epgKey, startClock, stopClock,
} from './useUplData';

const params = ref(parseHash());
const currentId = ref<string>(params.value.ch);
const railOpen = ref(false);
const railRef = ref<InstanceType<typeof UplChannelRail> | null>(null);

const signedIn = !!localStorage.getItem('auth_token');

const current = computed<Channel | null>(
  () => orderedChannels.value.find((c) => c.id === currentId.value) ?? null,
);
const src = computed<string | null>(() => (current.value ? appPlayerProxyPath(current.value) : null));
const currentKey = computed(() => epgKey(current.value));

// --- engine + health readout ---------------------------------------------------------------------------
const engine = ref<'vhs' | 'native' | null>(null);
const stats = ref({ bitrateKbps: null as number | null, bufferSec: 0, dropped: 0 });
const resolution = ref<string | null>(null);
const levels = ref<{ index: number; label: string; active: boolean }[]>([]);
const pinnedLevel = ref(-1); // -1 = ABR (auto)
const playerRef = ref<InstanceType<typeof UplVideoJsPlayer> | null>(null);

const engineLabel = computed(() => {
  if (engine.value === 'vhs') return 'VHS · MSE';
  if (engine.value === 'native') return 'native HLS';
  return 'starting…';
});

function onStats(s: { bitrateKbps: number | null; bufferSec: number; dropped: number }): void {
  stats.value = s;
}

// Video.js's own control bar ships no quality selector, so the shell owns one, built from the
// QualityLevelList the player reports. Empty on Safari's native-HLS path — the browser does not expose its
// renditions — so the control says "Auto (native)" and disables rather than pretending to offer a choice.
function onLevels(l: { index: number; label: string; active: boolean }[]): void {
  levels.value = l;
  if (l.length === 0) pinnedLevel.value = -1;
}
function pinLevel(v: string): void {
  const i = Number(v);
  pinnedLevel.value = i;
  playerRef.value?.selectLevel(i);
}

// The drawer normally persists a channel's resolution when its embedded player reports one
// (ChannelDrawer.onResolution). With the player living out here, do the same so that behaviour survives
// Ultimate mode. `stream` is a MERGE patch server-side, so send only the changed field — never the whole
// stream object, which would carry the probe snapshot back over itself. Best-effort: the route is
// admin-only, so a standard user just gets a 403 we ignore.
async function onResolution(res: string): Promise<void> {
  resolution.value = res;
  const ch = current.value;
  if (!ch || ch.stream.res === res) return;
  try {
    await fetch(`/api/playlists/${encodeURIComponent(ch.source)}/channels/${encodeURIComponent(ch.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: { res } }),
    });
    ch.stream.res = res;
  } catch { /* non-essential telemetry */ }
}

// --- tuning --------------------------------------------------------------------------------------------
function tune(ch: Channel): void {
  if (ch.id === currentId.value) { railOpen.value = false; return; }
  currentId.value = ch.id;
  resolution.value = null;
  engine.value = null;
  railOpen.value = false;
  // Keep the address bar honest so a refresh (or a copied URL) lands on the channel being watched.
  const h = `#pl=${encodeURIComponent(params.value.pl)}&ch=${encodeURIComponent(ch.id)}`;
  if (window.location.hash !== h) window.history.replaceState(null, '', h);
}

function step(delta: number): void {
  const list = orderedChannels.value;
  const i = list.findIndex((c) => c.id === currentId.value);
  if (i < 0) { if (list[0]) tune(list[0]); return; }
  const next = list[(i + delta + list.length) % list.length];
  if (next) tune(next);
}

// --- keyboard: ONE keymap for the window ---------------------------------------------------------------
// Video.js's own hotkeys are disabled (userActions.hotkeys: false), so there is no second handler to fight.
// Typing in the rail's filter box must never be swallowed, hence the input-target bail-out.
function onKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
    if (e.key === 'Escape') { railOpen.value = false; (t as HTMLInputElement).blur(); }
    return;
  }
  switch (e.key) {
    case 'ArrowUp':
      if (!railOpen.value) railOpen.value = true;
      else railRef.value?.move(-1);
      e.preventDefault();
      break;
    case 'ArrowDown':
      if (!railOpen.value) railOpen.value = true;
      else railRef.value?.move(1);
      e.preventDefault();
      break;
    case 'Enter':
      if (railOpen.value) { railRef.value?.tuneCursor(); e.preventDefault(); }
      break;
    case '[': step(-1); break;
    case ']': step(1); break;
    case 'c': case 'C': railOpen.value = !railOpen.value; break;
    case 'Escape': railOpen.value = false; break;
    default: break;
  }
}

// --- lifecycle -----------------------------------------------------------------------------------------
async function boot(): Promise<void> {
  if (!params.value.pl) return;
  await loadChannels(params.value.pl);
  // Fall back to the first channel if the requested id isn't in this playlist (e.g. it was just deleted).
  if (!orderedChannels.value.some((c) => c.id === currentId.value)) {
    currentId.value = orderedChannels.value[0]?.id ?? '';
  }
}

function onHashChange(): void {
  const next = parseHash();
  const playlistChanged = next.pl !== params.value.pl;
  params.value = next;
  if (playlistChanged) {
    currentId.value = next.ch;
    void boot();
  } else if (next.ch && next.ch !== currentId.value) {
    currentId.value = next.ch;
  }
}

// Guide data for the channel being watched — the rich lane (descriptions, episode info).
watch(currentKey, (k) => { void loadStripPrograms(params.value.pl, k); }, { immediate: true });
// Keep the document title useful when several player windows are open.
watch(current, (c) => {
  document.title = c ? `${c.tvg_name} · Ultimate Player` : 'Ultimate Player · masqueradarr';
});

onMounted(() => {
  startClock();
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('keydown', onKey);
  if (signedIn) void boot();
});
onBeforeUnmount(() => {
  stopClock();
  window.removeEventListener('hashchange', onHashChange);
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="upl-root">
    <!-- Not signed in: this window can't authenticate on its own (no login form here by design). -->
    <div v-if="!signedIn" class="upl-gate">
      <Icon name="lock" :size="22" />
      <h2>Not signed in</h2>
      <p class="muted">Sign in to masqueradarr in the main window, then launch the player again.</p>
    </div>

    <div v-else-if="!params.pl" class="upl-gate">
      <Icon name="warn" :size="22" />
      <h2>No playlist</h2>
      <p class="muted">Open this window from a channel in a playlist so it knows what to load.</p>
    </div>

    <div v-else-if="channelsError" class="upl-gate">
      <Icon name="warn" :size="22" />
      <h2>Can't load channels</h2>
      <p class="muted">{{ channelsError }}</p>
    </div>

    <template v-else>
      <!-- Header: who's playing. Compact so the picture keeps the room. -->
      <header class="upl-hd">
        <ChannelLogo v-if="current" :ch="current" />
        <div class="upl-hd-txt">
          <div class="upl-hd-name">{{ current?.tvg_name ?? (loading ? 'Loading…' : 'No channel') }}</div>
          <div class="mono muted upl-hd-sub">
            #{{ current?.channelNo ?? '—' }}
            <template v-if="current?.group"> · {{ current.group }}</template>
            <template v-if="resolution || current?.stream.res"> · {{ resolution ?? current?.stream.res }}</template>
          </div>
        </div>
        <button type="button" class="upl-hd-btn" title="Channels (C)" @click="railOpen = !railOpen">
          <Icon name="list" :size="14" /> Channels
        </button>
      </header>

      <UplVideoJsPlayer
        ref="playerRef"
        :src="src"
        @resolution="onResolution"
        @engine="engine = $event"
        @stats="onStats"
        @levels="onLevels"
      />

      <UplEpgStrip :programs="stripPrograms" :has-epg-link="!!currentKey" />

      <!-- Engine + health. The engine label is deliberately explicit: on Safari this player runs the
           browser's native HLS rather than VHS, and that should be visible, not guessed at. -->
      <footer class="upl-foot mono">
        <span class="upl-foot-engine" :class="{ native: engine === 'native' }">
          <Icon name="chip" :size="12" /> {{ engineLabel }}
        </span>
        <span>{{ stats.bitrateKbps !== null ? (stats.bitrateKbps / 1000).toFixed(2) + ' Mb/s' : '—' }}</span>
        <span>buffer {{ stats.bufferSec.toFixed(1) }}s</span>
        <span>dropped {{ stats.dropped }}</span>
        <label class="upl-foot-q">
          quality
          <select
            v-if="levels.length"
            class="select upl-foot-select"
            :value="String(pinnedLevel)"
            @change="pinLevel(($event.target as HTMLSelectElement).value)"
          >
            <option value="-1">Auto</option>
            <option v-for="l in levels" :key="l.index" :value="String(l.index)">{{ l.label }}</option>
          </select>
          <select v-else class="select upl-foot-select" disabled>
            <option>Auto (native)</option>
          </select>
        </label>
        <span class="upl-foot-keys muted">↑↓ browse · ⏎ tune · [ ] prev/next · C channels</span>
      </footer>

      <UplChannelRail
        ref="railRef"
        :channels="orderedChannels"
        :programs="railPrograms"
        :current-id="currentId"
        :open="railOpen"
        @update:open="railOpen = $event"
        @tune="tune"
        @visible-keys="ensureRailPrograms(params.pl, $event)"
      />
    </template>
  </div>
</template>

<style scoped>
/* This window has no app shell, so the root owns the full-viewport column layout. */
.upl-root {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-0);
  color: var(--text-0);
}

.upl-hd {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--hairline);
  background: var(--bg-1);
}
.upl-hd-txt { flex: 1; min-width: 0; }
.upl-hd-name {
  font-weight: 600;
  font-size: var(--fs-base);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.upl-hd-sub { font-size: var(--fs-xs); margin-top: 2px; }
.upl-hd-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--radius-s);
  border: 1px solid var(--hairline-strong);
  background: transparent;
  color: var(--text-1);
  font-size: var(--fs-xs);
  cursor: pointer;
}
.upl-hd-btn:hover { color: var(--accent-hi); border-color: var(--accent); }

.upl-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 6px 14px;
  border-top: 1px solid var(--hairline);
  background: var(--bg-1);
  font-size: 10px;
  color: var(--text-3);
}
.upl-foot-engine { display: inline-flex; align-items: center; gap: 5px; color: var(--accent-hi); }
/* Native HLS is a genuinely different engine — flag it as a warn tone, not an accent one. */
.upl-foot-engine.native { color: var(--warn); }
.upl-foot-q { display: inline-flex; align-items: center; gap: 6px; }
.upl-foot-select { height: 22px; padding: 0 20px 0 6px; font-size: 10px; background-position: right 4px center; }
.upl-foot-keys { margin-left: auto; }

.upl-gate {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
  padding: 32px;
  color: var(--text-2);
}
.upl-gate h2 { margin: 0; font-size: var(--fs-h2); color: var(--text-0); }
.upl-gate p { margin: 0; max-width: 46ch; font-size: var(--fs-sm); }
</style>
