// Bridge between the persisted `settings` singleton and the side-effect-only dns.ts module. dns.ts is
// imported FIRST in index.ts (before Mongo connects) and must stay Mongo-free, so the Settings read lives
// here instead. applyDnsFromSettings() reads the singleton's nameservers + dnsLogLevel and (re)installs the
// global fetch() DNS dispatcher via applyDnsSettings(). Called after connect (boot, source 'mongo') and on
// every Settings PUT that touches nameservers/dnsLogLevel (source 'update') — so the runtime resolver and
// trace verbosity track the persisted value live, no restart needed.

import { Settings, SETTINGS_ID, type SettingsDoc } from '../models/Settings.js';
import { applyDnsSettings } from '../dns.js';

export async function applyDnsFromSettings(source: 'mongo' | 'update'): Promise<void> {
  const doc = (await Settings.findOne({ _id: SETTINGS_ID }).lean()) as SettingsDoc | null;
  applyDnsSettings(doc?.nameservers ?? null, doc?.dnsLogLevel ?? 2, source);
}
