// resolveStream.ts — resolve a dlhd channel id into its freshly-minted, signed HLS master URL. Ported
// from ../d-combine/sources/dlhd/resolve-stream.mjs.
//
// dlhd's master URL is minted per request and hidden behind a 2-hop, Referer-gated player chain. The whole
// chain works server-side with fetch + regex; no headless browser is needed.
//
//   id (e.g. 51)
//     ── hop 1 ──►  GET {BASE}/stream/stream-51.php   (Referer: {BASE}/)
//                     server-renders <iframe src="https://<player>/premiumtv/daddy3.php?id=51">
//     ── hop 2 ──►  GET <player>/premiumtv/daddy3.php?id=51   (Referer: {BASE}/   ← 403 without it)
//                     HTML embeds atob("aHR0cHM6Ly...") → https://<cdn>/premium51/index.m3u8?md5v1=…&expires=…
//     ── hop 3 ──►  GET <that master>   (Referer: <player origin>/   ← 403 without it)
//                     #EXTM3U … tracks-v1a1/mono.m3u8?md5=…&expires=…   ← variant + token
//
// The signed token (md5/expires) is minted PER REQUEST and short-lived; re-resolve for a fresh one. If a
// channel isn't live, hop 1/2 won't yield a daddy URL or a base64 master → treated as "not live".
//
// PLAYER SELECTION (Player 1..N): the channel's watch.php page offers several players, each the SAME channel
// under a different hop-1 path prefix (/stream/, /cast/, … — see config.PLAYER_PREFIXES). `opts.player` (a
// 1-based index; 0/undefined = Auto) chooses which to PREFER; on failure the resolver FALLS BACK through the
// remaining players in order (they are redundant embeds of the one feed). Auto / Player 1 keeps the exact
// pre-feature single-path behavior and only enumerates the alternates lazily, if the default page fails.

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

export interface ResolvedStream {
  id: string;
  playerUrl: string;
  masterUrl: string;
  variantUrl: string;
  token: string | null;
  streamInf: string | null;
  master: string;
  playerIndex: number; // which player (1-based) actually served this master
  playerCount: number; // how many players were enumerated (best-effort; the UI can hint the available range)
}

/** Resolve options threaded from the resolve seam (buildGrant). */
export interface ResolveOptions {
  player?: number; // 1-based preferred player; 0/undefined = Auto (lead with Player 1)
}

