// Ultimate Player data layer — the launching playlist's channels plus the guide data the rail and the
// now/next strip render.
//
// This module deliberately does NOT import data.ts: the popup is its own Vite entry and must not drag the
// SPA's app-wide reactive stores and bootstrap fetches into its bundle. `Channel` / `Program` come in as
// TYPE-only imports (erased at build, no runtime edge), and the two fetches are written locally. Auth rides
// on the global Bearer interceptor installed by authFetch.ts.
//
// Both endpoints used here are the USER-SCOPED siblings (`/api/playlists/:id/...`), not the admin-only
// `/api/channels` + `/api/epg-programs`. That is what lets a standard user open the player for a playlist
// they have been granted, and the server re-checks the grant on every call.
//
// Programs are fetched in two lanes, because the two surfaces want opposite things:
//   - RAIL  — lean projection, a short window, but for MANY channels. Only the rows currently scrolled into
//             view, debounced and deduped (the pattern EPGDetailScreen.ensureProgramsLoaded uses), chunked
//             to the route's 500-id cap.
//   - STRIP — `?rich=1` (descriptions, episode/season, rating), a long window, but for exactly ONE channel:
//             the one being watched. Tiny payload, so the rich projection costs nothing here.
// They write to SEPARATE caches so a lean rail fetch can never clobber the rich data the strip is showing.

import { ref, computed, watch } from 'vue';
import type { Channel, Program } from '../data';

const HOUR_MS = 3_600_000;
const MAX_CHANNEL_IDS = 500; // mirrors server/src/epg/queryPrograms.ts MAX_CHANNEL_IDS
const RAIL_WINDOW = { back: 1 * HOUR_MS, fwd: 3 * HOUR_MS };
const STRIP_WINDOW = { back: 1 * HOUR_MS, fwd: 12 * HOUR_MS };
const RAIL_TTL_MS = 15 * 60_000; // re-fetch rail guide data this often so "now" doesn't drift off the end
const CLOCK_TICK_MS = 30_000;

// ---------------------------------------------------------------------------------------------------
// Hash params: player.html#pl=<playlistId>&ch=<channelId>
// ---------------------------------------------------------------------------------------------------

export interface UplParams { pl: string; ch: string }

