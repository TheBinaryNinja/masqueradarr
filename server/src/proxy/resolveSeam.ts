import { getSource } from '../sources/registry.js';
import { resolveProxyConfig } from '../proxyconfig/resolve.js';
import type { RuntimeProxyConfig } from '../proxyconfig/translate.js';
import { PlaylistChannel, type PlaylistChannelDoc } from '../models/PlaylistChannel.js';
import type { ResolveStreamOptions, SourceAdapter } from '../sources/types.js';
import {
  liveStreams,
  noteFailoverServing,
  noteUpstreamHost,
  noteRequestedConfig,
} from '../sources/core/streamTelemetry.js';
import { streamKey } from '../sources/core/streamState.js';
import { logger } from '../sources/core/logger.js';
import { logMilestone, logTrace } from '../logs/tier.js';

// The RESOLVE SEAM (control plane). Given a stream request the Rust data plane can't resolve itself, Node
// runs the stateful, per-source adapter logic (dulo Supabase auth, dlhd 3-hop scrape + mirror rotation, the
// SourceProxy bag) and returns a per-stream GRANT the sidecar replays for the whole stream. This keeps ALL
// churn-prone provider logic in TypeScript; Rust just fetches + rewrites + pipes.
//
// Faithfulness notes (verified against the adapters):
//  · upstreamHeaders is per-stream CONSTANT — snapshot once here. An adapter whose headers depend on the resolve
//    returns them with it (ResolvedStream.upstreamHeaders — dlhd's player-page Referer/Origin); the rest are the
//    adapter's `proxy.upstreamHeaders(target)` rule.
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
//  · Adapter CAPABILITIES ride the grant as declared values, never as source ids — Rust must not know adapter
//    names (playerSelectable, adSignature, segmentUnwrap). The one capability applied HERE instead is
//    `originRequired`: it is folded into proxyConfig.originEnabled, so the data plane sees an ordinary knob.
//  · expiresAtMs is the resolved TARGET's own validity (a signed URL's token expiry, when the adapter knows it),
//    so the data plane re-resolves ahead of it instead of discovering the expiry as a 403 mid-stream. The other
//    direction: when the target fails BEFORE that (refused outright, or its playlist stops refreshing), the data
//    plane says so in the resolve's `reason`, and the adapter is asked for a fresh one (opts.fresh) rather than
//    whatever it cached — see FRESH_REASONS.
//  · A source's concurrent-stream cap (maxConcurrentStreams) is enforced here, BEFORE the adapter resolves —
//    a refused stream costs the upstream nothing — against the adapter actually SERVING each stream, failover
//    children included. See admitToCap.

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
   * The serving adapter's segments arrive wrapped in a container prefix the data plane must strip
   * (`SourceProxy.segmentUnwrap`). Adapter-declared like adSignature, and the serving CANDIDATE's own value on a
   * failover grant: Rust files it on the policySource policy, so a disguised provider carried as a backup under
   * a plain one still gets unwrapped, and the plain parent's own streams are never touched.
   */
  segmentUnwrap: boolean;
  /**
   * Epoch ms at which `target` stops being valid (the adapter's `ResolvedStream.expiresAtMs`), or null when
   * unknown — the direct/identity sources, and any adapter that doesn't report one. Always null when the entry
   * needed no resolution (`isEntry: false`): an unresolved entry is its own stable URL.
   */
  expiresAtMs: number | null;
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
  /** Optional operator-facing detail, sent beside `error` in the resolve seam's reply (routes/internal.ts). */
  message?: string;
}

const RELABEL_PROBE = 'application/x-masq-probe';

// The resolve `reason`s that mean "the target this candidate was serving failed before its expiry" — the data
// plane sends them on a re-resolve it makes BECAUSE of a failure: the upstream refused the cached target outright
// (401/403/410 on the entry → `target_rejected`), or the origin ingest could not refresh the playlist it was
// following (`refresh_failed`). A scheduled renewal carries no reason, so it is still answered from an adapter's
// cache. `-` and `_` separators are treated alike; the vocabulary is the data plane's, this only reads it.
const FRESH_REASONS = new Set(['target_rejected', 'refresh_failed']);

