// Provisioning / sync / reset for the established (Default) source playlists.
//
// NO boot-time seeding AND no boot-time auto-provisioning. At startup bootInitSources() reconciles indexes,
// runs idempotent migrations, and seeds the singleton settings doc — but it NO LONGER registers a shell
// Playlist row for every source. A built-in source playlist is now provisioned ON DEMAND, when the user adds
// it via the Add Playlist modal's "Built-In" option (POST /api/sources/:id/provision → ensureShellRow). Once
// added it is a normal zero-channel SHELL row; its channels are populated only on the user's first "Sync now"
// (POST /api/sources/:id/sync → syncLive), and persist in MongoDB thereafter (a reboot is a no-op on an
// already-provisioned/synced row). The committed <id>.snapshot.json is syncLive's offline fallback; reset = a
// full re-fetch (resetSource). EXISTING already-provisioned rows are preserved untouched across this change —
// nothing here deletes a row, and every migration/upsert is keyed by `id` so it no-ops on an absent source.

import { Playlist } from '../models/Playlist.js';
import { PlaylistAuth } from '../models/PlaylistAuth.js';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import { StreamSession } from '../models/StreamSession.js';
import { Settings, SETTINGS_ID } from '../models/Settings.js';
import { SourceChannel, type SourceChannelDoc } from '../models/SourceChannel.js';
import { EpgSource } from '../models/EpgSource.js';
import { Cronjob } from '../models/Cronjob.js';
import { getSource } from './registry.js';
import { buildSource } from './core/buildSource.js';
import { logger } from './core/logger.js';
import { seedSettings } from './seedSettings.js';
import { envDefaults } from '../settings/translate.js';
import { toPlaylistChannelDoc } from './toPlaylistChannel.js';
import type { SourceAdapter } from './types.js';

// A (Default)/Global playlist is no longer "hosted" at a single canonical file — the m3u compose writes
// only per-user files (compose/_global/m3u/<username>-<slug>.m3u). So a Global playlist's `url` is just the
// bare operator origin (no path, no trailing slash); per-user URLs are built from it by the SPA. See
// .claude/skills/m3u/SKILL.md §7.

// The Global hosted url from the persisted settings.domain (seeded before the per-source loop): the bare
// origin, trailing slash stripped.
async function globalHostedUrl(): Promise<string> {
  const s = await Settings.findOne({ _id: SETTINGS_ID }, { domain: 1 }).lean();
  return (s?.domain ?? envDefaults().domain).replace(/\/+$/, '');
}

