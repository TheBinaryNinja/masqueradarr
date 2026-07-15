// HDHomeRun downstream serving surface — the endpoints a DVR app (Plex/Emby/Jellyfin/Channels) fetches from
// an emulated tuner. Mounted at /hdhr (OUTSIDE /api, so it bypasses the admin auth gate) BEFORE the SPA
// catch-all. `:tunerId` is the tuner's unguessable slug — the access secret, since lineup.json embeds the
// owner's streamToken in each stream URL (same posture as the token-free User.slug .m3u download). An unknown
// or disabled tuner → 404.
//
// The lineup/guide are built from the wired Playlist's SAME Active channel set the M3U/EPG compose uses
// (playlistActiveChannels + deriveStreamUrl + buildGuideXml), so a tuner can never drift from the playlist.

import { Router, type Request } from 'express';
import { HdhrTuner, type HdhrTunerDoc } from '../models/HdhrTuner.js';
import { Playlist } from '../models/Playlist.js';
import { User, type UserDoc } from '../models/User.js';
import { playlistActiveChannels, type PlaylistLite } from '../m3u/compose.js';
import { deriveStreamUrl, deriveTunerStreamUrl, channelToExtinf, m3uHeader } from '../m3u/serialize.js';
import { buildGuideXml } from '../epg/composeGuide.js';
import { deviceIdToNumber } from '../hdhomerun/deviceId.js';
import { buildGrant } from '../proxy/resolveSeam.js';
import { gateStreamAccess } from '../middleware/streamGate.js';
import { isPrivateHost } from '../sources/core/ssrf.js';
import { serveTunerStream, activeStreamCount } from '../hdhomerun/tunerEngine.js';

export const hdhrServeRouter = Router();

// The absolute origin the client reached us on — honoring a reverse proxy (x-forwarded-*) so BaseURL /
// LineupURL / stream URLs all echo the address the DVR app actually used (robust for direct-IP + domain + TLS).
export function requestBase(req: Request): string {
  const xfProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const proto = xfProto || req.protocol || 'http';
  const xfHost = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
  const host = xfHost || req.headers.host || '';
  return `${proto}://${host}`;
}

async function getEnabledTuner(id: string): Promise<HdhrTunerDoc | null> {
  return HdhrTuner.findOne({ id, enabled: true }, { _id: 0 }).lean<HdhrTunerDoc>();
}

// The wired playlist as the minimal shape playlistActiveChannels reads; null when it has vanished.
async function wiredPlaylist(playlistId: string): Promise<PlaylistLite | null> {
  const pl = await Playlist.findOne(
    { id: playlistId },
    { _id: 0, id: 1, url: 1, endpoint: 1, state: 1, source: 1 },
  ).lean<PlaylistLite>();
  return pl ?? null;
}

async function ownerStreamToken(username: string): Promise<string | undefined> {
  const owner = await User.findOne({ username }, { _id: 0, streamToken: 1 }).lean<{ streamToken?: string }>();
  return owner?.streamToken;
}

// The tuner owner as the user object the stream-access ladder reads (role / streamTokenEnabled /
// allowedPlaylists). The token-free /stream route uses this to re-check the owner still has access to the
// source — defense-in-depth on top of the unguessable :tunerId slug (a revoked owner can't stream).
async function ownerGateUser(username: string): Promise<(UserDoc & { _id: unknown }) | undefined> {
  const owner = await User.findOne({ username });
  return owner ?? undefined;
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
}

// A DETERMINISTIC fallback GuideNumber for a channel with no explicit channelNo. Derived from a stable channel
// key (streamEntryUrl) via FNV-1a into a high band [10000, 99999], so the channel keeps the SAME number across
// syncs (unlike a positional index, which shifts when the channel set changes and remaps DVR recordings) and
// never collides with the small explicit channel numbers operators assign. Linear-probes past any number that
// is already emitted (`used`) or reserved by an explicit channelNo (`reserved`) to guarantee uniqueness.
function fallbackGuideNumber(key: string, used: Set<string>, reserved: Set<string>): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let n = 10000 + ((h >>> 0) % 90000);
  let guard = 0;
  while ((used.has(String(n)) || reserved.has(String(n))) && guard++ < 90000) {
    n = n >= 99999 ? 10000 : n + 1;
  }
  return String(n);
}

