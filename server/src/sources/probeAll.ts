// Scheduled channel probe (PRB, P1.3) — the ffprobe-free successor to the removed streamProbe sweep. Walks
// every Active channel in every (non-clone) playlist and refreshes its persisted health (stream.status) +
// human resolution (stream.res), so those fields stay current for channels nobody has open right now (the
// live telemetry only fills them while a viewer watches).
//
// HYBRID by design — the churny per-source logic stays in Node, the durable byte work stays in Rust:
//   1. RESOLVE in Node (throttled): buildGrant() runs the same adapter logic the resolve seam does (dulo
//      Supabase session, dlhd 3-hop scrape + mirror, dami delegation) → a { target, upstreamHeaders } grant.
//   2. FETCH + ANALYZE in Rust: the resolved batch is POSTed to the sidecar's /probe endpoint, which fetches
//      each target concurrently and reports liveness (a 2xx manifest = live) + decode via the SAME parser the
//      live proxy uses (manifest::extract_media).
//   3. WRITE in Node: each result is persisted with the clone-propagating updateMany (the source channel and
//      every clone copy of the same upstream update together — the (origin ?? source) join statsHub uses).
//
// Guardrails: one in-process `running` guard (the scheduler tick + a manual run can never overlap); a small
// Node-side resolve concurrency cap (upstreams are auth-gated / rate-limited); auth-required playlists with no
// session are skipped wholesale (never falsely marked "down"). Clone playlists are never walked — filled by
// propagation. Transport-free: progress is a plain snapshot (getProbeStatus), read by GET /api/probe/status.

import { Playlist } from '../models/Playlist.js';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import { buildGrant } from '../proxy/resolveSeam.js';
import { PROXY_HOST, PROXY_PORT } from '../proxy/sidecar.js';
import { PROXY_SECRET, PROXY_SECRET_HEADER } from '../proxy/secret.js';
import { humanResolution } from './core/decodeLabels.js';
import { logger } from './core/logger.js';

const tag = 'probe';

// Node-side resolve fan-out cap — bounded so a sweep doesn't hammer an auth-gated / rate-limited upstream
// (dulo/dlhd) with hundreds of simultaneous resolves. The Rust /probe endpoint bounds its own fetch fan-out.
const RESOLVE_CONCURRENCY = 4;

const SIDECAR_BASE = `http://${PROXY_HOST}:${PROXY_PORT}`;

export interface ProbeState {
  running: boolean;
  playlistId: string | null;
  playlistName: string | null;
  channelIndex: number; // 1-based position within the current playlist's resolve phase
  channelTotal: number; // Active channels in the current playlist
  currentChannelName: string | null;
  startedAt: number | null; // epoch ms of the current run
}

const state: ProbeState = {
  running: false,
  playlistId: null,
  playlistName: null,
  channelIndex: 0,
  channelTotal: 0,
  currentChannelName: null,
  startedAt: null,
};

/** A snapshot of the current sweep state (served by GET /api/probe/status). */
export function getProbeStatus(): ProbeState {
  return { ...state };
}

// One result the Rust /probe endpoint returns per submitted item (id = our batch index).
interface ProbeResult {
  id: string;
  live: boolean;
  resolution: string | null;
  codecs: string | null;
  frameRate: string | null;
  container: string | null;
  bandwidth: number | null;
}

/** POST a resolved batch to the Rust sidecar's /probe endpoint. Throws on transport/non-2xx so the sweep
 *  records the error rather than silently marking every channel "down" when the data plane is unreachable. */
