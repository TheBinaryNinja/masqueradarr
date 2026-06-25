<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';
import Pill from '../components/Pill.vue';
import StatusDot from '../components/StatusDot.vue';
import SearchInput from '../components/SearchInput.vue';
import Segmented from '../components/Segmented.vue';
import ChannelLogo from '../components/ChannelLogo.vue';
import LivelineChart from '../components/LivelineChart.vue';
import { ACTIVE_STREAMS, CHANNELS, EPG_PROGRAMS, SYSTEM_STATS, fetchProgramsFor, flagEmoji, type ActiveStream, type Program, type StreamClient, type EngineSnapshot } from '../data';
import { useStreamStats } from '../composables/useStreamStats';
import { useSystemStats } from '../composables/useSystemStats';
import ActiveStreamDiagram from '../components/ActiveStreamDiagram.vue';

// Live snapshot over the /api/stream-stats WebSocket (updates ACTIVE_STREAMS in place). Only show streams
// whose channelId resolves to a real channel in the global list.
const { subscribe, release, bitrateSeries } = useStreamStats();
// GPU frame for the diagram's GPU node (admin-only feed; same audience as this screen). gpuSeries → mini liveline.
const { subscribe: subscribeSys, release: releaseSys } = useSystemStats();
const liveStreams = computed(() => ACTIVE_STREAMS.value.filter((s) => CHANNELS.value.some((c) => c.id === s.channelId)));

const selId = ref<string | null>(null);
const filter = ref<'all' | 'live' | 'issues'>('all');
const search = ref('');
const viewing = ref<string | null>(null);
const playing = ref(true);
const muted = ref(false);

function chOf(s: ActiveStream) { return CHANNELS.value.find((c) => c.id === s.channelId)!; }

const filtered = computed(() => liveStreams.value.filter((s) => {
  if (filter.value === 'issues' && s.status === 'good') return false;
  if (filter.value === 'live' && s.status !== 'good') return false;
  if (search.value && !chOf(s).tvg_name.toLowerCase().includes(search.value.toLowerCase())) return false;
  return true;
}));
const sel = computed(() => liveStreams.value.find((s) => s.id === selId.value) || liveStreams.value[0]);
const totals = computed(() => ({
  streams: liveStreams.value.filter((s) => s.status !== 'bad').length,
  viewers: liveStreams.value.reduce((a, s) => a + s.viewers, 0),
  peak: liveStreams.value.reduce((a, s) => a + s.peakViewers, 0),
  bandwidth: liveStreams.value.reduce((a, s) => a + s.bandwidth, 0),
  issues: liveStreams.value.filter((s) => s.status !== 'good').length,
}));

// Technical detail for a stream: the live ffprobe snapshot rides ActiveStream.probe; fall back to the
// flat codec/resolution fields. `probed` flips on the extra probe-only rows (pixfmt / time base).
function techOf(s: ActiveStream) {
  const p = s.probe;
  if (p && (p.video.codec || p.audio.codec)) {
    const v = p.video, a = p.audio;
    const audio = [
      a.codec,
      a.channelLayout || (a.channels ? `${a.channels}ch` : null),
      a.sampleRate ? `${a.sampleRate} Hz` : null,
      a.format,
      a.bitrate ? `${Math.round(a.bitrate / 1000)}k` : null,
    ].filter(Boolean).join(' · ');
    return {
      probed: true,
      video: [v.codec, v.profile].filter(Boolean).join(' ') || '—',
      audio: audio || '—',
      container: p.container || s.container || '—',
      resolution: v.resolution || s.resolution || '—',
      fps: v.fps ?? s.fps,
      pixFmt: v.pixFmt,
      tbr: v.tbr,
      tbn: v.tbn,
    };
  }
  return { probed: false, video: s.codec ?? '—', audio: s.audio ?? '—', container: s.container ?? '—', resolution: s.resolution ?? '—', fps: s.fps, pixFmt: null, tbr: null, tbn: null };
}
const selTech = computed(() => (sel.value ? techOf(sel.value) : null));
const viewTech = computed(() => (viewStream.value ? techOf(viewStream.value) : null));

// External-client name from the User-Agent — a SOFT label only, used to enrich the "Player" pill. The
// session's player kind (appPlayer vs externalPlayer) is decided server-side by the request mount, never the UA.
function externalClientName(ua: string): string {
  const u = (ua || '').toLowerCase();
  if (u.includes('tivimate')) return 'TiviMate';
  if (u.includes('kodi')) return 'Kodi';
  if (u.includes('vlc')) return 'VLC';
  if (u.includes('exoplayer')) return 'ExoPlayer';
  if (u.includes('lavf') || u.includes('ffmpeg')) return 'ffmpeg';
  if (u.includes('coremedia') || u.includes('apple')) return 'Apple';
  if (u.includes('okhttp') || u.includes('dalvik')) return 'Android';
  return 'External';
}
// "Player" pill text for a connected viewer: In-App for the slide-out player, else the external client name.
function playerLabel(c: StreamClient): string {
  return c.playerType === 'externalPlayer' ? externalClientName(c.userAgent) : 'In-App';
}

