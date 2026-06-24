// Tiny tagged logger matching the existing console style ("[mongo] connected", "[api] …").
// Ported from d-combine/lib/core/logger.mjs, trimmed to what the core uses.
//
// This module lives in the source-agnostic core and MUST NOT import a model (the DB-free rule). It only
// console-prints `[tag] msg` and forwards each line to an OPTIONAL injected sink. Persistence + transport
// live in server/src/logs/ and are injected at boot via setLogSink / setCategoryResolver. The console output
// and the `[tag] msg` format are byte-for-byte unchanged; `ok` collapses to `info` ONLY on the persisted
// level (it still console-prints via console.info). See .claude/skills/logs/SKILL.md §5.

type Level = 'info' | 'warn' | 'error' | 'ok';

// Per-call overrides: an explicit category (wins over the resolver) and/or structured meta context.
export interface LogOpts {
  category?: string;
  meta?: Record<string, unknown> | null;
}

// The injected persistence/transport sink. `category` is ALREADY resolved by the time the sink sees it —
// the core stays category-agnostic. Receives only the three persisted levels (never 'ok').
export interface LogSink {
  (
    level: 'info' | 'warn' | 'error',
    category: string,
    tag: string,
    message: string,
    meta?: Record<string, unknown> | null,
  ): void;
}

let sink: LogSink | null = null;
export function setLogSink(s: LogSink | null): void {
  sink = s;
}

// Resolves a tag → category for the sink. Injected by the logs subsystem at boot (categoryForTag); the
// core's default keeps it decoupled from product categories.
let resolveCategory: (tag: string) => string = () => 'core';
export function setCategoryResolver(fn: (tag: string) => string): void {
  resolveCategory = fn;
}

function emit(level: Level, tag: string, msg: string, opts?: LogOpts): void {
  const line = `[${tag}] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);

  if (sink) {
    const persistLevel = level === 'ok' ? 'info' : level;
    try {
      sink(persistLevel, opts?.category ?? resolveCategory(tag), tag, msg, opts?.meta ?? null);
    } catch {
      /* swallow — logging must never break the caller (and the sink must never re-enter logger.*) */
    }
  }
}

export const logger = {
  info: (tag: string, msg: string, opts?: LogOpts) => emit('info', tag, msg, opts),
  warn: (tag: string, msg: string, opts?: LogOpts) => emit('warn', tag, msg, opts),
  error: (tag: string, msg: string, opts?: LogOpts) => emit('error', tag, msg, opts),
  ok: (tag: string, msg: string, opts?: LogOpts) => emit('ok', tag, msg, opts),
};
