<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import StatusDot from './StatusDot.vue';
import ChannelLogo from './ChannelLogo.vue';
import Segmented from './Segmented.vue';
import HlsPlayer from './HlsPlayer.vue';
import LivelineChart from './LivelineChart.vue';
import { useStreamStats } from '../composables/useStreamStats';
import { ACTIVE_STREAMS, GROUPS, PLAYLISTS, appPlayerProxyPath, type Channel, type StreamProbe } from '../data';

const props = defineProps<{ ch: Channel }>();
const emit = defineEmits<{ (e: 'close'): void }>();

// The owning playlist (a (Default) playlist's id === source). `builtin` decides whether the stream entry
// url is editable (built-in source playlists resolve their own urls; only mock/custom ones expose it).
const playlist = computed(() => PLAYLISTS.value.find((p) => p.id === props.ch.source));
const builtin = computed(() => playlist.value?.builtin === true);

// Editable copies (seeded from the channel). The Status toggle persists immediately; the other fields are
// persisted on Save. Only changed fields are sent.
const displayName = ref(props.ch.tvg_name);
const channelNo = ref(props.ch.channelNo ?? '');
const group = ref(props.ch.group ?? '');
const tvgId = ref(props.ch.tvg_id ?? '');
const streamUrl = ref(props.ch.streamEntryUrl ?? '');

