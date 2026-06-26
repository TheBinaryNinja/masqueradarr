// Generic source REST API, ported from ../d-combine/server.mjs into Masqueradarr's Express stack. One router
// serves every source by iterating the registry — adding a source needs zero route changes.
//
//   GET  /api/sources               manifest (drives the SPA; one entry per registered source)
//   GET  /api/sources/:id/status    runtime provenance (dlhd: live mirror; null otherwise)
//   GET  /api/sources/:id/metrics   per-source proxy counters
//   POST /api/sources/:id/sync      live refresh → upsert channels + Playlist sync metadata
//   POST /api/sources/:id/reset     Restore defaults: drop channels + re-sync from upstream
//   GET  /api/v1/:source/*          single stream proxy; the :source segment binds that source's
//                                   resolve+proxy behavior (createProxyHandler per adapter)
//
// Mounted at the app root (app.use(sourcesRouter)) because its paths span /api/sources, /api/v1, …

import { Router, type Request, type Response, type RequestHandler } from 'express';
import { AuthRequest } from '../middleware/auth.js';
import { logger } from '../sources/core/logger.js';
import { SOURCES, getSource } from '../sources/registry.js';
import { DEFAULT_BUILTIN_META } from '../sources/types.js';
import { createProxyHandler, type ServeEntry } from '../sources/core/proxyHandler.js';
import { createBrollComposer, type CardInfo } from '../sources/core/brollProxy.js';
import {
  externalPlayerEnsureStream,
  externalPlayerKeepAlive,
  isExternalEngineLoopbackUrl,
  type ExternalEngineConfig,
} from '../sources/core/externalEngine.js';
import { ensureTsStream, attachTsClient } from '../sources/core/externalTsEngine.js';
import { getVideoConfigCached, resolvePlaylistConfigId } from '../videoconfig/runtime.js';
import { DEFAULT_FFMPEG_ARGS, DEFAULT_VLC_ARGS, DEFAULT_TS_ARGS, DEFAULT_VLC_TS_ARGS, VIDEO_CONFIG_ID } from '../videoconfig/translate.js';
import { createMetrics, snapshotOne, type Metrics } from '../sources/core/metrics.js';
import { streamKey, phaseFor } from '../sources/core/streamState.js';
import { ensureProbe, probeFor } from '../sources/core/streamProbe.js';
import { noteViewer } from '../sources/core/streamTelemetry.js';
import { syncLive, resetSource, ensureShellRow } from '../sources/seed.js';
import { duloAuth } from '../sources/adapters/dulo/auth.js';
import { Settings, SETTINGS_ID } from '../models/Settings.js';
import { Playlist } from '../models/Playlist.js';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import { StreamSession, type StreamProbe } from '../models/StreamSession.js';
import { grantPlaylistToAdmins } from '../security/adminAccess.js';

export const sourcesRouter = Router();

// Look up the B-Roll card text for a channel entry URL: the operator Display Name (singleton Settings)
// + the channel name (the editable PlaylistChannel store, so a user rename shows on the card). Channel
// names rarely change between polls, so they're cached per entry URL; the Display Name is read each call
// (one tiny singleton doc) so edits show within a poll.
const channelNameCache = new Map<string, string>();
function makeCardLookup(source: string): (entryUrl: string) => Promise<CardInfo> {
  return async (entryUrl) => {
    const settings = await Settings.findOne({ _id: SETTINGS_ID }, { _id: 0, displayName: 1 }).lean();
    const title = settings?.displayName || 'TVApp2';
    let channel = channelNameCache.get(entryUrl);
    if (channel === undefined) {
      const doc = await PlaylistChannel.findOne(
        // Match by the PROXY source (origin ?? source), mirroring src/data.ts proxyPath: imported channels
        // store source=<importId> with origin='direct', so { source:'direct' } alone would never match them.
        { streamEntryUrl: entryUrl, $or: [{ origin: source }, { origin: null, source }] },
        { tvg_name: 1 },
      ).lean();
      channel = doc?.tvg_name || entryUrl.split('/').pop() || entryUrl;
      channelNameCache.set(entryUrl, channel);
    }
    return { title, channel };
  };
}

