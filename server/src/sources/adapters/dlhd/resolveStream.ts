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

import {
  getBase,
  getReferer,
  UA,
  allowHost,
  setPlayerOrigin,
  playerReferer,
  getPlayerDefault,
  PLAYER_PREFIXES,
} from './config.js';
import { extractMasterUrls } from './embedExtractors.js';
import { preferenceOrder, noteGood, noteBad, burnCurrent } from './playerMemory.js';
import { logMilestone, logTrace } from '../../../logs/tier.js';

// Node's fetch has NO default timeout, so one hanging provider would stall the whole walk (and with it the
// client's establish) indefinitely. Every hop is bounded.
const HOP_TIMEOUT_MS = Number(process.env.DLHD_HOP_TIMEOUT_MS || 8000);
// …and a per-hop bound alone is not enough: six players x three hops x HOP_TIMEOUT would be minutes, long
// past any player's manifest timeout. The whole walk gets a deadline; the LEAD player always gets its full
// try, and the fall-through stops once the budget is spent. Same reasoning as the Rust failover walk's
// reduced budget for later candidates (proxy.rs).
const RESOLVE_BUDGET_MS = Number(process.env.DLHD_RESOLVE_BUDGET_MS || 20_000);

export interface ResolvedStream {
  id: string;
  /** The player-provider embed URL that produced this playlist (hop 2). Its origin is the Referer replayed downstream. */
  playerUrl: string;
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
  constructor(message: string, mirrorUnreachable: boolean) {
    super(message);
    this.name = 'DlhdResolveError';
    this.mirrorUnreachable = mirrorUnreachable;
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

/** Connection-level (not HTTP-level) failure — the mirror/provider could not be reached at all. */
function isTransportError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return true;
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|UND_ERR/i.test(
    String(e?.message ?? ''),
  );
}

/** A bounded GET with the dlhd UA. Every hop in this file goes through here. */
function hop(url: string, referer: string): Promise<Response> {
  return fetch(url, {
    headers: { Referer: referer, 'User-Agent': UA },
    signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
  });
}

function shortErr(err: unknown): string {
  const m = String((err as Error)?.message ?? err);
  return m.length > 160 ? `${m.slice(0, 157)}…` : m;
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
  const out: string[] = [];
  const add = (raw: string): void => {
    if (!raw || /^(about:|data:|javascript:)/i.test(raw)) return;
    let abs: string;
    try {
      abs = new URL(raw, pageUrl).href;
    } catch {
      return;
    }
    if (!/^https?:$/i.test(new URL(abs).protocol)) return;
    if (NON_PLAYER_RE.test(abs)) return;
    if (!out.includes(abs)) out.push(abs);
  };

  const premium = html.match(PREMIUMTV_RE);
  if (premium) add(premium[0]);
  for (const m of html.matchAll(/<iframe[^>]*\bsrc=["']([^"']+)["']/gi)) add(m[1]);
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
// watch.php can't be parsed (layout change / fetch error) so selection + fallback still work.
async function listPlayerPages(id: string): Promise<PlayerPage[]> {
  try {
    const r = await hop(`${getBase()}/watch.php?id=${id}`, getReferer());
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
        return paths.map((p, i) => ({ url: `${getBase()}${p}`, playerIndex: i + 1 }));
      }
    }
  } catch {
    /* fall through to the last-known prefixes */
  }
  return PLAYER_PREFIXES.map((_, i) => staticPage(id, i + 1));
}

/** Raised by hop 1 so the caller can tell "the mirror is unreachable" from "this provider is dead". */
class MirrorHopError extends Error {}

/**
 * The full resolve against ONE player's stream page: hop 1 → every embed it offers → every playlist URL
 * each embed yields → the first one that fetches and validates. Throws so the caller falls through to the
 * next player. Seeds the dynamic SSRF allowlist and the player-origin Referer for the WINNER only — a
 * losing embed must not poison the module-global Referer the proxy replays.
 */
