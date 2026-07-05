import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../sources/core/logger.js';
import { PROXY_SECRET } from './secret.js';
import { getProxyLogLevel } from './logLevel.js';

// The masqueradarr durable video DATA PLANE is a separate Rust binary (repo `proxy/` crate → `masq-proxy`)
// run as a LOOPBACK sidecar that Node spawns + supervises (plan topology "sidecar behind Node", staged to a
// public edge at P3). Node owns its lifecycle: it starts with the API here and is torn down in index.ts's
// graceful shutdown BEFORE process.exit — so tini→node SIGTERM forwarding tears the child down in BOTH Docker
// images unchanged (standard `exec node`; AIO `gosu node …`), no entrypoint edits. A missing/failed sidecar is
// NON-FATAL (the API keeps serving; only streaming is affected), consistent with the other boot initializers.
//
// P0 wires supervision + `/health` only. P1 points the reverse-proxy at PROXY_PORT and adds the resolve seam.
// EDGE-3 (opt-in MASQ_EDGE) adds a SECOND, public listener inside the same sidecar and inverts the topology —
// see .claude/plans/durable-iptv-proxy.md.

const here = dirname(fileURLToPath(import.meta.url));

// The sidecar's INTERNAL listener — loopback, secret-gated (/health + /probe, and in sidecar mode the stream
// relay target). This is what Node CONNECTS to (relay.ts, probeAll.ts), so it stays 127.0.0.1:8787 in BOTH
// topologies — decoupled from the public bind below so edge mode never makes Node dial 0.0.0.0 (non-portable).
export const PROXY_HOST = process.env.MASQ_PROXY_HOST ?? '127.0.0.1';
export const PROXY_PORT = Number(process.env.MASQ_PROXY_PORT) || 8787;

// EDGE-3: when MASQ_EDGE is set, Rust ALSO binds a PUBLIC listener (0.0.0.0:3000 by default) that becomes the
// front door — it serves the stream mounts in-process and reverse-proxies everything else to Node (now on a
// loopback internal port). Default OFF → today's sidecar topology, untouched. The public port defaults to 3000
// (what EXPOSE/compose/the healthcheck use); the entrypoints move Node to an internal port (PORT=8080).
export const EDGE = !!process.env.MASQ_EDGE;
const EDGE_HOST = process.env.MASQ_EDGE_HOST ?? '0.0.0.0';
const EDGE_PORT = Number(process.env.MASQ_EDGE_PORT) || 3000;

const MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 2000;
const HEALTHY_UPTIME_MS = 60_000; // a run at least this long resets the restart budget (see below)