// Persist a fresh ffprobe result for a channel: upsert the channel's single streamsessions row (1:1 by
// `_id` = PlaylistChannel._id, so it overwrites rather than duplicating) + patch the channel's latest
// snapshot (stream.probe), linked by PlaylistChannel._id (resolved from (source, entryUrl) and cached). The
// probe core (streamProbe.ts) is DB-free; this is the sink it invokes — best-effort, so monitoring
// persistence never disrupts streaming. (Mirrors makeCardLookup's injected-DB-access pattern.)
const channelIdCache = new Map<string, string | null>();
function makePersistProbe(source: string): (entryUrl: string, probe: StreamProbe) => void {
  return (entryUrl, probe) => {
    void (async () => {
      try {
        let channelId = channelIdCache.get(entryUrl);
        if (channelId === undefined) {
          const doc = await PlaylistChannel.findOne(
            // proxy source = origin ?? source (imports store source=<importId>, origin='direct')
            { streamEntryUrl: entryUrl, $or: [{ origin: source }, { origin: null, source }] },
            { _id: 1 },
          ).lean();
          channelId = doc?._id ?? null;
          channelIdCache.set(entryUrl, channelId);
        }
        if (!channelId) return;
        await Promise.all([
          StreamSession.updateOne(
            { _id: channelId },
            {
              $set: {
                channelId,
                capturedAt: Date.now(),
                video: probe.video,
                audio: probe.audio,
                container: probe.container,
              },
            },
            { upsert: true },
          ),
          PlaylistChannel.updateOne({ _id: channelId }, { $set: { 'stream.probe': probe } }),
        ]);
      } catch (err) {
        logger.warn('stream:probe', `persist failed: ${(err as Error).message}`);
      }
    })();
  };
}

// Composer-free external HLS entry resolver — the externalPlayer's loopback-HLS path (it REPLACES the old
// B-Roll composer on /api/ext, the solid separation from the in-app player). For a channel entry it routes the
// adapter-resolved master through the per-channel ffmpeg/VLC engine (videoconfig-driven, per-playlist via
// ctx.configId) and returns the engine's 127.0.0.1 loopback HLS master for the proxy handler's common
// fetch→rewrite→serve path; with the engine OFF it returns the adapter master unchanged (a B-Roll-free DIRECT
// RELAY, so external clients keep working). Side effects on each entry poll: register the viewer (poll-recency
// heartbeat → Active Streams/History) + kick the one-shot ffprobe (technical details). NO slate — a failure
// throws and the proxy handler 502s (the externalPlayer's "truest path", exactly like the raw-TS path). The
// videoconfig read is cached (5s TTL); a config change takes effect on the next channel establish.
function makeExternalHlsEntry(adapter: (typeof SOURCES)[number]): ServeEntry {
  const persist = makePersistProbe(adapter.id);
  return async (entryUrl, ctx) => {
    const cfg = await getVideoConfigCached(ctx.configId);
    const engine = cfg?.enabledEngine;
    // The entry poll is the viewer heartbeat (poll-recency telemetry → Active Streams / History).
    noteViewer(adapter.id, entryUrl, ctx.ip, ctx.ua, ctx.username, 'externalPlayer');
    // Fast path: the engine is on AND already streaming this channel. The running ffmpeg/VLC holds its own
    // upstream connection (segments flow from the CDN), so externalPlayerEnsureStream would just DISCARD a
    // freshly-resolved master. Re-resolving every poll only re-hits the rotating/flapping source mirror and
    // 502s the poll the instant it blips — tearing down an otherwise-healthy stream. So while the engine is
    // warm, skip the resolve entirely and just keep it alive (refresh the idle-sweep heartbeat).
    if (cfg && (engine === 'ffmpeg' || engine === 'vlc')) {
      const warm = externalPlayerKeepAlive(adapter.id, entryUrl, ctx.configId);
      if (warm) return warm;
    }
    // Establish (no live engine yet) or direct-relay (engine off): we need a real upstream master.
    const resolved = await adapter.resolveStream(entryUrl); // the real upstream master (per-source resolve)
    let masterUrl: string;
    if (cfg && (engine === 'ffmpeg' || engine === 'vlc')) {
      // The engine fetches the upstream DIRECTLY (bypassing the proxy), so it needs the adapter's gate headers.
      const headers = adapter.proxy.upstreamHeaders(resolved.masterUrl);
      const ecfg: ExternalEngineConfig = {
        engine,
        args:
          engine === 'vlc'
            ? cfg.vlc?.advancedArgs?.trim() || DEFAULT_VLC_ARGS
            : cfg.ffmpeg?.advancedArgs?.trim() || DEFAULT_FFMPEG_ARGS,
        mode: cfg.mode,
        output: cfg.output,
        // Shared watchdog/thresholds (failTimeoutS gates both engines' stall→failed; stallSpeedThreshold is
        // ffmpeg-only — VLC has no speed signal, its liveness is segment cadence).
        stallSpeedThreshold: cfg.ffmpeg?.options?.stallSpeedThreshold ?? 0.95,
        failTimeoutS: cfg.ffmpeg?.options?.failTimeoutS ?? 15,
        configId: ctx.configId, // folded into the engine proc-map key → per-config process isolation
        // ffmpeg-only: when this resolved per-playlist config has ExtPicky Override on, add `-extension_picky 0`
        // so the HLS demuxer reads disguised-extension segments (e.g. dlhd's .js/.jpg). VLC has no such gate.
        inputArgs: engine === 'ffmpeg' && cfg.extPickyOverride ? ['-extension_picky', '0'] : undefined,
        // ffmpeg-only: when this resolved per-playlist config has Freeze detection on, spawn the decode-only
        // freezedetect tap so frozen pictures register as buffering (VLC has no freezedetect — ignored downstream).
        freezeDetect: !!cfg.freezeDetect,
      };
      ({ masterUrl } = await externalPlayerEnsureStream(adapter.id, entryUrl, resolved.masterUrl, headers, ecfg));
    } else {
      masterUrl = resolved.masterUrl; // engine off → B-Roll-free direct relay (adapter master, mirrored verbatim)
    }
    // One-shot ffprobe of what the client will actually receive (drives the drawer "Technical" block). Keyed by
    // the PLAIN streamKey so GET /api/sources/:id/stream-details reads it back (the engine proc key is config-scoped).
    ensureProbe(streamKey(adapter.id, entryUrl), masterUrl, adapter.proxy.upstreamHeaders(masterUrl), (p) =>
      persist(entryUrl, p),
    );
    return { masterUrl };
  };
}

