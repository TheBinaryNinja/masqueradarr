import './dns.js'; // FIRST: install the outbound global-fetch DNS dispatcher before anything else
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { loadConfig } from './config.js';
import { publicDir, composeDir } from './paths.js';
import { connect, disconnect } from './db.js';
import { healthRouter } from './routes/health.js';
import { playlistsRouter } from './routes/playlists.js';
import { epgSourcesRouter } from './routes/epgSources.js';
import { channelsRouter } from './routes/channels.js';
import { activeStreamsRouter } from './routes/activeStreams.js';
import { customPlaylistsRouter } from './routes/customPlaylists.js';
import { importRouter } from './routes/import.js';
import { programsRouter } from './routes/programs.js';
import { epgChannelsRouter } from './routes/epgChannels.js';
import { streamSessionsRouter } from './routes/streamSessions.js';
import { viewSessionsRouter } from './routes/viewSessions.js';
import { settingsRouter } from './routes/settings.js';
import { videoConfigRouter } from './routes/videoConfig.js';
import { brollRouter } from './routes/broll.js';
import { cronjobsRouter } from './routes/cronjobs.js';
import { probeRouter } from './routes/probe.js';
import { backupRouter } from './routes/backup.js';
import { systemRouter } from './routes/system.js';
import { sourcesRouter } from './routes/sources.js';
import { bootInitSources } from './sources/seed.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { authenticate, requireAdmin } from './middleware/auth.js';
import { startScheduler } from './scheduler/index.js';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import { duloLoginBrowser } from './sources/adapters/dulo/loginBrowser.js';
import { startStreamTelemetry, stopStreamTelemetry } from './sources/core/streamTelemetry.js';
import { startStatsHub, closeAllStats, attachStats } from './stats/statsHub.js';
import { startSystemStatsHub, closeAllSystemStats, attachSystemStats } from './stats/systemStatsHub.js';
import { systemStatsRouter } from './routes/systemStats.js';
import { startProbeHub, closeAllProbe, attachProbe } from './sources/probeHub.js';
import { logsRouter } from './routes/logs.js';
import { startLogStore, stopLogStore, attachLogs, closeAllLogs } from './logs/logStore.js';
import { applyDnsFromSettings } from './settings/applyDns.js';
import { applyHwDetection } from './videoconfig/hwDetect.js';
import { logger } from './sources/core/logger.js';

// Same-origin gate for the dulo login-stream WebSocket. Compares HOSTNAMES (ignoring port) so the Vite dev
// proxy (localhost:5173 → localhost:3000) and the co-served prod SPA both pass, while a cross-site page is
// rejected. A missing Origin (non-browser client) is allowed — consistent with the API trusting its caller.
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).hostname === (req.headers.host ?? '').split(':')[0];
  } catch {
    return false;
  }
}

