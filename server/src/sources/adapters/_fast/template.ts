// makeFastSource — the shared factory for the FastChannels FAST-source family (Samsung, Vizio, Xumo, …). It
// supplies the DIRECT-HLS scaffold copied from adapters/direct.ts (an .m3u8 entry, identity resolve, the
// ts/aac/mp4/m4s→segment classify) so a truly-direct source is ~40 lines: just listChannels() + normalize() +
// a CDN suffix allowlist. Every proxy/resolution piece is an OPTIONAL override, so a source that mints per-play
// URLs (Samsung's jmp2.uk redirect) overrides resolveStream + isEntryUrl + the dynamic SSRF allow-set without
// the factory growing a per-source branch — the core stays source-agnostic.
//
// The ONE deliberate divergence from direct.ts: the default isAllowedUpstream is SCOPED to `allowedSuffixes`
// (suffix allowlist + private-IP BLOCK), because FAST sources proxy public CDNs, not the admin-curated LAN
// imports `direct` allows. A source needing a runtime-growing allowlist passes createDynamicAllow(...) itself
// (see adapters/_fast/dynamicAllow.ts + adapters/samsung.ts).

import { createDynamicAllow } from './dynamicAllow.js';
import type {
  ArtifactType,
  BuiltinPlaylistMeta,
  RawListing,
  SourceAdapter,
  SourceGrouping,
} from '../../types.js';
import type { SourceChannelDoc } from '../../../models/SourceChannel.js';

export interface FastSourceOptions {
  id: string;
  label: string;
  requiresAuth?: boolean;
  grouping: SourceGrouping;
  builtinMeta?: BuiltinPlaylistMeta;
  defaultDisabled?(channel: SourceChannelDoc): boolean;
  status?: SourceAdapter['status'];
  afterSync?: SourceAdapter['afterSync'];

  // ── the two per-source functions (always required) ──
  listChannels(): Promise<RawListing>;
  normalize(raw: any, ctx: { ingestedAt: string }): SourceChannelDoc | null;

  // ── proxy / resolution — direct-HLS defaults, each overridable ──
  /** CDN domain suffixes for the DEFAULT static isAllowedUpstream (ignored when isAllowedUpstream is overridden). */
  allowedSuffixes: string[];
  upstreamHeaders?(url: string): Record<string, string>; // default {}
  isEntryUrl?(url: string): boolean; // default: pathname ends with .m3u8
  resolveStream?(entryUrl: string): Promise<{ masterUrl: string }>; // default: identity
  isAllowedUpstream?(url: string): boolean; // default: scoped static suffix allowlist + private-IP block
  onPlaylistChildHost?: ((host: string) => void) | null; // default: null (static allowlist learns nothing)
  relabelSegmentContentType?(url: string, contentType: string, type?: ArtifactType): string;
  classifyArtifact?(url: string): ArtifactType;
}

// Copied verbatim from direct.ts — arbitrary HLS: ts/aac/mp4/m4s are segments, .m3u8 is the master (variant vs
// master isn't distinguishable for a generic source), everything else is other.
function defaultClassifyArtifact(url: string): ArtifactType {
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (/\.(ts|aac|mp4|m4s)$/.test(p)) return 'segment';
    if (p.endsWith('.m3u8')) return 'master';
    return 'other';
  } catch {
    return 'other';
  }
}

function defaultIsEntryUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}

export function makeFastSource(opts: FastSourceOptions): SourceAdapter {
  // Only build the default allow-set when the source doesn't supply its own gate (Samsung passes a dynamic one).
  const isAllowedUpstream =
    opts.isAllowedUpstream ?? createDynamicAllow(opts.allowedSuffixes).isAllowedUpstream;

  return {
    id: opts.id,
    label: opts.label,
    requiresAuth: opts.requiresAuth,
    listChannels: opts.listChannels,
    normalize: opts.normalize,
    defaultDisabled: opts.defaultDisabled,
    grouping: opts.grouping,
    builtinMeta: opts.builtinMeta,
    status: opts.status,
    isEntryUrl: opts.isEntryUrl ?? defaultIsEntryUrl,
    resolveStream: opts.resolveStream ?? (async (entryUrl: string) => ({ masterUrl: entryUrl })),
    proxy: {
      upstreamHeaders: opts.upstreamHeaders ?? (() => ({})),
      isAllowedUpstream,
      onPlaylistChildHost: opts.onPlaylistChildHost ?? null,
      relabelSegmentContentType:
        opts.relabelSegmentContentType ??
        ((_url: string, contentType: string) => contentType || 'application/octet-stream'),
      classifyArtifact: opts.classifyArtifact ?? defaultClassifyArtifact,
    },
    afterSync: opts.afterSync,
  };
}
