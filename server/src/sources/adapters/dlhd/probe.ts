// probe.ts — the playlist-config Test probe for DaddyLive (SourceAdapter.testDomain). Answers "does this candidate
// domain serve DaddyLive's 24/7 channel directory?" by doing exactly what a sync does — GET /24-7-channels.php and
// run the shared card parser — so "the mirror works" is decided by the same extractor that produces the catalog.
// One request, read-only: it never calls setBase() or touches the resolver.

import { UA } from './config.js';
import { parseChannels } from './parseDirectory.js';
import type { DomainProbe } from '../../types.js';

const PROBE_TIMEOUT_MS = 10_000;
// A working mirror lists hundreds of channels; a handful means an error or placeholder page that happens to
// carry a card or two.
const MIN_CHANNELS = 50;

export async function probeDlhdDomain(domain: string): Promise<DomainProbe> {
  const base = `https://${domain}`;
  const endpoint = `${base}/24-7-channels.php`;
  const startedAt = Date.now();
  const notes: string[] = [];
  try {
    const res = await fetch(endpoint, {
      headers: { Referer: `${base}/`, 'User-Agent': UA },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.redirected) {
      const landed = new URL(res.url).host;
      if (landed !== domain) notes.push(`redirects to ${landed} — consider using that domain directly`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        endpoint,
        httpStatus: res.status,
        ms: Date.now() - startedAt,
        channelCount: null,
        redirectTo: null,
        notes,
        error: `channel directory returned HTTP ${res.status}`,
      };
    }
    const channels = parseChannels(await res.text()).length;
    const ok = channels >= MIN_CHANNELS;
    if (ok) notes.push('DaddyLive channel directory confirmed');
    return {
      ok,
      endpoint,
      httpStatus: res.status,
      ms: Date.now() - startedAt,
      channelCount: channels,
      redirectTo: null,
      notes,
      error: ok
        ? null
        : channels === 0
          ? 'no channel cards found — this does not look like a DaddyLive mirror (or its page layout changed)'
          : `only ${channels} channels parsed — a working mirror lists hundreds`,
    };
  } catch (err) {
    return {
      ok: false,
      endpoint,
      httpStatus: null,
      ms: Date.now() - startedAt,
      channelCount: null,
      redirectTo: null,
      notes,
      error: (err as Error).message,
    };
  }
}
