// Reactive store for Masqueradarr.
//
// Top-level data (PLAYLISTS, CHANNELS, ACTIVE_STREAMS, etc.) is fetched from
// the API at app startup via bootstrapData(). Consumers in <script setup>
// read them as Vue refs (e.g. CHANNELS.value) or via the reactive
// EPG_PROGRAMS map.
//
// Static UI constants (GROUPS, EPG_HOURS) and pure client-side helpers
// live here too — they're not mock data, they're config the SPA owns.

import { ref, reactive, computed, type Ref } from 'vue';
import { summarizeFrequency } from './composables/useSchedule';

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export interface Playlist {
  id: string; name: string; url: string; channels: number; groups: number;
  lastSync: string; status: string; auto: boolean; interval: string; builtin?: boolean;
  // Persisted operator state: `state` = Active/Inactive, `endpoint` = where it's hosted, `url` = the
  // hosted URL ("HOSTED AT"). Edited via PUT /api/playlists/:id; `url` re-derives on a domain change.
  state?: boolean;
  // Lowercase canonical value (the repo-wide source-type normalization): 'global' | 'custom'.
  endpoint?: 'global' | 'custom';
  // Set for the established (Default) source playlists (dulo/common/dlhd); drives live sync. For a
  // user-composed playlist this is a lowercase TYPE TAG: 'clone' | 'file' | 'url' | 'hdhomerun' | 'local'
  // (legacy 'import' still appears on pre-split rows).
  source?: string | null;
  // Auth: `authentication` = this playlist requires sign-in to stream (stored, source-intrinsic);
  // `isAuthenticated` = currently signed in (stored mirror of the owning playlistauths.status==='active').
  authentication?: boolean;
  isAuthenticated?: boolean;
  // Remote-URL import source — set ONLY for a remote-URL m3u import playlist (source:'url'); null/absent for
  // every other playlist. The upstream .m3u/.m3u8 URL the import fetched, persisted so a manual or scheduled
  // Sync re-fetches + reconciles this playlist's channels from it. (Distinct from `url`, the hosted URL.)
  remoteUrl?: string | null;
  // Organizational pin — when true the playlist renders in the Playlists screen's PINNED section (above the
  // source-type groups). `pinOrder` is the drag-to-reorder ordinal WITHIN that section. Toggled via PUT
  // /api/playlists/:id { pinned }; ordering persisted via PUT /api/playlists/reorder (reorderPlaylistPins).
  // Optional: legacy rows pre-date the fields (absent ⇒ not pinned; pinOrder absent ⇒ sorts as 0).
  pinned?: boolean;
  pinOrder?: number;
  // Manual list position WITHIN this playlist's source-type category (Playlists screen, A-Z toggle OFF).
  // Optional BY DESIGN: an unset `order` sorts LAST, so a newly created playlist lands at the bottom of its
  // category. Set via PUT /api/playlists/reorder { field:'order' } (reorderPlaylistCategory); never by a sync.
  order?: number;
  // Operator-assigned custom tag ids (opaque Tag.id references; resolve to names via tagNames()). Set via
  // PUT /api/playlists/:id { tags }. Absent on legacy rows (treat undefined as none).
  tags?: string[];
  // When true, this playlist's `tags` are cascaded (additively) onto every one of its channels — pushed now
  // and re-pushed whenever the tags change. Set via PUT /api/playlists/:id { applyTagsToChannels }.
  applyTagsToChannels?: boolean;
}
export interface EpgSource {
  id: string; name: string; url: string; channels: number; programs: number;
  lastSync: string; status: string; auto: boolean; interval: string; builtin?: boolean;
  // true ⇒ this EPG source was created by a playlist's sync automation (the tubi/dlhd self-EPG rows). Bound
  // rows show a "Playlist-bound" chip and hide their manual sync + schedule controls. Optional: legacy rows
  // and user-added sources are absent/false.
  playlistBinding?: boolean;
  // User-defined list position (the EPG Sources screen's drag-to-reorder ordinal). The list is served sorted
  // by it; reorderEpgSources() persists a new sequence. Optional: legacy/mock rows pre-date the field.
  order?: number;
  // Lifetime sync outcome counters (maintained server-side by syncEpgSource). Optional: legacy/mock rows
  // that pre-date the fields return undefined — treat as 0 in the UI.
  syncSuccessCount?: number;
  syncFailCount?: number;
  // EPG-XML generation run stats (persisted on the row; the XMLTV generation job is deferred, so these stay
  // at their defaults for now). Optional: legacy/mock rows pre-date the fields.
  lastXmlAt?: string | null;
  xmlGeneratedCount?: number;
  xmlFailCount?: number;
  // Gracenote provenance (present on sources added via the Gracenote tab; null/absent otherwise).
  source?: string | null;
  location?: string | null;
  lineup_Type?: string | null;
  postalCode?: string | null;
  aid?: string | null;
  headendId?: string | null;
  lineupId?: string | null;
  country?: string | null;
  device?: string | null;
  timezone?: string | null;
  languagecode?: string | null;
  // Operator-assigned custom tag ids (opaque Tag.id references; resolve to names via tagNames()). Set via
  // PUT /api/epg-sources/:id { tags }. Absent on legacy rows (treat undefined as none).
  tags?: string[];
}
// Decode-metadata shape (the deep technical-detail slot). Channel.stream.probe is filled by the channel probe
// from manifest-declared decode metadata (null until first probed); ActiveStream.probe stays null — a passthrough
// proxy can't measure the deep per-session metrics (dropped frames / latency) this slot was built to carry.
export interface StreamProbe {
  video: {
    codec: string | null; profile: string | null; pixFmt: string | null;
    width: number | null; height: number | null; resolution: string | null;
    bitrate: number | null; fps: number | null; tbr: number | null; tbn: number | null;
  };
  audio: {
    codec: string | null; sampleRate: number | null; channels: number | null;
    channelLayout: string | null; format: string | null; bitrate: number | null;
  };
  container: string | null;
}
// 1:1 with the editable PlaylistChannel store (server/src/models/PlaylistChannel.ts) — read verbatim from
// GET /api/playlists/:id/channels (no projection). `status` is the enable/disable governor ('Active' |
// 'Disabled', m3u inclusion). Volatile per-channel detail lives in `stream`: realtime phase, playability,
// resolution, the initials logo fallback, and the technical-detail snapshot. Fields with no source
// equivalent are explicit null.
export interface Channel {
  id: string;
  tvg_name: string;
  group: string | null;
  channel: number | null; // legacy numeric channel number — kept in the model but unused for display
  channelNo: string | null; // displayed channel number (user-editable); shown everywhere with a '—' fallback
  tvg_id: string | null; // EPG link factor 1: bare upstream channel id (= epgchannels.channelId)
  epg: string | null; // EPG link factor 2: owning EPG source id (= epgchannels.source) — link only, NOT a display flag
  epgState: 'matched' | 'unmatched' | null; // EPG match status — the visual/programmatic "already matched?" indicator
  //                                            (distinct from `epg`, the source-id link factor); null at seed

