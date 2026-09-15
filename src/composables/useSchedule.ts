
import type { CronFrequency } from '../data';

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function hm(h: number, m: number): string {
  return `${pad2(clamp(h, 0, 23))}:${pad2(clamp(m, 0, 59))}`;
}


export const WEEKDAYS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

export const FREQUENCY_MODES = [
  { value: 'minutes', label: 'Minutes', icon: 'refresh' },
  { value: 'hourly', label: 'Hourly', icon: 'refresh' },
  { value: 'daily', label: 'Daily', icon: 'sync' },
  { value: 'weekly', label: 'Weekly', icon: 'sync' },
  { value: 'custom', label: 'Custom', icon: 'edit' },
];

export function defaultFrequency(): CronFrequency {
  return { mode: 'hourly', every: 6, atHour: null, atMinute: 0, daysOfWeek: null };
}

export function buildCron(f: CronFrequency, rawCron = ''): string {
  switch (f.mode) {
    case 'minutes': {
      const n = clamp(f.every ?? 15, 1, 59);
      return `*/${n} * * * *`;
    }
    case 'hourly': {
      const n = clamp(f.every ?? 6, 1, 23);
      const m = clamp(f.atMinute ?? 0, 0, 59);
      return `${m} */${n} * * *`;
    }
    case 'daily': {
      const h = clamp(f.atHour ?? 3, 0, 23);
      const m = clamp(f.atMinute ?? 0, 0, 59);
      return `${m} ${h} * * *`;
    }
    case 'weekly': {
      const h = clamp(f.atHour ?? 4, 0, 23);
      const m = clamp(f.atMinute ?? 0, 0, 59);
      const days = (f.daysOfWeek && f.daysOfWeek.length ? [...f.daysOfWeek].sort((a, b) => a - b) : [0]).join(',');
      return `${m} ${h} * * ${days}`;
    }
    case 'custom':
    default:
      return rawCron.trim();
  }
}

export function summarizeFrequency(f: CronFrequency, rawCron = ''): string {
  switch (f.mode) {
    case 'minutes': {
      const n = clamp(f.every ?? 15, 1, 59);
      return n === 1 ? 'Every minute' : `Every ${n} minutes`;
    }
    case 'hourly': {
      const n = clamp(f.every ?? 6, 1, 23);
      return n === 1 ? 'Every hour' : `Every ${n} hours`;
    }
    case 'daily':
      return `Daily at ${hm(f.atHour ?? 3, f.atMinute ?? 0)}`;
    case 'weekly': {
      const days = (f.daysOfWeek && f.daysOfWeek.length ? [...f.daysOfWeek].sort((a, b) => a - b) : [0])
        .map((d) => WEEKDAYS[d]?.label ?? d)
        .join(', ');
      return `Weekly on ${days} at ${hm(f.atHour ?? 4, f.atMinute ?? 0)}`;
    }
    case 'custom':
    default:
      return rawCron.trim() ? `Custom (${rawCron.trim()})` : 'Custom schedule';
  }
}


export interface SchedulePreset {
  label: string;
  cron: string;
  next: string;
}

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { label: 'Every 15 minutes', cron: '*/15 * * * *', next: 'in 8 min' },
  { label: 'Every 30 minutes', cron: '*/30 * * * *', next: 'in 22 min' },
  { label: 'Every hour', cron: '0 * * * *', next: 'in 38 min' },
  { label: 'Every 6 hours', cron: '0 */6 * * *', next: 'in 3h 12m' },
  { label: 'Every 12 hours', cron: '0 */12 * * *', next: 'in 8h 41m' },
  { label: 'Daily at 03:00', cron: '0 3 * * *', next: 'tomorrow 03:00' },
  { label: 'Daily at 06:00', cron: '0 6 * * *', next: 'tomorrow 06:00' },
  { label: 'Weekly (Sun 04:00)', cron: '0 4 * * 0', next: 'Sun 04:00' },
];

export function presetMatch(cron: string): boolean {
  return SCHEDULE_PRESETS.some((p) => p.cron === cron);
}

export function nextRunForCron(cron: string): string {
  return SCHEDULE_PRESETS.find((p) => p.cron === cron)?.next || '—';
}

export function defaultCronFor(interval: string): string {
  const v = (interval ?? '').toLowerCase();
  if (v === 'every 6 hours') return '0 */6 * * *';
  if (v === 'every 12 hours') return '0 */12 * * *';
  if (v === 'daily') return '0 3 * * *';
  if (v === 'auto-updated') return '0 */6 * * *';
  return '0 3 * * *';
}
