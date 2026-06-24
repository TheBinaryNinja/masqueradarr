// M3U composition — turns the editable PlaylistChannel store into stream-ready EXTM3U files on disk.
// DB-aware (reads Playlist + PlaylistChannel + Settings.domain) but source-AGNOSTIC: the URL line is
// always the /api/ext/v1 externalPlayer proxy path (this M3U is for third-party IPTV clients; serialize.ts
// builds it), so there is no per-source branching here (SKILL.md §6). Two trigger
// paths share this core: the manual button (POST /api/playlists/:id/compose) and the scheduled
// `playlist-m3u` cron tick — both call composeM3u(). See .claude/skills/m3u/SKILL.md.
//
// PER-USER ONLY: there is NO canonical playlist.m3u and NO canonical 1:1 Custom file. compose writes ONLY
// per-user files — one per users-collection account WITH access (Global: scoped to allowedPlaylists;
// Custom: gated on admin || allowedCustomPlaylists.includes(id)). Zero users with access → nothing is
// written and any stale per-user file is pruned. Layout (SKILL §7):
//   _global/m3u/<username>-<slug>.m3u          the Global union, per user
//   custom/<customPath>/<username>-<slug>.m3u   one Custom playlist, per user (<customPath> = normalized url)

import { resolve, sep } from 'node:path';
import type { HydratedDocument } from 'mongoose';
import { logger } from '../sources/core/logger.js';
import { Playlist } from '../models/Playlist.js';
import { PlaylistChannel, type PlaylistChannelDoc } from '../models/PlaylistChannel.js';
import { Settings, SETTINGS_ID } from '../models/Settings.js';
import { User, type UserDoc } from '../models/User.js';
import { generateSlug } from '../security/crypto.js';
import { envDefaults } from '../settings/translate.js';
import { SOURCES } from '../sources/registry.js';
import { composeDir } from '../paths.js';
import { normalizeEndpointPath, channelSourceKey } from './paths.js';
import { channelToExtinf, m3uHeader } from './serialize.js';
import { withPathLock, atomicWrite, pruneFile } from './atomicFile.js';
import { composeGuide, pruneGuide } from '../epg/composeGuide.js';
import { GLOBAL_GUIDE_PATH, customGuidePath } from '../epg/guidePaths.js';

type UserHydrated = HydratedDocument<UserDoc>;

export interface ComposeResult {
  endpoint: 'global' | 'custom';
  path: string;
  channelCount: number;
  bytes: number;
}

// The minimal lean Playlist shape this module reads.
interface PlaylistLite {
  id: string;
  url: string;
  endpoint?: string;
  state?: boolean;
  source?: string | null;
}

// Registry order index for the cross-source Global union (then group → tvg_name within each source).
const sourceOrder = new Map(SOURCES.map((s, i) => [s.id, i]));

// Resolve the operator domain (settings singleton, env-default fallback) — used to absolutize URL lines.
async function resolveDomain(): Promise<string> {
  const s = await Settings.findOne({ _id: SETTINGS_ID }, { domain: 1 }).lean();
  return (s?.domain ?? envDefaults().domain).replace(/\/+$/, '');
}

// A source's Active channels in the canonical UI order (group → tvg_name) — the same sort the channels
// route applies (routes/playlists.ts).
async function activeChannels(source: string): Promise<PlaylistChannelDoc[]> {
  return PlaylistChannel.find({ source, status: 'Active' }, { _id: 0 })
    .sort({ group: 1, tvg_name: 1 })
    .lean<PlaylistChannelDoc[]>();
}

// The TWO-LEVEL inclusion gate (SKILL.md §5), applied as a single boundary so every compose surface
// (Global / Custom / per-user) gates identically:
//   1. PLAYLIST level (checked FIRST) — an Inactive playlist (state === false) contributes ZERO channels,
//      regardless of any channel's individual status. Returns [] before any channel query.
//   2. CHANNEL level (checked SECOND, only for an Active playlist) — only status === 'Active' channels are
//      included (delegated to activeChannels()); a 'Disabled' channel is omitted.
// channelSourceKey() resolves the PlaylistChannel `source` key (its id for a custom type, else its `source`);
// a playlist with no usable key also yields [].
async function playlistActiveChannels(playlist: PlaylistLite): Promise<PlaylistChannelDoc[]> {
  if (playlist.state === false) return []; // (1) Inactive playlist → exclude its entire channel set
  const key = channelSourceKey(playlist);
  if (!key) return [];
  return activeChannels(key); // (2) Active playlist → its Active channels only
}

