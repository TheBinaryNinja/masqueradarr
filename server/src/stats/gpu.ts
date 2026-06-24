// Live GPU telemetry sampler for the Dashboard "GPU Performance" card. DB-free and source-agnostic: given the
// set of HW encoders currently enabled across the videoconfigs (the caller resolves that from Mongo), it picks
// the primary GPU's vendor and samples live usage/resources off the host. Every path degrades to null and
// NEVER throws — the system-stats tick must not crash. Provenance per vendor:
//   • NVIDIA — `nvidia-smi` (injected at runtime by the NVIDIA Container Toolkit; no apt install)
//   • AMD    — /sys/class/drm sysfs counters (no binary), with a `radeontop` fallback for utilization
//   • Intel  — `intel_gpu_top -J` (the `intel-gpu-tools` package)
// Mirrors videoconfig/hwDetect.ts's exec-with-timeout posture and systemStatsHub.ts's "every metric degrades
// to null rather than throwing" rule. A fabricated value is never returned — an unavailable metric is null.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 2500; // a GPU probe must never hold the ~2.5s tick open

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'unknown';

// One frame of GPU telemetry. Mirror this on the SPA side (src/data.ts → SystemStats.gpu). Every numeric is
// nullable: explicit null when the host can't report it (no device, tool missing, integrated/shared memory).
export interface GpuStats {
  vendor: GpuVendor;
  name: string | null; // friendly model when the tool reports one (NVIDIA does; AMD/Intel often null)
  encoder: string | null; // the enabled HW encoder driving it, e.g. 'h264_nvenc'
  utilizationPct: number | null; // overall GPU / render-engine busy %
  encoderPct: number | null; // dedicated encode-engine % (NVENC / Intel Video); null when not exposed
  memUsedBytes: number | null; // VRAM used (null on Intel — shared system memory)
  memTotalBytes: number | null;
  memUsedPct: number | null;
  temperatureC: number | null;
  source: 'nvidia-smi' | 'sysfs' | 'radeontop' | 'intel_gpu_top' | null; // where the numbers came from
}

interface GpuTarget {
  vendor: GpuVendor;
  encoder: string | null;
  cardPath: string | null; // /sys/class/drm/cardN/device for AMD/Intel; null for NVIDIA / unresolved
}

// ── small pure helpers (mirror systemStatsHub.ts; kept local to avoid a circular import) ────────────────
function clampPct(n: number): number {
  return Math.round(Math.max(0, Math.min(100, n)) * 10) / 10;
}
function toNum(s: string | undefined): number | null {
  if (s == null) return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
}
function toPct(s: string | undefined): number | null {
  const n = toNum(s);
  return n == null ? null : clampPct(n);
}
function mibToBytes(s: string | undefined): number | null {
  const n = toNum(s);
  return n == null ? null : Math.round(n * 1024 * 1024);
}
function pctOf(used: number | null, total: number | null): number | null {
  if (used == null || total == null || total <= 0) return null;
  return clampPct((100 * used) / total);
}
async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
async function readNum(path: string): Promise<number | null> {
  return toNum((await readText(path)) ?? undefined);
}

// ── DRM card discovery (vendor disambiguation for VAAPI) ────────────────────────────────────────────────
// PCI vendor ids on /sys/class/drm/cardN/device/vendor. VAAPI/QSV/AMF can't tell Intel from AMD by encoder
// name alone, so we read the id off the render node.
const PCI = { nvidia: '0x10de', amd: '0x1002', intel: '0x8086' } as const;

async function listDrmCards(): Promise<Array<{ cardPath: string; vendorId: string }>> {
  let entries: string[];
  try {
    entries = await readdir('/sys/class/drm');
  } catch {
    return []; // non-Linux dev / no DRM
  }
  const cards: Array<{ cardPath: string; vendorId: string }> = [];
  for (const e of entries) {
    if (!/^card\d+$/.test(e)) continue; // skip connector subdirs (card0-HDMI-…) and renderD* nodes
    const cardPath = `/sys/class/drm/${e}/device`;
    const vendorId = ((await readText(`${cardPath}/vendor`)) ?? '').trim().toLowerCase();
    if (vendorId) cards.push({ cardPath, vendorId });
  }
  return cards;
}