// Real rolling bitrate series from the WS ticks — finite samples only, never a fabricated flat/zero
// series (a zero value-range freezes the liveline chart). LivelineChart shows a placeholder until ≥2
// real samples arrive, so an empty/short series here is fine.
const selSeries = computed(() => {
  if (!sel.value) return [];
  return bitrateSeries(sel.value.id).filter(Number.isFinite);
});
const selTarget = computed(() => sel.value?.bitrate || 1);
// Avg/min/max guard the empty series (fall back to the current bitrate) — Math.min(...[]) is Infinity.
const selAvg = computed(() => {
  const s = selSeries.value;
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : (sel.value?.bitrate || 0);
});
const selMin = computed(() => (selSeries.value.length ? Math.min(...selSeries.value) : (sel.value?.bitrate || 0)));
const selMax = computed(() => (selSeries.value.length ? Math.max(...selSeries.value) : (sel.value?.bitrate || 0)));

// HUD header chrome — DERIVED from the selected stream so each stream renders its own stable barcode +
// code tags (reads as real per-stream telemetry, never a fixed brand decoration). seedFrom() is the
// FNV-1a 32-bit hash of a string; the barcode reuses the Dashboard's deterministic LCG (seeded from the
// stream id) returning {rects,width}; the two code tags are 2-letter (source) + a stable id-hashed
// number. All aria-hidden (decorative). Keyed off `sel` so they re-derive on selection change.
const seedFrom = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const headerBarcode = computed(() => {
  const rects: { x: number; w: number }[] = [];
  let seed = seedFrom(sel.value?.id ?? 'masq') || 1, x = 0, ink = true;
  while (x < 240) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const w = 2 + (seed % 5);
    if (ink) rects.push({ x, w });
    x += w;
    ink = !ink;
  }
  return { rects, width: x };
});
const codeTags = computed(() => {
  const ch = sel.value ? CHANNELS.value.find((c) => c.id === sel.value!.channelId) : undefined;
  const src = (ch?.source || 'mq').toUpperCase();
  const h = seedFrom(sel.value?.id ?? '');
  const a = `${src.slice(0, 2)}-${100 + (h % 900)}`;        // e.g. DU-417
  const b = `${src.slice(-2) || 'HL'}-${10 + ((h >>> 8) % 90)}`; // e.g. LO-62
  return [a, b];
});

const viewStream = computed(() => liveStreams.value.find((s) => s.id === viewing.value));

// Connected viewers for the selected channel (re-fetched on selection + each snapshot). A monotonic
// token discards a stale response — rapid switching can leave an older channel's fetch in flight that
// resolves after the newer one, which would otherwise paint the wrong channel's sessions.
const clients = ref<StreamClient[]>([]);
let clientsReq = 0;
async function loadClients(id: string | undefined) {
  const my = ++clientsReq;
  if (!id) { clients.value = []; return; }
  try {
    const res = await fetch(`/api/active-streams/${encodeURIComponent(id)}/clients`);
    if (my !== clientsReq) return; // superseded by a newer selection
    if (res.ok) clients.value = (await res.json()) as StreamClient[];
  } catch { /* best-effort */ }
}
watch([() => sel.value?.id, ACTIVE_STREAMS], () => loadClients(sel.value?.id), { immediate: true });

// Per-channel external-player engine snapshot — drives the "Video Engine Service" diagram. Same monotonic-token
// pattern as loadClients; refreshes on selection + each WS tick. Empty ⇒ no transcode engine (passthrough/relay).
const engine = ref<EngineSnapshot[]>([]);
let engineReq = 0;
async function loadEngine(id: string | undefined) {
  const my = ++engineReq;
  if (!id) { engine.value = []; return; }
  try {
    const res = await fetch(`/api/active-streams/${encodeURIComponent(id)}/engine`);
    if (my !== engineReq) return; // superseded by a newer selection
    if (res.ok) engine.value = ((await res.json()) as { engines: EngineSnapshot[] }).engines;
  } catch { /* best-effort */ }
}
watch([() => sel.value?.id, ACTIVE_STREAMS], () => loadEngine(sel.value?.id), { immediate: true });

function onView() { if (!sel.value) return; viewing.value = sel.value.id; playing.value = sel.value.status !== 'bad'; muted.value = false; }
function close() { viewing.value = null; }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && viewing.value) close(); }
onMounted(() => { subscribe(); subscribeSys(); window.addEventListener('keydown', onKey); });
onBeforeUnmount(() => { release(); releaseSys(); window.removeEventListener('keydown', onKey); });

