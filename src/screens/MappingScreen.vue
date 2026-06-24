<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick, onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';
import Pill from '../components/Pill.vue';
import Stat from '../components/Stat.vue';
import ChannelLogo from '../components/ChannelLogo.vue';
import SearchInput from '../components/SearchInput.vue';
import Segmented from '../components/Segmented.vue';
import ProgressBar from '../components/ProgressBar.vue';
import {
  CHANNELS, PLAYLISTS, EPG_CHANNELS, EPG_SOURCES,
  reloadChannels, fetchEpgChannelsForSource, reloadEpgSources,
  type Channel, type EpgChannel,
} from '../data';
import { useVirtualList } from '../composables/useVirtualList';

// Refresh the stores this screen reads on every mount, so navigating to /mapping always reflects
// current Mongo state (e.g. an EPG source deleted elsewhere disappears here too) — the boot snapshot
// alone goes stale. EPG guide channels are NO LONGER loaded wholesale; they're fetched per-selected
// source (see the selectedEpgSource watch) so a large guide doesn't flood the screen. The immediate
// watch on CHANNELS below rebuilds `mappings` once the reload lands.
onMounted(() => {
  Promise.all([reloadChannels(), reloadEpgSources()]).catch((err) =>
    console.error('[mapping] refresh failed:', err));
  nextTick(() => { vL.measure(); vR.measure(); });
});

// The channel↔EPG link is the 2-factor pair (tvg_id = epgchannels.channelId, epg = epgchannels.source) —
// tracked here per channel id. Seeded from the persisted CHANNELS (only the 'matched' ones with both
// factors) and kept in sync as link/unlink/auto-match persist. Rebuilt whenever CHANNELS is (re)loaded.
const mappings = reactive<Record<string, { tvg_id: string; epg: string }>>({});
watch(CHANNELS, (list) => {
  for (const k of Object.keys(mappings)) delete mappings[k];
  list.forEach((c) => {
    if (c.epgState === 'matched' && c.tvg_id && c.epg) mappings[c.id] = { tvg_id: c.tvg_id, epg: c.epg };
  });
}, { immediate: true });

const selL = ref<string | null>(null);
const filter = ref<'all' | 'unmatched' | 'matched'>('unmatched');
// Left-list Active/Disabled status filter — mirrors PlaylistDetailScreen's `stateFilter`. Defaults to
// 'Active' so the M3U list opens showing only Active channels; filters on the top-level 'Active' |
// 'Disabled' governor (playlistchannels.status). Composes with selectedPlaylist + filter + leftSearch.
const stateFilter = ref<'Active' | 'Disabled'>('Active');
const selectedPlaylist = ref<string>('all');
// Default 'none' — the right list shows nothing until an EPG source is picked (see epgFiltered).
const selectedEpgSource = ref<string>('none');

// Per-column free-text search (left filters M3U channel names; right filters EPG name/id — see epgSorted,
// kept out of epgFiltered so auto-match/scoring/the count Pill stay on the full source set).
const leftSearch = ref<string>('');
const rightSearch = ref<string>('');

// Scroll containers for the A–Z jump bars (scroll-to-letter; see jumpTo/jumpLeft/jumpRight).
const leftListRef = ref<HTMLElement | null>(null);
const rightListRef = ref<HTMLElement | null>(null);
// The letter currently at the top of each scrolled list — highlighted cyan in its A–Z bar.
const activeLeftLetter = ref<string>('');
const activeRightLetter = ref<string>('');

// Sort state — one key + direction per column. Clicking the active key reverses direction.
const sortKey = ref<'name' | 'playlist'>('name');
const sortDir = ref<'asc' | 'desc'>('asc');
const epgSortKey = ref<'name' | 'id' | 'intelligent'>('name');
const epgSortDir = ref<'asc' | 'desc'>('asc');

function toggleSort(key: 'name' | 'playlist') {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  else { sortKey.value = key; sortDir.value = 'asc'; }
}
function toggleEpgSort(key: 'name' | 'id') {
  if (epgSortKey.value === key) epgSortDir.value = epgSortDir.value === 'asc' ? 'desc' : 'asc';
  else { epgSortKey.value = key; epgSortDir.value = 'asc'; }
}

