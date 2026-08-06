// embedExtractors.ts — pull the signed .m3u8 out of a dlhd PLAYER EMBED page (hop 2).
//
// Why this file exists: DaddyLive's "PLAYER 1..6" buttons are NOT six paths to one player. Verified live
// on watch.php?id=648, the six hop-1 pages embed six DIFFERENT providers:
//
//   P1 hamis.romponalis.st/premiumtv/daddy4.php   → atob('…') blob        (the historical shape)
//   P2 dollardescent.net/e/<slug>                 → Cloudflare-gated
//   P3 liveon5.zip//sonic/index.php?a=<n>         → own host
//   P4 logic.icelanders.st/embed/<slug>           → XOR-array eval blob, JW Player
//   P5 www.ksohls.ru/premiumtv/daddyhd.php        → daddy-family again
//
// The old resolver only understood P1's shape (it required "/premiumtv/" in the iframe src AND an atob
// base64 run), so the alternates were unreachable — which is why "Auto" could never hop to a working
// player. This module is the generic replacement: an ORDERED chain of cheap, pure, total extractors, each
// returning candidate master URLs. The chain stops at the first extractor that yields anything; the caller
// tries the candidates in order against hop 3, so a false positive costs one small fetch, not a failure.
//
// Every extractor is written to be SELF-DESCRIBING — it parses whatever constants the page carries rather
// than hardcoding them — because these are third-party sites that rotate. Adding the next provider should
// be a ~10-line function appended to CHAIN, not a rewrite.

/** Absolute-ish .m3u8 references. Protocol-relative is common on embeds; root-relative is resolved by the caller. */
const M3U8_RE = /(?:https?:)?\/\/[^\s"'`<>\\)]+?\.m3u8[^\s"'`<>\\)]*/gi;
// A base64-ish run long enough to hold a signed URL. Same threshold the pre-existing premiumtv reader used.
const B64_RE = /[A-Za-z0-9+/]{40,}={0,2}/g;
// Guard the XOR decoder against a pathological page: the observed blob is ~2.6k entries.
const MAX_XOR_ARRAY = 20_000;
// How many (xor, offset) key pairs the crib-drag fallback will fully decode before giving up.
const MAX_KEY_CANDIDATES = 16;
// Substrings the decoded payload must contain — the crib-drag recovers the keys from these alone.
const CRIBS = ['.m3u8', 'https://'] as const;
// How many candidates any single page may contribute. Hop 3 tries them in order; this bounds the cost of a
// page that happens to mention several .m3u8 URLs (posters, examples, alternate qualities).
const MAX_CANDIDATES = 4;

/** Collect every .m3u8 in `text`, absolutised against `pageUrl`, in first-seen order. */
function scanM3u8(text: string, pageUrl: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(M3U8_RE)) {
    let u = m[0];
    if (u.startsWith('//')) u = `https:${u}`;
    try {
      out.push(new URL(u, pageUrl).href);
    } catch {
      /* skip a malformed match */
    }
  }
  return out;
}

/** Decode every long base64 run in `text` and return the decoded strings that look like URLs/JS. */
function decodeB64Runs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(B64_RE)) {
    try {
      const d = Buffer.from(m[0], 'base64').toString('utf8');
      if (d.includes('m3u8')) out.push(d.trim());
    } catch {
      /* not base64 after all */
    }
  }
  return out;
}

// ── 1. base64 ─────────────────────────────────────────────────────────────────────────────────────────
// The historical /premiumtv/daddy<n>.php shape: source: window.atob('aHR0cHM6Ly…'). Kept first because it
// is the cheapest and still by far the most common.
function base64(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  for (const decoded of decodeB64Runs(html)) {
    if (/^https?:\/\/\S+\.m3u8/i.test(decoded)) out.push(decoded);
    else out.push(...scanM3u8(decoded, pageUrl));
  }
  return out;
}