// Programs are stored epoch-ms — format an absolute epoch-ms time as local HH:MM.
function formatTime(ms: number) { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
// Resolve an active stream's channel to its guide key: the 2-factor EPG composite `${epg}:${tvg_id}`
// (= the Program.channelId) when linked, else the raw channel id as a fallback. Programs are no longer
// preloaded at boot, so this set is fetched lazily (see loadNowNext) — bounded to the live channels.
function npKey(channelId: string): string {
  const ch = CHANNELS.value.find((c) => c.id === channelId);
  return ch?.epg && ch.tvg_id ? `${ch.epg}:${ch.tvg_id}` : channelId;
}
function npData(channelId: string): { live?: Program; next?: Program } {
  const progs = EPG_PROGRAMS[npKey(channelId)] || [];
  const now = Date.now();
  const live = progs.find((p) => now >= p.start && now < p.end);
  const next = progs.find((p) => p.start >= (live ? live.end : now));
  return { live, next };
}

// Lazily load now/next guide for the (bounded) set of live channels — deduped by the channel-key set
// so a per-frame stats push doesn't refetch. Window: a little past → a few hours ahead (covers live + next).
const NP_HOUR_MS = 3_600_000;
let lastNpSig = '';
function loadNowNext(): void {
  const keys = [...new Set(liveStreams.value.map((s) => npKey(s.channelId)))];
  const sig = keys.slice().sort().join(',');
  if (!keys.length || sig === lastNpSig) return;
  lastNpSig = sig;
  const t = Date.now();
  void fetchProgramsFor(keys, t - NP_HOUR_MS, t + 3 * NP_HOUR_MS)
    .catch((err) => console.error('[active] now/next load failed:', err));
}
watch(liveStreams, loadNowNext, { immediate: true });

// Per-client display helpers.
function rateKB(bps: number) { return (bps / 1024).toFixed(0); }
function sinceLabel(ts: number) { const m = Math.floor((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; }
</script>

<template>
  <div class="col mq-active" style="height: 100%; min-height: 0;">
    <div class="stats">
      <div class="card stat">
        <div class="lbl">Live now</div>
        <div class="val">{{ totals.streams }}<span style="color: var(--text-3); font-size: 16px; font-weight: 500;"> / {{ liveStreams.length }}</span></div>
        <div class="delta"><span class="dot good pulse" style="width: 6px; height: 6px;" />relaying</div>
      </div>
      <div class="card stat">
        <div class="lbl">Viewers</div>
        <div class="val">{{ totals.viewers }}</div>
        <div class="delta"><Icon name="check" :size="12" />peak {{ totals.peak }} this session</div>
      </div>
      <div class="card stat">
        <div class="lbl">Egress</div>
        <div class="val">{{ totals.bandwidth.toFixed(1) }}<span style="font-size: 14px; color: var(--text-2); font-weight: 500;"> Mbps</span></div>
        <div class="delta">live across all viewers</div>
      </div>
      <div class="card stat">
        <div class="lbl">Issues</div>
        <div class="val">{{ totals.issues }}</div>
        <div :class="['delta', { bad: totals.issues }]">
          <template v-if="totals.issues"><Icon name="warn" :size="12" />needs attention</template>
          <template v-else><Icon name="check" :size="12" />all healthy</template>
        </div>
      </div>
    </div>

    <div v-if="sel && chOf(sel)" class="streams-grid">
      <div class="streams-list">
        <div class="toolbar">
          <SearchInput :value="search" @change="(v) => search = v" placeholder="Search streams" :width="180" />
          <span class="spacer" />
          <Segmented :value="filter" @change="(v) => filter = v as any" :options="[
            { value: 'all', label: 'All' },
            { value: 'live', label: 'Live' },
            { value: 'issues', label: 'Issues' },
          ]" />
        </div>
        <div class="body">
          <div v-for="s in filtered" :key="s.id"
               :class="['stream-item', { selected: selId === s.id }]" @click="selId = s.id"
               :title="s.watchers.length ? 'Watching: ' + s.watchers.join(', ') : undefined">
            <ChannelLogo :ch="chOf(s)" />
            <div style="min-width: 0;">
              <div class="nm">
                <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ chOf(s).tvg_name }}</span>
                <span v-if="s.status === 'good'" class="dot good pulse" style="width: 6px; height: 6px;" />
                <span v-else-if="s.status === 'warn'" class="dot warn" style="width: 6px; height: 6px;" />
                <span v-else class="dot bad" style="width: 6px; height: 6px;" />
              </div>
              <div class="meta">
                <span class="mono">{{ s.status === 'bad' ? 'offline' : (s.resolution ?? '—') }}</span>
                <span>·</span>
                <span class="mono">{{ s.status === 'bad' ? '—' : s.bitrate.toFixed(1) + ' Mbps' }}</span>
                <span>·</span>
                <span>{{ s.uptime }}</span>
                <template v-if="s.watchers.length === 1">
                  <span>·</span>
                  <span class="mono" style="color: var(--accent-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ s.watchers[0] }}</span>
                </template>
              </div>
            </div>
            <div class="viewer">
              <b>{{ s.viewers }}</b>
              <span>viewers</span>
            </div>
          </div>
          <div v-if="filtered.length === 0" class="empty" style="padding: 40px;">
            <div class="muted">No active streams — start playing a channel to see it here.</div>
          </div>
        </div>
      </div>

      <div class="stream-detail">
        <!-- HUD corner brackets framing the now-borderless instrument cluster -->
        <span class="corner tl" aria-hidden="true" /><span class="corner tr" aria-hidden="true" />
        <span class="corner bl" aria-hidden="true" /><span class="corner br" aria-hidden="true" />
        <div class="stream-detail-body" :style="{ padding: 'var(--pad-card)', display: 'flex', flexDirection: 'column', gap: '16px' }">
          <!-- brand telemetry header → 3-column strip: stacked mono lines · per-stream barcode · derived code tags -->
          <div class="asd-hdr-strip" aria-hidden="true">
            <div class="asd-hdr-text">
              <span class="mq-micro-hi">MASQUERADARR // STREAM</span>
              <div class="mq-overline">
                <span class="mq-ov-tag">SYS</span>
                <span class="mq-ov-rule" />
                <span class="mq-ov-dim">ACTIVE SESSION</span>
              </div>
            </div>
            <div class="asd-hdr-bars">
              <svg class="mq-barcode" :viewBox="`0 0 ${headerBarcode.width} 26`" preserveAspectRatio="none">
                <rect v-for="(r, i) in headerBarcode.rects" :key="i" :x="r.x" y="0" :width="r.w" height="26" />
              </svg>
            </div>
            <div class="asd-hdr-tags">
              <span>{{ codeTags[0] }}</span>
              <span>{{ codeTags[1] }}</span>
            </div>
          </div>
          <div class="row" style="gap: 14px;">
            <ChannelLogo :ch="chOf(sel)" size="lg" />
            <div style="flex: 1;">
              <div class="row" style="gap: 10px;">
                <h2 style="margin: 0; font-size: 17px; font-weight: 600;">{{ chOf(sel).tvg_name }}</h2>
                <!-- Status badge in a fixed-geometry slot so live/buffer/establishing/offline never
                     reflow the title row (each variant keeps its own color, the slot keeps the box). -->
                <span class="status-badge-slot">
                  <span v-if="sel.status === 'good'" class="live-pill"><span class="dot" />LIVE</span>
                  <Pill v-else-if="sel.status === 'bad'" tone="bad"><Icon name="warn" :size="11" />offline</Pill>
                  <Pill v-else tone="warn"><Icon name="warn" :size="11" />{{ sel.phase }}</Pill>
                </span>
              </div>
              <div class="mono muted" style="font-size: var(--fs-xs); margin-top: 4px;">
                #{{ chOf(sel).channelNo ?? '—' }} · {{ chOf(sel).group }} · stream-id <span style="color: var(--text-1);">{{ sel.id }}</span>
              </div>
              <div class="row" style="gap: 6px; margin-top: 8px; flex-wrap: wrap;">
                <span class="muted" style="font-size: var(--fs-xs);">Watching</span>
                <Pill v-for="u in sel.watchers.slice(0, 3)" :key="u" tone="cyan"><Icon name="check" :size="11" />{{ u }}</Pill>
                <Pill v-if="sel.watchers.length > 3">+{{ sel.watchers.length - 3 }} more</Pill>
                <span v-if="!sel.watchers.length" class="muted" style="font-size: var(--fs-xs);">{{ sel.viewers }} viewer{{ sel.viewers === 1 ? '' : 's' }} · no account</span>
              </div>
            </div>
            <button class="asd-globe" @click="onView" title="View channel" aria-label="View channel">
              <Icon name="orbit" :size="18" />
            </button>
          </div>

          <div class="stream-detail-split">
            <div class="stream-detail-main">
          <div class="card asd-label">
            <div class="asd-label-hd">
              <span class="asd-cap">BITRATE // LIVE</span>
              <span class="spacer" />
              <Pill tone="cyan">avg {{ selAvg.toFixed(1) }} Mbps</Pill>
              <Pill>min {{ selMin.toFixed(1) }}</Pill>
              <Pill>max {{ selMax.toFixed(1) }}</Pill>
            </div>
            <LivelineChart :series="selSeries" :target="selTarget" />
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
            <div class="card asd-label">
              <div class="asd-label-hd"><span class="asd-cap">TECHNICAL // DECODE</span></div>
              <div class="kv-list">
                <div class="k">Video</div><div class="v mono">{{ selTech?.video }}</div>
                <div class="k">Audio</div><div class="v mono">{{ selTech?.audio }}</div>
                <div class="k">Container</div><div class="v mono">{{ selTech?.container }}</div>
                <div class="k">Resolution</div><div class="v mono">{{ selTech?.resolution }}<template v-if="selTech?.fps"> @ {{ selTech?.fps }}fps</template></div>
                <template v-if="selTech?.probed">
                  <div class="k">Pixel format</div><div class="v mono">{{ selTech.pixFmt ?? '—' }}</div>
                  <div class="k">Frame rate</div><div class="v mono">{{ selTech.fps ?? '—' }} fps · {{ selTech.tbr ?? '—' }} tbr · {{ selTech.tbn ?? '—' }} tbn</div>
                </template>
                <div class="k">Phase</div><div class="v mono">{{ sel.phase }}</div>
              </div>
              <div class="asd-label-ft" aria-hidden="true"><span class="asd-cap-dim">DECODE SPEC</span><span class="asd-mk">MK-07.10</span></div>
            </div>
            <div class="card asd-label">
              <div class="asd-label-hd"><span class="asd-cap">SOURCE // FEED</span></div>
              <div class="kv-list">
                <div class="k">Stream entry</div>
                <div class="v mono" style="font-size: 11px; word-break: break-all;">{{ chOf(sel).streamEntryUrl }}</div>
                <div class="k">Protocol</div><div class="v mono">HLS</div>
                <div class="k">TVG-ID</div>
                <div class="v mono">
                  <template v-if="chOf(sel).tvg_id">{{ chOf(sel).tvg_id }}</template>
                  <span v-else style="color: var(--text-3);">—</span>
                </div>
                <div class="k">Source</div>
                <div class="v"><Pill tone="cyan">{{ chOf(sel).source }}</Pill></div>
                <div class="k">EPG</div>
                <div class="v">
                  <Pill v-if="chOf(sel).epgState === 'matched'" tone="good"><Icon name="check" :size="11" />matched</Pill>
                  <Pill v-else tone="warn">unmatched</Pill>
                </div>
              </div>
              <div class="asd-label-ft" aria-hidden="true"><span class="asd-cap-dim">FEED SPEC</span><span class="asd-mk">MK-07.11</span></div>
            </div>
          </div>

          <div class="card flush stream-sessions asd-label asd-label-flush">
            <div class="card-hd asd-label-hd" style="padding: 12px 14px;">
              <span class="asd-cap">SESSIONS // CONNECTED</span>
              <Pill tone="cyan">{{ clients.length }}</Pill>
              <span class="spacer" />
            </div>
            <div v-if="clients.length === 0" class="empty" style="padding: 28px;">
              <div class="muted">{{ sel.status === 'bad' ? 'No viewers — stream is offline.' : 'No connected viewers right now.' }}</div>
            </div>
            <!-- The ONLY scroller in the panel: capped to ~2 data rows, header pinned (sticky thead). -->
            <div v-else class="asd-sess-scroll">
              <table class="tbl">
                <thead>
                  <tr><th>User</th><th>Client IP</th><th>Location</th><th>Player</th><th>Connected</th><th>Rate</th></tr>
                </thead>
                <tbody>
                  <tr v-for="c in clients" :key="c.ip + c.userAgent + (c.username ?? '')">
                    <td><Pill tone="cyan"><Icon name="check" :size="11" />{{ c.username || 'unknown' }}</Pill></td>
                    <td class="mono">{{ c.ip }}</td>
                    <td class="mono" style="max-width: 160px;"><div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ flagEmoji(c.countryCode) }} {{ c.location || '—' }}</div></td>
                    <td style="max-width: 240px;">
                      <div class="row" style="gap: 6px; align-items: center; white-space: nowrap; overflow: hidden;">
                        <Pill :tone="c.playerType === 'externalPlayer' ? 'system' : 'cyan'">{{ playerLabel(c) }}</Pill>
                        <span class="mono muted" style="overflow: hidden; text-overflow: ellipsis;" :title="c.userAgent">{{ c.userAgent || 'unknown' }}</span>
                      </div>
                    </td>
                    <td class="mono muted">{{ sinceLabel(c.connectedAt) }}</td>
                    <td class="mono">{{ rateKB(c.currentRate) }} KB/s</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
            </div>
            <aside class="stream-detail-engine">
              <div class="asd-railhd">
                <Icon name="topology" :size="15" />
                <h2>Video Engine Service</h2>
                <span class="spacer" />
                <span class="asd-cap">ENGINE // DECODE</span>
              </div>
              <ActiveStreamDiagram
                v-if="engine.length"
                :channel="chOf(sel)" :stream="sel" :engines="engine"
                :clients="clients" :gpu="SYSTEM_STATS.gpu"
              />
              <div v-else class="asd-note">
                <Icon name="tv" :size="22" />
                <div class="asd-note-t">Served directly to the in-app player</div>
                <div class="muted">HLS passthrough — no transcode engine for this stream.</div>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="card empty" style="flex: 1; display: grid; place-items: center;">
      <div style="text-align: center;">
        <Icon name="tv" :size="32" />
        <h3 style="margin-top: 12px;">No active streams</h3>
        <div class="muted" style="font-size: var(--fs-sm);">Play a channel through the proxy and it appears here in real time.</div>
      </div>
    </div>

    <!-- Stream viewer slide-over -->
    <div v-if="viewStream" class="stream-view-bg" @click="close">
      <div class="stream-view" @click.stop>
        <div class="stream-view-hd">
          <ChannelLogo :ch="chOf(viewStream)" />
          <div style="min-width: 0; flex: 1;">
            <div class="row" style="gap: 8px;">
              <span style="font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ chOf(viewStream).tvg_name }}</span>
              <span v-if="viewStream.status !== 'bad'" class="live-pill"><span class="dot" />LIVE</span>
              <Pill v-else tone="bad"><Icon name="warn" :size="11" />offline</Pill>
            </div>
            <div class="mono muted" style="font-size: var(--fs-xs); margin-top: 3px;">
              #{{ chOf(viewStream).channelNo ?? '—' }} · {{ chOf(viewStream).group }} ·
              {{ viewStream.status === 'bad' ? 'no signal' : (viewStream.resolution ?? '—') + ' · ' + viewStream.bitrate.toFixed(1) + ' Mbps' }}
            </div>
          </div>
          <Btn variant="ghost" size="sm" icon="x" @click="close" title="Close (Esc)" />
        </div>

        <div class="stream-view-body">
          <div class="player" style="border-radius: 12px;">
            <template v-if="viewStream.status === 'bad'">
              <div style="position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-2); font-size: 13px;">
                <div style="text-align: center;">
                  <Icon name="warn" :size="32" />
                  <div style="margin-top: 12px; font-weight: 600; color: var(--text-1); font-size: 15px;">Stream offline</div>
                  <div class="mono" style="font-size: 11px; margin-top: 6px;">upstream unreachable</div>
                </div>
              </div>
            </template>
            <template v-else>
              <div class="stripes" />
              <div class="label mono">{{ viewTech?.resolution }} · {{ viewTech?.fps ?? '—' }}fps · {{ viewStream.bitrate.toFixed(1) }} Mbps</div>
              <div v-if="!playing" class="play" @click="playing = true">
                <div class="play-btn"><Icon name="play" :size="28" /></div>
              </div>
              <div class="controls">
                <button class="player-ctrl" @click="playing = !playing">
                  <Icon :name="playing ? 'pause' : 'play'" :size="14" />
                </button>
                <div class="track" />
                <button class="player-ctrl" @click="muted = !muted">
                  <Icon :name="muted ? 'x' : 'check'" :size="13" />
                </button>
                <span class="mono" style="font-size: 11px;">LIVE</span>
                <button class="player-ctrl" title="Fullscreen"><Icon name="grid" :size="13" /></button>
              </div>
            </template>
          </div>

          <div v-if="viewStream.status !== 'bad'" class="card flush" style="background: var(--bg-2);">
            <div class="card-hd" style="padding: 12px 14px;">
              <h2 style="font-size: 13px;">From the guide</h2>
              <span class="spacer" />
              <span class="muted" style="font-size: var(--fs-xs);">EPG-matched</span>
            </div>
            <div :style="{ padding: '14px', display: 'grid', gridTemplateColumns: npData(viewStream.channelId).live && npData(viewStream.channelId).next ? '1fr 1fr' : '1fr', gap: '12px' }">
              <div v-if="npData(viewStream.channelId).live"
                   style="padding: 10px 12px; border-radius: 8px; background: var(--accent-soft); border: 1px solid oklch(0.82 0.13 220 / 0.4);">
                <div class="mono" style="font-size: 10px; letter-spacing: 0.08em; color: var(--accent-hi); font-weight: 600;">ON NOW</div>
                <div style="font-weight: 600; font-size: 14px; margin-top: 4px; color: var(--accent-hi);">{{ npData(viewStream.channelId).live!.title }}</div>
                <div class="mono muted" style="font-size: 11px; margin-top: 4px;">
                  {{ formatTime(npData(viewStream.channelId).live!.start) }}–{{ formatTime(npData(viewStream.channelId).live!.end) }} · {{ npData(viewStream.channelId).live!.cat }}
                </div>
              </div>
              <div v-if="npData(viewStream.channelId).next"
                   style="padding: 10px 12px; border-radius: 8px; background: var(--bg-3); border: 1px solid var(--hairline);">
                <div class="mono" style="font-size: 10px; letter-spacing: 0.08em; color: var(--text-2); font-weight: 600;">UP NEXT</div>
                <div style="font-weight: 600; font-size: 14px; margin-top: 4px; color: var(--text-0);">{{ npData(viewStream.channelId).next!.title }}</div>
                <div class="mono muted" style="font-size: 11px; margin-top: 4px;">
                  {{ formatTime(npData(viewStream.channelId).next!.start) }}–{{ formatTime(npData(viewStream.channelId).next!.end) }} · {{ npData(viewStream.channelId).next!.cat }}
                </div>
              </div>
            </div>
          </div>

          <div class="metric-grid" style="grid-template-columns: repeat(4, 1fr);">
            <div class="metric"><div class="lbl">Viewers</div><div class="val" style="font-size: 17px;">{{ viewStream.viewers }}</div></div>
            <div class="metric"><div class="lbl">Bitrate</div><div class="val" style="font-size: 17px;">{{ viewStream.status === 'bad' ? '—' : viewStream.bitrate.toFixed(1) + ' Mbps' }}</div></div>
            <div class="metric"><div class="lbl">Bandwidth</div><div class="val" style="font-size: 17px;">{{ viewStream.bandwidth }} Mbps</div></div>
            <div class="metric"><div class="lbl">Uptime</div><div class="val" style="font-size: 17px;">{{ viewStream.uptime }}</div></div>
          </div>

          <div class="card flush" style="background: var(--bg-2);">
            <div class="card-hd" style="padding: 12px 14px;">
              <h2 style="font-size: 13px;">Stream details</h2>
              <span class="spacer" />
              <Pill :tone="viewStream.status === 'bad' ? 'bad' : viewStream.status === 'warn' ? 'warn' : 'good'">
                <StatusDot :status="viewStream.status" :pulse="viewStream.status !== 'bad'" />
                {{ viewStream.status === 'bad' ? 'offline' : viewStream.status === 'warn' ? viewStream.phase : 'healthy' }}
              </Pill>
            </div>
            <div style="padding: 14px;">
              <div class="kv-list">
                <div class="k">Video</div><div class="v mono">{{ viewTech?.video }}</div>
                <div class="k">Audio</div><div class="v mono">{{ viewTech?.audio }}</div>
                <div class="k">Container</div><div class="v mono">{{ viewTech?.container }}</div>
                <div class="k">Resolution</div><div class="v mono">{{ viewTech?.resolution }}<template v-if="viewTech?.fps"> @ {{ viewTech?.fps }}fps</template></div>
                <template v-if="viewTech?.probed">
                  <div class="k">Pixel format</div><div class="v mono">{{ viewTech.pixFmt ?? '—' }}</div>
                  <div class="k">Frame rate</div><div class="v mono">{{ viewTech.fps ?? '—' }} fps · {{ viewTech.tbr ?? '—' }} tbr · {{ viewTech.tbn ?? '—' }} tbn</div>
                </template>
                <div class="k">Bandwidth</div><div class="v mono">{{ viewStream.bandwidth }} Mbps egress</div>
                <div class="k">TVG-ID</div>
                <div class="v mono">
                  <template v-if="chOf(viewStream).tvg_id">{{ chOf(viewStream).tvg_id }}</template>
                  <span v-else style="color: var(--text-3);">—</span>
                </div>
                <div class="k">Source</div>
                <div class="v"><Pill tone="cyan">{{ chOf(viewStream).source }}</Pill></div>
              </div>
            </div>
          </div>

          <div class="row" style="gap: 8px;">
            <Btn variant="ghost" icon="edit">Edit channel</Btn>
            <span class="spacer" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* masqueradarr stage depth — lift the top-level surfaces off the brand gradient field. The 4 stat
   cards + the empty state now inherit the elevation from the global .card recipe (which carries the
   same gradient + sheen + multi-layer shadow), so their scoped copies were removed as pure duplicates.
   The streams LIST panel is NOT a .card, so the global rule never reaches it — it keeps its explicit
   lift here (own bg retained, elevation only). The stream-DETAIL panel is a borderless HUD instrument
   cluster (no surface, no lift — defined by corner brackets, a brand header, and flat spec-label inner
   cards), so it is intentionally NOT lifted here. The slide-over viewer modal is also not matched, and
   the liveline's container is never touched. */
