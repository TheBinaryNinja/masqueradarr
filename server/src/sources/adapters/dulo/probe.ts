// probe.ts — the playlist-config Test probe for dulo (SourceAdapter.testDomain): does a candidate domain serve
// dulo's Live TV catalog, and is it a dulo frontend build? The bundle scrape is the stronger signal — any site can
// 404, but only dulo's build carries an `sb_publishable_` key next to a supabase.co project URL. It uses the
// cache-free scrapeSupabaseConfig (not discoverSupabaseConfig), so probing a candidate can never poison the ACTIVE
// session's Supabase config. Read-only: it never calls setDomain() or touches the session.

import { browserHeadersFor, catalogUrlFor, originFor } from './config.js';
import { scrapeSupabaseConfig } from './supabaseConfig.js';
import type { DomainProbe } from '../../types.js';

const PROBE_TIMEOUT_MS = 10_000;

export async function probeDuloDomain(domain: string): Promise<DomainProbe> {
  const endpoint = catalogUrlFor(domain);
  const startedAt = Date.now();
  const notes: string[] = [];
  let httpStatus: number | null = null;
  let channelCount: number | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(endpoint, {
      headers: browserHeadersFor(originFor(domain)),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    httpStatus = res.status;
    if (res.ok) {
      const raw = await res.text();
      let body: { channels?: unknown[] } | null = null;
      try {
        body = JSON.parse(raw) as { channels?: unknown[] };
      } catch {
        // A site that serves its SPA shell for unknown paths answers 200 with HTML — the API is not here.
        error = /^\s*</.test(raw)
          ? "catalog URL answered with a web page, not JSON — dulo's API is not at this domain"
          : 'catalog is not valid JSON';
      }
      if (body) {
        channelCount = Array.isArray(body.channels) ? body.channels.length : 0;
        if (channelCount === 0) error = 'catalog answered but lists no channels';
      }
    } else {
      await res.body?.cancel().catch(() => undefined);
      error = `catalog returned HTTP ${res.status}`;
    }
  } catch (err) {
    error = (err as Error).message;
  }
  const ms = Date.now() - startedAt;

  const supabase = await scrapeSupabaseConfig(originFor(domain));
  if (supabase) notes.push(`dulo build confirmed (Supabase project ${new URL(supabase.supabaseUrl).host})`);
  else notes.push('no dulo frontend bundle found — double-check this is dulo');

  return {
    ok: channelCount !== null && channelCount > 0,
    endpoint,
    httpStatus,
    ms,
    channelCount,
    redirectTo: null,
    notes,
    error,
  };
}
