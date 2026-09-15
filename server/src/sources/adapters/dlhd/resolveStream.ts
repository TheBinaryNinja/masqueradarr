// resolveStream.ts — resolve a dlhd channel id into a freshly-minted, signed, playable HLS URL.
//
// dlhd's playlist URL is minted per request and hidden behind a Referer-gated player chain. The whole
// chain works server-side with fetch + regex; no headless browser is needed.
//
//   id (e.g. 648)
//     ── hop 1 ──►  GET {BASE}/{prefix}/stream-648.php     (Referer: {BASE}/)
//                     server-renders an <iframe> at the player provider for THIS player button
//     ── hop 2 ──►  GET <that embed>                       (Referer: {BASE}/   ← 403 without it)
//                     the signed playlist URL, however that provider chooses to hide it
//                     (see ./embedExtractors.ts — base64, plaintext, XOR-eval, packed, hex)
//     ── hop 3 ──►  GET <that playlist>                    (Referer: <embed origin>/  ← 403/404 without it)
//                     a master (#EXT-X-STREAM-INF) or a media playlist (#EXTINF) — BOTH are valid
//
// The signature is minted PER REQUEST and short-lived; re-resolve for a fresh one. If a channel isn't live
// on a player, some hop yields nothing and we fall through to the next player.
//
// PLAYER SELECTION (Player 1..N) — the important correction. The "PLAYER 1..6" buttons on watch.php are
// NOT redundant embeds of one feed differing only in the hop-1 path prefix; that was the original (wrong)
// model and it is why "Auto" could never hop. Verified live on ch 648, the six pages embed six DIFFERENT
// providers, and only one of them carried the channel:
//
//   P1 /stream/  → hamis.romponalis.st/premiumtv/daddy4.php   master 404 (not on that CDN)
//   P2 /cast/    → dollardescent.net/e/<slug>                 Cloudflare 403
//   P3 /watch/   → liveon5.zip//sonic/index.php               connection refused
//   P4 /plus/    → logic.icelanders.st/embed/<slug>           ✅ 200, a MEDIA playlist
//   P5 /casting/ → www.ksohls.ru/premiumtv/daddyhd.php        NXDOMAIN
//   P6 /player/  → (same as P5)
//
// So hop 2 must be provider-agnostic (any iframe, any obfuscation) and hop 3 must accept either playlist
// shape. `opts.player` (1-based; 0/undefined = Auto) chooses which player to PREFER; the resolver then
// falls through the rest, remembers the winner and burns the losers (./playerMemory.ts) so the next
// establish leads with the player that actually worked instead of re-walking from Player 1.
//
// MIRROR TRAFFIC. Hop 1 is the mirror's heaviest page and the one thing every resolve of every channel has in
// common, so it is where an IP gets rate-limited. ./resolveCache.ts keeps it to what is needed: hop-1 embed lists
// and the player list are cached, concurrent resolves of a channel share one walk, a failed walk is replayed
// rather than repeated, and a mirror that refused us (or said 429) is left alone for a while by every channel.

import {
  getBase,
  getReferer,
  UA,
  allowHost,
  getPlayerDefault,
  PLAYER_PREFIXES,
} from './config.js';
import { extractMasterUrls, type EmbedCandidate } from './embedExtractors.js';
import { preferenceOrder, noteGood, noteBad, burnCurrent } from './playerMemory.js';
import {
  cachedEmbeds,
  rememberEmbeds,
  forgetEmbeds,
  cachedPlayerPaths,
  rememberPlayerPaths,
  recentFailure,
  rememberFailure,
  clearFailure,
  mirrorDown,
  noteMirrorDown,
  singleFlight,
} from './resolveCache.js';
import { transportKind, transportText, describeTransport, type TransportKind } from './transport.js';
import { logger } from '../../core/logger.js';
import { logMilestone, logTrace } from '../../../logs/tier.js';

