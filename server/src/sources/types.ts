// The source-adapter contract, ported from d-combine (sources/<id>/adapter.mjs). One object per
// source captures ONLY what differs between sources; the generic core (buildSource, proxyHandler,
// playlist) consumes any adapter without per-source branching. Adding a source = one adapter +
// one registry line.

import type { SourceChannelDoc } from '../models/SourceChannel.js';

export interface SourceMeta {
  live?: boolean;
  [k: string]: unknown;
}

export interface RawListing {
  // upstream-shaped records (JSON API rows, scraped cards, …) — the adapter boundary is untyped.
  raw: any[];
  meta?: SourceMeta;
}

export type ArtifactType = 'master' | 'variant' | 'segment' | 'other';

export interface SourceGrouping {
  by: string;
  groupOrder: string;
  channelOrder: string;
}

// Operator-facing "what does this built-in include?" summary, surfaced over GET /api/sources (manifest →
// SourceManifestEntry.builtinMeta) and rendered by the Add Playlist modal's "Built-In" option BEFORE the
// user provisions the source. These are INHERENT, declarative properties of the built-in source — NOT live
// state — so they live next to the adapter (the registry pattern) and the modal iterates them generically
// with no per-source branching. `playlistBoundEpg` is the only field that varies across the current
// built-ins: true when a playlist sync ALSO refreshes the source's OWN guide (a self-EPG written by the
// adapter's afterSync hook — dlhd's syncDlhdEpg, tubi's writeTubiEpg, both flagged EpgSource.playlistBinding);
// false when the source carries no self-built guide and the user must match its channels (dulo, which only
// crosswalks onto EXISTING external Gracenote sources).
export interface BuiltinPlaylistMeta {
  /** Can be hosted as a Global endpoint (the consolidated per-user m3u). */
  globalPlaylist: boolean;
  /** Can be cloned into a user-composed custom playlist. */
  clonePlaylist: boolean;
  /** Supports a recurring sync schedule (cronjobs targetType:'playlist'). */
  syncSchedules: boolean;
  /** A playlist sync refreshes the source's OWN guide (self-EPG). false ⇒ user must match channels. */
  playlistBoundEpg: boolean;
  /** The Playlist EPG supports its own sync schedule (false for every current built-in). */
  epgSyncSchedules: boolean;
}

// Sensible default applied when an adapter omits builtinMeta (so a future source still surfaces a summary
// and the modal never has to special-case a missing field). Mirrors the common posture of today's built-ins.
export const DEFAULT_BUILTIN_META: BuiltinPlaylistMeta = {
  globalPlaylist: true,
  clonePlaylist: true,
  syncSchedules: true,
  playlistBoundEpg: false,
  epgSyncSchedules: false,
};

/**
 * How to recognize an AD segment for a source whose manifest carries no cue tags at all (pluto emits no
 * #EXT-X-CUE-OUT / SCTE-35 / DATERANGE — its only signal is the creative's URI shape).
 *
 * Deliberately a POSITIVE, DECLARED literal rather than a heuristic. The local origin previously carried a
 * generic "the segment URL's directory changed" detector and it was removed for false positives (see
 * proxy/src/origin.rs `Boundary`): pluto rotates keyfiles inside one clip and some CDNs mint a per-segment
 * opaque path token, so no URI *diff* can be made reliable. A fixed substring an adapter opts into is a
 * different shape entirely — it fails closed when absent and never compares two URIs to each other.
 */
export interface AdSignature {
  /** Match if the percent-DECODED segment URI contains any of these (case-insensitive). */
  uriContains: string[];
}

export interface SourceProxy {
  /** Headers to inject on every upstream hop (dulo: Origin; dlhd: Referer+UA). */
  upstreamHeaders(url: string): Record<string, string>;
  /** Ad-segment URI signature for cue-tag-less sources (pluto). Omitted ⇒ no URI-based ad detection. */
  adSignature?: AdSignature;
  /** SSRF gate for direct hops (dulo: *.dulo.tv; dlhd: dynamic Set; direct/import: any http(s), private IPs allowed for LAN sources). */
  isAllowedUpstream(url: string): boolean;
  /** Per-rewritten-child hook (dlhd: dynamic-allow each host; dulo/common: null). */
  onPlaylistChildHost: ((host: string) => void) | null;
  /** dulo/common: pass-through; dlhd: relabel disguised image/pdf TS as video/mp2t. */
  relabelSegmentContentType(url: string, contentType: string, type?: ArtifactType): string;
  classifyArtifact(url: string): ArtifactType;
}

// Per-resolve options threaded from the resolve seam (buildGrant) into resolveStream. Only `playerSelectable`
// sources read it; kept minimal + provider-agnostic (a numeric player index) so the generic core stays neutral.
export interface ResolveStreamOptions {
  /** Preferred upstream player (1-based; 0/undefined = Auto). Resolved from the per-channel pref → source default. */
  player?: number;
  /**
   * Validate one level deeper before accepting an upstream — for dlhd, fetch the chosen variant and require
   * real segments, so a player that mints a valid-looking master but never streams is rejected while the
   * player walk can still act on it. Set by the LIVE resolve seam only; the scheduled probe sweep leaves it
   * off so its per-channel cost is unchanged. Adapters that don't understand it ignore it.
   */
  deep?: boolean;
  /**
   * WHY the upstream is being retired, when `advance` is set. The data plane names the cause so the adapter
   * can record it against the provider it burns: "this provider 404s" and "this provider serves video the
   * decoder cannot use" are different operational facts, and an operator staring at a burnt player list
   * needs to tell them apart. Free-form; adapters that don't record reasons ignore it.
   */
  advanceReason?: string;
  /**
   * "The upstream you handed me last time just failed — give me a DIFFERENT one." Set by the resolve seam
   * on a play-time failover attempt. A `playerSelectable` adapter honors it by excluding the player it last
   * served (dlhd burns it for a short TTL, so the walk skips it); adapters without alternates ignore it and
   * simply re-resolve, which is today's behavior. Throwing when no alternate remains is correct — the seam
   * turns that into a 502 and the data plane moves on to the channel's failover-group children.
   */
  advance?: boolean;
}