/** Does the data plane's `reason` ask for a FRESHLY resolved target (ResolveStreamOptions.fresh)? */
function wantsFresh(reason: string | undefined): boolean {
  return !!reason && FRESH_REASONS.has(reason.replace(/-/g, '_'));
}

// A resolve result's expiry, validated into epoch ms or null. The data plane schedules a proactive re-resolve
// off this value, so garbage must degrade to "unknown", never to "refresh now": a seconds-epoch (a unit slip —
// 1.7e9 reads as January 1970 in ms), NaN, or an instant already past would otherwise fire a renewal at once
// and, on the next grant, again — a re-resolve loop against the very upstream the expiry exists to spare.
function expiryOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > Date.now() ? Math.floor(v) : null;
}

// The effective proxy config for a stream served by `adapter`: the Custom app_<pl> override → the Default app →
// env defaults (proxyconfig/resolve.ts), with the adapter's `originRequired` forced on top. Called with the
// SERVING adapter — the child's on a failover grant — because the Rust SourcePolicy the config lands on is
// keyed by policySource: a backup from an origin-only provider must run on the origin, and a plain backup
// under an origin-only parent must not inherit the force. Forcing it here, before noteRequestedConfig, is
// what makes Active Streams report the value the stream actually runs with.
async function effectiveProxyConfig(adapter: SourceAdapter, pl?: string): Promise<RuntimeProxyConfig> {
  const cfg = await resolveProxyConfig(pl);
  return adapter.proxy.originRequired ? { ...cfg, originEnabled: true } : cfg;
}

// ── Per-source concurrent-stream cap (SourceAdapter.maxConcurrentStreams) ────────────────────────────────
// Counts the DISTINCT live streams an adapter's upstream is carrying — the unit an upstream that ranks "unique
// streams per client" sees; N viewers of one channel share one ingest and count once — and refuses a NEW one at
// the cap. Two inputs, because neither alone is a cap:
//   · telemetry (liveStreams): a stream with a viewer inside its recency TTL, an open raw-TS socket even while
//     it is starved of bytes, or a channel a socket closed on moments ago (streamTelemetry CAP LIVENESS).
//     Authoritative, but it LAGS: a viewer is only recorded on its first SUCCESSFUL manifest poll, which for an
//     origin-served channel waits for the ring to fill (several target durations). Two channels opened inside
//     that window would both read the same count and both be admitted.
//   · admission holds (capHolds): every stream this seam admitted in the last CAP_HOLD_MS, stamped in the SAME
//     synchronous step as the check — Node runs one request's check-then-reserve to completion before any
//     other's, so two concurrent new channels cannot both slip under the cap. A reservation whose resolve
//     then fails is released, so a dead upstream never occupies a slot; every re-grant refreshes the hold.
//     Everything else a grant needs that can fail (the proxy-config read) runs BEFORE the reservation, so no
//     path out of the seam leaves a reservation neither confirmed nor released.
// A stream already counted is always admitted: an origin ingest renewing an expiring token, a second viewer,
// a reconnect — none is a NEW stream, and refusing them would kill a channel that is legitimately playing.
//
// WHO IS COUNTED. A stream is identified the way the data plane reports it — streamKey(mount source, entry),
// the channel the viewer asked for — but it is counted against the adapter SERVING it, which a failover child
// makes a different one: the child carries its parent's stream under the parent's identity (every viewer event
// keys on the parent's (source, entry)), so telemetry alone cannot tell. `servedBy` records, per stream, which
// adapter its last grant went to. Without it a zlive backup under a dlhd parent was never counted against zlive
// (an uncapped way around the cap), and a zlive parent carried by a dlhd backup kept occupying a zlive slot.
// Failover children are therefore capped like any other stream (buildFailoverGrant), keyed on that same
// stream: a backup from the SAME adapter that was already carrying the stream is not a new one and is admitted;
// a backup from another capped adapter is.
//
// REFUSAL SHAPES. A refusal the data plane cannot route around is a 429 `source_stream_cap`, which it treats
// as DEFINITIVE — no failover walk, no retry loop — and relays to the client as-is. Wherever a later candidate
// COULD carry the stream instead (a grouped parent with a backup on another adapter, the alternate-upstream
// stage, a capped failover child), the refusal is a plain walkable 502 instead (capRefusal), so the walk reaches
// that candidate rather than ending on a cap that only binds this one.
//
// Honest limits: in-memory (a restart forgets it — nothing is live after a restart either), and a channel
// whose last viewer left keeps counting for ~30 s: a poll client until its TTL lapses, a raw-TS socket for the
// same window after its close. That is also the window its origin ingest keeps pulling upstream in its idle
// grace, so the refusal describes real upstream load; the price is that zapping away from a channel frees its
// slot half a minute later, not at once.
const CAP_HOLD_MS = 30_000;
/** serving adapter id → stream key → when it was admitted/granted, and the entry to list it under in status. */
const capHolds = new Map<string, Map<string, CapHold>>();
/**
 * stream key → the adapter its last grant went to, for a stream carried by an adapter OTHER than its mount
 * source (a cross-provider failover child). Absent ⇒ its mount source serves it, which is every stream a
 * primary grant went out for — so only failover-carried streams are ever stored. Pruned by cappedStreams once
 * the stream has no viewer and no hold, and its grant is older than the hold window (`at`) — the telemetry lag
 * a hold covers applies here too, and an UNCAPPED serving adapter takes no hold that could cover it.
 */
