// HDHomeRun device API — discover + lineup fetch/parse. A per-DEVICE leaf module (NOT the generic
// buildSource pipeline in core/): an HDHomeRun import points at ONE LAN device IP, so listing is bespoke per
// device. http-only (HDHomeRun exposes no TLS), short timeout, every failure throws a typed Error the route
// maps to a 400/502 (never a 500). See restapi-sources/SKILL.md (HDHomeRun) + the plan in .claude/plans/.
//
//   GET <base>/discover.json → device identity + TunerCount (the concurrent-stream cap).
//   GET <base>/lineup.json   → the channel catalog ([{ GuideNumber, GuideName, URL, Tags }]); the device's
//                              `URL` (e.g. http://<ip>:5004/auto/v5.1) is the raw MPEG-TS the remux turns to HLS.
//   GET <base>/lineup.m3u    → the same catalog as an M3U (used by the Test endpoint per the feature spec).

const TIMEOUT_MS = Number(process.env.HDHR_TIMEOUT_MS || 8000);
const UA = 'Masqueradarr-hdhr/1.0';

export interface HdhrDiscover {
  friendlyName: string;
  modelNumber: string;
  firmwareVersion: string | null;
  deviceId: string | null;
  tunerCount: number;
  baseUrl: string;
  lineupUrl: string;
}

export interface HdhrLineupEntry {
  guideNumber: string; // virtual channel number, e.g. "5.1" (ATSC) or "5"
  guideName: string; // UTF-8 channel name
  url: string; // the device's raw MPEG-TS stream URL
  tags: string[]; // lower-cased Tags (e.g. "favorite", "drm")
  drm: boolean; // true → protected/unplayable (seeded Disabled on import)
}

// Normalize a user-supplied address into an http(s) base ORIGIN (scheme + host[:port], no path/query):
// accepts "192.168.1.100", "192.168.1.100:80", "http://192.168.1.100/", etc. A bare host gets http://.
// Returns null for an unparseable value or a non-http(s) scheme.
export function normalizeDeviceBase(raw: string): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return `${u.protocol}//${u.host}`;
}

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': UA, Accept: 'application/json,*/*' },
  });
  if (!r.ok) throw new Error(`http_${r.status}`);
  return r.json();
}

// GET <base>/discover.json → device identity. A tuner device exposes a LineupURL; we tolerate its absence by
// deriving the conventional <base>/lineup.json. TunerCount defaults to 1 if absent/zero (a safe floor for the cap).
export async function fetchDiscover(base: string): Promise<HdhrDiscover> {
  const j = (await getJson(`${base}/discover.json`)) as Record<string, unknown>;
  const tuner = Number(j.TunerCount);
  return {
    friendlyName: typeof j.FriendlyName === 'string' && j.FriendlyName ? j.FriendlyName : 'HDHomeRun',
    modelNumber: typeof j.ModelNumber === 'string' ? j.ModelNumber : '',
    firmwareVersion: typeof j.FirmwareVersion === 'string' ? j.FirmwareVersion : null,
    deviceId: typeof j.DeviceID === 'string' ? j.DeviceID : null,
    tunerCount: Number.isFinite(tuner) && tuner > 0 ? tuner : 1,
    baseUrl: typeof j.BaseURL === 'string' && j.BaseURL ? j.BaseURL : base,
    lineupUrl: typeof j.LineupURL === 'string' && j.LineupURL ? j.LineupURL : `${base}/lineup.json`,
  };
}

// GET <base>/lineup.json → the structured catalog (preferred over lineup.m3u for the import: it carries the
// canonical GuideNumber and the DRM tag). Malformed rows (no number/url) are dropped.
export async function fetchLineup(base: string): Promise<HdhrLineupEntry[]> {
  const rows = await getJson(`${base}/lineup.json`);
  if (!Array.isArray(rows)) throw new Error('lineup_not_array');
  return (rows as Array<Record<string, unknown>>)
    .map((c) => {
      const tags = (typeof c.Tags === 'string' ? c.Tags : '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      const guideNumber = c.GuideNumber == null ? '' : String(c.GuideNumber);
      return {
        guideNumber,
        guideName: typeof c.GuideName === 'string' && c.GuideName ? c.GuideName : guideNumber,
        url: typeof c.URL === 'string' ? c.URL : '',
        tags,
        drm: tags.includes('drm') || c.DRM === 1 || c.DRM === true,
      };
    })
    .filter((e) => e.guideNumber !== '' && e.url !== '');
}

// GET <base>/lineup.m3u → raw text. Used by the Test endpoint (the feature spec's "fetch a lineup.m3u"); the
// route parses it with the shared m3u parser for the human-readable channel summary.
export async function fetchLineupM3uText(base: string): Promise<string> {
  const r = await fetch(`${base}/lineup.m3u`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': UA, Accept: '*/*' },
  });
  if (!r.ok) throw new Error(`lineup_m3u_http_${r.status}`);
  return r.text();
}
