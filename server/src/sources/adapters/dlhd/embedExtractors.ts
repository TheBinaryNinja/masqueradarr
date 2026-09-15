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
// …and they rotate within hours. On 2026-09-15, ch 925 / 648 on dlive.sx:
//
//   P1 assetrage.net/e/<slug>, P2 tiestep.top/e/<slug>  → one provider, two domains: `window._econfig` blob
//                                                         (shuffledConfig) — the only one actually serving
//   P3 hamis.romponalis.st/premiumtv/daddy.php          → 403 "not available on your domain"
//   P4 epiembeds.online/embed/<name>                    → XOR-array blob (xorEval), but a self-signed TLS cert
//   P3/P4 liveon5.zip, P5/P6 www.ksohls.ru              → refusing connections / NXDOMAIN
//
// The old resolver only understood P1's shape (it required "/premiumtv/" in the iframe src AND an atob
// base64 run), so the alternates were unreachable — which is why "Auto" could never hop to a working
// player. This module is the generic replacement: an ORDERED chain of cheap, pure, total extractors, each
// returning candidate master URLs. EVERY extractor runs and the candidates are pooled in chain order — the
// most specific decoders first, the plaintext scan (the one most likely to pick up a decoy) last — and the
// caller tries them in that order against hop 3, so a false positive costs one small fetch, not a failure.
// (The chain used to stop at the first extractor that found anything, which let one decoy .m3u8 in an ad
// script hide the real URL a later extractor would have decoded.)
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
// How many candidates any single extractor may contribute, and how many a page may yield in total. Hop 3 tries
// them in order; this bounds the cost of a page that happens to mention several .m3u8 URLs (posters, examples,
// alternate qualities).
const MAX_CANDIDATES = 4;
const MAX_TOTAL_CANDIDATES = 6;

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
// Many embeds ship the URL in clear, in an attribute, or inside an inline JSON config — where a serializer
// usually escapes the slashes (`streamUrl: "https:\/\/…"`), which hides the `//` the scan anchors on.
function plaintext(html: string, pageUrl: string): string[] {
  return scanM3u8(html.replace(/\\\//g, '/'), pageUrl);
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

// ── 6. shuffledConfig ─────────────────────────────────────────────────────────────────────────────────
// assetrage.net / tiestep.top (dlhd Players 1+2 on 2026-09-15) put no URL in the page at all, only
//   window._econfig = '<~150 KB of base64>'
// which the provider's own /assets/stream.js turns into a JSON config { stream_url, stream_url_nop2p, p2p, … }:
// base64-decode it, cut the text into N equal chunks, drop the junk character at index K of each, base64-decode
// each chunk, put the pieces back in a fixed ORDER and base64-decode the join. stream.js v0.0.26 uses N=4, K=3,
// ORDER=[2,0,3,1] — constants that live in that script, not in the page. Rather than fetch and parse the script,
// the layout is recovered from the payload itself: the reassembled text is base64 of a JSON object, so the piece
// that leads is the one decoding to "{", and only the right (N, K, ORDER) produces text JSON.parse accepts.
// The search is small — N ≤ 6, K ≤ 5, at most 5! orders behind the fixed first piece — and exits on the first hit.
const MIN_CONFIG_BLOB = 1000;
const MAX_SHUFFLE_PARTS = 6;
const MAX_JUNK_INDEX = 5;

function shuffledConfig(html: string, pageUrl: string): string[] {
  const blobs = [...html.matchAll(new RegExp(`(["'])([A-Za-z0-9+/=]{${MIN_CONFIG_BLOB},})\\1`, 'g'))]
    .map((m) => m[2])
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  for (const blob of blobs) {
    const config = recoverShuffledJson(blob);
    if (config !== undefined) {
      const urls = playlistUrlsIn(config, pageUrl);
      if (urls.length) return urls;
    }
  }
  return [];
}

function fromB64(s: string): string {
  return Buffer.from(s, 'base64').toString('latin1');
}

/** The JSON value hidden in `blob` under the chunk-shuffle layout above, or undefined when it isn't one. */
function recoverShuffledJson(blob: string): unknown {
  const text = fromB64(blob);
  if (!/^[A-Za-z0-9+/=]{16}/.test(text)) return undefined; // the first layer must decode to more base64
  for (let n = 2; n <= MAX_SHUFFLE_PARTS; n++) {
    const size = Math.ceil(text.length / n);
    const chunks = Array.from({ length: n }, (_, i) => text.substr(i * size, size));
    for (let k = 0; k <= MAX_JUNK_INDEX; k++) {
      const pieces = chunks.map((c) => fromB64(c.slice(0, k) + c.slice(k + 1)));
      for (let lead = 0; lead < n; lead++) {
        if (!fromB64(pieces[lead].slice(0, 4)).startsWith('{')) continue;
        const rest = pieces.filter((_, i) => i !== lead);
        for (const order of permutations(rest)) {
          try {
            return JSON.parse(fromB64([pieces[lead], ...order].join('')));
          } catch {
            /* not this arrangement */
          }
        }
      }
    }
  }
  return undefined;
}

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i++) {
    for (const tail of permutations([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i], ...tail];
  }
}

/** Every .m3u8 URL among a decoded config's string values, in document order. */
function playlistUrlsIn(value: unknown, pageUrl: string, depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === 'string') return value.includes('.m3u8') ? scanM3u8(value, pageUrl) : [];
  if (Array.isArray(value)) return value.flatMap((v) => playlistUrlsIn(v, pageUrl, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap((v) => playlistUrlsIn(v, pageUrl, depth + 1));
  }
  return [];
}

// ── 7. chunkedAtob ────────────────────────────────────────────────────────────────────────────────────
// The URL split across several base64(url) string variables and reassembled through a local decoder:
//   function dq(s){ return atob(s.replace(/-/g,'+').replace(/_/g,'/')) }
//   var k1='aHR0cHM6Ly9…', k2='…', k3='…';   var src = dq(k1)+dq(k2)+dq(k3);
// (the cdnlivetv shape — dlhd Player 5 on the morning of 2026-09-15). No single literal holds the whole URL, so
// neither the base64 nor the plaintext pass can see it. The decoder is the function an atob call sits in — found
// by looking back from each `atob(` (a handful per page) rather than by scanning every assignment on it, which
// is quadratic on a page carrying a 150 KB base64 literal. The parts are the string literals its calls name.
const DECODER_LOOKBACK = 400;

function chunkedAtob(html: string, pageUrl: string): string[] {
  const decoders = new Set<string>();
  for (const a of html.matchAll(/\batob\s*\(/g)) {
    const before = html.slice(Math.max(0, a.index! - DECODER_LOOKBACK), a.index!);
    const heads = [
      ...before.matchAll(/(?:function\s+([\w$]{1,40})\s*\(|([\w$]{1,40})\s*=\s*(?:function\b|\([^)]{0,40}\)\s*=>|[\w$]{1,40}\s*=>))/g),
    ];
    const head = heads[heads.length - 1];
    if (head) decoders.add(head[1] ?? head[2]);
  }
  if (!decoders.size) return [];
  const literals = new Map<string, string>();
  for (const m of html.matchAll(/([\w$]{1,40})\s*=\s*(["'])([A-Za-z0-9+/=_-]{4,})\2/g)) literals.set(m[1], m[3]);

  const out: string[] = [];
  for (const dec of decoders) {
    const call = `${dec.replace(/\$/g, '\\$')}\\(\\s*([\\w$]+)\\s*\\)`;
    for (const m of html.matchAll(new RegExp(`${call}(?:\\s*\\+\\s*${call})+`, 'g'))) {
      const names = [...m[0].matchAll(new RegExp(call, 'g'))].map((x) => x[1]);
      if (!names.every((n) => literals.has(n))) continue;
      const joined = names.map((n) => fromB64(literals.get(n)!.replace(/-/g, '+').replace(/_/g, '/'))).join('');
      out.push(...scanM3u8(joined, pageUrl));
    }
  }
  return out;
}

// ── 8. charArrayJoin ──────────────────────────────────────────────────────────────────────────────────
// The URL spelled out one character at a time and finished off with text read from the DOM:
//   return(["h","t","t","p","s",":","\/","\/", …].join("") + document.getElementById("tk").innerHTML);
// (the igniteandship shape). The array is joined here, and the element text appended when the page names one.
function charArrayJoin(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\]\s*\.join\(\s*(["'])\1\s*\)/g)) {
    const open = html.lastIndexOf('[', m.index!);
    if (open === -1 || m.index! - open > 20_000) continue;
    const items = [...html.slice(open + 1, m.index!).matchAll(/(["'])((?:\\.|(?!\1).)*)\1/g)].map((x) => jsUnescape(x[2]));
    let text = items.join('');
    if (!/^https?:/i.test(text)) continue;
    const tail = html.slice(m.index! + m[0].length, m.index! + m[0].length + 200);
    const el = tail.match(/^\s*\+\s*document\.getElementById\(\s*(["'])([^"']+)\1\s*\)\.(?:innerHTML|innerText|textContent)/);
    if (el) {
      const id = el[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text += html.match(new RegExp(`id=["']${id}["'][^>]*>([^<]*)<`))?.[1]?.trim() ?? '';
    }
    out.push(...scanM3u8(text, pageUrl));
  }
  return out;
}

/** Undo JS string escapes (\/, \xNN, \uNNNN, \"). */
function jsUnescape(s: string): string {
  return s
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(.)/g, '$1');
}

/**
 * The ordered chain, EVERY entry of which runs. Order is rank: decoders that recover a URL the page went out of
 * its way to hide come first; the plaintext scan — the pass most likely to pick up an ad's or a poster's .m3u8 —
 * comes last.
 */
const CHAIN: Array<{ name: string; run: (html: string, pageUrl: string) => string[] }> = [
  { name: 'base64', run: base64 },
  { name: 'shuffledConfig', run: shuffledConfig },
  { name: 'xorEval', run: xorEval },
  { name: 'packed', run: packed },
  { name: 'chunkedAtob', run: chunkedAtob },
  { name: 'charArrayJoin', run: charArrayJoin },
  { name: 'hexEscape', run: hexEscape },
  { name: 'plaintext', run: plaintext },
];

export interface EmbedCandidate {
  /** A candidate master/media playlist URL, absolute. */
  url: string;
  /** Which extractor produced it — surfaced in logs so a provider rotation is diagnosable. */
  extractor: string;
}

/**
 * Pull candidate playlist URLs out of a player-embed page, best-first and deduped (a URL keeps the rank of the
 * first extractor that found it). Empty when no extractor matched — the caller treats that as "this player
 * isn't live / isn't a shape we understand" and moves on.
 */
export function extractMasterUrls(html: string, pageUrl: string): EmbedCandidate[] {
  const out: EmbedCandidate[] = [];
  const seen = new Set<string>();
  for (const { name, run } of CHAIN) {
    let urls: string[];
    try {
      urls = run(html, pageUrl);
    } catch {
      continue; // an extractor must never break the walk
    }
    for (const url of [...new Set(urls)].slice(0, MAX_CANDIDATES)) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, extractor: name });
    }
  }
  return out.slice(0, MAX_TOTAL_CANDIDATES);
}