// GET /:tunerId/discover.json — device metadata. BaseURL/LineupURL derive from the request.
hdhrServeRouter.get('/:tunerId/discover.json', async (req, res, next) => {
  try {
    const t = await getEnabledTuner(req.params.tunerId);
    if (!t) return res.status(404).json({ error: 'not_found' });
    const base = `${requestBase(req)}/hdhr/${t.id}`;
    res.json({
      FriendlyName: t.friendlyName,
      Manufacturer: 'masqueradarr',
      ManufacturerURL: 'https://github.com/TheBinaryNinja/masqueradarr',
      ModelNumber: 'HDHR5-4US',
      FirmwareName: 'hdhomerun5_atsc',
      FirmwareVersion: '20230101',
      DeviceID: t.deviceId,
      DeviceAuth: '',
      TunerCount: t.tunerCount,
      BaseURL: base,
      LineupURL: `${base}/lineup.json`,
    });
  } catch (err) {
    next(err);
  }
});

// GET /:tunerId/lineup.json — the wired playlist's channels as HDHomeRun entries.
hdhrServeRouter.get('/:tunerId/lineup.json', async (req, res, next) => {
  try {
    const t = await getEnabledTuner(req.params.tunerId);
    if (!t) return res.status(404).json({ error: 'not_found' });
    const pl = await wiredPlaylist(t.playlistId);
    if (!pl) return res.json([]); // wired playlist vanished → empty lineup (don't 500)
    const base = requestBase(req);
    const channels = await playlistActiveChannels(pl);
    // GuideNumber must be UNIQUE (DVR apps key channels by it and silently drop duplicates) and STABLE across
    // syncs. Reserve every explicit channelNo first so a derived fallback never steals one; then assign: an
    // explicit number goes to the FIRST channel that claims it, everything else gets a deterministic fallback.
    const reserved = new Set<string>();
    for (const ch of channels) {
      const e = ch.channelNo?.trim();
      if (e) reserved.add(e);
    }
    const used = new Set<string>();
    const lineup: Array<{ GuideNumber: string; GuideName: string; URL: string; HD: number; DRM: number }> = [];
    for (const ch of channels) {
      // Point Plex/Emby at the DEDICATED tuner ffmpeg-TS route (not /api/ext/v1) — token-free, slug-gated.
      const url = deriveTunerStreamUrl(ch, base, t.id);
      if (!url) continue;
      const explicit = ch.channelNo?.trim();
      const guide = explicit && !used.has(explicit) ? explicit : fallbackGuideNumber(ch.streamEntryUrl, used, reserved);
      used.add(guide);
      lineup.push({ GuideNumber: guide, GuideName: ch.tvg_name, URL: url, HD: 1, DRM: 0 });
    }
    res.json(lineup);
  } catch (err) {
    next(err);
  }
});

// GET /:tunerId/lineup_status.json — a static idle/scan-possible status.
hdhrServeRouter.get('/:tunerId/lineup_status.json', async (req, res, next) => {
  try {
    const t = await getEnabledTuner(req.params.tunerId);
    if (!t) return res.status(404).json({ error: 'not_found' });
    res.json({ ScanInProgress: 0, ScanPossible: 1, Source: 'Cable', SourceList: ['Cable'] });
  } catch (err) {
    next(err);
  }
});

// POST /:tunerId/lineup.post — channel-scan trigger. We have a fixed lineup, so this is a no-op.
hdhrServeRouter.post('/:tunerId/lineup.post', async (req, res, next) => {
  try {
    const t = await getEnabledTuner(req.params.tunerId);
    if (!t) return res.status(404).json({ error: 'not_found' });
    res.status(200).end();
  } catch (err) {
    next(err);
  }
});

// GET /:tunerId/lineup.m3u — the same channel set as an M3U (some clients prefer it), with the guide advertised.
hdhrServeRouter.get('/:tunerId/lineup.m3u', async (req, res, next) => {
  try {
    const t = await getEnabledTuner(req.params.tunerId);
    if (!t) return res.status(404).json({ error: 'not_found' });
    const base = requestBase(req);
    const pl = await wiredPlaylist(t.playlistId);
    if (!pl) {
      res.type('audio/x-mpegurl').send(`${m3uHeader(null)}\n`);
      return;
    }
    const token = await ownerStreamToken(t.ownerUsername);
    const channels = await playlistActiveChannels(pl);
    const lines = [m3uHeader(`${base}/hdhr/${t.id}/epg.xml`)];
    for (const ch of channels) {
      const line = channelToExtinf(ch, base, token);
      if (line) lines.push(line);
    }
    res.type('audio/x-mpegurl').send(`${lines.join('\n')}\n`);
  } catch (err) {
    next(err);
  }
});

