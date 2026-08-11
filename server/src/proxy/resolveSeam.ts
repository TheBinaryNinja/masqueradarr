import { getSource } from '../sources/registry.js';
import { resolveProxyConfig } from '../proxyconfig/resolve.js';
import type { RuntimeProxyConfig } from '../proxyconfig/translate.js';
import { PlaylistChannel, type PlaylistChannelDoc } from '../models/PlaylistChannel.js';
import type { ResolveStreamOptions } from '../sources/types.js';
import { noteFailoverServing, noteUpstreamHost, noteRequestedConfig } from '../sources/core/streamTelemetry.js';
import { logger } from '../sources/core/logger.js';
import { logMilestone, logTrace } from '../logs/tier.js';

// The RESOLVE SEAM (control plane). Given a stream request the Rust data plane can't resolve itself, Node
// runs the stateful, per-source adapter logic (dulo Supabase auth, dlhd 3-hop scrape + mirror rotation, the
// SourceProxy bag) and returns a per-stream GRANT the sidecar replays for the whole stream. This keeps ALL
// churn-prone provider logic in TypeScript; Rust just fetches + rewrites + pipes.
//
// Faithfulness notes (verified against the adapters):
//  · upstreamHeaders is per-stream CONSTANT — snapshot once here (for dlhd this captures the rotating
//    playerReferer per stream, which is MORE correct than the shared module global the old proxy replayed).
//    The (Default)/(Custom) proxy-config `headerOverrides` are merged ON TOP here (operator wins), so Rust
//    replays the final header set unchanged — the one proxy-config knob applied Node-side (see CFG/PXY-2).
//  · The SSRF allowlist is OBSERVATIONAL: Rust seeds it from the resolved target host and grows it from the
//    hosts it rewrites out of each manifest (all of dulo/dlhd enable dynamic-allow), so the grant needs
//    NO host list — only `allowPrivate` (false for these public-CDN sources; a future LAN source flips it).
//  · relabelSegment is derived by PROBING the adapter's relabel rule with a sentinel content-type, so the
//    core stays generic (no per-source branch): dulo passes the sentinel through → null; dlhd forces
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
  /** Permit private/loopback upstream IPs (LAN sources). false for the public-CDN sources (dulo/dlhd). */
  allowPrivate: boolean;
  /** Whether the request URL needed server-side resolution (vs a direct passthrough entry). */
  isEntry: boolean;
  /**
   * Does the SERVING adapter have alternate upstreams to walk to (`adapter.playerSelectable`)?
   *
   * S3/UND: the local origin's undecodable-upstream detector is scoped to this. Retiring an upstream only
   * helps where another one can take over — on a single-upstream source the retirement just re-resolves the
   * same dead provider on a 2 s loop. It rides the grant because the capability belongs to the adapter, and
   * the data plane must not know adapter names: it used to test `source === 'dlhd'` in Rust, which silently
   * excluded the next playerSelectable adapter from detection until someone edited and redeployed the crate.
   */
  playerSelectable: boolean;
  /** The resolved (Default/Custom) data-plane config for this stream — Rust applies the LIVE knobs, carries the rest. */
  proxyConfig: RuntimeProxyConfig;
  /**
   * Ad-segment URI signature for sources that emit no cue tags (pluto). Adapter-declared, never inferred —
   * the local origin's ad classifier falls back to this only when the manifest carried no CUE-OUT/DATERANGE.
   * null for every other source, which is what makes detection fail closed.
   */
  adSignature: { uriContains: string[] } | null;
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

// Read a channel's per-channel player OVERRIDE (for playerSelectable sources — dlhd today, and any
// adapter that sets the flag). Returns the 1-based
// preference, or 0 when unset (the adapter's resolveStream then falls back to the cached source-wide default).
// Mirrors buildFailoverGrant's reverse lookup: exact by (streamEntryUrl, pl) when the composed M3U stamped ?pl,
// else a DETERMINISTIC no-pl fallback (canonical source-playlist doc, then the lexically-first clone copy). One
// indexed read at stream start, called ONLY for playerSelectable sources, so the generic hot path is untouched.
async function channelPlayerPref(source: string, url: string, pl?: string): Promise<number> {
  const proj = { playerPref: 1, _id: 0 };
  const ch = pl
    ? await PlaylistChannel.findOne({ streamEntryUrl: url, source: pl }, proj).lean()
    : ((await PlaylistChannel.findOne({ streamEntryUrl: url, source, origin: null }, proj).lean()) ??
      (await PlaylistChannel.findOne({ streamEntryUrl: url, origin: source }, proj).sort({ source: 1 }).lean()));
  const pref = ch?.playerPref;
  return typeof pref === 'number' && pref > 0 ? pref : 0;
}