// One-time, idempotent migration: lowercase the source-type / origination / endpoint values on any
// pre-normalization Playlist doc AND the EPG source-KIND discriminator on any pre-normalization EpgSource
// doc, PLUS the FIXED schedule-interval enum values on both (the repo-wide normalization). Registry-driven
// source playlists already store lowercase ids (dulo/dlhd/tubi); only the user-composed type tags
// ('Clone'/'Import'/'HDHomeRun') and the endpoint hosting mode ('Global'/'Custom') were ever capitalized.
// For EPG sources only the two upstream providers ('Gracenote'/'EPG-PW') were capitalized — tubi/dlhd/xml
// file/remote url were always lowercase. For the interval, only the three fixed enums ('None'/'Manual'/
// 'Auto-updated') were capitalized; the free-form friendly labels are left intact (see below). Source rows
// repopulate on first sync (so a fresh DB has nothing to migrate) but user-composed Clone/Import/HDHomeRun
// playlists and user-created EPG sources are persistent, so their stale capitalized tags WILL exist and must
// be rewritten. Each updateMany is keyed by the exact stale casing → a no-op once the DB is clean (and on a
// fresh install). Non-fatal: a failure must never crash boot.
async function normalizeSourceTypeCasing(): Promise<void> {
  // source TYPE TAGS (only the user-composed ones were capitalized; adapter ids are already lowercase).
  const sourceTagMap: Array<[string, string]> = [
    ['Clone', 'clone'],
    ['Import', 'import'],
    ['HDHomeRun', 'hdhomerun'],
  ];
  for (const [from, to] of sourceTagMap) {
    const r = await Playlist.updateMany({ source: from }, { $set: { source: to } });
    if (r.modifiedCount) logger.info('seed', `normalized ${r.modifiedCount} playlist source '${from}' → '${to}'`);
  }
  // endpoint hosting mode.
  const endpointMap: Array<[string, string]> = [
    ['Global', 'global'],
    ['Custom', 'custom'],
  ];
  for (const [from, to] of endpointMap) {
    const r = await Playlist.updateMany({ endpoint: from }, { $set: { endpoint: to } });
    if (r.modifiedCount) logger.info('seed', `normalized ${r.modifiedCount} playlist endpoint '${from}' → '${to}'`);
  }
  // EPG source KIND discriminator (epgsources.source). EPG sources are user-created persistent rows, so
  // stale capitalized provider tags WILL exist; the lowercase canonical is the sync-dispatch/scheduler key.
  // tubi/dlhd/xml file/remote url were already lowercase — only the two upstream providers were capitalized.
  const epgKindMap: Array<[string, string]> = [
    ['Gracenote', 'gracenote'],
    ['EPG-PW', 'epg-pw'],
  ];
  for (const [from, to] of epgKindMap) {
    const r = await EpgSource.updateMany({ source: from }, { $set: { source: to } });
    if (r.modifiedCount) logger.info('seed', `normalized ${r.modifiedCount} epg source kind '${from}' → '${to}'`);
  }

  // Schedule INTERVAL discriminator enums (playlists.interval AND epgsources.interval). Only the three FIXED
  // enum values were ever capitalized ('None' = clone/import/hdhomerun no-schedule; 'Manual' = manual sync;
  // 'Auto-updated' = the built-in source shell default); the friendly free-form labels (summarizeFrequency
  // output, e.g. 'Every 6 hours' / 'Daily at 03:00') are LEFT UNTOUCHED — each updateMany is keyed by the
  // EXACT stale casing so it never matches (and never corrupts) a free-form value and is a no-op once clean.
  const intervalMap: Array<[string, string]> = [
    ['None', 'none'],
    ['Manual', 'manual'],
    ['Auto-updated', 'auto-updated'],
  ];
  for (const [from, to] of intervalMap) {
    const rp = await Playlist.updateMany({ interval: from }, { $set: { interval: to } });
    if (rp.modifiedCount) logger.info('seed', `normalized ${rp.modifiedCount} playlist interval '${from}' → '${to}'`);
    const re = await EpgSource.updateMany({ interval: from }, { $set: { interval: to } });
    if (re.modifiedCount) logger.info('seed', `normalized ${re.modifiedCount} epg source interval '${from}' → '${to}'`);
  }
}

// One-time, idempotent rename of the self-EPG source DISPLAY names to their current human-readable values.
// The tubi/dlhd self-EPG rows are created by their playlist-sync afterSync hooks (upsertTubiEpgSource /
// upsertDlhdEpgSource), which $set `name` from the current code — so a fresh row already carries the new
// name and a playlist re-sync also corrects an old one. This migration just brings EXISTING rows current
// WITHOUT waiting for that next sync. Keyed by the EXACT old name → a no-op once renamed / on a fresh DB.
// Matched by the stable `source` kind discriminator (NOT the name) so a user rename via PUT isn't reverted
// unless it's still the literal old default. Non-fatal: a failure must never crash boot.
async function renameSelfEpgSources(): Promise<void> {
  const renames: Array<{ source: string; from: string; to: string }> = [
    { source: 'tubi', from: 'tubi', to: 'Tubi TV Schedule' },
    { source: 'dlhd', from: 'DaddyLive Schedule', to: 'DaddyLive TV Schedule' },
  ];
  for (const { source, from, to } of renames) {
    const r = await EpgSource.updateMany({ source, name: from }, { $set: { name: to } });
    if (r.modifiedCount) logger.info('seed', `renamed ${r.modifiedCount} '${source}' epg source name '${from}' → '${to}'`);
  }
}