// GET /:tunerId/stream/:source/:entry — the DEDICATED tuner video route (Path B). A per-connection ffmpeg
// copy-remux (hdhomerun/tunerEngine.ts) streams a continuous video/mp2t straight to Plex/Emby, fully separate
// from /api/ext/v1 + the Rust data plane. Token-free (the :tunerId slug is the secret); the owner's stream
// access is re-checked here, then buildGrant resolves the upstream master + headers the engine feeds ffmpeg.
hdhrServeRouter.get('/:tunerId/stream/:source/:entry', async (req, res, next) => {
  try {
    const t = await getEnabledTuner(req.params.tunerId);
    if (!t) return res.status(404).type('text/plain').send('not found');

    const source = req.params.source;
    // Auth: the owner must still have stream access to this source (plain-text deny so a player surfaces it).
    const owner = await ownerGateUser(t.ownerUsername);
    const decision = gateStreamAccess(owner, source);
    if (!decision.ok) return res.status(decision.status!).type('text/plain').send(decision.message!);

    // Per-tuner concurrency cap — Plex self-limits to TunerCount, but guard against runaway ffmpeg.
    if (activeStreamCount(t.id) >= t.tunerCount) {
      return res.status(503).type('text/plain').send('all tuners busy');
    }

    // Express decodes the :entry param once, so it equals the stored streamEntryUrl (single-encoded by
    // deriveTunerStreamUrl). buildGrant's PlaylistChannel.exists gate rejects anything not a stored entry.
    const entryUrl = req.params.entry;
    const pl = typeof req.query.pl === 'string' ? req.query.pl : undefined;

    const grant = await buildGrant(source, entryUrl, pl, 0);
    if (!grant.ok) return res.status(grant.status).type('text/plain').send(grant.error);

    // SSRF: ffmpeg fetches grant.target directly (no Rust host gate), so block a private/loopback target
    // unless the adapter opts into private upstreams (grant.allowPrivate).
    let host = '';
    try {
      host = new URL(grant.target).hostname;
    } catch {
      /* malformed target → blocked below */
    }
    if (!grant.allowPrivate && (!host || isPrivateHost(host))) {
      return res.status(403).type('text/plain').send('forbidden upstream');
    }

    await serveTunerStream({
      res,
      tunerId: t.id,
      source,
      entryUrl,
      pl,
      grant,
      viewer: {
        ip: req.ip || '',
        ua: (req.headers['user-agent'] as string) || '',
        username: t.ownerUsername,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /:tunerId/epg.xml — the paired XMLTV guide, built in-memory from the same channel set (no disk write).
hdhrServeRouter.get('/:tunerId/epg.xml', async (req, res, next) => {
  try {
    const t = await getEnabledTuner(req.params.tunerId);
    if (!t) return res.status(404).json({ error: 'not_found' });
    const pl = await wiredPlaylist(t.playlistId);
    const channels = pl ? await playlistActiveChannels(pl) : [];
    const built = await buildGuideXml(channels);
    res.type('application/xml').send(built.xml);
  } catch (err) {
    next(err);
  }
});

// GET /:tunerId/device.xml — minimal UPnP description for SSDP-based clients.
hdhrServeRouter.get('/:tunerId/device.xml', async (req, res, next) => {
  try {
    const t = await getEnabledTuner(req.params.tunerId);
    if (!t) return res.status(404).json({ error: 'not_found' });
    const base = `${requestBase(req)}/hdhr/${t.id}`;
    const uuid = deviceIdToNumber(t.deviceId).toString(16).padStart(8, '0');
    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>${xmlEscape(base)}</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${xmlEscape(t.friendlyName)}</friendlyName>
    <manufacturer>Silicondust</manufacturer>
    <modelName>HDHomeRun</modelName>
    <modelNumber>HDHR5-4US</modelNumber>
    <serialNumber>${xmlEscape(t.deviceId)}</serialNumber>
    <UDN>uuid:${uuid}-0000-0000-0000-${t.deviceId.toLowerCase()}</UDN>
  </device>
</root>
`,
    );
  } catch (err) {
    next(err);
  }
});