// Raw-TS passthrough handler (videoconfig.output==='ts', the opt-in for raw-only IPTV clients). Unlike the
// HLS composer path it does NOT rewrite child URIs — a raw-TS client makes ONE request for the channel entry
// and holds the socket while the per-channel shared ffmpeg pipes MPEG-TS through the ring buffer
// (externalTsEngine.ts). The body is served as video/mp2t; the composed M3U URL is format-neutral (never
// claims .m3u8), so the content-type is what tells the client it's TS — satisfying the ExoPlayer guardrail.
function createExternalTsHandler(adapter: (typeof SOURCES)[number], metrics: Metrics): (req: Request, res: Response) => Promise<void> {
  const MARKER = `/v1/${adapter.id}/`;
  const tag = `stream:${adapter.id}:ts`;
  return async (req, res) => {
    const urlPathOnly = req.originalUrl.split('?')[0];
    const idx = urlPathOnly.indexOf(MARKER);
    const rawPath = idx >= 0 ? urlPathOnly.slice(idx + MARKER.length) : '';
    let entryUrl: string;
    try {
      entryUrl = decodeURIComponent(rawPath);
    } catch {
      res.status(400).type('text/plain').send('Bad request: malformed encoded URL');
      return;
    }
    if (!adapter.isEntryUrl(entryUrl)) {
      res.status(400).type('text/plain').send('Bad request: raw-TS path serves channel entries only');
      return;
    }
    const ip = req.ip ?? '';
    const ua = (req.headers['user-agent'] as string | undefined) ?? '';
    const username = (req as AuthRequest).user?.username;
    metrics.requests.total++;
    metrics.requests.master++;
    try {
      const configId = (req as any).videoConfigId ?? VIDEO_CONFIG_ID; // per-playlist videoconfig (route-resolved)
      const cfg = await getVideoConfigCached(configId);
      const resolved = await adapter.resolveStream(entryUrl); // the real upstream master (per-source resolve)
      // ffmpeg fetches the upstream DIRECTLY (bypassing the proxy), so it needs the adapter's gate headers.
      const headers = adapter.proxy.upstreamHeaders(resolved.masterUrl);
      // The operative args must mux TS to STDOUT for the ring buffer. Use the user's advancedArgs only if it
      // already targets stdout (a custom TS string), else the built-in per-engine default — the HLS-oriented
      // advancedArgs write files, not a pipe. ffmpeg ⇒ `-f mpegts pipe:1`; VLC ⇒ `std{...dst=/dev/stdout}`.
      const engine = cfg?.enabledEngine === 'vlc' ? 'vlc' : 'ffmpeg';
      let args: string;
      if (engine === 'vlc') {
        const u = cfg?.vlc?.advancedArgs?.trim() || '';
        args = u.includes('/dev/stdout') || u.includes('dst=-') ? u : DEFAULT_VLC_TS_ARGS;
      } else {
        const u = cfg?.ffmpeg?.advancedArgs?.trim() || '';
        args = u.includes('pipe:1') ? u : DEFAULT_TS_ARGS;
      }
      const ecfg: ExternalEngineConfig = {
        engine,
        args,
        mode: cfg?.mode ?? 'auto',
        output: 'ts',
        stallSpeedThreshold: cfg?.ffmpeg?.options?.stallSpeedThreshold ?? 0.95,
        failTimeoutS: cfg?.ffmpeg?.options?.failTimeoutS ?? 15,
        configId, // folded into the engine proc-map key → per-config process isolation
        // ffmpeg-only: raw-TS dlhd would fail identically without this — ExtPicky Override adds -extension_picky 0.
        inputArgs: engine === 'ffmpeg' && cfg?.extPickyOverride ? ['-extension_picky', '0'] : undefined,
        // ffmpeg-only: same per-playlist Freeze detection as the HLS path — spawn the decode-only freezedetect tap
        // when this resolved config has it on (VLC has no freezedetect — ignored downstream).
        freezeDetect: !!cfg?.freezeDetect,
      };
      const rec = await ensureTsStream(adapter.id, entryUrl, resolved.masterUrl, headers, ecfg);
      res.status(200);
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Cache-Control', 'no-store');
      metrics.active++;
      res.on('close', () => {
        metrics.active--;
      });
      attachTsClient(rec, res, { source: adapter.id, entryUrl, ip, ua, username, playerType: 'externalPlayer' });
    } catch (err) {
      metrics.requests.errors++;
      metrics.lastError = (err as Error).message;
      logger.warn(tag, `raw-TS establish failed: ${(err as Error).message}`);
      if (!res.headersSent) res.status(502).type('text/plain').send(`raw-TS engine failed: ${(err as Error).message}`);
    }
  };
}