export interface SourceAdapter {
  id: string;
  label: string;
  /** Playlist requires authentication to stream (dulo: true). Drives Playlist.authentication at seed/sync. */
  requiresAuth?: boolean;
  /**
   * A proxy-ONLY pseudo-source: it provides stream routing (a proxy handler at /api/v1/<id>/…) but has NO
   * catalog of its own, so it is NOT registered as a syncable (Default) playlist. Boot init skips its shell
   * row and the /api/sources manifest omits it. `direct` (the imported-playlist passthrough) sets this — its
   * channels live under their import Playlist's id with origin:'direct' for routing. Absent → a normal source.
   */
  synthetic?: boolean;
  /** Fetch/scrape raw listings → { raw, meta }; falls back to a bundled snapshot when offline. */
  listChannels(): Promise<RawListing>;
  /** Map one raw record → one normalized document, or null to drop it. */
  normalize(raw: any, ctx: { ingestedAt: string }): SourceChannelDoc | null;
  /**
   * Optional first-sync default: channels for which this returns true are seeded with status
   * 'Disabled' (instead of 'Active') on their FIRST sync only. Applied on the $setOnInsert path in
   * upsertPlaylistChannels, so a later user edit (Enable) is never clobbered by a re-sync. Lets a
   * source ship opinionated defaults without the generic converter branching per source. Absent →
   * all playable channels start 'Active'. (dlhd: hide adult "18+" channels.)
   */
  defaultDisabled?(channel: SourceChannelDoc): boolean;
  /** Serializable UI descriptor read by the SPA over /api/sources. */
  grouping: SourceGrouping;
  /**
   * Optional "what's included?" summary surfaced over /api/sources (manifest) and rendered by the Add
   * Playlist modal's Built-In option. Inherent, declarative properties of the source (NOT live state).
   * Absent → DEFAULT_BUILTIN_META is applied at the manifest layer. Omitted by synthetic (proxy-only)
   * sources, which are not listed as syncable playlists.
   */
  builtinMeta?: BuiltinPlaylistMeta;
  /** Optional runtime provenance (dlhd: active mirror + probes). Absent → manifest statusUrl null. */
  status?: () => unknown | Promise<unknown>;
  /**
   * Opt-in: this source exposes multiple interchangeable upstream "players" per channel that the operator can
   * PREFER (a source-wide default + per-channel override, honored + failed-over by resolveStream via opts.player).
   * dlhd/dami set this (DaddyLive's Player 1..N). Absent/false ⇒ the resolve seam never reads a player pref and
   * the SPA hides the picker. Purely a capability flag; the resolution logic lives in the adapter.
   */
  playerSelectable?: boolean;
  /** Does this URL need server-side resolution before proxying? (dulo/common: false; dlhd: watch.php) */
  isEntryUrl(url: string): boolean;
  /**
   * Entry URL → { masterUrl }. dulo/common: identity; dlhd: 3-hop scrape. `opts.player` (1-based; 0/undefined
   * = Auto) is honored only by `playerSelectable` sources; others ignore it (a 1-arg impl still satisfies this).
   * `playerIndex`/`playerCount` are OPTIONAL reporting fields — a `playerSelectable` source returns which
   * player actually served so the seam can log and badge it; a plain `{ masterUrl }` still satisfies this.
   */
  resolveStream(
    entryUrl: string,
    opts?: ResolveStreamOptions,
  ): Promise<{ masterUrl: string; playerIndex?: number; playerCount?: number }>;
  proxy: SourceProxy;
  /**
   * Optional post-sync side-effect, called by syncLive AFTER both channel stores are upserted/pruned.
   * The source-agnostic extension point for a source that carries MORE than streamable channels — tubi
   * bundles its own EPG inline, so its afterSync writes epgchannels/programs, upserts the 'tubi' EpgSource,
   * and self-links its playlistchannels to that guide. Absent (dulo/dlhd) → no-op. `raw` is the same
   * upstream listing buildSource consumed (so the hook needn't re-hit a rate-limited upstream); `live` is
   * false on a snapshot fallback. Non-fatal: a throw here is logged and must not fail the channel sync.
   */
  afterSync?(ctx: { raw: any[]; live: boolean; sourceId: string }): Promise<void>;
  /**
   * Optional SNAPSHOT-only transform, applied by scripts/rebuild-source-seed.ts to the live `raw` listing
   * BEFORE it is written to <id>.snapshot.json — NEVER on the sync path. The extension point for a source
   * whose live rows carry heavy fields the runtime guide DOES want but the committed offline fallback does
   * not (tubi keeps per-program artwork live for a richer XMLTV guide but strips it from the snapshot, where
   * it would ~double the file). Pure + synchronous; absent → the raw listing is snapshotted verbatim.
   */
  snapshotTransform?(raw: any[]): any[];
}
