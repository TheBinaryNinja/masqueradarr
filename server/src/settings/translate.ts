// Translation layer between the EXTERNAL settings doc (MongoDB — the source of truth) and the INTERNAL
// runtime settings shape the API exposes and the SPA/server consume. The Settings analogue of
// sources/toPlaylistChannel.ts: the single place the internal<->external Settings boundary is defined, so
// the boot seed (seedSettings), GET (read projection) and PUT (patch builder) all agree on one mapping.
//
// Three directional maps:
//   - envDefaults()        ENV -> external : defaults derived from environment variables, used to SEED the
//                                            singleton on first boot ($setOnInsert) and as the GET upsert
//                                            defaults. Applied via $setOnInsert by callers, so it never
//                                            overwrites a value the operator has since edited.
//   - toRuntimeSettings()  external -> internal : a stored SettingsDoc -> the runtime shape the API returns
//                                                 (drops the Mongo _id; this is the read-projection authority).
//   - toExternalPatch()    internal -> external : a request body -> a validated, whitelisted $set patch (or
//                                                 a 400 error string). The one input gate: only known
//                                                 fields, type-checked, are ever patched to Mongo.
//
// These are APP settings (persisted in Mongo); distinct from infra config (mongoUri/port/logLevel in
// config.json via MASQUERADARR_CONFIG — see config.ts). See schemas.md §3.12.

import { isIP } from 'node:net';
import type { SettingsDoc } from '../models/Settings.js';
import { DULO_DEFAULT_DOMAIN, normalizeDomain } from '../sources/adapters/dulo/config.js';
import { zoneOffsetString } from './zoneOffset.js';

// First-provision default for the outbound-fetch DNS resolver(s). Hardcoded (the NAMESERVER env was
// dropped): Google public DNS, written into the settings singleton on first insert so a working resolver
// is always present from boot one. The operator overrides it on the Settings screen afterwards.
export const DEFAULT_NAMESERVERS = '8.8.8.8,8.8.4.4';

// The external-data shape minus the singleton _id — what seeds/patches/reads operate on.
export type SettingsData = Omit<SettingsDoc, '_id'>;

// The three player modes the SPA can render, and the one coercion used by ALL three directional maps below
// (env seed, read projection, write validator) so they can never disagree about what a valid mode is.
// Anything unrecognized — a legacy row, a bad env var, a hand-edited doc — collapses to the 'inapp' default.
export const VIDEO_PLAYER_MODES = ['inapp', 'ultimate', 'debug'] as const;
export type VideoPlayerMode = (typeof VIDEO_PLAYER_MODES)[number];

function asVideoPlayerMode(v: unknown): VideoPlayerMode {
  return VIDEO_PLAYER_MODES.includes(v as VideoPlayerMode) ? (v as VideoPlayerMode) : 'inapp';
}

// Internal runtime shape returned by the API. Diverges from SettingsData by REDACTING the secret MaxMind
// license key (GET /api/settings is a public read): the raw key is never returned, only a boolean telling
// the SPA whether one is configured. toRuntimeSettings() is the sole read-projection authority, so this is
// the one place the secret is dropped.
export type RuntimeSettings = Omit<SettingsData, 'maxmindLicenseKey'> & { maxmindLicenseKeySet: boolean };

