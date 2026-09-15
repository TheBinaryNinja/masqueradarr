// resolveCache.ts — what the dlhd resolver remembers between resolves, so it stops re-asking the mirror.
//
// Each resolve used to start from nothing: hop 1 against the mirror (a ~630 KB page per player), the watch.php
// player list on any fall-through, and — when every player failed — the whole walk again on the very next
// request. Players and IPTV clients retry a dead channel every few seconds, and a watched channel re-resolves
// every minute (the data plane's target TTL), so the mirror saw a steady stream of its heaviest pages: the
// traffic shape that gets an IP rate-limit blocked. On 2026-09-15 it did — the origin behind every advertised
// mirror started refusing this server's connections outright.
//
//   embeds       stream page URL → the embed URL(s) hop 1 found on it          DLHD_EMBED_CACHE_MS        20 min
//   player list  channel id      → the watch.php PLAYER 1..N paths              DLHD_PLAYER_LIST_CACHE_MS  30 min
//   failures     channel id      → the last failed walk, replayed without network DLHD_FAILURE_CACHE_MS      90 s
//   mirror       the mirror      → "it refused / didn't resolve / said 429", for EVERY channel
//                                                                               DLHD_MIRROR_BREAKER_MS     60 s
//   in flight    one walk per (channel, options) at a time; concurrent callers share its result
//
// Module-level and Mongo-free, the same posture as ./playerMemory.ts: the hot resolve path takes no DB hit, and
// losing all of it on restart costs one cold walk. Every key carries the mirror base (or is a URL on it), so
// changing `daddylive.domain` starts fresh instead of replaying what the old mirror said.

import type { TransportKind } from './transport.js';

const EMBED_TTL_MS = Number(process.env.DLHD_EMBED_CACHE_MS || 1_200_000);
const PLAYER_LIST_TTL_MS = Number(process.env.DLHD_PLAYER_LIST_CACHE_MS || 1_800_000);
const FAILURE_TTL_MS = Number(process.env.DLHD_FAILURE_CACHE_MS || 90_000);
const MIRROR_BREAKER_MS = Number(process.env.DLHD_MIRROR_BREAKER_MS || 60_000);
// Bound every map so a large catalog can't leak; the oldest write is evicted first.
const MAX_ENTRIES = 4096;

interface Stamped<V> {
  value: V;
  at: number;
  until: number;
}

/** A bounded map whose entries lapse. Reads report how old the entry is and how long it has left. */
class TtlMap<V> {
  private readonly entries = new Map<string, Stamped<V>>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  get(key: string): { value: V; ageMs: number; leftMs: number } | null {
    const e = this.entries.get(key);
    if (!e) return null;
    const t = Date.now();
    if (e.until <= t) {
      this.entries.delete(key);
      return null;
    }
    return { value: e.value, ageMs: t - e.at, leftMs: e.until - t };
  }

  set(key: string, value: V): void {
    this.entries.delete(key); // re-insert at the back, so eviction stays oldest-first
    const t = Date.now();
    this.entries.set(key, { value, at: t, until: t + this.ttlMs });
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

// ── hop 1: a player page's embed URLs ────────────────────────────────────────────────────────────────────
// A player page names the same embed for a long time, so after the first resolve a renewal or a failover goes
// straight to hop 2. Keyed by the page URL itself, which already carries the mirror base.
const EMBEDS = new TtlMap<string[]>(EMBED_TTL_MS);

/** The embed URLs hop 1 last found on this player page, and how long ago — or null when unknown/lapsed. */
export function cachedEmbeds(pageUrl: string): { embeds: string[]; ageMs: number } | null {
  const hit = EMBEDS.get(pageUrl);
  return hit ? { embeds: hit.value, ageMs: hit.ageMs } : null;
}

export function rememberEmbeds(pageUrl: string, embeds: string[]): void {
  if (embeds.length) EMBEDS.set(pageUrl, [...embeds]);
}

export function forgetEmbeds(pageUrl: string): void {
  EMBEDS.delete(pageUrl);
}

// ── the watch.php player list ────────────────────────────────────────────────────────────────────────────
// Paths only ("/plus/stream-925.php"): the caller re-prefixes the active base at read time.
const PLAYER_PATHS = new TtlMap<string[]>(PLAYER_LIST_TTL_MS);

export function cachedPlayerPaths(base: string, id: string): string[] | null {
  return PLAYER_PATHS.get(`${base}|${id}`)?.value ?? null;
}

export function rememberPlayerPaths(base: string, id: string, paths: string[]): void {
  if (paths.length) PLAYER_PATHS.set(`${base}|${id}`, [...paths]);
}

// ── failed walks ─────────────────────────────────────────────────────────────────────────────────────────
// Only walks that REACHED the mirror and found no working player land here; a mirror that could not be reached
// is the breaker's business (below), because that says nothing about this channel. Keyed per channel, with the
// player preference the walk ran under — an operator who picks a different player gets a fresh walk at once.
const FAILURES = new TtlMap<{ want: number; message: string }>(FAILURE_TTL_MS);

export interface RecentFailure {
  message: string;
  ageMs: number;
  leftMs: number;
}

export function recentFailure(base: string, id: string, want: number): RecentFailure | null {
  const hit = FAILURES.get(`${base}|${id}`);
  if (!hit || hit.value.want !== want) return null;
  return { message: hit.value.message, ageMs: hit.ageMs, leftMs: hit.leftMs };
}

export function rememberFailure(base: string, id: string, want: number, message: string): void {
  FAILURES.set(`${base}|${id}`, { want, message });
}

export function clearFailure(base: string, id: string): void {
  FAILURES.delete(`${base}|${id}`);
}

// ── the mirror breaker ───────────────────────────────────────────────────────────────────────────────────
// A refused connection, an unresolvable domain or an HTTP 429 on hop 1 is about the MIRROR, and every channel's
// hop 1 goes to the same mirror. While the breaker is open each resolve fails at once with the same diagnosis, so
// a blocked server stops re-knocking on every client retry; when it lapses, the next resolve is the probe.
let mirror: { base: string; kind: TransportKind; detail: string; until: number } | null = null;

export interface MirrorDown {
  kind: TransportKind;
  detail: string;
  leftMs: number;
}

/** The open breaker for this mirror base, or null when it is closed (or was tripped on a different base). */
export function mirrorDown(base: string): MirrorDown | null {
  if (!mirror || mirror.base !== base) return null;
  const left = mirror.until - Date.now();
  if (left <= 0) {
    mirror = null;
    return null;
  }
  return { kind: mirror.kind, detail: mirror.detail, leftMs: left };
}

export function noteMirrorDown(base: string, kind: TransportKind, detail: string): void {
  mirror = { base, kind, detail, until: Date.now() + MIRROR_BREAKER_MS };
}

// ── one walk at a time ───────────────────────────────────────────────────────────────────────────────────
// Three viewers opening the same channel, or a client that retries before the first attempt answered, used to
// mean three full walks. They now share one.
const INFLIGHT = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const running = INFLIGHT.get(key);
  if (running) return running as Promise<T>;
  const p = run().finally(() => INFLIGHT.delete(key));
  INFLIGHT.set(key, p);
  return p;
}

/** Test seam: forget everything. */
export function _resetResolveCache(): void {
  EMBEDS.clear();
  PLAYER_PATHS.clear();
  FAILURES.clear();
  mirror = null;
  INFLIGHT.clear();
}