// One-time, idempotent rename of the built-in (Default) source playlists' DISPLAY names to their current
// adapter labels. The `name` field is seeded once from `adapter.label` via $setOnInsert (so a re-sync never
// clobbers a user rename) — which means a label change in the adapter only takes effect on a FRESH provision.
// This migration brings EXISTING already-provisioned shell/source rows current. Matched by the stable `id`
// (registry source id, NEVER renamed) AND keyed by the EXACT old default name → a no-op once renamed / on a
// fresh DB, and it never reverts a user's custom rename (their name no longer equals the old default). The
// `from` is the previous bare-id label; `to` mirrors the adapter.label set in adapters/<id>.ts. Non-fatal.
async function renameSourcePlaylists(): Promise<void> {
  const renames: Array<{ id: string; from: string; to: string }> = [
    { id: 'dulo', from: 'dulo', to: 'Dulo.TV' },
    { id: 'dlhd', from: 'dlhd', to: 'DaddyLive.TV' },
    { id: 'tubi', from: 'tubi', to: 'Tubi.TV' },
  ];
  for (const { id, from, to } of renames) {
    const r = await Playlist.updateMany({ id, name: from }, { $set: { name: to } });
    if (r.modifiedCount) logger.info('seed', `renamed ${r.modifiedCount} '${id}' playlist name '${from}' → '${to}'`);
  }
}

// One-time, idempotent seed of the EPG-source list-order ordinal (epgsources.order — the drag-to-reorder
// position). Legacy/pre-field rows all default to 0, which would make their list order non-deterministic on a
// first drag; this assigns each a stable distinct ordinal (current name order) IFF every row still sits at 0
// (i.e. the user has never reordered). Once any row has a non-zero order the user has taken control and this
// is a no-op. Non-fatal: a failure must never crash boot. Only runs when there are ≥2 rows all at order 0.
async function seedEpgSourceOrder(): Promise<void> {
  const distinct = (await EpgSource.distinct('order')) as number[];
  // If any row already carries a non-zero order the list has been reordered — leave it alone.
  if (distinct.some((o) => typeof o === 'number' && o !== 0)) return;
  const rows = (await EpgSource.find({}, { id: 1, _id: 0 }).sort({ name: 1 }).lean()) as { id: string }[];
  if (rows.length < 2) return; // 0 or 1 row → nothing meaningful to order
  const ops = rows.map((r, i) => ({ updateOne: { filter: { id: r.id }, update: { $set: { order: i } } } }));
  await EpgSource.bulkWrite(ops);
  logger.info('seed', `seeded list order on ${rows.length} epg sources (name order)`);
}

// One-time, idempotent backfill of the playlistBinding flag onto the self-EPG rows (tubi/dlhd/dami) created by
// a playlist's afterSync BEFORE the field existed. The upsert{Tubi,Dlhd,Dami}EpgSource hooks now $set
// playlistBinding:true on every sync — so a fresh row already carries it and a playlist re-sync corrects an
// old one; this brings EXISTING rows current WITHOUT waiting for that next sync. Matched by the stable
// `source` kind discriminator; the `$ne: true` guard makes it a no-op once set / on a fresh DB. Non-fatal.
async function backfillPlaylistBinding(): Promise<void> {
  const r = await EpgSource.updateMany(
    { source: { $in: ['tubi', 'dlhd', 'dami'] }, playlistBinding: { $ne: true } },
    { $set: { playlistBinding: true } },
  );
  if (r.modifiedCount) logger.info('seed', `backfilled playlistBinding on ${r.modifiedCount} self-epg source(s)`);
}