// ── 2. plaintext ──────────────────────────────────────────────────────────────────────────────────────
// Many embeds ship the URL in clear, in an attribute, or inside an inline JSON config.
function plaintext(html: string, pageUrl: string): string[] {
  return scanM3u8(html, pageUrl);
}

// ── 3. xorEval ────────────────────────────────────────────────────────────────────────────────────────
// logic.icelanders.st/embed/<slug> (dlhd Player 4) ships:
//   var _sx4=[166,166,…],_nb6=210,_uu9=84,_zx0="",_gk5;
//   for(…){ _zx0 += String.fromCharCode(((_sx4[_gk5] ^ _nb6) - _uu9 + 256) % 256); }
//   window["ev"+"al"](_zx0);
// Both keys are literals in the same script, so we recover them instead of hardcoding: first by parsing
// the formula's operands, then — if the identifiers were renamed or inlined differently — by a bounded
// brute force over the 65536 key pairs, scored on "does the head decode to printable ASCII". The decoded
// text is JS source, so it is fed back through the base64 + plaintext extractors.
function xorEval(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  for (const arr of xorArrays(html)) {
    for (const decoded of xorDecodeCandidates(html, arr)) {
      out.push(...plaintext(decoded, pageUrl), ...base64(decoded, pageUrl));
      if (out.length) break; // the first key pair that yields a URL is the right one
    }
    if (out.length) break;
  }
  return out;
}

/** Every plausible byte array literal in the page, longest first (the payload dwarfs any incidental list). */
function xorArrays(html: string): number[][] {
  const found: number[][] = [];
  for (const m of html.matchAll(/\[\s*(\d{1,3}(?:\s*,\s*\d{1,3}){39,})\s*\]/g)) {
    const nums = m[1].split(',').map((s) => Number(s.trim()));
    if (nums.length <= MAX_XOR_ARRAY && nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      found.push(nums);
    }
  }
  return found.sort((a, b) => b.length - a.length).slice(0, 3);
}

/** Candidate decodings of `arr` under c = ((n ^ a) - b + 256) % 256 — parsed keys first, then brute force. */
function xorDecodeCandidates(html: string, arr: number[]): string[] {
  const apply = (a: number, b: number): string =>
    arr.map((n) => String.fromCharCode(((n ^ a) - b + 256) % 256)).join('');

  const pairs: Array<[number, number]> = [];
  const seen = new Set<number>();
  const push = (a: number, b: number): void => {
    const k = (a << 8) | b;
    if (!seen.has(k)) {
      seen.add(k);
      pairs.push([a, b]);
    }
  };

  // Parse: ((IDENT[IDENT] ^ A) - B + 256) % 256, where A/B are literals or identifiers assigned literals.
  const f = html.match(/\(\s*\(\s*\w+\s*\[[^\]]+\]\s*\^\s*(\w+)\s*\)\s*-\s*(\w+)\s*\+\s*256\s*\)\s*%\s*256/);
  if (f) {
    const lit = (tok: string): number | null => {
      if (/^\d+$/.test(tok)) return Number(tok);
      const d = html.match(new RegExp(`\\b${tok}\\s*=\\s*(\\d+)`));
      return d ? Number(d[1]) : null;
    };
    const a = lit(f[1]);
    const b = lit(f[2]);
    if (a !== null && b !== null) push(a, b);
  }

  // Key-recovery fallback, for when the formula was renamed or inlined past the parser above. A
  // printable-ASCII test is far too weak a discriminator here (ASCII is 7-bit, so hundreds of key pairs
  // keep the plaintext "readable"); instead CRIB-DRAG the one string the payload must contain. For every
  // offset and every xor key the subtraction key is forced by the crib's first byte, so this is a single
  // O(len x 256) sweep with an early exit — ~1M cheap ops on the observed ~2.6k blob. Keys rotate; the
  // transform shape has not.
  for (const crib of CRIBS) {
    for (const [a, b] of cribDrag(arr, crib)) push(a, b);
    if (pairs.length >= MAX_KEY_CANDIDATES) break;
  }

  // Rank by how much of the full decode is printable — the real key wins decisively over a chance hit.
  return pairs
    .slice(0, MAX_KEY_CANDIDATES)
    .map(([a, b]) => apply(a, b))
    .filter((s) => s.includes('m3u8'))
    .sort((x, y) => printableRatio(y) - printableRatio(x));
}

