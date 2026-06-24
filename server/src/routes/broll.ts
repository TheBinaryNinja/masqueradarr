import { Router } from 'express';
import {
  renderBroll,
  readBrollSegment,
  BROLL_SEG_SECONDS,
  type BrollStatus,
} from '../sources/core/broll.js';

// DEV / PREVIEW AID — render a self-contained VOD B-Roll clip so the placeholder card can be eyeballed
// in a browser or VLC (e.g. /api/broll/preview.m3u8?title=Home&channel=BBC%20One&status=buffer&retry=1).
// The *real* B-Roll is served through the stream proxy (sources/core/proxyHandler.ts) with a live
// playlist + server-decided status; this route just exercises the renderer in isolation.

export const brollRouter = Router();

const STATUSES: BrollStatus[] = ['establishing', 'buffer', 'failed'];

brollRouter.get('/preview.m3u8', async (req, res, next) => {
  try {
    const title = typeof req.query.title === 'string' ? req.query.title : 'TVApp2';
    const channel = typeof req.query.channel === 'string' ? req.query.channel : 'Preview Channel';
    const status = STATUSES.includes(req.query.status as BrollStatus)
      ? (req.query.status as BrollStatus)
      : 'establishing';
    const retry = Math.max(0, Math.min(9, parseInt(String(req.query.retry ?? '0'), 10) || 0));

    const r = await renderBroll({ title, channel, status, retry });
    if (!r) {
      return res.status(503).type('text/plain').send('B-Roll unavailable (ffmpeg missing or render failed)');
    }
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(BROLL_SEG_SECONDS)}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
    ];
    for (const seg of r.segments) {
      lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
      lines.push(`/api/broll/seg/${r.hash}/${seg.name}`);
    }
    lines.push('#EXT-X-ENDLIST');
    res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(lines.join('\n') + '\n');
  } catch (err) {
    next(err);
  }
});

brollRouter.get('/seg/:hash/:name', (req, res) => {
  const buf = readBrollSegment(req.params.hash, req.params.name);
  if (!buf) return res.status(404).type('text/plain').send('not found');
  res.type('video/mp2t').set('Cache-Control', 'no-store').send(buf);
});
