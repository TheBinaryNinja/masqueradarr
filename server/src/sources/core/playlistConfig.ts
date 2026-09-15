// playlistConfig.ts — the operator's Playlist Domain / Configuration: ONE JSON document holding every per-source
// knob that used to be a scattered Settings field (Settings → Advanced → Playlist Domain / Configuration).
//
//   { "daddylive": { "enable": true, "domain": "dlive.sx", "extendedProperties": { "defaultPlayer": "auto" } },
//     "dulo":      { "enable": true, "domain": "dulo.gd",  "extendedProperties": {} },
//     "zlive":     { "enable": true, "domain": "zlive.st", "extendedProperties": { "concurrency": 2 } } }
//
//   · enable              — false HIDES the source: it drops out of the Add Playlist picker and its Settings card
//                           (dulo's authentication) is hidden. It is a visibility switch only — an existing playlist
//                           of that source keeps syncing and playing.
//   · domain              — the host the source lives on (dlhd's content mirror, dulo's site, zlive's apex). Run
//                           through the shared core/domain.ts gate, a real SSRF boundary: the Test endpoint and the
//                           source's own fetches go to whatever lands here.
//   · extendedProperties  — the source's own knobs (daddylive: default player; zlive: distinct-channel cap).
//
// Persisted in Mongo (Settings.playlistConfig, so backups carry it) and mirrored to a JSON file by
// settings/applyPlaylistConfig.ts; the running app reads the in-memory copy cached here.
//
// A Mongo-FREE leaf: it imports only the three source config leaves and the domain gate, and has no side effects
// at import — dns.ts → settings/translate.ts → here loads before Mongo connects.

import {
  DLHD_DEFAULT_DOMAIN,
  getBase as getDlhdBase,
  getPlayerDefault,
  setBase as setDlhdBase,
  setPlayerDefault,
} from '../adapters/dlhd/config.js';
import { DULO_DEFAULT_DOMAIN, setDomain as setDuloDomain } from '../adapters/dulo/config.js';
import {
  ZLIVE_DEFAULT_DOMAIN,
  ZLIVE_DEFAULT_MAX_STREAMS,
  ZLIVE_MAX_STREAMS_LIMIT,
  getMaxStreams as getZliveMaxStreams,
  setDomain as setZliveDomain,
  setMaxStreams as setZliveMaxStreams,
} from '../adapters/zlive/config.js';
import { normalizeDomain } from './domain.js';

/** daddylive's default player: "auto" (lead with Player 1, walk the rest) or a specific 1-based player. */
export type DlhdDefaultPlayer = 'auto' | number;

export interface PlaylistSourceConfig<E extends object> {
  enable: boolean;
  domain: string;
  extendedProperties: E;
}

export interface PlaylistConfig {
  daddylive: PlaylistSourceConfig<{ defaultPlayer: DlhdDefaultPlayer }>;
  dulo: PlaylistSourceConfig<Record<string, never>>;
  zlive: PlaylistSourceConfig<{ concurrency: number }>;
}

export type PlaylistConfigKey = keyof PlaylistConfig;

/** Config key → the registry source id it configures. The keys are the operator-facing names. */
export const PLAYLIST_CONFIG_SOURCES: Readonly<Record<PlaylistConfigKey, string>> = {
  daddylive: 'dlhd',
  dulo: 'dulo',
  zlive: 'zlive',
};

export const PLAYLIST_CONFIG_KEYS = Object.keys(PLAYLIST_CONFIG_SOURCES) as PlaylistConfigKey[];

/** The same bound the per-channel player override accepts (routes/playlists.ts playerPref). */
const DLHD_PLAYER_LIMIT = 12;

/** The shipped defaults. A fresh object per call — callers (and Mongoose's Mixed default) may mutate it. */
export function defaultPlaylistConfig(): PlaylistConfig {
  return {
    daddylive: { enable: true, domain: DLHD_DEFAULT_DOMAIN, extendedProperties: { defaultPlayer: 'auto' } },
    dulo: { enable: true, domain: DULO_DEFAULT_DOMAIN, extendedProperties: {} },
    zlive: { enable: true, domain: ZLIVE_DEFAULT_DOMAIN, extendedProperties: { concurrency: ZLIVE_DEFAULT_MAX_STREAMS } },
  };
}

// ── Validation ──────────────────────────────────────────────────────────────────────────────────────────

type FieldParse = { ok: true; value: unknown } | { ok: false; error: string };

interface ExtendedSpec {
  default: unknown;
  parse(v: unknown): FieldParse;
}

