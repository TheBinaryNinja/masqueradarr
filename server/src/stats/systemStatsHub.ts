// Live system-performance hub — samples host/container runtime metrics on a fixed tick, caches the latest
// frame, and fans it out over the /api/system-stats WebSocket. Mirrors stats/statsHub.ts (the WS scaffolding
// + 2.5s cadence) and sources/probeHub.ts (a tiny DB-free state hub), and is the server side of the Dashboard
// "System Performance" banner (src/composables/useSystemStats.ts).
//
// Scope: CPU% and Memory% are CONTAINER-AWARE — read from cgroup (v2 first, then v1), falling back to Node
// os.* on bare-metal / macOS dev (no /sys/fs/cgroup). Disk I/O (/proc/self/io) and Network (/proc/net/dev)
// are already process/namespace-scoped on Linux and return null when /proc is absent (dev). Every metric
// degrades to null rather than throwing — the tick must never crash boot or the loop.

import os from 'node:os';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import { WebSocket } from 'ws';
import { logger } from '../sources/core/logger.js';
import { VideoConfig } from '../models/VideoConfig.js';
import { resolveGpuTarget, sampleGpu, type GpuStats } from './gpu.js';

const TICK_MS = 2500; // matches statsHub BROADCAST_MS + LivelineChart SAMPLE_MS (60 samples × 2.5s window)
const CG = '/sys/fs/cgroup';

type Scope = 'cgroup-v2' | 'cgroup-v1' | 'host';

// The frame broadcast over the WS and returned (cached) by GET /api/system-stats. Mirror this interface on
// the SPA side (src/data.ts → SystemStats) — the rule→code sync contract.
export interface SystemStats {
  ts: number;
  scope: Scope; // drives the card caption ("container" for cgroup, "host" otherwise)
  cpu: { usagePct: number | null; cores: number; loadAvg: [number, number, number] };
  memory: { totalBytes: number; usedBytes: number; usedPct: number; rssBytes: number };
  diskIo: { readMbPerSec: number; writeMbPerSec: number } | null; // null on non-Linux dev (no /proc/self/io)
  network: { rxMbitPerSec: number; txMbitPerSec: number } | null; // null on non-Linux dev (no /proc/net/dev)
  mongo: {
    readyState: number; // mongoose.connection.readyState (1 = connected)
    connections: { current: number | null; available: number | null; active: number | null; totalCreated: number | null };
    // Live MongoDB health (Atlas-style) — derived by diffing consecutive serverStatus reads (~5s apart).
    // null when disconnected, serverStatus is unavailable, or before the second sample exists (rates need a delta).
    health: {
      opsPerSec: number | null; // Σ opcounters delta / sec
      avgLatencyMs: number | null; // Σ opLatencies latency delta / Σ ops delta (µs → ms)
      queryTargeting: number | null; // queryExecutor.scanned delta / document.returned delta (ratio)
      queueDepth: number | null; // globalLock.currentQueue.total (instantaneous snapshot)
      scanAndOrderPerSec: number | null; // metrics.operation.scanAndOrder delta / sec
    } | null;
  };
  // Live GPU telemetry — null unless one or more videoconfigs has HW accel enabled (drives the Dashboard
  // "GPU Performance" card's visibility). Sampled in stats/gpu.ts; numeric fields degrade to null per-vendor.
  gpu: GpuStats | null;
}

// ── delta state (raw counters from the previous tick) ─────────────────────────────────────────────────
let prevCgCpu: { usageUs: number; at: number } | null = null; // cgroup cumulative CPU time (µs)
let prevHostCpu: { idle: number; total: number } | null = null; // os.cpus() aggregate jiffies
let prevIo: { read: number; write: number; at: number } | null = null; // /proc/self/io bytes
let prevNet: { rx: number; tx: number; at: number } | null = null; // /proc/net/dev bytes