// The PlaylistChannel `source` key that holds a playlist's channels is shared with the routes (m3u/paths.ts):
// a custom-type playlist ('clone'/'file'/'url'/'hdhomerun', or legacy 'import') stores its channel COPIES under its own id; every
// other playlist's channels are keyed by its own `source`. This is the only custom-awareness the compose core needs.

// Serialize channels into a stream-ready EXTM3U body: LF only, single trailing '\n', UTF-8 (Node writes
// no BOM). Returns the included channel count (entries the serializer accepted). `token` (a user's
// streamToken) is baked into every channel URL — every per-user write passes one (the file downloads
// token-free, but its channel STREAMS need the token at the proxy gate). `guideUrl` (the absolute URL of
// this surface's XMLTV guide sibling) becomes the header's x-tvg-url= so a player auto-discovers the guide.
function serialize(
  channels: PlaylistChannelDoc[],
  domain: string,
  token?: string,
  guideUrl?: string,
): { body: string; count: number } {
  const lines = [m3uHeader(guideUrl ?? null)];
  let count = 0;
  for (const ch of channels) {
    const entry = channelToExtinf(ch, domain, token);
    if (entry) {
      lines.push(entry);
      count++;
    }
  }
  return { body: lines.join('\n') + '\n', count };
}

// ── Per-user playlist files ─────────────────────────────────────────────────
// Each account with access gets its OWN <username>-<slug>.m3u (no canonical file), with their streamToken
// baked into every channel URL. The file downloads without auth (the slug is the unguessable bearer
// secret); the channel STREAMS still require the token (proxy gate). Usernames are charset-validated at
// write time (routes), so they are filesystem-safe; the path-escape guard is defense in depth. The only
// `.` in a per-user filename is the `.m3u` extension (username + slug are joined with a HYPHEN).

// The per-user filename: `<username>-<slug>.m3u`. Username is charset-validated [a-z0-9._-]; slug is the
// random alnum bearer secret — but neither may contain `/`, so the filename can't escape its directory.
function userFileName(username: string, slug: string): string {
  return `${username}-${slug}.m3u`;
}

// The <customPath> for a Custom playlist: normalizeEndpointPath() over its stored url's pathname (drops a
// trailing `…/file.ext` segment, collapses slashes, no leading/trailing slash). Empty when the url has no
// usable path → falls back to 'unknown' so a file is still addressable. See m3u/paths.ts.
function customPathOf(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = '';
  }
  return normalizeEndpointPath(pathname) || 'unknown';
}

// Disk path of a user's Global per-user file: compose/_global/m3u/<username>-<slug>.m3u.
function globalUserM3uPath(username: string, slug: string): string {
  const dir = resolve(composeDir, '_global', 'm3u');
  const abs = resolve(dir, userFileName(username, slug));
  if (!abs.startsWith(dir + sep)) throw new Error('user_path_escapes_compose_dir');
  return abs;
}

// Disk path of a user's per-user Custom file: compose/custom/<customPath>/<username>-<slug>.m3u. The
// per-user file sits DIRECTLY inside the <customPath> directory (no canonical file beside it). Guards
// against a path escaping composeDir.
function customUserM3uPath(url: string, username: string, slug: string): string {
  const abs = resolve(composeDir, 'custom', ...customPathOf(url).split('/'), userFileName(username, slug));
  if (abs !== composeDir && !abs.startsWith(composeDir + sep)) {
    throw new Error('path_escapes_compose_dir');
  }
  return abs;
}

// Lazily backfill a stable slug for a user created before this field existed. Generate-once + persist;
// compose only ever READS the slug after this, so a cron compose never changes a user's filename. Retries
// the astronomically-rare unique-index collision a few times.
async function ensureSlug(user: UserHydrated): Promise<string> {
  if (user.slug) return user.slug;
  for (let attempt = 0; ; attempt++) {
    user.slug = generateSlug();
    try {
      await user.save();
      return user.slug;
    } catch (err) {
      if (attempt < 4 && (err as { code?: number }).code === 11000) continue;
      throw err;
    }
  }
}