  status: string; // governor: 'Active' | 'Disabled'
  source: string;
  origin?: string | null; // clone-copy provider source (e.g. 'dulo'); a clone's `source` is its own id, so
  //                          appPlayerProxyPath()/the stream URL key on (origin ?? source). null for source channels.
  logoColor: string;
  logoUrl: string | null;
  streamEntryUrl: string; // always present — appPlayerProxyPath keys on it
  failoverGroupId?: string | null; // failover group key; null/undefined = ungrouped (older docs lack the fields)
  failoverRole?: 'parent' | 'child' | null; // 'child' rows are export-hidden backups; EPG is inherited from the parent
  failoverOrder?: number | null; // child ordinal within the group
  origTvgId?: string | null; // pre-failover snapshot of this channel's own tvg_id (server-managed; SPA never writes it)
  playerPref?: number | null; // preferred upstream player (1-based) for playerSelectable sources (dlhd); null = inherit source default
  tags?: string[]; // operator-assigned custom tag ids (Tag.id refs; resolve via tagNames()). Set via PUT /api/playlists/:id/channels/:id
  stream: {
    initials: string | null;
    isPlayable: boolean;
    res: string | null;
    status: 'live' | 'establishing' | 'buffer' | 'failed' | null; // realtime phase
    probe?: StreamProbe | null; // technical-detail snapshot from the channel probe (latest); null until first probed
  };
}
// start/end are epoch ms for ALL programs (Gracenote/EPG-PW synced AND the mock seed — uniform shape; EPG
// screens convert to hours-of-day for timeline positioning). The extended fields are present on Gracenote
// programs, null/absent otherwise. See schemas.md §3.5.
export interface Program {
  start: number; end: number; title: string; cat: string;
  offset?: string | null; // UTC offset ('±HHMM') stamped at sync time (settings.offset); for localized timeline display
  callSign?: string | null;
  channelNo?: string | null;
  shortDesc?: string | null;
  rating?: string | null;
  seriesId?: string | null;
  season?: string | null;
  episode?: string | null;
  episodeTitle?: string | null;
}
// 1:1 with the live in-memory Active Streams snapshot (server stats/statsHub.ts → DisplayStream), served by
// GET /api/active-streams and pushed over the /api/stream-stats WebSocket. One row per channel with ≥1
// active viewer. Real-metrics-only: viewers/bandwidth/bitrate are measured off the proxy byte stream and
// quality (codec/audio/container/resolution/fps) is MANIFEST-DECLARED (parsed from #EXT-X-STREAM-INF by the
// Rust data plane, humanized server-side; null for a media-playlist-only upstream). The deep `probe`
// snapshot is not rebuilt (always null) — a passthrough proxy still can't measure dropped frames or latency.
// Which player produced a session: the in-app slide-out HLS player (appPlayer) or a third-party IPTV client
// app — TiviMate/Kodi/VLC/… (externalPlayer, served from the proxy's external mount as HLS or raw-TS).
export type PlayerType = 'appPlayer' | 'externalPlayer';
export interface ActiveStream {
  id: string; // = channelId (stable row id)
  channelId: string;
  source: string;
  phase: 'live' | 'establishing' | 'buffer' | 'failed';
  status: 'good' | 'warn' | 'bad';
  uptime: string; uptimeMin: number;
  viewers: number; peakViewers: number;
  watchers: string[]; // distinct usernames watching (anonymous viewers omitted; never the token)
  viewersByPlayer: { appPlayer: number; externalPlayer: number }; // viewer split: in-app player vs external IPTV clients
  // The wire format actually being served now — distinct from `container` (the upstream segments' decode format,
  // MPEG-TS either way) and from the requested proxy outputFormat: 'hls' = segmented HLS (incl. a Raw-TS request
  // that fell back for an AES/fMP4 upstream), 'ts' = one continuous raw MPEG-TS socket, 'mixed' = both at once.
  delivery: 'hls' | 'ts' | 'mixed';
  bitrate: number; // Mbps — per-viewer stream bitrate
  bandwidth: number; // Mbps — total egress across viewers
  bytesTotal: number;
  codec: string | null; audio: string | null; container: string | null;
  resolution: string | null; fps: number | null;
  probe: StreamProbe | null;
  // S3/ORIGIN Side-1 (ingest) health — non-null only for an origin-backed channel. The counterpart to
  // `delivery` (Side-2). `ingestedBytes` is UPSTREAM traffic for the ONE shared ingest and is deliberately
  // not comparable to `bandwidth` (egress across all viewers): with N viewers, egress ≈ N × ingest, and that
  // divergence is the signal that the ring is doing its job.
  ingest: {
    status: string; subscribers: number;
    ringSegments: number; ringBytes: number;
    headSeq: number; generation: number;
    ingestedSegments: number; ingestedBytes: number; evictedSegments: number;
    // S3/UND: non-null once an upstream has been retired for a structural fault the byte counters cannot see.
    suspect?: string | null; suspectRetires?: number;
    targetDuration: number; at: number;
  } | null;
  // Failover attribution: non-null while a failover CHILD is serving under this (parent) channel's identity.
  failover: { attempt: number; candidateId: string; candidateName: string } | null;
  // S3/CUE Side-1 ad-break state — non-null only once the data plane has DETECTED a break on this channel,
  // so it stays null for every source that emits no cue tags and declares no ad-URI signature.
  // `profileChanged` is the one that matters: it says the decoder had to reconfigure across the splice,
  // which is why the break cannot simply be smoothed over.
  adBreak: {
    inBreak: boolean; signal: string; breakId: number;
    segments: number; durationSec: number; announcedSec: number;
    profileChanged: boolean; breaksSeen: number; totalBreakSec: number; at: number;
  } | null;
}
// One connected viewer of an active stream (GET /api/active-streams/:channelId/clients).
export interface StreamClient {
  ip: string; userAgent: string;
  username: string | null; // the watching user account resolved from the stream token (never the token)
  playerType: PlayerType; // in-app slide-out player vs a third-party IPTV client (drives the "Player" pill)
  connectedAt: number; lastSeen: number;
  bytes: number; currentRate: number; // bytes total, bytes/sec over the last tick
  segments: number;
  location?: string | null; // geo resolved from `ip` server-side ("City, Region, US" / "Local"); null/absent = geo off
  countryCode?: string | null; // ISO-3166-1 alpha-2 for the flag emoji
}
// 1:1 with the per-source epgchannels store (server/src/models/EpgChannel.ts) — read verbatim from
// GET /api/epg-channels ({ _id: 0 }). These are the guide's channels (the right-hand "EPG channel IDs" in
// the mapping screen). `channelId` + `source` are the 2-factor EPG link target (= a channel's tvg_id + epg).
export interface EpgChannel {
  callSign: string | null;
  affiliateName: string;
  channelId: string;
  channelNo: string | null;
  source: string;
}
export interface CustomPlaylist { id: string; name: string; slug: string; channels: number; updated: string }
// One buffering interval within a watch session (epoch-ms start + interval duration). `side` is which edge it
// was observed on: 'upstream' (phase-derived) vs 'client' (this viewer's download rate fell below bitrate);
// OPTIONAL — rows written before the two-sided split omit it and are treated as 'upstream'.
export interface ViewBufferEvent { at: number; phase: 'buffer' | 'failed'; ms: number; side?: 'upstream' | 'client' }
// 1:1 with the viewsessions store (server/src/models/ViewSession.ts) — a completed per-viewer watch session
// written when a client goes stale. Read from GET /api/view-sessions (newest first). Feeds the History /
// Metrics screen (session table, buffer histogram, problem channels, QoE). avgBitrate is kbps.
export interface ViewSession {
  channelId: string; source: string;
  ip: string; userAgent: string;
  username: string | null;
  playerType?: PlayerType; // in-app vs external IPTV client; absent on rows written before the external engine
  startedAt: number; endedAt: number | null; durationMs: number;
  bytesTotal: number; avgBitrate: number; // kbps
  location?: string | null; // geo resolved from `ip` at write time ("City, Region, US" / "Local"); null/absent for older rows
  countryCode?: string | null; // ISO-3166-1 alpha-2 for the flag emoji
  resolution: string | null; codec: string | null;
  bufferCount: number; rebufferMs: number;
  bufferEvents: ViewBufferEvent[];
  qoeScore: number; health: 'good' | 'warn' | 'bad';
}
// 1:1 with GET /api/view-sessions/user-metrics — a per-user rollup aggregated server-side across the
// FULL viewsessions history (not just the live 500-row cap). `username` is 'unknown' for sessions with
// no resolved account. avgQoe is 0–100; durations are ms; bytes are raw. Never includes the stream token.
export interface UserMetric {
  username: string;
  totalSessions: number;
  totalDurationMs: number;
  totalBytes: number;
  avgQoe: number;
  goodSessions: number;
  warnSessions: number;
  badSessions: number;
}
// 1:1 with the logs collection (server/src/models/Log.ts) — one application log event. Read from
// GET /api/logs (newest-first) and tailed live over /api/logs-stream (useLogStream.ts). `ts` is epoch-ms;
// `category` is one of LOG_CATEGORIES; `level` is the persisted info/warn/error (the logger's `ok` collapses
// to `info` server-side). The server's createdAt TTL anchor is never sent to the SPA.
export interface Log {
  ts: number;
  category: string;
  level: 'info' | 'warn' | 'error';
  tag: string;
  message: string;
  meta?: Record<string, unknown> | null;
}
// The Add Playlist "Built-In" summary surfaced on each manifest entry — inherent, declarative properties of
// a built-in source (mirrors server BuiltinPlaylistMeta). Rendered by the Add Playlist modal's Built-In
// option BEFORE the source is provisioned. `playlistBoundEpg` is the only field that varies across the
// current built-ins (true ⇒ a playlist sync also refreshes the source's own guide; false ⇒ user must match).
export interface BuiltinPlaylistMeta {
  globalPlaylist: boolean;
  clonePlaylist: boolean;
  syncSchedules: boolean;
  playlistBoundEpg: boolean;
  epgSyncSchedules: boolean;
}
// One entry from the source manifest (GET /api/sources) — the registry-driven discovery contract.
// The global channel list is built by iterating this and fetching each source's projected channels.
export interface SourceManifestEntry {
  id: string;
  label: string;
  grouping: { by: string; groupOrder: string; channelOrder: string };
  sourceUrl: string;
  proxyPrefix: string;
  statusUrl: string | null;
  // This source exposes several interchangeable upstream "players" per channel (DaddyLive), so the player
  // picker is rendered for its channels. Read it instead of hardcoding source ids — see playerSelectable().
  playerSelectable?: boolean;
  // The Add Playlist "Built-In" summary (server fills DEFAULT_BUILTIN_META when an adapter omits it).
  builtinMeta: BuiltinPlaylistMeta;
}

