import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { logger } from '../sources/core/logger.js';
import { buildGrant, type ResolveGrant } from '../proxy/resolveSeam.js';
import { isPrivateHost } from '../sources/core/ssrf.js';
import {
  nextSocketConnId,
  noteSocketViewerOpen,
  noteSocketBytes,
  noteSocketViewerClose,
} from '../sources/core/streamTelemetry.js';

// The DEDICATED HDHomeRun-tuner video engine (Path B). Each Plex/Emby tune of a lineup channel spawns ONE
// per-connection ffmpeg copy-remux (`-c copy -f mpegts pipe:1`) whose continuous video/mp2t is piped straight
// to that client's HTTP response, then killed on disconnect. This is fully SEPARATE from the production
// `/api/ext/v1` + Rust data plane: it lives on the `/hdhr/<tunerId>/stream/…` route and is a Node subprocess.
//
// Why ffmpeg (vs the Rust raw-TS concatenator): `-c copy` natively fetches the AES-128 key + decrypts (tubi),
// remuxes fMP4→TS, and normalizes timestamps / smooths ad-boundary discontinuities — everything the tuner
// needs — while Plex ingests the raw TS and does any further transcoding, so bare apt `ffmpeg` suffices (no
// GPU / jellyfin-ffmpeg). The only unsupportable case is SAMPLE-AES / Widevine / FairPlay (roku): ffmpeg
// exits with a decode error, which we log clearly and surface as a 502 rather than crash.
//
// Durability: ffmpeg's own `-reconnect` handles transient upstream blips; a stall watchdog + FOG
// failover-respawn (re-`buildGrant(attempt+1)` to the next candidate, reusing the exact data-plane failover
// semantics) keeps the Plex session alive across a hard upstream death without dropping the client.

const STALL_MS = Number(process.env.MASQ_TUNER_STALL_MS) || 15_000; // no stdout bytes this long ⇒ upstream dead
const MAX_FAILOVER = Number(process.env.MASQ_TUNER_MAX_FAILOVER) || 5; // consecutive-unhealthy respawn budget
const HEALTHY_UPTIME_MS = 60_000; // a proc that streamed bytes for at least this long resets the failover streak
const KILL_GRACE_MS = 5_000; // SIGTERM → SIGKILL grace on teardown

// ── Process registry (concurrency cap + exit sweep) ────────────────────────────────────────────────────
const activeByTuner = new Map<string, Set<object>>(); // tunerId → set of live stream handles
const liveChildren = new Set<ChildProcess>(); // every live ffmpeg — SIGKILL'd on process exit

let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Last-resort: SIGKILL any surviving ffmpeg if the process exits without a graceful teardown.
  process.on('exit', () => {
    for (const c of liveChildren) {
      try {
        c.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });
}

/** Number of live tuner streams for a tuner — the route enforces the per-tuner TunerCount cap against this. */
export function activeStreamCount(tunerId: string): number {
  return activeByTuner.get(tunerId)?.size ?? 0;
}

/** Graceful shutdown: SIGTERM every live ffmpeg, then SIGKILL after a grace. Called from index.ts shutdown. */
export async function shutdownTunerEngine(): Promise<void> {
  const procs = [...liveChildren];
  if (procs.length === 0) return;
  await Promise.all(
    procs.map(
      (proc) =>
        new Promise<void>((res) => {
          const timer = setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              /* gone */
            }
            res();
          }, KILL_GRACE_MS);
          proc.once('exit', () => {
            clearTimeout(timer);
            res();
          });
          try {
            proc.kill('SIGTERM');
          } catch {
            clearTimeout(timer);
            res();
          }
        }),
    ),
  );
}

/**
 * Locate the ffmpeg binary: explicit env override, then common install paths, then a PATH scan. Returns null
 * when none is found — a missing binary is non-fatal (the route replies 503 and the control plane keeps
 * serving), mirroring the sidecar's `resolveBinary()`.
 */
export function resolveFfmpegBinary(): string | null {
  const explicit = [
    process.env.MASQ_FFMPEG_BIN,
    '/usr/bin/ffmpeg', // Debian apt (both Docker images)
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg', // macOS dev
  ].filter((p): p is string => !!p);
  for (const p of explicit) if (existsSync(p)) return p;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && existsSync(`${dir}/ffmpeg`)) return `${dir}/ffmpeg`;
  }
  return null;
}

