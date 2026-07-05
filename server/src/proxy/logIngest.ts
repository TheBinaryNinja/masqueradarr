import { ingestExternalLog } from '../logs/logStore.js';
import type { LogLevel } from '../models/Log.js';

// LOG INGEST — the Node half of the Rust proxy-engine log seam. The sidecar (proxy/src/log.rs) gates its
// own verbosity against the live global logLevel and ships the lines it keeps as a batched
// `{ events: [ { ts, level, tag, rid, msg, meta } ] }` POST to /api/internal/log (routes/internal.ts). This
// module validates each event and forwards it to logStore.ingestExternalLog, which resolves the category
// (the engine tags proxy/stream/tsmux/edge/probe/resolve → the `proxy` category) and persists + fans it out
// on /api/logs-stream — so the Rust engine's full resolve→fetch→repackage→serve lineage shows in the same
// View logs drawer as everything else. Best-effort + fire-and-forget from Rust's side; a hiccup here must
// never affect streaming. See .claude/skills/logs/SKILL.md (the Rust log seam section).
//
// Event fields:
//  · ts    — epoch ms stamped in Rust (SystemTime); Node falls back to now() if absent/invalid.
//  · level — one of info | warn | error (Rust's trace tier already collapsed to info before shipping).
//  · tag   — the engine tag (proxy | stream | tsmux | edge | probe | resolve) → the `proxy` category.
//  · rid   — the per-viewing-session lineage id (also embedded in `msg`); carried through in `meta.rid`.
//  · msg   — the human line; already prefixed with `[rid]` in Rust for grep-ability.
//  · meta  — optional structured context (source, entryHost, status, bytes, streamId, …).

const LEVELS = new Set<LogLevel>(['info', 'warn', 'error']);

interface RustLogEvent {
  ts?: unknown;
  level?: unknown;
  tag?: unknown;
  rid?: unknown;
  msg?: unknown;
  meta?: unknown;
}

function applyLog(e: RustLogEvent): void {
  if (!e || typeof e !== 'object') return;
  const level = typeof e.level === 'string' && LEVELS.has(e.level as LogLevel) ? (e.level as LogLevel) : 'info';
  const tag = typeof e.tag === 'string' && e.tag ? e.tag : 'proxy';
  const msg = typeof e.msg === 'string' ? e.msg : '';
  if (!msg) return; // nothing to record
  const ts = typeof e.ts === 'number' && e.ts > 0 ? e.ts : undefined;
  // Merge the lineage id into meta (also present inline in the message) so structured consumers can group by it.
  const baseMeta = e.meta && typeof e.meta === 'object' && !Array.isArray(e.meta)
    ? (e.meta as Record<string, unknown>)
    : null;
  const rid = typeof e.rid === 'string' && e.rid ? e.rid : undefined;
  const meta = rid ? { rid, ...(baseMeta ?? {}) } : baseMeta;
  ingestExternalLog(level, tag, msg, meta, ts);
}

// Accept a single event or a { events: [...] } batch (Rust always batches; both shapes are tolerated).
export function ingestProxyLog(body: unknown): void {
  if (!body || typeof body !== 'object') return;
  const b = body as { events?: unknown };
  if (Array.isArray(b.events)) {
    for (const e of b.events) applyLog(e as RustLogEvent);
  } else {
    applyLog(body as RustLogEvent);
  }
}
