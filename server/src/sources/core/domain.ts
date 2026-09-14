// Shared operator-typed DOMAIN normalizer. Lifted out of adapters/dulo/config.ts so every source whose home
// domain is an operator SETTING (dulo rebrands; zlive's is set the same way) runs one SSRF boundary instead of
// a copy each — a copy is where the next hardening fix gets applied to one source and silently missed in the
// other. dulo/config.ts keeps its own `normalizeDomain(raw)` as a thin wrapper, so its callers and its exact
// error text are unchanged.
//
// This is a real security boundary, not cosmetic validation: the Settings "Test"/"Auto-detect" helpers and a
// source's catalog/resolver fetches all go to whatever host comes back from here, server-side. So beyond
// shape it rejects IP literals and private/loopback hosts (the literal-only guard in ./ssrf.ts — DNS
// rebinding is out of scope there and here).
//
// Mongo-free and dependency-light on purpose: the per-source config leaves that call it must stay importable
// from the hot proxy path and from the settings translate layer alike.

import { isPrivateHost } from './ssrf.js';

export type DomainParse = { ok: true; domain: string } | { ok: false; error: string };

/**
 * Normalize an operator-typed domain into a bare lowercase host.
 *
 * Accepts "dulo.tv", "https://Dulo.TV/", "HTTPS://dulo.tv/live?x=1" — scheme, path, query, userinfo and port
 * are all stripped. Rejects anything but http(s), IP literals, private/loopback targets and names without a
 * plausible TLD.
 *
 * `label` names the source in the one message that is about the source rather than the input ("an IP address
 * is not a valid <label> domain"); omitted, that message reads "not a valid domain".
 */
export function normalizeDomain(raw: string, label?: string): DomainParse {
  const v = String(raw ?? '').trim();
  if (!v) return { ok: false, error: 'domain is required' };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    return { ok: false, error: `"${v}" is not a valid domain` };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: 'only http(s) domains are supported' };
  }
  const host = u.hostname.toLowerCase(); // hostname drops userinfo + port; IPv6 stays bracketed
  if (!host) return { ok: false, error: `"${v}" is not a valid domain` };
  if (isPrivateHost(host)) return { ok: false, error: `"${host}" is a private or loopback address` };
  if (host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return { ok: false, error: `an IP address is not a valid ${label ? `${label} ` : ''}domain — use a hostname` };
  }
  // At least one dot and a plausible TLD label (allows punycode "xn--…" TLDs).
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(host)) {
    return { ok: false, error: `"${host}" is not a valid domain name` };
  }
  return { ok: true, domain: host };
}
