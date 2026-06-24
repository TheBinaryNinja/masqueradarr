// Resolve the UTC offset stamped onto every `programs` record at sync time. Reads the `settings` singleton's
// `offset` (itself derived from the operator's Time zone — see settings/translate.ts + settings/zoneOffset.ts)
// and reports whether it had to default. Every EPG write path (gracenote/epgpw/tubi/dlhd/xmltv) calls this so
// stored programs carry the operator's offset; a missing/blank value DEFAULTS TO UTC ('+0000') and flags
// `defaulted` so the caller can warn the user (a toast on a manual sync/upload/create; a log line otherwise).

import { Settings, SETTINGS_ID } from '../models/Settings.js';

const OFFSET_RE = /^[+-]\d{4}$/; // canonical '±HHMM'

export async function resolveProgramOffset(): Promise<{ offset: string; defaulted: boolean }> {
  const doc = await Settings.findById(SETTINGS_ID).lean<{ offset?: string } | null>();
  const o = doc?.offset;
  if (typeof o === 'string' && OFFSET_RE.test(o)) return { offset: o, defaulted: false };
  return { offset: '+0000', defaulted: true };
}