// Toggle the right-hand EPG list into (or back out of) the composite match-score ranking (see matchScore
// below): rows are ordered highest-score-first against the selected M3U channel. This is selectable at ANY
// time — with no left channel selected the mode is still active but epgSorted falls back to name-asc and no
// per-row scores show, so picking a channel afterward immediately ranks the list without a re-click. Clicking
// while already in intelligent mode returns to the default Name (asc) sort. The Name/ID modes deselect
// automatically because they key off epgSortKey; per-row scores show only while this mode is active.
function intelligentSort() {
  if (epgSortKey.value === 'intelligent') { epgSortKey.value = 'name'; epgSortDir.value = 'asc'; }
  else epgSortKey.value = 'intelligent';
}

// Resolve a channel's owning playlist name from its `source` (a source playlist's id === channel.source);
// falls back to the raw source id if no playlist row is loaded yet.
const playlistNameById = computed(() => {
  const m: Record<string, string> = {};
  for (const p of PLAYLISTS.value) m[p.id] = p.name;
  return m;
});

// Resolve an EPG source's display name from its id (for the right-hand source filter + row context).
const epgSourceNameById = computed(() => {
  const m: Record<string, string> = {};
  for (const s of EPG_SOURCES.value) m[s.id] = s.name;
  return m;
});
function epgSourceName(id: string): string { return epgSourceNameById.value[id] || id; }

// The visible left-list set: narrowed by the Playlist dropdown (a source playlist's id === channel.source)
// AND the Unmatched/Matched/All segmented filter, then ordered by the Sort controls. Single source of
// truth for both the render and Auto-match (.filter() returns a fresh array, so .sort() is in-place safe).
const channelsView = computed(() => {
  const dir = sortDir.value === 'asc' ? 1 : -1;
  const q = leftSearch.value.trim().toLowerCase();
  return CHANNELS.value
    .filter((c) =>
      c.status === stateFilter.value &&
      (selectedPlaylist.value === 'all' || c.source === selectedPlaylist.value) &&
      (filter.value === 'all' || (filter.value === 'unmatched' ? !mappings[c.id] : !!mappings[c.id])) &&
      (q === '' || c.tvg_name.toLowerCase().includes(q)))
    .sort((a, b) => {
      if (sortKey.value === 'playlist') {
        const pa = playlistNameById.value[a.source] || a.source;
        const pb = playlistNameById.value[b.source] || b.source;
        return pa.localeCompare(pb) * dir || a.tvg_name.localeCompare(b.tvg_name);
      }
      return a.tvg_name.localeCompare(b.tvg_name) * dir;
    });
});

// The EPG source options for the right-hand filter — the real epgsources collection (EPG_SOURCES), so a
// deleted/added source is reflected immediately (not the distinct sources lingering in EPG_CHANNELS).
const epgSourceOptions = computed(() => EPG_SOURCES.value.map((s) => ({ id: s.id, name: s.name })));

// The right-list set: real epgchannels narrowed to the ONE selected source. 'none' (the default) shows
// nothing — only an explicitly picked source populates the list.
const epgFiltered = computed(() =>
  selectedEpgSource.value === 'none'
    ? []
    : EPG_CHANNELS.value.filter((e) => e.source === selectedEpgSource.value));

// The selected left (M3U) channel object (or null) — the reference the intelligent match scores rank against.
const selectedLeft = computed(() => CHANNELS.value.find((c) => c.id === selL.value) ?? null);
// Composite match scores (0–100) keyed by "<source>:<channelId>", computed ONLY in Intelligent Sorting
// mode with a left channel selected — so Name/ID modes and the no-selection state cost nothing. See matchScore.
const epgScores = computed(() => {
  const m = new Map<string, number>();
  const ch = selectedLeft.value;
  if (epgSortKey.value !== 'intelligent' || !ch) return m;
  // The variant set depends only on the selected left channel — build it once, reuse across the EPG list.
  const variants = m3uVariants(ch.tvg_name);
  const allTokens = new Set(variants.flatMap((v) => v.tokens));
  for (const e of epgFiltered.value) m.set(`${e.source}:${e.channelId}`, scoreVariants(variants, allTokens, ch, e));
  return m;
});
function scoreFor(e: EpgChannel): number { return epgScores.value.get(`${e.source}:${e.channelId}`) ?? 0; }

