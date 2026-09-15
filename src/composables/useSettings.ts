import { ref, computed, watch, nextTick } from 'vue';
import { useTweaks } from './useTweaks';
import { bus } from './bus';
import { reloadPlaylists, reloadSources } from '../data';

// Operator settings the SPA shares with the server. Persisted fields are hydrated once from
// GET /api/settings (loadSettings) and PUT back, debounced, on edit. epgPath stays SPA-local
// (display only; see schemas.md §3.12) and mirrors the Global guide path
// (server/src/epg/guidePaths.ts GLOBAL_GUIDE_PATH) — keep them in sync.
// (There is no canonical Global m3u path anymore — per-user M3U files are served flat at
// <domain>/<username>-<slug>.m3u and surfaced on the Dashboard/Users screens, so the Settings
// "M3U endpoint" field shows just the bare <domain> origin and no m3uPath/m3uEndpoint exist.)
// Defaults mirror the server's env-seeded defaults so a brief pre-hydrate render looks right.
export const displayName = ref('TVApp2');
export const domain = ref('http://localhost:3000');
export const timezone = ref('America/New_York');
// Derived server-side from `timezone` (DST-aware '±HHMM'); READ-ONLY here — no watcher PUTs it back. Surfaced
// so the Settings screen can show the active UTC offset; the EPG timeline reads each program's own stamped
// offset, not this. See server/src/settings/zoneOffset.ts.
export const offset = ref('+0000');
export const darkMode = ref(true);
// Which player the channel slide-out renders: 'inapp' (default), 'ultimate' (the Ultimate Player — the
// slide-out's media block collapses to a launch button that opens the standalone player.html popup), or
// 'debug' (the diagnostic HUD with a live hls.js status readout + event log). Global operator toggle;
// persisted on the Settings singleton like any other field. 'inapp'/'debug' are consumed by
// ChannelPlayer.vue to pick which player component to mount; 'ultimate' is handled a level up, in
// ChannelDrawer.vue, which never mounts an in-drawer player at all.
export type VideoPlayerMode = 'inapp' | 'ultimate' | 'debug';
export const VIDEO_PLAYER_MODES: readonly VideoPlayerMode[] = ['inapp', 'ultimate', 'debug'];
export const videoPlayer = ref<VideoPlayerMode>('inapp');
// The Playlist Domain / Configuration JSON (Settings → Advanced): per source an `enable` visibility switch (false
// hides it from the Add Playlist picker and hides its Settings card), the `domain` it lives on, and its own
// `extendedProperties` (daddylive's default player, zlive's distinct-channel cap). Mirrors the server's
// sources/core/playlistConfig.ts shape + defaults. DELIBERATELY NOT auto-persisted: it is saved as a whole, once,
// from the editor's Save button (savePlaylistConfig) — a changed dulo domain signs the dulo session out, and a
// changed zlive domain resets its resolver, so a debounced keystroke watcher would be wrong twice over.
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
  daddylive: { enable: true, domain: 'dlive.sx', extendedProperties: { defaultPlayer: 'auto' } },
  dulo: { enable: true, domain: 'dulo.gd', extendedProperties: {} },
  zlive: { enable: true, domain: 'zlive.st', extendedProperties: { concurrency: 2 } },
});
export const epgPath = ref('/_global/epg/playlist.xml');
// Outbound-fetch DNS: comma-separated resolver IP(s) (blank => OS resolver). Persists like any other field;
// the server re-applies it to the live undici dispatcher on save (server/src/dns.ts via settings/applyDns.ts).
export const nameservers = ref('');
// logLevel — the GLOBAL 1|2|3 log verbosity (was dnsLogLevel), governing the whole app AND the Rust proxy
// engine. On save the server re-applies DNS trace verbosity AND pushes the level to the sidecar (picked up
// live, no restart); all of it — DNS traces + the engine's full resolve→serve lineage — shows in the View
// logs drawer (the `proxy` category holds the engine lineage).
export const logLevel = ref(2);
// MaxMind GeoIP credentials (Settings screen → viewer geolocation on the Active Streams + History screens).
// accountId round-trips like any other field; the license KEY is write-only — the API never returns it
// (it's a secret behind a public GET), so we only hydrate a "configured?" boolean and PUT a new key on Save.
export const maxmindAccountId = ref('');
export const maxmindLicenseKeySet = ref(false);
// On-disk location the scheduled backup job writes to (Settings → Data card). Persists like any other
// field; defaults to '/backups'. The Data backup feature (Generate/Restore/schedule) lives on the Settings
// screen — see SettingsScreen.vue.
export const backupLocation = ref('/backups');
// Playlists screen "A-Z" toggle: when true, rows auto-sort alphabetically within each source-type category;
// when false they follow the manual per-category order (Playlist.order). Persisted on the Settings singleton
// like any other field (shared across admin devices); the Playlists screen mutates this ref directly (button
// click, or a drag → false) and the debounced watcher below PUTs it. Default ON.
export const playlistsAlphaSort = ref(true);

const { tweaks, setTweak } = useTweaks();

// settings.darkMode is the persisted source of truth; useTweaks.theme is the live view that drives
// document.dataset.theme. Two-way, but each side writes only when the value actually differs, so the
// binding settles instead of looping (Vue also dedups same-value ref writes).
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
    // Best-effort: the defaults stand if the API is unreachable.
  } finally {
    // Let the hydration-triggered watchers flush (with the guard still false → no echo PUT) before arming.
    await nextTick();
    settingsHydrated = true;
  }
}

// Debounced PUT of accumulated edits. Skips the initial hydrate (settingsHydrated guard) so loading the
// persisted values doesn't echo them straight back (which would, for `domain`, also trigger the
// server-side playlist-url cascade for no reason).
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
        // A domain change cascades server-side into every playlist's persisted `url` (HOSTED AT). Re-pull the
        // canonical rows into the shared PLAYLISTS store so the copyable custom-playlist / guide URLs on the
        // Dashboard + Users screens (derived from it via usePublishedUrls) update live — no page reload, and
        // no manual Compose (the server already recomposed the on-disk files in the same cascade).
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

// Write-only PUT of the MaxMind license key (never goes through the auto-persist refs — the API doesn't
// return it, so round-tripping would blank it). Triggered by the Save/Clear buttons on the Settings screen;
// returns whether the write succeeded so the button can reflect the result. An empty key clears it.
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

// Explicit (un-debounced) PUT of the whole playlist configuration, from the editor's Save button — see
// playlistConfig above for why this is not a watcher. `next` is the operator's parsed JSON, sent as-is: the server's
// strict validator is the authority, and its path-prefixed `errors` come back for the editor to list. On success the
// server's canonical config (domains normalized, defaults filled) is adopted, the source manifest is re-pulled (an
// `enable` flip changes the Add Playlist picker), and a changed dulo domain — which signed the session out
// server-side — is broadcast so playlist auth badges refresh.
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

// One probed source from POST /api/sources/playlist-config/test.
export interface PlaylistConfigTestResult {
  key: string;
  sourceId: string;
  label: string;
  enable: boolean;
  domain: string;
  /** The tested domain differs from the one the running app uses (the edit is not saved yet). */
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

// Probe every domain in a (usually unsaved) playlist configuration. Persists nothing server-side. A config the
// server's validator refuses comes back as { ok:false, errors } without any probe having run.
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

// (Per-playlist state/endpoint/url is now persisted on the Playlist doc — edited via PUT /api/playlists/:id
// in PlaylistStatusDrawer.vue — so the old SPA-local usePlaylistStatus/playlistEndpoint helpers were removed.)