/**
 * Resolve the primary GPU to sample from the set of currently-enabled HW encoders. Returns null when nothing
 * real is enabled (encoder 'none' or empty) → the card stays hidden. v1 samples a single primary GPU; multi-
 * GPU / multi-vendor aggregation is out of scope.
 */
export async function resolveGpuTarget(enabledEncoders: string[]): Promise<GpuTarget | null> {
  const encoders = enabledEncoders.filter((e) => e && e !== 'none');
  if (!encoders.length) return null;
  const pick = (frag: string): string | null => encoders.find((e) => e.includes(frag)) ?? null;
  const has = (frag: string): boolean => encoders.some((e) => e.includes(frag));

  // NVIDIA: NVENC + a present device node (the container-runtime devices).
  if (has('nvenc') && (existsSync('/dev/nvidia0') || existsSync('/dev/nvidiactl'))) {
    return { vendor: 'nvidia', encoder: pick('nvenc'), cardPath: null };
  }

  const cards = await listDrmCards();
  const cardOf = (vendorId: string): string | null => cards.find((c) => c.vendorId === vendorId)?.cardPath ?? null;

  // AMD: AMF, or VAAPI on an AMD render node.
  if (has('amf') || (has('vaapi') && cardOf(PCI.amd))) {
    const cardPath = cardOf(PCI.amd);
    if (cardPath) return { vendor: 'amd', encoder: pick('amf') ?? pick('vaapi'), cardPath };
  }
  // Intel: QSV, or VAAPI on an Intel render node.
  if (has('qsv') || (has('vaapi') && cardOf(PCI.intel))) {
    const cardPath = cardOf(PCI.intel);
    if (cardPath) return { vendor: 'intel', encoder: pick('qsv') ?? pick('vaapi'), cardPath };
  }

  // Enabled, but no live source resolvable (device absent / dev host): still report the inferred vendor so the
  // card appears with '—' metrics, per spec ("show when HW accel is enabled").
  if (has('nvenc')) return { vendor: 'nvidia', encoder: pick('nvenc'), cardPath: null };
  if (has('amf')) return { vendor: 'amd', encoder: pick('amf'), cardPath: cardOf(PCI.amd) };
  if (has('qsv')) return { vendor: 'intel', encoder: pick('qsv'), cardPath: cardOf(PCI.intel) };
  if (has('vaapi')) {
    if (cardOf(PCI.amd)) return { vendor: 'amd', encoder: pick('vaapi'), cardPath: cardOf(PCI.amd) };
    if (cardOf(PCI.intel)) return { vendor: 'intel', encoder: pick('vaapi'), cardPath: cardOf(PCI.intel) };
    return { vendor: 'unknown', encoder: pick('vaapi'), cardPath: null };
  }
  return { vendor: 'unknown', encoder: encoders[0] ?? null, cardPath: null }; // e.g. videotoolbox (macOS dev)
}

/** Sample live stats for a resolved target. Always returns a frame; failed probes leave metrics null. */
export async function sampleGpu(target: GpuTarget): Promise<GpuStats> {
  const base: GpuStats = {
    vendor: target.vendor,
    name: null,
    encoder: target.encoder,
    utilizationPct: null,
    encoderPct: null,
    memUsedBytes: null,
    memTotalBytes: null,
    memUsedPct: null,
    temperatureC: null,
    source: null,
  };
  try {
    if (target.vendor === 'nvidia') return await sampleNvidia(base);
    if (target.vendor === 'amd' && target.cardPath) return await sampleAmd(base, target.cardPath);
    if (target.vendor === 'intel' && target.cardPath) return await sampleIntel(base, target.cardPath);
  } catch {
    /* degrade to the all-null base frame */
  }
  return base;
}

