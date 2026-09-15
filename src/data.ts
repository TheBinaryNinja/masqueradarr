
import { ref, reactive, computed, type Ref } from 'vue';
import { summarizeFrequency } from './composables/useSchedule';


export interface Playlist {
  id: string; name: string; url: string; channels: number; groups: number;
  lastSync: string; status: string; auto: boolean; interval: string; builtin?: boolean;
  state?: boolean;
  endpoint?: 'global' | 'custom';
  source?: string | null;
  authentication?: boolean;
  isAuthenticated?: boolean;
  remoteUrl?: string | null;
  pinned?: boolean;
  pinOrder?: number;
  order?: number;
  tags?: string[];
  applyTagsToChannels?: boolean;
}
export interface EpgSource {
  id: string; name: string; url: string; channels: number; programs: number;
  lastSync: string; status: string; auto: boolean; interval: string; builtin?: boolean;
  playlistBinding?: boolean;
  order?: number;
  syncSuccessCount?: number;
  syncFailCount?: number;
  lastXmlAt?: string | null;
  xmlGeneratedCount?: number;
  xmlFailCount?: number;
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
  tags?: string[];
}
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
export interface Channel {
  id: string;
  tvg_name: string;
  group: string | null;
  channel: number | null;
  channelNo: string | null;
  tvg_id: string | null;
  epg: string | null;
  epgState: 'matched' | 'unmatched' | null;

  status: string;
  source: string;
  origin?: string | null;
  logoColor: string;
  logoUrl: string | null;
  streamEntryUrl: string;
  failoverGroupId?: string | null;
  failoverRole?: 'parent' | 'child' | null;
  failoverOrder?: number | null;
  origTvgId?: string | null;
  playerPref?: number | null;
  tags?: string[];
  stream: {
    initials: string | null;
    isPlayable: boolean;
    res: string | null;
    status: 'live' | 'establishing' | 'buffer' | 'failed' | null;
    probe?: StreamProbe | null;
  };
}
export interface Program {
  start: number; end: number; title: string; cat: string;
  offset?: string | null;
  callSign?: string | null;
  channelNo?: string | null;
  shortDesc?: string | null;
  rating?: string | null;
  seriesId?: string | null;
  season?: string | null;
  episode?: string | null;
  episodeTitle?: string | null;
}
export type PlayerType = 'appPlayer' | 'externalPlayer';
export interface ActiveStream {
  id: string;
  channelId: string;
  source: string;
  phase: 'live' | 'establishing' | 'buffer' | 'failed';
  status: 'good' | 'warn' | 'bad';
  retry?: number; everStreamed?: boolean;
  uptime: string; uptimeMin: number;
  viewers: number; peakViewers: number;
  watchers: string[];
  viewersByPlayer: { appPlayer: number; externalPlayer: number };
  delivery: 'hls' | 'ts' | 'mixed';
  bitrate: number;
  bandwidth: number;
  bytesTotal: number;
  codec: string | null; audio: string | null; container: string | null;
  resolution: string | null; fps: number | null;
  declaredBps?: number | null;
  upstreamShape?: string | null;
  encryption?: string | null;
  lastClose?: { reason: string; at: number; socketBound: boolean } | null;
  probe: StreamProbe | null;
  ingest: {
    status: string; subscribers: number;
    ringSegments: number; ringBytes: number;
    channelRingCapBytes?: number;
    ringSeconds?: number; floorBeatsCap?: boolean;
    headSeq: number; generation: number;
    discSeq?: number; discInWindow?: number;
    ingestedSegments: number; ingestedBytes: number; evictedSegments: number;
    suspect?: string | null; suspectRetires?: number;
    demuxed?: boolean; ineligible?: string | null;
    targetDuration: number; at: number;
  } | null;
  failover: { attempt: number; candidateId: string; candidateName: string } | null;
  adBreak: {
    inBreak: boolean; signal: string; breakId: number;
    segments: number; durationSec: number; announcedSec: number;
    profileChanged: boolean; breaksSeen: number; totalBreakSec: number; at: number;
  } | null;
  upstreamHost?: string | null;
  requested?: { outputFormat: string; originEnabled: boolean; originRingMb: number; spliceNormalize: boolean } | null;
}
export interface StreamClient {
  ip: string; userAgent: string;
  username: string | null;
  playerType: PlayerType;
  connectedAt: number; lastSeen: number;
  bytes: number; currentRate: number;
  segments: number;
  bufferCount?: number; rebufferMs?: number;
  socketBound?: boolean;
  location?: string | null;
  countryCode?: string | null;
}
export interface EpgChannel {
  callSign: string | null;
  affiliateName: string;
  channelId: string;
  channelNo: string | null;
  source: string;
}
export interface CustomPlaylist { id: string; name: string; slug: string; channels: number; updated: string }
export interface ViewBufferEvent { at: number; phase: 'buffer' | 'failed'; ms: number; side?: 'upstream' | 'client' }
export interface ViewSession {
  channelId: string; source: string;
  ip: string; userAgent: string;
  username: string | null;
  playerType?: PlayerType;
  startedAt: number; endedAt: number | null; durationMs: number;
  bytesTotal: number; avgBitrate: number;
  location?: string | null;
  countryCode?: string | null;
  resolution: string | null; codec: string | null;
  bufferCount: number; rebufferMs: number;
  bufferEvents: ViewBufferEvent[];
  qoeScore: number; health: 'good' | 'warn' | 'bad';
}
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
export interface Log {
  ts: number;
  category: string;
  level: 'info' | 'warn' | 'error';
  tag: string;
  message: string;
  meta?: Record<string, unknown> | null;
}
export interface BuiltinPlaylistMeta {
  globalPlaylist: boolean;
  clonePlaylist: boolean;
  syncSchedules: boolean;
  playlistBoundEpg: boolean;
  epgSyncSchedules: boolean;
}
export interface SourceManifestEntry {
  id: string;
  label: string;
  grouping: { by: string; groupOrder: string; channelOrder: string };
  sourceUrl: string;
  proxyPrefix: string;
  statusUrl: string | null;
  playerSelectable?: boolean;
  probeExempt?: boolean;
  originRequired?: boolean;
  enabled?: boolean;
  builtinMeta: BuiltinPlaylistMeta;
}