async function probeBatch(
  items: { id: string; target: string; upstreamHeaders: Record<string, string> }[],
): Promise<ProbeResult[]> {
  if (!items.length) return [];
  const res = await fetch(`${SIDECAR_BASE}/probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [PROXY_SECRET_HEADER]: PROXY_SECRET },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error(`sidecar /probe returned HTTP ${res.status}`);
  const data = (await res.json()) as { results?: ProbeResult[] };
  return data.results ?? [];
}

/** Run `fn` over `items` with at most `limit` concurrent in flight (a tiny bounded worker pool). */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await fn(item);
    }
  });
  await Promise.all(workers);
}

type ChannelDoc = { id: string; source: string; origin: string | null; streamEntryUrl: string; tvg_name: string };

/** Persist a probe outcome to the source channel AND every clone copy of the same upstream in one write. On a
 *  "down" result write only stream.status — leave the last-known res rather than blanking it. */
async function writeResult(ch: ChannelDoc, eff: string, status: 'live' | 'failed', res: string | null): Promise<void> {
  const set: Record<string, unknown> = { 'stream.status': status };
  if (status === 'live') set['stream.res'] = res;
  await PlaylistChannel.updateMany(
    { streamEntryUrl: ch.streamEntryUrl, $or: [{ origin: eff }, { origin: null, source: eff }] },
    { $set: set },
  );
}

/**
 * Run the full sweep. Early-returns (no-op) if a sweep is already running, so a scheduler tick can't pile up
 * on a long run and the manual trigger + scheduler share one guard. Per-channel/-playlist failures are
 * recorded as 'failed', not propagated — only an unexpected top-level error (e.g. the sidecar unreachable)
 * rethrows so the scheduler records lastError.
 */
export async function probeAllChannels(): Promise<void> {
  if (state.running) {
    logger.warn(tag, 'sweep already running — skipping this trigger');
    return;
  }
  state.running = true;
  state.startedAt = Date.now();
  state.channelIndex = 0;
  state.channelTotal = 0;
  state.playlistId = null;
  state.playlistName = null;
  state.currentChannelName = null;

  let probed = 0;
  let live = 0;
  let down = 0;
  let skipped = 0;
  try {
    // Canonical playlists only — Default source playlists + imports. Clone copies (source:'clone') are filled
    // by propagation in writeResult, never walked. $nin both casings so a pre-normalization 'Clone' is excluded.
    const playlists = await Playlist.find({ source: { $nin: ['clone', 'Clone'] } }).lean();
    for (const pl of playlists) {
      const channels = (await PlaylistChannel.find(
        { source: pl.id, status: 'Active' },
        { id: 1, source: 1, origin: 1, streamEntryUrl: 1, tvg_name: 1, _id: 0 },
      ).lean()) as ChannelDoc[];
      if (!channels.length) continue;

      // Generic auth gate (no per-source code): an auth-required playlist with no active session can't resolve
      // any stream — skip it wholesale instead of marking every channel falsely "down".
      if (pl.authentication && !pl.isAuthenticated) {
        logger.warn(tag, `[${pl.id}] skipped ${channels.length} channel(s) — not authenticated`);
        skipped += channels.length;
        continue;
      }

      state.playlistId = pl.id;
      state.playlistName = pl.name;
      state.channelTotal = channels.length;
      state.channelIndex = 0;

      // Phase 1 — resolve (throttled). Each channel → a resolved target, a skip (no adapter), or a down (the
      // resolve failed: dead upstream / expired auth).
      const resolved: { ch: ChannelDoc; eff: string; target: string; headers: Record<string, string> }[] = [];
      const failedResolve: { ch: ChannelDoc; eff: string }[] = [];
      let done = 0;
      await mapLimit(channels, RESOLVE_CONCURRENCY, async (ch) => {
        const eff = ch.origin ?? ch.source; // the proxy/adapter source (imports route via origin)
        try {
          const grant = await buildGrant(eff, ch.streamEntryUrl);
          if (grant.ok) resolved.push({ ch, eff, target: grant.target, headers: grant.upstreamHeaders });
          else if (grant.status === 404) skipped++; // no adapter — data anomaly, don't mark failed
          else failedResolve.push({ ch, eff }); // resolve failed → down
        } catch {
          failedResolve.push({ ch, eff });
        }
        done++;
        state.channelIndex = done;
        state.currentChannelName = ch.tvg_name;
      });

      // Phase 2 — probe the resolved targets in Rust (concurrent fetch + decode there). A sidecar failure
      // throws out of the whole sweep (recorded as an error) rather than corrupting statuses to false "down".
      const results = await probeBatch(
        resolved.map((r, i) => ({ id: String(i), target: r.target, upstreamHeaders: r.headers })),
      );
      const byId = new Map(results.map((p) => [p.id, p]));

      // Phase 3 — persist. Resolved+live → live + humanized res; resolved-but-not-live → failed;
      // resolve-failed → failed (keeping last-known res).
      for (let i = 0; i < resolved.length; i++) {
        const r = resolved[i];
        const p = byId.get(String(i));
        const status: 'live' | 'failed' = p?.live ? 'live' : 'failed';
        await writeResult(r.ch, r.eff, status, status === 'live' ? humanResolution(p?.resolution ?? null) : null);
        probed++;
        if (status === 'live') live++;
        else down++;
      }
      for (const f of failedResolve) {
        await writeResult(f.ch, f.eff, 'failed', null);
        probed++;
        down++;
      }
    }
    logger.info(tag, `sweep complete — ${probed} probed (${live} live, ${down} down), ${skipped} skipped`);
  } catch (err) {
    logger.error(tag, `sweep failed: ${(err as Error).message}`);
    throw err;
  } finally {
    state.running = false;
    state.playlistId = null;
    state.playlistName = null;
    state.currentChannelName = null;
    state.channelIndex = 0;
    state.channelTotal = 0;
  }
}
