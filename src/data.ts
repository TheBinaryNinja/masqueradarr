// Reactive store for Masqueradarr.
//
// Top-level data (PLAYLISTS, CHANNELS, ACTIVE_STREAMS, etc.) is fetched from
// the API at app startup via bootstrapData(). Consumers in <script setup>
// read them as Vue refs (e.g. CHANNELS.value) or via the reactive
// EPG_PROGRAMS map.
//
// Static UI constants (GROUPS, EPG_HOURS) and pure client-side helpers
// live here too — they're not mock data, they're config the SPA owns.

import { ref, reactive, type Ref } from 'vue';
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
  // user-composed playlist this is a lowercase TYPE TAG: 'clone' | 'file' | 'url' | 'hdhomerun'
  // (legacy 'import' still appears on pre-split rows).
  source?: string | null;
  // Auth: `authentication` = this playlist requires sign-in to stream (stored, source-intrinsic);
  // `isAuthenticated` = currently signed in (stored mirror of the owning playlistauths.status==='active').
  authentication?: boolean;
  isAuthenticated?: boolean;
  // Per-playlist externalPlayer video config: 'default' (global app config) | 'app_<id>' (a Custom config doc).
  // Governs how this playlist's channels are served to EXTERNAL IPTV clients only (the in-app player is unaffected).
  videoconfig?: string;
  // Remote-URL import source — set ONLY for a remote-URL m3u import playlist (source:'url'); null/absent for
  // every other playlist. The upstream .m3u/.m3u8 URL the import fetched, persisted so a manual or scheduled
  // Sync re-fetches + reconciles this playlist's channels from it. (Distinct from `url`, the hosted URL.)
  remoteUrl?: string | null;
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
}
// ffprobe-derived technical details (server/src/models/StreamSession.ts → StreamProbe). The latest snapshot
// rides Channel.stream.probe; the ~10s time-series rides the StreamSession rows. `tbc` is intentionally
// absent (removed from modern ffprobe); tbn/tbr are the faithful equivalents.
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
// resolution, the initials logo fallback, and the ffprobe technical-detail snapshot. Fields with no source
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
  stream: {
    initials: string | null;
    isPlayable: boolean;
    res: string | null;
    status: 'live' | 'establishing' | 'buffer' | 'failed' | null; // realtime phase
    probe?: StreamProbe | null; // ffprobe technical-detail snapshot (latest); null until first probed
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
// quality (codec/resolution/fps/…) off ffprobe; a passthrough proxy can't measure dropped frames or
// playback latency, so those fields are intentionally absent.
// Which player produced a session: the in-app slide-out HLS player (appPlayer) or a third-party IPTV client
// app — TiviMate/Kodi/VLC/… (externalPlayer, routed through the server-side ffmpeg/VLC engine).
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
  bitrate: number; // Mbps — per-viewer stream bitrate
  bandwidth: number; // Mbps — total egress across viewers
  bytesTotal: number;
  codec: string | null; audio: string | null; container: string | null;
  resolution: string | null; fps: number | null;
  probe: StreamProbe | null;
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
// One external-player ENGINE process serving a channel (GET /api/active-streams/:channelId/engine → { engines }).
// Drives the "Video Engine Service" diagram on the Active Streams screen. ffmpeg fills speed/fps/bitrateKbps/
// outTimeMs/dropFrames; VLC leaves them null (no -progress). `clients` is the raw-TS socket count (null for the HLS engine).
// `upstreamUrl` is query-redacted (host+path) server-side. An empty engines[] ⇒ no transcode engine (in-app
// passthrough / engine off) ⇒ the screen shows the passthrough note instead of the diagram.
export interface EngineSnapshot {
  output: 'hls' | 'ts';
  engine: 'ffmpeg' | 'vlc';
  configId: string; // 'app' (Default) | 'app_<playlistId>' (Custom)
  mode: string; // 'auto' | 'copy' | 'transcode'
  preset: string | null; // from the resolved videoconfig (ffmpeg/vlc sub-object)
  advancedArgs: string; // operative spawn args (from the videoconfig)
  hwEncoder: string | null; // resolved HW encoder (null = software → no GPU node)
  upstreamUrl: string; // resolved upstream master, query-redacted to host+path
  startedAt: number;
  state: 'init' | 'live' | 'buffer' | 'failed';
  speed: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  outTimeMs: number | null;
  dropFrames: number | null; // cumulative dropped frames (ffmpeg -progress); null for VLC
  clients: number | null; // raw-TS attached socket count; null for the HLS engine
  producing: boolean;
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
// 1:1 with the repurposed streamsessions store (server/src/models/StreamSession.ts) — the per-channel
// stream-probe time-series. One row per ffprobe capture, linked to its channel by channelId (= a Channel.id
// / PlaylistChannel._id). Read from GET /api/stream-sessions (newest first). Feeds the History/Metrics
// build-out (later).
export interface StreamSession {
  channelId: string; capturedAt: number;
  video: StreamProbe['video']; audio: StreamProbe['audio']; container: string | null;
}
// One buffering interval within a watch session (epoch-ms start + interval duration).
export interface ViewBufferEvent { at: number; phase: 'buffer' | 'failed'; ms: number }
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
  videoEngineCustomization: boolean;
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
  // The Add Playlist "Built-In" summary (server fills DEFAULT_BUILTIN_META when an adapter omits it).
  builtinMeta: BuiltinPlaylistMeta;
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
// Live state of the scheduled ffprobe sweep (server/src/sources/probeAll.ts) — ephemeral, NOT a persisted
// collection. Pushed over the /api/probe-progress WebSocket (useProbeProgress.ts) and read on demand via
// GET /api/probe/status. Drives the sidebar "Probe: running" indicator. `running:false` = idle.
export interface ProbeStatus {
  running: boolean;
  playlistId: string | null;
  playlistName: string | null;
  channelIndex: number; // 1-based position within the current playlist
  channelTotal: number; // Active channels in the current playlist
  currentChannelName: string | null;
  startedAt: number | null; // epoch ms of the current run
}
// 1:1 with the live system-performance frame (server stats/systemStatsHub.ts → SystemStats) — ephemeral,
// NOT a persisted collection. Read on demand via GET /api/system-stats and pushed every ~2.5s over the
// /api/system-stats WebSocket (useSystemStats.ts). Drives the Dashboard "System Performance" banner.
// `scope` reports where CPU/Memory were measured: cgroup ('container') vs Node os.* ('host'). diskIo/network
// are null when /proc is unavailable (non-Linux dev); mongo connection fields are null when serverStatus is
// unprivileged/unavailable. CPU usagePct is null until the second tick (needs a delta). `gpu` is null unless a
// videoconfig has HW accel enabled (drives the Dashboard "GPU Performance" card); per-vendor numeric fields are
// null when the host can't report them (no device / monitor tool missing / Intel shared memory).
export interface GpuStats {
  vendor: 'nvidia' | 'amd' | 'intel' | 'unknown';
  name: string | null;
  encoder: string | null; // the enabled HW encoder, e.g. 'h264_nvenc'
  utilizationPct: number | null;
  encoderPct: number | null; // dedicated encode-engine % (NVENC / Intel Video)
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  memUsedPct: number | null;
  temperatureC: number | null;
  source: 'nvidia-smi' | 'sysfs' | 'radeontop' | 'intel_gpu_top' | null;
}
export interface SystemStats {
  ts: number;
  scope: 'cgroup-v2' | 'cgroup-v1' | 'host';
  cpu: { usagePct: number | null; cores: number; loadAvg: [number, number, number] };
  memory: { totalBytes: number; usedBytes: number; usedPct: number; rssBytes: number };
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
  gpu: GpuStats | null;
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
export const STREAM_SESSIONS: Ref<StreamSession[]> = ref([]);
export const VIEW_SESSIONS: Ref<ViewSession[]> = ref([]);
export const USER_METRICS: Ref<UserMetric[]> = ref([]);
export const LOGS: Ref<Log[]> = ref([]);
export const CRON_JOBS: Ref<CronJob[]> = ref([]);
export const EPG_PROGRAMS: Record<string, Program[]> = reactive({});
// Ephemeral (not bootstrapped) — kept live by useProbeProgress.ts off the /api/probe-progress WebSocket.
export const PROBE_STATUS: Ref<ProbeStatus | null> = ref(null);
// Ephemeral (not bootstrapped) — kept live by useSystemStats.ts off the /api/system-stats WebSocket. NOT in
// bootstrapData(): the route is admin-only, so a standard user's parallel bootstrap would 403; the admin
// Dashboard subscribes on enter (mirrors PROBE_STATUS).
export const SYSTEM_STATS: Ref<SystemStats | null> = ref(null);

// ──────────────────────────────────────────────────────────────────────
// Static UI constants
// ──────────────────────────────────────────────────────────────────────

export const GROUPS = ['News', 'Sport', 'Entertainment', 'Movies', 'Kids', 'Music', 'Documentary', 'Lifestyle'];
export const EPG_HOURS = Array.from({ length: 25 }, (_, i) => i);

// The 12 fixed log categories — shared verbatim with the server (server/src/logs/categories.ts) and the
// /api/logs route validator. Drives the Logs drawer's category filter. Keep in lockstep if it ever changes.
export const LOG_CATEGORIES = [
  'dashboard', 'active', 'playlists', 'epg-sources', 'mapping', 'history',
  'users', 'import', 'settings', 'api', 'core', 'mongodb',
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
      customPlaylists, streamSessions, viewSessions, logs, cronjobs,
    ] = await Promise.all([
      getJson<Playlist[]>('/api/playlists'),
      getJson<EpgSource[]>('/api/epg-sources'),
      getJson<SourceManifestEntry[]>('/api/sources'),
      getJson<ActiveStream[]>('/api/active-streams'),
      getJson<CustomPlaylist[]>('/api/custom-playlists'),
      getJson<StreamSession[]>('/api/stream-sessions'),
      getJson<ViewSession[]>('/api/view-sessions'),
      getJson<Log[]>('/api/logs?limit=200'),
      getJson<CronJob[]>('/api/cronjobs'),
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
    STREAM_SESSIONS.value = streamSessions;
    VIEW_SESSIONS.value = viewSessions;
    LOGS.value = logs;
    CRON_JOBS.value = cronjobs;
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

// appPlayer proxy path for a source-playlist channel: /api/v1/<source>/<enc streamEntryUrl>. This is the
// IN-APP player's stream URL (prefixed `appPlayer*` to distinguish it from the externalPlayer /api/ext
// mount the M3U composer writes for third-party IPTV clients). Derived here (not stored) so a proxy-mount /
// dlhd mirror change needs no data rewrite. Null for legacy channels.
export function appPlayerProxyPath(ch: Channel): string | null {
  // A clone copy's proxy source is its provider (`origin`, e.g. 'dulo') — its `source` is the clone id; a
  // source-playlist channel's is its `source` (origin null). Mirrors serialize.ts (channelToExtinf).
  const src = ch.origin || ch.source;
  if (!ch.streamEntryUrl || !src) return null;
  return `/api/v1/${src}/${encodeURIComponent(ch.streamEntryUrl)}`;
}

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
// lowercase ('gracenote'/'epg-pw'/'jesmann'/'tubi'/'dlhd'/'xml file'/'remote url') — this maps the proper-name
// providers back to their brand casing for the UI (the SOURCE chip, etc.); unknown kinds pass through
// verbatim. Case-insensitive so a legacy capitalized row still renders the brand label pre-migration.
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
