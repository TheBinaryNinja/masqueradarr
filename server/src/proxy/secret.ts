import { randomBytes, timingSafeEqual } from 'node:crypto';

// Shared secret gating the Node↔sidecar internal channel: Rust→Node (the resolve seam + telemetry ingest)
// and Node→Rust (the relay). The sidecar is loopback-only, so the secret is defense-in-depth against another
// local process reaching either side. Operator-overridable via MASQ_PROXY_SECRET; otherwise a strong per-boot
// random. Generated ONCE at first import — both sidecar.ts (which passes it to the child via env) and the
// internal router import this same module, so they share the value.
export const PROXY_SECRET = process.env.MASQ_PROXY_SECRET || randomBytes(32).toString('hex');

// The header the two sides carry the secret on.
export const PROXY_SECRET_HEADER = 'x-masq-secret';

/** Constant-time compare of a provided secret against ours. Length-guards first (timingSafeEqual throws on a length mismatch). */
export function checkSecret(provided: string | undefined | string[]): boolean {
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(PROXY_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}
