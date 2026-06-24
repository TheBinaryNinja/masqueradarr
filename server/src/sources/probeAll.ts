// Scheduled ffprobe sweep — walks every Active channel in every (non-clone) playlist and refreshes its
// persisted health (stream.status), human-readable resolution (stream.res), and technical snapshot
// (stream.probe). Unlike the live proxy probe (core/streamProbe.ts ensureProbe), which only fires while a
// viewer is watching, this sweep keeps those fields current for channels nobody has opened recently.
//
// Driven two ways, both gated by a single in-process `running` guard so they can never overlap:
//   · the scheduler (cronjobs targetType:'probe-all', see scheduler/index.ts) on its cadence
//   · the manual "Run probe now" trigger (POST /api/probe/run, routes/probe.ts)
//
// Iterates ONE non-clone playlist at a time, ONE channel at a time (sequential by design — bounded load on
// auth-gated/rate-limited upstreams). Clone playlists (Playlist.source === 'clone') are skipped during the
// walk and filled by PROPAGATION: each result is written with updateMany keyed by the shared upstream
// (streamEntryUrl + effective proxy source), so the source channel and every clone copy update together —
// the same (origin ?? source) join statsHub.resolveChannelId uses. This avoids re-resolving/re-probing the
// same dulo/dlhd stream once per clone.
//
// Progress is surfaced over a small listener registry (onProbeProgress) consumed by probeHub.ts (the
// /api/probe-progress WebSocket) and read on demand via getProbeStatus() — this module stays transport-free.

import { Playlist } from '../models/Playlist.js';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import type { StreamProbe } from '../models/StreamSession.js';
import { getSource } from './registry.js';
import { probeOnce } from './core/streamProbe.js';
import { logger } from './core/logger.js';

const tag = 'probe';

export interface ProbeState {
  running: boolean;
  playlistId: string | null;
  playlistName: string | null;
  channelIndex: number; // 1-based position within the current playlist
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

/** A snapshot of the current sweep state (served by GET /api/probe/status + the WS's first frame). */
export function getProbeStatus(): ProbeState {
  return { ...state };
}

// Progress fan-out — probeHub subscribes here; this module never imports the transport (no cycle).
type Listener = (s: ProbeState) => void;
const listeners = new Set<Listener>();
export function onProbeProgress(cb: Listener): void {
  listeners.add(cb);
}
function emit(): void {
  const snap = getProbeStatus();
  for (const cb of listeners) {
    try {
      cb(snap);
    } catch {
      /* a listener throw must not derail the sweep */
    }
  }
}

// Human-readable resolution from the probed height ("1080p"), matching statsHub.resolutionLabel +
// HlsPlayer's `${h}p` so the pill value stays consistent across the app. null when height is unknown.
function humanRes(height: number | null | undefined): string | null {
  return height ? `${height}p` : null;
}

/**
 * Run the full sweep. Early-returns (no-op) if a sweep is already running, so an hourly tick can't pile up
 * on a long run and the manual trigger + scheduler share one guard. Per-channel failures are recorded as a
 * 'failed' (down) status, not propagated — only an unexpected top-level error rethrows (so the scheduler
 * records lastError; the manual route swallows it).
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
  emit();

  let probed = 0;
  let live = 0;
  let down = 0;
  let skipped = 0;
  try {
    // Canonical playlists only — Default source playlists + imports (HDHomeRun/direct). Clone copies
    // (source:'clone') are filled by propagation below, never walked, so we don't re-probe shared upstreams.
    // $nin both casings so a pre-normalization 'Clone' doc is still excluded until the boot migration runs.
    const playlists = await Playlist.find({ source: { $nin: ['clone', 'Clone'] } }).lean();
    for (const pl of playlists) {
      const channels = await PlaylistChannel.find({ source: pl.id, status: 'Active' }).lean();
      if (!channels.length) continue;

      // Generic auth gate (no per-source code): an auth-required playlist with no active session can't
      // resolve any stream — skip it wholesale instead of marking every channel falsely "down".
      if (pl.authentication && !pl.isAuthenticated) {
        logger.warn(tag, `[${pl.id}] skipped ${channels.length} channel(s) — not authenticated`);
        skipped += channels.length;
        continue;
      }

      state.playlistId = pl.id;
      state.playlistName = pl.name;
      state.channelTotal = channels.length;
      state.channelIndex = 0;

      let idx = 0;
      for (const ch of channels) {
        idx++;
        state.channelIndex = idx;
        state.currentChannelName = ch.tvg_name;
        emit();

        const eff = ch.origin ?? ch.source; // the proxy/adapter source (imports route via origin)
        const adapter = getSource(eff);
        if (!adapter) {
          logger.warn(tag, `[${pl.id}] no adapter for "${eff}" (${ch.id}) — skipped`);
          skipped++;
          continue;
        }

        let status: 'live' | 'failed' = 'failed';
        let res: string | null = null;
        let probe: StreamProbe | null = null;
        try {
          let masterUrl = ch.streamEntryUrl;
          if (adapter.isEntryUrl(masterUrl)) {
            const resolved = await adapter.resolveStream(masterUrl);
            masterUrl = resolved.masterUrl;
          }
          const headers = adapter.proxy.upstreamHeaders(masterUrl);
          probe = await probeOnce(masterUrl, headers);
          if (probe) {
            status = 'live'; // ffprobe analyzed the stream → it's up
            res = humanRes(probe.video.height);
          }
        } catch (err) {
          status = 'failed'; // couldn't resolve/read → effectively down
          logger.warn(tag, `[${pl.id}] "${ch.tvg_name}": ${(err as Error).message}`);
        }

        // Persist the source channel AND every clone copy of the same upstream in one write. On a "down"
        // result write only stream.status — leave the last-known res/probe rather than blanking them.
        const set: Record<string, unknown> = { 'stream.status': status };
        if (status === 'live') {
          set['stream.res'] = res;
          set['stream.probe'] = probe;
        }
        await PlaylistChannel.updateMany(
          { streamEntryUrl: ch.streamEntryUrl, $or: [{ origin: eff }, { origin: null, source: eff }] },
          { $set: set },
        );

        probed++;
        if (status === 'live') live++;
        else down++;
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
    emit(); // final "idle" frame so any live client clears its indicator
  }
}