// ENV -> external. Defaults for the singleton. Used both to seed on first boot and as the GET upsert
// defaults, so a read before the boot seed ran (e.g. bootInitSources failed) still reflects them. Most
// fields fall back to an env var; `nameservers` is a HARDCODED default (DEFAULT_NAMESERVERS) — the
// NAMESERVER env was dropped — so a working outbound-fetch resolver is always present on first provision.
export function envDefaults(): SettingsData {
  const timezone = process.env.TZ ?? 'America/New_York';
  return {
    displayName: process.env.DISPLAY_NAME ?? 'TVApp2',
    domain: process.env.DOMAIN ?? 'http://localhost:3000',
    timezone,
    // Derived from `timezone` (DST-aware) so a first-provision settings doc already carries a valid offset
    // for the EPG sync stamp; re-derived on every timezone save in toExternalPatch.
    offset: zoneOffsetString(timezone),
    darkMode: true,
    videoPlayer: asVideoPlayerMode(process.env.VIDEO_PLAYER),
    // Source-wide default DaddyLive player (0 = Auto). Seedable from DLHD_PLAYER; clamped to a non-negative int.
    dlhdPlayer: Math.max(0, Math.trunc(Number(process.env.DLHD_PLAYER)) || 0),
    // The domain dulo is currently on. Deliberately NOT env-derived: dulo identity is kept out of infra
    // config (the old DULO_API / DULO_API_BASE overrides were retired with this field), so the committed
    // default seeds first boot and the operator edits it on the Settings screen thereafter.
    duloDomain: DULO_DEFAULT_DOMAIN,
    // nameservers: hardcoded first-provision default (no longer env-derived — the NAMESERVER env was
    // dropped). 8.8.8.8,8.8.4.4 (Google public DNS) is written into the singleton on first insert so a
    // working outbound-fetch resolver is ALWAYS present out of the box; the operator edits it on the
    // Settings screen thereafter (Mongo wins, applied live). Critical for initial setup, so never null here.
    nameservers: DEFAULT_NAMESERVERS,
    // GLOBAL log verbosity (was dnsLogLevel). Seeds from LOG_LEVEL (falling back to the legacy DNS_LOG_LEVEL
    // for back-compat); default 2. NOTE this is the Mongo settings knob — distinct from the infra config.json
    // `logLevel` STRING (config.ts), which is a different object read from a different source.
    logLevel: Math.min(3, Math.max(1, Number(process.env.LOG_LEVEL ?? process.env.DNS_LOG_LEVEL) || 2)),
    maxmindAccountId: process.env.MAXMIND_ACCOUNT_ID ?? null,
    maxmindLicenseKey: process.env.MAXMIND_LICENSE_KEY ?? null,
    user: {},
    // Scheduled/saved backups write here (default '/backups'; the AIO image seeds BACKUPS_DIR=/data/backups).
    backupLocation: process.env.BACKUPS_DIR ?? '/backups',
    // Playlists screen "A-Z" toggle default (SPA-only display preference; not env-derived). Default ON so a
    // fresh install shows alphabetical rows within each source-type category out of the box.
    playlistsAlphaSort: true,
  };
}

// external -> internal. Project a stored SettingsDoc into the runtime shape the API returns (drops _id).
export function toRuntimeSettings(doc: SettingsDoc): RuntimeSettings {
  return {
    displayName: doc.displayName,
    domain: doc.domain,
    timezone: doc.timezone,
    offset: doc.offset ?? '+0000', // derived from timezone; surfaced read-only to the SPA
    darkMode: doc.darkMode,
    videoPlayer: asVideoPlayerMode(doc.videoPlayer),
    dlhdPlayer: typeof doc.dlhdPlayer === 'number' ? doc.dlhdPlayer : 0, // source-wide default DaddyLive player (0 = Auto)
    duloDomain: doc.duloDomain || DULO_DEFAULT_DOMAIN, // bare host; not secret — returned for the Settings UI
    nameservers: doc.nameservers ?? null, // not secret — returned verbatim for the Settings UI
    logLevel: typeof doc.logLevel === 'number' ? doc.logLevel : 2,
    maxmindAccountId: doc.maxmindAccountId ?? null,
    maxmindLicenseKeySet: !!doc.maxmindLicenseKey, // redact the secret → expose only "configured?"
    user: doc.user ?? {},
    backupLocation: doc.backupLocation ?? '/backups', // not secret — returned for the Settings UI
    playlistsAlphaSort: typeof doc.playlistsAlphaSort === 'boolean' ? doc.playlistsAlphaSort : true,
  };
}

export type PatchResult =
  | { ok: true; $set: Partial<SettingsData> }
  | { ok: false; error: string };

