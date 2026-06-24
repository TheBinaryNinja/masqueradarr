// parseDirectory.ts — pure HTML parsing for the dlhd 24/7 channel directory. Ported verbatim from
// ../d-combine/sources/dlhd/parse-directory.mjs.
//
// A LEAF module with zero imports on purpose: it is shared by both
//   · adapters/dlhd.ts                  (live listings: scrape ${BASE}/24-7-channels.php)
//   · adapters/dlhd/mirrorDirectory.ts  (probe: "does this candidate mirror serve channels?")
// so "a mirror works" is decided by the EXACT same extractor that produces the catalog.

/** One scraped directory card → the raw record listChannels() emits and normalize() consumes. */
export interface DlhdRawChannel {
  id: number;
  name: string;
  group: string;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)));
}

export function parseChannels(html: string): DlhdRawChannel[] {
  const seen = new Set<string>();
  const channels: DlhdRawChannel[] = [];
  // Split on each card anchor and pull fields out of the fragment (attribute order varies / spans
  // newlines, so per-field extraction is more robust than one big regex).
  for (const frag of html.split(/<a\s+class="card"/i).slice(1)) {
    const id = frag.match(/href="\/?watch\.php\?id=(\d+)"/i)?.[1];
    const rawName = frag.match(/<div[^>]*class="card__title"[^>]*>([^<]*)<\/div>/i)?.[1]?.trim();
    const name = rawName ? decodeEntities(rawName) : rawName;
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const first = (frag.match(/data-first="([^"]*)"/i)?.[1] || name[0] || '#').toUpperCase();
    const group = /[A-Z]/.test(first) ? first : '#';
    channels.push({ id: Number(id), name, group });
  }
  return channels;
}