/**
 * Does this channel's real provider expose selectable players? Route on the PROXY source (`origin ?? source`)
 * — the same key the stream URL is built from — so a clone copy is judged by its real provider, and read the
 * capability off the source manifest so a future player-selectable adapter lights the picker up for free.
 */
export function playerSelectable(ch: Pick<Channel, 'source' | 'origin'>): boolean {
  const id = ch.origin ?? ch.source;
  return SOURCES.value.some((s) => s.id === id && s.playerSelectable === true);
}
// Structured frequency-builder state (mirrors server CronFrequency) — lets the Edit drawer re-render the
// builder without reverse-parsing the cron string. `mode` selects which other fields apply.
export interface CronFrequency {
  mode: 'minutes' | 'hourly' | 'daily' | 'weekly' | 'custom';
  every: number | null;
  atHour: number | null;
  atMinute: number | null;
  daysOfWeek: number[] | null;
}
// 1:1 with the persisted Cronjob doc (server/src/models/Cronjob.ts), read from GET /api/cronjobs (the
// composite _id is projected out — match by targetType + targetId). The scheduler executes these.
export interface CronJob {
  targetType: string;
  targetId: string;
  cron: string;
  frequency: CronFrequency;
  timezone: string | null;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
// 1:1 with the live system-performance frame (server stats/systemStatsHub.ts → SystemStats) — ephemeral,
// NOT a persisted collection. Read on demand via GET /api/system-stats and pushed every ~2.5s over the
// /api/system-stats WebSocket (useSystemStats.ts). Drives the Dashboard "System Performance" banner.
// `scope` reports where CPU/Memory were measured: cgroup ('container') vs Node os.* ('host'). diskIo/network
// are null when /proc is unavailable (non-Linux dev); mongo connection fields are null when serverStatus is
// unprivileged/unavailable. CPU usagePct is null until the second tick (needs a delta).
export interface SystemStats {
  ts: number;
  scope: 'cgroup-v2' | 'cgroup-v1' | 'host';
  cpu: { usagePct: number | null; cores: number; loadAvg: [number, number, number] };
  memory: { totalBytes: number; usedBytes: number; usedPct: number; rssBytes: number };
  // S3/ORIGIN segment rings, process-wide — the Rust sidecar's RAM, which memory.rssBytes (the Node process)
  // does not see. null = the sidecar never reported or went silent (origin disabled, or no sidecar).
  ring: {
    bytes: number;
    capBytes: number;
    origins: number;
    subscribed: number;
    pressurePct: number;
  } | null;
  diskIo: { readMbPerSec: number; writeMbPerSec: number } | null;
  network: { rxMbitPerSec: number; txMbitPerSec: number } | null;
  mongo: {
    readyState: number;
    connections: { current: number | null; available: number | null; active: number | null; totalCreated: number | null };
    // Live MongoDB health (Atlas-style rates from consecutive serverStatus reads); null when disconnected /
    // serverStatus unavailable / before the second sample. Mirrors server SystemStats['mongo']['health'].
    health: {
      opsPerSec: number | null;
      avgLatencyMs: number | null;
      queryTargeting: number | null;
      queueDepth: number | null;
      scanAndOrderPerSec: number | null;
    } | null;
  };
}

// ──────────────────────────────────────────────────────────────────────
// Reactive stores — populated by bootstrapData()
// ──────────────────────────────────────────────────────────────────────

export const PLAYLISTS: Ref<Playlist[]> = ref([]);
export const EPG_SOURCES: Ref<EpgSource[]> = ref([]);
export const SOURCES: Ref<SourceManifestEntry[]> = ref([]);
export const CHANNELS: Ref<Channel[]> = ref([]);
export const EPG_CHANNELS: Ref<EpgChannel[]> = ref([]);
export const ACTIVE_STREAMS: Ref<ActiveStream[]> = ref([]);
export const CUSTOM_PLAYLISTS: Ref<CustomPlaylist[]> = ref([]);
export const VIEW_SESSIONS: Ref<ViewSession[]> = ref([]);
export const USER_METRICS: Ref<UserMetric[]> = ref([]);
export const LOGS: Ref<Log[]> = ref([]);
export const CRON_JOBS: Ref<CronJob[]> = ref([]);
// Custom tags — the shared registry (server: Tag collection + /api/tags). Assigned by opaque id on Playlist /
// EpgSource / Channel; resolve id→name via tagNames(). Managed on the Settings screen (TagManager.vue).
export const TAGS: Ref<Tag[]> = ref([]);
export const EPG_PROGRAMS: Record<string, Program[]> = reactive({});
// Ephemeral (not bootstrapped) — kept live by useSystemStats.ts off the /api/system-stats WebSocket. NOT in
// bootstrapData(): the route is admin-only, so a standard user's parallel bootstrap would 403; the admin
// Dashboard subscribes on enter.
export const SYSTEM_STATS: Ref<SystemStats | null> = ref(null);

// ──────────────────────────────────────────────────────────────────────
// Static UI constants
// ──────────────────────────────────────────────────────────────────────

export const GROUPS = ['News', 'Sport', 'Entertainment', 'Movies', 'Kids', 'Music', 'Documentary', 'Lifestyle'];
export const EPG_HOURS = Array.from({ length: 25 }, (_, i) => i);

// The 14 fixed log categories — shared verbatim with the server (server/src/logs/categories.ts) and the
// /api/logs route validator. Drives the Logs drawer's category filter. Keep in lockstep if it ever changes.
// `proxy` = the Rust video data-plane (masq-proxy) full-lineage engine logs (resolve→fetch→repackage→serve).
// `failover` = playlist failover groups (parent + child backups): group create/reorder/disband on the
// control plane + the runtime failover walk on the data plane (both Node and Rust emit the `failover` tag).
export const LOG_CATEGORIES = [
  'dashboard', 'active', 'playlists', 'epg-sources', 'mapping', 'history',
  'users', 'import', 'settings', 'api', 'core', 'mongodb', 'proxy', 'failover',
] as const;

// ──────────────────────────────────────────────────────────────────────
// Bootstrap — fetches every collection in parallel
// ──────────────────────────────────────────────────────────────────────

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

// The set of playlist ids whose channels populate the global CHANNELS union: every registered source that
// has actually been PROVISIONED as a Playlist row (its id === its source id) PLUS every user-composed
// Clone/Import playlist (its channel copies are keyed by its own id). Deduplicated, preserving order
// (sources first).
//
// Built-in source playlists are now added ON DEMAND (Add Playlist → "Built-In"), so the manifest (which
// enumerates the FULL registry) can list a source that has no Playlist row yet. We must NOT fetch
// /api/playlists/<id>/channels for such a source — that endpoint 404s with no row, and getJson throws on a
// 404, rejecting the whole bootstrap. So intersect the manifest source ids with the provisioned playlist
// ids before fetching. A custom playlist hosted at the same id as a source can't happen — create
// disambiguates the id — but the Set guards against any accidental overlap.
function channelPlaylistIds(
  sources: { id: string }[],
  customPlaylists: { id: string }[],
  playlists: { id: string }[],
): string[] {
  const provisioned = new Set(playlists.map((p) => p.id));
  const sourceIds = sources.map((s) => s.id).filter((id) => provisioned.has(id));
  return [...new Set([...sourceIds, ...customPlaylists.map((c) => c.id)])];
}

let bootstrapPromise: Promise<void> | null = null;

export function bootstrapData(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    // EPG programs + epg-channels are NO LONGER loaded here — a large guide (Jesmann) made this a
    // multi-hundred-MB boot fetch that stalled the whole app. Programs are now fetched on demand,
    // scoped to the channels a screen is about to render (fetchProgramsFor); the Mapping screen
    // loads epg-channels per-selected-source (fetchEpgChannelsForSource).
    const [
      playlists, epgSources, sources, activeStreams,
      customPlaylists, viewSessions, logs, cronjobs, tags,
    ] = await Promise.all([
      getJson<Playlist[]>('/api/playlists'),
      getJson<EpgSource[]>('/api/epg-sources'),
      getJson<SourceManifestEntry[]>('/api/sources'),
      getJson<ActiveStream[]>('/api/active-streams'),
      getJson<CustomPlaylist[]>('/api/custom-playlists'),
      getJson<ViewSession[]>('/api/view-sessions'),
      getJson<Log[]>('/api/logs?limit=200'),
      getJson<CronJob[]>('/api/cronjobs'),
      getJson<Tag[]>('/api/tags'),
    ]);
    // The global channel list is the union of each PROVISIONED source's projected channels PLUS every
    // user-composed (Clone/Import) playlist's copied channels (the legacy /api/channels collection endpoint
    // was removed). A source playlist's id equals its source id; a custom playlist's channel copies are keyed
    // by its own id — both are served by /api/playlists/<id>/channels (the toUiChannel-projected list).
    // `playlists` is threaded so an un-added built-in source (manifest-listed but unprovisioned) is excluded
    // — fetching its channels would 404 and reject the whole bootstrap.
    const channelLists = await Promise.all(
      channelPlaylistIds(sources, customPlaylists, playlists).map((id) =>
        getJson<Channel[]>(`/api/playlists/${id}/channels`),
      ),
    );
    PLAYLISTS.value = playlists;
    EPG_SOURCES.value = epgSources;
    SOURCES.value = sources;
    CHANNELS.value = channelLists.flat();
    ACTIVE_STREAMS.value = activeStreams;
    CUSTOM_PLAYLISTS.value = customPlaylists;
    VIEW_SESSIONS.value = viewSessions;
    LOGS.value = logs;
    CRON_JOBS.value = cronjobs;
    TAGS.value = tags;
  })().catch((err) => {
    bootstrapPromise = null;
    throw err;
  });
  return bootstrapPromise;
}

