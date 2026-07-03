import { getSource } from '../sources/registry.js';
import { resolveProxyConfig } from '../proxyconfig/resolve.js';
import type { RuntimeProxyConfig } from '../proxyconfig/translate.js';

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
//    applies the LIVE-in-P2 subset (connectTimeoutMs + maxRedirects → its upstream client); the deferred knobs
//    (read timeout / buffer / segment cache / output format) ride along for P3. headerOverrides are already
//    folded into upstreamHeaders above, so Rust ignores that field (no double-apply).

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

export async function buildGrant(source: string, url: string, pl?: string): Promise<ResolveGrant | ResolveError> {
  const adapter = getSource(source);
  if (!adapter) return { ok: false, status: 404, error: 'unknown_source' };

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

  // P1 sources (dulo/dlhd/dami) are all public-CDN + private-IP-rejecting. A future LAN adapter (hdhomerun/
  // local) will need a per-adapter signal here to allow private targets; hardcoded false is correct for now.
  return { ok: true, target, upstreamHeaders, relabelSegment, allowPrivate: false, isEntry, proxyConfig };
}