// Each source's extendedProperties: the allowed keys, their defaults and their parsers. A key absent from the
// operator's JSON takes its default; a key not listed here is an error.
const EXTENDED: Readonly<Record<PlaylistConfigKey, Readonly<Record<string, ExtendedSpec>>>> = {
  daddylive: {
    defaultPlayer: {
      default: 'auto',
      parse: (v) =>
        v === 'auto' || (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= DLHD_PLAYER_LIMIT)
          ? { ok: true, value: v }
          : { ok: false, error: `"auto" or an integer 1..${DLHD_PLAYER_LIMIT}` },
    },
  },
  dulo: {},
  zlive: {
    concurrency: {
      default: ZLIVE_DEFAULT_MAX_STREAMS,
      parse: (v) =>
        typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= ZLIVE_MAX_STREAMS_LIMIT
          ? { ok: true, value: v }
          : { ok: false, error: `an integer 0..${ZLIVE_MAX_STREAMS_LIMIT} (0 = no limit)` },
    },
  },
};

const ENTRY_FIELDS = ['enable', 'domain', 'extendedProperties'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export type PlaylistConfigParse = { ok: true; config: PlaylistConfig } | { ok: false; errors: string[] };

/**
 * Validate an operator-supplied config into the canonical shape (domains normalized, missing extended properties
 * defaulted). Strict: every source key is required, and an unknown key at any level is an error — a typo must not
 * silently become a no-op. Every error names its path, e.g. "zlive.extendedProperties.concurrency: …".
 */
export function validatePlaylistConfig(input: unknown): PlaylistConfigParse {
  if (!isPlainObject(input)) return { ok: false, errors: ['the configuration must be a JSON object'] };
  const errors: string[] = [];

  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(PLAYLIST_CONFIG_SOURCES, key)) {
      errors.push(`${key}: unknown playlist (expected ${PLAYLIST_CONFIG_KEYS.join(', ')})`);
    }
  }

  const out: Record<string, PlaylistSourceConfig<Record<string, unknown>>> = {};
  for (const key of PLAYLIST_CONFIG_KEYS) {
    const entry = input[key];
    if (entry === undefined) {
      errors.push(`${key}: missing — keep the entry and set "enable": false to hide it`);
      continue;
    }
    if (!isPlainObject(entry)) {
      errors.push(`${key}: must be an object`);
      continue;
    }
    for (const field of Object.keys(entry)) {
      if (!ENTRY_FIELDS.includes(field)) {
        errors.push(`${key}.${field}: unknown property (expected ${ENTRY_FIELDS.join(', ')})`);
      }
    }

    let enable = true;
    if (typeof entry.enable === 'boolean') enable = entry.enable;
    else errors.push(`${key}.enable: must be true or false`);

    let domain = '';
    if (typeof entry.domain !== 'string') {
      errors.push(`${key}.domain: must be a string`);
    } else {
      const parsed = normalizeDomain(entry.domain, key);
      if (parsed.ok) domain = parsed.domain;
      else errors.push(`${key}.domain: ${parsed.error}`);
    }

    const specs = EXTENDED[key];
    const extended: Record<string, unknown> = {};
    const rawExt = entry.extendedProperties === undefined ? {} : entry.extendedProperties;
    if (!isPlainObject(rawExt)) {
      errors.push(`${key}.extendedProperties: must be an object`);
    } else {
      const allowed = Object.keys(specs);
      for (const field of Object.keys(rawExt)) {
        if (!Object.hasOwn(specs, field)) {
          errors.push(
            `${key}.extendedProperties.${field}: unknown property ` +
              (allowed.length ? `(expected ${allowed.join(', ')})` : `(${key} has none)`),
          );
        }
      }
      for (const [field, spec] of Object.entries(specs)) {
        if (rawExt[field] === undefined) {
          extended[field] = spec.default;
          continue;
        }
        const parsed = spec.parse(rawExt[field]);
        if (parsed.ok) extended[field] = parsed.value;
        else errors.push(`${key}.extendedProperties.${field}: ${parsed.error}`);
      }
    }

    out[key] = { enable, domain, extendedProperties: extended };
  }

  return errors.length ? { ok: false, errors } : { ok: true, config: out as unknown as PlaylistConfig };
}

// ── Legacy migration ────────────────────────────────────────────────────────────────────────────────────

/** The Settings fields the playlist configuration replaced. */
export const LEGACY_PLAYLIST_FIELDS = ['dlhdPlayer', 'duloDomain', 'zliveDomain', 'zliveMaxStreams'] as const;

/** dulo's old default, which stopped resolving entirely (a hard cut-over) — never carried forward. */
const DEAD_DULO_DOMAIN = 'dulo.tv';

/**
 * Build the config from the four Settings fields it replaces (dlhdPlayer, duloDomain, zliveDomain,
 * zliveMaxStreams), for a doc written before playlistConfig existed. Anything absent or invalid takes the default;
 * daddylive's domain always does (it was never a setting — the mirror was auto-picked).
 */
