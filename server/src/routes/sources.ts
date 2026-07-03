// Generic source REST API, ported from ../d-combine/server.mjs into Masqueradarr's Express stack. One router
// serves every source by iterating the registry — adding a source needs zero route changes.
//
//   GET  /api/sources               manifest (drives the SPA; one entry per registered source)
//   GET  /api/sources/:id/status    runtime provenance (dlhd: live mirror; null otherwise)
//   GET  /api/sources/:id/metrics   per-source proxy counters
//   POST /api/sources/:id/sync      live refresh → upsert channels + Playlist sync metadata
//   POST /api/sources/:id/reset     Restore defaults: drop channels + re-sync from upstream
//   POST /api/sources/:id/provision provision a built-in (Default) source playlist on demand
//
// NOTE (video engine teardown): the stream proxy mounts (/api/v1 appPlayer + /api/ext/v1 externalPlayer) and
// their ffmpeg engine / B-Roll slate / ffprobe machinery were REMOVED. No video is served here until a new
// playback engine is rebuilt (the in-app player shell stays but its /api/v1 URLs no longer resolve). This
// router now covers only the catalog manifest, per-source status/metrics, sync/reset, built-in provisioning,
// and dulo auth. Mounted at the app root (app.use(sourcesRouter)) because its paths span /api/sources.

import { Router } from 'express';
import { logger } from '../sources/core/logger.js';
import { SOURCES, getSource } from '../sources/registry.js';
import { DEFAULT_BUILTIN_META } from '../sources/types.js';
import { createMetrics, snapshotOne, type Metrics } from '../sources/core/metrics.js';
import { syncLive, resetSource, ensureShellRow } from '../sources/seed.js';
import { duloAuth } from '../sources/adapters/dulo/auth.js';
import { Playlist } from '../models/Playlist.js';
import { grantPlaylistToAdmins } from '../security/adminAccess.js';

export const sourcesRouter = Router();

// Per-source proxy metrics bag (retained for the /metrics endpoint). The stream proxy that incremented these
// counters was removed in the video-engine teardown, so they read as zero until playback is rebuilt.
const metricsById = new Map<string, Metrics>();
for (const adapter of SOURCES) {
  metricsById.set(adapter.id, createMetrics());
}

// ── Manifest ────────────────────────────────────────────────────────────────
// Synthetic (proxy-only) sources like `direct` are OMITTED — they have no catalog and are not syncable
// playlists; the SPA must not list them as sources.
sourcesRouter.get('/api/sources', (_req, res) => {
  res.json(
    SOURCES.filter((s) => !s.synthetic).map((s) => ({
      id: s.id,
      label: s.label,
      grouping: s.grouping,
      sourceUrl: `/api/channels?source=${s.id}`, // normalized catalog over Mongo
      proxyPrefix: `/api/v1/${s.id}/`, // in-app stream mount path (the byte-serving route is removed pending rebuild)
      statusUrl: s.status ? `/api/sources/${s.id}/status` : null,
      // The Add Playlist "Built-In" summary (inherent, declarative; rendered before provisioning). Falls
      // back to the common-posture default when an adapter omits it.
      builtinMeta: s.builtinMeta ?? DEFAULT_BUILTIN_META,
    })),
  );
});

// ── Per-source runtime status (dlhd mirror provenance; null for sources without one) ──
sourcesRouter.get('/api/sources/:id/status', async (req, res, next) => {
  try {
    const adapter = getSource(req.params.id);
    if (!adapter) return res.status(404).json({ error: 'unknown_source' });
    const status = adapter.status ? await adapter.status() : null;
    res.json(status ?? null);
  } catch (err) {
    next(err);
  }
});

// ── Per-source proxy metrics ──────────────────────────────────────────────────
sourcesRouter.get('/api/sources/:id/metrics', (req, res) => {
  const m = metricsById.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'unknown_source' });
  res.json(snapshotOne(m));
});

// ── Live sync (refresh channels + Playlist sync metadata from upstream) ───────
sourcesRouter.post('/api/sources/:id/sync', async (req, res, next) => {
  try {
    if (!getSource(req.params.id)) return res.status(404).json({ error: 'unknown_source' });
    res.json(await syncLive(req.params.id));
  } catch (err) {
    next(err);
  }
});

// ── Reset (Restore defaults) = drop channels + re-sync from upstream ───────────
sourcesRouter.post('/api/sources/:id/reset', async (req, res, next) => {
  try {
    if (!getSource(req.params.id)) return res.status(404).json({ error: 'unknown_source' });
    res.json(await resetSource(req.params.id));
  } catch (err) {
    next(err);
  }
});

// ── Provision a built-in (Default) source playlist on demand (user-initiated, Add Playlist → "Built-In") ──
// Built-in source playlists are no longer auto-seeded as shell rows on boot (see bootInitSources) — the user
// adds the ones they want here. Registers the zero-channel shell Playlist row (ensureShellRow, idempotent —
// re-adding an already-present built-in is a harmless no-op) WITHOUT syncing: channels still populate on the
// user's first "Sync now" (POST /api/sources/:id/sync). A synthetic (proxy-only) source has no catalog and is
// not a syncable playlist → treated as unknown. Admin-only (the /api/sources adminOnlyRoutes prefix).
sourcesRouter.post('/api/sources/:id/provision', async (req, res, next) => {
  try {
    const adapter = getSource(req.params.id);
    if (!adapter || adapter.synthetic) return res.status(404).json({ error: 'unknown_source' });
    await ensureShellRow(adapter);
    // Auto-grant the just-provisioned built-in to every admin (it hosts Global → allowedPlaylists). Best-
    // effort — a grant hiccup must not fail the provision (admins still pass the role bypass meanwhile).
    await grantPlaylistToAdmins(adapter.id, 'global').catch((err) =>
      logger.warn('users', `grantPlaylistToAdmins after provision (${adapter.id}) failed: ${(err as Error).message}`),
    );
    const doc = await Playlist.findOne({ id: adapter.id }, { _id: 0 }).lean();
    if (!doc) return res.status(500).json({ error: 'provision_failed' });
    res.status(201).json({ ...doc, channels: 0 });
  } catch (err) {
    next(err);
  }
});

// ── dulo Live TV authentication ───────────────────────────────────────────────
// dulo gates Live TV streams behind a Supabase session (no static stream URLs). The SPA captures the
// already signed-in session from dulo.tv and POSTs the tokens here — only tokens are stored, never a
// password (see sources/adapters/dulo/auth.ts). Read auth state via GET /api/sources/dulo/status.
sourcesRouter.post('/api/sources/dulo/auth', async (req, res, next) => {
  try {
    const { accessToken, refreshToken, expiresAt, supabaseUrl, anonKey, deviceFingerprint, deviceId, deviceName } =
      req.body ?? {};
    if (typeof accessToken !== 'string' || !accessToken) {
      return res.status(400).json({ error: 'accessToken (string) required' });
    }
    // Device identity is optional here (the streamed login is the primary capture path); thread it through
    // when a paste payload happens to carry it so playback matches dulo's binding (see auth.ts CapturePayload).
    const status = await duloAuth.signIn({
      accessToken,
      refreshToken,
      expiresAt,
      supabaseUrl,
      anonKey,
      deviceFingerprint,
      deviceId,
      deviceName,
    });
    res.status(201).json(status);
  } catch (err) {
    next(err);
  }
});

sourcesRouter.delete('/api/sources/dulo/auth', async (_req, res, next) => {
  try {
    await duloAuth.signOut();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