// The mirror embeds the player as an <iframe> pointing at …/premiumtv/daddy<n>.php?id=N. The numeric
// suffix VARIES per channel — observed live: daddy.php, daddy2.php, daddy3.php — so match any of them.
const PLAYER_RE = /https?:\/\/[^"'\s)]+\/premiumtv\/daddy\d*\.php\?id=\d+/i;

/** Find the player URL in a stream page: the daddy<n>.php embed, or any /premiumtv/ iframe as fallback. */
function findPlayerUrl(html: string): string | null {
  const m = html.match(PLAYER_RE);
  if (m) return m[0];
  // Fallback: any iframe whose src is a /premiumtv/ player with an ?id= — resilient to a script rename.
  for (const im of html.matchAll(/<iframe[^>]*\bsrc=["']([^"']+)["']/gi)) {
    if (/\/premiumtv\//i.test(im[1]) && /[?&]id=\d+/.test(im[1])) return im[1];
  }
  return null;
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

/** From the player-page HTML, find the one base64 blob that decodes to an https://…m3u8 URL. */
function extractMasterFromPlayer(html: string): string | null {
  for (const m of html.matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)) {
    let decoded: string;
    try {
      decoded = Buffer.from(m[0], 'base64').toString('utf8');
    } catch {
      continue;
    }
    if (/^https?:\/\/\S+\.m3u8/i.test(decoded)) return decoded.trim();
  }
  return null;
}

interface PlayerPage {
  url: string; // the hop-1 stream page for this player, on the ACTIVE mirror
  playerIndex: number; // 1-based "Player N"
}

// Enumerate a channel's players. AUTHORITATIVE source: the watch.php page's ordered <button data-url> list
// (matches the site's PLAYER 1..N exactly and self-heals if the site reorders/renames the prefixes). Each
// data-url is normalized onto the ACTIVE mirror host (getBase) so every hop-1 fetch targets the proven-live
// mirror, not whatever host the button happened to name. Falls back to the last-known PLAYER_PREFIXES when
// watch.php can't be parsed (layout change / fetch error) so selection + fallback still work.
async function listPlayerPages(id: string): Promise<PlayerPage[]> {
  try {
    const r = await fetch(`${getBase()}/watch.php?id=${id}`, {
      headers: { Referer: getReferer(), 'User-Agent': UA },
    });
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
  return PLAYER_PREFIXES.map((prefix, i) => ({
    url: `${getBase()}/${prefix}/stream-${id}.php`,
    playerIndex: i + 1,
  }));
}

// Order the candidate players to TRY: the preferred one first (1-based `want`, clamped — out-of-range → lead),
// then every other player in natural order. This is the prefer-then-fallback sequence.
function orderToTry(pages: PlayerPage[], want: number): PlayerPage[] {
  const startIdx = want >= 1 && want <= pages.length ? want - 1 : 0;
  return [pages[startIdx], ...pages.filter((_, i) => i !== startIdx)];
}

// The 3-hop resolve against ONE player's stream page. Throws on any "not live / blocked" condition so the
// caller can fall through to the next player. Seeds the dynamic SSRF allowlist + player-origin Referer for
// the winning player exactly as before.
async function resolveViaStreamPage(
  streamPageUrl: string,
  id: string,
  playerIndex: number,
  playerCount: number,
): Promise<ResolvedStream> {
  // ── hop 1: discover the rotating player URL from the mirror ──────────────────
  const s = await fetch(streamPageUrl, { headers: { Referer: getReferer(), 'User-Agent': UA } });
  if (!s.ok) throw new Error(`stream page fetch failed: HTTP ${s.status} (${streamPageUrl})`);
  const playerUrl = findPlayerUrl(await s.text());
  if (!playerUrl) throw new Error(`No premiumtv player found for channel ${id} — not live or layout changed`);

  // Remember the player origin (CDN/segment hosts — and the master's own /secure/ gate — expect it as
  // Referer) + allow its host. Capture a LOCAL copy of the referer for hop 3 below: setPlayerOrigin
  // writes a shared module global that a concurrent resolve of another channel could overwrite across
  // the awaits, so the resolve fetches use the local value; the global remains for the proxy replay.
  setPlayerOrigin(playerUrl);
  let playerRef: string;
  try {
    const u = new URL(playerUrl);
    playerRef = `${u.origin}/`;
    allowHost(u.hostname);
  } catch {
    playerRef = playerReferer();
  }

  // ── hop 2: pull the base64-embedded signed master from the player page ───────
  const d = await fetch(playerUrl, { headers: { Referer: getReferer(), 'User-Agent': UA } });
  if (!d.ok) throw new Error(`player page fetch failed: HTTP ${d.status} (Referer-gated)`);
  const masterUrl = extractMasterFromPlayer(await d.text());
  if (!masterUrl) throw new Error(`No signed master URL in player page for channel ${id} — not live`);
  try {
    allowHost(new URL(masterUrl).hostname); // CDN host (rotates) → allow proxying it
  } catch {
    /* ignore */
  }

  // ── hop 3: fetch the master to read the variant line + token. The CDN's path-based /secure/ gate
  // requires the (rotating) player origin as Referer — the signed path alone is no longer sufficient
  // (it was, under the old ?md5v1=&expires= scheme). "rejected" (not "…fetch failed") keeps a genuine
  // HTTP 4xx from being misread as an unreachable mirror upstream (see dlhd.ts looksUnreachable). ──
  const m = await fetch(masterUrl, { headers: { Referer: playerRef, 'User-Agent': UA } });
  if (!m.ok) throw new Error(`master playlist rejected: HTTP ${m.status} ${masterUrl}`);
  const master = await m.text();
  if (!master.startsWith('#EXTM3U')) throw new Error(`Master is not an HLS playlist (got: ${master.slice(0, 50)}…)`);

  const lines = master.split(/\r?\n/);
  const variantLine = lines.find((l) => l.trim() && !l.startsWith('#'));
  if (!variantLine) throw new Error('No variant line in master playlist');
  const variantUrl = new URL(variantLine.trim(), masterUrl).href;
  try {
    allowHost(new URL(variantUrl).hostname);
  } catch {
    /* ignore */
  }
  // dlhd signs with md5/expires (nginx secure_link-style); expose md5 as the "token".
  const token = new URL(variantUrl).searchParams.get('md5');
  const streamInf = lines.find((l) => l.startsWith('#EXT-X-STREAM-INF')) ?? null;

  return { id, playerUrl, masterUrl, variantUrl, token, streamInf, master, playerIndex, playerCount };
}

export async function resolveStreamUrl(
  input: string | number,
  opts?: ResolveOptions,
): Promise<ResolvedStream> {
  const id = channelId(input);
  // Effective player = the per-channel override the seam passed (opts.player), else the source-wide default
  // (getPlayerDefault, cached from Settings), else 0 = Auto. Resolved HERE so the generic resolve seam only
  // has to read the per-channel value and stays provider-agnostic.
  const want = opts?.player && opts.player > 0 ? opts.player : getPlayerDefault();

  // Fast path — Auto / Player 1: try the default /stream/ page first (the exact pre-feature single path, NO
  // extra watch.php fetch when it works). Only if it fails do we enumerate the alternates and fall through.
  if (want <= 1) {
    const primaryUrl = `${getBase()}/stream/stream-${id}.php`;
    try {
      return await resolveViaStreamPage(primaryUrl, id, 1, PLAYER_PREFIXES.length);
    } catch (primaryErr) {
      const pages = await listPlayerPages(id);
      // Fall back through every OTHER player (skip the exact page we just tried, matched by URL so ordering
      // quirks can't make us re-try it or skip the wrong one).
      for (const cand of pages.filter((p) => p.url !== primaryUrl)) {
        try {
          return await resolveViaStreamPage(cand.url, id, cand.playerIndex, pages.length);
        } catch {
          /* try the next player */
        }
      }
      throw primaryErr; // no player yielded a live master — surface the original (Player 1) reason
    }
  }

  // Explicit Player k (k ≥ 2): enumerate, prefer k, then fall back through the rest.
  const pages = await listPlayerPages(id);
  const order = orderToTry(pages, want);
  let lastErr: unknown;
  for (const cand of order) {
    try {
      return await resolveViaStreamPage(cand.url, id, cand.playerIndex, pages.length);
    } catch (err) {
      lastErr = err;
    }
  }
  throw (lastErr as Error) ?? new Error(`No live player for channel ${id}`);
}
