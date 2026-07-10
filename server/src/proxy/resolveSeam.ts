import { getSource } from '../sources/registry.js';
import { resolveProxyConfig } from '../proxyconfig/resolve.js';
import type { RuntimeProxyConfig } from '../proxyconfig/translate.js';
import { PlaylistChannel, type PlaylistChannelDoc } from '../models/PlaylistChannel.js';
import { noteFailoverServing } from '../sources/core/streamTelemetry.js';
import { logger } from '../sources/core/logger.js';
import { logMilestone, logTrace } from '../logs/tier.js';

// The RESOLVE SEAM (control plane). Given a stream request the Rust data plane can't resolve itself, Node
// runs the stateful, per-source adapter logic (dulo Supabase auth, dlhd 3-hop scrape + mirror rotation, the
// SourceProxy bag) and returns a per-stream GRANT the sidecar replays for the whole stream. This keeps ALL
// churn-prone provider logic in TypeScript; Rust just fetches + rewrites + pipes.
//
// Faithfulness notes (verified against the adapters):
//  · upstreamHeaders is per-stream CONSTANT — snapshot once here (for dlhd/dami this captures the rotating
//    playerReferer per stream, which is MORE correct than the shared module global the old proxy replayed).
//    The (Default)/(Custom) proxy-config `headerOverrides` are merged ON TOP here (operator wins), so Rust
//    replays the final header set unchanged — the one proxy-config knob applied Node-side (see CFG/PXY-2).
//  · The SSRF allowlist is OBSERVATIONAL: Rust seeds it from the resolved target host and grows it from the
//    hosts it rewrites out of each manifest (all of dulo/dlhd/dami enable dynamic-allow), so the grant needs
//    NO host list — only `allowPrivate` (false for these public-CDN sources; a future LAN source flips it).
//  · relabelSegment is derived by PROBING the adapter's relabel rule with a sentinel content-type, so the
//    core stays generic (no per-source branch): dulo passes the sentinel through → null; dlhd/dami force
//    'video/mp2t' on segments → 'video/mp2t'.
//  · proxyConfig is the resolved (Custom app_<pl> → Default app → env) knob set (proxyconfig/resolve.ts). Rust
//    applies connectTimeoutMs + maxRedirects (P2 → its upstream client), readTimeoutMs + bufferSizeKb (P3.1/RSL
//    → per-stream) and outputFormat (hls|ts, P3.2/DST); only segmentCacheTtlSec still rides along unenforced.
//    headerOverrides are already folded into upstreamHeaders above, so Rust ignores that field (no double-apply).

export interface ResolveGrant {
  ok: true;
  /** The URL the sidecar fetches for the ENTRY hop: a resolved master (dulo/dlhd) or the entry itself (direct sources). */
  target: string;
  /** Headers to replay on EVERY hop of this stream (master/variant/segment). Per-stream constant; includes the merged proxy-config headerOverrides. */
  upstreamHeaders: Record<string, string>;
  /** Force this content-type on non-manifest (segment) responses; null = pass upstream through. */
  relabelSegment: string | null;
  /** Permit private/loopback upstream IPs (LAN sources). false for the public-CDN sources (dulo/dlhd/dami). */
  allowPrivate: boolean;
  /** Whether the request URL needed server-side resolution (vs a direct passthrough entry). */
  isEntry: boolean;
  /** The resolved (Default/Custom) data-plane config for this stream — Rust applies the LIVE knobs, carries the rest. */
  proxyConfig: RuntimeProxyConfig;
  /**
   * Which per-source policy this grant's headers/relabel/hosts belong to: the SERVING candidate's adapter
   * id — equal to the mount source for attempt 0 / ungrouped channels, the child's `origin ?? source` for a
   * failover candidate. Rust keys its shared SourcePolicy by THIS (not the URL mount source), so a
   * cross-provider child grant can never overwrite the parent provider's policy for its other streams.
   */
  policySource: string;
  /** Failover context (attempt >= 1 only): which candidate this grant serves + the loop bound. */
  failover: { attempt: number; total: number; candidateId: string; candidateName: string } | null;
}

export interface ResolveError {
  ok: false;
  status: number;
  error: string;
}

const RELABEL_PROBE = 'application/x-masq-probe';

