// zlive source adapter (ZLive — a free sports/linear restream site). Built on the makeFastSource factory (the
// samsung.ts template), with the dulo pattern's operator-set domain and host-free sentinel entries.
//
// How zlive delivers, and what each piece of this adapter answers to:
//   · CATALOG — `GET https://cast.<domain>/channels.json`, a bare JSON array of ~177 linear channels
//     {id, name, sport, …} with no logos, guide ids or numbers. listChannels() makes that ONE request and keeps
//     only {id, name, sport}. There is no committed snapshot: a failed fetch returns an EMPTY offline listing
//     (meta.live:false), which flips the playlist to 'warn' and — because syncLive only prunes on a live result —
//     keeps every channel already synced. A catalog under half the size of the last synced one is treated the same
//     way (see listChannels). The events feed (streams.json) is deliberately not read: linear only.
//   · IDENTITY — a channel is its RESOLVER SLUG (the catalog id minus one leading `auto-`, then one leading `evt-`,
//     exactly as zlive's own player derives it): `_id` `zlive:<slug>`, entry `zlive://<slug>`. Host-free, so an
//     operator domain change never invalidates a stored channel or an exported M3U line.
//   · RESOLVE — per play, `GET https://iptv.<domain>/<slug>` answers a 302 to a signed, ~2.5 h playlist URL.
//     ./zlive/resolver.ts reuses a target until 10 min before its token expires (dropping it early, rate-limited,
//     when the data plane reports it failing — opts.fresh), backs off after a refusal or a failed contact, vets the
//     Location (shape, registrable domain, public addresses) and watches for zlive's leech-list decoy. The token's
//     expiry rides back as expiresAtMs, so the data plane renews ahead of it instead of meeting a 403.
//   · MEDIA — the playlist's segments are TikTok-CDN "images": a RIFF/WEBP wrapper whose EXIF chunk IS the
//     MPEG-TS. `segmentUnwrap` tells the data plane to strip it on the pass-through paths (the origin ingest
//     unwraps universally), and the relabel below stops the relay advertising image/webp.
//
// Operational posture — zlive polices restreamers (it ranks clients by unique streams per IP and serves a decoy
// to IPs on a manual leech list), so the adapter declares the capabilities that keep masqueradarr's traffic
// shaped like one household's, and never tries to disguise it:
//   · originRequired — one refcounted ingest per channel however many viewers; forced whatever the proxy config.
//   · probeExempt    — the scheduled probe sweep never resolves zlive channels in bulk.
//   · maxConcurrentStreams — at most Settings.zliveMaxStreams distinct channels live (default 2; 0 = unlimited).
//   · a decoy answer is detected and SURFACED (status(), warn log), never routed around.
//
// EPG: zlive has no guide. A committed station-id crosswalk (seed-data/zlive-playlist-addon.json) links channels
// onto the operator's EXISTING Gracenote / Jesmann guides — after every playlist sync (afterSync) and after every
// guide sync (applyEpgLinks), fill-only-if-untouched. No self-EPG is written, so playlistBoundEpg is false.

import { makeFastSource } from './_fast/template.js';
import {
  ENTRY_PREFIX,
  UA,
  ZLIVE_DEFAULT_DOMAIN,
  entryUrlFor,
  getCatalogUrl,
  getDomain,
  getMaxStreams,
  getResolverBase,
  groupOf,
  isDuplicateSlug,
  parseCatalog,
  slugFromEntry,
  slugOf,
  zliveAllow,
} from './zlive/config.js';
import { createZliveResolver } from './zlive/resolver.js';
import { ZLIVE_EPG_ADDON_FILE } from '../paths.js';
import { applyStationCrosswalk } from '../epgCrosswalk.js';
import { logger } from '../core/logger.js';
import type { ArtifactType, RawListing } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SOURCE_ID = 'zlive';

/** A catalog GET is one ~40 KB file; a hung request must not hold a sync open indefinitely. */
const CATALOG_TIMEOUT_MS = 20_000;
/** A live catalog listing fewer than this share of the channels last synced is refused as partial… */
const SHRINK_GUARD_RATIO = 0.5;
/** …once the source has at least this many channels (a first sync, or a tiny catalog, has nothing to protect). */
const SHRINK_GUARD_MIN_PRIOR = 20;