// Build the copy-remux argv. spawn() passes args verbatim (no shell), so header values with CRLF and a
// user-agent with spaces need no quoting. `-probesize/-analyzeduration 10M` is load-bearing for a mid-GOP
// live edge (tubi) — without deeper probing `-c copy` fails the header write.
function buildArgv(target: string, headers: Record<string, string>): string[] {
  const uaKey = Object.keys(headers).find((k) => k.toLowerCase() === 'user-agent');
  const ua = (uaKey && headers[uaKey]) || 'Masqueradarr-hdhr/1.0';
  const extra = Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'user-agent');
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-user_agent',
    ua,
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '4',
    '-fflags',
    '+genpts',
    '-probesize',
    '10M',
    '-analyzeduration',
    '10M',
    // Accept disguised segment extensions (dlhd et al. serve non-.ts segment URLs). Paired with a
    // protocol whitelist that DROPS `file`/`subfile` so allowing all extensions can't become a local-file
    // read vector — the input is always a resolved HTTP(S) master, and `crypto` stays in for AES-128 decrypt.
    '-allowed_extensions',
    'ALL',
    '-protocol_whitelist',
    'crypto,data,http,https,tcp,tls',
  ];
  if (extra.length > 0) {
    // All upstream headers except User-Agent → one CRLF-joined -headers blob (ffmpeg convention).
    args.push('-headers', extra.map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n');
  }
  args.push(
    '-i',
    target,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c',
    'copy',
    '-copyts',
    '-f',
    'mpegts',
    'pipe:1',
  );
  return args;
}

export interface TunerStreamOpts {
  res: ServerResponse;
  tunerId: string; // for the per-tuner concurrency cap
  source: string; // request source (origin ?? channel source) — telemetry + buildGrant key
  entryUrl: string; // decoded streamEntryUrl
  pl?: string; // owning playlist id (?pl) — proxyConfig + failover parent lookup
  grant: ResolveGrant; // pre-resolved attempt-0 grant (route already ran the SSRF check on grant.target)
  viewer: { ip: string; ua: string; username?: string };
}

/**
 * Spawn a copy-remux ffmpeg for one client and pipe video/mp2t to `res`. Handles reconnect, FOG
 * failover-respawn, Active-Streams telemetry, and teardown-on-disconnect internally. Resolves when the
 * stream ends (client disconnect, clean EOF, or failover exhausted).
 */
