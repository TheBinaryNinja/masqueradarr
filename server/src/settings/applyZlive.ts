// Bridge between the persisted `settings` singleton and the zlive adapter's module-level caches. Two settings:
//   · zliveDomain     → config.setDomain(): the catalog (cast.<domain>) and stream resolver (iptv.<domain>) move
//                       with it at once. A CHANGED domain also bumps the leaf's domain epoch, which the resolver
//                       notices on its next call and drops its per-slug target cache, decoy latches and last-good
//                       Location suffix — all of that described the deployment the operator just switched away
//                       from. No sign-out cascade (unlike dulo): zlive has no session, and stored channel entries
//                       are host-free `zlive://<slug>` sentinels, so nothing else needs rewriting.
//   · zliveMaxStreams → config.setMaxStreams(): read by the adapter's maxConcurrentStreams() on every live
//                       resolve, so a new cap applies to the next stream start with no restart.
// Mirrors applyDuloDomain: called after connect (boot, source 'mongo'), on every Settings PUT that touches either
// field (source 'update'), and after a backup restore ('mongo'). Kept out of zlive/config.ts (a Mongo-free leaf) so
// config never imports the models layer.

import { Settings, SETTINGS_ID, type SettingsDoc } from '../models/Settings.js';
import {
  ZLIVE_DEFAULT_DOMAIN,
  ZLIVE_DEFAULT_MAX_STREAMS,
  getDomain,
  getMaxStreams,
  setDomain,
  setMaxStreams,
} from '../sources/adapters/zlive/config.js';
import { logger } from '../sources/core/logger.js';

const tag = 'zlive';

export async function applyZliveFromSettings(
  source: 'mongo' | 'update',
): Promise<{ domain: string; maxStreams: number; changed: boolean }> {
  const doc = (await Settings.findOne({ _id: SETTINGS_ID }, { zliveDomain: 1, zliveMaxStreams: 1 }).lean()) as Pick<
    SettingsDoc,
    'zliveDomain' | 'zliveMaxStreams'
  > | null;
  const changed = setDomain(doc?.zliveDomain || ZLIVE_DEFAULT_DOMAIN);
  const prevCap = getMaxStreams();
  setMaxStreams(typeof doc?.zliveMaxStreams === 'number' ? doc.zliveMaxStreams : ZLIVE_DEFAULT_MAX_STREAMS);
  const domain = getDomain();
  const maxStreams = getMaxStreams();

  if (changed && source === 'update') {
    logger.warn(tag, `zlive domain changed to ${domain} — resolver cache and decoy state reset; re-sync the ZLive playlist to refresh its catalog`);
  } else if (changed) {
    logger.info(tag, `zlive domain set to ${domain}`);
  }
  if (source === 'update' && maxStreams !== prevCap) {
    logger.info(tag, `zlive stream cap set to ${maxStreams === 0 ? 'unlimited' : maxStreams}`);
  }
  return { domain, maxStreams, changed };
}
