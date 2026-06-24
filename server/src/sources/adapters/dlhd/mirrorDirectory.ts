// mirrorDirectory.ts — decide which dlhd content mirror to use, dynamically. Ported from
// ../d-combine/sources/dlhd/mirror-directory.mjs, plus a lazy TTL gate (ensureMirror) for the long-running
// server (the PoC resolved at build + boot + on a timer; Masqueradarr resolves on demand instead — see below).
//
// DaddyLive publishes a "Mirror Domains Directory" page whose job is to advertise the CURRENT working
// content mirrors as hyperlinks. The directory shows each as "Checking…" (liveness is computed in the
// browser), so we extract the advertised links and probe them OURSELVES, server-side, then commit the best.
//
//   resolveActiveMirror()
//     ├─ env DLHD_BASE set?  → use it verbatim (operator override wins), skip the directory
//     ├─ fetch the directory → advertised candidate origins (page order); else SEED_MIRRORS
//     ├─ probe ALL candidates concurrently: GET <c>/24-7-channels.php → parse channel cards
//     └─ pick the BEST (most channels, tie-break fastest) → setBase(); memoize provenance
//
// Imports ONLY config + the shared parser (+ logger) — never the adapter — so the import graph stays
// acyclic (parseDirectory ← mirrorDirectory ← adapter).

import { UA, getBase, setBase } from './config.js';
import { parseChannels } from './parseDirectory.js';
import { logger } from '../../core/logger.js';

/** One candidate mirror's probe outcome. */
export interface ProbeResult {
  base: string;
  ok: boolean;
  channels: number;
  ms: number;
  status?: number;
  reason?: string;
}

/** Provenance of the last mirror resolution — returned by the adapter's status() and the /status route. */
export interface MirrorResolution {
  chosen: string;
  source: 'env' | 'directory' | 'seed';
  directory: string | null;
  directoryOk: boolean;
  reason: string | null;
  candidates: string[];
  probes: ProbeResult[];
  degraded: boolean;
  chosenAt: string;
  ttlMs: number;
}

interface DirectoryResult {
  directory: string;
  candidates: string[];
  ok: boolean;
  reason?: string;
}

// The directory site to read advertised mirrors from. Override with DADDYLIVE_DIRECTORY.
const DIRECTORY_URL = (): string =>
  (process.env.DADDYLIVE_DIRECTORY || 'https://daddylive.pk').replace(/\/+$/, '');
// Known-good content mirrors — fallback if the directory is unreachable/empty, and always unioned in as a
// tail so a stale directory can't strand us.
const SEED_MIRRORS = ['https://dlhd.pk', 'https://dlstreams.com', 'https://dlhd.sx'];
// A candidate must yield at least this many parsed channel cards to count as a working content source.
const MIN_CHANNELS = Number(process.env.DLHD_PROBE_MIN_CHANNELS || 50);
const PROBE_TIMEOUT_MS = Number(process.env.DLHD_PROBE_TIMEOUT_MS || 8000);
// How often the long-running server re-resolves the active mirror. Exposed in provenance for the UI.
export const MIRROR_TTL_MS = Number(process.env.DLHD_MIRROR_TTL_MS || 1_800_000); // 30 min

