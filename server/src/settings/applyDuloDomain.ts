// Bridge between the persisted `settings` singleton and the dulo adapter's module-level domain cache.
// dulo rebrands periodically, so the domain it lives on is an operator setting (Settings.duloDomain) rather
// than a compile-time const; this reads it into config.setDomain() so the synchronous hot paths
// (upstreamHeaders / isAllowedUpstream) and every dulo fetch resolve it with NO DB hit. Mirrors
// applyDlhdPlayer: called after connect (boot, source 'mongo') and on every Settings PUT that touches
// duloDomain (source 'update'). Kept out of dulo/config.ts (a Mongo-free leaf) so config never imports the
// models layer.
//
// A CHANGED domain on 'update' cascades twice:
//   · resetSupabaseDiscovery() — the cached Supabase project pair was scraped from the OLD site and its
//     cooldown would otherwise suppress a re-scrape for minutes.
//   · duloAuth.signOut()      — a captured session belongs to the domain it was captured on; rather than
//     letting playback fail opaquely later, drop it and send the operator back through the pairing flow.
// Boot ('mongo') NEVER signs out — it is just hydrating the cache from what is already stored.

import { Settings, SETTINGS_ID, type SettingsDoc } from '../models/Settings.js';
import { DULO_DEFAULT_DOMAIN, getDomain, setDomain } from '../sources/adapters/dulo/config.js';
import { resetSupabaseDiscovery } from '../sources/adapters/dulo/supabaseConfig.js';
import { duloAuth } from '../sources/adapters/dulo/auth.js';
import { logger } from '../sources/core/logger.js';

const tag = 'dulo:auth';

export async function applyDuloDomainFromSettings(
  source: 'mongo' | 'update',
): Promise<{ domain: string; changed: boolean }> {
  const doc = (await Settings.findOne({ _id: SETTINGS_ID }, { duloDomain: 1 }).lean()) as Pick<
    SettingsDoc,
    'duloDomain'
  > | null;
  const changed = setDomain(doc?.duloDomain || DULO_DEFAULT_DOMAIN);
  const domain = getDomain();

  if (changed && source === 'update') {
    resetSupabaseDiscovery();
    await duloAuth.signOut();
    logger.warn(tag, `dulo domain changed to ${domain} — session signed out, re-pair required`);
  } else if (changed) {
    logger.info(tag, `dulo domain set to ${domain}`);
  }
  return { domain, changed };
}
