// Samsung TV Plus — shared leaf constants imported by BOTH the adapter (sources/adapters/samsung.ts) and the
// EPG module (epg/samsung.ts), so neither imports the other (mirrors adapters/dlhd/config.ts as an acyclic
// leaf). Samsung's catalog + per-region XMLTV guide come from Matt Huisman's public mirror (i.mjh.nz); each
// channel's stream is a jmp2.uk short link that 302-redirects to the real (token-bearing, rotating) CDN master
// — resolved per play in the adapter's resolveStream. Region selection is an env knob (SAMSUNG_REGIONS, default
// 'us'); a per-playlist config UI is a cross-cutting follow-up.

export const ALLOWED_REGIONS = ['us', 'ca', 'gb', 'de', 'fr', 'es', 'it', 'kr', 'in', 'at', 'ch'] as const;

/** Gzip JSON catalog: { regions: { <code>: { channels: { <chId>: { name, logo, group, chno, license_url? } } } } }. */
export const CHANNELS_URL = 'https://i.mjh.nz/SamsungTVPlus/.channels.json.gz';
/** Gzip XMLTV guide, one file per region ({region} substituted). */
export const EPG_URL = 'https://i.mjh.nz/SamsungTVPlus/{region}.xml.gz';
/** Per-channel stream entry: a jmp2.uk short link that 302-redirects to the real CDN master (resolved per play). */
export const STREAM_URL = 'https://jmp2.uk/stvp-{id}';

// mjh.nz + jmp2.uk serve a plain client UA fine; match FastChannels' okhttp client.
export const UA = process.env.SAMSUNG_UA || 'okhttp/4.12.0';

// SSRF allowlist seed for the stream proxy. jmp2.uk is the entry short-link host; the rest are the Samsung CDN
// families the redirect lands on. The adapter's dynamic allow-set grows this at runtime with the resolved
// master host (resolveStream) + every child host seen inside a resolved playlist (private IPs always blocked).
export const SAMSUNG_SUFFIXES = [
  'jmp2.uk',
  'samsungtv.plus',
  'akamaized.net',
  'googlevideo.com',
  'google.com',
  'doubleclick.net',
];

/** Requested Samsung regions: env SAMSUNG_REGIONS (csv/space), validated against ALLOWED_REGIONS; default ['us']. */
export function samsungRegions(): string[] {
  const raw = String(process.env.SAMSUNG_REGIONS || '').trim();
  if (!raw) return ['us'];
  const wanted = raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid = wanted.filter((r) => (ALLOWED_REGIONS as readonly string[]).includes(r));
  return valid.length ? [...new Set(valid)] : ['us'];
}