.mq-active .streams-list {
  border-color: var(--hairline-strong);
  box-shadow:
    inset 0 1px 0 var(--hairline-strong),
    0 1px 2px rgba(0, 0, 0, 0.28),
    0 14px 34px rgba(0, 0, 0, 0.34);
}
[data-theme="light"] .mq-active .streams-list {
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.8),
    0 1px 2px rgba(0, 0, 0, 0.06),
    0 12px 28px rgba(0, 0, 0, 0.10);
}

/* ───────────────────────── stream-detail → HUD instrument cluster ─────────────────────────
   Everything below is SCOPED under .stream-detail so the globally-shared .card / .metric / .kv-list
   rules are never altered for other screens. Definition comes from corner brackets, a brand header,
   hairlines, teal mono captions, the metric emblems, and accent underbars — not fills/borders.
   Theme-aware tokens only (no reference HEX), so light mode stays legible. */

/* Corner brackets framing the borderless panel (the LoginScreen/SetupScreen idiom). */
.stream-detail .corner {
  position: absolute;
  width: 14px;
  height: 14px;
  pointer-events: none;
  z-index: 1;
}
.stream-detail .corner.tl { top: 9px; left: 9px; border-top: 1.5px solid var(--bracket); border-left: 1.5px solid var(--bracket); }
.stream-detail .corner.tr { top: 9px; right: 9px; border-top: 1.5px solid var(--bracket); border-right: 1.5px solid var(--bracket); }
.stream-detail .corner.bl { bottom: 9px; left: 9px; border-bottom: 1.5px solid var(--bracket); border-left: 1.5px solid var(--bracket); }
.stream-detail .corner.br { bottom: 9px; right: 9px; border-bottom: 1.5px solid var(--bracket); border-right: 1.5px solid var(--bracket); }