let _resolution: MirrorResolution | null = null; // memoized provenance from the last resolveActiveMirror()

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`; // strip path/query; no trailing slash (matches cleanBase output)
  } catch {
    return null;
  }
}

/** Pull advertised mirror origins out of the directory HTML. Prefers anchor hrefs; falls back to any
 * absolute http(s) URL if the markup changed. Order-preserving. */
function extractCandidates(html: string, directoryHost: string): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const o = originOf(raw);
    if (!o) return;
    if (new URL(o).host === directoryHost) return; // skip the directory's own host
    const key = o.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(o);
  };

  let any = false;
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["'](https?:\/\/[^"']+)["']/gi)) {
    any = true;
    add(m[1]);
  }
  if (!any) {
    for (const m of html.matchAll(/https?:\/\/[^\s"'<>)]+/gi)) add(m[0]);
  }
  return ordered;
}

/** Fetch the directory and return advertised candidate mirror origins, in page order. */
export async function fetchDirectoryCandidates(): Promise<DirectoryResult> {
  const directory = DIRECTORY_URL();
  try {
    const res = await fetch(directory, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { directory, candidates: [], ok: false, reason: `HTTP ${res.status}` };
    const host = new URL(directory).host;
    const candidates = extractCandidates(await res.text(), host);
    return {
      directory,
      candidates,
      ok: candidates.length > 0,
      reason: candidates.length ? undefined : 'no links found',
    };
  } catch (err) {
    return { directory, candidates: [], ok: false, reason: (err as Error).message };
  }
}

/** Probe one candidate base by doing exactly what the live listings do: GET /24-7-channels.php and run the
 * shared channel parser. "Passes" ⇒ this mirror will produce a real catalog. */
export async function probeCandidate(base: string): Promise<ProbeResult> {
  const startedAt = Date.now();
  try {
    const res = await fetch(`${base}/24-7-channels.php`, {
      headers: { Referer: `${base}/`, 'User-Agent': UA },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const ms = Date.now() - startedAt;
    if (!res.ok) return { base, ok: false, channels: 0, ms, status: res.status };
    const channels = parseChannels(await res.text()).length;
    return { base, ok: channels >= MIN_CHANNELS, channels, ms };
  } catch (err) {
    return { base, ok: false, channels: 0, ms: Date.now() - startedAt, reason: (err as Error).message };
  }
}

/** Among passing probes, the best mirror is the one serving the most channels (tie-break: fastest). */
function pickBest(probes: ProbeResult[]): ProbeResult | undefined {
  return probes.filter((p) => p.ok).sort((a, b) => b.channels - a.channels || a.ms - b.ms)[0];
}

/** Resolve (and commit, via setBase) the active content mirror. Memoized; pass { force:true } to
 * re-resolve. Never throws — on total failure it keeps the current base and marks the result degraded. */
export async function resolveActiveMirror({ force = false }: { force?: boolean } = {}): Promise<MirrorResolution> {
  if (_resolution && !force) return _resolution;

  // 1) Operator override wins outright — pin the base, skip the directory + probes.
  const override = String(process.env.DLHD_BASE || '').trim();
  if (override) {
    const chosen = setBase(override);
    _resolution = {
      chosen,
      source: 'env',
      directory: null,
      directoryOk: false,
      reason: null,
      candidates: [chosen],
      probes: [],
      degraded: false,
      chosenAt: new Date().toISOString(),
      ttlMs: MIRROR_TTL_MS,
    };
    logger.ok('dlhd', `active mirror: ${chosen} (source=env, pinned)`);
    return _resolution;
  }

  // 2) Candidate list: advertised links from the directory, else the seeds; seeds appended as a tail.
  const dir = await fetchDirectoryCandidates();
  const candidates: string[] = [];
  const seenC = new Set<string>();
  for (const c of [...(dir.ok ? dir.candidates : []), ...SEED_MIRRORS]) {
    const key = c.toLowerCase();
    if (!seenC.has(key)) {
      seenC.add(key);
      candidates.push(c);
    }
  }

  // 3) Probe them all, then pick the best.
  const probes = await Promise.all(candidates.map(probeCandidate));
  const best = pickBest(probes);

  let chosen: string;
  let degraded: boolean;
  if (best) {
    chosen = setBase(best.base);
    degraded = false;
    logger.ok(
      'dlhd',
      `active mirror: ${chosen} (${best.channels} channels, ${best.ms}ms; source=${dir.ok ? 'directory' : 'seed'})`,
    );
  } else {
    // Nothing reachable — keep the current base so the catalog can still fall back to snapshot.
    chosen = getBase();
    degraded = true;
    logger.warn(
      'dlhd',
      `no mirror passed probing (${probes.length} tried) — keeping ${chosen}; catalog will use snapshot`,
    );
  }

  _resolution = {
    chosen,
    source: dir.ok ? 'directory' : 'seed',
    directory: dir.directory,
    directoryOk: dir.ok,
    reason: dir.reason ?? null,
    candidates,
    probes,
    degraded,
    chosenAt: new Date().toISOString(),
    ttlMs: MIRROR_TTL_MS,
  };
  return _resolution;
}

/** The last resolution provenance (sync), or null before the first resolveActiveMirror() runs. */
export function getResolution(): MirrorResolution | null {
  return _resolution;
}

// ── Lazy TTL gate (Masqueradarr addition) ───────────────────────────────────────────────────────────────────
// The PoC resolved the mirror at build, at boot, and on a setInterval. Masqueradarr channels populate on the
// user's first Sync (not boot), so resolving eagerly at boot would be wasted work + an unprompted outbound
// probe on every start. Instead the adapter calls ensureMirror() at the top of listChannels()/
// resolveStream()/status(): it re-resolves only when the cached base is older than the TTL, and a
// single-flight guard collapses concurrent callers onto one in-flight resolve. No boot hook, no timer.
let _resolvedAt = 0;
let _ensuring: Promise<void> | null = null;
export async function ensureMirror(): Promise<void> {
  if (_resolvedAt && Date.now() - _resolvedAt < MIRROR_TTL_MS) return; // fresh enough → no-op
  if (_ensuring) return _ensuring; // a resolve is already in flight → join it
  _ensuring = resolveActiveMirror({ force: true })
    .then(() => {
      _resolvedAt = Date.now(); // rate-limit re-probes to once per TTL even when degraded (no hammering)
    })
    .finally(() => {
      _ensuring = null;
    });
  return _ensuring;
}

// Failure-triggered failover (Masqueradarr addition). ensureMirror() re-probes only on the 30-min TTL, so a
// mirror that dies MID-WINDOW would otherwise strand every resolve against the dead base until the TTL
// lapses. reprobeMirror() lets the adapter force a fresh directory re-probe the MOMENT a resolve hits a
// connection error and fail over to whatever mirror is live now. Single-flighted with ensureMirror (shared
// _ensuring), and cooled down so a sustained all-mirrors-down outage can't turn every failed resolve into a
// probe storm. Returns the resulting resolution (degraded ⇒ nothing reachable; caller should not retry).
const REPROBE_COOLDOWN_MS = Number(process.env.DLHD_REPROBE_COOLDOWN_MS || 15_000);
let _lastReprobeAt = 0;
export async function reprobeMirror(): Promise<MirrorResolution | null> {
  if (_ensuring) {
    await _ensuring; // a resolve is already in flight → join it instead of starting a second sweep
    return getResolution();
  }
  // Don't hammer the directory: if we re-probed very recently and found nothing reachable, reuse that.
  const last = getResolution();
  if (last?.degraded && _lastReprobeAt && Date.now() - _lastReprobeAt < REPROBE_COOLDOWN_MS) return last;
  _resolvedAt = 0; // invalidate the TTL gate so the forced re-probe actually runs
  _ensuring = resolveActiveMirror({ force: true })
    .then(() => {
      _resolvedAt = Date.now();
      _lastReprobeAt = Date.now();
    })
    .finally(() => {
      _ensuring = null;
    });
  await _ensuring;
  return getResolution();
}
