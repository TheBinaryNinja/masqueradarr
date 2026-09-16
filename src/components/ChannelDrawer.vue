<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import StatusDot from './StatusDot.vue';
import ChannelLogo from './ChannelLogo.vue';
import Segmented from './Segmented.vue';
import ChannelPlayer from './ChannelPlayer.vue';
import LivelineChart from './LivelineChart.vue';
import GroupPicker from './GroupPicker.vue';
import GroupManager from './GroupManager.vue';
import TagPicker from './TagPicker.vue';
import { useStreamStats } from '../composables/useStreamStats';
import { videoPlayer } from '../composables/useSettings';
import { openUltimatePlayer } from '../composables/uplLaunch';
import { ACTIVE_STREAMS, CHANNELS, PLAYLISTS, appPlayerProxyPath, deleteChannels, playerSelectable, tagNames, type Channel, type StreamProbe } from '../data';
import { bus } from '../composables/bus';

const props = defineProps<{ ch: Channel }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const playlist = computed(() => PLAYLISTS.value.find((p) => p.id === props.ch.source));
const builtin = computed(() => playlist.value?.builtin === true);

const displayName = ref(props.ch.tvg_name);
const channelNo = ref(props.ch.channelNo ?? '');
const group = ref(props.ch.group ?? '');
const tvgId = ref(props.ch.tvg_id ?? '');
const streamUrl = ref(props.ch.streamEntryUrl ?? '');
const player = ref(props.ch.playerPref ?? 0);
const tags = ref<string[]>([...(props.ch.tags ?? [])]);

const isFailoverChild = computed(() => props.ch.failoverRole === 'child');
const supportsPlayer = computed(() => playerSelectable(props.ch));

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
      const body = (await res.json().catch(() => null)) as { _cascadedChildren?: Channel[] } | null;
      const kids = body?._cascadedChildren;
      if (kids?.length) {
        const byId = new Map(kids.map((k) => [k.id, k]));
        CHANNELS.value = CHANNELS.value.map((c) => byId.get(c.id) ?? c);
        bus.emit('tvapp:failover-cascade', { source, children: kids });
      }
    }
  } catch {
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
  if (!isFailoverChild.value && (tvgId.value || null) !== (props.ch.tvg_id ?? null)) {
    patch.tvg_id = tvgId.value || null;
    patch.epg = null;
    patch.epgState = 'unmatched';
  }
  if (supportsPlayer.value && (player.value || null) !== (props.ch.playerPref ?? null)) {
    patch.playerPref = player.value || null;
  }
  const curTags = props.ch.tags ?? [];
  const sameTags = tags.value.length === curTags.length && tags.value.every((t) => curTags.includes(t));
  if (!sameTags) patch.tags = tags.value;
  if (Object.keys(patch).length) putChannel(patch);
  emit('close');
}

const confirmRemove = ref(false);
async function removeChannel() {
  const { source, id } = props.ch;
  if (!source) return;
  try {
    await deleteChannels(source, [id]);
    bus.emit('tvapp:channels-deleted', { source, ids: [id] });
    emit('close');
  } catch {
    confirmRemove.value = false;
  }
}

function onResolution(res: string) {
  if (res !== props.ch.stream.res) putChannel({ stream: { res } });
}

function launchUpl() {
  const { source, id } = props.ch;
  if (!source || !id) return;
  openUltimatePlayer(source, id);
}

const details = ref<StreamProbe | null>(props.ch.stream.probe ?? null);