/**
 * Build the per-stream grant.
 *
 * `attempt` selects the candidate:
 *   · undefined — a NON-failover caller (probeAll): always resolves the requested channel itself, never
 *     touches failover attribution, and does NOT get deep validation (its sweep cost stays as it was).
 *   · 0 — the data plane's primary attempt (the requested channel; clears stale failover attribution).
 *   · 1 on a `playerSelectable` source — the requested channel again, but through a DIFFERENT alternate
 *     upstream (dlhd: a different one of DaddyLive's six independent player providers).
 *   · beyond that — the requested channel's Nth ordered failover CHILD, resolved via the CHILD's own
 *     adapter, indexed past whatever the alternate-upstream stage consumed.
 * When the requested entry has no (more) candidates the reply is a distinct 410 `failover_exhausted` —
 * Rust's attempt loop terminates on it (a plain 502 means "this candidate failed, try the next").
 */
export async function buildGrant(
  source: string,
  url: string,
  pl?: string,
  attempt?: number,
  advanceReason?: string,
): Promise<ResolveGrant | ResolveError> {
  const adapter = getSource(source);
  if (!adapter) return { ok: false, status: 404, error: 'unknown_source' };

  // ALTERNATE-UPSTREAM STAGE (playerSelectable sources — dlhd). DaddyLive's "Player 1..6" are six
  // INDEPENDENT embed providers, and which of them carries a given channel changes without notice, so the
  // FIRST failover attempt re-resolves the SAME channel through a different provider before the data plane
  // starts walking the operator's configured backups (a different real-world feed is the bigger hammer).
  // ONE attempt is enough because the adapter's own resolve walks every remaining alternate internally —
  // which also means the offset for child indexing is a CONSTANT, so children stay deterministically
  // ordered with no per-channel bookkeeping in the seam.
  const altAttempts = adapter.playerSelectable ? 1 : 0;
  if (attempt !== undefined && attempt > altAttempts) {
    return buildFailoverGrant(source, url, pl, attempt, altAttempts);
  }
  // `advance` = this is that alternate-upstream attempt: tell the adapter the upstream it last handed us
  // died so it excludes it. `deep` = validate one level further before accepting an upstream; probeAll is
  // the ONLY caller that omits `attempt` (the data plane always sends one), so deep validation rides the
  // live path exclusively and the scheduled sweep's per-channel cost is unchanged.
  const advance = attempt !== undefined && attempt >= 1;
  const deep = attempt !== undefined;

  // SSRF guard: `url` is the entry taken VERBATIM from the request path, and Rust does NOT run ssrf_ok on the
  // trusted-entry hop (proxy.rs gates hops only) — so an arbitrary URL here would make the data plane fetch it
  // (internal SSRF / open proxy: cloud-metadata, LAN hosts, response exfiltration). Every LEGITIMATE entry is a
  // stored channel's streamEntryUrl — the exported m3u/lineup reference exactly those, and the index
  // {streamEntryUrl, source} makes this exists() cheap. Reject anything else before resolving or fetching it.
  // This closes the identity-passthrough (direct/hdhomerun) AND non-sentinel (dulo/dlhd isEntryUrl→false)
  // open-proxy paths uniformly; the failover path (attempt>=1, above) is already DB-sourced, not request-driven.
  if (!(await PlaylistChannel.exists({ streamEntryUrl: url }))) {
    // Logged at warn because the ONE false-positive shape — a stored channel whose streamEntryUrl drifted out
    // of sync with an already-exported m3u — is otherwise indistinguishable from an attack: the operator just
    // sees a channel stop playing. A re-sync re-stamps the entry and fixes it.
    logger.warn('proxy', `rejected unrecognized entry for ${source}: ${url.slice(0, 120)}`);
    return { ok: false, status: 403, error: 'unrecognized_entry' };
  }

  let target = url;
  let isEntry = false;
  let servingPlayer: { index: number; count: number } | null = null;
  try {
    if (adapter.isEntryUrl(url)) {
      isEntry = true;
      // playerSelectable sources (dlhd): read the per-channel player override; resolveStream applies the
      // source-wide default when it's 0/unset, prefers the player it last saw work, and falls through the
      // rest on failure.
      const opts: ResolveStreamOptions = { deep };
      if (adapter.playerSelectable) {
        opts.player = await channelPlayerPref(source, url, pl);
        opts.advance = advance;
        if (advance && advanceReason) opts.advanceReason = advanceReason;
      }
      const resolved = await adapter.resolveStream(url, opts);
      target = resolved.masterUrl;
      if (typeof resolved.playerIndex === 'number') {
        servingPlayer = { index: resolved.playerIndex, count: resolved.playerCount ?? 0 };
      }
    }
    if (advance && !servingPlayer) {
      // Defensive: an advance attempt that produced no ALTERNATE would hand the data plane the same
      // upstream that just died and be read as a recovery. 502 instead, so the walk moves to the children.
      return { ok: false, status: 502, error: 'resolve_failed: no alternate upstream for this entry' };
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (advance) {
      // Issue-level (≥1): the alternate-upstream stage is the last thing between a dead provider and the
      // operator's configured backups, so its failure is worth surfacing at the quietest verbosity.
      logger.warn('failover', `no alternate upstream for ${source} ${url.slice(0, 120)}: ${msg}`);
    }
    return { ok: false, status: 502, error: `resolve_failed: ${msg}` };
  }

  // The effective proxy config for this stream: the Custom app_<pl> override → the Default app → env defaults.
  // Resolved by the OWNING playlist id the composed M3U stamps as ?pl (=== the channel's source; see
  // m3u/serialize.ts). The in-app appPlayer path carries no ?pl → the Default applies (CFG/PXY-2).
  const proxyConfig = await resolveProxyConfig(pl);

  // Snapshot the per-stream upstream headers against the resolved target (dlhd: the CDN-host branch →
  // { Referer: playerReferer(), UA }; dulo: a constant map — it ignores the url arg), then merge the operator
  // headerOverrides ON TOP (operator wins, CASE-INSENSITIVELY — HTTP header names are case-insensitive and Rust
  // normalizes them, so a `referer` override must beat the adapter's `Referer`, not race it). This is the one
  // proxy-config knob applied Node-side, so Rust replays the final set unchanged.
  const upstreamHeaders = mergeUpstreamHeaders(adapter.proxy.upstreamHeaders(target), proxyConfig.headerOverrides);

  // Probe the relabel rule generically: force-type iff the adapter rewrites our sentinel for a 'segment'.
  const probed = adapter.proxy.relabelSegmentContentType('https://x/s.ts', RELABEL_PROBE, 'segment');
  const relabelSegment = probed && probed !== RELABEL_PROBE ? probed : null;

  // Attribution. An alternate upstream is a failover in every sense the operator cares about — the channel
  // it asked for is being carried by something other than its usual provider — so it rides the SAME
  // telemetry/badge path as a failover-group child, naming the player instead of a sibling channel.
  //
  // Reported on a play-time `advance` AND whenever a primary resolve lands on anything but Player 1: with
  // the resolver's sticky memory, a channel dropped by its default provider silently settles on another one
  // and would otherwise look completely ordinary in Active Streams. Player 1 is DaddyLive's own default and
  // the historical single path, so "not Player 1" is exactly the case worth surfacing.
  // `attempt !== undefined` keeps probeAll out of this entirely (it resolves every channel on a schedule and
  // must never touch a stream's failover attribution — same discriminator as `deep` above).
  const failover =
    attempt !== undefined && servingPlayer && (advance || servingPlayer.index !== 1)
      ? {
          attempt: attempt ?? 0,
          total: servingPlayer.count,
          candidateId: `${source}:player-${servingPlayer.index}`,
          candidateName: `Player ${servingPlayer.index}`,
        }
      : null;
  if (failover) {
    noteFailoverServing(source, url, failover);
    // Milestone (≥2): an alternate provider is now carrying the channel — the headline event, same tier as
    // "serving backup N" below.
    logMilestone('failover', `serving ${failover.candidateName} for ${source} ${url.slice(0, 120)}`);
  } else if (attempt === 0) {
    // An explicit attempt 0 is the data plane (re)trying the channel itself — any prior "something else is
    // serving" attribution is stale the moment this grant is built (a later failed fetch re-sets it).
    noteFailoverServing(source, url, null);
  }
  // Attribution + the requested-vs-served pair, recorded where they are RESOLVED. Both carry the same
  // `attempt !== undefined` gate as the failover block above, and for the same reason: probeAll resolves
  // every Active channel on a schedule with no `attempt` and no `pl`, so ungated it would (a) overwrite a
  // live stream's host attribution and (b) — worse — record the DEFAULT proxy config over a Custom
  // playlist's, making the panel report `originEnabled: false` for a channel demonstrably running a ring.
  if (attempt !== undefined) {
    try {
      noteUpstreamHost(source, url, new URL(target).host);
    } catch {
      // Entries are not guaranteed to be URLs — the synthetic sources accept arbitrary stored values.
    }
    noteRequestedConfig(source, url, {
      outputFormat: proxyConfig.outputFormat,
      originEnabled: proxyConfig.originEnabled,
      originRingMb: proxyConfig.originRingMb,
      spliceNormalize: proxyConfig.spliceNormalize,
    });
  }

  // P1 sources (dulo/dlhd) are all public-CDN + private-IP-rejecting. A future LAN adapter (hdhomerun/
  // local) will need a per-adapter signal here to allow private targets; hardcoded false is correct for now.
  return {
    ok: true,
    target,
    upstreamHeaders,
    relabelSegment,
    allowPrivate: false,
    isEntry,
    playerSelectable: !!adapter.playerSelectable,
    proxyConfig,
    adSignature: adapter.proxy.adSignature ?? null,
    policySource: source,
    failover,
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
  /**
   * How many earlier attempts the seam spent on the source's own alternate upstreams (see the
   * alternate-upstream stage in buildGrant). Children are indexed by `attempt - offset` so their ordering
   * is unaffected by that stage, while the wire/log `attempt` stays the data plane's own cursor value —
   * otherwise Rust's log lines and Node's would disagree about which attempt is which.
   */
  offset = 0,
): Promise<ResolveGrant | ResolveError> {
  const childIndex = attempt - offset;
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
  const cand = children[childIndex - 1];
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
      `backup ${childIndex} (attempt ${attempt}) ("${cand.tvg_name}") for ${parent.id}: unknown adapter '${candSource}'`,
    );
    return { ok: false, status: 502, error: `resolve_failed: unknown candidate adapter '${candSource}'` };
  }

  let target = cand.streamEntryUrl;
  let isEntry = false;
  try {
    if (candAdapter.isEntryUrl(target)) {
      isEntry = true;
      // Honor the failover child's OWN player override (playerSelectable sources); cand is already loaded, so
      // no extra read. resolveStream falls back to the source default (0/unset) + the other players on failure.
      // A backup is a live establish like any other, so it gets the same deep validation as the primary —
      // serving a backup that resolves but never streams would be the worst of both worlds.
      const opts: ResolveStreamOptions = { deep: true };
      if (candAdapter.playerSelectable && typeof cand.playerPref === 'number' && cand.playerPref > 0) {
        opts.player = cand.playerPref;
      }
      target = (await candAdapter.resolveStream(target, opts)).masterUrl;
    }
  } catch (err) {
    // This backup couldn't resolve its stream; the 502 advances the data plane to the next candidate.
    // Issue-level (≥1) — a failing backup is worth surfacing even at the quietest verbosity.
    logger.warn(
      'failover',
      `backup ${childIndex} (attempt ${attempt}) ("${cand.tvg_name}") for ${parent.id} resolve failed: ${(err as Error).message}`,
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
  // Same parent identity, and no `attempt` gate needed here — this function is only reachable from the
  // `attempt !== undefined && attempt > altAttempts` branch, and its own signature types `attempt` as a
  // required number, so probeAll can never reach this path.
  try {
    noteUpstreamHost(source, url, new URL(target).host);
  } catch {
    // As above: a stored entry is not guaranteed to be a URL.
  }
  noteRequestedConfig(source, url, {
    outputFormat: proxyConfig.outputFormat,
    originEnabled: proxyConfig.originEnabled,
    originRingMb: proxyConfig.originRingMb,
    spliceNormalize: proxyConfig.spliceNormalize,
  });
  // Milestone (≥2): a backup is now serving in place of the parent — the headline failover event.
  logMilestone(
    'failover',
    `serving backup ${childIndex}/${failover.total} ("${cand.tvg_name}") for ${parent.id}`,
  );

  return {
    ok: true,
    target,
    upstreamHeaders,
    relabelSegment,
    allowPrivate: false,
    isEntry,
    // The CHILD's capability, for the same reason as its signature below: a failover onto a single-upstream
    // provider must not keep the parent's alternates-exist promise, and vice versa.
    playerSelectable: !!candAdapter.playerSelectable,
    proxyConfig,
    // The CHILD's own signature, like its headers/relabel — a cross-provider backup must not inherit the
    // parent provider's ad shape (same reason policySource names candSource).
    adSignature: candAdapter.proxy.adSignature ?? null,
    policySource: candSource,
    failover,
  };
}