const epgSorted = computed(() => {
  const q = rightSearch.value.trim().toLowerCase();
  const list = epgFiltered.value.filter((e) =>
    q === '' || e.affiliateName.toLowerCase().includes(q) || e.channelId.toLowerCase().includes(q));
  // Intelligent: rank by composite match score (highest first), tie-break by name. With no left channel
  // selected there's nothing to score against, so fall back to name-asc until one is picked.
  if (epgSortKey.value === 'intelligent') {
    if (!selectedLeft.value) return list.sort((a, b) => a.affiliateName.localeCompare(b.affiliateName));
    return list.sort((a, b) => scoreFor(b) - scoreFor(a) || a.affiliateName.localeCompare(b.affiliateName));
  }
  const dir = epgSortDir.value === 'asc' ? 1 : -1;
  return list.sort((a, b) =>
    (epgSortKey.value === 'id'
      ? a.channelId.localeCompare(b.channelId)
      : a.affiliateName.localeCompare(b.affiliateName)) * dir);
});

// Load the picked EPG source's guide channels on demand (scoped `?source=` fetch) — replaces the old
// boot-wide load of every source's channels. EPG_CHANNELS then holds just this source's rows;
// epgFiltered/epgScores/epgSorted/auto-match all keep operating on the full in-memory set (one source
// is bounded), and only the DOM is windowed (see the virtual lists below). Reset scroll on a switch.
watch(selectedEpgSource, (id) => {
  fetchEpgChannelsForSource(id).catch((err) => console.error('[mapping] epg channels load failed:', err));
  if (rightListRef.value) rightListRef.value.scrollTop = 0;
}, { immediate: true });

// Fixed-height virtual lists — the DOM holds only the visible rows (+ overscan), so a huge source no
// longer materializes tens of thousands of nodes. ROW_H MUST match .map-item height in styles.css.
const ROW_H = 50;
const vL = useVirtualList(leftListRef, () => channelsView.value.length, ROW_H);
const vR = useVirtualList(rightListRef, () => epgSorted.value.length, ROW_H);
const lStart = vL.start, lEnd = vL.end, lPad = vL.padTop, lTotal = vL.totalHeight;
const rStart = vR.start, rEnd = vR.end, rPad = vR.padTop, rTotal = vR.totalHeight;

// Left-row selection is gated on the right list having rows to link to: with no EPG source picked (or a
// source with no channels) there is nothing to map, so selecting a left channel is quietly inert. Clear a
// stale selection if the right list empties (e.g. the Source dropdown is switched back to None).
const canSelectLeft = computed(() => epgSorted.value.length > 0);
watch(canSelectLeft, (ok) => { if (!ok) selL.value = null; });