// Write (or prune) one user's Global file: their scoped view of the union (admin = full union), token baked.
async function writeUserGlobalFile(
  user: UserHydrated,
  gplaylists: Array<{ id: string; source: string }>,
  bySource: Map<string, PlaylistChannelDoc[]>,
  domain: string,
): Promise<void> {
  const slug = await ensureSlug(user);
  const file = globalUserM3uPath(user.username, slug);
  if (!user.streamTokenEnabled) {
    await withPathLock(file, () => pruneFile(file));
    return;
  }
  const visible =
    user.role === 'admin' ? gplaylists : gplaylists.filter((p) => (user.allowedPlaylists ?? []).includes(p.id));
  const channels: PlaylistChannelDoc[] = [];
  for (const p of visible) channels.push(...(bySource.get(p.source) ?? []));
  const { body } = serialize(channels, domain, user.streamToken, `${domain}${GLOBAL_GUIDE_PATH}`);
  await withPathLock(file, () => atomicWrite(file, body));
}

// Write (or prune) one user's Custom file for a single Custom playlist (membership-gated, token baked).
async function writeUserCustomFile(
  user: UserHydrated,
  target: PlaylistLite,
  channels: PlaylistChannelDoc[],
  domain: string,
): Promise<void> {
  const slug = await ensureSlug(user);
  const file = customUserM3uPath(target.url, user.username, slug);
  const allowed =
    (user.role === 'admin' || (user.allowedCustomPlaylists ?? []).includes(target.id)) &&
    user.streamTokenEnabled &&
    target.state !== false;
  if (!allowed) {
    await withPathLock(file, () => pruneFile(file));
    return;
  }
  const { body } = serialize(channels, domain, user.streamToken, `${domain}${customGuidePath(target.url)}`);
  await withPathLock(file, () => atomicWrite(file, body));
}

// Fan out the Global file to every user — the Global compose's only on-disk output (no canonical file).
async function composeGlobalPerUser(
  gplaylists: Array<{ id: string; source: string }>,
  bySource: Map<string, PlaylistChannelDoc[]>,
  domain: string,
): Promise<void> {
  for (const user of await User.find({})) await writeUserGlobalFile(user, gplaylists, bySource, domain);
}

// Fan out one Custom playlist's file to every user — the Custom compose's only on-disk output.
async function composeCustomPerUser(
  target: PlaylistLite,
  channels: PlaylistChannelDoc[],
  domain: string,
): Promise<void> {
  for (const user of await User.find({})) await writeUserCustomFile(user, target, channels, domain);
}

// Prune every user's per-user file for a Custom url (e.g. the playlist was paused/deleted/renamed).
async function pruneCustomPerUser(url: string): Promise<void> {
  const users = await User.find({}, { username: 1, slug: 1 }).lean<Array<{ username: string; slug?: string }>>();
  for (const u of users) {
    if (!u.slug) continue;
    const file = customUserM3uPath(url, u.username, u.slug);
    await withPathLock(file, () => pruneFile(file));
  }
}

// Compose just ONE user's files across every surface (Global + each Custom they can see). Used by the user
// lifecycle hooks (create / token regen / allowed-list change) so they avoid a full all-users fan-out.
export async function composeUserFiles(user: UserHydrated): Promise<void> {
  const domain = await resolveDomain();

  const gplaylists = (await Playlist.find(
    { endpoint: 'global', state: true, source: { $ne: null } },
    { id: 1, source: 1 },
  ).lean()) as Array<{ id: string; source: string }>;
  gplaylists.sort((a, b) => (sourceOrder.get(a.source) ?? 999) - (sourceOrder.get(b.source) ?? 999));
  const bySource = new Map<string, PlaylistChannelDoc[]>();
  for (const p of gplaylists) if (!bySource.has(p.source)) bySource.set(p.source, await activeChannels(p.source));
  await writeUserGlobalFile(user, gplaylists, bySource, domain);

  const cplaylists = (await Playlist.find({ endpoint: 'custom' }, { _id: 0 }).lean()) as PlaylistLite[];
  for (const c of cplaylists) {
    // Two-level gate: an Inactive Custom playlist yields [] (playlist-level), else its Active channels.
    const channels = await playlistActiveChannels(c);
    await writeUserCustomFile(user, c, channels, domain);
  }
}

