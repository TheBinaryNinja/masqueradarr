// Decode-metadata humanizers (DEC) — turn the raw HLS decode fields the Rust data plane parses from a
// manifest (streamTelemetry.MediaInfo) into the friendly labels the UI shows. Pure + source-agnostic +
// DB-free, so BOTH the live Active Streams surface (stats/statsHub.ts) and the scheduled channel probe
// (sources/probeAll.ts) share one source of truth — a channel's resolution reads "1080p" the same way on
// the Active Streams card and in the persisted stream.res pill.
//
// The raw CODECS list holds BOTH the video and audio codecs (e.g. "avc1.640028,mp4a.40.2"); each side is
// picked by its RFC 6381 fourcc prefix. Unknown values fall back to the raw string; a missing value is null.

/** First CODECS entry whose fourcc matches `re`, or null. */
function pickCodec(codecs: string | null, re: RegExp): string | null {
  if (!codecs) return null;
  return codecs.split(',').map((c) => c.trim()).find((c) => re.test(c)) ?? null;
}

export function humanVideoCodec(codecs: string | null): string | null {
  const v = pickCodec(codecs, /^(avc1|avc3|hvc1|hev1|dvh[1e]|av01|vp0?9|mp4v)/i);
  if (!v) return null;
  const p = v.toLowerCase();
  if (p.startsWith('avc1') || p.startsWith('avc3')) return 'H.264';
  if (p.startsWith('hvc1') || p.startsWith('hev1') || p.startsWith('dvh')) return 'H.265';
  if (p.startsWith('av01')) return 'AV1';
  if (p.startsWith('vp9') || p.startsWith('vp09')) return 'VP9';
  if (p.startsWith('mp4v')) return 'MPEG-4';
  return v;
}

export function humanAudioCodec(codecs: string | null): string | null {
  const a = pickCodec(codecs, /^(mp4a|ac-3|ec-3|opus|flac|alac|dts)/i);
  if (!a) return null;
  const p = a.toLowerCase();
  if (p.startsWith('mp4a')) return 'AAC';
  if (p.startsWith('ac-3')) return 'AC-3';
  if (p.startsWith('ec-3')) return 'E-AC-3';
  if (p.startsWith('opus')) return 'Opus';
  if (p.startsWith('flac')) return 'FLAC';
  if (p.startsWith('alac')) return 'ALAC';
  if (p.startsWith('dts')) return 'DTS';
  return a;
}

export function humanContainer(container: string | null): string | null {
  if (!container) return null;
  if (container === 'fmp4') return 'fMP4';
  if (container === 'ts') return 'MPEG-TS';
  return container;
}

// Common broadcast heights → friendly labels; anything else keeps the raw "WxH".
const RES_LABELS: Record<number, string> = {
  4320: '8K', 2160: '4K', 1440: '1440p', 1080: '1080p', 720: '720p', 576: '576p', 480: '480p', 360: '360p', 240: '240p',
};
export function humanResolution(res: string | null): string | null {
  if (!res) return null;
  const m = /^(\d+)x(\d+)$/.exec(res);
  if (!m) return res;
  return RES_LABELS[Number(m[2])] ?? res;
}

export function parseFps(frameRate: string | null): number | null {
  if (!frameRate) return null;
  const n = Number.parseFloat(frameRate);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