// ── NVIDIA — nvidia-smi ─────────────────────────────────────────────────────────────────────────────────
async function sampleNvidia(base: GpuStats): Promise<GpuStats> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
      { timeout: EXEC_TIMEOUT_MS },
    ));
  } catch {
    return base; // nvidia-smi absent (no Container Toolkit) / failed → no live source
  }
  const out: GpuStats = { ...base, source: 'nvidia-smi' };
  const first = stdout.split('\n').find((l) => l.trim().length);
  if (first) {
    const [name, util, memUsed, memTotal, temp] = first.split(',').map((s) => s.trim());
    out.name = name || null;
    out.utilizationPct = toPct(util);
    out.memUsedBytes = mibToBytes(memUsed);
    out.memTotalBytes = mibToBytes(memTotal);
    out.memUsedPct = pctOf(out.memUsedBytes, out.memTotalBytes);
    out.temperatureC = toNum(temp);
  }
  // Encode-engine % is not a --query-gpu field; pull it from the verbose UTILIZATION report (best-effort).
  try {
    const { stdout: util } = await execFileAsync('nvidia-smi', ['-q', '-d', 'UTILIZATION'], { timeout: EXEC_TIMEOUT_MS });
    const m = util.match(/Encoder\s*:\s*(\d+)\s*%/);
    if (m) out.encoderPct = clampPct(Number(m[1]));
  } catch {
    /* leave encoderPct null */
  }
  return out;
}

// ── AMD — /sys/class/drm sysfs (radeontop fallback for utilization) ─────────────────────────────────────
async function sampleAmd(base: GpuStats, cardPath: string): Promise<GpuStats> {
  const out: GpuStats = { ...base, source: 'sysfs' };
  const busy = await readNum(`${cardPath}/gpu_busy_percent`);
  out.utilizationPct = busy == null ? null : clampPct(busy);
  out.memUsedBytes = await readNum(`${cardPath}/mem_info_vram_used`);
  out.memTotalBytes = await readNum(`${cardPath}/mem_info_vram_total`);
  out.memUsedPct = pctOf(out.memUsedBytes, out.memTotalBytes);
  out.temperatureC = await readHwmonTemp(cardPath);

  if (out.utilizationPct == null) {
    const rt = await sampleRadeontop(); // sysfs busy% unavailable on some kernels → radeontop
    if (rt != null) {
      out.utilizationPct = rt;
      out.source = 'radeontop';
    }
  }
  return out;
}

async function sampleRadeontop(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('radeontop', ['-d', '-', '-l', '1'], { timeout: EXEC_TIMEOUT_MS });
    const m = stdout.match(/gpu\s+([\d.]+)\s*%/i); // "... gpu 37.50%, ee 0.00%, ..."
    if (m) return clampPct(Number(m[1]));
  } catch {
    /* radeontop absent / failed */
  }
  return null;
}

// ── Intel — intel_gpu_top -J ────────────────────────────────────────────────────────────────────────────
async function sampleIntel(base: GpuStats, cardPath: string): Promise<GpuStats> {
  // intel_gpu_top streams a JSON array of periodic samples; capture briefly, then parse the first complete
  // object. The timeout kills it (intel_gpu_top runs until interrupted); we keep whatever it printed.
  let stdout = '';
  try {
    const res = await execFileAsync('intel_gpu_top', ['-J', '-s', '1000'], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
    stdout = res.stdout;
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? ''; // timeout/SIGTERM still yields partial stdout
  }
  const sample = firstJsonObject(stdout);
  if (!sample) return base; // intel_gpu_top absent / no perf permission → no live source

  const out: GpuStats = { ...base, source: 'intel_gpu_top' };
  const engines = sample.engines as Record<string, { busy?: number }> | undefined;
  if (engines) {
    const render = engines['Render/3D']?.busy ?? engines['Render/3D/0']?.busy;
    const video = engines['Video']?.busy ?? engines['Video/0']?.busy;
    if (render != null) out.utilizationPct = clampPct(render);
    if (video != null) out.encoderPct = clampPct(video);
  }
  out.temperatureC = await readHwmonTemp(cardPath); // i915 hwmon, best-effort
  // VRAM stays null — Intel integrated GPUs share system memory (already on the System Performance card).
  return out;
}

// First balanced {...} in a (possibly truncated) JSON stream. intel_gpu_top values are numbers/objects with
// simple keys, so naive brace counting is safe (no braces inside string values).
function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ── shared: hwmon temperature (AMD + Intel expose temp1_input in milli-°C) ──────────────────────────────
async function readHwmonTemp(cardPath: string): Promise<number | null> {
  try {
    const dirs = await readdir(`${cardPath}/hwmon`);
    for (const d of dirs) {
      const milli = await readNum(`${cardPath}/hwmon/${d}/temp1_input`);
      if (milli != null) return Math.round(milli / 1000);
    }
  } catch {
    /* no hwmon */
  }
  return null;
}