// Locate the binary: explicit env override, then the Docker runtime path (COPY'd in), then a local dev build
// (`cargo build [--release]` in proxy/). Returns null when none exists — a missing sidecar is non-fatal, so
// dev without a built crate still boots (streaming just won't work until the crate is built).
function resolveBinary(): string | null {
  const candidates = [
    process.env.MASQ_PROXY_BIN,
    '/usr/local/bin/masq-proxy', // Docker runtime (both images COPY the release binary here)
    resolve(here, '..', '..', '..', 'proxy', 'target', 'release', 'masq-proxy'), // dev release build
    resolve(here, '..', '..', '..', 'proxy', 'target', 'debug', 'masq-proxy'), // dev debug build
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

let child: ChildProcess | null = null;
let alive = false;
let shuttingDown = false;
let restarts = 0;
// The Node base URL the sidecar calls back on (the resolve seam + telemetry ingest). Set from the API port
// when the sidecar starts; defaulted so a stray restart before start() still has a sane value.
let nodeUrl = 'http://127.0.0.1:3000';

export function startProxySidecar(nodePort: number): void {
  nodeUrl = `http://127.0.0.1:${nodePort}`;
  const bin = resolveBinary();
  if (!bin) {
    logger.warn(
      'proxy',
      'sidecar binary not found (set MASQ_PROXY_BIN or build the proxy/ crate) — streaming disabled until a build is present',
    );
    return;
  }
  spawnOnce(bin);
}

function spawnOnce(bin: string): void {
  const startedAt = Date.now();
  const proc = spawn(bin, [], {
    stdio: 'inherit', // sidecar logs flow to node's stdout (captured by `docker logs`)
    env: {
      ...process.env,
      MASQ_PROXY_HOST: PROXY_HOST, // internal loopback listener (unchanged in both topologies)
      MASQ_PROXY_PORT: String(PROXY_PORT),
      MASQ_PROXY_SECRET: PROXY_SECRET, // shared secret for the Node↔sidecar internal channel (secret.ts)
      MASQ_NODE_URL: nodeUrl, // where the sidecar calls resolve/authorize/telemetry/log (= Node's port, 8080 in edge)
      MASQ_LOG_LEVEL: String(getProxyLogLevel()), // INITIAL engine verbosity; kept live via the seam echo-back
      // EDGE-3: hand Rust the public bind so it lights its second (edge) listener. Explicit so a bare
      // MASQ_EDGE=1 is enough (the host/port defaults resolve here); omitted entirely in sidecar mode.
      ...(EDGE ? { MASQ_EDGE: '1', MASQ_EDGE_HOST: EDGE_HOST, MASQ_EDGE_PORT: String(EDGE_PORT) } : {}),
    },
  });
  child = proc;
  alive = true;
  logger.info(
    'proxy',
    EDGE
      ? `sidecar started (pid ${proc.pid}) — internal ${PROXY_HOST}:${PROXY_PORT}, PUBLIC EDGE ${EDGE_HOST}:${EDGE_PORT} → node ${nodeUrl} — ${bin}`
      : `sidecar started (pid ${proc.pid}) on ${PROXY_HOST}:${PROXY_PORT} — ${bin}`,
  );

  proc.on('error', (err) => {
    logger.error('proxy', `sidecar spawn error: ${err.message}`);
  });
  proc.on('exit', (code, signal) => {
    alive = false;
    if (child === proc) child = null;
    if (shuttingDown) return; // expected during graceful shutdown — don't respawn
    // A run that lasted a healthy while resets the restart budget (so a rare long-uptime crash doesn't
    // permanently exhaust it); a fast crash-loop counts against the cap and eventually gives up — a
    // persistent crash is a code/config bug, and the API keeps serving without streaming.
    // EDGE-3: in edge mode Rust owns the PUBLIC socket, so "give up" would take the whole app down (not just
    // streaming). Never give up — keep respawning after the backoff (the container healthcheck, which now
    // traverses Rust→Node, goes unhealthy so an orchestrator can recycle the container on a persistent crash).
    if (Date.now() - startedAt > HEALTHY_UPTIME_MS) restarts = 0;
    if (!EDGE && restarts >= MAX_RESTARTS) {
      logger.error(
        'proxy',
        `sidecar exited (code ${code}, signal ${signal}) — giving up after ${restarts} restarts; streaming disabled`,
      );
      return;
    }
    restarts += 1;
    logger.warn(
      'proxy',
      EDGE
        ? `EDGE sidecar exited (code ${code}, signal ${signal}) — public edge DOWN, restarting (#${restarts}) in ${RESTART_DELAY_MS}ms`
        : `sidecar exited (code ${code}, signal ${signal}) — restarting ${restarts}/${MAX_RESTARTS} in ${RESTART_DELAY_MS}ms`,
    );
    setTimeout(() => {
      if (!shuttingDown) spawnOnce(bin);
    }, RESTART_DELAY_MS);
  });
}

// Graceful stop: SIGTERM the sidecar and await its exit (SIGKILL after a 5s grace) so index.ts's shutdown
// does not process.exit() while the child is still draining. Idempotent + safe when never started.
export async function stopProxySidecar(): Promise<void> {
  shuttingDown = true;
  const proc = child;
  if (!proc || !alive) return;
  await new Promise<void>((res) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      res();
    }, 5000);
    proc.once('exit', () => {
      clearTimeout(timer);
      res();
    });
    proc.kill('SIGTERM');
  });
}