export async function serveTunerStream(opts: TunerStreamOpts): Promise<void> {
  const { res, tunerId, source, entryUrl, pl, viewer } = opts;
  installExitHook();

  const bin = resolveFfmpegBinary();
  if (!bin) {
    logger.warn('hdhr-tuner', `ffmpeg not found — cannot serve ${source} (${entryUrl.slice(0, 80)})`);
    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader('content-type', 'text/plain');
      res.end('tuner engine unavailable (ffmpeg not installed)');
    }
    return;
  }

  // Register for the concurrency cap + exit sweep.
  const handle = {};
  let set = activeByTuner.get(tunerId);
  if (!set) {
    set = new Set();
    activeByTuner.set(tunerId, set);
  }
  set.add(handle);

  const connId = nextSocketConnId();
  noteSocketViewerOpen(source, entryUrl, viewer.ip, viewer.ua, viewer.username, 'externalPlayer', connId);

  return new Promise<void>((resolveDone) => {
    let proc: ChildProcess | null = null;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0; // current grant's failover attempt (0 = parent, ≥1 = Nth child)
    let streak = 0; // consecutive unhealthy failovers (resets after a healthy run)
    let procSpawnAt = 0; // when the CURRENT ffmpeg started (for the healthy-uptime check)
    let procProduced = false; // did the current ffmpeg emit any bytes
    let everProduced = false; // did ANY ffmpeg on this stream emit bytes (502-vs-end on give-up)
    let done = false; // teardown complete / in progress
    let stderrTail = ''; // last ~2 KB of the current ffmpeg's stderr for exit diagnostics

    const ensureHeaders = (): void => {
      if (res.headersSent) return;
      res.statusCode = 200;
      res.setHeader('content-type', 'video/mp2t');
      res.setHeader('cache-control', 'no-store');
    };

    const clearStall = (): void => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };

    const armStall = (): void => {
      clearStall();
      stallTimer = setTimeout(() => {
        logger.warn(
          'hdhr-tuner',
          `stall: no output for ${STALL_MS}ms on ${source} (${entryUrl.slice(0, 60)}) — treating as upstream death`,
        );
        onDeath('stall');
      }, STALL_MS);
      if (typeof stallTimer.unref === 'function') stallTimer.unref();
    };

    const killProc = (): void => {
      const p = proc;
      proc = null;
      if (!p) return;
      liveChildren.delete(p);
      p.removeAllListeners('exit');
      try {
        p.kill('SIGTERM');
      } catch {
        /* gone */
      }
      const t = setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }, KILL_GRACE_MS);
      if (typeof t.unref === 'function') t.unref();
      p.once('exit', () => clearTimeout(t));
    };

    const finish = (): void => {
      if (done) return;
      done = true;
      clearStall();
      killProc();
      set!.delete(handle);
      if (set!.size === 0) activeByTuner.delete(tunerId);
      noteSocketViewerClose(connId);
      if (!res.writableEnded) {
        if (!res.headersSent) {
          res.statusCode = 502;
          res.setHeader('content-type', 'text/plain');
          res.end('tuner stream unavailable');
        } else {
          res.end();
        }
      }
      resolveDone();
    };

    // The client hung up (or the response closed) — tear the whole stream down.
    res.on('close', () => {
      if (!res.writableEnded) finish();
    });

    const spawnFor = (grant: ResolveGrant): void => {
      if (done) return;
      const argv = buildArgv(grant.target, grant.upstreamHeaders);
      let child: ChildProcess;
      try {
        child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        logger.warn('hdhr-tuner', `ffmpeg spawn threw for ${source}: ${(err as Error).message}`);
        onDeath('spawn-error');
        return;
      }
      proc = child;
      procSpawnAt = Date.now();
      procProduced = false;
      stderrTail = '';
      liveChildren.add(child);

      child.on('error', (err) => {
        // ENOENT here means the binary vanished/PATH resolution failed after resolveFfmpegBinary — non-fatal.
        logger.warn('hdhr-tuner', `ffmpeg process error for ${source}: ${err.message}`);
      });

      child.stdout!.on('data', (chunk: Buffer) => {
        procProduced = true;
        everProduced = true;
        armStall();
        noteSocketBytes(connId, chunk.length);
        ensureHeaders();
        // Backpressure: pause ffmpeg's stdout when the client socket is full, resume on drain.
        if (!res.write(chunk)) {
          child.stdout!.pause();
          res.once('drain', () => {
            if (!done) child.stdout!.resume();
          });
        }
      });

      child.stderr!.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2048);
      });

      child.on('exit', (code, signal) => {
        liveChildren.delete(child);
        if (done || proc !== child) return; // we initiated the kill, or a newer proc already took over
        if (code === 0) {
          // Clean EOF (upstream ended the playlist) — end the client; Plex re-tunes if it wants more.
          logger.info('hdhr-tuner', `ffmpeg EOF (code 0) on ${source} (${entryUrl.slice(0, 60)})`);
          finish();
          return;
        }
        logger.warn(
          'hdhr-tuner',
          `ffmpeg exited (code ${code}, signal ${signal}) on ${source} (${entryUrl.slice(0, 60)})` +
            (stderrTail ? ` — ${stderrTail.replace(/\s+/g, ' ').trim().slice(-300)}` : ''),
        );
        onDeath('exit');
      });

      armStall();
    };

    // A hard upstream failure (non-zero exit or stall). Walk the FOG failover chain in Node: a healthy run
    // resets the streak and retries the PARENT from scratch; otherwise climb to the next candidate. Give up
    // (end the client → Plex re-tunes) when the budget is spent or buildGrant reports the chain exhausted.
    const onDeath = async (reason: string): Promise<void> => {
      if (done) return;
      clearStall();
      const wasHealthy = procProduced && Date.now() - procSpawnAt > HEALTHY_UPTIME_MS;
      killProc();
      if (wasHealthy) {
        streak = 0;
        attempt = 0; // retry the parent — it may have recovered
      } else {
        streak += 1;
        attempt += 1; // climb to the next failover candidate
      }
      if (streak > MAX_FAILOVER) {
        logger.warn(
          'hdhr-tuner',
          `giving up on ${source} (${entryUrl.slice(0, 60)}) after ${streak} failed attempts (${reason})`,
        );
        finish();
        return;
      }

      let grant: ResolveGrant | { ok: false; status: number; error: string };
      try {
        grant = await buildGrant(source, entryUrl, pl, attempt);
      } catch (err) {
        logger.warn('hdhr-tuner', `re-resolve threw for ${source}: ${(err as Error).message}`);
        finish();
        return;
      }
      if (done) return; // client left while we were resolving
      if (!grant.ok) {
        // 410 failover_exhausted (or a resolve error). If nothing ever played, this is the DRM/unsupported
        // (roku) or dead-upstream case — surfaced as the 502 in finish() plus this operator-visible warn.
        logger.warn(
          'hdhr-tuner',
          `cannot continue ${source} (${entryUrl.slice(0, 60)}): ${grant.error}` +
            (everProduced ? '' : ' — no bytes ever produced (DRM/unsupported or upstream unreachable?)'),
        );
        finish();
        return;
      }
      // Re-check SSRF for the (possibly cross-provider) failover target the same way the route does at entry.
      let host = '';
      try {
        host = new URL(grant.target).hostname;
      } catch {
        /* malformed target → treated as private below */
      }
      if (!grant.allowPrivate && (!host || isPrivateHost(host))) {
        logger.warn('hdhr-tuner', `blocked private failover target for ${source}: ${grant.target.slice(0, 80)}`);
        finish();
        return;
      }
      logger.info(
        'hdhr-tuner',
        `respawn ffmpeg for ${source} (attempt ${attempt}${grant.failover ? `, candidate ${grant.failover.candidateName}` : ''})`,
      );
      spawnFor(grant);
    };

    // If the client already vanished during the route's resolve, don't spawn.
    if (res.writableEnded || res.destroyed) {
      finish();
      return;
    }
    spawnFor(opts.grant);
  });
}
