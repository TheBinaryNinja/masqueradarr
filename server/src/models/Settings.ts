import { Schema, model } from 'mongoose';

// Settings — a single application-settings document. Deterministic _id ('app') makes every read/write
// a singleton upsert (same idempotency rule as the synced collections). It holds operator-facing values
// the SPA edits on the Settings screen that the *server* also needs at runtime, and that must survive a
// restart:
//   - displayName  — burned into the server-rendered B-Roll placeholder card (headless clients see it).
//   - domain       — base URL of every hosted endpoint; drives each playlist's persisted `url` (HOSTED AT)
//                    and the settings→playlists url cascade (see routes/settings.ts + routes/playlists.ts).
//   - timezone / darkMode — operator preferences. `offset` is the DST-aware UTC offset ('±HHMM') DERIVED
//     from `timezone` server-side whenever it's saved (settings/zoneOffset.ts) — it's stamped onto every
//     synced `programs` record (settings/programOffset.ts) and emitted by the composed XMLTV guide.
//   - nameservers  — comma-separated resolver IP(s) for the app's OUTBOUND fetch() DNS (M3U/EPG/mirror
//                    scrapes + the HLS proxy). Seeded on first provision ONLY ($setOnInsert) with the
//                    hardcoded DEFAULT_NAMESERVERS ('8.8.8.8,8.8.4.4' — Google public DNS; the NAMESERVER
//                    env was dropped); thereafter Mongo is authoritative. Read + re-applied live by dns.ts
//                    (settings/applyDns.ts) after connect and on every change. null/blank = OS resolver.
//   - logLevel     — the GLOBAL 1|2|3 log verbosity for the whole app AND the Rust proxy engine (formerly
//                    `dnsLogLevel`, repurposed into the one master knob): 1 = lifecycle + issues only;
//                    2 = + milestones (incl. per-host DNS resolution, deduped); 3 = full per-stage/hop/segment
//                    lineage (every DNS lookup + the Rust data plane's whole resolve→fetch→repackage→serve
//                    path). Read + re-applied live by dns.ts (settings/applyDns.ts) and pushed to the Rust
//                    sidecar (settings/applyDns.ts → proxy/logLevel.ts, echoed back on the internal seam).
//   - maxmind*     — MaxMind GeoLite2 web-service credentials (account id + license key) used by
//                    geoip/geoip.ts to resolve viewer IPs → geolocation on the Active Streams + History
//                    screens. The license key is a SECRET: never returned by the API (the GET /api/settings
//                    read is public) — translate.ts redacts it to a `maxmindLicenseKeySet` boolean.
//   - user         — placeholder for per-user settings (populated later; stored as an opaque object).
//   - videoPlayer  — which in-app player the channel slide-out renders: 'inapp' (default) or 'debug' (a
//                    diagnostic HUD with a live hls.js status readout + event log). Global operator toggle,
//                    edited on the Settings screen; consumed only by the SPA.
//   - dlhdPlayer   — source-wide DEFAULT upstream player for DaddyLive (dlhd/dami) channels that expose several
//                    (0 = Auto/first; 1..N = a specific player). A per-channel override (PlaylistChannel.playerPref)
//                    wins over it. Cached into the dlhd resolver at boot + on every save (settings/applyDlhdPlayer.ts)
//                    so the hot resolve path reads it with no DB hit.
// (Per-source sync/auto-match is governed by the cronjobs scheduler, not by a global settings flag.)
// These are APP settings (persisted in Mongo); they are distinct from infra config
// (mongoUri/port/logLevel in config.json via MASQUERADARR_CONFIG — see config.ts). First-boot values are seeded
// from environment variables (sources/seedSettings.ts, $setOnInsert, so a redeploy never clobbers UI edits)
// — except `nameservers`, which seeds from a hardcoded default (DEFAULT_NAMESERVERS in settings/translate.ts).
// The internal<->external boundary — env->doc defaults, doc->runtime projection, and request->$set patch —
// lives in settings/translate.ts (the Settings analogue of sources/toPlaylistChannel.ts).

export interface SettingsDoc {
  _id: string; // always 'app' — singleton row
  displayName: string;
  domain: string;
  timezone: string;
  offset: string; // DST-aware UTC offset ('±HHMM') derived from `timezone` on save; stamped onto programs + emitted in the guide
  darkMode: boolean;
  videoPlayer: 'inapp' | 'debug'; // which in-app player the channel slide-out renders ('inapp' default; 'debug' = diagnostic HUD)
  dlhdPlayer: number; // source-wide default DaddyLive player (0 = Auto/first; 1..N) for dlhd/dami channels without a per-channel override
  nameservers: string | null; // comma-separated outbound-fetch resolver IP(s); null/blank = OS resolver (DEFAULT_NAMESERVERS 8.8.8.8,8.8.4.4 seeds first boot)
  logLevel: number; // GLOBAL 1|2|3 log verbosity — app + Rust proxy engine (default 2; formerly dnsLogLevel)
  maxmindAccountId: string | null; // MaxMind GeoLite2 web-service account id (null = geo disabled)
  maxmindLicenseKey: string | null; // MaxMind GeoLite2 license key — SECRET, redacted by translate.ts on read
  user: Record<string, unknown>; // placeholder for per-user settings; opaque object for now
  backupLocation: string; // absolute on-disk dir for scheduled + saved backups; default '/backups' (BACKUPS_DIR env)
}

export const SETTINGS_ID = 'app';

const SettingsSchema = new Schema<SettingsDoc>(
  {
    _id: { type: String, required: true },
    displayName: { type: String, required: true, default: 'TVApp2' },
    domain: { type: String, required: true, default: 'http://localhost:3000' },
    timezone: { type: String, required: true, default: 'America/New_York' },
    offset: { type: String, required: true, default: '+0000' },
    darkMode: { type: Boolean, required: true, default: true },
    videoPlayer: { type: String, required: true, default: 'inapp' },
    dlhdPlayer: { type: Number, required: true, default: 0 }, // 0 = Auto; 1..N = source-wide default DaddyLive player
    nameservers: { type: String, default: null },
    logLevel: { type: Number, required: true, default: 2 },
    maxmindAccountId: { type: String, default: null },
    maxmindLicenseKey: { type: String, default: null },
    user: { type: Schema.Types.Mixed, default: {} },
    backupLocation: { type: String, required: true, default: '/backups' },
  },
  { versionKey: false },
);

export const Settings = model<SettingsDoc>('Settings', SettingsSchema);
