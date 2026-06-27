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
  /** Supports a per-playlist externalPlayer video configuration (videoconfig 'app_<id>'). */
  videoEngineCustomization: boolean;
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
  videoEngineCustomization: true,
  playlistBoundEpg: false,
  epgSyncSchedules: false,
};

export interface SourceProxy {
  /** Headers to inject on every upstream hop (dulo: Origin; dlhd: Referer+UA). */
  upstreamHeaders(url: string): Record<string, string>;
  /** SSRF gate for direct hops (dulo: *.dulo.tv; dlhd: dynamic Set; direct/import: any http(s), private IPs allowed for LAN sources). */
  isAllowedUpstream(url: string): boolean;
  /** Per-rewritten-child hook (dlhd: dynamic-allow each host; dulo/common: null). */
  onPlaylistChildHost: ((host: string) => void) | null;
  /** dulo/common: pass-through; dlhd: relabel disguised image/pdf TS as video/mp2t. */
  relabelSegmentContentType(url: string, contentType: string, type?: ArtifactType): string;
  classifyArtifact(url: string): ArtifactType;
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
  /** Does this URL need server-side resolution before proxying? (dulo/common: false; dlhd: watch.php) */
  isEntryUrl(url: string): boolean;
  /** Entry URL → { masterUrl }. dulo/common: identity; dlhd: 3-hop scrape. */
  resolveStream(entryUrl: string): Promise<{ masterUrl: string }>;
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
