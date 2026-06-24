// Shared SSRF private-IP guard. Lifted out of adapters/dlhd/config.ts so any adapter can reuse it without
// depending on dlhd internals — the `direct` (imported-playlist) adapter gates arbitrary user-supplied
// upstream hosts with it. dlhd/config.ts now re-exports this so its existing callers are unchanged.
//
// Belt-and-suspenders: never let a literal private / loopback / link-local target through, so a learned or
// user-pasted host can't point the proxy at the internal network. NOTE: this blocks IP-LITERAL + "localhost"
// targets only — it does NOT defend against DNS-rebinding (a public name resolving to a private IP), which
// would need a per-hop DNS lookup (out of scope; an upstream allowlist is the primary gate where one exists).

const PRIVATE_V4 = /^(?:0|10|127|169\.254|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./;

export function isPrivateHost(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 literal brackets
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.includes(':')) {
    // IPv6 literal: loopback ::1, unspecified ::, link-local fe80::/10, unique-local fc00::/7.
    return h === '::1' || h === '::' || /^fe[89ab]/.test(h) || /^f[cd]/.test(h);
  }
  // IPv4: classify only a dotted-quad literal so real domains (e.g. "10.example.com") aren't misflagged.
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) && PRIVATE_V4.test(h);
}
