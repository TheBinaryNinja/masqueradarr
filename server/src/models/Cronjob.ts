// Cron job registration for scheduled, recurring work against a target resource (today: EPG sources).
// Keyed by a deterministic _id = "<targetType>:<targetId>" so a save is an idempotent upsert and a delete
// is by id — created/updated/deleted cleanly. Stores BOTH the machine cron string (what the scheduler
// runs, croner-validated) AND the structured `frequency` builder state, so the Edit UI can re-render the
// frequency builder faithfully without reverse-parsing a cron expression. The scheduler subsystem
// (scheduler/index.ts) reads these and runs them; nextRun/lastRun/lastStatus are scheduler-maintained.
// See restapi.md (the /api/cronjobs resource) + schemas.md §3.13.

import { Schema, model } from 'mongoose';

// Structured frequency builder state. `mode` selects which of the other fields are meaningful:
//   minutes/hourly → `every`; daily → `atHour`/`atMinute`; weekly → `daysOfWeek` + `atHour`/`atMinute`;
//   custom → none (the raw `cron` is authoritative). Fields not used by the mode are null.
export interface CronFrequency {
  mode: 'minutes' | 'hourly' | 'daily' | 'weekly' | 'custom';
  every: number | null;
  atHour: number | null;
  atMinute: number | null;
  daysOfWeek: number[] | null; // 0 (Sun) .. 6 (Sat)
}

export interface CronjobDoc {
  _id: string; // "<targetType>:<targetId>"
  targetType: string; // 'epg-source' (EPG sync) | 'playlist' | 'playlist-m3u' | 'probe-all'; extensible — the scheduler switches on this
  targetId: string; // the target resource id (e.g. EpgSource.id)
  cron: string; // 5-field expression the scheduler runs (croner-validated)
  frequency: CronFrequency;
  timezone: string | null; // defaults to the app settings timezone when set by the client
  enabled: boolean;
  lastRun: string | null; // ISO; set by the scheduler tick
  nextRun: string | null; // ISO; computed from the croner instance
  lastStatus: string | null; // 'pending' | 'success' | 'error'
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

// Deterministic id builder — the single place the composite key is formed.
export function cronjobId(targetType: string, targetId: string): string {
  return `${targetType}:${targetId}`;
}

const CronFrequencySchema = new Schema<CronFrequency>(
  {
    mode: { type: String, required: true },
    every: { type: Number, default: null },
    atHour: { type: Number, default: null },
    atMinute: { type: Number, default: null },
    daysOfWeek: { type: [Number], default: null },
  },
  { _id: false, versionKey: false },
);

const CronjobSchema = new Schema<CronjobDoc>(
  {
    _id: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: String, required: true },
    cron: { type: String, required: true },
    frequency: { type: CronFrequencySchema, required: true },
    timezone: { type: String, default: null },
    enabled: { type: Boolean, required: true, default: true },
    lastRun: { type: String, default: null },
    nextRun: { type: String, default: null },
    lastStatus: { type: String, default: null },
    lastError: { type: String, default: null },
    createdAt: { type: String, required: true },
    updatedAt: { type: String, required: true },
  },
  { versionKey: false },
);

// Covers the per-target job lookup (the EPG detail schedule cards read a target's job(s) by targetId).
CronjobSchema.index({ targetId: 1 });
// Covers the scheduler's startup load of jobs to register.
CronjobSchema.index({ enabled: 1 });

export const Cronjob = model<CronjobDoc>('Cronjob', CronjobSchema);
