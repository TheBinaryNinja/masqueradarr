import { Schema, model } from 'mongoose';

// PlaylistAuth (playlistauths) — the per-playlist authenticated-session store. One row per playlist that
// requires authentication to stream; the row traces back to its owning playlist via `playlistSource`.
//
// dulo.tv is the first (and today only) such source: it removed the static `source_url` from its catalog
// and mints Live TV streams per play behind a Supabase JWT (POST /api/live-tv/playback-session). This
// collection persists the captured session so the server can resolve streams across restarts. **Only
// tokens are stored — never the user's password**: the SPA captures the already-signed-in session from
// the source's own login page and the server keeps only the access/refresh tokens (see
// sources/adapters/dulo/auth.ts). The Supabase/device fields below are dulo-specific and stay nullable so
// a future non-Supabase auth source leaves them null.
//
// Deterministic `_id = playlistSource` keeps it a singleton PER SOURCE, upserted idempotently and durable
// across reseeds/factory-resets (unlike the Playlist's auto-generated ObjectId). The unique index on
// `playlistSource` enforces the 1:1 playlist↔auth relationship.

export interface PlaylistAuthDoc {
  _id: string; // = playlistSource (the owning source/playlist key, e.g. 'dulo')
  playlistSource: string; // durable owner key (=== _id); the Playlist.source / Playlist.id it belongs to
  playlist_id: string | null; // owning Playlist's ObjectId hex — informational only (refreshed; not a key)
  accessToken: string | null; // Supabase JWT — Bearer for dulo /api/live-tv/* (≈1h TTL)
  refreshToken: string | null; // Supabase refresh token — mints fresh access tokens
  expiresAt: number | null; // ms epoch when accessToken expires
  supabaseUrl: string | null; // https://<ref>.supabase.co — derived from the JWT; used to refresh
  anonKey: string | null; // dulo's PUBLIC supabase anon key (not a secret) — required `apikey` to refresh
  deviceFingerprint: string; // stable id we generate once and register with the source
  deviceId: string | null; // id returned by activate-device
  deviceName: string | null; // label shown in the source's device list
  status: string; // 'signed_out' | 'active' | 'reauth_required' | 'blocked' | 'error'
  blockReason: string | null; // access-status block.reason (no subscription / evicted by another session)
  lastError: string | null;
  updatedAt: string; // ISO of the last write
}

const PlaylistAuthSchema = new Schema<PlaylistAuthDoc>(
  {
    _id: { type: String, required: true },
    playlistSource: { type: String, required: true },
    playlist_id: { type: String, default: null },
    accessToken: { type: String, default: null },
    refreshToken: { type: String, default: null },
    expiresAt: { type: Number, default: null },
    supabaseUrl: { type: String, default: null },
    anonKey: { type: String, default: null },
    deviceFingerprint: { type: String, required: true },
    deviceId: { type: String, default: null },
    deviceName: { type: String, default: null },
    status: { type: String, required: true, default: 'signed_out' },
    blockReason: { type: String, default: null },
    lastError: { type: String, default: null },
    updatedAt: { type: String, required: true },
  },
  { versionKey: false },
);

// One auth doc per playlist source — enforces the 1:1 playlist↔auth relationship and serves lookup by owner.
PlaylistAuthSchema.index({ playlistSource: 1 }, { unique: true });

export const PlaylistAuth = model<PlaylistAuthDoc>('PlaylistAuth', PlaylistAuthSchema);