// Build per-source handlers once, then dispatch by :source. The two players are SEPARATE execution paths
// (they share only one metrics bag + card lookup + probe sink per source):
//   • in-app /api/v1 (appPlayer): the B-Roll composer (createBrollComposer) — establishing/buffer/failed slate.
//   • external /api/ext/v1 (externalPlayer): composer-free + engine-driven, NO B-Roll. HLS via the loopback
//     engine through makeExternalHlsEntry (serveEntry); raw-TS (videoconfig.output==='ts') via the held-socket
//     ring buffer (createExternalTsHandler). extraAllowed lets the rewritten 127.0.0.1 loopback segment hops
//     past the adapter's SSRF gate.
// The engine is the SOLE streamState writer on the external path when active (there is no external composer to
// race); when the engine is off, /api/ext is a B-Roll-free direct relay.
const metricsById = new Map<string, Metrics>();
const proxyHandlers = new Map<string, RequestHandler>();
const externalHandlers = new Map<string, RequestHandler>();
const externalTsHandlers = new Map<string, (req: Request, res: Response) => Promise<void>>();
for (const adapter of SOURCES) {
  const m = createMetrics();
  metricsById.set(adapter.id, m);
  const composer = createBrollComposer({
    source: adapter.id,
    prefix: `/api/v1/${adapter.id}/`,
    tag: `stream:${adapter.id}`,
    metrics: m,
    resolveStream: (url) => adapter.resolveStream(url),
    upstreamHeaders: adapter.proxy.upstreamHeaders,
    onPlaylistChildHost: adapter.proxy.onPlaylistChildHost,
    cardLookup: makeCardLookup(adapter.id),
    persistProbe: makePersistProbe(adapter.id),
  });
  proxyHandlers.set(adapter.id, createProxyHandler(adapter, m, composer) as RequestHandler);

  // External-client mount (externalPlayer), HLS output: composer-free + engine-driven (no B-Roll). The entry
  // resolver routes through the ffmpeg/VLC engine (loopback HLS) or relays the adapter master when the engine is
  // off; the proxy handler then fetches+rewrites+serves it (and proxies the loopback-allowed segment hops).
  externalHandlers.set(
    adapter.id,
    createProxyHandler(adapter, m, undefined, {
      prefix: `/api/ext/v1/${adapter.id}/`,
      extraAllowed: isExternalEngineLoopbackUrl,
      serveEntry: makeExternalHlsEntry(adapter),
      learnChildHosts: false, // never teach the loopback/relay child hosts to the adapter's shared SSRF allowlist
    }) as RequestHandler,
  );

  // External-client mount, raw-TS output (videoconfig.output==='ts'): also composer-free, no child rewriting —
  // the entry is piped as a held-open MPEG-TS socket via the per-channel ring buffer.
  externalTsHandlers.set(adapter.id, createExternalTsHandler(adapter, m));
}