async function resolveViaStreamPage(
  streamPageUrl: string,
  id: string,
  playerIndex: number,
  playerCount: number,
  deep: boolean,
): Promise<ResolvedStream> {
  // ── hop 1: the mirror's per-player page ─────────────────────────────────────
  let s: Response;
  try {
    s = await hop(streamPageUrl, getReferer());
  } catch (err) {
    throw new MirrorHopError(`stream page unreachable: ${shortErr(err)}`);
  }
  if (!s.ok) throw new Error(`stream page fetch failed: HTTP ${s.status}`);
  const embeds = findEmbedUrls(await s.text(), streamPageUrl);
  if (!embeds.length) throw new Error(`no player embed on the page for channel ${id} — not live or layout changed`);

  const reasons: string[] = [];
  for (const embedUrl of embeds) {
    // ── hop 2: the player provider's embed page ───────────────────────────────
    let d: Response;
    try {
      d = await hop(embedUrl, getReferer());
    } catch (err) {
      reasons.push(`${hostOf(embedUrl)}: ${shortErr(err)}`);
      continue;
    }
    if (!d.ok) {
      reasons.push(`${hostOf(embedUrl)}: embed HTTP ${d.status}`);
      continue;
    }
    const { urls, extractor } = extractMasterUrls(await d.text(), embedUrl);
    if (!urls.length) {
      reasons.push(`${hostOf(embedUrl)}: no playlist URL in the embed`);
      continue;
    }

    // The CDN's /secure/ gate folds the (rotating) player origin into the signature, so hop 3 needs it as
    // Referer. Held LOCALLY here: setPlayerOrigin writes a module global a concurrent resolve of another
    // channel could clobber across awaits, and we only want to commit it for the player that wins.
    let playerRef: string;
    try {
      playerRef = `${new URL(embedUrl).origin}/`;
    } catch {
      playerRef = playerReferer();
    }

    for (const candidate of urls) {
      // ── hop 3: the signed playlist ──────────────────────────────────────────
      let m: Response;
      try {
        m = await hop(candidate, playerRef);
      } catch (err) {
        reasons.push(`${hostOf(candidate)}: ${shortErr(err)}`);
        continue;
      }
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
        if (deep && !(await variantHasMedia(variantUrl, playerRef))) {
          reasons.push(`${hostOf(candidate)}: variant carries no segments`);
          continue;
        }
      }

      // Winner — commit the shared state now that this player is proven.
      setPlayerOrigin(embedUrl);
      try {
        allowHost(new URL(embedUrl).hostname);
      } catch {
        /* ignore */
      }
      for (const u of [candidate, variantUrl]) {
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

      return {
        id,
        playerUrl: embedUrl,
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
    }
  }
  throw new Error(reasons.join('; ') || `no playable embed for channel ${id}`);
}

/** Deep check: does this variant actually list media? Guards "resolves fine but never streams" players. */
async function variantHasMedia(variantUrl: string, referer: string): Promise<boolean> {
  try {
    const r = await hop(variantUrl, referer);
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
  if (strict) {
    // The data plane names the cause when it has one (S3/UND sends `undecodable-video`); anything else is
    // the generic play-time failure. Recorded against the player so the burn list says WHY, not just THAT.
    const why = opts?.advanceReason || 'play-time-failure';
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

  const attempt = async (page: PlayerPage, count: number): Promise<ResolvedStream | null> => {
    attempted += 1;
    try {
      const r = await resolveViaStreamPage(page.url, id, page.playerIndex, count, deep);
      noteGood(id, r.playerIndex);
      logMilestone(
        'dlhd:stream',
        `channel ${id} → Player ${r.playerIndex}/${r.playerCount} via ${hostOf(r.playerUrl)} (${r.extractor}, ${r.shape})`,
      );
      return r;
    } catch (err) {
      if (err instanceof MirrorHopError) mirrorFailures += 1;
      noteBad(id, page.playerIndex);
      failures.push(`P${page.playerIndex}: ${shortErr(err)}`);
      logTrace('dlhd:stream', `channel ${id} Player ${page.playerIndex} failed: ${shortErr(err)}`);
      return null;
    }
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
  }

  // Every attempt failed at hop 1 with a connection error ⇒ it is the MIRROR that is unreachable, not the
  // channel. The adapter re-probes the mirror directory on this signal (and only on it).
  throw new DlhdResolveError(
    `no live player for channel ${id} (${failures.join('; ')})`,
    attempted > 0 && mirrorFailures === attempted,
  );
}