// Re-fetch the EPG collections after an out-of-band write (e.g. adding a Gracenote source). Kept here so
// the modal can refresh the shared store without re-running the whole bootstrap.
export async function reloadEpgSources(): Promise<void> {
  EPG_SOURCES.value = await getJson<EpgSource[]>('/api/epg-sources');
}

// Persist a new EPG-source list order (the drag-to-reorder UX). `orderedIds` is the full id sequence in the
// new visual order. Optimistic: the EPG_SOURCES ref is reordered immediately so the UI snaps, then PUT
// /api/epg-sources/reorder writes the ordinals and returns the freshly re-sorted list which we reconcile
// back (authoritative). On failure the original list is restored so the UI never drifts from the server.
export async function reorderEpgSources(orderedIds: string[]): Promise<void> {
  const prev = EPG_SOURCES.value;
  const byId = new Map(prev.map((s) => [s.id, s]));
  // Optimistic snap: rebuild the array in the requested id order (skip ids we don't know about).
  EPG_SOURCES.value = orderedIds.map((id) => byId.get(id)).filter((s): s is EpgSource => !!s);
  try {
    const res = await fetch('/api/epg-sources/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: orderedIds }),
    });
    if (!res.ok) throw new Error(`reorder failed: ${res.status}`);
    EPG_SOURCES.value = (await res.json()) as EpgSource[];
  } catch (err) {
    EPG_SOURCES.value = prev; // reconcile back to the known-good order on failure
    throw err;
  }
}

