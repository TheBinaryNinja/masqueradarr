import { Router } from 'express';
import { buildDisplaySnapshot } from '../stats/statsHub.js';
import { clientsFor } from '../sources/core/streamTelemetry.js';
import { streamKey } from '../sources/core/streamState.js';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import { resolveGeo } from '../geoip/geoip.js';

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