export function playerSelectable(ch: Pick<Channel, 'source' | 'origin'>): boolean {
  const id = ch.origin ?? ch.source;
  return SOURCES.value.some((s) => s.id === id && s.playerSelectable === true);
}
export interface CronFrequency {
  mode: 'minutes' | 'hourly' | 'daily' | 'weekly' | 'custom';
  every: number | null;
  atHour: number | null;
  atMinute: number | null;
  daysOfWeek: number[] | null;
}
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
export interface SystemStats {
  ts: number;
  scope: 'cgroup-v2' | 'cgroup-v1' | 'host';
  cpu: { usagePct: number | null; cores: number; loadAvg: [number, number, number] };
  memory: { totalBytes: number; usedBytes: number; usedPct: number; rssBytes: number };
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
    health: {
      opsPerSec: number | null;
      avgLatencyMs: number | null;
      queryTargeting: number | null;
      queueDepth: number | null;
      scanAndOrderPerSec: number | null;
    } | null;
  };
}


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
export const TAGS: Ref<Tag[]> = ref([]);
export const EPG_PROGRAMS: Record<string, Program[]> = reactive({});
export const SYSTEM_STATS: Ref<SystemStats | null> = ref(null);


export const GROUPS = ['News', 'Sport', 'Entertainment', 'Movies', 'Kids', 'Music', 'Documentary', 'Lifestyle'];
export const EPG_HOURS = Array.from({ length: 25 }, (_, i) => i);

export const LOG_CATEGORIES = [
  'dashboard', 'active', 'playlists', 'epg-sources', 'mapping', 'history',
  'users', 'import', 'settings', 'api', 'core', 'mongodb', 'proxy', 'failover',
] as const;


export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

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

export async function reloadEpgSources(): Promise<void> {
  EPG_SOURCES.value = await getJson<EpgSource[]>('/api/epg-sources');
}

export async function reorderEpgSources(orderedIds: string[]): Promise<void> {
  const prev = EPG_SOURCES.value;
  const byId = new Map(prev.map((s) => [s.id, s]));
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
    EPG_SOURCES.value = prev;
    throw err;
  }
}

export async function reloadSources(): Promise<void> {
  SOURCES.value = await getJson<SourceManifestEntry[]>('/api/sources');
}

export async function reloadPlaylists(): Promise<void> {
  PLAYLISTS.value = await getJson<Playlist[]>('/api/playlists');
}

export async function setPlaylistPinned(id: string, pinned: boolean): Promise<void> {
  const res = await fetch(`/api/playlists/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok) throw new Error(`pin toggle failed: ${res.status}`);
  await reloadPlaylists();
}

export async function reorderPlaylistPins(orderedIds: string[]): Promise<void> {
  const prev = PLAYLISTS.value;
  const orderMap = new Map(orderedIds.map((id, i) => [id, i]));
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
    PLAYLISTS.value = prev;
    throw err;
  }
}

export async function reorderPlaylistCategory(orderedIds: string[]): Promise<void> {
  const prev = PLAYLISTS.value;
  const orderMap = new Map(orderedIds.map((id, i) => [id, i]));
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
    PLAYLISTS.value = prev;
    throw err;
  }
}


export interface FailoverGroupResult {
  groupId: string;
  parent: Channel;
  children: Channel[];
}

function patchChannelsStore(members: Channel[]): void {
  if (!members.length) return;
  const byId = new Map(members.map((m) => [m.id, m]));
  CHANNELS.value = CHANNELS.value.map((c) => byId.get(c.id) ?? c);
}

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
  CHANNELS.value = CHANNELS.value.map((c) =>
    c.failoverGroupId === result.groupId && !memberIds.has(c.id) ? disbandChannelLocal(c) : c,
  );
  patchChannelsStore([result.parent, ...result.children]);
  return result;
}

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

export async function disbandFailoverGroup(source: string, groupId: string): Promise<void> {
  const res = await fetch(`/api/playlists/${source}/failover-groups/${groupId}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`failover disband failed: ${res.status}`);
  CHANNELS.value = CHANNELS.value.map((c) => (c.failoverGroupId === groupId ? disbandChannelLocal(c) : c));
}


