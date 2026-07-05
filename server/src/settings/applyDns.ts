// Bridge between the persisted `settings` singleton and the side-effect-only dns.ts module. dns.ts is
// imported FIRST in index.ts (before Mongo connects) and must stay Mongo-free, so the Settings read lives
// here instead. applyDnsFromSettings() reads the singleton's nameservers + logLevel and (re)installs the
// global fetch() DNS dispatcher via applyDnsSettings(). Because `logLevel` is now the ONE global verbosity
// (was dnsLogLevel — it governs the app AND the Rust proxy engine), this same read also pushes the level to
// proxy/logLevel.ts, from where the sidecar picks it up (env at spawn + echoed on the internal seam). Called
// after connect (boot, source 'mongo') and on every Settings PUT that touches nameservers/logLevel (source
// 'update') — so the runtime resolver, trace verbosity, and the engine's verbosity all track the value live.

import { Settings, SETTINGS_ID, type SettingsDoc } from '../models/Settings.js';
import { applyDnsSettings } from '../dns.js';
import { setProxyLogLevel } from '../proxy/logLevel.js';

export async function applyDnsFromSettings(source: 'mongo' | 'update'): Promise<void> {
  const doc = (await Settings.findOne({ _id: SETTINGS_ID }).lean()) as SettingsDoc | null;
  const logLevel = doc?.logLevel ?? 2;
  applyDnsSettings(doc?.nameservers ?? null, logLevel, source);
  setProxyLogLevel(logLevel); // keep the proxy-engine verbosity in lockstep with the global knob
}
