<script setup lang="ts">
// UplEpgStrip — the "what's on" panel docked directly under the picture: the programme now airing (with its
// elapsed bar, description and episode/rating detail) followed by a short list of what's next.
//
// Reads the RICH guide lane (useUplData.stripPrograms), which is fetched with ?rich=1 for the single channel
// being watched — that is where shortDesc / episodeTitle / season / episode / rating come from. Those fields
// are Gracenote-only, so every one of them is rendered conditionally; a source without them degrades to
// title + time and still looks deliberate.
import { computed } from 'vue';
import type { Program } from '../data';
import { now, nowNext, progressOf, fmtClock, fmtRemaining, fmtEpisode } from './useUplData';

const props = defineProps<{ programs: Program[]; hasEpgLink: boolean }>();

const nn = computed(() => nowNext(props.programs, now.value, 5));
const live = computed(() => nn.value.live);
const pct = computed(() => Math.round(progressOf(live.value, now.value) * 100));
</script>

<template>
  <div class="upl-strip">
    <!-- Unmapped channel: say why there's nothing rather than showing an empty shell. -->
    <div v-if="!hasEpgLink" class="upl-strip-empty mono">
      No guide data — this channel isn't linked to an EPG source.
    </div>
    <div v-else-if="!live && nn.upcoming.length === 0" class="upl-strip-empty mono">
      No guide data for this channel right now.
    </div>

    <template v-else>
      <div v-if="live" class="upl-strip-now">
        <div class="upl-strip-hd">
          <span class="upl-strip-tag mono">NOW</span>
          <span class="mono muted upl-strip-time">{{ fmtClock(live.start) }}–{{ fmtClock(live.end) }}</span>
          <span class="upl-strip-title">{{ live.title }}</span>
          <span v-if="live.episodeTitle" class="muted upl-strip-ep">“{{ live.episodeTitle }}”</span>
          <span v-if="fmtEpisode(live)" class="pill cyan">{{ fmtEpisode(live) }}</span>
          <span v-if="live.rating" class="pill">{{ live.rating }}</span>
          <span v-if="live.cat" class="pill">{{ live.cat }}</span>
        </div>
        <div class="upl-strip-bar" role="progressbar" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100">
          <div class="upl-strip-fill" :style="{ width: pct + '%' }" />
        </div>
        <div class="mono muted upl-strip-left">{{ fmtRemaining(live, now) }}</div>
        <p v-if="live.shortDesc" class="upl-strip-desc">{{ live.shortDesc }}</p>
      </div>

      <div v-if="nn.upcoming.length" class="upl-strip-next">
        <span class="upl-strip-tag mono">NEXT</span>
        <span v-for="p in nn.upcoming" :key="p.start" class="upl-strip-next-item">
          <span class="mono muted">{{ fmtClock(p.start) }}</span>
          <span>{{ p.title }}</span>
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Self-contained panel in a standalone window — no app shell to inherit from, so the layout lives here.
   Colours/typography all come from the global --mq-* tokens. */
.upl-strip {
  flex: 0 0 auto;
  padding: 10px 14px;
  border-top: 1px solid var(--hairline);
  background: var(--bg-1);
  max-height: 30vh;
  overflow-y: auto;
}
.upl-strip-empty { font-size: var(--fs-xs); color: var(--text-3); padding: 4px 0; }
.upl-strip-hd { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.upl-strip-tag {
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--accent-hi);
}
.upl-strip-time { font-size: var(--fs-xs); }
.upl-strip-title { font-weight: 600; font-size: var(--fs-base); }
.upl-strip-ep { font-size: var(--fs-sm); }
.upl-strip-bar {
  margin-top: 7px;
  height: 4px;
  border-radius: 3px;
  background: oklch(1 0 0 / 0.1);
  overflow: hidden;
}
.upl-strip-fill { height: 100%; background: var(--accent); border-radius: 3px; }
.upl-strip-left { font-size: var(--fs-xs); margin-top: 4px; }
.upl-strip-desc {
  margin: 6px 0 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
  max-width: 92ch;
}
.upl-strip-next {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid var(--hairline);
  font-size: var(--fs-sm);
}
.upl-strip-next-item { display: inline-flex; gap: 6px; align-items: baseline; }
</style>