// Re-fetch playlists after an out-of-band change (e.g. a dulo sign-in flips a playlist's isAuthenticated).
export async function reloadPlaylists(): Promise<void> {
  PLAYLISTS.value = await getJson<Playlist[]>('/api/playlists');
}

// Pin/unpin a playlist (the Playlists screen's PINNED section toggle). PUT the flag, then re-pull the shared
// store so every consumer (nav count, Dashboard) stays coherent. On the transition into pinned the server
// assigns a bottom-of-section pinOrder, so a plain reload surfaces the new position.
export async function setPlaylistPinned(id: string, pinned: boolean): Promise<void> {
  const res = await fetch(`/api/playlists/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok) throw new Error(`pin toggle failed: ${res.status}`);
  await reloadPlaylists();
}

// Persist a new pinned-playlist order (the drag-to-reorder UX inside the PINNED section). `orderedIds` is the
// pinned id sequence in the new visual order. Optimistic: each reordered row's `pinOrder` is snapped
// immediately (the screen sorts the PINNED section by it) so the UI reflects the drop before the round-trip,
// then PUT /api/playlists/reorder writes the ordinals and returns the authoritative list which we reconcile
// back. On failure the original list is restored so the UI never drifts from the server. Mirrors
// reorderEpgSources (the EPG Sources drag-to-reorder).
export async function reorderPlaylistPins(orderedIds: string[]): Promise<void> {
  const prev = PLAYLISTS.value;
  const orderMap = new Map(orderedIds.map((id, i) => [id, i]));
  // Optimistic snap: rewrite pinOrder in place on the reordered rows (untouched rows pass through).
  PLAYLISTS.value = prev.map((p) => (orderMap.has(p.id) ? { ...p, pinOrder: orderMap.get(p.id) } : p));
  try {
    const res = await fetch('/api/playlists/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: orderedIds }),
    });
    if (!res.ok) throw new Error(`reorder failed: ${res.status}`);
    PLAYLISTS.value = (await res.json()) as Playlist[];
  } catch (err) {
    PLAYLISTS.value = prev; // reconcile back to the known-good order on failure
    throw err;
  }
}

// Persist a new manual order for ONE source-type category (the Playlists screen's per-category drag-reorder,
// active when the A-Z toggle is OFF). `orderedIds` is that category's rows in the new visual order; the server
// rewrites each row's `order` to its index (field:'order'). Same optimistic-snap + reconcile + rollback shape
// as reorderPlaylistPins — only the ordinal field differs.
export async function reorderPlaylistCategory(orderedIds: string[]): Promise<void> {
  const prev = PLAYLISTS.value;
  const orderMap = new Map(orderedIds.map((id, i) => [id, i]));
  // Optimistic snap: rewrite `order` in place on the reordered rows (untouched rows pass through).
  PLAYLISTS.value = prev.map((p) => (orderMap.has(p.id) ? { ...p, order: orderMap.get(p.id) } : p));
  try {
    const res = await fetch('/api/playlists/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: orderedIds, field: 'order' }),
    });
    if (!res.ok) throw new Error(`reorder failed: ${res.status}`);
    PLAYLISTS.value = (await res.json()) as Playlist[];
  } catch (err) {
    PLAYLISTS.value = prev; // reconcile back to the known-good order on failure
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Failover groups — thin wrappers over the /api/playlists/:id/failover-groups routes. The detail screen
// owns a LOCAL channels ref, so each helper returns the authoritative post-state for the screen to merge
// by id; we ALSO patch the global CHANNELS union here (the Mapping screen reads it — inherited tvg_id/epg
// must not go stale there until the next bootstrap).
// ──────────────────────────────────────────────────────────────────────

export interface FailoverGroupResult {
  groupId: string;
  parent: Channel;
  children: Channel[];
}

// Merge group members into the global CHANNELS union by id (last-write-wins).
function patchChannelsStore(members: Channel[]): void {
  if (!members.length) return;
  const byId = new Map(members.map((m) => [m.id, m]));
  CHANNELS.value = CHANNELS.value.map((c) => byId.get(c.id) ?? c);
}

// Mirror the server's failoverDisbandUpdate (server/src/services/failover.ts) on the client: transform a
// channel that is LEAVING its failover group into its ungrouped form. A former CHILD gets its own
// pre-failover tvg_id back from the write-once `origTvgId` snapshot — a present snapshot (even null) wins,
// matching the server's `$type != 'missing'` gate; a parent / un-snapshotted member keeps its live id.
// Then clear the three group fields and drop the consumed snapshot (the server $$REMOVEs it; it's
// re-captured on a later re-group). Every local un-group patch reuses this so the row's tvg_id updates in
// place — no page refresh needed to surface the restored id (the DELETE/PUT never echo it back).
export function disbandChannelLocal(c: Channel): Channel {
  const restoreTvgId = c.failoverRole === 'child' && c.origTvgId !== undefined;
  return {
    ...c,
    ...(restoreTvgId ? { tvg_id: c.origTvgId ?? null } : {}),
    failoverGroupId: null,
    failoverRole: null,
    failoverOrder: null,
    origTvgId: undefined,
  };
}

// Create/replace a failover group. Non-optimistic (the save is a multi-doc cascade — children inherit the
// parent's EPG identity server-side); await, then merge the returned members. Rows the save dropped FROM
// this group get their grouping cleared here too; rows of a DONOR group a moved foreign child came from
// can also change server-side (reconcile may disband it) — the detail screen's post-save reload() is the
// authoritative reconcile for those, and Mapping refetches CHANNELS on mount.
export async function saveFailoverGroup(
  source: string,
  body: { groupId?: string; parentId: string; childIds: string[] },
): Promise<FailoverGroupResult> {
  const res = await fetch(`/api/playlists/${source}/failover-groups`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `failover group save failed: ${res.status}`);
  }
  const result = (await res.json()) as FailoverGroupResult;
  const memberIds = new Set([result.parent.id, ...result.children.map((c) => c.id)]);
  // A member the save dropped from this group is a disband from that channel's POV — the server restored
  // its original tvg_id (same failoverDisbandUpdate), so mirror the full un-group locally, not just the
  // grouping clear.
  CHANNELS.value = CHANNELS.value.map((c) =>
    c.failoverGroupId === result.groupId && !memberIds.has(c.id) ? disbandChannelLocal(c) : c,
  );
  patchChannelsStore([result.parent, ...result.children]);
  return result;
}

// Persist a new child order. Callers pass the FULL child id sequence in the new visual order (the modal's
// local list already snapped optimistically; the response is the authoritative group to reconcile with).
export async function reorderGroupChildren(
  source: string,
  groupId: string,
  childIds: string[],
): Promise<FailoverGroupResult> {
  const res = await fetch(`/api/playlists/${source}/failover-groups/${groupId}/reorder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ childIds }),
  });
  if (!res.ok) throw new Error(`failover reorder failed: ${res.status}`);
  const result = (await res.json()) as FailoverGroupResult;
  patchChannelsStore([result.parent, ...result.children].filter(Boolean) as Channel[]);
  return result;
}

