// Bridge between the persisted `settings` singleton and the dlhd resolver's module-level player-default cache.
// The source-wide default DaddyLive player (Settings.dlhdPlayer) is read into config.setPlayerDefault() so the
// hot resolve path (resolveSeam.buildGrant → dlhd/resolveStream) reads it with NO DB hit. Mirrors applyDns:
// called after connect (boot, source 'mongo') and on every Settings PUT that touches dlhdPlayer (source
// 'update'). Kept out of dlhd/config.ts (a Mongo-free leaf) so config never imports the models layer.

import { Settings, SETTINGS_ID, type SettingsDoc } from '../models/Settings.js';
import { setPlayerDefault } from '../sources/adapters/dlhd/config.js';

export async function applyDlhdPlayerFromSettings(source: 'mongo' | 'update'): Promise<void> {
  const doc = (await Settings.findOne({ _id: SETTINGS_ID }, { dlhdPlayer: 1 }).lean()) as Pick<
    SettingsDoc,
    'dlhdPlayer'
  > | null;
  setPlayerDefault(typeof doc?.dlhdPlayer === 'number' ? doc.dlhdPlayer : 0);
  void source; // symmetry with applyDnsFromSettings; no phase-specific behavior needed here
}
