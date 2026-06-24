import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared filesystem locations. This module lives at server/src/paths.{ts,js} in dev and
// server/dist/paths.js in prod, so '..' + '<dir>' resolves to server/<dir> (dev) and /app/<dir>
// (the Docker runtime stage) identically — the same computation index.ts uses for the static mounts.
const here = dirname(fileURLToPath(import.meta.url));

/**
 * The SPA static-serve directory: the built Vue assets only (express.static + the SPA catch-all).
 * Populated at image build time (Docker COPY); read-only at runtime.
 */
export const publicDir = resolve(here, '..', 'public');

/**
 * The composed-export directory: the Global + Custom .m3u exports written by m3u/compose.ts
 * (mounted via express.static BEFORE publicDir, with the /_global/ route ahead of both). Decoupled
 * from publicDir so exports never entangle with SPA assets. Ephemeral — created + chowned to `node`
 * in the Dockerfile, regenerated on demand by Compose/cron; wiped on a Docker image rebuild.
 */
export const composeDir = resolve(here, '..', 'compose');