// Disband a group. Each former CHILD gets its own pre-failover tvg_id restored (disbandChannelLocal
// mirrors the server) while keeping its inherited EPG (clearing the link is the explicit unlink action);
// the screen re-reads/merges its local list — here we patch the grouping + restored id in the global union.
export async function disbandFailoverGroup(source: string, groupId: string): Promise<void> {
  const res = await fetch(`/api/playlists/${source}/failover-groups/${groupId}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`failover disband failed: ${res.status}`);
  CHANNELS.value = CHANNELS.value.map((c) => (c.failoverGroupId === groupId ? disbandChannelLocal(c) : c));
}

// ──────────────────────────────────────────────────────────────────────
// Channel groups — the first-class, persisted group registry per playlist (server: Playlist.groupDefs +
// /api/playlists/:id/groups). The shared GroupPicker + the bulk "Manage groups" panel read GROUPS_BY_PLAYLIST
// so a group created in ONE editor immediately appears in the other. Rename/delete also patch the global
// CHANNELS union so the Mapping / EPG-detail screens don't show a stale group label.
// ──────────────────────────────────────────────────────────────────────

export interface GroupDef {
  name: string;
  order: number;
  channels?: number; // live member count (present on GET; absent on create/rename/delete responses is fine)
}

// Registry keyed by playlist id. Populated on demand by reloadGroups(playlistId).
export const GROUPS_BY_PLAYLIST: Ref<Record<string, GroupDef[]>> = ref({});

function setGroups(playlistId: string, defs: GroupDef[]): void {
  GROUPS_BY_PLAYLIST.value = { ...GROUPS_BY_PLAYLIST.value, [playlistId]: defs };
}

export async function reloadGroups(playlistId: string): Promise<GroupDef[]> {
  const defs = await getJson<GroupDef[]>(`/api/playlists/${encodeURIComponent(playlistId)}/groups`);
  setGroups(playlistId, defs);
  return defs;
}

// Create an EMPTY group (persists with zero channels). Returns the refreshed registry.
export async function createGroup(playlistId: string, name: string): Promise<GroupDef[]> {
  const res = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `create group failed: ${res.status}`);
  }
  const defs = (await res.json()) as GroupDef[];
  setGroups(playlistId, defs);
  return defs;
}

// Rename a group across the whole playlist (relabels every member channel). Patches the global CHANNELS union.
export async function renameGroup(playlistId: string, oldName: string, newName: string): Promise<GroupDef[]> {
  const res = await fetch(
    `/api/playlists/${encodeURIComponent(playlistId)}/groups/${encodeURIComponent(oldName)}`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName }) },
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `rename group failed: ${res.status}`);
  }
  const defs = (await res.json()) as GroupDef[];
  setGroups(playlistId, defs);
  CHANNELS.value = CHANNELS.value.map((c) =>
    c.source === playlistId && c.group === oldName ? { ...c, group: newName } : c,
  );
  return defs;
}

// Delete a group (clears it on every member channel; the channels stay). Patches the global CHANNELS union.
export async function deleteGroup(playlistId: string, name: string): Promise<GroupDef[]> {
  const res = await fetch(
    `/api/playlists/${encodeURIComponent(playlistId)}/groups/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`delete group failed: ${res.status}`);
  const defs = (await res.json()) as GroupDef[];
  setGroups(playlistId, defs);
  CHANNELS.value = CHANNELS.value.map((c) =>
    c.source === playlistId && c.group === name ? { ...c, group: null } : c,
  );
  return defs;
}

// ──────────────────────────────────────────────────────────────────────
// Custom tags — the shared, app-wide label registry (server: Tag collection + /api/tags). Records store
// opaque tag IDS (a `tags: string[]` on Playlist / EpgSource / Channel); tagNames() resolves ids → display
// names via a single cached Map so rows never do per-item lookups. A rename is one registry write (every row
// reflects it reactively — no record rewrite); a delete `$pull`s the id from every record server-side and is
// mirrored in-memory below so open rows drop the pill without a refetch.
// ──────────────────────────────────────────────────────────────────────

export interface Tag { id: string; name: string; order?: number }

// id → name, rebuilt only when TAGS changes.
export const tagsById = computed(() => new Map(TAGS.value.map((t) => [t.id, t.name])));

// Resolve a record's tag ids to display names (dropping any unknown/stale id).
export function tagNames(ids?: string[]): string[] {
  if (!ids?.length) return [];
  const m = tagsById.value;
  return ids.map((id) => m.get(id)).filter((n): n is string => !!n);
}

export async function reloadTags(): Promise<void> {
  TAGS.value = await getJson<Tag[]>('/api/tags');
}

// Create a tag. Returns it; throws with the server error slug (e.g. 'tag_exists') so a caller can react.
export async function createTag(name: string): Promise<Tag> {
  const res = await fetch('/api/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `create tag failed: ${res.status}`);
  }
  const tag = (await res.json()) as Tag;
  TAGS.value = [...TAGS.value, tag];
  return tag;
}

