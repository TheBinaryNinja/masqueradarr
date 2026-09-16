import { ref, computed, watch, nextTick } from 'vue';
import { useTweaks } from './useTweaks';
import { bus } from './bus';
import { reloadPlaylists, reloadSources } from '../data';
import { dec } from '../codec';

export const displayName = ref('TVApp2');
export const domain = ref('http://localhost:3000');
export const timezone = ref('America/New_York');
export const offset = ref('+0000');
export const darkMode = ref(true);
export type VideoPlayerMode = 'inapp' | 'ultimate' | 'debug';
export const VIDEO_PLAYER_MODES: readonly VideoPlayerMode[] = ['inapp', 'ultimate', 'debug'];
export const videoPlayer = ref<VideoPlayerMode>('inapp');
export interface PlaylistSourceConfig<E extends object = Record<string, unknown>> {
  enable: boolean;
  domain: string;
  extendedProperties: E;
}
export interface PlaylistConfig {
  daddylive: PlaylistSourceConfig<{ defaultPlayer: 'auto' | number }>;
  dulo: PlaylistSourceConfig<Record<string, never>>;
  zlive: PlaylistSourceConfig<{ concurrency: number }>;
}
export const playlistConfig = ref<PlaylistConfig>({
  daddylive: { enable: true, domain: dec('ZGxpdmUuc3g='), extendedProperties: { defaultPlayer: 'auto' } },
  dulo: { enable: true, domain: dec('ZHVsby5nZA=='), extendedProperties: {} },
  zlive: { enable: true, domain: dec('emxpdmUuc3Q='), extendedProperties: { concurrency: 2 } },
});
export const epgPath = ref('/_global/epg/playlist.xml');
export const nameservers = ref('');
export const logLevel = ref(2);
export const maxmindAccountId = ref('');
export const maxmindLicenseKeySet = ref(false);
export const backupLocation = ref('/backups');
export const playlistsAlphaSort = ref(true);

const { tweaks, setTweak } = useTweaks();

watch(darkMode, (v) => {
  const theme = v ? 'dark' : 'light';
  if (tweaks.theme !== theme) setTweak('theme', theme);
});
watch(
  () => tweaks.theme,
  (theme) => {
    const v = theme === 'dark';
    if (darkMode.value !== v) darkMode.value = v;
  },
);

let settingsHydrated = false;

export async function loadSettings(): Promise<void> {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) return;
    const s = (await res.json()) as Partial<{
      displayName: string;
      domain: string;
      timezone: string;
      offset: string;
      darkMode: boolean;
      videoPlayer: VideoPlayerMode;
      playlistConfig: PlaylistConfig;
      nameservers: string | null;
      logLevel: number;
      maxmindAccountId: string | null;
      maxmindLicenseKeySet: boolean;
      backupLocation: string;
      playlistsAlphaSort: boolean;
    }>;
    if (typeof s.displayName === 'string') displayName.value = s.displayName;
    if (typeof s.domain === 'string') domain.value = s.domain;
    if (typeof s.timezone === 'string') timezone.value = s.timezone;
    if (typeof s.offset === 'string') offset.value = s.offset;
    if (typeof s.darkMode === 'boolean') darkMode.value = s.darkMode;
    if (s.videoPlayer && VIDEO_PLAYER_MODES.includes(s.videoPlayer)) videoPlayer.value = s.videoPlayer;
    if (s.playlistConfig && typeof s.playlistConfig === 'object') playlistConfig.value = s.playlistConfig;
    if (s.nameservers !== undefined) nameservers.value = s.nameservers ?? '';
    if (typeof s.logLevel === 'number') logLevel.value = s.logLevel;
    if (s.maxmindAccountId !== undefined) maxmindAccountId.value = s.maxmindAccountId ?? '';
    if (typeof s.maxmindLicenseKeySet === 'boolean') maxmindLicenseKeySet.value = s.maxmindLicenseKeySet;
    if (typeof s.backupLocation === 'string') backupLocation.value = s.backupLocation;
    if (typeof s.playlistsAlphaSort === 'boolean') playlistsAlphaSort.value = s.playlistsAlphaSort;
  } catch {
  } finally {
    await nextTick();
    settingsHydrated = true;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: Record<string, unknown> = {};
function persist(patch: Record<string, unknown>): void {
  if (!settingsHydrated) return;
  Object.assign(pending, patch);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const body = pending;
    pending = {};
    const changedDomain = 'domain' in body;
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (res.ok && changedDomain) void reloadPlaylists();
      })
      .catch(() => undefined);
  }, 500);
}

watch(displayName, (v) => persist({ displayName: v }));
watch(domain, (v) => persist({ domain: v }));
watch(timezone, (v) => persist({ timezone: v }));
watch(darkMode, (v) => persist({ darkMode: v }));
watch(videoPlayer, (v) => persist({ videoPlayer: v }));
watch(nameservers, (v) => persist({ nameservers: v.trim() === '' ? null : v.trim() }));
watch(logLevel, (v) => persist({ logLevel: v }));
watch(maxmindAccountId, (v) => persist({ maxmindAccountId: v.trim() === '' ? null : v.trim() }));
watch(backupLocation, (v) => persist({ backupLocation: v.trim() || '/backups' }));
watch(playlistsAlphaSort, (v) => persist({ playlistsAlphaSort: v }));

export async function saveMaxmindLicenseKey(key: string): Promise<boolean> {
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxmindLicenseKey: key }),
    });
    if (!res.ok) return false;
    maxmindLicenseKeySet.value = key.trim() !== '';
    return true;
  } catch {
    return false;
  }
}

export function clearMaxmindLicenseKey(): Promise<boolean> {
  return saveMaxmindLicenseKey('');
}

export async function savePlaylistConfig(next: unknown): Promise<{ ok: boolean; error?: string; errors?: string[] }> {
  const prevDulo = playlistConfig.value.dulo.domain;
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playlistConfig: next }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      playlistConfig?: PlaylistConfig;
      error?: string;
      errors?: string[];
    };
    if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}`, errors: body.errors };
    if (body.playlistConfig) playlistConfig.value = body.playlistConfig;
    void reloadSources().catch(() => undefined);
    if (playlistConfig.value.dulo.domain !== prevDulo) bus.emit('tvapp:auth-changed', { source: 'dulo' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface PlaylistConfigTestResult {
  key: string;
  sourceId: string;
  label: string;
  enable: boolean;
  domain: string;
  unsaved: boolean;
  ok: boolean;
  endpoint: string | null;
  httpStatus: number | null;
  ms: number;
  channelCount: number | null;
  redirectTo: string | null;
  notes: string[];
  error: string | null;
}

export interface PlaylistConfigTestOutcome {
  ok: boolean;
  testedAt?: string;
  results?: PlaylistConfigTestResult[];
  error?: string;
  errors?: string[];
}
export async function testPlaylistConfig(config: unknown): Promise<PlaylistConfigTestOutcome> {
  try {
    const res = await fetch('/api/sources/playlist-config/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      testedAt?: string;
      results?: PlaylistConfigTestResult[];
      error?: string;
      errors?: string[];
    };
    if (!res.ok || !Array.isArray(body.results)) {
      return { ok: false, error: body.error || `HTTP ${res.status}`, errors: body.errors };
    }
    return { ok: true, testedAt: body.testedAt ?? new Date().toISOString(), results: body.results };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export const epgEndpoint = computed(() => `${domain.value.replace(/\/$/, '')}${epgPath.value.startsWith('/') ? '' : '/'}${epgPath.value}`);