// Node's fetch has NO default timeout, so one hanging provider would stall the whole walk (and with it the
// client's establish) indefinitely. Every hop is bounded.
const HOP_TIMEOUT_MS = Number(process.env.DLHD_HOP_TIMEOUT_MS || 8000);
// …and a per-hop bound alone is not enough: six players x three hops x HOP_TIMEOUT would be minutes, long
// past any player's manifest timeout. The whole walk gets a deadline; the LEAD player always gets its full
// try, and the fall-through stops once the budget is spent. Same reasoning as the Rust failover walk's
// reduced budget for later candidates (proxy.rs).
const RESOLVE_BUDGET_MS = Number(process.env.DLHD_RESOLVE_BUDGET_MS || 20_000);
// A cached embed list younger than this is not re-read from hop 1 when it fails: it can't have gone stale yet,
// and re-reading it would double a failing player's mirror cost on every walk.
const EMBED_RECHECK_MS = 120_000;
// Hop-1 failures that are about the MIRROR, not the player: every other player page is on the same host and
// would fail the same way, so the walk stops at the first one instead of knocking five more times.
const MIRROR_STOP: ReadonlySet<TransportKind> = new Set<TransportKind>(['refused', 'dns', 'throttled']);
// Some providers' embed page is only a frame around the real player page. One that yields no candidate but
// frames another page is followed, at most this many levels deep.
const MAX_FRAME_DEPTH = 2;

export interface ResolvedStream {
  id: string;
  /** The player page that produced this playlist (hop 2, or the page it framed). Its origin is the Referer replayed downstream. */
  playerUrl: string;
  /** What the data plane replays on every hop of this stream — streamHeaders(playerUrl). */
  upstreamHeaders: Record<string, string>;
  /** What the data plane fetches. Despite the name it may be a MASTER or a MEDIA playlist — see `shape`. */
  masterUrl: string;
  variantUrl: string;
  token: string | null;
  streamInf: string | null;
  master: string;
  shape: 'master' | 'media';
  /** Which extractor read the URL out of the embed page — surfaced in logs so a provider rotation is diagnosable. */
  extractor: string;
  playerIndex: number; // which player (1-based) actually served this stream
  playerCount: number; // how many players were enumerated (best-effort; the UI hints the available range)
}

/** Resolve options threaded from the resolve seam (buildGrant). */
export interface ResolveOptions {
  /** 1-based preferred player; 0/undefined = Auto (operator default, then the remembered winner). */
  player?: number;
  /**
   * Validate one level deeper before accepting a player: for a MASTER, fetch the chosen variant and
   * require real segments. Set by the live resolve seam only — the scheduled probe sweep leaves it off so
   * its per-channel cost is unchanged.
   */
  deep?: boolean;
  /**
   * "The player you gave me last time just failed." Burns the remembered winner before walking, and walks
   * ONLY players that aren't burnt — so an exhausted channel fails FAST (throwing `DlhdPlayersExhausted`)
   * instead of spending the whole budget re-trying providers we already know are dead.
   */
  advance?: boolean;
  /**
   * WHY the serving player is being retired, when `advance` is set — recorded against the burn so the memo
   * (and the status route reading it) can tell "this provider isn't carrying the channel" apart from "this
   * provider serves video the decoder can't use". The latter is the one that looks healthy in every
   * byte-level metric; see `origin.rs`'s S3/UND detector, which is what sends `undecodable-video`.
   */
  advanceReason?: string;
}

/**
 * Thrown when no player yielded a playable stream. `mirrorUnreachable` is true only when the failures were
 * connection-level against the MIRROR itself (hop 1) — the adapter uses it to decide whether to re-probe
 * the mirror directory. It must not be inferred from the message: the aggregated text now contains
 * third-party providers' connection errors too (a dead `liveon5.zip` says nothing about the mirror).
 */
export class DlhdResolveError extends Error {
  readonly mirrorUnreachable: boolean;
  /** HOW the mirror failed, when `mirrorUnreachable` — the operator advice depends on it (see ./transport.ts). */
  readonly mirrorKind: TransportKind | null;
  /** Answered from ./resolveCache.ts (the breaker or a failed walk) without touching the network. */
  readonly replayed: boolean;
  constructor(message: string, mirrorUnreachable: boolean, mirrorKind: TransportKind | null = null, replayed = false) {
    super(message);
    this.name = 'DlhdResolveError';
    this.mirrorUnreachable = mirrorUnreachable;
    this.mirrorKind = mirrorKind;
    this.replayed = replayed;
  }
}

