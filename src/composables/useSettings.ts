import { ref, computed, watch, nextTick } from 'vue';
import { useTweaks } from './useTweaks';

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
export const epgPath = ref('/_global/epg/playlist.xml');
// Outbound-fetch DNS: comma-separated resolver IP(s) (blank => OS resolver) + a 1|2|3 trace-verbosity level.
// Both persist like any other field; the server re-applies them to the live undici dispatcher on save
// (server/src/dns.ts via settings/applyDns.ts) and surfaces DNS traces in the View logs drawer (core category).
export const nameservers = ref('');
export const dnsLogLevel = ref(2);
// MaxMind GeoIP credentials (Settings screen → viewer geolocation on the Active Streams + History screens).
// accountId round-trips like any other field; the license KEY is write-only — the API never returns it
// (it's a secret behind a public GET), so we only hydrate a "configured?" boolean and PUT a new key on Save.
export const maxmindAccountId = ref('');
export const maxmindLicenseKeySet = ref(false);
// On-disk location the scheduled backup job writes to (Settings → Data card). Persists like any other
// field; defaults to '/backups'. The Data backup feature (Generate/Restore/schedule) lives on the Settings
// screen — see SettingsScreen.vue.
export const backupLocation = ref('/backups');

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
      nameservers: string | null;
      dnsLogLevel: number;
      maxmindAccountId: string | null;
      maxmindLicenseKeySet: boolean;
      backupLocation: string;
    }>;
    if (typeof s.displayName === 'string') displayName.value = s.displayName;
    if (typeof s.domain === 'string') domain.value = s.domain;
    if (typeof s.timezone === 'string') timezone.value = s.timezone;
    if (typeof s.offset === 'string') offset.value = s.offset;
    if (typeof s.darkMode === 'boolean') darkMode.value = s.darkMode;
    if (s.nameservers !== undefined) nameservers.value = s.nameservers ?? '';
    if (typeof s.dnsLogLevel === 'number') dnsLogLevel.value = s.dnsLogLevel;
    if (s.maxmindAccountId !== undefined) maxmindAccountId.value = s.maxmindAccountId ?? '';
    if (typeof s.maxmindLicenseKeySet === 'boolean') maxmindLicenseKeySet.value = s.maxmindLicenseKeySet;
    if (typeof s.backupLocation === 'string') backupLocation.value = s.backupLocation;
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
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  }, 500);
}

watch(displayName, (v) => persist({ displayName: v }));
watch(domain, (v) => persist({ domain: v }));
watch(timezone, (v) => persist({ timezone: v }));
watch(darkMode, (v) => persist({ darkMode: v }));
watch(nameservers, (v) => persist({ nameservers: v.trim() === '' ? null : v.trim() }));
watch(dnsLogLevel, (v) => persist({ dnsLogLevel: v }));
watch(maxmindAccountId, (v) => persist({ maxmindAccountId: v.trim() === '' ? null : v.trim() }));
watch(backupLocation, (v) => persist({ backupLocation: v.trim() || '/backups' }));

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

export const epgEndpoint = computed(() => `${domain.value.replace(/\/$/, '')}${epgPath.value.startsWith('/') ? '' : '/'}${epgPath.value}`);

// (Per-playlist state/endpoint/url is now persisted on the Playlist doc — edited via PUT /api/playlists/:id
// in PlaylistStatusDrawer.vue — so the old SPA-local usePlaylistStatus/playlistEndpoint helpers were removed.)