async function main() {
  const config = loadConfig();

  try {
    await connect(config.mongoUri);
  } catch (err) {
    console.error('[startup] failed to connect to mongo:', (err as Error).message);
    process.exit(1);
  }

  // Start the log store immediately after Mongo connects (before the other initializers) so boot-init,
  // scheduler, and telemetry logs are captured. Non-fatal; uses raw console — the sink may not be ready.
  try {
    startLogStore();
  } catch (err) {
    console.error('[startup] log store init error (continuing):', (err as Error).message);
  }

  // Ingest the established (Default) source playlists: guarantee each from its committed bundle
  // (idempotent), then kick a non-blocking live sync. Runs in both Docker variants via this single
  // boot path. A failure here must not prevent the API from serving.
  try {
    await bootInitSources();
  } catch (err) {
    logger.error('startup', `source init error (continuing): ${(err as Error).message}`);
  }

  // Re-apply the outbound-fetch DNS dispatcher from the persisted settings singleton (seeded above by
  // bootInitSources → seedSettings). dns.ts already installed the env value at import; the Mongo value is
  // authoritative from here on. Non-fatal — a bad nameserver only affects global fetch(), never Mongo.
  try {
    await applyDnsFromSettings('mongo');
  } catch (err) {
    logger.error('startup', `dns settings apply error (continuing): ${(err as Error).message}`);
  }

  // Detect host hardware-encoder capability (ffmpeg -encoders + device nodes) → videoconfig.hwAccel.detected,
  // so the Settings → Video Configuration card only offers encoders that can actually run here (WS6). Non-fatal:
  // software transcode + the loopback/raw-TS engines work regardless of GPU presence.
  try {
    await applyHwDetection();
  } catch (err) {
    logger.error('startup', `hw detection error (continuing): ${(err as Error).message}`);
  }

  // Register persisted cron jobs (cronjobs collection) with the scheduler. Non-fatal: a scheduler
  // failure must not prevent the API from serving.
  try {
    await startScheduler();
  } catch (err) {
    logger.error('startup', `scheduler init error (continuing): ${(err as Error).message}`);
  }

  // Live stream telemetry: the in-memory viewer/bandwidth tick + the WebSocket stats hub. Non-fatal.
  try {
    startStreamTelemetry();
    startStatsHub();
    startProbeHub();
    startSystemStatsHub();
  } catch (err) {
    logger.error('startup', `stream telemetry init error (continuing): ${(err as Error).message}`);
  }

  const app = express();
  // The proxy attributes viewers/bandwidth by client ip — read the real client IP from X-Forwarded-For
  // when behind the Docker/edge reverse proxy. (The API already trusts its caller; no auth depends on it.)
  app.set('trust proxy', true);
  // The M3U import API accepts a whole playlist file in the JSON body — raise its limit BEFORE the default
  // parser (which would otherwise reject a multi-MB body at the 100kb default). The default parser then
  // no-ops on these requests (the body is already parsed), so every other endpoint keeps the tight limit.
  app.use('/api/import', express.json({ limit: '25mb' }));
  // The Custom EPG source uploads a whole XMLTV guide (Add file / re-upload). Real guides run 50–150 MB
  // uncompressed, so the browser gzips them and ships the bytes as a RAW body (application/gzip) with the
  // metadata as query params — far smaller on the wire and no JSON-escaping inflation. Accept that raw body
  // before the JSON parser; the server gunzips it (xmltvIngest.decodeXmltvBody). The legacy JSON `{content}`
  // path still works for tiny guides under the (now modest) JSON limit; the metadata/url bodies are tiny.
  app.use(
    '/api/epg-sources',
    express.raw({
      type: ['application/gzip', 'application/octet-stream', 'application/xml', 'text/xml'],
      limit: '64mb',
    }),
  );
  app.use('/api/epg-sources', express.json({ limit: '12mb' }));
  // Restore accepts a whole backup file (gzipped JSON, or plain JSON) as a RAW body. A from-nothing backup
  // can be large, so raise the limit well above the defaults; scoped to the restore path only (also covers
  // /restore/:filename, which sends no body, so this no-ops there). Body-parser overflow → 413 in the error
  // middleware below. The default JSON parser then no-ops on these requests.
  app.use(
    '/api/backup/restore',
    // Buffer the body for ANY content-type on this admin-only path (type: () => true) — the SPA sends
    // application/gzip|json, but a missing/foreign header must still be read as the backup bytes rather than
    // being skipped (which would surface as a misleading 400 empty_body). /restore/:filename sends no body.
    express.raw({ type: () => true, limit: '256mb' }),
  );
  app.use(express.json());

  // Apply authenticate middleware to all /api/ endpoints
  app.use('/api', authenticate);

  app.use('/api/health', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);

  // Protect admin-only endpoints (GET settings is allowed for standard users, PUT is admin-only)
  app.put('/api/settings', requireAdmin);
  // videoconfig mirrors settings: GET is open (no secrets — drives the externalPlayer engine), PUT/DELETE are
  // admin-only. DELETE removes a per-playlist Custom config ('app_<playlistId>'); the global 'app' is undeletable.
  app.put('/api/video-config/:id', requireAdmin);
  app.delete('/api/video-config/:id', requireAdmin);

  const adminOnlyRoutes = [
    '/api/epg-sources',
    '/api/channels',
    '/api/active-streams',
    '/api/custom-playlists',
    '/api/import',
    '/api/epg-programs',
    '/api/epg-channels',
    '/api/logs',
    '/api/stream-sessions',
    '/api/view-sessions',
    '/api/cronjobs',
    '/api/probe',
    '/api/broll',
    '/api/system-stats',
    '/api/backup',
    '/api/system',
    '/api/sources'
  ];
  for (const routePath of adminOnlyRoutes) {
    app.use(routePath, requireAdmin);
  }

  app.use('/api/playlists', playlistsRouter);
  app.use('/api/epg-sources', epgSourcesRouter);
  app.use('/api/channels', channelsRouter);
  app.use('/api/active-streams', activeStreamsRouter);
  app.use('/api/custom-playlists', customPlaylistsRouter);
  app.use('/api/import', importRouter);
  app.use('/api/epg-programs', programsRouter);
  app.use('/api/epg-channels', epgChannelsRouter);
  app.use('/api/logs', logsRouter);
  app.use('/api/stream-sessions', streamSessionsRouter);
  app.use('/api/view-sessions', viewSessionsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/video-config', videoConfigRouter);
  app.use('/api/cronjobs', cronjobsRouter);
  app.use('/api/probe', probeRouter); // manual trigger + status for the scheduled ffprobe sweep
  app.use('/api/broll', brollRouter); // dev/preview aid for the B-Roll renderer (see routes/broll.ts)
  app.use('/api/system-stats', systemStatsRouter); // latest system-performance snapshot (live feed is the WS)
  app.use('/api/backup', backupRouter); // full-system backup generate/list/restore (Settings → Data)
  app.use('/api/system', systemRouter); // index rebuild + workspace reset (Settings → Data)

  // Generic source API (manifest, stream proxy, status, sync/reset) — mounted at root since its
  // paths span /api/sources and /api/v1.
  app.use(sourcesRouter);

  // composeDir holds the m3u exports (decoupled from the SPA's publicDir). Files are PER-USER ONLY
  // (<username>-<slug>.m3u) under _global/m3u/ (Global) and custom/<customPath>/ (Custom), plus the EPG
  // guide siblings. Served WITHOUT auth — the playlist DOWNLOAD is token-free (the random User.slug is the
  // unguessable bearer); the channel STREAMS inside still require a token (proxy gate). The m3u files are
  // exposed at FLAT public URLs — the _global/m3u/ and custom/ disk namespaces are STRIPPED — via two
  // scoped static mounts at '/': a Global file resolves at <domain>/<username>-<slug>.m3u and a Custom file
  // at <domain>/<customPath>/<username>-<slug>.m3u. The plain composeDir mount still serves the guide
  // siblings (and the namespaced paths, 1:1) as a fallback. ALL come BEFORE the SPA mount + catch-all. The
  // mkdirSyncs ensure the static roots exist so a file written after boot is reachable without a restart
  // (in Docker /app/compose is pre-created + chowned to `node`; here a no-op or a dev-side create).
  mkdirSync(resolve(composeDir, '_global/m3u'), { recursive: true });
  mkdirSync(resolve(composeDir, 'custom'), { recursive: true });
  app.use(express.static(resolve(composeDir, '_global/m3u'))); // Global per-user files at the URL root
  app.use(express.static(resolve(composeDir, 'custom')));      // Custom files at /<customPath>/...
  app.use(express.static(composeDir));                         // guide siblings + namespaced 1:1 fallback

  // publicDir holds the built SPA assets only. express.static is mounted unconditionally; the SPA
  // catch-all is added only when a built index.html is present (prod/Docker) — in dev Vite serves the
  // SPA, so a missing index.html must not turn every non-/api path into a 500.
  mkdirSync(publicDir, { recursive: true });
  app.use(express.static(publicDir));
  if (existsSync(resolve(publicDir, 'index.html'))) {
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(resolve(publicDir, 'index.html'));
    });
    logger.info('http', `serving SPA from ${publicDir}`);
  }

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // body-parser rejects an over-limit body with a PayloadTooLargeError — surface it as a clean 413 so the
    // uploader can show a real "too large" message instead of a generic 500.
    const e = err as Error & { type?: string; status?: number; statusCode?: number };
    if (e.type === 'entity.too.large' || e.status === 413 || e.statusCode === 413) {
      logger.warn('api', `payload too large: ${err.message}`);
      return res.status(413).json({ error: 'payload_too_large' });
    }
    logger.error('api', err.message);
    res.status(500).json({ error: 'internal_error' });
  });

  const server = app.listen(config.port, () => {
    logger.info('api', `listening on :${config.port}`);
  });

  // dulo streamed-login WebSocket (sources/adapters/dulo/loginBrowser.ts). Mounted on the raw http.Server's
  // 'upgrade' event — Express has no native WS. The browser launches lazily on connect, so this adds zero
  // boot cost; it spans only /api/dulo/login-stream and never touches the SPA static / catch-all.
  // Five WS endpoints share the one upgrade handler, dispatched by pathname (Express has no native WS):
  //   /api/dulo/login-stream → the dulo streamed-login browser
  //   /api/stream-stats       → the live Active Streams / metrics push (stats/statsHub.ts)
  //   /api/logs-stream        → the live application-log tail (logs/logStore.ts)
  //   /api/probe-progress     → the scheduled ffprobe sweep's live counter (sources/probeHub.ts)
  //   /api/system-stats       → the live system-performance push (stats/systemStatsHub.ts)
  const wss = new WebSocketServer({ noServer: true });
  const wssStats = new WebSocketServer({ noServer: true });
  const wssLogs = new WebSocketServer({ noServer: true });
  const wssProbe = new WebSocketServer({ noServer: true });
  const wssSystem = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '', `http://${req.headers.host}`).pathname;
    } catch {
      pathname = '';
    }
    if (!sameOrigin(req)) {
      socket.destroy();
      return;
    }
    if (pathname === '/api/dulo/login-stream') {
      wss.handleUpgrade(req, socket, head, (ws) => duloLoginBrowser.attach(ws));
    } else if (pathname === '/api/stream-stats') {
      wssStats.handleUpgrade(req, socket, head, (ws) => attachStats(ws));
    } else if (pathname === '/api/logs-stream') {
      wssLogs.handleUpgrade(req, socket, head, (ws) => attachLogs(ws));
    } else if (pathname === '/api/probe-progress') {
      wssProbe.handleUpgrade(req, socket, head, (ws) => attachProbe(ws));
    } else if (pathname === '/api/system-stats') {
      wssSystem.handleUpgrade(req, socket, head, (ws) => attachSystemStats(ws));
    } else {
      socket.destroy();
    }
  });

  const shutdown = async (signal: string) => {
    logger.info('shutdown', `received ${signal}`);
    await duloLoginBrowser.closeAll();
    closeAllStats();
    closeAllSystemStats();
    closeAllProbe();
    closeAllLogs();
    stopStreamTelemetry();
    await stopLogStore(); // detach the sink + flush the final batch (incl. the shutdown line) before disconnect
    wss.close();
    wssStats.close();
    wssLogs.close();
    wssProbe.close();
    wssSystem.close();
    server.close();
    await disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[startup] fatal:', err);
  process.exit(1);
});
