// The log persistence + transport layer — the analogue of stats/statsHub.ts. It MAY import the Log model;
// the source-agnostic core logger may not. It registers the category resolver + the DB sink into the core
// logger, batches inserts (so a busy boot doesn't thrash Mongo), survives a Mongo outage via a capped
// ring buffer (drop-oldest, never OOM), and fans every line out live to /api/logs-stream subscribers.
//
// Recursion guard: this module's OWN diagnostics use raw `console`, never logger.* — a logger.* call here
// would loop back through the sink. See .claude/skills/logs/SKILL.md §6 + §8.

import { WebSocket } from 'ws';
import { setLogSink, setCategoryResolver, type LogSink } from '../sources/core/logger.js';
import { categoryForTag } from './categories.js';
import { Log, type LogDoc, type LogLevel, type LogCategory } from '../models/Log.js';

const FLUSH_MS = 1000; // batch-flush cadence
const HIGH_WATER = 50; // flush early once the buffer crosses this
const BUFFER_MAX = 5000; // ring-buffer cap — drop oldest so a Mongo outage can't OOM the process

const buffer: LogDoc[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

// ── The injected sink: enqueue for batched persistence + fan out live ─────────────────────────────────────
// `category`/`level` are already resolved/narrowed by the core (the sink only ever sees the 3 persisted
// levels). Never throws back into the caller; never calls logger.* (recursion guard).
const enqueue: LogSink = (level, category, tag, message, meta) => {
  const entry: LogDoc = {
    ts: Date.now(),
    createdAt: new Date(), // TTL anchor — written together with ts (never read by the app)
    category: category as LogCategory,
    level: level as LogLevel,
    tag,
    message,
    meta: meta ?? null,
  };
  buffer.push(entry);
  if (buffer.length > BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX); // drop oldest
  broadcast(entry);
  if (buffer.length >= HIGH_WATER) void flush();
};

async function flush(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer.splice(0, buffer.length);
  try {
    await Log.insertMany(batch, { ordered: false });
  } catch (err) {
    // Best-effort — drop the batch and keep serving. Raw console (never logger.*) is the recursion guard.
    console.error('[logstore] flush failed (dropping batch):', (err as Error).message);
  } finally {
    flushing = false;
  }
}

/** Register the resolver + DB sink and start the batch-flush loop. Idempotent; non-fatal (wrapped in index.ts). */
export function startLogStore(): void {
  if (timer) return;
  setCategoryResolver(categoryForTag);
  setLogSink(enqueue);
  timer = setInterval(() => void flush(), FLUSH_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Detach the sink, stop the loop, and drain the final batch (called from shutdown(), before disconnect()). */
export async function stopLogStore(): Promise<void> {
  setLogSink(null);
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await flush();
}

// ── WebSocket fan-out (the /api/logs-stream live tail) ────────────────────────────────────────────────────

const sockets = new Set<WebSocket>();

function send(ws: WebSocket, text: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(text);
    } catch {
      /* a broken socket is cleaned up on its own close/error */
    }
  }
}

// Stream each line as the LogDoc shape MINUS the TTL-only createdAt (the SPA never reads it).
function broadcast(entry: LogDoc): void {
  if (sockets.size === 0) return;
  const log = {
    ts: entry.ts,
    category: entry.category,
    level: entry.level,
    tag: entry.tag,
    message: entry.message,
    meta: entry.meta ?? null,
  };
  const text = JSON.stringify({ type: 'log', log });
  for (const ws of sockets) send(ws, text);
}

/** Wire a freshly-upgraded WebSocket into the log fan-out (called from index.ts's upgrade handler). */
export function attachLogs(ws: WebSocket): void {
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
  ws.on('error', () => {
    sockets.delete(ws);
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
}

/** Close every log socket (graceful shutdown). */
export function closeAllLogs(): void {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  sockets.clear();
}