// The per-play resolver (one per process). Network-facing pieces injected: global fetch, and dns.ts lookupAll —
// the same resolver fetch() connects with — for vetting the Location host. dns.ts is imported at CALL time: its
// import installs the global fetch dispatcher, a side effect that belongs to index.ts (where it is the first
// import), not to every script that happens to load the source registry.
const resolver = createZliveResolver({
  fetch: (url, init) => fetch(url, init),
  lookup: async (host) => (await import('../../dns.js')).lookupAll(host),
  now: () => Date.now(),
});

// How many channels the last sync left for this source, or null when that cannot be read (no connected Mongo —
// a script — or a transient error), in which case the shrink guard simply does not apply. The model is imported
// at CALL time for the same reason as the resolve seam in status(): this module must stay loadable on its own.
async function priorChannelCount(): Promise<number | null> {
  try {
    const { SourceChannel } = await import('../../models/SourceChannel.js');
    if (SourceChannel.db.readyState !== 1) return null; // never queue behind mongoose's command buffering
    return await SourceChannel.countDocuments({ source: SOURCE_ID });
  } catch {
    return null;
  }
}

// ONE GET of the public catalog, User-Agent only, rows trimmed to {id, name, sport}. Redirects are NOT followed:
// zlive has no reason to redirect a static JSON file, and when its domain moves a redirect is exactly what the
// operator needs to see (named in the reason, pointing at the setting) rather than a silent hop to another host.
// On ANY failure the listing is empty and offline — no snapshot exists, and an empty offline result is the shape
// that keeps the channels already synced (no prune) while the playlist shows 'warn'.
//
// SHRINK GUARD. A live listing is also refused when it holds under half the channels the last sync left. ~174 of
// zlive's ~177 rows come from its own 10-minute re-sync of a fragile upstream (the `auto-` rows); if that re-sync
// comes back empty, the catalog still answers with its few manual rows, and accepting it would prune every other
// channel — with the operator's renames, numbers, failover groups and EPG-link choices on them. A smaller catalog
// that is REAL is accepted through the playlist's Restore Defaults, which clears the channels first (so there is
// no prior count to compare against).
async function listChannels(): Promise<RawListing> {
  const endpoint = getCatalogUrl();
  try {
    const res = await fetch(endpoint, {
      redirect: 'manual',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get('location') ?? '(no Location)';
      await res.body?.cancel().catch(() => undefined);
      throw new Error(
        `catalog redirected (HTTP ${res.status}) to ${to.slice(0, 160)} — if zlive has moved, set its new domain ` +
          'under Settings → Advanced → ZLive',
      );
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = parseCatalog(await res.json());
    if (!raw) throw new Error('catalog is not a JSON array');
    if (!raw.length) throw new Error('empty channel list');
    const prior = await priorChannelCount();
    if (prior !== null && prior >= SHRINK_GUARD_MIN_PRIOR && raw.length < prior * SHRINK_GUARD_RATIO) {
      throw new Error(
        `it lists only ${raw.length} channels, under half of the ${prior} last synced — zlive's own upstream ` +
          "sync looks partial, so nothing is removed. If zlive really dropped them, the playlist's Restore " +
          'Defaults accepts the smaller catalog',
      );
    }
    return { raw, meta: { live: true, endpoint, fetchedAt: new Date().toISOString() } };
  } catch (err) {
    return {
      raw: [],
      meta: {
        live: false,
        endpoint,
        reason: `zlive catalog at ${endpoint} not used: ${(err as Error).message} (existing channels kept)`,
      },
    };
  }
}

// One catalog row → one SourceChannel, keyed on the resolver slug (see the header). A row whose slug the
// resolver would not sign is dropped. Grouped by zlive's `sport` with its own "Other" for the blank ones.
function normalize(raw: any, { ingestedAt }: { ingestedAt: string }): SourceChannelDoc | null {
  const slug = typeof raw?.id === 'string' ? slugOf(raw.id) : null;
  if (!slug) return null;
  const group = groupOf(raw.sport);
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : slug;
  return {
    _id: `${SOURCE_ID}:${slug}`,
    source: SOURCE_ID,
    sourceChannelId: slug,
    name,
    category: group,
    groupKey: group,
    groupLabel: group,
    logoUrl: null, // zlive's catalog carries no logos
    streamEntryUrl: entryUrlFor(slug),
    isPlayable: true, // liveness is request-time; the resolver signs any slug, so a sync can't know better
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    ingestedAt,
  };
}

// Documentation only (classifyArtifact is called by nothing in the Node tree today): the resolved target is a
// MEDIA playlist, and segments are TikTok-CDN image URLs carrying TS.
function classifyArtifact(url: string): ArtifactType {
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (p.endsWith('.m3u8')) return 'variant';
    if (p.endsWith('.ts') || p.includes('~tplv-')) return 'segment';
    return 'other';
  } catch {
    return 'other';
  }
}

// Stream-cap usage + resolver state, for GET /api/sources/zlive/status and the Settings ZLive panel. The cap
// bookkeeping lives in the resolve seam, which imports the registry, which imports this module — so it is
// imported at CALL time: a static import would make the registry's SOURCES read this adapter before it exists
// whenever something loads the adapter ahead of the registry (a script, a test, a future import order).
async function status() {
  const { streamCapStatus } = await import('../../proxy/resolveSeam.js');
  return {
    domain: getDomain(),
    catalogUrl: getCatalogUrl(),
    resolverBase: getResolverBase(),
    maxStreams: getMaxStreams(),
    streamCap: streamCapStatus(SOURCE_ID),
    resolver: resolver.status(),
  };
}

// Link channels onto the operator's station-id guides. applyStationCrosswalk is itself guarded and never
// throws; the catch only keeps a future regression there from failing a sync.
async function linkGuides(sourceId: string): Promise<void> {
  await applyStationCrosswalk(sourceId, ZLIVE_EPG_ADDON_FILE).catch((err) =>
    logger.warn('seed', `[${sourceId}] station EPG crosswalk failed (continuing): ${(err as Error).message}`),
  );
}

const zliveAdapter = makeFastSource({
  id: SOURCE_ID,
  label: 'ZLive',

  // zlive's own sport buckets (Sports / Kids / F1 / Other), alphabetical.
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. No self-built guide (the crosswalk links onto EXISTING external guides),
  // so Playlist-bound EPG is false; the rest is the common posture.
  builtinMeta: {
    globalPlaylist: true,
    clonePlaylist: true,
    syncSchedules: true,
    playlistBoundEpg: false,
    epgSyncSchedules: false,
  },

  listChannels,
  normalize,
  defaultDisabled: (ch) => isDuplicateSlug(ch.sourceChannelId),
  status,

  // ── capabilities (see the header) ──
  probeExempt: true,
  maxConcurrentStreams: () => getMaxStreams(),
  originRequired: true,
  segmentUnwrap: true,

  // ── proxy / resolution ──
  allowedSuffixes: [ZLIVE_DEFAULT_DOMAIN], // unused — isAllowedUpstream is the dynamic set below
  upstreamHeaders: () => ({ 'User-Agent': UA }),
  isAllowedUpstream: (url: string) => zliveAllow.isAllowedUpstream(url),
  onPlaylistChildHost: (host: string) => zliveAllow.onPlaylistChildHost(host),
  isEntryUrl: (url: string) => typeof url === 'string' && url.startsWith(ENTRY_PREFIX),
  async resolveStream(entryUrl, opts) {
    const slug = slugFromEntry(entryUrl);
    if (!slug) throw new Error(`malformed zlive entry: ${String(entryUrl).slice(0, 80)}`);
    return resolver.resolve(slug, { advance: opts?.advance === true, fresh: opts?.fresh === true });
  },
  // Segments arrive as image/webp. Keyed on `type` ONLY: the resolve seam probes this rule once with a fake URL
  // and a sentinel content-type, so a test on the real type or host would never fire.
  relabelSegmentContentType: (_url, contentType, type) =>
    type === 'segment' ? 'video/mp2t' : contentType || 'application/octet-stream',
  classifyArtifact,

  // ── EPG links: after a playlist sync, and again after any gracenote/jesmann guide sync ──
  async afterSync({ sourceId }) {
    await linkGuides(sourceId);
  },
  applyEpgLinks: linkGuides,
});

export default zliveAdapter;
