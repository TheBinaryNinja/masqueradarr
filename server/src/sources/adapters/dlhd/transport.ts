// transport.ts — name the way a dlhd fetch failed below HTTP, so the operator gets advice that fits.
//
// fetch() reports every connection-level failure as the same `TypeError: fetch failed`; the real reason sits
// on `cause`. The distinction is not cosmetic. Every mirror DaddyLive advertised on 2026-09-15 sat on ONE origin
// IP, so when that origin refuses this server (an IP rate-limit block), telling the operator to change
// `daddylive.domain` sends them after the wrong fix — while a domain that no longer resolves is exactly the case
// where changing it is right.
//
//   refused  — TCP reset on connect: the host is up and turning THIS client away (rate-limit / IP block)
//   dns      — the name does not resolve: the domain is gone or moved
//   timeout  — no answer in time: down, blackholed, or slow
//   network  — any other transport failure (reset mid-request, unreachable network, TLS)
//   throttled — the host DID answer, with HTTP 429. Not a transport failure, and transportKind() never returns
//               it; the resolver assigns it, because the right response is the same as to `refused`: stop asking.

export type TransportKind = 'refused' | 'dns' | 'timeout' | 'network' | 'throttled';

interface NetErr {
  name?: string;
  message?: string;
  code?: unknown; // a string errno code — or, on a DOMException (TimeoutError), a legacy NUMBER
  syscall?: string;
  errors?: NetErr[];
  cause?: NetErr;
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'ENODATA', 'ESERVFAIL', 'ENONAME']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);

/** The underlying error fetch() wrapped, or the error itself when it wasn't wrapped. */
function root(err: unknown): NetErr {
  const e = (err ?? {}) as NetErr;
  return e.cause ?? e;
}

/** The errno-style code of the underlying error, or '' (a DOMException's numeric code is not one). */
function codeOf(err: unknown): string {
  const code = root(err).code;
  return typeof code === 'string' ? code : '';
}

/**
 * Classify a transport failure, or null when `err` is not one (an HTTP status, a parse error, our own throw).
 *
 * `ECONNREFUSED` only counts as `refused` on a CONNECT: the custom DNS resolver (src/dns.ts) surfaces c-ares
 * errors, and c-ares reports a refusing NAMESERVER with that same code under a `query*` syscall. Node's
 * happy-eyeballs connect wraps one refusal per address in an AggregateError whose own syscall is unset.
 */
export function transportKind(err: unknown): TransportKind | null {
  const top = (err ?? {}) as NetErr;
  if (top.name === 'TimeoutError' || top.name === 'AbortError') return 'timeout';
  const c = root(err);
  const code = codeOf(err);
  const syscalls = c.syscall ? [c.syscall] : (c.errors ?? []).map((x) => x.syscall ?? '');
  const isDnsCall = syscalls.some((s) => s === 'getaddrinfo' || s.startsWith('query'));
  if (code === 'ECONNREFUSED' && syscalls.length && syscalls.every((s) => s === 'connect')) return 'refused';
  if (DNS_CODES.has(code) || isDnsCall || /\bno addresses\b/.test(c.message ?? '')) return 'dns';
  if (code === 'ETIMEOUT') return 'dns'; // c-ares: the nameserver never answered
  if (TIMEOUT_CODES.has(code)) return 'timeout';
  // Errno-style and undici socket codes only: an `ERR_*` (e.g. ERR_INVALID_URL) is our input, not the network.
  if (top.message === 'fetch failed' || /^E[A-Z]+$/.test(code) || code.startsWith('UND_ERR')) return 'network';
  return null;
}

/** `fetch failed` plus the code that explains it — `fetch failed (ECONNREFUSED)` — for logs and reasons. */
export function transportText(err: unknown): string {
  const top = (err ?? {}) as NetErr;
  const code = codeOf(err);
  const msg = String(top.message ?? err);
  return code && !msg.includes(code) ? `${msg} (${code})` : msg;
}

/** One clause naming what happened to `host` (a hostname or a label like "DaddyLive at x"), for the operator. */
export function describeTransport(kind: TransportKind, host: string): string {
  switch (kind) {
    case 'refused':
      return `${host} is refusing connections from this server (likely a temporary rate-limit block on this server's IP)`;
    case 'dns':
      return `${host} does not resolve (the domain is gone or has moved)`;
    case 'timeout':
      return `${host} did not answer in time (down, blackholed, or very slow)`;
    case 'throttled':
      return `${host} is rate-limiting this server (HTTP 429)`;
    default:
      return `${host} could not be reached`;
  }
}