let scope: Scope = 'host';
let latest: SystemStats | null = null;

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────────
function clampPct(n: number): number {
  return Math.round(Math.max(0, Math.min(100, n)) * 10) / 10;
}
function round2(n: number): number {
  return Math.round(Math.max(0, n) * 100) / 100;
}
async function readNum(path: string): Promise<number | null> {
  try {
    const n = Number((await readFile(path, 'utf8')).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ── scope detection (once, at startup) ────────────────────────────────────────────────────────────────
function detectScope(): Scope {
  if (existsSync(`${CG}/cpu.stat`) && existsSync(`${CG}/cgroup.controllers`)) return 'cgroup-v2';
  if (existsSync(`${CG}/cpuacct/cpuacct.usage`) || existsSync(`${CG}/cpu,cpuacct/cpuacct.usage`)) return 'cgroup-v1';
  return 'host';
}

// ── CPU ─────────────────────────────────────────────────────────────────────────────────────────────
function readHostCpuTotals(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

// cgroup v2: usage_usec from cpu.stat; effective cores from cpu.max ("<quota> <period>" | "max <period>").
async function readCgV2(): Promise<{ usageUs: number | null; cores: number }> {
  let usageUs: number | null = null;
  try {
    const m = (await readFile(`${CG}/cpu.stat`, 'utf8')).match(/usage_usec\s+(\d+)/);
    if (m) usageUs = Number(m[1]);
  } catch {
    /* fall through to null */
  }
  let cores = os.cpus().length;
  try {
    const [quota, period] = (await readFile(`${CG}/cpu.max`, 'utf8')).trim().split(/\s+/);
    if (quota && quota !== 'max') {
      const q = Number(quota);
      const p = Number(period);
      if (q > 0 && p > 0) cores = q / p;
    }
  } catch {
    /* keep host core count */
  }
  return { usageUs, cores };
}

// cgroup v1: cpuacct.usage (ns → µs); effective cores from cpu.cfs_quota_us / cpu.cfs_period_us.
async function readCgV1(): Promise<{ usageUs: number | null; cores: number }> {
  let usageUs: number | null = null;
  for (const p of [`${CG}/cpuacct/cpuacct.usage`, `${CG}/cpu,cpuacct/cpuacct.usage`]) {
    const ns = await readNum(p);
    if (ns != null) {
      usageUs = ns / 1000;
      break;
    }
  }
  let cores = os.cpus().length;
  for (const base of [`${CG}/cpu/`, `${CG}/cpu,cpuacct/`]) {
    const quota = await readNum(`${base}cpu.cfs_quota_us`);
    const period = await readNum(`${base}cpu.cfs_period_us`);
    if (quota != null && quota > 0 && period != null && period > 0) {
      cores = quota / period;
      break;
    }
  }
  return { usageUs, cores };
}

async function computeCpu(): Promise<SystemStats['cpu']> {
  const loadAvg = os.loadavg() as [number, number, number];

  if (scope === 'host') {
    const cur = readHostCpuTotals();
    let usagePct: number | null = null;
    if (prevHostCpu) {
      const dIdle = cur.idle - prevHostCpu.idle;
      const dTotal = cur.total - prevHostCpu.total;
      if (dTotal > 0) usagePct = clampPct(100 * (1 - dIdle / dTotal));
    }
    prevHostCpu = cur;
    return { usagePct, cores: os.cpus().length, loadAvg };
  }

  const { usageUs, cores } = scope === 'cgroup-v2' ? await readCgV2() : await readCgV1();
  const now = Date.now();
  let usagePct: number | null = null;
  if (usageUs != null && prevCgCpu) {
    const dUsage = usageUs - prevCgCpu.usageUs; // µs of CPU time consumed
    const dWall = (now - prevCgCpu.at) * 1000; // wall µs over the interval
    if (dUsage >= 0 && dWall > 0 && cores > 0) usagePct = clampPct((dUsage / dWall / cores) * 100);
  }
  if (usageUs != null) prevCgCpu = { usageUs, at: now };
  return { usagePct, cores: Math.round(cores * 10) / 10, loadAvg };
}

// ── Memory ────────────────────────────────────────────────────────────────────────────────────────────
async function computeMemory(): Promise<SystemStats['memory']> {
  const rssBytes = process.memoryUsage().rss;
  let totalBytes = os.totalmem();
  let usedBytes = os.totalmem() - os.freemem();

  if (scope === 'cgroup-v2') {
    const cur = await readNum(`${CG}/memory.current`);
    if (cur != null) {
      // memory.current includes reclaimable page cache; subtract inactive_file for a truer working set.
      let inactiveFile = 0;
      try {
        const m = (await readFile(`${CG}/memory.stat`, 'utf8')).match(/(?:^|\n)inactive_file\s+(\d+)/);
        if (m) inactiveFile = Number(m[1]);
      } catch {
        /* keep 0 */
      }
      usedBytes = Math.max(0, cur - inactiveFile);
      const maxRaw = (await readFile(`${CG}/memory.max`, 'utf8').catch(() => 'max')).trim();
      totalBytes = maxRaw === 'max' ? os.totalmem() : Number(maxRaw) || os.totalmem();
    }
  } else if (scope === 'cgroup-v1') {
    const cur = await readNum(`${CG}/memory/memory.usage_in_bytes`);
    if (cur != null) {
      usedBytes = cur;
      const lim = await readNum(`${CG}/memory/memory.limit_in_bytes`);
      // v1 "unlimited" is a huge sentinel (~PAGE_COUNTER_MAX) — treat anything ≥ host RAM as no limit.
      totalBytes = lim != null && lim < os.totalmem() ? lim : os.totalmem();
    }
  }

  const usedPct = totalBytes > 0 ? clampPct((100 * usedBytes) / totalBytes) : 0;
  return { totalBytes, usedBytes, usedPct, rssBytes };
}

// ── Disk I/O (/proc/self/io — this process; null when /proc is absent) ─────────────────────────────────
async function computeDiskIo(): Promise<SystemStats['diskIo']> {
  let read = 0;
  let write = 0;
  try {
    const txt = await readFile('/proc/self/io', 'utf8');
    for (const line of txt.split('\n')) {
      if (line.startsWith('read_bytes:')) read = Number(line.slice('read_bytes:'.length).trim());
      else if (line.startsWith('write_bytes:')) write = Number(line.slice('write_bytes:'.length).trim());
    }
  } catch {
    prevIo = null;
    return null;
  }
  const now = Date.now();
  let out: SystemStats['diskIo'] = null;
  if (prevIo) {
    const dt = (now - prevIo.at) / 1000;
    if (dt > 0) {
      out = {
        readMbPerSec: round2((read - prevIo.read) / 1e6 / dt),
        writeMbPerSec: round2((write - prevIo.write) / 1e6 / dt),
      };
    }
  }
  prevIo = { read, write, at: now };
  return out; // null on the first tick after (re)gaining the file
}

// ── Network (/proc/net/dev — sum non-loopback rx/tx → megabits/sec; null when absent) ──────────────────
async function computeNetwork(): Promise<SystemStats['network']> {
  let rx = 0;
  let tx = 0;
  try {
    const txt = await readFile('/proc/net/dev', 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([^:]+):\s*(.*)$/);
      if (!m) continue;
      if (m[1].trim() === 'lo') continue; // skip loopback
      const cols = m[2].trim().split(/\s+/);
      rx += Number(cols[0]); // bytes received
      tx += Number(cols[8]); // bytes transmitted
    }
  } catch {
    prevNet = null;
    return null;
  }
  const now = Date.now();
  let out: SystemStats['network'] = null;
  if (prevNet) {
    const dt = (now - prevNet.at) / 1000;
    if (dt > 0) {
      out = {
        rxMbitPerSec: round2(((rx - prevNet.rx) * 8) / 1e6 / dt),
        txMbitPerSec: round2(((tx - prevNet.tx) * 8) / 1e6 / dt),
      };
    }
  }
  prevNet = { rx, tx, at: now };
  return out;
}

// ── MongoDB connections + health (serverStatus — split cadence, degrades on missing privilege) ──────────
let mongoTick = 0;
let cachedMongo: SystemStats['mongo'] | null = null;
let serverStatusWarned = false;
// Raw cumulative counters from the previous serverStatus read — the basis for the Atlas-style rate deltas.
// Reset to null on every degrade (disconnect / serverStatus failure) so reconnection recomputes cleanly.
let prevMongoRaw: { ts: number; totalOps: number; latencyMicros: number; latencyOps: number; scanned: number; returned: number; scanAndOrder: number } | null = null;

// Compute the live health rates from the current serverStatus doc, diffed against prevMongoRaw. queueDepth is
// an instantaneous snapshot; the four rates are null until a second sample lets us take a delta.
function computeMongoHealth(status: Record<string, unknown>): SystemStats['mongo']['health'] {
  // serverStatus counters are 64-bit — the driver usually promotes them to JS number (promoteLongs), but
  // coerce defensively from bigint / BSON Long ({ low, high } / .toNumber()) so an un-promoted value isn't lost.
  const num = (v: unknown): number => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (typeof v === 'bigint') return Number(v);
    if (v && typeof v === 'object') {
      const o = v as { toNumber?: () => number; low?: number; high?: number };
      if (typeof o.toNumber === 'function') { const n = o.toNumber(); return Number.isFinite(n) ? n : 0; }
      if (typeof o.low === 'number' && typeof o.high === 'number') return o.high * 4294967296 + (o.low >>> 0);
    }
    return 0;
  };
  const opc = (status.opcounters ?? {}) as Record<string, number>;
  const lat = (status.opLatencies ?? {}) as Record<string, { latency?: number; ops?: number }>;
  const metrics = (status.metrics ?? {}) as Record<string, Record<string, unknown>>;
  const qe = (metrics.queryExecutor ?? {}) as Record<string, number>;
  const doc = (metrics.document ?? {}) as Record<string, number>;
  const op = (metrics.operation ?? {}) as Record<string, number>;
  const gl = (status.globalLock ?? {}) as Record<string, { total?: number }>;

  const totalOps = num(opc.insert) + num(opc.query) + num(opc.update) + num(opc.delete) + num(opc.getmore) + num(opc.command);
  const latencyMicros = num(lat.reads?.latency) + num(lat.writes?.latency) + num(lat.commands?.latency);
  const latencyOps = num(lat.reads?.ops) + num(lat.writes?.ops) + num(lat.commands?.ops);
  const scanned = num(qe.scanned);
  const returned = num(doc.returned);
  const scanAndOrder = num(op.scanAndOrder);
  const queueDepth = num(gl.currentQueue?.total);

  const cur = { ts: Date.now(), totalOps, latencyMicros, latencyOps, scanned, returned, scanAndOrder };
  const prev = prevMongoRaw;
  prevMongoRaw = cur;

  if (!prev) return { opsPerSec: null, avgLatencyMs: null, queryTargeting: null, queueDepth, scanAndOrderPerSec: null };
  const dtSec = (cur.ts - prev.ts) / 1000;
  const dOps = cur.latencyOps - prev.latencyOps;
  const dReturned = cur.returned - prev.returned;
  return {
    opsPerSec: dtSec > 0 ? Math.max(0, (cur.totalOps - prev.totalOps) / dtSec) : null,
    avgLatencyMs: dOps > 0 ? Math.max(0, (cur.latencyMicros - prev.latencyMicros) / dOps / 1000) : null,
    queryTargeting: dReturned > 0 ? Math.max(0, (cur.scanned - prev.scanned) / dReturned) : null,
    queueDepth,
    scanAndOrderPerSec: dtSec > 0 ? Math.max(0, (cur.scanAndOrder - prev.scanAndOrder) / dtSec) : null,
  };
}

async function computeMongo(): Promise<SystemStats['mongo']> {
  const readyState = mongoose.connection.readyState;
  const empty = { current: null, available: null, active: null, totalCreated: null };
  if (readyState !== 1) {
    prevMongoRaw = null;
    cachedMongo = { readyState, connections: empty, health: null };
    return cachedMongo;
  }
  // serverStatus() is a real DB command and the counts barely move between 2.5s ticks — refresh every other
  // tick (~5s) and reuse the cached value in between (the health rates are also diffed across this ~5s window).
  if (cachedMongo && mongoTick % 2 !== 0) return { readyState, connections: cachedMongo.connections, health: cachedMongo.health };
  try {
    const status = await mongoose.connection.db?.admin().serverStatus();
    const c = (status?.connections ?? {}) as Record<string, number>;
    cachedMongo = {
      readyState,
      connections: {
        current: c.current ?? null,
        available: c.available ?? null,
        active: c.active ?? null,
        totalCreated: c.totalCreated ?? null,
      },
      health: computeMongoHealth((status ?? {}) as Record<string, unknown>),
    };
    return cachedMongo;
  } catch (err) {
    if (!serverStatusWarned) {
      logger.warn('stats', `serverStatus unavailable (degrading): ${(err as Error).message}`);
      serverStatusWarned = true;
    }
    prevMongoRaw = null;
    cachedMongo = { readyState, connections: empty, health: null };
    return cachedMongo;
  }
}

// ── GPU (videoconfig-gated; spawns nvidia-smi/intel_gpu_top → throttled like mongo) ─────────────────────
let gpuTick = 0;
let cachedGpu: GpuStats | null | undefined; // undefined = not yet sampled (distinct from "no HW accel" null)
let gpuWarned = false;

async function computeGpu(): Promise<GpuStats | null> {
  gpuTick++;
  // Refresh on every other tick (~5s) and reuse in between — videoconfig toggles are rare and the per-vendor
  // probes (nvidia-smi / intel_gpu_top) shouldn't run every 2.5s.
  if (cachedGpu !== undefined && gpuTick % 2 !== 0) return cachedGpu;
  try {
    // Which HW encoders are enabled across all videoconfigs ('app' Default + 'app_<id>' Custom)?
    const enabled = await VideoConfig.find({ 'hwAccel.enabled': true }, { 'hwAccel.encoder': 1, _id: 0 }).lean();
    const encoders = enabled.map((c) => c.hwAccel?.encoder ?? 'none');
    const target = encoders.length ? await resolveGpuTarget(encoders) : null;
    cachedGpu = target ? await sampleGpu(target) : null;
  } catch (err) {
    if (!gpuWarned) {
      logger.warn('stats', `gpu sampling unavailable (degrading): ${(err as Error).message}`);
      gpuWarned = true;
    }
    cachedGpu = null;
  }
  return cachedGpu;
}

// ── the tick ──────────────────────────────────────────────────────────────────────────────────────────
async function tick(): Promise<void> {
  mongoTick++;
  try {
    const [cpu, memory, diskIo, network, mongo, gpu] = await Promise.all([
      computeCpu(),
      computeMemory(),
      computeDiskIo(),
      computeNetwork(),
      computeMongo(),
      computeGpu(),
    ]);
    latest = { ts: Date.now(), scope, cpu, memory, diskIo, network, mongo, gpu };
    if (sockets.size) broadcast({ type: 'system-stats', stats: latest });
  } catch (err) {
    logger.error('stats', `system-stats tick failed: ${(err as Error).message}`);
  }
}

/** The latest cached frame, for GET /api/system-stats (null only in the first tick after boot). */
export function getLatestSystemStats(): SystemStats | null {
  return latest;
}

// ── WebSocket fan-out (copied from statsHub.ts — the guarded-send pattern) ─────────────────────────────
const sockets = new Set<WebSocket>();

function send(ws: WebSocket, text: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(text);
    } catch {
      /* a broken socket is cleaned up on its own close/error */
    }
  }
}

function broadcast(payload: unknown): void {
  const text = JSON.stringify(payload);
  for (const ws of sockets) send(ws, text);
}

/** Wire a freshly-upgraded WebSocket into the system-stats fan-out (called from index.ts's upgrade handler). */
export function attachSystemStats(ws: WebSocket): void {
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
  ws.on('error', () => {
    sockets.delete(ws);
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
  if (latest) send(ws, JSON.stringify({ type: 'system-stats', stats: latest })); // immediate first frame
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the sampling loop. Non-fatal at boot; idempotent. */
export function startSystemStatsHub(): void {
  if (timer) return;
  scope = detectScope();
  void tick(); // prime prev* counters + latest immediately (CPU/disk/net are null until the second tick)
  timer = setInterval(() => void tick(), TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info('stats', `system-stats hub started (scope: ${scope})`);
}

/** Stop the loop + close every socket (graceful shutdown). */
export function closeAllSystemStats(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  sockets.clear();
}