// ── Manifest ────────────────────────────────────────────────────────────────
// Synthetic (proxy-only) sources like `direct` are OMITTED — they have no catalog and are not syncable
// playlists; the SPA must not list them as sources. Their proxy route still works (handler map below).
sourcesRouter.get('/api/sources', (_req, res) => {
  res.json(
    SOURCES.filter((s) => !s.synthetic).map((s) => ({
      id: s.id,
      label: s.label,
      grouping: s.grouping,
      sourceUrl: `/api/channels?source=${s.id}`, // normalized catalog over Mongo
      proxyPrefix: `/api/v1/${s.id}/`, // appPlayer (in-app) stream mount
      externalProxyPrefix: `/api/ext/v1/${s.id}/`, // externalPlayer (IPTV-client) stream mount — written into composed M3U
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

// ── Per-channel stream status (drives the SPA drawer pill; server-decided B-Roll phase) ──
// channelId is the channel's streamEntryUrl (the value the SPA derives proxyPath from). Returns the
// live phase + retry count the proxy is currently serving for that channel.
sourcesRouter.get('/api/sources/:id/channel-status', (req, res) => {
  if (!getSource(req.params.id)) return res.status(404).json({ error: 'unknown_source' });
  const channelId = typeof req.query.channelId === 'string' ? req.query.channelId : '';
  if (!channelId) return res.status(400).json({ error: 'channelId query parameter required' });
  const info = phaseFor(streamKey(req.params.id, channelId));
  res.json({ phase: info.phase, retry: info.retry });
});

// ── Per-channel stream technical details (ffprobe-derived; drives the drawer "Technical" block) ──
// channelId is the channel's streamEntryUrl. Returns the last-probed StreamProbe (in-memory, TTL'd) or
// null when the channel hasn't been probed yet (never streamed / ffprobe unavailable). DB-free read of the
// in-memory probe cache — same sync, no-try/catch shape as channel-status above.
sourcesRouter.get('/api/sources/:id/stream-details', (req, res) => {
  if (!getSource(req.params.id)) return res.status(404).json({ error: 'unknown_source' });
  const channelId = typeof req.query.channelId === 'string' ? req.query.channelId : '';
  if (!channelId) return res.status(400).json({ error: 'channelId query parameter required' });
  res.json(probeFor(streamKey(req.params.id, channelId)));
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

// ── Single stream proxy API ───────────────────────────────────────────────────
// The stream-access gate, shared by both proxy mounts (/api/v1 = appPlayer, /api/ext/v1 = externalPlayer):
// same token model (a stream token, enabled), same per-user source scope. Returns true when access is granted;
// otherwise it has already sent the plain-text error (the proxy never emits JSON / never calls next(err)).
function checkStreamAccess(req: AuthRequest, res: import('express').Response, source: string): boolean {
  // 1. Enforce authentication on stream requests
  if (!req.user) {
    res.status(401).type('text/plain').send('Unauthorized: stream token required');
    return false;
  }
  // 2. Enforce stream token enabled check
  if (!req.user.streamTokenEnabled) {
    res.status(403).type('text/plain').send('Forbidden: stream token is disabled');
    return false;
  }
  // 3. For standard users, check allowed playlists scope. EXEMPT synthetic (proxy-only) sources: an
  //    imported channel streams via /…/direct/… (origin:'direct'), but a user is never granted the
  //    'direct' pseudo-source — access to imported channels is governed by their per-user m3u fan-out
  //    (allowedCustomPlaylists) + a valid, enabled stream token (checked above), not this source-scope list.
  if (req.user.role === 'user' && !getSource(source)?.synthetic) {
    const allowed = req.user.allowedPlaylists || [];
    if (!allowed.includes(source)) {
      res.status(403).type('text/plain').send('Forbidden: you do not have access to this source');
      return false;
    }
  }
  return true;
}

// In-app player mount (appPlayer): direct relay through the per-source proxy/B-Roll composer.
sourcesRouter.get('/api/v1/:source/*', (req: AuthRequest, res) => {
  const source = req.params.source as string;
  if (!checkStreamAccess(req, res, source)) return;
  const handler = proxyHandlers.get(source);
  if (!handler) {
    return res.status(404).type('text/plain').send(`Unknown source: ${source}`);
  }
  return handler(req, res, () => undefined);
});

// External-client mount (externalPlayer): the per-user M3U composer writes these URLs (m3u/serialize.ts). The
// path is composer-free + engine-driven — NO B-Roll, a solid separation from the in-app /api/v1 player. When the
// ffmpeg/VLC engine is enabled (per the playlist's resolved videoconfig) the session is routed through the
// server-side engine for transcode/normalize + loading/buffering/failed health capture; when it's off /api/ext
// is a B-Roll-free direct relay, so external clients keep working either way. Same access gate as /api/v1.
//
// Per-playlist config: the composed URL carries ?pl=<owningPlaylistId>; resolvePlaylistConfigId maps it to the
// videoconfig (Default 'app' or Custom 'app_<id>'). The id is attached to the request so the entry resolver +
// raw-TS handler read the right config AND key the engine process by it (two playlists with different configs
// for one channel stay isolated). Old M3Us / source playlists without ?pl fall back to :source.
//
// Output split (videoconfig.output): the default 'hls' path serves the loopback-HLS engine (makeExternalHlsEntry);
// the opt-in 'ts' path (ffmpeg OR vlc engine on) serves a held-open raw MPEG-TS socket via externalTsEngine.ts for
// raw-only clients. The composed M3U URL is format-neutral, so the same URL works for either (served content-type
// distinguishes them).
sourcesRouter.get('/api/ext/v1/:source/*', async (req: AuthRequest, res) => {
  const source = req.params.source as string;
  if (!checkStreamAccess(req, res, source)) return;
  // Resolve the per-playlist videoconfig and attach it for the entry resolver / raw-TS handler (engine keying).
  const playlistId = typeof req.query.pl === 'string' && req.query.pl ? req.query.pl : source;
  const configId = await resolvePlaylistConfigId(playlistId);
  (req as any).videoConfigId = configId;
  const cfg = await getVideoConfigCached(configId);
  if ((cfg?.enabledEngine === 'ffmpeg' || cfg?.enabledEngine === 'vlc') && cfg.output === 'ts') {
    const tsHandler = externalTsHandlers.get(source);
    if (!tsHandler) {
      return res.status(404).type('text/plain').send(`Unknown source: ${source}`);
    }
    return tsHandler(req, res);
  }
  const handler = externalHandlers.get(source);
  if (!handler) {
    return res.status(404).type('text/plain').send(`Unknown source: ${source}`);
  }
  return handler(req, res, () => undefined);
});
