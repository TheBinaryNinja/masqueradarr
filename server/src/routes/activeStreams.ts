import { Router } from 'express';
import { buildDisplaySnapshot } from '../stats/statsHub.js';
import { clientsFor } from '../sources/core/streamTelemetry.js';
import { streamKey } from '../sources/core/streamState.js';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import { resolveGeo } from '../geoip/geoip.js';
import { enginesForChannel as hlsEnginesForChannel } from '../sources/core/externalEngine.js';
import { enginesForChannel as tsEnginesForChannel } from '../sources/core/externalTsEngine.js';
import { getVideoConfigCached } from '../videoconfig/runtime.js';

export const activeStreamsRouter = Router();

// Live in-memory snapshot of every channel with ≥1 active viewer — served straight from the streamTelemetry
// core via the stats hub (no Mongo read). Replaces the legacy empty ActiveStream collection. The same
// payload is pushed over the /api/stream-stats WebSocket; this GET is the initial-load / WS-less fallback.
activeStreamsRouter.get('/', async (_req, res, next) => {
  try {
    res.json(await buildDisplaySnapshot());
  } catch (err) {
    next(err);
  }
});

// Per-channel connected viewers (drives the detail "Connected sessions" card). channelId = PlaylistChannel._id;
// resolve it to (source, streamEntryUrl) → the telemetry channel key → the live client list.
activeStreamsRouter.get('/:channelId/clients', async (req, res, next) => {
  try {
    const ch = await PlaylistChannel.findById(req.params.channelId, { source: 1, origin: 1, streamEntryUrl: 1 }).lean();
    if (!ch) return res.status(404).json({ error: 'not_found' });
    // Enrich each connected viewer with a geolocation resolved from its IP (cached; a no-op em-dash when geo
    // is disabled). The telemetry core stays DB-free — the geoip lookup lives here at the edge.
    // Telemetry keys on the PROXY source (origin ?? source) — imports store source=<importId>, origin='direct'.
    const clients = clientsFor(streamKey(ch.origin ?? ch.source, ch.streamEntryUrl));
    const enriched = await Promise.all(
      clients.map(async (c) => {
        const geo = await resolveGeo(c.ip);
        return { ...c, location: geo?.location ?? null, countryCode: geo?.countryCode ?? null };
      }),
    );
    res.json(enriched);
  } catch (err) {
    next(err);
  }
});

// Strip an upstream master URL to host + path — its query string can carry signed/expiring tokens (dlhd
// signed masters, dulo playbackUrls). The admin diagram shows host+path for orientation, never the raw URL.
function redactUpstream(raw: string): string {
  try {
    const u = new URL(raw);
    return u.host + u.pathname;
  } catch {
    return (raw || '').split('?')[0];
  }
}

// Per-channel external-player ENGINE snapshot (drives the Active Streams "Video Engine Service" diagram). One
// entry per live ffmpeg engine process serving this channel (HLS + raw-TS cores unioned; usually 0 or 1).
// Each core snapshot is enriched here with the videoconfig-derived preset/advancedArgs/hwEncoder (the cores
// stay DB-free) and has its resolved upstream URL query-redacted. channelId = PlaylistChannel._id →
// (origin ?? source, streamEntryUrl) → the engine channel key. An empty `engines` ⇒ no live external engine for
// this channel (only the in-app player is watching, or nobody) ⇒ the SPA shows the passthrough note. Admin-only
// via the adminOnlyRoutes prefix.
activeStreamsRouter.get('/:channelId/engine', async (req, res, next) => {
  try {
    const ch = await PlaylistChannel.findById(req.params.channelId, { source: 1, origin: 1, streamEntryUrl: 1 }).lean();
    if (!ch) return res.status(404).json({ error: 'not_found' });
    const channelKey = streamKey(ch.origin ?? ch.source, ch.streamEntryUrl);
    const snapshots = [...hlsEnginesForChannel(channelKey), ...tsEnginesForChannel(channelKey)];
    const engines = await Promise.all(
      snapshots.map(async (s) => {
        const doc = await getVideoConfigCached(s.configId);
        const sub = doc?.ffmpeg;
        const hw = doc?.hwAccel;
        return {
          ...s,
          upstreamUrl: redactUpstream(s.upstreamUrl),
          preset: sub?.preset ?? null,
          advancedArgs: sub?.advancedArgs ?? '',
          hwEncoder: hw?.enabled && hw.encoder !== 'none' ? hw.encoder : null,
        };
      }),
    );
    res.json({ engines });
  } catch (err) {
    next(err);
  }
});