// Persist a channel's EPG link via PUT /api/playlists/<source>/channels/<id>, then reflect it locally on the
// CHANNELS entry (mirrors ChannelDrawer.vue's putChannel). Returns whether it persisted.
async function putChannelLink(ch: Channel, patch: Record<string, unknown>): Promise<boolean> {
  if (!ch.source) return false;
  try {
    const res = await fetch(
      `/api/playlists/${encodeURIComponent(ch.source)}/channels/${encodeURIComponent(ch.id)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) },
    );
    if (res.ok) { Object.assign(ch, patch); return true; }
  } catch {
    // best-effort
  }
  return false;
}

// Link a channel to an EPG channel: persist the 2-factor pair + epgState:'matched', then track it locally.
async function link(ch: Channel, e: EpgChannel): Promise<void> {
  if (await putChannelLink(ch, { tvg_id: e.channelId, epg: e.source, epgState: 'matched' })) {
    mappings[ch.id] = { tvg_id: e.channelId, epg: e.source };
  }
}
// Click-to-link from the right list: link the currently selected left channel, then clear the selection.
async function linkSelected(e: EpgChannel): Promise<void> {
  const ch = CHANNELS.value.find((c) => c.id === selL.value);
  if (!ch) return;
  await link(ch, e);
  selL.value = null;
}
// Unlink: clear both factors + flip epgState to 'unmatched' (the channel WAS matched, so not back to null).
async function unlink(ch: Channel): Promise<void> {
  if (await putChannelLink(ch, { tvg_id: null, epg: null, epgState: 'unmatched' })) {
    delete mappings[ch.id];
  }
}

// MATCHED totals are scoped to BOTH the active status filter (Active/Disabled) AND the Playlist dropdown
// (a source playlist's id === channel.source; 'all' = no narrowing), so the header reflects the same set
// the M3U list shows: `total` = channels in scope; `matched` = those of them currently linked (a `mappings`
// entry). The progress bar reads the same scoped pair. The numerator color keys off stateFilter — green
// (var(--good)) for Active, amber (var(--warn)) for Disabled — matching the Active/Disabled Segmented
// control's seg-green/seg-amber tones; the denominator keeps the default theme.
function inMatchScope(c: Channel): boolean {
  return c.status === stateFilter.value &&
    (selectedPlaylist.value === 'all' || c.source === selectedPlaylist.value);
}
const matched = computed(() =>
  CHANNELS.value.filter((c) => inMatchScope(c) && !!mappings[c.id]).length);
const total = computed(() =>
  CHANNELS.value.filter((c) => inMatchScope(c)).length);
const matchedColor = computed(() => (stateFilter.value === 'Disabled' ? 'var(--warn)' : 'var(--good)'));

// --- A–Z jump bars ------------------------------------------------------------------------------------
// Scroll-to-letter index under each list: only letters actually present (in the current display order)
// are shown, and clicking one scrolls that list to the first row whose name starts with that letter.
// First A–Z letter of a name, uppercased; digits/symbols bucket into '#'.
function firstLetter(name: string): string {
  const c = (name || '').trim().charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
}
// Distinct present letters in render order, sorted A→Z with '#' last.
function letterSet(names: string[]): string[] {
  const set = new Set(names.map(firstLetter));
  return [...set].sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)));
}
const leftLetters = computed(() => letterSet(channelsView.value.map((c) => c.tvg_name)));
const rightLetters = computed(() => letterSet(epgSorted.value.map((e) => e.affiliateName)));

// Jump the list so the first row whose name starts with `letter` sits at the top. With the lists now
// virtualized (the DOM holds only visible rows) the old children[index]/bounding-rect math can't work —
// but the FULL sorted array is still in memory, so the index comes from a plain findIndex and the
// fixed row height turns the scroll into arithmetic (scrollTop = index * ROW_H, in useVirtualList).
function jumpLeft(letter: string): void {
  vL.scrollToIndex(channelsView.value.findIndex((c) => firstLetter(c.tvg_name) === letter));
  updateLeftActive();
}
function jumpRight(letter: string): void {
  vR.scrollToIndex(epgSorted.value.findIndex((e) => firstLetter(e.affiliateName) === letter));
  updateRightActive();
}

// The first letter of the row currently at the top of each list — derived arithmetically from the
// virtual list's top index (no DOM measurement). Drives the active A–Z highlight.
function updateLeftActive(): void {
  const names = channelsView.value;
  activeLeftLetter.value = names.length ? firstLetter(names[vL.topIndex()]?.tvg_name ?? '') : '';
}
function updateRightActive(): void {
  const names = epgSorted.value;
  activeRightLetter.value = names.length ? firstLetter(names[vR.topIndex()]?.affiliateName ?? '') : '';
}
// Keep the virtual window + active letter current as the user scrolls.
function onLeftScroll(): void { vL.measure(); updateLeftActive(); }
function onRightScroll(): void { vR.measure(); updateRightActive(); }
// Refresh window + active letter on initial render and whenever the visible list changes (filter/search/
// sort/source) — scroll events keep them current as the user scrolls; nextTick lets the new rows lay out.
watch(channelsView, () => nextTick(() => { vL.measure(); updateLeftActive(); }), { immediate: true });
watch(epgSorted, () => nextTick(() => { vR.measure(); updateRightActive(); }), { immediate: true });

// How many M3U channels currently link to this EPG channel — matched on the full 2-factor pair so the same
// channelId published by two EPG sources stays distinct. EPG channels may be linked by many M3U channels,
// so this is a count (shown per row), not a one-shot "used" flag.
function linkCount(e: EpgChannel): number {
  return Object.values(mappings).filter((v) => v.tvg_id === e.channelId && v.epg === e.source).length;
}

// --- Intelligent match scoring -------------------------------------------------------------------------
// A composite name-similarity score (0–100) ranking an EPG channel against a selected M3U channel:
// Sørensen–Dice bigram overlap (primary) + token Jaccard + normalized Levenshtein, plus call-sign and
// channel-number bonuses. To absorb messy provider naming, the SELECTED M3U name is standardized into a
// SET of normalized variants (m3uVariants) and the EPG candidate is scored against each, keeping the max —
// so the most-specific form wins and no real match is ever lost. The EPG side stays canonical (normEpg).
// See the design notes in the Channel Mapping plan; weights are tunable here.
const QUALITY_TAGS = new Set(['hd', 'fhd', 'uhd', 'sd', '4k', '8k', 'hevc', 'h265', 'h264', 'hq']);
const COUNTRY_TOKENS = new Set(['us', 'usa', 'uk', 'ca']); // token-based, NOT substring (protects "Music"/"Plus")
const GENERIC = new Set([...COUNTRY_TOKENS, 'tv', 'channel', 'network', 'the']); // a variant of ONLY these is non-identifying → discarded
const PAREN_RE = /\([^)]*\)/g; // remove "(...)" + inner text
const BRACKET_RE = /\[[^\]]*\]/g; // remove "[...]" + inner text

type NormForm = { str: string; tokens: string[] };

// EPG (Gracenote) names are clean — strip structural noise + quality tags, but KEEP every meaningful token
// (so "USA Network" / "TV Land" stay intact). No dash split, no country/TV drop on this side.
function normEpg(s: string): NormForm {
  const cleaned = (s || '').toLowerCase().replace(/&/g, ' and ').replace(PAREN_RE, ' ').replace(BRACKET_RE, ' ');
  const tokens = cleaned.split(/[^a-z0-9]+/).filter((t) => t && !QUALITY_TAGS.has(t));
  return { str: tokens.join(''), tokens };
}

// Standardize a messy M3U name into a SET of normalized variants. Each transform that could destroy a real
// match is offered BOTH ways (paren kept/removed, dash first-segment/full, country+TV kept/dropped); scoring
// takes the max, so the most-specific form wins and nothing is ever lost. Returns deduped, non-degenerate forms.
// Ordering is load-bearing: parens/brackets and the dash are handled at string level BEFORE the tokenizer
// (split on non-alphanumeric) strips the remaining special characters — otherwise the dash would be gone first.
function m3uVariants(s: string): NormForm[] {
  const base = (s || '').toLowerCase().replace(/&/g, ' and ');
  const structural = new Set([base, base.replace(PAREN_RE, ' ').replace(BRACKET_RE, ' ')]); // (...)/[...] kept + removed
  const out: NormForm[] = [];
  const seen = new Set<string>();
  for (const v of structural) {
    const dashForms = v.includes('-') ? [v, v.split('-')[0]] : [v]; // dash: full + first-index-only
    for (const d of dashForms) {
      const raw = d.split(/[^a-z0-9]+/).filter(Boolean); // tokenizer drops remaining special chars
      const kept = raw.filter((t) => !QUALITY_TAGS.has(t)); // always drop quality tags
      const dropped = kept.filter((t) => !COUNTRY_TOKENS.has(t) && t !== 'tv'); // country/TV "drop" variant
      for (const toks of [kept, dropped]) {
        if (!toks.length || toks.every((t) => GENERIC.has(t))) continue; // discard empty / generic-only
        const str = toks.join('');
        if (str.length < 2 || seen.has(str)) continue;
        seen.add(str);
        out.push({ str, tokens: toks });
      }
    }
  }
  return out;
}

// Sørensen–Dice coefficient over character bigrams (0–1) — order-tolerant, ideal for short names.
function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const ba = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); ba.set(g, (ba.get(g) || 0) + 1); }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const c = ba.get(g) || 0;
    if (c > 0) { overlap++; ba.set(g, c - 1); }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

// Jaccard overlap of word-token sets (0–1) — catches reordering / abbreviation that bigrams miss.
function jaccard(ta: string[], tb: string[]): number {
  if (!ta.length && !tb.length) return 1;
  const sa = new Set(ta), sb = new Set(tb);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0;
}

// Classic edit distance — small DP, only ever run on short collapsed names.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

// Score one EPG candidate against a precomputed M3U variant set: max base similarity across variants, then
// add the callsign / channel-number bonuses once. The callsign bonus tests the UNION of all variant tokens.
function scoreVariants(variants: NormForm[], allTokens: Set<string>, ch: Channel, e: EpgChannel): number {
  const E = normEpg(e.affiliateName);
  if (!E.str || !variants.length) return 0;
  let best = 0;
  for (const L of variants) {
    let base: number;
    if (L.str === E.str) {
      base = 1;
    } else {
      const lv = 1 - levenshtein(L.str, E.str) / Math.max(L.str.length, E.str.length);
      base = 0.55 * dice(L.str, E.str) + 0.30 * jaccard(L.tokens, E.tokens) + 0.15 * lv;
    }
    if (base > best) best = base;
  }
  // Bonus: the EPG call sign appears as a whole token in the M3U name.
  if (e.callSign) {
    const cs = e.callSign.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cs && allTokens.has(cs)) best += 0.12;
  }
  // Bonus: both sides carry the same channel number.
  if (ch.channelNo && e.channelNo && ch.channelNo === e.channelNo) best += 0.05;
  return Math.round(Math.min(1, best) * 100);
}

// Thin single-pair wrapper (builds the variant set, then scores). epgScores precomputes the set once per
// selection — see there — so this is only for one-off callers.
function matchScore(ch: Channel, e: EpgChannel): number {
  const variants = m3uVariants(ch.tvg_name);
  return scoreVariants(variants, new Set(variants.flatMap((v) => v.tokens)), ch, e);
}

// Auto-match progress modal state. `autoMatchOpen` shows the modal; `autoMatchTotal` is the number of EPG
// matches found to persist, `autoMatchDone` rises as each PUT resolves (so the bar reflects real persistence
// progress, not just dispatch). `autoMatchRunning` keeps the Close button out until the run settles.
const autoMatchOpen = ref(false);
const autoMatchRunning = ref(false);
const autoMatchTotal = ref(0);
const autoMatchDone = ref(0);
const autoMatchProgress = computed(() =>
  autoMatchTotal.value ? autoMatchDone.value / autoMatchTotal.value : 0);

// Best-effort name-based auto-match over the currently visible left rows, claiming from the currently
// filtered EPG source: for each still-unmatched channel, claim + persist the first EPG channel whose
// canonical name EXACTLY equals one of the M3U name's standardized variants. Exact-only (not substring) so
// auto-linking never mis-claims near-names like "ESPN" → "ESPN2". EPG channels may be shared across multiple
// M3U channels, so a match is NOT reserved exclusively; a failed PUT just drops the optimistic local entry.
// A modal opens for the duration showing a progress bar (found matches persisted / total found).
async function autoMatch(): Promise<void> {
  autoMatchOpen.value = true;
  autoMatchRunning.value = true;
  autoMatchDone.value = 0;
  autoMatchTotal.value = 0;
  // First pass: find all matches up front so the bar has a stable denominator.
  const hits: { c: Channel; hit: EpgChannel }[] = [];
  for (const c of channelsView.value) {
    if (mappings[c.id]) continue;
    const variants = m3uVariants(c.tvg_name).map((v) => v.str);
    if (!variants.length) continue;
    const hit = epgFiltered.value.find((e) => variants.includes(normEpg(e.affiliateName).str));
    if (hit) hits.push({ c, hit });
  }
  autoMatchTotal.value = hits.length;
  // Second pass: persist each match in parallel, advancing the bar as each PUT settles.
  const tasks = hits.map(({ c, hit }) => {
    mappings[c.id] = { tvg_id: hit.channelId, epg: hit.source }; // optimistic reserve
    return putChannelLink(c, { tvg_id: hit.channelId, epg: hit.source, epgState: 'matched' })
      .then((ok) => { if (!ok) delete mappings[c.id]; })
      .finally(() => { autoMatchDone.value += 1; });
  });
  await Promise.all(tasks);
  autoMatchRunning.value = false;
}
</script>

<template>
  <div class="col map-screen">
    <div class="card map-head">
      <div class="map-head-top">
        <Icon name="map" :size="20" />
        <div class="map-title" style="flex: 1;">Channel ↔ EPG mapping</div>
        <Stat label="Matched" :value="`${matched} / ${total}`">
          <span :style="{ color: matchedColor }">{{ matched }}</span> / {{ total }}
        </Stat>
        <div style="width: 180px; height: 6px; background: var(--bg-2); border-radius: 999px; overflow: hidden;">
          <div :style="{ width: (total ? matched / total * 100 : 0) + '%', height: '100%', background: 'var(--accent)', boxShadow: '0 0 12px var(--accent)' }" />
        </div>
        <Btn variant="primary" icon="refresh" :disabled="selectedEpgSource === 'none'"
             :title="selectedEpgSource === 'none' ? 'Pick an EPG Source to enable auto-match' : undefined"
             @click="autoMatch">Auto-match</Btn>
      </div>
      <div class="map-controls">
        <label class="map-field">
          <span>Playlist</span>
          <div class="select lg">
            <select v-model="selectedPlaylist">
              <option value="all">All</option>
              <option v-for="p in PLAYLISTS" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </div>
        </label>
        <label class="map-field">
          <span>EPG Source</span>
          <div class="select lg">
            <select v-model="selectedEpgSource">
              <option value="none">None</option>
              <option v-for="o in epgSourceOptions" :key="o.id" :value="o.id">{{ o.name }}</option>
            </select>
          </div>
        </label>
      </div>
    </div>

    <!-- Auto-match progress modal: a popup that opens for the duration of an Auto-match run and shows the
         live persistence progress (found matches saved / total found), reusing the global .modal* surface. -->
    <div v-if="autoMatchOpen" class="modal-bg" role="dialog" aria-modal="true" aria-labelledby="automatch-title"
         @click="!autoMatchRunning && (autoMatchOpen = false)">
      <div class="modal automatch-modal" @click.stop>
        <div class="modal-hd">
          <Icon name="refresh" :size="18" />
          <h2 id="automatch-title">Auto-matching channels</h2>
          <span class="spacer" />
          <Btn v-if="!autoMatchRunning" variant="ghost" size="sm" icon="x" @click="autoMatchOpen = false" />
        </div>
        <div class="modal-body">
          <ProgressBar :value="autoMatchRunning && autoMatchTotal === 0 ? null : autoMatchProgress" tone="good" />
          <div class="muted" style="font-size: var(--fs-sm);">
            <template v-if="autoMatchRunning && autoMatchTotal === 0">Scanning channels for name matches…</template>
            <template v-else-if="autoMatchRunning">Linking {{ autoMatchDone }} / {{ autoMatchTotal }} matched channels…</template>
            <template v-else-if="autoMatchTotal === 0">No new name matches were found in this view.</template>
            <template v-else>Linked {{ autoMatchDone }} / {{ autoMatchTotal }} matched channels.</template>
          </div>
        </div>
        <div class="modal-ft">
          <Btn variant="primary" icon="check" :disabled="autoMatchRunning" @click="autoMatchOpen = false">Done</Btn>
        </div>
      </div>
    </div>

    <div class="map-grid">
      <div class="map-col">
        <h3>
          <Icon name="playlist" :size="14" /> M3U Channels
          <span class="spacer" />
          <Segmented :value="stateFilter" @change="(v) => stateFilter = v as any" :options="[
            { value: 'Active', label: 'Active', icon: 'check', cls: 'seg-cyan' },
            { value: 'Disabled', label: 'Disabled', icon: 'x', cls: 'seg-amber' },
          ]" />
          <SearchInput :value="leftSearch" @change="leftSearch = $event" placeholder="Search channels" :width="180" />
        </h3>
        <div class="map-sort">
          <div class="segmented" style="padding: 2px;">
            <button :class="['seg-amber', filter === 'unmatched' ? 'active' : '']" @click="filter = 'unmatched'"
                    style="font-size: 10.5px; padding: 3px 8px;">Unmatched</button>
            <button :class="['seg-green', filter === 'matched' ? 'active' : '']" @click="filter = 'matched'"
                    style="font-size: 10.5px; padding: 3px 8px;">Matched</button>
            <button :class="['seg-cyan', filter === 'all' ? 'active' : '']" @click="filter = 'all'"
                    style="font-size: 10.5px; padding: 3px 8px;">All</button>
          </div>
          <span class="spacer" />
          <span class="muted" style="font-size: 10.5px;">Sort</span>
          <div class="segmented" style="padding: 2px;">
            <button :class="sortKey === 'name' ? 'active' : ''" @click="toggleSort('name')"
                    style="font-size: 10.5px; padding: 3px 8px;">
              Name <span v-if="sortKey === 'name'">{{ sortDir === 'asc' ? '↑' : '↓' }}</span>
            </button>
            <button :class="sortKey === 'playlist' ? 'active' : ''" @click="toggleSort('playlist')"
                    style="font-size: 10.5px; padding: 3px 8px;">
              Playlist <span v-if="sortKey === 'playlist'">{{ sortDir === 'asc' ? '↑' : '↓' }}</span>
            </button>
          </div>
        </div>
        <div class="map-list" ref="leftListRef" @scroll="onLeftScroll">
          <div :style="{ height: lTotal + 'px', position: 'relative' }">
            <div :style="{ transform: `translateY(${lPad}px)` }">
              <div v-for="c in channelsView.slice(lStart, lEnd)" :key="c.id"
                   :class="['map-item', { selected: selL === c.id, matched: !!mappings[c.id] }]"
                   @click="() => { if (canSelectLeft) selL = c.id; }">
                <ChannelLogo :ch="c" />
                <div class="nm">{{ c.tvg_name }}</div>
                <span class="pl" :title="playlistNameById[c.source] || c.source">{{ playlistNameById[c.source] || c.source }}</span>
                <template v-if="mappings[c.id]">
                  <span class="id">{{ mappings[c.id].tvg_id }}</span>
                  <Btn variant="ghost" size="sm" icon="x" @click.stop="unlink(c)" />
                  <Pill tone="good">matched</Pill>
                </template>
                <Pill v-else tone="warn">unmatched</Pill>
              </div>
            </div>
          </div>
          <div v-if="channelsView.length === 0" class="empty">
            <h3>All matched 🎉</h3>
            <p>Every channel in this view has an EPG ID assigned.</p>
          </div>
        </div>
        <div v-if="leftLetters.length" class="map-foot">
          <button v-for="L in leftLetters" :key="L" :class="{ active: L === activeLeftLetter }"
                  @click="jumpLeft(L)">{{ L }}</button>
        </div>
      </div>

      <div class="map-link" style="align-self: center;">
        <Icon name="chevron-r" :size="22" />
      </div>

      <div class="map-col">
        <h3>
          <Icon name="epg" :size="14" /> EPG Channels
          <span class="spacer" />
          <SearchInput :value="rightSearch" @change="rightSearch = $event" placeholder="Search EPG" :width="180" />
          <Pill>{{ epgFiltered.length }}</Pill>
        </h3>
        <div class="map-sort">
          <span class="muted" style="font-size: 10.5px;">Sort</span>
          <div class="segmented" style="padding: 2px;">
            <button :class="epgSortKey === 'name' ? 'active' : ''" @click="toggleEpgSort('name')"
                    style="font-size: 10.5px; padding: 3px 8px;">
              Name <span v-if="epgSortKey === 'name'">{{ epgSortDir === 'asc' ? '↑' : '↓' }}</span>
            </button>
            <button :class="epgSortKey === 'id' ? 'active' : ''" @click="toggleEpgSort('id')"
                    style="font-size: 10.5px; padding: 3px 8px;">
              ID <span v-if="epgSortKey === 'id'">{{ epgSortDir === 'asc' ? '↑' : '↓' }}</span>
            </button>
          </div>
          <span class="spacer" />
          <Btn size="sm" :variant="epgSortKey === 'intelligent' ? 'primary' : 'ghost'"
               :title="selL ? undefined : 'Select an M3U channel to rank matches by relevance'"
               @click="intelligentSort">✨ Intelligent Sorting</Btn>
        </div>
        <div class="map-list" ref="rightListRef" @scroll="onRightScroll">
          <div :style="{ height: rTotal + 'px', position: 'relative' }">
            <div :style="{ transform: `translateY(${rPad}px)` }">
              <div v-for="e in epgSorted.slice(rStart, rEnd)" :key="`${e.source}:${e.channelId}`"
                   class="map-item"
                   :title="e.callSign ? `Call sign: ${e.callSign}${e.channelNo ? ' · #' + e.channelNo : ''}` : undefined"
                   @click="() => { if (selL) linkSelected(e); }">
                <div class="nm">{{ e.affiliateName }}</div>
                <span class="pl" :title="epgSourceName(e.source)">{{ epgSourceName(e.source) }}</span>
                <span class="id">{{ e.channelId }}</span>
                <Pill v-if="epgSortKey === 'intelligent' && selL"
                      :tone="scoreFor(e) >= 80 ? 'good' : scoreFor(e) >= 50 ? 'warn' : undefined">{{ scoreFor(e) }}%</Pill>
                <Pill v-if="linkCount(e) > 0" tone="good"><Icon name="check" :size="10" />{{ linkCount(e) }} linked</Pill>
                <Pill v-else-if="selL" tone="cyan">click to link</Pill>
              </div>
            </div>
          </div>
          <div v-if="epgSorted.length === 0" class="empty">
            <h3>No EPG channels</h3>
            <p>Add or sync an EPG source to populate guide channels here.</p>
          </div>
        </div>
        <div v-if="rightLetters.length" class="map-foot">
          <button v-for="L in rightLetters" :key="L" :class="{ active: L === activeRightLetter }"
                  @click="jumpRight(L)">{{ L }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