// Prune ALL of a user's per-user files (Global + every Custom). Used on user delete and on username rename
// (to remove the old-name files). Needs the slug to reconstruct the filenames.
export async function pruneUserFiles(username: string, slug: string): Promise<void> {
  if (!slug) return; // no slug → this user never had per-user files written
  const gfile = globalUserM3uPath(username, slug);
  await withPathLock(gfile, () => pruneFile(gfile));
  const cplaylists = (await Playlist.find({ endpoint: 'custom' }, { url: 1 }).lean()) as Array<{ url: string }>;
  for (const c of cplaylists) {
    const file = customUserM3uPath(c.url, username, slug);
    await withPathLock(file, () => pruneFile(file));
  }
}

// Emit a surface's XMLTV guide sibling from the SAME channel set the M3U used — best-effort: a guide hiccup
// is logged and swallowed so it never fails the (already-written) M3U compose. The guide advertises itself
// to players via the x-tvg-url serialize() bakes into the M3U header. No per-user guides — every per-user
// .m3u points its x-tvg-url at this one shared guide (a guide may be a superset of a user's channels —
// harmless). See epg/composeGuide.ts.
async function composeGuideSafe(channels: PlaylistChannelDoc[], guideServedPath: string): Promise<void> {
  try {
    await composeGuide(channels, guideServedPath);
  } catch (err) {
    logger.warn('xmltv', `guide compose failed for ${guideServedPath}: ${(err as Error).message}`);
  }
}

// Recompose the Global surface: write each user's per-user file (the union of every Global + Active source
// playlist's Active channels, ordered source(registry) → group → tvg_name, scoped to that user's
// allowedPlaylists; admin = the full union). There is NO canonical playlist.m3u — a user without access (or
// with their token disabled) has their stale file pruned. The shared XMLTV guide is still composed from the
// full union (a guide may be a superset of a user's channels — harmless).
export async function composeGlobal(): Promise<ComposeResult> {
  const domain = await resolveDomain();
  const playlists = (await Playlist.find(
    { endpoint: 'global', state: true, source: { $ne: null } },
    { id: 1, source: 1 },
  ).lean()) as Array<{ id: string; source: string }>;
  playlists.sort((a, b) => (sourceOrder.get(a.source) ?? 999) - (sourceOrder.get(b.source) ?? 999));

  // Cache each source's Active channels once — reused by the shared guide and every per-user file.
  const bySource = new Map<string, PlaylistChannelDoc[]>();
  for (const p of playlists) if (!bySource.has(p.source)) bySource.set(p.source, await activeChannels(p.source));

  const all: PlaylistChannelDoc[] = [];
  for (const p of playlists) all.push(...(bySource.get(p.source) ?? []));

  // The shared XMLTV guide sibling, from the full union (programmes merged across every linked source).
  // Best-effort — never fails the per-user compose. Every per-user file advertises this one guide via
  // x-tvg-url. xmltv owns GLOBAL_GUIDE_PATH; KEPT at its current signature (next-wave URL scheme TBD).
  await composeGuideSafe(all, GLOBAL_GUIDE_PATH);

  // The per-user files (<username>-<slug>.m3u), token-baked + scoped. Each user without access is pruned.
  await composeGlobalPerUser(playlists, bySource, domain);
  return { endpoint: 'global', path: resolve(composeDir, '_global', 'm3u'), channelCount: all.length, bytes: 0 };
}

