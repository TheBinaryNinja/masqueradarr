// Translation layer between the EXTERNAL proxy-config doc (MongoDB — the source of truth) and the INTERNAL
// runtime shape the API returns and the resolve seam embeds in the grant. The ProxyConfig analogue of
// settings/translate.ts: the single place the internal<->external boundary is defined, so the boot seed
// (proxyconfig/seed), the route (GET read projection + PUT patch builder) and the grant resolution
// (proxyconfig/resolve) all agree on one mapping.
//
//   - envDefaults()          ENV -> external : first-boot defaults for the (Default) singleton ($setOnInsert),
//                                              also the GET/resolve fallback if the row is missing.
//   - toRuntimeProxyConfig() external -> internal : a stored doc -> the runtime shape (drops _id). No secret
//                                                    redaction — these are operator knobs on an admin surface,
//                                                    so headerOverrides is returned verbatim (unlike Settings'
//                                                    maxmindLicenseKey).
//   - toExternalPatch()      internal -> external : a request body -> a validated, whitelisted $set patch (or a
//                                                    400 error string). The one input gate.
//
// P2 keeps the surface SMALL (see models/ProxyConfig.ts); knobs whose phase hasn't landed still validate +
// persist (they ship in the grant, enforced later). See .claude/plans/durable-iptv-proxy.md.

import type { ProxyConfigDoc } from '../models/ProxyConfig.js';

// The external-data shape minus the keyed _id — what seeds/patches/reads operate on.
export type ProxyConfigData = Omit<ProxyConfigDoc, '_id'>;

// Internal runtime shape returned by the API + carried in the grant. No divergence from ProxyConfigData in P2
// (no secret fields to redact) — kept as a distinct alias so a future redaction has one place to land.
export type RuntimeProxyConfig = ProxyConfigData;

// The distribution containers honored today (remux-free core): 'hls' (per-segment passthrough + manifest
// rewrite) and 'ts' (P3.2/DST — a continuous raw-TS stream on the external-player mount, for pure-MPEG-TS
// upstreams; the data plane falls back to HLS for fMP4/AES). 'mp4'/'dash' still need RMX (deferred), so the
// input gate rejects them. 'ts' applies to the /api/ext/v1 mount; the in-app player (/api/v1) is always HLS.
export const OUTPUT_FORMATS = ['hls', 'ts'] as const;

// Clamp an integer env var into [min, max], falling back to `def` for an unset/invalid value.
function envInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ENV -> external. Defaults for the (Default) singleton — seeded on first boot and used as the GET/resolve
// fallback. Only the two LIVE-in-P2 knobs read an env var (so an operator can pin the data-plane client at
// provision); the deferred knobs default to their inert null/'hls' values.
export function envDefaults(): ProxyConfigData {
  return {
    connectTimeoutMs: envInt(process.env.PROXY_CONNECT_TIMEOUT_MS, 15000, 100, 120000),
    readTimeoutMs: null,
    bufferSizeKb: null,
    maxRedirects: envInt(process.env.PROXY_MAX_REDIRECTS, 10, 0, 50),
    headerOverrides: {},
    outputFormat: 'hls',
    segmentCacheTtlSec: null,
  };
}

// external -> internal. Project a stored doc into the runtime shape (drops _id), coercing each field to a safe
// value so a partially-populated or legacy doc still resolves.
export function toRuntimeProxyConfig(doc: ProxyConfigDoc): RuntimeProxyConfig {
  const d = envDefaults();
  return {
    connectTimeoutMs: typeof doc.connectTimeoutMs === 'number' ? doc.connectTimeoutMs : d.connectTimeoutMs,
    readTimeoutMs: typeof doc.readTimeoutMs === 'number' ? doc.readTimeoutMs : null,
    bufferSizeKb: typeof doc.bufferSizeKb === 'number' ? doc.bufferSizeKb : null,
    maxRedirects: typeof doc.maxRedirects === 'number' ? doc.maxRedirects : d.maxRedirects,
    headerOverrides: sanitizeHeaderMap(doc.headerOverrides),
    outputFormat: OUTPUT_FORMATS.includes(doc.outputFormat as (typeof OUTPUT_FORMATS)[number]) ? doc.outputFormat : 'hls',
    segmentCacheTtlSec: typeof doc.segmentCacheTtlSec === 'number' ? doc.segmentCacheTtlSec : null,
  };
}

// Keep only string->string entries with a plausible header-name key — a defensive projection so a hand-edited
// or legacy doc can never feed a non-string header into the grant/Rust.
function sanitizeHeaderMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof k === 'string' && /^[A-Za-z0-9-]+$/.test(k) && typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

export type PatchResult =
  | { ok: true; $set: Partial<ProxyConfigData> }
  | { ok: false; error: string };

// A nullable-integer knob: accepts null (clears it), or an integer in [min, max]; anything else is a 400.
function patchNullableInt(
  $set: Partial<ProxyConfigData>,
  b: Record<string, unknown>,
  key: 'readTimeoutMs' | 'bufferSizeKb' | 'segmentCacheTtlSec',
  min: number,
  max: number,
): string | null {
  if (b[key] === undefined) return null;
  const v = b[key];
  if (v === null) {
    $set[key] = null;
    return null;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    return `${key} (integer ${min}..${max} or null) required`;
  }
  $set[key] = v;
  return null;
}

// A required-integer knob: accepts an integer in [min, max]; anything else (incl. null) is a 400.
function patchInt(
  $set: Partial<ProxyConfigData>,
  b: Record<string, unknown>,
  key: 'connectTimeoutMs' | 'maxRedirects',
  min: number,
  max: number,
): string | null {
  if (b[key] === undefined) return null;
  const v = b[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    return `${key} (integer ${min}..${max}) required`;
  }
  $set[key] = v;
  return null;
}

// internal -> external. Validate a request body and build the $set patch persisted to Mongo. Unknown fields
// are ignored; every known field is type-checked; a failure returns a 400 message naming the field.
export function toExternalPatch(body: unknown): PatchResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const $set: Partial<ProxyConfigData> = {};

  for (const err of [
    patchInt($set, b, 'connectTimeoutMs', 100, 120000),
    patchInt($set, b, 'maxRedirects', 0, 50),
    patchNullableInt($set, b, 'readTimeoutMs', 0, 600000),
    patchNullableInt($set, b, 'bufferSizeKb', 16, 1048576),
    patchNullableInt($set, b, 'segmentCacheTtlSec', 0, 86400),
  ]) {
    if (err) return { ok: false, error: err };
  }

  if (b.outputFormat !== undefined) {
    const v = b.outputFormat;
    if (typeof v !== 'string' || !OUTPUT_FORMATS.includes(v as (typeof OUTPUT_FORMATS)[number])) {
      return { ok: false, error: `outputFormat (one of: ${OUTPUT_FORMATS.join(', ')}) required` };
    }
    $set.outputFormat = v;
  }

  // headerOverrides: an object of header-name -> string value. An empty object clears all overrides. Reject a
  // non-object, a non-string value, or an implausible header name (so nothing bad reaches the grant/Rust).
  if (b.headerOverrides !== undefined) {
    const v = b.headerOverrides;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return { ok: false, error: 'headerOverrides (object of string values) required' };
    }
    const clean: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9-]+$/.test(k)) return { ok: false, error: `headerOverrides: '${k}' is not a valid header name` };
      if (typeof val !== 'string') return { ok: false, error: `headerOverrides['${k}'] (string) required` };
      clean[k] = val;
    }
    $set.headerOverrides = clean;
  }

  return { ok: true, $set };
}