// Rename a tag. No record patching — rows resolve names via tagsById, which updates reactively.
export async function renameTag(id: string, name: string): Promise<Tag> {
  const res = await fetch(`/api/tags/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `rename tag failed: ${res.status}`);
  }
  const tag = (await res.json()) as Tag;
  TAGS.value = TAGS.value.map((t) => (t.id === id ? tag : t));
  return tag;
}

// Delete a tag. The server cascades a $pull across all records; mirror it in-memory so open rows drop the
// pill without a refetch (parallels deleteGroup patching CHANNELS).
export async function deleteTag(id: string): Promise<void> {
  const res = await fetch(`/api/tags/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`delete tag failed: ${res.status}`);
  TAGS.value = TAGS.value.filter((t) => t.id !== id);
  PLAYLISTS.value = PLAYLISTS.value.map((p) =>
    p.tags?.includes(id) ? { ...p, tags: p.tags.filter((t) => t !== id) } : p,
  );
  EPG_SOURCES.value = EPG_SOURCES.value.map((e) =>
    e.tags?.includes(id) ? { ...e, tags: e.tags.filter((t) => t !== id) } : e,
  );
  CHANNELS.value = CHANNELS.value.map((c) =>
    c.tags?.includes(id) ? { ...c, tags: c.tags.filter((t) => t !== id) } : c,
  );
}