// Compose one Custom playlist's per-user files (no canonical file). An Inactive Custom endpoint is paused →
// every user's file is pruned so downstream clients 404 (honors SKILL §5 under static serving), and the
// shared guide sibling is pruned. Active → fan out one <username>-<slug>.m3u per user WITH access. The
// guide is composed once from the playlist's channels and advertised by every per-user file's x-tvg-url.
async function composeCustom(target: PlaylistLite, domain: string): Promise<ComposeResult> {
  const dir = resolve(composeDir, 'custom', ...customPathOf(target.url).split('/'));
  const guideServed = customGuidePath(target.url);
  if (target.state === false) {
    await pruneCustomPerUser(target.url);
    await pruneGuide(guideServed); // the paused Custom's guide sibling is pruned too (clients 404)
    return { endpoint: 'custom', path: dir, channelCount: 0, bytes: 0 };
  }
  // target.state === false was already pruned above; playlistActiveChannels re-asserts the playlist-level
  // gate then returns the playlist's Active channels (two-level gate, SKILL §5).
  const channels = await playlistActiveChannels(target);
  // xmltv owns customGuidePath; KEPT at its current signature (next-wave URL scheme TBD). Best-effort.
  await composeGuideSafe(channels, guideServed);
  await composeCustomPerUser(target, channels, domain);
  return { endpoint: 'custom', path: dir, channelCount: channels.length, bytes: 0 };
}

// Compose the export for one (Default) source playlist id. Global target → recompose every user's Global
// file (the shared union, scoped); Custom target → (re)write/prune every user's file for it. Throws
// 'unknown_playlist' if the id doesn't exist (the route maps it to 404; the scheduler records it as lastError).
export async function composeM3u(targetId: string): Promise<ComposeResult> {
  const target = (await Playlist.findOne({ id: targetId }, { _id: 0 }).lean()) as PlaylistLite | null;
  if (!target) throw new Error('unknown_playlist');
  // Case-insensitive so a pre-normalization 'Custom' doc still routes to the Custom compose.
  if ((target.endpoint ?? '').toLowerCase() === 'custom') {
    return composeCustom(target, await resolveDomain());
  }
  return composeGlobal();
}

// Recompose every export surface (the Global union + each Custom) for every user. Used by the settings
// domain cascade: a new domain changes every absolutized channel URL, so all per-user files are stale
// until rebuilt.
export async function recomposeAllExports(): Promise<void> {
  await composeGlobal();
  const customs = (await Playlist.find({ endpoint: 'custom' }, { id: 1 }).lean()) as Array<{ id: string }>;
  for (const c of customs) await composeM3u(c.id);
}

// Fired after PUT /api/playlists/:id changes a source playlist's endpoint/state/url. Best-effort — the
// caller swallows errors so a compose/prune hiccup never fails the API write. All artifacts are per-user
// now (no canonical file). Pruning rules per SKILL §8: a playlist that leaves the Global union just drops
// out of the next per-user Global compose; a playlist's Custom per-user files are exclusively its own.
export async function reconcilePlaylistExport(
  before: { endpoint?: string; url: string },
  after: PlaylistLite,
): Promise<void> {
  // Normalize casing so a pre-normalization 'Custom'/'Global' snapshot still classifies correctly.
  const beforeEp = (before.endpoint ?? '').toLowerCase();
  const afterEp = (after.endpoint ?? '').toLowerCase();
  // Custom → Global: prune the playlist's Custom per-user files; it now joins the shared per-user Global union.
  if (beforeEp === 'custom' && afterEp === 'global') {
    await pruneCustomFile(before.url);
    await composeGlobal();
    return;
  }
  // Global → Custom: recompose every user's Global file WITHOUT it, then write its Custom per-user files.
  if (beforeEp === 'global' && afterEp === 'custom') {
    await composeGlobal();
    await composeM3u(after.id);
    return;
  }
  // Custom path rename (stays Custom, url changed): move the files (prune old <customPath>, write new).
  if (beforeEp === 'custom' && afterEp === 'custom' && before.url !== after.url) {
    await pruneCustomFile(before.url);
    await composeM3u(after.id);
    return;
  }
  // Otherwise a state flip (or no-op): the per-user Global union tracks `state`, and a Custom playlist's
  // per-user files are written/pruned by its own state. Recompose the surfaces this playlist could affect.
  await composeGlobal();
  if (afterEp === 'custom') await composeM3u(after.id);
}

// Delete every user's per-user file for a Custom playlist (+ the empty <customPath> dirs they leave) and the
// playlist's shared guide sibling. Idempotent. Called on playlist delete and on Custom url rename (old url)
// — see reconcilePlaylistExport. (There is no canonical Custom file to delete anymore.)
export async function pruneCustomFile(url: string): Promise<void> {
  await pruneCustomPerUser(url);
  await pruneGuide(customGuidePath(url)); // the Custom playlist's guide sibling goes with its per-user files
}