const servedBy = new Map<string, { adapter: string; at: number }>();
const capRefusals = new Map<string, { count: number; last: { at: number; entry: string } | null }>();

interface CapHold {
  at: number;
  entry: string;
}

/** The adapter's cap, or 0 for unlimited (absent, null, 0 — and junk such as NaN or a negative). */
function streamCapOf(adapter: SourceAdapter): number {
  const n = adapter.maxConcurrentStreams?.();
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * The streams counted against `adapterId`'s cap right now (stream key → entry): every live stream whose serving
 * adapter it is, ∪ its unexpired holds. Prunes expired holds and spent `servedBy` attributions on the way.
 */
function cappedStreams(adapterId: string, now: number): Map<string, string> {
  const live = liveStreams();
  for (const [key, s] of servedBy) {
    if (live.has(key) || now - s.at <= CAP_HOLD_MS) continue;
    const hold = capHolds.get(s.adapter)?.get(key);
    if (!hold || now - hold.at > CAP_HOLD_MS) servedBy.delete(key);
  }
  const counted = new Map<string, string>();
  for (const [key, s] of live) {
    if ((servedBy.get(key)?.adapter ?? s.source) === adapterId) counted.set(key, s.entryUrl);
  }
  const holds = capHolds.get(adapterId);
  if (holds) {
    for (const [key, h] of holds) {
      if (now - h.at > CAP_HOLD_MS) holds.delete(key);
      else counted.set(key, h.entry);
    }
  }
  return counted;
}

/**
 * A grant for stream `key` is going out, carried by `adapterId`: attribute the stream to it (clearing the entry
 * when that is the mount source itself), and retire every OTHER adapter's hold on the stream — its upstream is
 * no longer being pulled for it, so the slot it reserved is free now, not half a minute from now.
 */
function noteServedBy(key: string, mountSource: string, adapterId: string): void {
  if (adapterId === mountSource) servedBy.delete(key);
  else servedBy.set(key, { adapter: adapterId, at: Date.now() });
  for (const [id, holds] of capHolds) if (id !== adapterId) holds.delete(key);
}

interface CapSlot {
  ok: true;
  /** The resolve failed — give back a hold THIS admission created (a no-op for an already-counted stream). */
  release(): void;
  /** The grant is going out — refresh the hold so it outlives the telemetry lag from THIS moment. */
  confirm(): void;
}

interface CapRefusal {
  ok: false;
  /** How many streams the adapter is counted as carrying, and its cap — the refusal's own sentence. */
  live: number;
  cap: number;
}

/**
 * Admit stream `key` (named by `entry` in status/logs) under `adapterId`'s cap, reserving it, or refuse it. Only
 * decides and reserves — the caller turns a refusal into the right reply for where it stands (capRefusal).
 */
function admitToCap(adapterId: string, key: string, entry: string, cap: number): CapSlot | CapRefusal {
  const now = Date.now();
  const counted = cappedStreams(adapterId, now);
  const isNew = !counted.has(key);
  if (isNew && counted.size >= cap) return { ok: false, live: counted.size, cap };
  const holds = capHolds.get(adapterId) ?? new Map<string, CapHold>();
  capHolds.set(adapterId, holds);
  // Reserve only a NEW stream. An already-counted one needs no reservation, and stamping it here would let a
  // FAILED re-resolve (an ingest in its idle grace, say) keep holding a slot its confirm never earned.
  const stamp: CapHold | null = isNew ? { at: now, entry } : null;
  if (stamp) holds.set(key, stamp);
  return {
    ok: true,
    // Only undo OUR stamp: if a concurrent grant for the same stream re-stamped it meanwhile, it is theirs.
    release: () => {
      if (stamp && holds.get(key) === stamp) holds.delete(key);
    },
    confirm: () => {
      holds.set(key, { at: Date.now(), entry });
    },
  };
}

/**
 * Turn a cap refusal into the seam's reply. `walkable: false` is the DEFINITIVE 429 `source_stream_cap` — only
 * where no later candidate could carry the stream instead, because the data plane ends the walk on it. `true` is
 * a plain 502 `resolve_failed`, for a refusal a later candidate can route around: its error must never be
 * `source_stream_cap` (and its status never 429), which Rust's seam_failure reads as the terminal refusal. The
 * message is the same sentence either way — it is what the viewer sees if the walk runs out.
 */
function capRefusal(
  adapter: SourceAdapter,
  entry: string,
  r: CapRefusal,
  walkable: boolean,
  note: string,
): ResolveError {
  const now = Date.now();
  const rec = capRefusals.get(adapter.id) ?? { count: 0, last: null };
  // Issue-level (≥1): an operator needs to see a stream being turned away. Throttled per entry, because a
  // refused IPTV client typically retries the same channel every few seconds — one warn per entry per hold
  // window says everything; the repeats drop to level-3 lineage.
  const repeat = rec.last?.entry === entry && now - rec.last.at < CAP_HOLD_MS;
  const line = `${adapter.id}: stream cap ${r.cap} reached (${r.live} live) — refused ${entry.slice(0, 120)}${note}`;
  if (repeat) logTrace('proxy', line);
  else logger.warn('proxy', line);
  capRefusals.set(adapter.id, { count: rec.count + 1, last: { at: now, entry } });
  const message =
    `${adapter.label} already has ${r.live} of ${r.cap} allowed concurrent stream(s) live — ` +
    'stop one before starting another';
  return walkable
    ? { ok: false, status: 502, error: `resolve_failed: ${adapter.label} stream cap reached`, message }
    : { ok: false, status: 429, error: 'source_stream_cap', message };
}

/** A source's stream-cap usage, for its adapter's status(). The same count the cap enforces, so they agree. */
export interface StreamCapStatus {
  /** The adapter's cap as of now (0 = unlimited). */
  cap: number;
  /**
   * Streams counted against it right now — one it is serving to a live viewer, or admitted within the last
   * CAP_HOLD_MS — each named by the entry the viewer requested (a failover-carried stream by its PARENT's).
   */
  live: string[];
  /** Refusals since boot (walkable ones included), and the most recent one. */
  refusals: number;
  lastRefusal: { at: number; entry: string } | null;
}

/** Read model over the cap bookkeeping above (e.g. for a capped adapter's status()). */
export function streamCapStatus(source: string): StreamCapStatus {
  const adapter = getSource(source);
  const rec = capRefusals.get(source);
  return {
    cap: adapter ? streamCapOf(adapter) : 0,
    live: [...cappedStreams(source, Date.now()).values()],
    refusals: rec?.count ?? 0,
    lastRefusal: rec?.last ?? null,
  };
}

// ── Failover-group lookups (shared by the cap refusal and buildFailoverGrant) ───────────────────────────────

/**
 * Identify the requested channel as a failover PARENT, or null when it heads no group. With ?pl (every exported
 * line stamps it — the owning playlist === the channel doc's `source`) the lookup is exact. The in-app player
 * carries no ?pl, and the same (adapter, entry URL) can back SEVERAL parent docs — the source playlist's own
 * channel ({origin:null, source}) plus any clone copy ({origin:source}), each groupable independently — so the
 * no-pl lookup must be DETERMINISTIC, not an arbitrary findOne: prefer the canonical source-playlist doc, then
 * the lexically-first clone copy (stable across requests).
 */
async function findFailoverParent(source: string, url: string, pl: string | undefined) {
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
  return parent?.failoverGroupId ? { ...parent, failoverGroupId: parent.failoverGroupId } : null;
}

/**
 * A group's candidates: its Active children in failover order. Disabled children are deliberately skipped
 * (status is the operator's exclusion governor — a disabled backup must never be served).
 */
function activeFailoverChildren(playlist: string, failoverGroupId: string): Promise<PlaylistChannelDoc[]> {
  return PlaylistChannel.find(
    { source: playlist, failoverGroupId, failoverRole: 'child', status: 'Active' },
    { _id: 0 },
  )
    .sort({ failoverOrder: 1 })
    .lean<PlaylistChannelDoc[]>()
    .exec();
}

/**
 * Could the failover walk carry this cap-refused stream on something OTHER than the cap that refused it? Only a
 * grouped parent with at least one Active child served by another known adapter qualifies, and only while
 * failover is enabled for `pl` — with it off the data plane never walks, and a walkable 502 would just turn the
 * viewer's "the cap is full" into a bare "resolve failed". A child on the refusing adapter itself does not count:
 * it would be asked about the same stream against the same cap, and refused the same way.
 */
async function backupCouldCarry(
  source: string,
  url: string,
  pl: string | undefined,
  refusingAdapter: string,
): Promise<boolean> {
  const parent = await findFailoverParent(source, url, pl);
  if (!parent) return false;
  const children = await activeFailoverChildren(parent.source, parent.failoverGroupId);
  const elsewhere = children.some((c) => {
    const id = c.origin ?? c.source;
    return id !== refusingAdapter && getSource(id) !== undefined;
  });
  return elsewhere && (await resolveProxyConfig(pl)).failoverEnabled;
}

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
 * Rust's attempt loop terminates on it (a plain 502 means "this candidate failed, try the next"). A source
 * at its concurrent-stream cap answers a NEW stream with 429 `source_stream_cap`, which is equally terminal —
 * so it is sent only where nothing else could carry the stream: an ungrouped channel, a group whose backups
 * all sit on the refusing adapter, or failover switched off. A grouped parent with a backup on another adapter
 * is refused with a walkable 502 instead, and so is a capped alternate-upstream attempt or failover child (see
 * capRefusal), because there the walk has somewhere left to go.
 *
 * `advanceReason` is the data plane's optional `reason`: WHY it is retiring the upstream it was serving. On a
 * playerSelectable alternate-upstream attempt it is recorded against the burnt provider (opts.advanceReason);
 * `target_rejected` / `refresh_failed` (see FRESH_REASONS) additionally ask the candidate being resolved — at
 * whatever attempt — for a freshly resolved target rather than a cached one (opts.fresh).
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
  // probeAll (attempt undefined) never sends a reason, and must never force a fresh resolve anyway.
  const fresh = attempt !== undefined && wantsFresh(advanceReason);

  // ALTERNATE-UPSTREAM STAGE (playerSelectable sources — dlhd). DaddyLive's "Player 1..6" are six
  // INDEPENDENT embed providers, and which of them carries a given channel changes without notice, so the
  // FIRST failover attempt re-resolves the SAME channel through a different provider before the data plane
  // starts walking the operator's configured backups (a different real-world feed is the bigger hammer).
  // ONE attempt is enough because the adapter's own resolve walks every remaining alternate internally —
  // which also means the offset for child indexing is a CONSTANT, so children stay deterministically
  // ordered with no per-channel bookkeeping in the seam.
  const altAttempts = adapter.playerSelectable ? 1 : 0;
  if (attempt !== undefined && attempt > altAttempts) {
    return buildFailoverGrant(source, url, pl, attempt, altAttempts, fresh);
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

  // The effective proxy config for this stream: the Custom app_<pl> override → the Default app → env defaults,
  // plus the adapter's originRequired force (effectiveProxyConfig). Resolved by the OWNING playlist id the
  // composed M3U stamps as ?pl (=== the channel's source; see m3u/serialize.ts). The in-app appPlayer path
  // carries no ?pl → the Default applies (CFG/PXY-2). Read, with the relabel probe, BEFORE the cap below
  // reserves a slot: a throw between a reservation and its confirm/release (a transient Mongo error here)
  // would leave a phantom hold refusing every other new stream for CAP_HOLD_MS.
  const proxyConfig = await effectiveProxyConfig(adapter, pl);

  // Probe the relabel rule generically: force-type iff the adapter rewrites our sentinel for a 'segment'.
  const probed = adapter.proxy.relabelSegmentContentType('https://x/s.ts', RELABEL_PROBE, 'segment');
  const relabelSegment = probed && probed !== RELABEL_PROBE ? probed : null;

  // PER-SOURCE STREAM CAP (adapter.maxConcurrentStreams). Live attempts only: the probe sweep (`attempt`
  // undefined) is not a stream and must never take or be refused a slot. Failover children were routed to
  // buildFailoverGrant above, which caps each against its OWN adapter. Checked BEFORE resolveStream, so a
  // refused stream costs the upstream nothing; the reservation is released below on every resolve failure.
  //
  // Which refusal (see capRefusal): the terminal 429 only where nothing else could carry the stream. The
  // alternate-upstream stage (`advance`) is mid-walk — whatever backups the channel has are still AHEAD of it —
  // so it is refused walkably. It used to be admitted unconditionally, as the continuation of an establish
  // attempt 0 had been admitted for; but attempt 0 may now have been refused itself (walkably, below), and
  // admitting the same stream on the same adapter one step later would walk straight around the cap. A stream
  // that is already playing (or whose attempt-0 grant went out) is counted, so it is still admitted here.
  const key = streamKey(source, url);
  const cap = attempt !== undefined ? streamCapOf(adapter) : 0;
  let capSlot: CapSlot | null = null;
  if (cap > 0) {
    const admitted = admitToCap(source, key, url, cap);
    if (!admitted.ok) {
      if (advance) return capRefusal(adapter, url, admitted, true, ' at the alternate-upstream stage — walking on');
      if (await backupCouldCarry(source, url, pl, source)) {
        return capRefusal(adapter, url, admitted, true, ' — walking to its failover backups');
      }
      return capRefusal(adapter, url, admitted, false, '');
    }
    capSlot = admitted;
  }

  let target = url;
  let isEntry = false;
  let expiresAtMs: number | null = null;
  let servingPlayer: { index: number; count: number } | null = null;
  let resolvedHeaders: Record<string, string> | undefined;
  let upstreamHeaders: Record<string, string>;
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
      // Any adapter: the target it handed out for this entry just failed early — a caching adapter must not
      // hand the same one back (zlive's Location cache). Adapters that don't cache ignore the flag.
      if (fresh) opts.fresh = true;
      const resolved = await adapter.resolveStream(url, opts);
      target = resolved.masterUrl;
      expiresAtMs = expiryOf(resolved.expiresAtMs);
      resolvedHeaders = resolved.upstreamHeaders;
      if (typeof resolved.playerIndex === 'number') {
        servingPlayer = { index: resolved.playerIndex, count: resolved.playerCount ?? 0 };
      }
    }
    if (advance && !servingPlayer) {
      // Defensive: an advance attempt that produced no ALTERNATE would hand the data plane the same
      // upstream that just died and be read as a recovery. 502 instead, so the walk moves to the children.
      capSlot?.release();
      return { ok: false, status: 502, error: 'resolve_failed: no alternate upstream for this entry' };
    }
    // The per-stream upstream headers: the ones the resolve reported for THIS stream when it has them (dlhd: the
    // Referer/Origin of the player page its playlist came from), else the adapter's rule for the resolved target
    // (dulo: a constant map — it ignores the url arg). Then the operator headerOverrides go ON TOP (operator wins,
    // CASE-INSENSITIVELY — HTTP header names are case-insensitive and Rust normalizes them, so a `referer` override
    // must beat the adapter's `Referer`, not race it). This is the one proxy-config knob applied Node-side, so Rust
    // replays the final set unchanged. Adapter code, so inside the guard: a throw releases the reservation like a
    // failed resolve.
    upstreamHeaders = mergeUpstreamHeaders(
      resolvedHeaders ?? adapter.proxy.upstreamHeaders(target),
      proxyConfig.headerOverrides,
    );
  } catch (err) {
    capSlot?.release();
    const msg = (err as Error).message;
    if (advance) {
      // Issue-level (≥1): the alternate-upstream stage is the last thing between a dead provider and the
      // operator's configured backups, so its failure is worth surfacing at the quietest verbosity.
      logger.warn('failover', `no alternate upstream for ${source} ${url.slice(0, 120)}: ${msg}`);
    }
    return { ok: false, status: 502, error: `resolve_failed: ${msg}` };
  }

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

  // The grant is going out: the capped stream's hold now runs from this moment, which is what covers the gap
  // until its first viewer shows up in telemetry. And the stream is now carried by THIS adapter again — any
  // failover child that was carrying it stops counting against its own adapter (probeAll never attributes).
  capSlot?.confirm();
  if (attempt !== undefined) noteServedBy(key, source, source);

  // P1 sources (dulo/dlhd) are all public-CDN + private-IP-rejecting. A future LAN adapter (hdhomerun/
  // local) will need a per-adapter signal here to allow private targets; hardcoded false is correct for now —
  // `direct` imports included: allowPrivate re-opens RFC 1918 AND every LAN host a manifest names, for every
  // public playlist an operator imports. A tailnet box reached by raw 100.x IP needs no flag: the data plane's
  // gate leaves 100.64.0.0/10 open (proxy.rs is_private_host).
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
    segmentUnwrap: adapter.proxy.segmentUnwrap === true,
    expiresAtMs,
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
  /**
   * The data plane is re-resolving this candidate because the target it was serving failed early (buildGrant's
   * `fresh`): forwarded to the CHILD's resolveStream, so a caching child adapter (a zlive backup) mints a new
   * target instead of replaying the refused one. On an escalation to the NEXT child the flag reaches a candidate
   * whose own target never failed; that costs at most one rate-limited fresh resolve (see ResolveStreamOptions).
   */
  fresh = false,
): Promise<ResolveGrant | ResolveError> {
  const childIndex = attempt - offset;
  // Identify the requested channel as a failover PARENT (exact with ?pl, deterministic without — see
  // findFailoverParent; the cap refusal in buildGrant asks the very same question).
  const parent = await findFailoverParent(source, url, pl);
  if (!parent) {
    // Defensive: Rust asked to fail over a channel that isn't a grouped parent (no group, or an in-app
    // probe past a plain channel). Normal terminator, not an operator-facing issue — level-3 lineage only.
    logTrace('failover', `attempt ${attempt}: ${url} is not a grouped failover parent — exhausted`);
    return { ok: false, status: 410, error: 'failover_exhausted' };
  }

  // Candidates = the group's Active children in failover order (activeFailoverChildren).
  const children = await activeFailoverChildren(parent.source, parent.failoverGroupId);
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

  // Keyed on the CHILD's adapter (its originRequired, not the parent's) — see effectiveProxyConfig. Read, with
  // the relabel probe, BEFORE the cap reserves a slot, as in buildGrant: nothing that can throw may sit between
  // a reservation and its confirm/release.
  const proxyConfig = await effectiveProxyConfig(candAdapter, pl);
  const probed = candAdapter.proxy.relabelSegmentContentType('https://x/s.ts', RELABEL_PROBE, 'segment');
  const relabelSegment = probed && probed !== RELABEL_PROBE ? probed : null;

  // The CANDIDATE's stream cap, against the stream this grant would carry — the PARENT's (source, entry), which
  // is how every viewer event for it is keyed. A backup is not exempt: one from another provider is a NEW stream
  // to that provider's upstream, and letting it through uncounted was a way around the cap. One from the adapter
  // already carrying this stream is not new, and is admitted even at the cap. A refusal is walkable (never the
  // terminal 429): the next candidate may well sit on an adapter with room.
  const key = streamKey(source, url);
  const candCap = streamCapOf(candAdapter);
  let capSlot: CapSlot | null = null;
  if (candCap > 0) {
    const admitted = admitToCap(candSource, key, cand.streamEntryUrl, candCap);
    if (!admitted.ok) {
      const note = ` — backup ${childIndex} (attempt ${attempt}) for ${parent.id}, trying the next`;
      return capRefusal(candAdapter, cand.streamEntryUrl, admitted, true, note);
    }
    capSlot = admitted;
  }

  let target = cand.streamEntryUrl;
  let isEntry = false;
  let expiresAtMs: number | null = null;
  let resolvedHeaders: Record<string, string> | undefined;
  let upstreamHeaders: Record<string, string>;
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
      if (fresh) opts.fresh = true;
      const resolved = await candAdapter.resolveStream(target, opts);
      target = resolved.masterUrl;
      // The CHILD's target expiry — it is the child's signed URL the data plane will be following.
      expiresAtMs = expiryOf(resolved.expiresAtMs);
      resolvedHeaders = resolved.upstreamHeaders;
    }
    // Same precedence as buildGrant: the child resolve's own per-stream headers, else its adapter's rule.
    upstreamHeaders = mergeUpstreamHeaders(
      resolvedHeaders ?? candAdapter.proxy.upstreamHeaders(target),
      proxyConfig.headerOverrides,
    );
  } catch (err) {
    capSlot?.release();
    // This backup couldn't resolve its stream; the 502 advances the data plane to the next candidate.
    // Issue-level (≥1) — a failing backup is worth surfacing even at the quietest verbosity.
    logger.warn(
      'failover',
      `backup ${childIndex} (attempt ${attempt}) ("${cand.tvg_name}") for ${parent.id} resolve failed: ${(err as Error).message}`,
    );
    return { ok: false, status: 502, error: `resolve_failed: ${(err as Error).message}` };
  }

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
  // The grant is going out: the child's hold runs from now, and the stream counts against the CHILD's adapter
  // (not the parent's mount source) until a later grant moves it again.
  capSlot?.confirm();
  noteServedBy(key, source, candSource);

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
    // Likewise the CHILD's wrapper: a disguised backup under a plain parent is unwrapped, and vice versa.
    segmentUnwrap: candAdapter.proxy.segmentUnwrap === true,
    expiresAtMs,
    policySource: candSource,
    failover,
  };
}