const statusChip = computed(() => {
  switch (liveStream.value?.phase ?? props.ch.stream.status) {
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

const { subscribe, release, bitrateSeries } = useStreamStats();
const liveStream = computed(() => ACTIVE_STREAMS.value.find((s) => s.channelId === props.ch.id));
const bitrateSamples = computed(() => bitrateSeries(props.ch.id).filter(Number.isFinite));
const bitrateTarget = computed(() => liveStream.value?.bitrate || 1);

watch(
  () => props.ch.id,
  () => {
    details.value = props.ch.stream.probe ?? null;
    displayName.value = props.ch.tvg_name;
    channelNo.value = props.ch.channelNo ?? '';
    group.value = props.ch.group ?? '';
    tvgId.value = props.ch.tvg_id ?? '';
    streamUrl.value = props.ch.streamEntryUrl ?? '';
    player.value = props.ch.playerPref ?? 0;
    tags.value = [...(props.ch.tags ?? [])];
    confirmRemove.value = false;
  },
);

onMounted(() => {
  subscribe();
});
onBeforeUnmount(() => {
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
        <template v-if="videoPlayer === 'ultimate'">
          <div class="chd-upl">
            <Btn v-if="ch.streamEntryUrl" variant="cyan" icon="play" @click="launchUpl">
              Launch Ultimate Video Player
            </Btn>
            <template v-else>
              <Btn variant="cyan" icon="play" disabled>Launch Ultimate Video Player</Btn>
              <div class="mono muted chd-upl-hint">This channel has no stream url to play.</div>
            </template>
          </div>
        </template>

        <template v-else>
          <div class="player chd-player" v-if="ch.streamEntryUrl" style="overflow: hidden;">
            <ChannelPlayer :src="appPlayerProxyPath(ch)" @resolution="onResolution" />
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

          <div class="chd-bitrate">
            <div class="field-lbl">Bitrate · live</div>
            <LivelineChart :series="bitrateSamples" :target="bitrateTarget" />
          </div>
        </template>

        <div style="height: 15px" />

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
          <Pill v-if="ch.failoverRole === 'parent'" tone="parent" title="Failover group parent">parent</Pill>
          <Pill v-else-if="ch.failoverRole === 'child'" tone="child" title="Failover backup — hidden from exports, EPG inherited from the parent">child</Pill>
          <Pill v-for="n in tagNames(ch.tags)" :key="n" tone="magenta">{{ n }}</Pill>
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
            <div class="field-lbl">TVG-ID (EPG link){{ isFailoverChild ? ' · inherited' : '' }}</div>
            <div class="input">
              <Icon name="link" :size="14" />
              <input v-model="tvgId" :disabled="isFailoverChild"
                     :title="isFailoverChild ? 'Inherited from the failover group parent — edit the parent instead' : undefined"
                     placeholder="e.g. bbc.one.uk" />
            </div>
            <div v-if="isFailoverChild" class="muted" style="font-size: var(--fs-xs); margin-top: 4px;">
              Inherited from the group parent — edit the parent's EPG link instead.
            </div>
          </div>
          <div class="form-row">
            <div class="field-lbl">Group</div>
            <GroupPicker v-model="group" :playlist-id="ch.source" allow-create />
          </div>
        </div>

        <div class="form-row">
          <div class="field-lbl">Tags</div>
          <TagPicker v-model="tags" />
        </div>

        <div v-if="supportsPlayer" class="form-row">
          <div class="field-lbl">Player source</div>
          <div class="select fill">
            <select v-model.number="player">
              <option :value="0">Auto — use the default, fall back if it’s down</option>
              <option :value="1">Player 1</option>
              <option :value="2">Player 2</option>
              <option :value="3">Player 3</option>
              <option :value="4">Player 4</option>
              <option :value="5">Player 5</option>
              <option :value="6">Player 6</option>
            </select>
          </div>
          <div class="muted" style="font-size: var(--fs-xs); margin-top: 6px;">
            Which DaddyLive player to prefer for this channel. Each player is an independent provider, so
            they don’t all carry every channel — whichever one you pick, the rest are tried if it fails, and
            the winner is remembered. “Auto” follows the source default (Settings → Playlist Domain / Configuration, <code class="mono">defaultPlayer</code>).
            <template v-if="liveStream?.failover">
              <br /><span style="color: var(--text-1);">Now streaming via {{ liveStream.failover.candidateName }}.</span>
            </template>
          </div>
        </div>

        <div class="divider" />

        <GroupManager :playlist-id="ch.source" />

        <div class="row" style="margin-top: 6px;">
          <template v-if="confirmRemove">
            <Icon name="warn" :size="15" style="color: var(--bad);" />
            <span style="font-size: var(--fs-sm); font-weight: 600;">Delete this channel?</span>
            <span class="spacer" />
            <Btn variant="ghost" size="sm" @click="confirmRemove = false">Cancel</Btn>
            <button class="btn ghost danger" @click="removeChannel">
              <Icon name="trash" :size="14" />Delete
            </button>
          </template>
          <template v-else>
            <Btn variant="ghost" icon="trash" @click="confirmRemove = true"><span style="color: var(--bad);">Remove</span></Btn>
            <span class="spacer" />
            <Btn variant="ghost" @click="emit('close')">Cancel</Btn>
            <Btn variant="primary" icon="check" @click="save">Save changes</Btn>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