// internal -> external. Validate a request body and build the $set patch persisted to Mongo. The single
// whitelist/validation gate: unknown fields are ignored, every known field is type-checked, and a failure
// returns a 400 message naming the offending field (matching the resource-API convention in restapi.md).
export function toExternalPatch(body: unknown): PatchResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const $set: Partial<SettingsData> = {};

  for (const key of ['displayName', 'domain', 'timezone'] as const) {
    const v = b[key];
    if (v !== undefined) {
      if (typeof v !== 'string' || v.trim() === '') {
        return { ok: false, error: `${key} (non-empty string) required` };
      }
      $set[key] = v.trim();
    }
  }
  // `offset` is DERIVED, never client-supplied: whenever the timezone changes, re-derive its DST-aware UTC
  // offset ('±HHMM') so the value stamped onto synced programs + emitted in the guide tracks the zone.
  if (typeof $set.timezone === 'string') {
    $set.offset = zoneOffsetString($set.timezone);
  }
  for (const key of ['darkMode', 'playlistsAlphaSort'] as const) {
    const v = b[key];
    if (v !== undefined) {
      if (typeof v !== 'boolean') {
        return { ok: false, error: `${key} (boolean) required` };
      }
      $set[key] = v;
    }
  }
  // videoPlayer: which player the channel slide-out renders. Enum 'inapp' | 'ultimate' | 'debug'
  // (default 'inapp'). Unlike the read/seed maps this does NOT coerce — an unknown mode is a client bug, so
  // it 400s rather than silently downgrading the operator's choice to 'inapp'.
  if (b.videoPlayer !== undefined) {
    if (!VIDEO_PLAYER_MODES.includes(b.videoPlayer as VideoPlayerMode)) {
      return { ok: false, error: `videoPlayer (${VIDEO_PLAYER_MODES.map((m) => `'${m}'`).join(', ')}) required` };
    }
    $set.videoPlayer = b.videoPlayer as VideoPlayerMode;
  }
  // dlhdPlayer: source-wide default DaddyLive player. 0 = Auto; 1..N selects a specific player. A generous
  // upper bound (out-of-range clamps to the lead player at resolve time, so the cap only bounds the dropdown).
  if (b.dlhdPlayer !== undefined) {
    const v = b.dlhdPlayer;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 12) {
      return { ok: false, error: 'dlhdPlayer (integer 0..12; 0 = Auto) required' };
    }
    $set.dlhdPlayer = v;
  }
  // duloDomain: the host dulo is currently on. Normalized (scheme/path/port/userinfo stripped, lowercased)
  // and gated by the SAME validator the Test/Auto-detect endpoints use — it rejects IP literals and
  // private/loopback targets, which matters because those endpoints server-side-fetch this value.
  if (b.duloDomain !== undefined) {
    if (typeof b.duloDomain !== 'string') return { ok: false, error: 'duloDomain (string) required' };
    const parsed = normalizeDomain(b.duloDomain);
    if (!parsed.ok) return { ok: false, error: `duloDomain: ${parsed.error}` };
    $set.duloDomain = parsed.domain;
  }
  // nameservers: optional comma-separated resolver IP(s). null or '' clears it (stored null → OS resolver);
  // a non-empty string must be a comma list of valid IPs (isIP), else 400 — a bad value never reaches dns.ts.
  if (b.nameservers !== undefined) {
    const v = b.nameservers;
    if (v === null) {
      $set.nameservers = null;
    } else if (typeof v !== 'string') {
      return { ok: false, error: 'nameservers (comma-separated IP string or null) required' };
    } else {
      const trimmed = v.trim();
      if (trimmed === '') {
        $set.nameservers = null;
      } else {
        const parts = trimmed.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        for (const p of parts) {
          if (isIP(p) === 0) {
            return { ok: false, error: `nameservers: '${p}' is not a valid IP address` };
          }
        }
        $set.nameservers = parts.join(',');
      }
    }
  }
  // logLevel: the GLOBAL log verbosity (app + Rust proxy engine) — an integer 1..3 (was dnsLogLevel).
  if (b.logLevel !== undefined) {
    const v = b.logLevel;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 3) {
      return { ok: false, error: 'logLevel (integer 1, 2 or 3) required' };
    }
    $set.logLevel = v;
  }
  // MaxMind credentials: optional nullable strings. An empty string clears the value (stored as null) so the
  // SPA can blank a field; the license key is write-only here (never read back — see toRuntimeSettings).
  for (const key of ['maxmindAccountId', 'maxmindLicenseKey'] as const) {
    const v = b[key];
    if (v !== undefined) {
      if (v === null) {
        $set[key] = null;
      } else if (typeof v !== 'string') {
        return { ok: false, error: `${key} (string or null) required` };
      } else {
        const trimmed = v.trim();
        $set[key] = trimmed === '' ? null : trimmed;
      }
    }
  }
  if (b.user !== undefined) {
    const v = b.user;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return { ok: false, error: 'user (object) required' };
    }
    $set.user = v as Record<string, unknown>;
  }
  // backupLocation: the on-disk dir for scheduled + saved backups. A required non-empty string (a blank
  // value would write backups to an unexpected place); read lazily by backup/paths.ts, no live side-effect.
  if (b.backupLocation !== undefined) {
    if (typeof b.backupLocation !== 'string' || b.backupLocation.trim() === '') {
      return { ok: false, error: 'backupLocation (non-empty string) required' };
    }
    $set.backupLocation = b.backupLocation.trim();
  }
  return { ok: true, $set };
}
