// playerMemory.ts — per-channel memory of which DaddyLive player actually works.
//
// DaddyLive's "PLAYER 1..6" are six INDEPENDENT embed providers (see ./embedExtractors.ts), and which of
// them carries a given channel changes without notice — ch 648 resolves only on Player 4 while its
// neighbours 640/645/649/650 all resolve on Player 1. Without memory the resolver is amnesiac in both
// directions:
//
//   · it re-walks 1 → 4 on EVERY establish (each hop-1 page is ~630 KB, plus DNS failures on the dead
//     providers), and
//   · a re-resolve after a play-time failure re-picks the player that just died, because the preference
//     is a pure function of (playerPref, dlhdPlayer) — which is exactly why "Auto" looked like it wasn't
//     hopping at all.
//
// So: remember the winner (STICKY) and remember the losers (BURNT), both with short TTLs. Module-level and
// Mongo-free, the same posture as config.ts's `_base` / `_playerDefault` caches — the hot resolve path must
// not take a DB hit. Losing this on restart is harmless: the first walk simply re-learns it.

// How long a winning player stays the preferred lead for its channel.
const STICKY_MS = Number(process.env.DLHD_PLAYER_STICKY_MS || 1_800_000); // 30 min
// How long a failed player is skipped. Short: providers come back, and a burn must never strand a channel.
const BURN_MS = Number(process.env.DLHD_PLAYER_BURN_MS || 300_000); // 5 min
// Bound the map so a large catalog can't leak. Swept lazily on write, oldest-touched first.
const MAX_ENTRIES = 4096;

interface PlayerMemo {
  /** 1-based index of the player that last resolved AND validated. */
  lastGood: number | null;
  lastGoodAt: number;
  /** playerIndex → epoch ms at which the burn lapses. */
  burnt: Map<number, number>;
  /** How many failover `attempt`s this channel has already spent walking players (see resolveSeam). */
  consumed: number;
  touchedAt: number;
}

const MEMO = new Map<string, PlayerMemo>();

function now(): number {
  return Date.now();
}

function entry(channelId: string): PlayerMemo {
  let m = MEMO.get(channelId);
  if (!m) {
    m = { lastGood: null, lastGoodAt: 0, burnt: new Map(), consumed: 0, touchedAt: now() };
    MEMO.set(channelId, m);
    sweep();
  }
  m.touchedAt = now();
  return m;
}

/** Drop the least-recently-touched entries once the map outgrows its bound. */
function sweep(): void {
  if (MEMO.size <= MAX_ENTRIES) return;
  const byAge = [...MEMO.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  for (const [k] of byAge.slice(0, MEMO.size - MAX_ENTRIES)) MEMO.delete(k);
}

/** The remembered winner for this channel, or null when unset/stale. */
export function preferredPlayer(channelId: string): number | null {
  const m = MEMO.get(channelId);
  if (!m || m.lastGood === null) return null;
  if (now() - m.lastGoodAt > STICKY_MS) return null;
  m.touchedAt = now();
  return m.lastGood;
}

/** Is this player currently burnt (recently failed) for this channel? */
export function isBurnt(channelId: string, playerIndex: number): boolean {
  const m = MEMO.get(channelId);
  const until = m?.burnt.get(playerIndex);
  if (until === undefined) return false;
  if (until <= now()) {
    m!.burnt.delete(playerIndex);
    return false;
  }
  return true;
}

/** Record a player that resolved AND validated. Clears its burn and resets the failover player cursor. */
export function noteGood(channelId: string, playerIndex: number): void {
  const m = entry(channelId);
  m.lastGood = playerIndex;
  m.lastGoodAt = now();
  m.burnt.delete(playerIndex);
  m.consumed = 0;
}

/** Record a player that failed to produce a playable stream. */
export function noteBad(channelId: string, playerIndex: number): void {
  const m = entry(channelId);
  m.burnt.set(playerIndex, now() + BURN_MS);
  if (m.lastGood === playerIndex) m.lastGood = null;
}

/**
 * Burn whatever is currently serving this channel — called by the resolve seam when the data plane reports
 * a play-time failure (`attempt >= 1`). Returns the burned player index, or null when nothing was pinned
 * (the next resolve then simply walks from the operator's preference).
 */
export function burnCurrent(channelId: string): number | null {
  const cur = preferredPlayer(channelId);
  if (cur === null) return null;
  noteBad(channelId, cur);
  return cur;
}

/** Clear every burn for a channel — used when the walk would otherwise have no candidate left. */
export function clearBurns(channelId: string): void {
  MEMO.get(channelId)?.burnt.clear();
}

/** How many failover attempts this channel has spent on player alternates. */
export function playerAttemptsConsumed(channelId: string): number {
  return MEMO.get(channelId)?.consumed ?? 0;
}

/** Record that one failover attempt went to a player alternate rather than a failover-group child. */
export function notePlayerAttempt(channelId: string): number {
  const m = entry(channelId);
  m.consumed += 1;
  return m.consumed;
}

/** Reset the player cursor so the next walk starts from the operator's preference again. */
export function resetPlayerAttempts(channelId: string): void {
  const m = MEMO.get(channelId);
  if (m) m.consumed = 0;
}

/** Read-only view for the UI / status route: what we currently believe about a channel. */
export interface PlayerMemoView {
  lastGood: number | null;
  lastGoodAgeMs: number | null;
  burnt: number[];
}

export function memoView(channelId: string): PlayerMemoView | null {
  const m = MEMO.get(channelId);
  if (!m) return null;
  const t = now();
  const fresh = m.lastGood !== null && t - m.lastGoodAt <= STICKY_MS;
  return {
    lastGood: fresh ? m.lastGood : null,
    lastGoodAgeMs: fresh ? t - m.lastGoodAt : null,
    burnt: [...m.burnt.entries()].filter(([, until]) => until > t).map(([i]) => i),
  };
}

/**
 * The order in which to TRY players for a channel: the operator's explicit pick (source default or
 * per-channel override) first, then the remembered winner, then natural order. `count` is how many players
 * are known to exist.
 *
 * Burnt players are moved to the very BACK rather than dropped, so an ordinary resolve can never end up
 * with nothing to try. In `strict` mode (a play-time failover attempt) they are dropped instead: the point
 * of that walk is to get OFF the players we already know are dead, and returning an empty list is the
 * "alternates exhausted" signal that lets the data plane move on to the channel's configured backups
 * instead of burning its budget re-probing corpses.
 */
export function preferenceOrder(
  channelId: string,
  want: number,
  count: number,
  strict = false,
): number[] {
  const head: number[] = [];
  if (Number.isInteger(want) && want >= 1 && want <= count) head.push(want);
  const sticky = preferredPlayer(channelId);
  if (sticky !== null && sticky >= 1 && sticky <= count) head.push(sticky);

  const ordered: number[] = [];
  for (const i of [...head, ...Array.from({ length: count }, (_, k) => k + 1)]) {
    if (!ordered.includes(i)) ordered.push(i);
  }
  const live = ordered.filter((i) => !isBurnt(channelId, i));
  if (strict) return live;
  const burnt = ordered.filter((i) => isBurnt(channelId, i));
  return [...live, ...burnt];
}

/** Test seam: drop all memory. */
export function _resetPlayerMemory(): void {
  MEMO.clear();
}