export function parseHash(hash = window.location.hash): UplParams {
  // Tolerate a leading '#' and an optional leading '/', then parse as a query string.
  const q = new URLSearchParams(hash.replace(/^#\/?/, ''));
  return { pl: q.get('pl') ?? '', ch: q.get('ch') ?? '' };
}

// ---------------------------------------------------------------------------------------------------
// Clock — one shared ticking "now" so progress bars and now/next roll over without per-component timers.
// ---------------------------------------------------------------------------------------------------

export const now = ref(Date.now());
let clockTimer: number | undefined;

export function startClock(): void {
  if (clockTimer !== undefined) return;
  clockTimer = window.setInterval(() => { now.value = Date.now(); }, CLOCK_TICK_MS);
}
export function stopClock(): void {
  if (clockTimer !== undefined) window.clearInterval(clockTimer);
  clockTimer = undefined;
}

// ---------------------------------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------------------------------

export const channels = ref<Channel[]>([]);
export const channelsError = ref<string | null>(null);
export const loading = ref(true);

// The composite guide key — the 2-factor (tvg_id, epg) EPG link, exactly as the Dashboard builds it.
// Null when the channel has never been mapped to a guide channel; such rows render "No guide data".
export function epgKey(ch: Channel | null | undefined): string | null {
  if (!ch?.tvg_id || !ch.epg) return null;
  return `${ch.epg}:${ch.tvg_id}`;
}

export async function loadChannels(pl: string): Promise<void> {
  loading.value = true;
  channelsError.value = null;
  try {
    const res = await fetch(`/api/playlists/${encodeURIComponent(pl)}/channels`);
    if (!res.ok) {
      channelsError.value = res.status === 403
        ? 'You do not have access to this playlist.'
        : `Could not load channels (${res.status}).`;
      channels.value = [];
      return;
    }
    const all = (await res.json()) as Channel[];
    // Failover 'child' rows are hidden backups for their parent — never independently tunable, so they must
    // not appear in the rail. Disabled channels are dropped too: this is a viewing surface, not the editor.
    channels.value = all.filter((c) => c.failoverRole !== 'child' && c.status !== 'Disabled');
  } catch {
    channelsError.value = 'Could not reach the server.';
    channels.value = [];
  } finally {
    loading.value = false;
  }
}

// ---------------------------------------------------------------------------------------------------
// Guide lane 1 — the rail (lean, many channels, visible slice only)
// ---------------------------------------------------------------------------------------------------

export const railPrograms = ref<Record<string, Program[]>>({});
let railInflight = new Set<string>();   // signatures currently being fetched (dedupe)
let railFetchedAt = 0;
let railTimer: number | undefined;
let railPending = new Set<string>();

async function fetchRailChunk(pl: string, keys: string[]): Promise<void> {
  const sig = keys.join(',');
  if (railInflight.has(sig)) return;
  railInflight.add(sig);
  try {
    const from = Date.now() - RAIL_WINDOW.back;
    const to = Date.now() + RAIL_WINDOW.fwd;
    const res = await fetch(
      `/api/playlists/${encodeURIComponent(pl)}/programs`
      + `?channelIds=${encodeURIComponent(sig)}&from=${from}&to=${to}`,
    );
    if (!res.ok) return;
    const grouped = (await res.json()) as Record<string, Program[]>;
    // Record every requested key, including ones the server had nothing for — an empty array is a real
    // answer ("no guide data") and stops us asking again on every scroll.
    const next = { ...railPrograms.value };
    for (const k of keys) next[k] = grouped[k] ?? [];
    railPrograms.value = next;
  } catch {
    // Best effort — rows just show "No guide data".
  } finally {
    railInflight.delete(sig);
  }
}

// Ask for guide data for the given keys. Debounced (150ms) and deduped against what is already cached, so
// scrolling the rail coalesces into a few requests instead of one per row.
export function ensureRailPrograms(pl: string, keys: (string | null)[]): void {
  // Whole-cache TTL: past this the window we fetched has drifted, so start over rather than serve stale.
  if (railFetchedAt && Date.now() - railFetchedAt > RAIL_TTL_MS) {
    railPrograms.value = {};
    railFetchedAt = 0;
  }
  for (const k of keys) {
    if (k && !(k in railPrograms.value)) railPending.add(k);
  }
  if (railPending.size === 0) return;

  if (railTimer !== undefined) window.clearTimeout(railTimer);
  railTimer = window.setTimeout(() => {
    railTimer = undefined;
    const batch = [...railPending];
    railPending = new Set();
    if (batch.length === 0) return;
    railFetchedAt = railFetchedAt || Date.now();
    for (let i = 0; i < batch.length; i += MAX_CHANNEL_IDS) {
      void fetchRailChunk(pl, batch.slice(i, i + MAX_CHANNEL_IDS));
    }
  }, 150);
}

// ---------------------------------------------------------------------------------------------------
// Guide lane 2 — the strip (rich, one channel, long window)
// ---------------------------------------------------------------------------------------------------

export const stripPrograms = ref<Program[]>([]);
export const stripKey = ref<string | null>(null);

export async function loadStripPrograms(pl: string, key: string | null): Promise<void> {
  stripKey.value = key;
  if (!key) { stripPrograms.value = []; return; }
  try {
    const from = Date.now() - STRIP_WINDOW.back;
    const to = Date.now() + STRIP_WINDOW.fwd;
    const res = await fetch(
      `/api/playlists/${encodeURIComponent(pl)}/programs`
      + `?channelIds=${encodeURIComponent(key)}&from=${from}&to=${to}&rich=1`,
    );
    if (!res.ok) { stripPrograms.value = []; return; }
    const grouped = (await res.json()) as Record<string, Program[]>;
    // Guard against a slow response for a channel the viewer has already switched away from.
    if (stripKey.value !== key) return;
    stripPrograms.value = grouped[key] ?? [];
  } catch {
    if (stripKey.value === key) stripPrograms.value = [];
  }
}

// ---------------------------------------------------------------------------------------------------
// now / next selection
// ---------------------------------------------------------------------------------------------------

export interface NowNext { live: Program | null; upcoming: Program[] }

// Programs arrive sorted by start. "Live" is the one straddling `at`; "upcoming" is everything after it.
export function nowNext(list: Program[] | undefined, at: number, take = 5): NowNext {
  if (!list || list.length === 0) return { live: null, upcoming: [] };
  const live = list.find((p) => p.start <= at && p.end > at) ?? null;
  const upcoming = list.filter((p) => p.start > at).slice(0, take);
  return { live, upcoming };
}

// 0..1 elapsed fraction of a program at `at` — drives the progress bars.
export function progressOf(p: Program | null, at: number): number {
  if (!p || p.end <= p.start) return 0;
  return Math.min(1, Math.max(0, (at - p.start) / (p.end - p.start)));
}

// ---------------------------------------------------------------------------------------------------
// Formatting helpers (shared by the rail and the strip so both read identically)
// ---------------------------------------------------------------------------------------------------

export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtRemaining(p: Program | null, at: number): string {
  if (!p) return '';
  const mins = Math.max(0, Math.round((p.end - at) / 60_000));
  if (mins < 60) return `${mins} min left`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m left`;
}

// "S38 E12" / "S38" / "E12" / '' — Gracenote-only fields, absent elsewhere.
export function fmtEpisode(p: Program | null): string {
  if (!p) return '';
  const s = p.season ? `S${p.season}` : '';
  const e = p.episode ? `E${p.episode}` : '';
  return [s, e].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------------------------------
// Rail sort order — a per-device viewer preference, not an operator setting.
// ---------------------------------------------------------------------------------------------------
// Persisted exactly like the volume/mute choice (UplVideoJsPlayer's `upl:audio`): same `upl:` namespace, same
// defensive read, same silent fallback when storage is blocked. Deliberately NOT a Settings field — this
// bundle never fetches /api/settings, and importing useSettings would drag data.ts into the popup.
const SORT_PREF_KEY = 'upl:sort';
export type UplSortKey = 'name' | 'channelNo';

function loadSortPref(): UplSortKey {
  try {
    const raw = localStorage.getItem(SORT_PREF_KEY);
    if (raw === 'name' || raw === 'channelNo') return raw;
  } catch { /* private mode / storage blocked — fall through to the default */ }
  return 'name';
}

// Default is NAME, not number. Channel numbers are inherited verbatim from the upstream provider and are
// frequently meaningless in a clone playlist (issue #51: 600000 sitting next to 6065), whereas the name always
// means something. Most playlists carry no number at all, so for them this is the order the rail already had.
export const sortKey = ref<UplSortKey>(loadSortPref());

watch(sortKey, (k) => {
  try { localStorage.setItem(SORT_PREF_KEY, k); } catch { /* a lost preference is not worth throwing over */ }
});

// The rail's flat, ordered list. The API sorts by (group, tvg_name); a player wants ONE list in the viewer's
// chosen order, so the grouping is discarded here and the sort is redone client-side.
export const orderedChannels = computed<Channel[]>(() => {
  const byName = (a: Channel, b: Channel) => a.tvg_name.localeCompare(b.tvg_name);
  const rows = [...channels.value];
  if (sortKey.value === 'name') return rows.sort(byName);
  // channelNo is a user-editable nullable STRING ('101', '4.1', '12A', '', null). Compare numerically when
  // both sides parse, else lexically, with unnumbered channels LAST — the rule the Playlist detail table's
  // "Channel No" sort already uses (PlaylistDetailScreen.vue), plus the blank-is-unnumbered guard below.
  // parseFloat (not Number) is load-bearing: it reads the leading number, so a '12A' subchannel sorts next
  // to 12 rather than being exiled with the unparseable ones.
  //
  // The previous `Number(c.channelNo)` here sorted unnumbered channels FIRST, against the comment that sat
  // above it: Number(null) is 0, not NaN.
  return rows.sort((a, b) => {
    // Blank counts as unnumbered. ChannelDrawer normalizes '' back to null on save, but a sync or an import
    // can still seed an empty string, and '' would otherwise lexically outrank every real channel number.
    const an = a.channelNo?.trim() || null;
    const bn = b.channelNo?.trim() || null;
    if (an == null && bn == null) return byName(a, b);
    if (an == null) return 1;
    if (bn == null) return -1;
    const af = parseFloat(an), bf = parseFloat(bn);
    const bothNum = !Number.isNaN(af) && !Number.isNaN(bf);
    return (bothNum ? af - bf : an.localeCompare(bn)) || byName(a, b);
  });
});
