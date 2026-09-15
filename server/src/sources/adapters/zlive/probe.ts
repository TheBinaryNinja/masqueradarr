// probe.ts — the playlist-config Test probe for zlive (SourceAdapter.testDomain). It makes exactly ONE request, to
// the candidate's public channel catalog, and deliberately never touches the stream resolver: every resolver hit is
// logged per IP on zlive's side (it ranks clients by unique streams and keeps a leech list), so a settings probe
// must not spend one. Redirects are reported, not followed — a moved domain shows up as "redirects to X" (the
// operator's next candidate) and the probe never hops to a host nobody vetted. Read-only: never calls setDomain().

import { UA, catalogUrlFor, parseCatalog, resolverBaseFor, slugOf } from './config.js';
import type { DomainProbe } from '../../types.js';

const PROBE_TIMEOUT_MS = 10_000;

export async function probeZliveDomain(domain: string): Promise<DomainProbe> {
  const endpoint = catalogUrlFor(domain);
  const startedAt = Date.now();
  const notes: string[] = [`streams resolve through ${new URL(resolverBaseFor(domain)).host} (not probed)`];
  let httpStatus: number | null = null;
  let channelCount: number | null = null;
  let redirectTo: string | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(endpoint, {
      redirect: 'manual',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    httpStatus = res.status;
    if (res.status >= 300 && res.status < 400) {
      redirectTo = res.headers.get('location');
      error = `catalog redirects (HTTP ${res.status})${redirectTo ? ` to ${redirectTo.slice(0, 160)}` : ''} — if zlive moved, test that domain instead`;
      await res.body?.cancel().catch(() => undefined);
    } else if (res.ok) {
      const rows = parseCatalog(await res.json());
      if (rows) {
        // The same count a sync would produce: rows whose id yields a slug the resolver would sign.
        channelCount = rows.filter((row) => slugOf(row.id) !== null).length;
        if (channelCount === 0) error = 'catalog lists no usable channels';
      } else {
        error = 'catalog is not a JSON array — this does not look like zlive';
      }
    } else {
      error = `catalog returned HTTP ${res.status}`;
      await res.body?.cancel().catch(() => undefined);
    }
  } catch (err) {
    error = (err as Error).message;
  }

  return {
    ok: channelCount !== null && channelCount > 0,
    endpoint,
    httpStatus,
    ms: Date.now() - startedAt,
    channelCount,
    redirectTo,
    notes,
    error,
  };
}