/**
 * Thrown on an `advance` resolve when every player is already burnt. Distinct from DlhdResolveError so the
 * resolve seam can stop spending failover attempts on players and move straight to the channel's
 * configured failover-group children.
 */
export class DlhdPlayersExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DlhdPlayersExhausted';
  }
}

/** A bounded GET. Every hop in this file goes through here, with headers from one of the builders below. */
function hop(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch(url, { headers, signal: AbortSignal.timeout(HOP_TIMEOUT_MS) });
}

// ── What a browser sends at each hop ─────────────────────────────────────────────────────────────────────
// watch.php frames the player page (same origin), the player page frames the provider's embed (cross-origin),
// and the embed's player fetches the playlist and segments with XHR (cross-origin, CORS). Under the default
// strict-origin-when-cross-origin policy — none of the observed pages sets another — a same-origin request
// carries the full URL as Referer and a cross-origin one only the origin. Matching that, and the fetch-metadata
// that goes with each kind of request, keeps these hops indistinguishable from a viewer's.
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

/** A page navigated to (`document`) or loaded into an <iframe>, from `referer` — already reduced to what the
 * browser sends (see refererFor). */
function pageHeaders(
  referer: string,
  site: 'same-origin' | 'cross-site',
  dest: 'document' | 'iframe',
): Record<string, string> {
  return {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': ACCEPT_LANGUAGE,
    Referer: referer,
    'Sec-Fetch-Dest': dest,
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': site,
    'Upgrade-Insecure-Requests': '1',
  };
}

/**
 * The player's own XHR to the CDN: playlist and segments. Hop 3 sends exactly this, and it is what the resolve
 * hands the data plane to replay (ResolvedStream.upstreamHeaders), so a playlist that validated here is fetched
 * the same way for the rest of the stream.
 */
export function streamHeaders(playerUrl: string): Record<string, string> {
  const origin = new URL(playerUrl).origin;
  return {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': ACCEPT_LANGUAGE,
    Referer: `${origin}/`,
    Origin: origin,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
  };
}

/** The Referer a browser sends from `from` to `to`: the full URL within one origin, only the origin across. */
function refererFor(from: string, to: string): { referer: string; site: 'same-origin' | 'cross-site' } {
  const a = new URL(from);
  return new URL(to).origin === a.origin
    ? { referer: from, site: 'same-origin' }
    : { referer: `${a.origin}/`, site: 'cross-site' };
}

// fetch's own message is always "fetch failed"; transportText appends the code that explains it (ECONNREFUSED …).
function shortErr(err: unknown): string {
  const m = transportText(err);
  return m.length > 160 ? `${m.slice(0, 157)}…` : m;
}