// One-time, idempotent purge of the retired 'epg-xml' compose cronjobs. The EPG-XML compose SCHEDULE was
// removed (the scheduler no longer dispatches an 'epg-xml' target and the UI no longer creates one), so any
// persisted job is an orphan. Delete them at boot — this runs BEFORE startScheduler() (index.ts), so the
// deleted docs are never loaded into the in-memory Cron map. Keyed by targetType → a no-op once clean / on a
// fresh DB. Non-fatal: a failure must never crash boot.
async function purgeEpgXmlCronjobs(): Promise<void> {
  const r = await Cronjob.deleteMany({ targetType: 'epg-xml' });
  if (r.deletedCount) logger.info('seed', `purged ${r.deletedCount} retired epg-xml compose cronjob(s)`);
}

export interface IntegrityReport {
  id: string;
  playlistExists: boolean;
  channelCount: number;
  ok: boolean;
  issues: string[];
}

function groupCount(docs: SourceChannelDoc[]): number {
  return new Set(docs.map((d) => d.groupKey)).size;
}

// Surface bulkWrite write errors (e.g. a stale/legacy unique index colliding inserts on a shared key)
// as a clear, counted log line instead of an opaque aggregate error that the non-fatal boot wrapper
// swallows. Rethrows so callers keep their existing control flow.
function describeWriteError(err: unknown, total: number): string {
  const e = err as {
    writeErrors?: Array<{ code?: number; errmsg?: string; err?: { code?: number; errmsg?: string } }>;
    message?: string;
  };
  const we = e.writeErrors;
  if (Array.isArray(we) && we.length) {
    const first = we[0];
    const code = first.code ?? first.err?.code ?? '?';
    const msg = first.errmsg ?? first.err?.errmsg ?? '';
    return `${we.length} of ${total} writes failed (first: ${code}${msg ? ` ${msg}` : ''})`;
  }
  return `bulk write failed: ${e.message ?? String(err)}`;
}