/** Key pairs under which `arr` decodes to `crib` at some offset. */
function cribDrag(arr: number[], crib: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const seen = new Set<number>();
  const c0 = crib.charCodeAt(0);
  for (let i = 0; i + crib.length <= arr.length; i++) {
    for (let a = 0; a < 256; a++) {
      // The crib's first byte forces b, so there is exactly one b to check per (offset, a).
      const b = (((arr[i] ^ a) - c0) % 256 + 256) % 256;
      let ok = true;
      for (let j = 1; j < crib.length; j++) {
        if (((arr[i + j] ^ a) - b + 256) % 256 !== crib.charCodeAt(j)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const k = (a << 8) | b;
      if (!seen.has(k)) {
        seen.add(k);
        out.push([a, b]);
      }
    }
  }
  return out;
}

function printableRatio(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)) n++;
  }
  return s.length ? n / s.length : 0;
}

// ── 4. packed ─────────────────────────────────────────────────────────────────────────────────────────
// Dean Edwards' p,a,c,k,e,d packer — the most common embed obfuscation after plain base64. Unpacking is a
// pure symbol substitution, so no eval is involved.
function packed(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(
    /}\s*\(\s*'((?:\\.|[^'\\])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\.|[^'\\])*)'\s*\.split\('\|'\)/g,
  )) {
    const payload = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    const radix = Number(m[2]);
    const words = m[4].split('|');
    if (!Number.isInteger(radix) || radix < 2 || radix > 62) continue;
    const unpacked = payload.replace(/\b\w+\b/g, (tok) => {
      const i = parseInt(tok, radix);
      return Number.isNaN(i) || !words[i] ? tok : words[i];
    });
    out.push(...plaintext(unpacked, pageUrl), ...base64(unpacked, pageUrl));
  }
  return out;
}

// ── 5. hexEscape ──────────────────────────────────────────────────────────────────────────────────────
// Cheap catch-all: many packers only \x/\u-escape the URL. Unescape and re-scan.
function hexEscape(html: string, pageUrl: string): string[] {
  if (!/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/i.test(html)) return [];
  const un = html
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return [...plaintext(un, pageUrl), ...base64(un, pageUrl)];
}

/** The ordered chain. Cheapest + most common first; the first extractor that yields anything wins. */
const CHAIN: Array<{ name: string; run: (html: string, pageUrl: string) => string[] }> = [
  { name: 'base64', run: base64 },
  { name: 'plaintext', run: plaintext },
  { name: 'xorEval', run: xorEval },
  { name: 'packed', run: packed },
  { name: 'hexEscape', run: hexEscape },
];

export interface EmbedExtraction {
  /** Candidate master/media playlist URLs, absolute, deduped, best-first. */
  urls: string[];
  /** Which extractor produced them — surfaced in logs so a provider rotation is diagnosable. */
  extractor: string;
}

/**
 * Pull candidate playlist URLs out of a player-embed page. Returns `urls: []` when no extractor matched
 * (the caller treats that as "this player isn't live / isn't a shape we understand" and moves on).
 */
export function extractMasterUrls(html: string, pageUrl: string): EmbedExtraction {
  for (const { name, run } of CHAIN) {
    let urls: string[];
    try {
      urls = run(html, pageUrl);
    } catch {
      continue; // an extractor must never break the walk
    }
    const uniq = [...new Set(urls)].slice(0, MAX_CANDIDATES);
    if (uniq.length) return { urls: uniq, extractor: name };
  }
  return { urls: [], extractor: 'none' };
}