function secs(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// The historical shape: the mirror embeds …/premiumtv/daddy<n>.php?id=N. The numeric suffix VARIES per
// channel (daddy.php, daddy2.php, daddy4.php, daddyhd.php), so match loosely.
const PREMIUMTV_RE = /https?:\/\/[^"'\s)]+\/premiumtv\/[a-z0-9]+\.php\?id=\d+/i;
// Hosts that appear in <iframe>s but are never the player.
const NON_PLAYER_RE = /(doubleclick|googletagmanager|google-analytics|googlesyndication|facebook|disqus)\./i;

/**
 * Candidate player-embed URLs from a hop-1 page, best-first. The `/premiumtv/` embed (when present) leads
 * because it is the cheapest and most common shape; every other iframe follows in DOM order. Requiring
 * `/premiumtv/` — as this did before — made Players 2/3/4 unreachable without a single network request.
 */
function findEmbedUrls(html: string, pageUrl: string): string[] {
  const premium = html.match(PREMIUMTV_RE)?.[0];
  return [...new Set([...(premium ? [premium] : []), ...iframeSrcs(html, pageUrl)])];
}

/**
 * A page's `<iframe src>` URLs, absolute and in DOM order — minus ad/analytics frames, and minus a src that a
 * script assembles at runtime (`'<iframe src="' + window.location.href + '"…'`), which only looks like a URL
 * to a regex.
 */
function iframeSrcs(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<iframe[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const raw = m[1].trim();
    if (!raw || /^(about:|data:|javascript:)/i.test(raw) || /['"+\s]|window\./.test(raw)) continue;
    let abs: URL;
    try {
      abs = new URL(raw, pageUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/i.test(abs.protocol) || NON_PLAYER_RE.test(abs.href)) continue;
    if (!out.includes(abs.href)) out.push(abs.href);
  }
  return out;
}

/** Extract the numeric channel id from a number, "51", a watch.php?id=51, or a stream-51.php URL. */
export function channelId(input: string | number): string {
  if (typeof input === 'number' && Number.isInteger(input)) return String(input);
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/[?&]id=(\d+)/) || s.match(/stream-(\d+)\.php/i);
  if (!m) throw new Error(`Cannot determine channel id from: ${input}`);
  return m[1];
}

/**
 * What shape is this playlist? BOTH are playable — the old code assumed a master and silently treated a
 * media playlist's first segment as if it were a variant. `invalid` covers a non-HLS body AND the
 * well-formed-but-empty manifest (`#EXTM3U` with no variants and no segments), which used to pass as a
 * success all the way to the player.
 */
function classifyPlaylist(text: string): 'master' | 'media' | 'invalid' {
  const t = text.replace(/^﻿/, '').trimStart();
  if (!t.startsWith('#EXTM3U')) return 'invalid';
  if (/^#EXT-X-STREAM-INF/m.test(t) || /^#EXT-X-MEDIA:[^\n]*URI=/m.test(t)) return 'master';
  if (/^#EXTINF/m.test(t)) return 'media';
  return 'invalid';
}

interface PlayerPage {
  url: string; // the hop-1 stream page for this player, on the ACTIVE mirror
  playerIndex: number; // 1-based "Player N"
}

/** The hop-1 URL for a player index, built from the static prefix table (no watch.php fetch needed). */
function staticPage(id: string, playerIndex: number): PlayerPage {
  return { url: `${getBase()}/${PLAYER_PREFIXES[playerIndex - 1]}/stream-${id}.php`, playerIndex };
}

// Enumerate a channel's players. AUTHORITATIVE source: the watch.php page's ordered <button data-url> list
// (matches the site's PLAYER 1..N exactly and self-heals if the site reorders/renames the prefixes). Each
// data-url is normalized onto the ACTIVE mirror host (getBase) so every hop-1 fetch targets the proven-live
// mirror, not whatever host the button happened to name. Falls back to the last-known PLAYER_PREFIXES when
// watch.php can't be parsed (layout change / fetch error) so selection + fallback still work. A parsed list is
// cached per channel (./resolveCache.ts); the static fallback is not, so the next walk tries watch.php again.
async function listPlayerPages(id: string): Promise<PlayerPage[]> {
  const base = getBase();
  const known = cachedPlayerPaths(base, id);
  if (known) return known.map((p, i) => ({ url: `${base}${p}`, playerIndex: i + 1 }));
  try {
    // A viewer reaches watch.php from the channel directory.
    const r = await hop(`${base}/watch.php?id=${id}`, pageHeaders(`${base}/24-7-channels.php`, 'same-origin', 'document'));
    if (r.ok) {
      const html = await r.text();
      const seen = new Set<string>();
      const paths: string[] = [];
      // data-url="https://<host>/<prefix>/stream-<id>.php" → keep the "/<prefix>/stream-<id>.php" path, in order.
      for (const m of html.matchAll(/data-url=["'][^"']*?(\/[a-z]+\/stream-\d+\.php)["']/gi)) {
        const path = m[1].toLowerCase();
        if (!seen.has(path)) {
          seen.add(path);
          paths.push(m[1]);
        }
      }
      if (paths.length) {
        rememberPlayerPaths(base, id, paths);
        return paths.map((p, i) => ({ url: `${base}${p}`, playerIndex: i + 1 }));
      }
    }
  } catch {
    /* fall through to the last-known prefixes */
  }
  return PLAYER_PREFIXES.map((_, i) => staticPage(id, i + 1));
}

/** Raised by hop 1 so the caller can tell "the mirror is unreachable" from "this provider is dead". */
class MirrorHopError extends Error {
  readonly kind: TransportKind;
  constructor(message: string, kind: TransportKind) {
    super(message);
    this.kind = kind;
  }
}

/** Hop 1: the mirror's page for one player → the embed URLs it offers. Remembered (./resolveCache.ts). */
async function fetchEmbeds(streamPageUrl: string, id: string): Promise<string[]> {
  let s: Response;
  try {
    // watch.php frames the player page, same origin — so the Referer is watch.php's full URL.
    s = await hop(streamPageUrl, pageHeaders(`${getBase()}/watch.php?id=${id}`, 'same-origin', 'iframe'));
  } catch (err) {
    throw new MirrorHopError(`stream page unreachable: ${shortErr(err)}`, transportKind(err) ?? 'network');
  }
  if (s.status === 429) throw new MirrorHopError('stream page throttled: HTTP 429', 'throttled');
  if (!s.ok) throw new Error(`stream page fetch failed: HTTP ${s.status}`);
  const embeds = findEmbedUrls(await s.text(), streamPageUrl);
  if (!embeds.length) throw new Error(`no player embed on the page for channel ${id} — not live or layout changed`);
  rememberEmbeds(streamPageUrl, embeds);
  return embeds;
}

/**
 * The full resolve against ONE player's stream page: hop 1 → every embed it offers → every playlist URL
 * each embed yields → the first one that fetches and validates. Throws so the caller falls through to the
 * next player. Seeds the dynamic SSRF allowlist for the WINNER only.
 *
 * Hop 1 comes from the cache when it can. A cached list that never got as far as a playlist fetch may have gone
 * stale — the page now names another embed, or the old embed URL carried a token that lapsed — so it is re-read
 * once and only the embeds it did not already name are tried.
 */
async function resolveViaStreamPage(
  streamPageUrl: string,
  id: string,
  playerIndex: number,
  playerCount: number,
  deep: boolean,
): Promise<ResolvedStream> {
  const hit = cachedEmbeds(streamPageUrl);
  const embeds = hit?.embeds ?? (await fetchEmbeds(streamPageUrl, id));
  const first = await tryEmbeds(streamPageUrl, embeds, id, playerIndex, playerCount, deep);
  if (first.stream) return first.stream;

  if (hit && !first.reachedPlaylist && hit.ageMs >= EMBED_RECHECK_MS) {
    forgetEmbeds(streamPageUrl);
    const unseen = (await fetchEmbeds(streamPageUrl, id)).filter((u) => !embeds.includes(u));
    if (unseen.length) {
      const second = await tryEmbeds(streamPageUrl, unseen, id, playerIndex, playerCount, deep);
      if (second.stream) return second.stream;
      first.reasons.push(...second.reasons);
    }
  }
  throw new Error(first.reasons.join('; ') || `no playable embed for channel ${id}`);
}

interface EmbedsOutcome {
  stream: ResolvedStream | null;
  reasons: string[];
  /** Some candidate got an HTTP answer at hop 3, so the embed itself was sound. */
  reachedPlaylist: boolean;
}

/**
 * Hop 2: an embed page → its candidate playlist URLs. When the page only frames the real player page, that page
 * is read instead (up to MAX_FRAME_DEPTH levels), and IT is the player page — the origin the CDN expects as
 * Referer. Each frame is requested as the browser would from the page framing it (see refererFor). Null when
 * nothing was found; the reason is recorded.
 */
async function readEmbed(
  parentUrl: string,
  embedUrl: string,
  reasons: string[],
): Promise<{ playerUrl: string; candidates: EmbedCandidate[] } | null> {
  let from = parentUrl;
  let url = embedUrl;
  for (let depth = 0; ; depth++) {
    const { referer, site } = refererFor(from, url);
    let d: Response;
    try {
      d = await hop(url, pageHeaders(referer, site, 'iframe'));
    } catch (err) {
      reasons.push(`${hostOf(url)}: ${shortErr(err)}`);
      return null;
    }
    if (!d.ok) {
      reasons.push(`${hostOf(url)}: embed HTTP ${d.status}`);
      return null;
    }
    const html = await d.text();
    const candidates = extractMasterUrls(html, url);
    if (candidates.length) return { playerUrl: url, candidates };
    const next = depth < MAX_FRAME_DEPTH ? iframeSrcs(html, url).find((u) => u !== url) : undefined;
    if (!next) {
      const nested = depth ? ` (${depth} frame${depth > 1 ? 's' : ''} deep)` : '';
      reasons.push(`${hostOf(url)}: no playlist URL in the embed${nested}`);
      return null;
    }
    from = url;
    url = next;
  }
}

/** Hops 2 + 3 over a player page's embeds, in order. Never throws: failures are collected as `reasons`. */
async function tryEmbeds(
  streamPageUrl: string,
  embeds: string[],
  id: string,
  playerIndex: number,
  playerCount: number,
  deep: boolean,
): Promise<EmbedsOutcome> {
  const reasons: string[] = [];
  let reachedPlaylist = false;
  for (const embedUrl of embeds) {
    const page = await readEmbed(streamPageUrl, embedUrl, reasons);
    if (!page) continue;
    const { playerUrl, candidates } = page;

    // Some CDNs' /secure/ gate folds the (rotating) player origin into the signature, so hop 3 goes out as the
    // player's own XHR would — and the same headers ride the resolve to the data plane for the rest of the stream.
    const headers = streamHeaders(playerUrl);

    for (const { url: candidate, extractor } of candidates) {
      // ── hop 3: the signed playlist ──────────────────────────────────────────
      let m: Response;
      try {
        m = await hop(candidate, headers);
      } catch (err) {
        reasons.push(`${hostOf(candidate)}: ${shortErr(err)}`);
        continue;
      }
      reachedPlaylist = true;
      if (!m.ok) {
        // 403 vs 404 is a real signal and worth spelling out: with a valid Referer, 403 means the
        // signature/Referer gate rejected us (a HEADER problem — another player won't help), while 404
        // means the gate PASSED and this CDN simply does not carry the channel (try the next player).
        // "rejected" (not "…fetch failed") also keeps a genuine 4xx from reading as an unreachable mirror.
        const hint = m.status === 404 ? ' (gate passed; channel not on this CDN)' : m.status === 403 ? ' (Referer/signature gate)' : '';
        reasons.push(`${hostOf(candidate)}: playlist rejected: HTTP ${m.status}${hint}`);
        continue;
      }
      const master = await m.text();
      const shape = classifyPlaylist(master);
      if (shape === 'invalid') {
        reasons.push(`${hostOf(candidate)}: not a playable HLS playlist (${master.trim().slice(0, 40)}…)`);
        continue;
      }

      // A master's first non-# line is its variant; a media playlist IS the stream, so it is its own
      // "variant" (the old code took the first segment here and called it a variant).
      const lines = master.split(/\r?\n/);
      let variantUrl = candidate;
      let streamInf: string | null = null;
      if (shape === 'master') {
        const variantLine = lines.find((l) => l.trim() && !l.startsWith('#'));
        if (!variantLine) {
          reasons.push(`${hostOf(candidate)}: master lists no variant`);
          continue;
        }
        variantUrl = new URL(variantLine.trim(), candidate).href;
        streamInf = lines.find((l) => l.startsWith('#EXT-X-STREAM-INF')) ?? null;
        if (deep && !(await variantHasMedia(variantUrl, headers))) {
          reasons.push(`${hostOf(candidate)}: variant carries no segments`);
          continue;
        }
      }

      // Winner — seed the SSRF allowlist now that this player is proven.
      for (const u of [embedUrl, playerUrl, candidate, variantUrl]) {
        try {
          allowHost(new URL(u).hostname);
        } catch {
          /* ignore */
        }
      }
      // dlhd's legacy CDN signs with md5/expires (nginx secure_link-style); newer providers sign in the
      // path, so a null token is normal, not an error.
      let token: string | null = null;
      try {
        token = new URL(variantUrl).searchParams.get('md5');
      } catch {
        /* ignore */
      }

      const stream: ResolvedStream = {
        id,
        playerUrl,
        upstreamHeaders: headers,
        masterUrl: candidate,
        variantUrl,
        token,
        streamInf,
        master,
        shape,
        extractor,
        playerIndex,
        playerCount,
      };
      return { stream, reasons, reachedPlaylist };
    }
  }
  return { stream: null, reasons, reachedPlaylist };
}

/** Deep check: does this variant actually list media? Guards "resolves fine but never streams" players. */
async function variantHasMedia(variantUrl: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const r = await hop(variantUrl, headers);
    if (!r.ok) return false;
    return /^#EXTINF/m.test(await r.text());
  } catch {
    return false;
  }
}

export async function resolveStreamUrl(
  input: string | number,
  opts?: ResolveOptions,
): Promise<ResolvedStream> {
  const id = channelId(input);
  // Effective preference = the per-channel override the seam passed (opts.player), else the source-wide
  // default (getPlayerDefault, cached from Settings), else 0 = Auto. Resolved HERE so the generic resolve
  // seam only has to read the per-channel value and stays provider-agnostic.
  const want = opts?.player && opts.player > 0 ? opts.player : getPlayerDefault();
  const deep = opts?.deep === true;
  // A play-time failover attempt: retire the player that was serving, then walk ONLY the players we have
  // no evidence against. Every other resolve is non-strict, so it can still fall back onto a burnt player
  // rather than leave the channel with nothing to try.
  const strict = opts?.advance === true;
  const base = getBase();

  // Answered from memory, without touching the mirror (./resolveCache.ts):
  //  · the breaker — the mirror refused us, didn't resolve, or said 429 moments ago. True for every channel.
  //  · a failed walk of THIS channel, under the same player preference, moments ago. Never for an advance: that
  //    walk skips every burnt player, so it is already cheap after a failed walk — and it must still reach
  //    whatever players the failed walk's budget left untried.
  const down = mirrorDown(base);
  if (down) {
    throw new DlhdResolveError(
      `no live player for channel ${id}: the mirror failed moments ago (${down.detail}) — not asking it again for ${secs(down.leftMs)}s`,
      true,
      down.kind,
      true,
    );
  }
  if (!strict) {
    const failed = recentFailure(base, id, want);
    if (failed) {
      throw new DlhdResolveError(
        `${failed.message} — from a walk ${secs(failed.ageMs)}s ago; next live try in ${secs(failed.leftMs)}s`,
        false,
        null,
        true,
      );
    }
  }
  // Concurrent resolves of the same channel under the same options share one walk.
  const key = `${base}|${id}|${want}|${deep ? 'deep' : 'shallow'}|${strict ? 'advance' : 'normal'}`;
  return singleFlight(key, () => walkPlayers(base, id, want, deep, strict, opts?.advanceReason));
}

/** The player walk behind resolveStreamUrl: the lead player, then the rest in preference order. */
async function walkPlayers(
  base: string,
  id: string,
  want: number,
  deep: boolean,
  strict: boolean,
  advanceReason: string | undefined,
): Promise<ResolvedStream> {
  if (strict) {
    // The data plane names the cause when it has one (S3/UND sends `undecodable-video`); anything else is
    // the generic play-time failure. Recorded against the player so the burn list says WHY, not just THAT.
    const why = advanceReason || 'play-time-failure';
    const burned = burnCurrent(id, why);
    logMilestone(
      'dlhd:stream',
      `channel ${id}: retiring ${burned === null ? 'the current player' : `Player ${burned}`} (${why}) and walking the alternates`,
    );
  }
  const failures: string[] = [];
  const deadline = Date.now() + RESOLVE_BUDGET_MS;
  let attempted = 0;
  let mirrorFailures = 0;
  let mirrorKind: TransportKind | null = null;

  const attempt = async (page: PlayerPage, count: number): Promise<ResolvedStream | null> => {
    attempted += 1;
    try {
      const r = await resolveViaStreamPage(page.url, id, page.playerIndex, count, deep);
      noteGood(id, r.playerIndex);
      clearFailure(base, id);
      logMilestone(
        'dlhd:stream',
        `channel ${id} → Player ${r.playerIndex}/${r.playerCount} via ${hostOf(r.playerUrl)} (${r.extractor}, ${r.shape})`,
      );
      return r;
    } catch (err) {
      if (err instanceof MirrorHopError) {
        // The MIRROR failed, not this player. Burning the player would leave a good provider at the back of
        // the order for BURN_MS after the mirror comes back.
        mirrorFailures += 1;
        mirrorKind = err.kind;
      } else {
        noteBad(id, page.playerIndex);
      }
      failures.push(`P${page.playerIndex}: ${shortErr(err)}`);
      logTrace('dlhd:stream', `channel ${id} Player ${page.playerIndex} failed: ${shortErr(err)}`);
      return null;
    }
  };

  // The mirror is out of reach: open the breaker so EVERY channel stops knocking for a while, and fail this
  // walk. Read through a function because `attempt` assigns mirrorKind from inside a closure.
  const lastMirrorKind = (): TransportKind | null => mirrorKind;
  const tripBreaker = (kind: TransportKind): never => {
    const detail = failures.join('; ');
    noteMirrorDown(base, kind, detail);
    logger.warn('dlhd', `${describeTransport(kind, hostOf(base))} — pausing dlhd resolves (${detail})`);
    throw new DlhdResolveError(`no live player for channel ${id} (${detail})`, true, kind);
  };
  // A refusal, an unresolvable name or a 429 is true of EVERY page on the mirror: stop at the first one.
  const stopIfMirrorSaidNo = (): void => {
    const kind = lastMirrorKind();
    if (kind !== null && MIRROR_STOP.has(kind)) tripBreaker(kind);
  };

  // FAST PATH — one page, no watch.php fetch. The lead is the operator's pick, else the remembered winner,
  // else Player 1; the static prefix table gives its URL without enumerating. This keeps the common case at
  // exactly one hop-1 fetch, including after the memory has learned a non-default winner.
  const lead = preferenceOrder(id, want, PLAYER_PREFIXES.length, strict)[0];
  if (lead === undefined) {
    throw new DlhdPlayersExhausted(`every player for channel ${id} is burnt — no alternate upstream left`);
  }
  const leadPage = staticPage(id, lead);
  const first = await attempt(leadPage, PLAYER_PREFIXES.length);
  if (first) return first;
  stopIfMirrorSaidNo();

  // FALL-THROUGH — enumerate the live button list (authoritative order, self-healing on a site rename) and
  // walk the remaining players in preference order.
  const pages = await listPlayerPages(id);
  const byIndex = new Map(pages.map((p) => [p.playerIndex, p]));
  for (const idx of preferenceOrder(id, want, pages.length, strict)) {
    const cand = byIndex.get(idx);
    if (!cand || cand.url === leadPage.url) continue; // matched by URL so ordering quirks can't re-try it
    if (Date.now() > deadline) {
      failures.push(`walk budget ${RESOLVE_BUDGET_MS}ms spent — stopped before P${idx}`);
      logTrace('dlhd:stream', `channel ${id}: resolve budget spent, ${failures.length} player(s) tried`);
      break;
    }
    const r = await attempt(cand, pages.length);
    if (r) return r;
    stopIfMirrorSaidNo();
  }

  // Every attempt failed at hop 1 with a connection error ⇒ it is the MIRROR that is unreachable, not the
  // channel (timeouts and resets land here; refusals, DNS and 429 stopped the walk above).
  const kind = lastMirrorKind();
  if (attempted > 0 && mirrorFailures === attempted && kind !== null) tripBreaker(kind);

  // The mirror answered and no player worked: replay this for a while rather than re-walk on every retry.
  const message = `no live player for channel ${id} (${failures.join('; ')})`;
  if (!strict) rememberFailure(base, id, want, message);
  throw new DlhdResolveError(message, false);
}
