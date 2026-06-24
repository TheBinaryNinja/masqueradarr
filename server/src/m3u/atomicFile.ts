// Shared compose filesystem primitives — the per-path write serialization, atomic overwrite, and
// prune-with-empty-dir-cleanup that BOTH the M3U export (m3u/compose.ts) and the XMLTV guide export
// (epg/composeGuide.ts) use. Kept here (one implementation) so the two compose pipelines can't drift in
// their on-disk write semantics. DB-free; the only dependency is composeDir (the prune climb boundary).

import { mkdir, writeFile, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import { composeDir } from '../paths.js';

// Per-path write serialization: chain operations on the same file so two near-simultaneous composes
// (e.g. a manual click racing a cron tick) can't interleave. Bounded by the number of distinct paths.
const writeChains = new Map<string, Promise<unknown>>();
export function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(path) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run regardless of the prior op's outcome
  writeChains.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

let tmpSeq = 0;
// Atomic overwrite: write a temp file in the SAME directory then rename over the target, so a concurrent
// reader never sees a half-written file. The temp MUST be on the same filesystem for rename to be atomic.
export async function atomicWrite(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${tmpSeq++}`;
  await writeFile(tmp, body, { encoding: 'utf8' });
  await rename(tmp, path);
}

// Binary sibling of atomicWrite: same temp-then-rename atomicity for a Buffer payload (e.g. a gzip backup),
// so a concurrent reader/list never sees a half-written file. Kept separate so the string callers' contract
// (utf8 text) is unchanged.
export async function atomicWriteBytes(path: string, body: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${tmpSeq++}`;
  await writeFile(tmp, body);
  await rename(tmp, path);
}

// Delete a file then remove any parent dirs it leaves empty, climbing up to (never including) composeDir.
// rmdir throws on a non-empty dir → that stops the climb, so a dir still holding another file is preserved.
export async function pruneFile(path: string): Promise<void> {
  await rm(path, { force: true });
  let dir = dirname(path);
  while (dir !== composeDir && dir.startsWith(composeDir + sep)) {
    try {
      await rmdir(dir);
    } catch {
      break; // ENOTEMPTY (or other) → stop climbing
    }
    dir = dirname(dir);
  }
}