async function bulkWriteChannels(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: { bulkWrite(ops: any[], opts?: { ordered?: boolean }): Promise<unknown> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ops: any[],
  store: string,
  source: string,
): Promise<void> {
  try {
    await model.bulkWrite(ops, { ordered: false });
  } catch (err) {
    logger.warn('seed', `[${source}] ${store}: ${describeWriteError(err, ops.length)}`);
    throw err;
  }
}

// Idempotent upsert by _id. Strips _id from $set (immutable; supplied by the filter on insert).
async function upsertChannels(docs: SourceChannelDoc[]): Promise<void> {
  if (!docs.length) return;
  const ops = docs.map((d) => {
    const { _id, ...rest } = d;
    return { updateOne: { filter: { _id }, update: { $set: rest }, upsert: true } };
  });
  await bulkWriteChannels(SourceChannel, ops, 'sourcechannels', docs[0]?.source ?? 'unknown');
}

// Upsert the editable PlaylistChannel store from the source docs, PRESERVING USER EDITS. Source-derived
// volatile fields (logo, stream url, playability, derived initials/color) go in $set (refreshed every sync);
// user-editable fields (status governor, name, group, channel#, channelNo, tvg_id, epg) go in $setOnInsert (written
// once, never clobbered). The two never touch the same path. A vanished channel is pruned in syncLive (its
// edits go with it — the channel is gone); a full reset (Restore Defaults) rebuilds from scratch.
async function upsertPlaylistChannels(docs: SourceChannelDoc[]): Promise<void> {
  if (!docs.length) return;
  const ops = docs.map((d) => {
    const pc = toPlaylistChannelDoc(d);
    // First-sync default disable (e.g. dlhd "18+"): flip the seeded status BEFORE it goes into
    // $setOnInsert. Re-syncs never re-evaluate this (status isn't in $set), so user Enable/Disable wins.
    if (pc.status === 'Active' && getSource(d.source)?.defaultDisabled?.(d)) {
      pc.status = 'Disabled';
    }
    return {
      updateOne: {
        filter: { _id: pc._id },
        update: {
          $set: {
            source: pc.source,
            logoColor: pc.logoColor,
            logoUrl: pc.logoUrl,
            streamEntryUrl: pc.streamEntryUrl,
            'stream.initials': pc.stream.initials,
            'stream.isPlayable': pc.stream.isPlayable,
          },
          $setOnInsert: {
            id: pc.id,
            tvg_name: pc.tvg_name,
            group: pc.group,
            channel: pc.channel,
            channelNo: pc.channelNo,
            tvg_id: pc.tvg_id,
            epg: pc.epg,
            epgState: pc.epgState,
            status: pc.status,
            'stream.res': pc.stream.res,
            'stream.status': pc.stream.status,
            // Written-once null; the live probe (set by the proxy sink) is preserved across re-syncs.
            'stream.probe': pc.stream.probe,
          },
        },
        upsert: true,
      },
    };
  });
  await bulkWriteChannels(PlaylistChannel, ops, 'playlistchannels', docs[0]?.source ?? 'unknown');
}

async function upsertPlaylistRow(
  adapter: SourceAdapter,
  groups: number,
  opts: { lastSync: string; status: string },
): Promise<void> {
  // Sync-managed fields are refreshed every run. The user-editable fields (name / state / endpoint / url)
  // are written only on first provisioning (or to migrate a legacy `source://<id>` sentinel url) so a
  // re-sync never clobbers an operator's rename / Active / endpoint / url choice. A `domain` change rewrites
  // url via the settings cascade (routes/settings.ts → cascadePlaylistUrls), not here.
  const syncManaged = {
    source: adapter.id,
    // `name` is NOT refreshed here — it is a user-editable display rename (PUT /api/playlists/:id),
    // seeded once from the adapter label via $setOnInsert below so a re-sync never clobbers an edit.
    groups,
    lastSync: opts.lastSync,
    status: opts.status,
    builtin: true,
    // Source-intrinsic: does this playlist require auth to stream? Refreshed every run from the adapter.
    authentication: !!adapter.requiresAuth,
  };
  const existing = await Playlist.findOne(
    { id: adapter.id },
    { state: 1, endpoint: 1, url: 1 },
  ).lean();
  const needsUserDefaults =
    !existing || !existing.endpoint || (existing.url ?? '').startsWith('source://');
  const userFields = needsUserDefaults
    ? {
        state: existing?.state ?? true,
        endpoint: existing?.endpoint ?? 'global',
        url: await globalHostedUrl(),
      }
    : {};
  await Playlist.updateOne(
    { id: adapter.id },
    {
      $set: { ...syncManaged, ...userFields },
      // Write-once defaults the operator owns thereafter, so a re-sync never clobbers them:
      //   • interval/auto — the schedule label + interval-type, set by PlaylistStatusDrawer → PUT
      //     /api/playlists/:id when a sync schedule is saved (the chip itself derives live from the cron job).
      //   • isAuthenticated — the auth-status mirror; the auth lifecycle (PlaylistAuthState.save) owns it
      //     after the first set, so a re-sync must never reset a live `true` back to `false`.
      //   • name — seeded once from the adapter label; a user rename (PUT /api/playlists/:id) then owns it.
      $setOnInsert: { name: `${adapter.label}`, interval: 'auto-updated', auto: true, isAuthenticated: false },
    },
    { upsert: true },
  );
}

export async function validateIntegrity(id: string): Promise<IntegrityReport> {
  const issues: string[] = [];
  const playlist = await Playlist.findOne({ id }).lean();
  // channelCount reflects the SURFACED store (PlaylistChannel) — what the UI lists. Also sanity-check the
  // pristine reference store (SourceChannel) it is seeded from.
  const channelCount = await PlaylistChannel.countDocuments({ source: id });
  const sourceCount = await SourceChannel.countDocuments({ source: id });
  if (!playlist) issues.push('playlist row missing');
  if (channelCount === 0) issues.push('no channels');
  if (sourceCount === 0) issues.push('no source reference channels');
  const sample = await PlaylistChannel.findOne({ source: id }).lean();
  if (sample) {
    for (const f of ['tvg_name', 'streamEntryUrl', 'status'] as const) {
      if (!sample[f]) issues.push(`a channel is missing required field "${f}"`);
    }
  }
  return { id, playlistExists: !!playlist, channelCount, ok: issues.length === 0, issues };
}

/**
 * Register a (Default) source playlist as a lightweight SHELL row at boot — identity only, ZERO channels.
 * Channels are populated on the user's first "Sync now" (POST /api/sources/:id/sync → syncLive). The
 * identity / source-intrinsic fields ($set) refresh every boot; the sync-state + user fields ($setOnInsert)
 * are written once, so a reboot never resets an already-synced row's lastSync/status/groups or an
 * operator's name/state/endpoint/url (a user rename via PUT /api/playlists/:id survives restart/re-sync).
 * `channels` is computed by the playlists route (count of PlaylistChannel), so it reads 0 until the first sync.
 */
export async function ensureShellRow(adapter: SourceAdapter): Promise<void> {
  await Playlist.updateOne(
    { id: adapter.id },
    {
      $set: {
        source: adapter.id,
        builtin: true,
        // Source-intrinsic: does this playlist require auth to stream? Refreshed every boot from the adapter.
        authentication: !!adapter.requiresAuth,
      },
      // Written once at provisioning; a re-sync (upsertPlaylistRow) owns lastSync/status/groups thereafter,
      // and the operator owns name/state/endpoint/url. `idle` = the never-synced dot (neutral, no pulse).
      // `name` is seeded once from the adapter label; a user rename (PUT /api/playlists/:id) then owns it
      // and neither a reboot nor a re-sync overwrites it.
      $setOnInsert: {
        name: `${adapter.label}`,
        status: 'idle',
        lastSync: 'Never',
        groups: 0,
        auto: true,
        interval: 'auto-updated',
        state: true,
        endpoint: 'global',
        url: await globalHostedUrl(),
        isAuthenticated: false,
      },
    },
    { upsert: true },
  );
  logger.info('seed', `[${adapter.id}] registered (Default) playlist shell row`);
}

/**
 * "Restore defaults" = a full re-fetch (no committed bundle anymore). Drop the source's channels from both
 * stores (clearing any user edits, by design), then rebuild from a live sync (snapshot fallback when
 * offline). Replaces the old bundle-based resetFromBundle.
 */
export async function resetSource(
  id: string,
): Promise<{ report: IntegrityReport; live: boolean; count: number }> {
  const adapter = getSource(id);
  if (!adapter) throw new Error(`unknown source: ${id}`);
  await SourceChannel.deleteMany({ source: id });
  await PlaylistChannel.deleteMany({ source: id });
  logger.info('seed', `[${id}] cleared channels — re-syncing from upstream`);
  return syncLive(id);
}

/** Live refresh: run the adapter's build pipeline, upsert, then prune vanished channels (live only). */
export async function syncLive(
  id: string,
): Promise<{ report: IntegrityReport; live: boolean; count: number }> {
  const adapter = getSource(id);
  if (!adapter) throw new Error(`unknown source: ${id}`);
  const result = await buildSource(adapter);
  await upsertChannels(result.docs);
  await upsertPlaylistChannels(result.docs); // preserves user edits ($setOnInsert); see the helper

  // Self-heal: drop channels that vanished upstream. dulo periodically reissues its WHOLE catalog with
  // fresh ids, so a pure upsert accumulates orphans (e.g. an old 102-channel catalog + a new 74-channel
  // one = 176 rows). Prune any source:id doc whose _id isn't in this run's live set — from BOTH the
  // reference store and the surfaced store (a pruned channel's user edits go with it; the channel is gone).
  //   Guard: only on a genuinely LIVE result with docs. A snapshot fallback (offline / upstream blip)
  //   must NEVER prune — that would delete real channels down to the stale baseline. Full-replace stays
  //   the job of resetSource; this only removes what a live upstream no longer lists.
  let removed = 0;
  if (result.live && result.docs.length > 0) {
    const liveIds = result.docs.map((d) => d._id);
    const del = await SourceChannel.deleteMany({ source: id, _id: { $nin: liveIds } });
    await PlaylistChannel.deleteMany({ source: id, _id: { $nin: liveIds } });
    removed = del.deletedCount ?? 0;
  }

  await upsertPlaylistRow(adapter, groupCount(result.docs), {
    lastSync: new Date().toISOString(),
    status: result.live ? 'good' : 'warn',
  });

  // Source-agnostic post-sync hook: a source that bundles more than streamable channels (tubi: its own
  // EPG + the self-link of its playlistchannels to that guide) does that work here, off the SAME listing
  // this run already fetched. Non-fatal — an EPG hiccup must never fail the channel sync that succeeded.
  try {
    await adapter.afterSync?.({ raw: result.raw, live: result.live, sourceId: id });
  } catch (err) {
    logger.warn('seed', `[${id}] afterSync hook failed (continuing): ${(err as Error).message}`);
  }

  logger.ok(
    'seed',
    `[${id}] live sync upserted ${result.count} channels${removed ? `, pruned ${removed} stale` : ''} (${result.live ? 'live' : 'snapshot'})`,
  );
  const report = await validateIntegrity(id);
  return { report, live: result.live, count: result.count };
}

/**
 * Run once at startup. Reconcile indexes (repurposed collections), run the idempotent data migrations, and
 * seed the singleton settings doc from env. It NO LONGER registers a shell Playlist row for every source —
 * built-in source playlists are now provisioned ON DEMAND when the user adds one via the Add Playlist
 * "Built-In" option (POST /api/sources/:id/provision → ensureShellRow). So a fresh/empty DB starts with NO
 * built-in playlist rows; the manifest (GET /api/sources) still enumerates the full registry so the modal can
 * offer every built-in. EXISTING already-provisioned rows are preserved (every migration is keyed by `id` and
 * no-ops on an absent source; nothing here deletes a row). NOTHING is written to the channel stores and NO
 * live sync runs at boot. Non-fatal throughout: a failure here must never crash boot.
 */
export async function bootInitSources(): Promise<void> {
  // One-time index reconcile (non-fatal). `playlistchannels` was REPURPOSED from a former
  // {playlistId, channelId, order} join table; Mongoose's autoIndex CREATES schema indexes but never
  // DROPS ones that vanished from the schema, so a pre-repurpose database keeps a legacy `unique` index
  // on {playlistId, channelId}. The new docs carry neither field, so every one collides on the (null,
  // null) key — only the first channel inserts, the rest fail E11000 (silently, under ordered:false).
  // syncIndexes() reconciles the collection to the current schema: drops the stale join-table indexes,
  // keeps the two correct ones. Idempotent — a no-op on fresh installs and once a DB is already clean.
  try {
    await PlaylistChannel.syncIndexes();
  } catch (err) {
    logger.warn('seed', `playlistchannels index reconcile failed (continuing): ${(err as Error).message}`);
  }

  // Ensure the playlistauths unique index on `playlistSource` exists (1:1 playlist↔auth). Idempotent and
  // non-fatal; a no-op once present. The collection itself is created lazily on first sign-in / status read.
  try {
    await PlaylistAuth.syncIndexes();
  } catch (err) {
    logger.warn('seed', `playlistauths index reconcile failed (continuing): ${(err as Error).message}`);
  }

  // `streamsessions` is now 1:1 with the streaming channel: one row per channel, UPSERTED under a
  // deterministic `_id` = PlaylistChannel._id (StreamSessionDoc). Reconcile to that shape: (1) drop legacy
  // append-only rows that still carry an auto ObjectId `_id` so they can't linger as duplicates of the new
  // deterministic rows (raw driver query so Mongoose doesn't cast `_id` to String; idempotent — no ObjectId
  // `_id`s remain after the first run); (2) syncIndexes() drops the stale `order`/{channelId,capturedAt}
  // indexes and builds {capturedAt:-1}. Idempotent + non-fatal.
  try {
    await StreamSession.collection.deleteMany({ _id: { $type: 'objectId' } });
    await StreamSession.syncIndexes();
  } catch (err) {
    logger.warn('seed', `streamsessions reconcile failed (continuing): ${(err as Error).message}`);
  }

  // One-time source-type/endpoint casing normalization (idempotent; non-fatal). Rewrites any persistent
  // user-composed Clone/Import/HDHomeRun row (and any pre-normalization Global/Custom endpoint) to the
  // canonical lowercase value so the lowercase read/branch/query sites match existing data.
  try {
    await normalizeSourceTypeCasing();
  } catch (err) {
    logger.warn('seed', `source-type casing normalize failed (continuing): ${(err as Error).message}`);
  }

  // Bring existing tubi/dlhd self-EPG rows to their current display names (idempotent; a no-op once renamed
  // or on a fresh DB). Non-fatal.
  try {
    await renameSelfEpgSources();
  } catch (err) {
    logger.warn('seed', `self-epg rename failed (continuing): ${(err as Error).message}`);
  }

  // Bring existing built-in (Default) source playlist rows to their current adapter-label display names
  // (idempotent; a no-op once renamed, on a fresh DB, or when a user has set their own name). Non-fatal.
  try {
    await renameSourcePlaylists();
  } catch (err) {
    logger.warn('seed', `source playlist rename failed (continuing): ${(err as Error).message}`);
  }

  // Seed the EPG-source drag-order ordinal for legacy rows that all still sit at the default 0 (idempotent;
  // a no-op once the user has reordered, or on a fresh/single-row DB). Non-fatal.
  try {
    await seedEpgSourceOrder();
  } catch (err) {
    logger.warn('seed', `epg source order seed failed (continuing): ${(err as Error).message}`);
  }

  // Backfill the playlistBinding flag onto existing tubi/dlhd self-EPG rows created before the field existed
  // (idempotent; a no-op once set or on a fresh DB). Non-fatal.
  try {
    await backfillPlaylistBinding();
  } catch (err) {
    logger.warn('seed', `playlistBinding backfill failed (continuing): ${(err as Error).message}`);
  }

  // Purge retired 'epg-xml' compose cronjobs (the EPG-XML compose schedule was removed). Runs BEFORE
  // startScheduler() so orphaned jobs are never loaded into the scheduler. Idempotent; non-fatal.
  try {
    await purgeEpgXmlCronjobs();
  } catch (err) {
    logger.warn('seed', `epg-xml cronjob purge failed (continuing): ${(err as Error).message}`);
  }

  // Seed the singleton settings doc from env defaults (non-fatal) — a later on-demand provision (the Add
  // Playlist "Built-In" option → ensureShellRow) reads the provisioned `domain` for the playlist `url`.
  try {
    await seedSettings();
  } catch (err) {
    logger.warn('seed', `settings seed failed (continuing): ${(err as Error).message}`);
  }

  // NOTE: built-in source playlists are NO LONGER auto-registered here. They are provisioned ON DEMAND when
  // the user adds one via the Add Playlist "Built-In" option (POST /api/sources/:id/provision → ensureShellRow).
  // A fresh DB therefore starts with no built-in rows; the GET /api/sources manifest still lists every
  // registered source so the modal can offer them, and any already-provisioned row is left untouched.
}
