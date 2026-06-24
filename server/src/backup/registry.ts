// Backup scope registry — the SINGLE place that declares which Mongoose collections a full-system backup
// captures, in what order they must be restored, and which fields are secrets. Every model module is
// imported here EXPLICITLY (not just transitively via a router) for two reasons: (1) it guarantees the
// model is registered with mongoose so the index-rebuild endpoint can enumerate every collection, and
// (2) it makes this file the one tunable list — change the scope by editing the arrays below, nothing else.
//
// Scope decision (see .claude/plans + schemas.md): the DEFAULT backup is LEAN — configuration + the
// editable channel mappings + auth tokens (CORE_BACKUP_SPECS) — enough to rebuild a system from a blank
// Mongo. The bulky derived data (sourcechannels/epgchannels/programs, HEAVY_BACKUP_SPECS) is excluded by
// default: it repopulates on the next sync. The ephemeral collections (sessions/logs/viewsessions/
// streamsessions) are never backed up (TTL'd / telemetry); they only appear in ALL_MODELS for index rebuild.

import type { Model } from 'mongoose';
import { Settings } from '../models/Settings.js';
import { User } from '../models/User.js';
import { Playlist } from '../models/Playlist.js';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import { EpgSource } from '../models/EpgSource.js';
import { PlaylistAuth } from '../models/PlaylistAuth.js';
import { Cronjob } from '../models/Cronjob.js';
import { VideoConfig } from '../models/VideoConfig.js';
import { SourceChannel } from '../models/SourceChannel.js';
import { EpgChannel } from '../models/EpgChannel.js';
import { Program } from '../models/Program.js';
import { Log } from '../models/Log.js';
import { Session } from '../models/Session.js';
import { StreamSession } from '../models/StreamSession.js';
import { ViewSession } from '../models/ViewSession.js';

export interface BackupSpec {
  // Logical key used both in the on-disk envelope (`collections.<name>`) and the restore counts. Stable
  // across schema changes; NOT necessarily the Mongo collection name.
  name: string;
  model: Model<any>;
  // Ascending dependency order for restore (settings first so playlist URLs/domain are present, etc.).
  restoreOrder: number;
  // Heavy/derived data — only captured when a backup opts into includeHeavy.
  heavy?: boolean;
  // Dotted top-level field names redacted when a backup opts OUT of includeSecrets. (The default backup
  // INCLUDES secrets — a from-nothing restore needs the password hashes + auth tokens to be usable.)
  secretFields?: string[];
}

// Always-included config + editable mappings + auth. restoreOrder enforces the dependency sequence.
export const CORE_BACKUP_SPECS: BackupSpec[] = [
  { name: 'settings', model: Settings, restoreOrder: 10, secretFields: ['maxmindLicenseKey'] },
  { name: 'users', model: User, restoreOrder: 20, secretFields: ['passwordHash', 'streamToken'] },
  { name: 'playlists', model: Playlist, restoreOrder: 30 },
  { name: 'playlistchannels', model: PlaylistChannel, restoreOrder: 40 },
  { name: 'epgsources', model: EpgSource, restoreOrder: 50 },
  { name: 'playlistauths', model: PlaylistAuth, restoreOrder: 60, secretFields: ['accessToken', 'refreshToken'] },
  { name: 'cronjobs', model: Cronjob, restoreOrder: 70 },
  { name: 'videoconfigs', model: VideoConfig, restoreOrder: 80 },
];

// Derived bulk data — excluded from the lean default, captured only when includeHeavy is set. Interleaved
// into the restore sequence by restoreOrder (each just after the config it derives from).
export const HEAVY_BACKUP_SPECS: BackupSpec[] = [
  { name: 'sourcechannels', model: SourceChannel, restoreOrder: 45, heavy: true },
  { name: 'epgchannels', model: EpgChannel, restoreOrder: 55, heavy: true },
  { name: 'programs', model: Program, restoreOrder: 56, heavy: true },
];

// Every registered model — used by POST /api/system/rebuild-indexes to syncIndexes() across the database.
export const ALL_MODELS: Model<any>[] = [
  Settings, User, Playlist, PlaylistChannel, EpgSource, PlaylistAuth, Cronjob, VideoConfig,
  SourceChannel, EpgChannel, Program, Log, Session, StreamSession, ViewSession,
];

// The specs to back up / restore for a given option set, sorted by restoreOrder.
export function backupSpecs(opts: { includeHeavy: boolean }): BackupSpec[] {
  const specs = opts.includeHeavy ? [...CORE_BACKUP_SPECS, ...HEAVY_BACKUP_SPECS] : [...CORE_BACKUP_SPECS];
  return specs.sort((a, b) => a.restoreOrder - b.restoreOrder);
}