// Merge operator header overrides ON TOP of the adapter's upstream headers, letting an override win even when
// it differs in CASE from the adapter's header (HTTP header names are case-insensitive). Any base header whose
// name case-insensitively matches an override is dropped, then the overrides (operator casing) are applied.
function mergeUpstreamHeaders(
  base: Record<string, string>,
  overrides: Record<string, string>,
): Record<string, string> {
  if (!overrides || Object.keys(overrides).length === 0) return { ...base };
  const overridden = new Set(Object.keys(overrides).map((k) => k.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (!overridden.has(k.toLowerCase())) out[k] = v;
  }
  for (const [k, v] of Object.entries(overrides)) out[k] = v;
  return out;
}

/**
 * Build the per-stream grant.
 *
 * `attempt` selects the failover candidate: undefined = a NON-failover caller (probeAll — always resolves
 * the requested channel itself and never touches failover attribution); 0 = the data plane's primary
 * attempt (the requested channel; clears any stale failover attribution); >= 1 = the requested channel's
 * Nth ordered failover CHILD (attempt 1 = children[0]), resolved via the CHILD's own adapter. When the
 * requested entry has no (more) candidates the reply is a distinct 410 `failover_exhausted` — Rust's
 * attempt loop terminates on it (a plain 502 means "this candidate failed, try the next").
 */
export async function buildGrant(
  source: string,
  url: string,
  pl?: string,
  attempt?: number,
): Promise<ResolveGrant | ResolveError> {
  const adapter = getSource(source);
  if (!adapter) return { ok: false, status: 404, error: 'unknown_source' };

  // Failover fall-through: resolve the requested channel's Nth child instead. The attempt-0/undefined path
  // below is byte-identical to the pre-failover seam — ZERO DB reads on the hot path, and the scheduled
  // probe sweep keeps probing the actual channel (failover can never mask a dead parent as healthy).
  if (attempt !== undefined && attempt >= 1) return buildFailoverGrant(source, url, pl, attempt);

  let target = url;
  let isEntry = false;
  try {
    if (adapter.isEntryUrl(url)) {
      isEntry = true;
      const resolved = await adapter.resolveStream(url);
      target = resolved.masterUrl;
    }
  } catch (err) {
    return { ok: false, status: 502, error: `resolve_failed: ${(err as Error).message}` };
  }

  // The effective proxy config for this stream: the Custom app_<pl> override → the Default app → env defaults.
  // Resolved by the OWNING playlist id the composed M3U stamps as ?pl (=== the channel's source; see
  // m3u/serialize.ts). The in-app appPlayer path carries no ?pl → the Default applies (CFG/PXY-2).
  const proxyConfig = await resolveProxyConfig(pl);

  // Snapshot the per-stream upstream headers against the resolved target (dlhd/dami: the CDN-host branch →
  // { Referer: playerReferer(), UA }; dulo: a constant map — it ignores the url arg), then merge the operator
  // headerOverrides ON TOP (operator wins, CASE-INSENSITIVELY — HTTP header names are case-insensitive and Rust
  // normalizes them, so a `referer` override must beat the adapter's `Referer`, not race it). This is the one
  // proxy-config knob applied Node-side, so Rust replays the final set unchanged.
  const upstreamHeaders = mergeUpstreamHeaders(adapter.proxy.upstreamHeaders(target), proxyConfig.headerOverrides);

  // Probe the relabel rule generically: force-type iff the adapter rewrites our sentinel for a 'segment'.
  const probed = adapter.proxy.relabelSegmentContentType('https://x/s.ts', RELABEL_PROBE, 'segment');
  const relabelSegment = probed && probed !== RELABEL_PROBE ? probed : null;

  // An explicit attempt 0 is the data plane (re)trying the channel itself — any prior "child is serving"
  // attribution is stale the moment this grant is built (a later failed fetch re-sets it via attempt 1).
  if (attempt === 0) noteFailoverServing(source, url, null);

  // P1 sources (dulo/dlhd/dami) are all public-CDN + private-IP-rejecting. A future LAN adapter (hdhomerun/
  // local) will need a per-adapter signal here to allow private targets; hardcoded false is correct for now.
  return {
    ok: true,
    target,
    upstreamHeaders,
    relabelSegment,
    allowPrivate: false,
    isEntry,
    proxyConfig,
    policySource: source,
    failover: null,
  };
}

// Resolve the requested entry's Nth ordered failover CHILD (attempt 1 = the first child). The candidate is
// resolved via ITS OWN adapter (headers, relabel probe, entry resolution all from `origin ?? source`), and
// the grant's policySource names that adapter so Rust files the policy under the right key (a
// cross-provider child must never overwrite the parent provider's shared policy).
async function buildFailoverGrant(
  source: string,
  url: string,
  pl: string | undefined,
  attempt: number,
): Promise<ResolveGrant | ResolveError> {
  // Identify the requested channel as a failover PARENT. With ?pl (every exported line stamps it — the
  // owning playlist === the channel doc's `source`) the lookup is exact. The in-app player carries no ?pl,
  // and the same (adapter, entry URL) can back SEVERAL parent docs — the source playlist's own channel
  // ({origin:null, source}) plus any clone copy ({origin:source}), each groupable independently — so the
  // no-pl lookup must be DETERMINISTIC, not an arbitrary findOne: prefer the canonical source-playlist doc,
  // then the lexically-first clone copy (stable across requests).
  const parent = pl
    ? await PlaylistChannel.findOne({ streamEntryUrl: url, source: pl, failoverRole: 'parent' }).lean()
    : ((await PlaylistChannel.findOne({
        streamEntryUrl: url,
        source,
        origin: null,
        failoverRole: 'parent',
      }).lean()) ??
      (await PlaylistChannel.findOne({ streamEntryUrl: url, origin: source, failoverRole: 'parent' })
        .sort({ source: 1 })
        .lean()));
  if (!parent?.failoverGroupId) {
    // Defensive: Rust asked to fail over a channel that isn't a grouped parent (no group, or an in-app
    // probe past a plain channel). Normal terminator, not an operator-facing issue — level-3 lineage only.
    logTrace('failover', `attempt ${attempt}: ${url} is not a grouped failover parent — exhausted`);
    return { ok: false, status: 410, error: 'failover_exhausted' };
  }

  // Candidates = the group's Active children in failover order. Disabled children are deliberately
  // skipped (status is the operator's exclusion governor — a disabled backup must never be served).
  const children = await PlaylistChannel.find(
    {
      source: parent.source,
      failoverGroupId: parent.failoverGroupId,
      failoverRole: 'child',
      status: 'Active',
    },
    { _id: 0 },
  )
    .sort({ failoverOrder: 1 })
    .lean<PlaylistChannelDoc[]>();
  const cand = children[attempt - 1];
  if (!cand) {
    // Every Active backup was tried and none established — the real terminal event. Issue-level (≥1): an
    // operator wants to know a stream fully exhausted its failover chain. Pairs with the Rust data-plane
    // "all backups exhausted" warn (data plane carries the session rid; this names the parent + source).
    logger.warn(
      'failover',
      `exhausted all ${children.length} backup(s) for ${parent.id} on ${parent.source}`,
    );
    return { ok: false, status: 410, error: 'failover_exhausted' };
  }

  const candSource = cand.origin ?? cand.source;
  const candAdapter = getSource(candSource);
  if (!candAdapter) {
    // A 502 (not 410) so the data plane advances to the NEXT candidate rather than giving up.
    logger.warn(
      'failover',
      `candidate ${attempt} ("${cand.tvg_name}") for ${parent.id}: unknown adapter '${candSource}'`,
    );
    return { ok: false, status: 502, error: `resolve_failed: unknown candidate adapter '${candSource}'` };
  }

  let target = cand.streamEntryUrl;
  let isEntry = false;
  try {
    if (candAdapter.isEntryUrl(target)) {
      isEntry = true;
      target = (await candAdapter.resolveStream(target)).masterUrl;
    }
  } catch (err) {
    // This backup couldn't resolve its stream; the 502 advances the data plane to the next candidate.
    // Issue-level (≥1) — a failing backup is worth surfacing even at the quietest verbosity.
    logger.warn(
      'failover',
      `candidate ${attempt} ("${cand.tvg_name}") for ${parent.id} resolve failed: ${(err as Error).message}`,
    );
    return { ok: false, status: 502, error: `resolve_failed: ${(err as Error).message}` };
  }

  const proxyConfig = await resolveProxyConfig(pl);
  const upstreamHeaders = mergeUpstreamHeaders(
    candAdapter.proxy.upstreamHeaders(target),
    proxyConfig.headerOverrides,
  );
  const probed = candAdapter.proxy.relabelSegmentContentType('https://x/s.ts', RELABEL_PROBE, 'segment');
  const relabelSegment = probed && probed !== RELABEL_PROBE ? probed : null;

  // Attribution: telemetry stays keyed on the PARENT's (source, entry) — record which child this grant
  // actually serves so Active Streams can show "failover → <child>" (see statsHub DisplayStream.failover).
  const failover = { attempt, total: children.length, candidateId: cand.id, candidateName: cand.tvg_name };
  noteFailoverServing(source, url, failover);
  // Milestone (≥2): a backup is now serving in place of the parent — the headline failover event.
  logMilestone(
    'failover',
    `serving candidate ${attempt}/${failover.total} ("${cand.tvg_name}") for ${parent.id}`,
  );

  return {
    ok: true,
    target,
    upstreamHeaders,
    relabelSegment,
    allowPrivate: false,
    isEntry,
    proxyConfig,
    policySource: candSource,
    failover,
  };
}