// Hard-delete channels (tombstoned server-side so a re-sync won't re-add them). Removes them from the global
// CHANNELS union; the caller (detail screen) also patches its own local list. Returns the deleted count.
export async function deleteChannels(playlistId: string, ids: string[]): Promise<number> {
  const res = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}/channels/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`delete channels failed: ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { deleted?: number };
  const dead = new Set(ids);
  CHANNELS.value = CHANNELS.value.filter((c) => !dead.has(c.id));
  return body.deleted ?? 0;
}

// Re-fetch the custom (clone) playlists after a create/append/delete so the shared store + the append
// dropdown reflect Mongo without re-running the whole bootstrap.
export async function reloadCustomPlaylists(): Promise<void> {
  CUSTOM_PLAYLISTS.value = await getJson<CustomPlaylist[]>('/api/custom-playlists');
}

// Load the EPG guide channels for ONE source into the shared EPG_CHANNELS store (the Mapping screen's
// right-hand list). Scoped by `?source=` so a large guide only transfers the picked source's channels
// (not every source's, as the old boot-wide /api/epg-channels did). Pass '' / 'none' to clear.
export async function fetchEpgChannelsForSource(sourceId: string): Promise<void> {
  EPG_CHANNELS.value = (sourceId && sourceId !== 'none')
    ? await getJson<EpgChannel[]>(`/api/epg-channels?source=${encodeURIComponent(sourceId)}`)
    : [];
}

// Re-fetch the global channel list (the per-source + per-custom-playlist union, same as bootstrapData()'s
// second wave) after an out-of-band change. Lets a screen reflect current Mongo state without re-running the
// whole bootstrap. Custom (Clone/Import) playlists are fetched fresh here too, and CUSTOM_PLAYLISTS is
// refreshed, so a clone created elsewhere (then navigated to, e.g. on the Mapping screen) shows its channels.
// Playlists are fetched fresh too so a built-in just provisioned via the Add Playlist "Built-In" option is
// counted (the channel-union intersection excludes un-added/manifest-only sources to avoid a 404).
export async function reloadChannels(): Promise<void> {
  const sources = SOURCES.value.length ? SOURCES.value : PLAYLISTS.value.filter((p) => p.source && p.source === p.id);
  const [playlists, customPlaylists] = await Promise.all([
    getJson<Playlist[]>('/api/playlists'),
    getJson<CustomPlaylist[]>('/api/custom-playlists'),
  ]);
  PLAYLISTS.value = playlists;
  CUSTOM_PLAYLISTS.value = customPlaylists;
  const channelLists = await Promise.all(
    channelPlaylistIds(sources, customPlaylists, playlists).map((id) =>
      getJson<Channel[]>(`/api/playlists/${id}/channels`),
    ),
  );
  CHANNELS.value = channelLists.flat();
}

// User-path sibling of reloadChannels(): builds CHANNELS from ONLY the playlists the signed-in user has
// been granted, without touching any admin-only endpoint (reloadChannels() fetches /api/custom-playlists,
// which 403s for role 'user' and rejects the whole load). GET /api/playlists is already user-scoped, so
// App.vue's loadAppData() awaits reloadPlaylists() first and this reads channels for exactly those granted
// ids — each /api/playlists/:id/channels call passes the server's allowed-playlist guard. A per-call catch
// keeps one playlist's failure from wiping the rest.
export async function reloadUserChannels(): Promise<void> {
  const lists = await Promise.all(
    PLAYLISTS.value.map((p) =>
      getJson<Channel[]>(`/api/playlists/${p.id}/channels`).catch(() => [] as Channel[])),
  );
  CHANNELS.value = lists.flat();
}

// Fetch programs for a SCOPED set of channels within a time window and MERGE them into the shared
// EPG_PROGRAMS cache (keyed by composite channelId "<source>:<id>"). Replaces the old "load every
// program at boot" path. Merge (not wipe) because two screens share the cache (EPG Detail timeline +
// Active Streams now/next); `clear: true` resets it first for an explicit full refresh. channelIds are
// chunked to the server's per-request cap. A channel with no programs in-window simply gets [].
const PROGRAMS_CHUNK = 500; // matches MAX_CHANNEL_IDS in routes/programs.ts

export async function fetchProgramsFor(
  channelIds: string[],
  from?: number,
  to?: number,
  clear = false,
): Promise<void> {
  const ids = [...new Set(channelIds.filter(Boolean))];
  if (clear) for (const k of Object.keys(EPG_PROGRAMS)) delete EPG_PROGRAMS[k];
  if (ids.length === 0) return;
  const win = (from != null && to != null) ? `&from=${from}&to=${to}` : '';
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += PROGRAMS_CHUNK) chunks.push(ids.slice(i, i + PROGRAMS_CHUNK));
  const results = await Promise.all(
    chunks.map((c) =>
      getJson<Record<string, Program[]>>(`/api/epg-programs?channelIds=${encodeURIComponent(c.join(','))}${win}`)),
  );
  for (const r of results) Object.assign(EPG_PROGRAMS, r);
}

// User-scoped sibling of fetchProgramsFor: reads the guide via GET /api/playlists/:id/programs (the
// user-reachable route) instead of the admin-only /api/epg-programs, then MERGES into EPG_PROGRAMS.
// The Dashboard's per-user view uses this. `channelIds` are composite "<epg>:<tvg_id>" keys; `playlistId`
// is the selected channel's `source` (the id the server's grant guard is checked against). A single
// channel is fetched at a time, so no chunking is needed.
export async function fetchUserProgramsFor(
  playlistId: string,
  channelIds: string[],
  from?: number,
  to?: number,
): Promise<void> {
  const ids = [...new Set(channelIds.filter(Boolean))];
  if (!playlistId || ids.length === 0) return;
  const win = (from != null && to != null) ? `&from=${from}&to=${to}` : '';
  const r = await getJson<Record<string, Program[]>>(
    `/api/playlists/${encodeURIComponent(playlistId)}/programs?channelIds=${encodeURIComponent(ids.join(','))}${win}`,
  );
  Object.assign(EPG_PROGRAMS, r);
}

// Re-fetch the cron jobs after a schedule edit (the EPG Edit drawer upserts/deletes one).
export async function reloadCronjobs(): Promise<void> {
  CRON_JOBS.value = await getJson<CronJob[]>('/api/cronjobs');
}

// Re-fetch the viewer watch-session history (the History/Metrics screen refreshes it out-of-band).
export async function reloadViewSessions(): Promise<void> {
  VIEW_SESSIONS.value = await getJson<ViewSession[]>('/api/view-sessions');
}

// Re-fetch the application logs (the Logs drawer reloads on open + after a Clear). Newest-first, capped to
// the route's default 200. Live lines arrive separately over /api/logs-stream (useLogStream.ts) and are
// prepended into LOGS, so this is only the initial/after-clear snapshot.
export async function reloadLogs(): Promise<void> {
  LOGS.value = await getJson<Log[]>('/api/logs?limit=200');
}

// Re-fetch the per-user watch-metrics rollup (History/Metrics "User Metrics" tab; refreshed on tab
// enter and whenever a freshly-closed session lands over the WS feed). Aggregated server-side.
export async function reloadUserMetrics(): Promise<void> {
  USER_METRICS.value = await getJson<UserMetric[]>('/api/view-sessions/user-metrics');
}

// appPlayerProxyPath now lives in streamPath.ts (dependency-free, so the standalone player.html entry can
// import it without pulling in this whole module). Re-exported here so every existing caller is unchanged.
export { appPlayerProxyPath } from './streamPath';

// ISO-3166-1 alpha-2 → flag emoji (regional-indicator pair). Empty string for missing/invalid codes, so a
// row with no resolved country just shows its location label (or an em-dash). Shared by the Active Streams +
// History/Metrics screens so the geo presentation stays identical.
export function flagEmoji(cc: string | null | undefined): string {
  if (!cc || cc.length !== 2 || !/^[A-Za-z]{2}$/.test(cc)) return '';
  const base = 0x1f1e6; // regional indicator 'A'
  const up = cc.toUpperCase();
  return String.fromCodePoint(base + (up.charCodeAt(0) - 65), base + (up.charCodeAt(1) - 65));
}

// Live human-readable schedule label for a schedulable playlist's cron job, derived from CRON_JOBS (never
// the stored interval). The argument is the cron TARGET ID — the playlist id (a playlist's sync/compose
// jobs key by its id; for a (Default) source playlist id === source, for a 'url'/'hdhomerun' custom import
// the id is its own — NOT the 'url'/'hdhomerun' TYPE TAG). targetType 'playlist' = Sync schedule,
// 'playlist-m3u' = Compose-m3u schedule — the two distinct jobs share targetId and differ only by
// targetType. 'manual' when there is no id or no matching job. The label renders LOWERCASE (matching the
// lowercase source/clone/custom/endpoint chips) — both the 'manual' fallback and the friendly
// summarizeFrequency label are lowercased here. Shared by the Playlists list/detail screens and the
// Dashboard playlist panel so the three presentations stay identical.
export function playlistScheduleLabel(
  targetId: string | null | undefined,
  targetType: 'playlist' | 'playlist-m3u',
): string {
  if (!targetId) return 'manual';
  const job = CRON_JOBS.value.find((j) => j.targetType === targetType && j.targetId === targetId);
  return (job ? summarizeFrequency(job.frequency, job.cron) : 'manual').toLowerCase();
}

// Provenance chips shown under an EPG source name, in a fixed order (source → id → lineupId →
// lineup_Type → headendId → country → postalCode). Only non-empty fields render. Shared by the EPG
// Sources list and the EPG detail header so the two presentations stay identical.
const EPG_META_FIELDS: { key: keyof EpgSource; label: string }[] = [
  { key: 'source', label: 'source' },
  { key: 'id', label: 'id' },
  { key: 'lineupId', label: 'lineupId' },
  { key: 'lineup_Type', label: 'lineup_Type' },
  { key: 'headendId', label: 'headendId' },
  { key: 'country', label: 'country' },
  { key: 'postalCode', label: 'postalCode' },
];
// Pretty display label for the lowercase EPG source-KIND discriminator. The stored/compared value is
// lowercase ('gracenote'/'epg-pw'/'jesmann'/'tubi'/'dlhd'/'xml file'/'remote url') — this maps the
// proper-name providers back to their brand casing for the UI (the SOURCE chip, etc.); unknown kinds pass
// through verbatim. Case-insensitive so a legacy capitalized row still renders the brand label pre-migration.
const EPG_SOURCE_LABELS: Record<string, string> = {
  gracenote: 'Gracenote',
  'epg-pw': 'EPG-PW',
  jesmann: 'Jesmann',
  tubi: 'tubi',
  dlhd: 'dlhd',
  'xml file': 'xml file',
  'remote url': 'remote url',
};
export function epgSourceLabel(source: string | null | undefined): string {
  if (!source) return '';
  return EPG_SOURCE_LABELS[source.toLowerCase()] ?? source;
}

// Pass `keys` to render a subset in that order (e.g. the Dashboard shows only source/lineupId/
// lineup_Type); omit it for the full set used by the list + detail headers. The `source` chip is
// pretty-printed via epgSourceLabel so the lowercase stored kind shows its brand casing.
export function epgMetaChips(s: EpgSource, keys?: (keyof EpgSource)[]): { label: string; value: unknown }[] {
  const fields = keys
    ? keys
        .map((k) => EPG_META_FIELDS.find((f) => f.key === k))
        .filter((f): f is { key: keyof EpgSource; label: string } => !!f)
    : EPG_META_FIELDS;
  return fields
    .map((f) => ({ label: f.label, value: f.key === 'source' ? epgSourceLabel(s[f.key] as string) : s[f.key] }))
    .filter((c) => c.value != null && c.value !== '');
}

// Shared last-sync presenter so the EPG List / Dashboard / Detail screens render `lastSync` identically.
// A real sync writes an ISO timestamp (syncEpgSource.ts) → render a short local date+time; legacy/mock rows
// hold free-text ('2 hours ago') that isn't a date → pass through unchanged.
export function formatSyncTime(s: string): string {
  if (!s) return '—';
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return s; // legacy free-text — leave as authored
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
