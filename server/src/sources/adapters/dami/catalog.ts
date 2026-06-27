// dami catalog — fetch + parse dami-tv.pro's published channel catalog (/data/dlhd-channels.json), with the
// committed snapshot fallback. The dami analogue of dlhd's listChannels()/parseDirectory, but dami publishes a
// clean JSON catalog (no HTML scrape) that ALSO carries logos + ISO country codes — richer than dlhd's bare
// directory. dami's channel ids ARE DaddyLive premium ids, so the rest of the adapter delegates resolve/proxy
// to dlhd's leaf modules; this module only owns the catalog fetch + the country → group label mapping.

import { readFileSync } from 'node:fs';
import { snapshotFile } from '../../paths.js';
import type { RawListing } from '../../types.js';

// Override the origin/catalog URL/UA via env (DAMI_BASE pins the host; the catalog is a static JSON asset).
export const DAMI_BASE = String(process.env.DAMI_BASE || 'https://dami-tv.pro').replace(/\/+$/, '');
export const DAMI_CATALOG_URL = process.env.DAMI_CATALOG_URL || `${DAMI_BASE}/data/dlhd-channels.json`;

// A normal desktop-browser User-Agent — dami's edge (Cloudflare) is happy with a plain UA on the static
// catalog + the documented papi endpoints; an obvious bot UA risks a challenge.
export const UA =
  process.env.DAMI_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

export interface DamiRawChannel {
  id: number;
  name: string;
  image: string | null;
  country: string | null;
}

const SNAPSHOT = snapshotFile('dami');

/**
 * Fetch the dami channel catalog (live), or fall back to the committed snapshot when offline / blocked. The
 * snapshot covers the CATALOG only — stream resolution still needs a reachable DaddyLive mirror (dami channel
 * ids are DaddyLive ids; resolveStream has no offline path). meta.live === false flips the playlist to 'warn'
 * (buildSource), exactly like dlhd's offline path.
 */
export async function fetchDamiCatalog(): Promise<RawListing> {
  try {
    const res = await fetch(DAMI_CATALOG_URL, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { channels?: DamiRawChannel[]; updated?: number; count?: number };
    const channels = Array.isArray(json.channels) ? json.channels : [];
    if (!channels.length) throw new Error('no channels in catalog (shape changed?)');
    return {
      raw: channels,
      meta: {
        endpoint: DAMI_CATALOG_URL,
        live: true,
        channelCount: channels.length,
        updated: json.updated ?? null,
        fetchedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { channels?: DamiRawChannel[] };
    return {
      raw: snap.channels || [],
      meta: {
        endpoint: DAMI_CATALOG_URL,
        live: false,
        fallback: 'dami.snapshot.json',
        reason: (err as Error).message,
        fetchedAt: new Date().toISOString(),
      },
    };
  }
}

// ISO-3166 alpha-2 → friendly country label for the UI group buckets (dami's catalog carries a `country` code
// on every channel — the data-backed grouping). Codes outside this map fall back to their upper-cased value
// (covers dami's non-ISO buckets like "international"/"arabic"); a blank code groups under "Other".
const COUNTRY_NAMES: Record<string, string> = {
  us: 'United States', gb: 'United Kingdom', uk: 'United Kingdom', ca: 'Canada', fr: 'France',
  de: 'Germany', it: 'Italy', es: 'Spain', pt: 'Portugal', nl: 'Netherlands', be: 'Belgium',
  pl: 'Poland', cz: 'Czech Republic', sk: 'Slovakia', gr: 'Greece', il: 'Israel', bg: 'Bulgaria',
  za: 'South Africa', rs: 'Serbia', hr: 'Croatia', dk: 'Denmark', se: 'Sweden', no: 'Norway',
  fi: 'Finland', mx: 'Mexico', br: 'Brazil', ar: 'Argentina', cl: 'Chile', co: 'Colombia',
  uy: 'Uruguay', tr: 'Turkey', ro: 'Romania', hu: 'Hungary', at: 'Austria', ch: 'Switzerland',
  ie: 'Ireland', nz: 'New Zealand', au: 'Australia', qa: 'Qatar', ae: 'UAE', sa: 'Saudi Arabia',
  cy: 'Cyprus', ru: 'Russia', in: 'India', pk: 'Pakistan', bd: 'Bangladesh', my: 'Malaysia',
  eg: 'Egypt', ba: 'Bosnia & Herzegovina', international: 'International', arabic: 'Arabic',
};

/** Map a catalog `country` code to its UI group label (friendly name, else upper-cased code, else "Other"). */
export function countryGroup(code: string | null | undefined): string {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return 'Other';
  return COUNTRY_NAMES[c] || c.toUpperCase();
}