// Persist an edit to this channel via PUT /api/playlists/<source>/channels/<id>, then reflect it locally
// so the open lists update. (Channels are keyed by deterministic id; source === the (Default) playlist id.)
// A nested `stream` patch is MERGED into the existing stream object so live-field PUTs don't clobber siblings.
async function putChannel(patch: Record<string, unknown>): Promise<void> {
  const { source, id } = props.ch;
  if (!source) return;
  try {
    const res = await fetch(
      `/api/playlists/${encodeURIComponent(source)}/channels/${encodeURIComponent(id)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) },
    );
    if (res.ok) {
      const { stream, ...flat } = patch;
      Object.assign(props.ch, flat);
      if (stream && typeof stream === 'object') Object.assign(props.ch.stream, stream);
    }
  } catch {
    // best-effort
  }
}

function setStatus(v: string) {
  putChannel({ status: v });
}

function save() {
  const patch: Record<string, unknown> = {};
  if (displayName.value !== props.ch.tvg_name) patch.tvg_name = displayName.value;
  if ((channelNo.value || null) !== (props.ch.channelNo ?? null)) patch.channelNo = channelNo.value || null;
  if ((group.value || null) !== (props.ch.group ?? null)) patch.group = group.value || null;
  if (!builtin.value && (streamUrl.value || null) !== (props.ch.streamEntryUrl ?? null)) {
    patch.streamEntryUrl = streamUrl.value || null;
  }
  if ((tvgId.value || null) !== (props.ch.tvg_id ?? null)) {
    patch.tvg_id = tvgId.value || null;
    // Changing the EPG link factor unlinks any prior match (mirrors MappingScreen.unlink).
    patch.epg = null;
    patch.epgState = 'unmatched';
  }
  if (Object.keys(patch).length) putChannel(patch);
  emit('close');
}

// Live HLS resolution → persist stream.res when it actually changes (drawer open).
function onResolution(res: string) {
  if (res !== props.ch.stream.res) putChannel({ stream: { res } });
}

// Live stream status — the server decides the B-Roll phase (establishing/buffer/failed) for the
// channel and the proxy serves the matching slate; we poll it here to drive the status pill so the
// drawer reflects what's actually playing instead of a hardcoded "stream live". See
// GET /api/sources/:id/channel-status (restapi-sources.md).
type Phase = 'live' | 'establishing' | 'buffer' | 'failed';
const phase = ref<Phase | null>(null);
const retry = ref(0);
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ffprobe-derived technical details. Seeded from the persisted snapshot (instant), then refreshed live from
// GET /api/sources/:id/stream-details while the channel is live (the server probes ~every 10s — see
// streamProbe.ts). See restapi-sources.md → "ffprobe stream monitoring".
const details = ref<StreamProbe | null>(props.ch.stream.probe ?? null);

async function pollDetails() {
  const { streamEntryUrl } = props.ch;
  const source = props.ch.origin || props.ch.source; // proxy source (mirror appPlayerProxyPath): imports route via 'direct'
  if (!source || !streamEntryUrl) return;
  try {
    const res = await fetch(
      `/api/sources/${source}/stream-details?channelId=${encodeURIComponent(streamEntryUrl)}`,
    );
    if (!res.ok) return;
    const p = (await res.json()) as StreamProbe | null;
    if (p) details.value = p; // keep the last good probe if the server hasn't probed yet (null)
  } catch {
    // best-effort
  }
}

async function pollStatus() {
  const { streamEntryUrl } = props.ch;
  const source = props.ch.origin || props.ch.source; // proxy source (mirror appPlayerProxyPath): imports route via 'direct'
  if (!source || !streamEntryUrl) return;
  try {
    const res = await fetch(
      `/api/sources/${source}/channel-status?channelId=${encodeURIComponent(streamEntryUrl)}`,
    );
    if (!res.ok) return;
    const s = (await res.json()) as { phase: Phase; retry: number };
    phase.value = s.phase;
    retry.value = s.retry ?? 0;
    // Persist the realtime phase onto the doc when it changes (drawer open).
    if (s.phase !== props.ch.stream.status) putChannel({ stream: { status: s.phase } });
    // Refresh technical details once the channel is live (cheap in-memory read; server-side TTL'd).
    if (s.phase === 'live') pollDetails();
  } catch {
    // best-effort — leave the last known phase
  }
}

// Status chip driven by the PERSISTENT document field `ch.stream.status` (kept live by pollStatus, which
// PUTs the polled phase onto the doc). The chip reads the stored value so it stays in sync with what's
// persisted while still updating live.
const statusChip = computed(() => {
  switch (props.ch.stream.status) {
    case 'live':
      return { tone: 'good', dot: 'good', pulse: false, label: 'Stream Live' };
    case 'establishing':
      return { tone: 'warn', dot: 'warn', pulse: true, label: 'Stream Establishing' };
    case 'buffer':
      return { tone: 'warn', dot: 'warn', pulse: true, label: 'Stream Buffering' };
    case 'failed':
      return { tone: 'bad', dot: 'bad', pulse: false, label: 'Stream Failed' };
    default:
      return { tone: 'cyan', dot: 'idle', pulse: true, label: 'Connecting…' };
  }
});

// Compact one-line presenters for the ffprobe technical details (null → row shows '—').
const videoLine = computed(() => {
  const v = details.value?.video;
  if (!v || !v.codec) return null;
  const parts = [v.codec, v.profile, v.resolution, v.pixFmt].filter(Boolean) as string[];
  if (v.bitrate) parts.push(`${Math.round(v.bitrate / 1000)}k`);
  return parts.join(' · ');
});
const audioLine = computed(() => {
  const a = details.value?.audio;
  if (!a || !a.codec) return null;
  const parts: string[] = [a.codec];
  if (a.channelLayout) parts.push(a.channelLayout);
  else if (a.channels) parts.push(`${a.channels}ch`);
  if (a.sampleRate) parts.push(`${a.sampleRate} Hz`);
  if (a.format) parts.push(a.format);
  if (a.bitrate) parts.push(`${Math.round(a.bitrate / 1000)}k`);
  return parts.join(' · ');
});
const timingLine = computed(() => {
  const v = details.value?.video;
  if (!v) return null;
  const parts: string[] = [];
  if (v.fps != null) parts.push(`${v.fps} fps`);
  if (v.tbr != null) parts.push(`${v.tbr} tbr`);
  if (v.tbn != null) parts.push(`${v.tbn} tbn`);
  return parts.length ? parts.join(' · ') : null;
});

// Live "liveline" bitrate for THIS channel, off the same /api/stream-stats telemetry the Active Streams
// screen uses (useStreamStats is a ref-counted singleton — subscribe on mount, release on unmount). The
// embedded HlsPlayer streams through the proxy, so opening the drawer registers this channel as a viewer
// and its per-channel bitrate series fills within ~2.5s. Everything is keyed by the channel's deterministic
// id (= ActiveStream.channelId = PlaylistChannel._id), so the readout is scoped to this channel alone.
const { subscribe, release, bitrateSeries } = useStreamStats();
const liveStream = computed(() => ACTIVE_STREAMS.value.find((s) => s.channelId === props.ch.id));
const bitrateSamples = computed(() => bitrateSeries(props.ch.id).filter(Number.isFinite));
const bitrateTarget = computed(() => liveStream.value?.bitrate || 1);

watch(
  () => props.ch.id,
  () => {
    phase.value = null;
    retry.value = 0;
    details.value = props.ch.stream.probe ?? null;
    displayName.value = props.ch.tvg_name;
    channelNo.value = props.ch.channelNo ?? '';
    group.value = props.ch.group ?? '';
    tvgId.value = props.ch.tvg_id ?? '';
    streamUrl.value = props.ch.streamEntryUrl ?? '';
    pollStatus();
  },
);

onMounted(() => {
  subscribe();
  pollStatus();
  pollTimer = setInterval(pollStatus, 2000);
});
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
  release();
});
</script>

<template>
  <div class="drawer-wrap">
    <div class="glass-bg drawer-backdrop" @click="emit('close')" />
    <div class="glass drawer-panel" style="width: 750px; max-width: 96vw;">
      <div class="drawer-hd">
        <ChannelLogo :ch="ch" size="lg" />
        <div style="flex: 1;">
          <div style="font-weight: 600; font-size: 15px;">{{ ch.tvg_name }}</div>
          <div class="mono muted" style="font-size: var(--fs-xs); margin-top: 2px;">
            #{{ ch.channelNo ?? '—' }} · {{ ch.group }}<template v-if="ch.stream.res"> · {{ ch.stream.res }}</template>
          </div>
        </div>
        <Btn variant="ghost" size="sm" icon="x" @click="emit('close')" />
      </div>

      <div class="drawer-body chd-body">
        <!-- Media + details stack vertically: player → liveline → tech details → status chips. -->
        <!-- Source-playlist channels stream live through the proxy; legacy mock channels keep the
             non-functional placeholder. -->
        <div class="player chd-player" v-if="ch.streamEntryUrl" style="overflow: hidden;">
          <HlsPlayer :src="appPlayerProxyPath(ch)" @resolution="onResolution" />
        </div>
        <div class="player chd-player" v-else>
          <div class="stripes" />
          <div class="label mono">STREAM TEST<template v-if="ch.stream.res"> · {{ ch.stream.res }}</template></div>
          <div class="play"><div class="play-btn"><Icon name="play" :size="26" /></div></div>
          <div class="controls">
            <Icon name="pause" :size="14" />
            <span class="mono" style="font-size: 11px;">00:14</span>
            <div class="track" />
            <span class="mono" style="font-size: 11px;">LIVE</span>
          </div>
        </div>

        <!-- Live "liveline" bitrate for this channel — self-contained 250px chart, same as Active Streams. -->
        <div class="chd-bitrate">
          <div class="field-lbl">Bitrate · live</div>
          <LivelineChart :series="bitrateSamples" :target="bitrateTarget" />
        </div>

        <!-- Blank spacer between the liveline graph and Technical Details. -->
        <div style="height: 15px" />

        <!-- Technical detail (labeled kv rows). ffprobe rows appear once the channel has been probed. -->
        <div class="chd-tech">
          <div class="field-lbl">Technical Details</div>
          <div class="kv-list">
            <template v-if="details">
              <div class="k">Video</div>
              <div class="v"><span class="mono" style="font-size: 11px;">{{ videoLine ?? '—' }}</span></div>
              <div class="k">Audio</div>
              <div class="v"><span class="mono" style="font-size: 11px;">{{ audioLine ?? '—' }}</span></div>
              <div class="k">Frame rate</div>
              <div class="v"><span class="mono" style="font-size: 11px;">{{ timingLine ?? '—' }}</span></div>
              <div class="k">Container</div>
              <div class="v"><span class="mono" style="font-size: 11px;">{{ details.container ?? '—' }}</span></div>
            </template>
            <div class="k">Stream URL</div>
            <div class="v">
              <span v-if="builtin" class="mono muted" style="font-size: 11px; word-break: break-all;">
                {{ ch.streamEntryUrl }}
              </span>
              <div v-else class="input mono" style="font-size: 11px; width: 100%;">
                <Icon name="link" :size="14" />
                <input v-model="streamUrl" placeholder="https://example.com/live/channel/index.m3u8" />
              </div>
            </div>
          </div>
        </div>

        <!-- Status chips: labels dropped, collected into a single row beneath Technical Details. Only
             Playable gains a descriptive word since its bare true/false isn't self-explanatory. -->
        <div class="chd-chip-row">
          <Pill :tone="statusChip.tone">
            <StatusDot :status="statusChip.dot" :pulse="statusChip.pulse" /> {{ statusChip.label }}
          </Pill>
          <Pill :tone="ch.epgState === 'matched' ? 'good' : 'warn'">
            {{ ch.epgState === 'matched' ? 'matched' : 'unmatched' }}
          </Pill>
          <Pill :tone="ch.stream.isPlayable ? 'good' : 'warn'">Playable {{ ch.stream.isPlayable }}</Pill>
          <Pill tone="cyan">{{ ch.stream.res ?? '—' }}</Pill>
          <Pill tone="cyan">{{ playlist?.source ?? ch.source }}</Pill>
        </div>

        <div class="divider" />

        <div class="form-row">
          <div class="field-lbl">Status</div>
          <div class="row" style="gap: 10px;">
            <Segmented :value="ch.status" @change="setStatus" :options="[
              { value: 'Active', label: 'Active', icon: 'check' },
              { value: 'Disabled', label: 'Disabled', icon: 'x' },
            ]" />
            <Pill :tone="ch.status === 'Active' ? 'active' : 'disabled'">
              {{ ch.status }}
            </Pill>
          </div>
        </div>

        <div class="form-row">
          <div class="field-lbl">Display name</div>
          <div class="input"><input v-model="displayName" /></div>
        </div>
        <div class="form-grid-3">
          <div class="form-row">
            <div class="field-lbl">Channel number</div>
            <div class="input"><input v-model="channelNo" placeholder="e.g. 101" /></div>
          </div>
          <div class="form-row">
            <div class="field-lbl">TVG-ID (EPG link)</div>
            <div class="input">
              <Icon name="link" :size="14" />
              <input v-model="tvgId" placeholder="e.g. bbc.one.uk" />
            </div>
          </div>
          <div class="form-row">
            <div class="field-lbl">Group</div>
            <div class="select">
              <select v-model="group">
                <option v-if="group && !GROUPS.includes(group)" :value="group">{{ group }}</option>
                <option v-for="g in GROUPS" :key="g" :value="g">{{ g }}</option>
              </select>
            </div>
          </div>
        </div>

        <div class="row" style="margin-top: 6px;">
          <Btn variant="ghost" icon="trash"><span style="color: var(--bad);">Remove</span></Btn>
          <span class="spacer" />
          <Btn variant="ghost" @click="emit('close')">Cancel</Btn>
          <Btn variant="primary" icon="check" @click="save">Save changes</Btn>
        </div>
      </div>
    </div>
  </div>
</template>