export interface GroupDef {
  name: string;
  order: number;
  channels?: number;
}

export const GROUPS_BY_PLAYLIST: Ref<Record<string, GroupDef[]>> = ref({});

function setGroups(playlistId: string, defs: GroupDef[]): void {
  GROUPS_BY_PLAYLIST.value = { ...GROUPS_BY_PLAYLIST.value, [playlistId]: defs };
}

export async function reloadGroups(playlistId: string): Promise<GroupDef[]> {
  const defs = await getJson<GroupDef[]>(`/api/playlists/${encodeURIComponent(playlistId)}/groups`);
  setGroups(playlistId, defs);
  return defs;
}

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


export interface Tag { id: string; name: string; order?: number }

export const tagsById = computed(() => new Map(TAGS.value.map((t) => [t.id, t.name])));

export function tagNames(ids?: string[]): string[] {
  if (!ids?.length) return [];
  const m = tagsById.value;
  return ids.map((id) => m.get(id)).filter((n): n is string => !!n);
}

export async function reloadTags(): Promise<void> {
  TAGS.value = await getJson<Tag[]>('/api/tags');
}

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

export async function reloadCustomPlaylists(): Promise<void> {
  CUSTOM_PLAYLISTS.value = await getJson<CustomPlaylist[]>('/api/custom-playlists');
}

export async function fetchEpgChannelsForSource(sourceId: string): Promise<void> {
  EPG_CHANNELS.value = (sourceId && sourceId !== 'none')
    ? await getJson<EpgChannel[]>(`/api/epg-channels?source=${encodeURIComponent(sourceId)}`)
    : [];
}

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

export async function reloadUserChannels(): Promise<void> {
  const lists = await Promise.all(
    PLAYLISTS.value.map((p) =>
      getJson<Channel[]>(`/api/playlists/${p.id}/channels`).catch(() => [] as Channel[])),
  );
  CHANNELS.value = lists.flat();
}

const PROGRAMS_CHUNK = 500;

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

export async function reloadCronjobs(): Promise<void> {
  CRON_JOBS.value = await getJson<CronJob[]>('/api/cronjobs');
}

export async function reloadViewSessions(): Promise<void> {
  VIEW_SESSIONS.value = await getJson<ViewSession[]>('/api/view-sessions');
}

export async function reloadLogs(): Promise<void> {
  LOGS.value = await getJson<Log[]>('/api/logs?limit=200');
}

export async function reloadUserMetrics(): Promise<void> {
  USER_METRICS.value = await getJson<UserMetric[]>('/api/view-sessions/user-metrics');
}

export { appPlayerProxyPath } from './streamPath';

export function flagEmoji(cc: string | null | undefined): string {
  if (!cc || cc.length !== 2 || !/^[A-Za-z]{2}$/.test(cc)) return '';
  const base = 0x1f1e6;
  const up = cc.toUpperCase();
  return String.fromCodePoint(base + (up.charCodeAt(0) - 65), base + (up.charCodeAt(1) - 65));
}

export function playlistScheduleLabel(
  targetId: string | null | undefined,
  targetType: 'playlist' | 'playlist-m3u',
): string {
  if (!targetId) return 'manual';
  const job = CRON_JOBS.value.find((j) => j.targetType === targetType && j.targetId === targetId);
  return (job ? summarizeFrequency(job.frequency, job.cron) : 'manual').toLowerCase();
}

const EPG_META_FIELDS: { key: keyof EpgSource; label: string }[] = [
  { key: 'source', label: 'source' },
  { key: 'id', label: 'id' },
  { key: 'lineupId', label: 'lineupId' },
  { key: 'lineup_Type', label: 'lineup_Type' },
  { key: 'headendId', label: 'headendId' },
  { key: 'country', label: 'country' },
  { key: 'postalCode', label: 'postalCode' },
];
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

export function formatSyncTime(s: string): string {
  if (!s) return '—';
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return s;
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
