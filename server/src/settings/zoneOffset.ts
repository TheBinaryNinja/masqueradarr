// IANA time zone → numeric UTC offset string ("±HHMM"), DST-aware at a given instant. The single place the
// Settings `offset` field is derived from `timezone` (see settings/translate.ts). Pure, no I/O — Node 22
// ships full ICU, so no tz library is needed. Mirrors the two-step zoned conversion in epg/dlhd.ts
// (tzOffsetMs): format the UTC instant AS the zone's wall-clock, read it back as if UTC, and diff.

// Offset (ms) of `tz` from UTC at `atMs`. Returns NaN for an unknown/blank zone (Intl throws).
function zoneOffsetMs(tz: string, atMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(atMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - atMs; // zone wall-clock = UTC + offset
}

// IANA zone (e.g. 'America/New_York') → '±HHMM' at `atMs` (default now). DST-aware, so the value reflects
// the offset in effect at that instant ('-0400' in summer, '-0500' in winter). Falls back to '+0000' on an
// unknown zone (Intl throws) so a bad value can never propagate as NaN.
export function zoneOffsetString(tz: string, atMs: number = Date.now()): string {
  let offMin: number;
  try {
    offMin = Math.round(zoneOffsetMs(tz, atMs) / 60000);
  } catch {
    return '+0000';
  }
  if (!Number.isFinite(offMin)) return '+0000';
  const sign = offMin < 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  return sign + String(Math.floor(abs / 60)).padStart(2, '0') + String(abs % 60).padStart(2, '0');
}