/* Brand telemetry header (mirrors the Dashboard .mq-* header chrome — those classes are scoped to the
   Dashboard, so the equivalents are redeclared here scoped to this panel). */
.stream-detail .asd-hdr-strip {
  display: flex;
  align-items: stretch;
  gap: 16px;
}
/* Left: the two stacked mono lines (brand line over the SYS / ACTIVE SESSION overline). */
.stream-detail .asd-hdr-text {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 5px;
  flex: none;
}
.stream-detail .mq-micro-hi {
  font-family: var(--mq-font-mono);
  font-size: 9.5px;
  letter-spacing: 0.16em;
  color: var(--text-2);
}
.stream-detail .mq-overline { display: flex; align-items: center; gap: 9px; }
.stream-detail .mq-ov-tag { font-family: var(--mq-font-mono); font-size: 10.5px; letter-spacing: 0.16em; color: var(--accent); }
.stream-detail .mq-ov-rule { height: 1px; width: 42px; background: var(--accent); opacity: 0.5; }
.stream-detail .mq-ov-dim { font-family: var(--mq-font-mono); font-size: 10.5px; letter-spacing: 0.16em; color: var(--text-3); }
/* Middle: a per-stream deterministic barcode (fills), height = the two-line text block, faint band behind. */
.stream-detail .asd-hdr-bars {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in oklab, var(--text-3) 6%, transparent);
}
.stream-detail .asd-hdr-bars .mq-barcode {
  display: block;
  width: 100%;
  height: 22px;
  opacity: 0.45;
}
.stream-detail .asd-hdr-bars .mq-barcode rect { fill: var(--text-2); }
/* Right: two stacked dim mono code tags, right-aligned. */
.stream-detail .asd-hdr-tags {
  flex: none;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: flex-end;
  gap: 5px;
  font-family: var(--mq-font-mono);
  font-size: 10.5px;
  letter-spacing: 0.12em;
  color: var(--text-3);
}

