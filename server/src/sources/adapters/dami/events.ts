// dami events — fetch + parse dami-tv.pro's DOCUMENTED public sports-events API into the flat DamiEvent shape
// epg/dami.ts maps into the playlist-bound guide. The dami analogue of dlhd's schedule.ts, but cleaner: dami
// publishes a documented JSON API (GET /papi/api/streams — its own READ_ME: "Free public API by DAMITV"),
// with REAL program bounds (starts_at/ends_at, epoch SECONDS) and the channel mapping encoded in each event's
// `sources[].embed` as `?ch=dlhd-<id>` (the DaddyLive channel id = the dami catalog id). No timezone math is
// needed (timestamps are absolute epoch). Falls back to the undocumented /papi/matches/all (start-only) if the
// documented endpoint's shape ever changes.

import { DAMI_BASE, UA } from './catalog.js';
import { logger } from '../../core/logger.js';

export interface DamiEventChannel {
  id: string; // bare DaddyLive channel id (= dami catalog id)
  name: string;
}

export interface DamiEvent {
  id: string;
  title: string;
  cat: string;
  start: number; // epoch ms
  stop: number | null; // epoch ms (real end from the API), or null → epg/dami applies a default duration
  channels: DamiEventChannel[]; // the catalog channels carrying this event
}

const STREAMS_URL = process.env.DAMI_STREAMS_URL || `${DAMI_BASE}/papi/api/streams`;
const MATCHES_URL = `${DAMI_BASE}/papi/matches/all`;
const CH_RE = /[?&]ch=dlhd-(\d+)/i; // event source embed → DaddyLive channel id

function headers(): Record<string, string> {
  return { 'User-Agent': UA, Accept: 'application/json', Referer: `${DAMI_BASE}/` };
}

// Pull channel ids carried by an event from its `sources[].embed` (?ch=dlhd-<id>); drop event-only feeds
// (?id=<event>), which have no linear channel to attach a program to.
function channelsOf(ev: any): DamiEventChannel[] {
  const out: DamiEventChannel[] = [];
  for (const s of Array.isArray(ev?.sources) ? ev.sources : []) {
    const m = CH_RE.exec(String(s?.embed || ''));
    if (m && !out.some((c) => c.id === m[1])) out.push({ id: m[1], name: String(s?.name || m[1]) });
  }
  return out;
}

// PRIMARY: the documented /papi/api/streams feed (categories → events with starts_at/ends_at). Throws on a
// fetch failure OR a broken top-level shape (so the caller preserves the prior guide); an empty-but-valid
// payload (quiet sports day) returns [].
async function fetchFromStreams(): Promise<DamiEvent[]> {
  const res = await fetch(STREAMS_URL, { headers: headers() });
  if (!res.ok) throw new Error(`dami /papi/api/streams: HTTP ${res.status}`);
  const json = (await res.json()) as { streams?: Array<{ streams?: any[] }> };
  if (!Array.isArray(json.streams)) throw new Error('dami /papi/api/streams: unexpected shape (no streams[])');
  const events: DamiEvent[] = [];
  const seen = new Set<string>();
  for (const cat of json.streams) {
    for (const ev of Array.isArray(cat?.streams) ? cat.streams : []) {
      const id = String(ev?.id ?? '');
      const start = Number(ev?.starts_at) * 1000;
      if (!id || seen.has(id) || !Number.isFinite(start) || start <= 0) continue;
      const channels = channelsOf(ev);
      if (!channels.length) continue;
      const endMs = Number(ev?.ends_at) * 1000;
      seen.add(id);
      events.push({
        id,
        title: String(ev?.name || ev?.title || 'Live Event'),
        cat: String(ev?.league || ev?.category_name || ev?.category || 'Live'),
        start,
        stop: Number.isFinite(endMs) && endMs > start ? endMs : null,
        channels,
      });
    }
  }
  return events;
}

// FALLBACK: the undocumented /papi/matches/all (flat events with `tvChannels[]` + a start-only `date` ms).
async function fetchFromMatches(): Promise<DamiEvent[]> {
  const res = await fetch(MATCHES_URL, { headers: headers() });
  if (!res.ok) throw new Error(`dami /papi/matches/all: HTTP ${res.status}`);
  const arr = (await res.json()) as any[];
  if (!Array.isArray(arr)) throw new Error('dami /papi/matches/all: unexpected shape');
  const events: DamiEvent[] = [];
  const seen = new Set<string>();
  for (const ev of arr) {
    const id = String(ev?.id ?? '');
    const start = Number(ev?.date);
    if (!id || seen.has(id) || !Number.isFinite(start) || start <= 0) continue;
    const channels: DamiEventChannel[] = (Array.isArray(ev?.tvChannels) ? ev.tvChannels : [])
      .filter((c: any) => /^\d+$/.test(String(c?.id)))
      .map((c: any) => ({ id: String(c.id), name: String(c?.name || c.id) }));
    if (!channels.length) continue;
    seen.add(id);
    events.push({
      id,
      title: String(ev?.title || 'Live Event'),
      cat: String(ev?.league || ev?.category || 'Live'),
      start,
      stop: null,
      channels,
    });
  }
  return events;
}

/** Fetch the dami live-events guide (documented streams API; matches/all as a shape-change fallback). */
export async function fetchDamiEvents(): Promise<{ events: DamiEvent[]; meta: Record<string, unknown> }> {
  try {
    const events = await fetchFromStreams();
    return { events, meta: { endpoint: STREAMS_URL, count: events.length, fetchedAt: new Date().toISOString() } };
  } catch (err) {
    logger.warn('epg', `dami events: /papi/api/streams failed (${(err as Error).message}) — trying /papi/matches/all`);
    const events = await fetchFromMatches();
    return {
      events,
      meta: { endpoint: MATCHES_URL, fallback: true, count: events.length, fetchedAt: new Date().toISOString() },
    };
  }
}
