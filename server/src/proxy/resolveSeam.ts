import { getSource } from '../sources/registry.js';

// The RESOLVE SEAM (control plane). Given a stream request the Rust data plane can't resolve itself, Node
// runs the stateful, per-source adapter logic (dulo Supabase auth, dlhd 3-hop scrape + mirror rotation, the
// SourceProxy bag) and returns a per-stream GRANT the sidecar replays for the whole stream. This keeps ALL
// churn-prone provider logic in TypeScript; Rust just fetches + rewrites + pipes.
//
// Faithfulness notes (verified against the adapters):
//  · upstreamHeaders is per-stream CONSTANT — snapshot once here (for dlhd/dami this captures the rotating
//    playerReferer per stream, which is MORE correct than the shared module global the old proxy replayed).
//  · The SSRF allowlist is OBSERVATIONAL: Rust seeds it from the resolved target host and grows it from the
//    hosts it rewrites out of each manifest (all of dulo/dlhd/dami enable dynamic-allow), so the grant needs
//    NO host list — only `allowPrivate` (false for these public-CDN sources; a future LAN source flips it).
//  · relabelSegment is derived by PROBING the adapter's relabel rule with a sentinel content-type, so the
//    core stays generic (no per-source branch): dulo passes the sentinel through → null; dlhd/dami force
//    'video/mp2t' on segments → 'video/mp2t'.

export interface ResolveGrant {
  ok: true;
  /** The URL the sidecar fetches for the ENTRY hop: a resolved master (dulo/dlhd) or the entry itself (direct sources). */
  target: string;
  /** Headers to replay on EVERY hop of this stream (master/variant/segment). Per-stream constant. */
  upstreamHeaders: Record<string, string>;
  /** Force this content-type on non-manifest (segment) responses; null = pass upstream through. */
  relabelSegment: string | null;
  /** Permit private/loopback upstream IPs (LAN sources). false for the public-CDN sources (dulo/dlhd/dami). */
  allowPrivate: boolean;
  /** Whether the request URL needed server-side resolution (vs a direct passthrough entry). */
  isEntry: boolean;
}

export interface ResolveError {
  ok: false;
  status: number;
  error: string;
}

const RELABEL_PROBE = 'application/x-masq-probe';

export async function buildGrant(source: string, url: string, _pl?: string): Promise<ResolveGrant | ResolveError> {
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

  // Snapshot the per-stream upstream headers against the resolved target (dlhd/dami: the CDN-host branch →
  // { Referer: playerReferer(), UA }; dulo: a constant map — it ignores the url arg).
  const upstreamHeaders = adapter.proxy.upstreamHeaders(target);

  // Probe the relabel rule generically: force-type iff the adapter rewrites our sentinel for a 'segment'.
  const probed = adapter.proxy.relabelSegmentContentType('https://x/s.ts', RELABEL_PROBE, 'segment');
  const relabelSegment = probed && probed !== RELABEL_PROBE ? probed : null;

  // P1 sources (dulo/dlhd/dami) are all public-CDN + private-IP-rejecting. A future LAN adapter (hdhomerun/
  // local) will need a per-adapter signal here to allow private targets; hardcoded false is correct for now.
  return { ok: true, target, upstreamHeaders, relabelSegment, allowPrivate: false, isEntry };
}