export function playlistConfigFromLegacy(legacy: Record<string, unknown>): PlaylistConfig {
  const cfg = defaultPlaylistConfig();
  const player = legacy.dlhdPlayer;
  if (typeof player === 'number' && Number.isInteger(player) && player >= 1 && player <= DLHD_PLAYER_LIMIT) {
    cfg.daddylive.extendedProperties.defaultPlayer = player;
  }
  if (typeof legacy.duloDomain === 'string') {
    const parsed = normalizeDomain(legacy.duloDomain, 'dulo');
    if (parsed.ok && parsed.domain !== DEAD_DULO_DOMAIN) cfg.dulo.domain = parsed.domain;
  }
  if (typeof legacy.zliveDomain === 'string') {
    const parsed = normalizeDomain(legacy.zliveDomain, 'zlive');
    if (parsed.ok) cfg.zlive.domain = parsed.domain;
  }
  const cap = legacy.zliveMaxStreams;
  if (typeof cap === 'number' && Number.isInteger(cap) && cap >= 0 && cap <= ZLIVE_MAX_STREAMS_LIMIT) {
    cfg.zlive.extendedProperties.concurrency = cap;
  }
  return cfg;
}

/**
 * Upgrade a RAW Settings document (a backup envelope's row) written before playlistConfig existed: fold the legacy
 * fields into playlistConfig — unless it already carries one — and drop them. Pure; returns the same object when
 * there is nothing to upgrade. The restore path needs this BEFORE the write: Mongoose's strict mode strips the
 * retired fields on insert, so a boot-time migration would never see them.
 */
export function upgradeLegacySettingsDoc(doc: Record<string, unknown>): Record<string, unknown> {
  const hasLegacy = LEGACY_PLAYLIST_FIELDS.some((f) => Object.hasOwn(doc, f));
  const needsConfig = doc.playlistConfig === undefined || doc.playlistConfig === null;
  if (!hasLegacy && !needsConfig) return doc;
  const out: Record<string, unknown> = { ...doc };
  if (needsConfig) out.playlistConfig = playlistConfigFromLegacy(doc);
  for (const f of LEGACY_PLAYLIST_FIELDS) delete out[f];
  return out;
}

// ── Runtime cache ───────────────────────────────────────────────────────────────────────────────────────

let _config: PlaylistConfig = defaultPlaylistConfig();

/** The active config. Always read at use time. */
export function getPlaylistConfig(): PlaylistConfig {
  return _config;
}

/** The config key that configures a registry source id, or null for a source the config does not cover. */
export function playlistConfigKeyOf(sourceId: string): PlaylistConfigKey | null {
  return PLAYLIST_CONFIG_KEYS.find((k) => PLAYLIST_CONFIG_SOURCES[k] === sourceId) ?? null;
}

/** Is this source enabled (offered in the Add Playlist picker)? A source the config does not cover always is. */
export function isSourceEnabled(sourceId: string): boolean {
  const key = playlistConfigKeyOf(sourceId);
  return key ? _config[key].enable : true;
}

/** What applyPlaylistConfig actually changed — the bridge uses it for the per-source cascades and the logs. */
export interface PlaylistConfigChanges {
  dlhdDomain: boolean;
  dlhdPlayer: boolean;
  duloDomain: boolean;
  zliveDomain: boolean;
  zliveConcurrency: boolean;
  /** Keys whose `enable` flipped. */
  enable: PlaylistConfigKey[];
}

/** Cache a validated config and push every value into its source's config leaf. */
export function applyPlaylistConfig(cfg: PlaylistConfig): PlaylistConfigChanges {
  const prev = _config;
  _config = cfg;

  const prevBase = getDlhdBase();
  const prevPlayer = getPlayerDefault();
  setDlhdBase(`https://${cfg.daddylive.domain}`);
  const player = cfg.daddylive.extendedProperties.defaultPlayer;
  setPlayerDefault(player === 'auto' ? 0 : player);

  const duloDomain = setDuloDomain(cfg.dulo.domain);
  const zliveDomain = setZliveDomain(cfg.zlive.domain);
  const prevCap = getZliveMaxStreams();
  setZliveMaxStreams(cfg.zlive.extendedProperties.concurrency);

  return {
    dlhdDomain: getDlhdBase() !== prevBase,
    dlhdPlayer: getPlayerDefault() !== prevPlayer,
    duloDomain,
    zliveDomain,
    zliveConcurrency: getZliveMaxStreams() !== prevCap,
    enable: PLAYLIST_CONFIG_KEYS.filter((k) => prev[k].enable !== cfg[k].enable),
  };
}

/** The on-disk form: 2-space JSON with a trailing newline (what the Settings editor shows). */
export function serializePlaylistConfig(cfg: PlaylistConfig): string {
  return `${JSON.stringify(cfg, null, 2)}\n`;
}
