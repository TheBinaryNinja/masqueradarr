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
//     ── hop 3 ──►  GET <that master>   (no Referer needed; signed-URL gate)
//                     #EXTM3U … tracks-v1a1/mono.m3u8?md5=…&expires=…   ← variant + token
//
// The signed token (md5/expires) is minted PER REQUEST and short-lived; re-resolve for a fresh one. If a
// channel isn't live, hop 1/2 won't yield a daddy URL or a base64 master → treated as "not live".

import { getBase, getReferer, UA, allowHost, setPlayerOrigin } from './config.js';

export interface ResolvedStream {
  id: string;
  playerUrl: string;
  masterUrl: string;
  variantUrl: string;
  token: string | null;
  streamInf: string | null;
  master: string;
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

export async function resolveStreamUrl(input: string | number): Promise<ResolvedStream> {
  const id = channelId(input);

  // ── hop 1: discover the rotating player URL from the mirror ──────────────────
  const streamPageUrl = `${getBase()}/stream/stream-${id}.php`;
  const s = await fetch(streamPageUrl, { headers: { Referer: getReferer(), 'User-Agent': UA } });
  if (!s.ok) throw new Error(`stream-${id}.php fetch failed: HTTP ${s.status}`);
  const playerUrl = findPlayerUrl(await s.text());
  if (!playerUrl) throw new Error(`No premiumtv player found for channel ${id} — not live or layout changed`);

  // Remember the player origin (CDN/segment hosts expect it as Referer) + allow its host.
  setPlayerOrigin(playerUrl);
  try {
    allowHost(new URL(playerUrl).hostname);
  } catch {
    /* ignore */
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

  // ── hop 3: fetch the master to read the variant line + token (no Referer needed) ──
  const m = await fetch(masterUrl, { headers: { 'User-Agent': UA } });
  if (!m.ok) throw new Error(`master playlist fetch failed: HTTP ${m.status} ${masterUrl}`);
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

  return { id, playerUrl, masterUrl, variantUrl, token, streamInf, master };
}