/* Header action: "View channel" is now an icon-only HUD control (bracketed, teal glyph) — the
   masqueradarr orbit-globe / UPLINK radar motif (MK-07.10) — instead of the heavy primary fill, to
   suit the stripped panel. (Class kept as .asd-globe: it's a CSS hook, not the glyph name.) */
.stream-detail .asd-globe {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: var(--accent-soft);
  border: 1px solid oklch(0.82 0.13 220 / 0.35);
  color: var(--accent-hi);
  cursor: default;
  transition: background .12s, border-color .12s, box-shadow .12s;
}
.stream-detail .asd-globe:hover {
  background: color-mix(in oklab, var(--accent) 22%, transparent);
  border-color: oklch(0.82 0.13 220 / 0.55);
  box-shadow: 0 0 12px var(--accent-glow);
}

/* Spec-sheet "label" instruments (the MK-07.10 UPLINK SPEC idiom): flat surface, a teal mono caption
   over a hairline, and an optional footer code-tag bar. Shared by the bitrate/technical/source cards;
   the sessions card reuses the caption styles via .asd-label-hd on its existing .card-hd. */
.stream-detail .asd-label {
  background: transparent;
  border: none;
  border-radius: 0;
  box-shadow: none; /* zero the global .card elevation — these HUD labels are flat by design */
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
}
.stream-detail .asd-label-flush { padding: 0; }
.stream-detail .asd-label-hd {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 9px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--hairline);
}
.stream-detail .asd-label-hd .spacer { flex: 1; }
.stream-detail .card-hd.asd-label-hd { margin-bottom: 0; }
.stream-detail .asd-cap {
  font-family: var(--mq-font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--accent);
  white-space: nowrap;
}
.stream-detail .asd-cap-dim {
  font-family: var(--mq-font-mono);
  font-size: 9.5px;
  letter-spacing: 0.12em;
  color: var(--text-2);
}
/* Footer code-tag bar (the muse's "UPLINK SPEC · MK-07.10" footer). */
.stream-detail .asd-label-ft {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px solid var(--hairline);
}
.stream-detail .asd-mk {
  font-family: var(--mq-font-mono);
  font-size: 9.5px;
  letter-spacing: 0.04em;
  color: var(--text-3);
}
/* kv-list rows recast to the mono spec idiom inside the label cards. */
.stream-detail .asd-label .kv-list .k { font-family: var(--mq-font-mono); font-size: 11px; letter-spacing: 0.04em; color: var(--text-2); }

/* Connected-sessions table → mono + hairline idiom (table semantics unchanged). */
.stream-detail .stream-sessions .tbl th {
  font-family: var(--mq-font-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  color: var(--text-2);
}
/* The sessions table is the ONLY scroller in the panel: capped to ~2 data rows so the panel itself
   never scrolls. The shared .tbl thead th is already position:sticky/top:0; give it an opaque bg here
   so scrolled rows don't bleed through the borderless (transparent) panel. Density-aware via --row-h. */
.stream-detail .stream-sessions .asd-sess-scroll {
  max-height: calc(var(--row-h) * 2 + 38px);
  overflow-y: auto;
}
.stream-detail .stream-sessions .asd-sess-scroll .tbl thead th {
  background: var(--bg-1);
  z-index: 1;
}

/* Engine rail header caption (the teal spec-label cue trails the existing title). */
.stream-detail .asd-railhd .spacer { flex: 1; }
.stream-detail .asd-railhd .asd-cap { color: var(--accent); }
</style>
