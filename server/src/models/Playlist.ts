import { Schema, model } from 'mongoose';

const PlaylistSchema = new Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    // The hosted URL this playlist is served at (shown as "HOSTED AT"). For a Global-endpoint playlist
    // it is the global M3U endpoint (settings.domain + the global m3u path); for Custom it is
    // settings.domain + the playlist's custom path. Both prepend the global domain, so a domain change in
    // Settings cascades to this field for every playlist (routes/settings.ts → cascadePlaylistUrls).
    url: { type: String, required: true },
    // 'global' (served via the consolidated M3U endpoint) | 'custom' (served at its own path). Stored
    // LOWERCASE (the repo-wide source-type normalization); a pre-normalization doc is migrated at boot.
    endpoint: { type: String, required: true, default: 'global' },
    // Active/Inactive — when false the endpoint is paused (downstream clients get 404).
    state: { type: Boolean, required: true, default: true },
    groups: { type: Number, required: true },
    lastSync: { type: String, required: true },
    status: { type: String, required: true },
    auto: { type: Boolean, required: true },
    interval: { type: String, required: true },
    builtin: { type: Boolean },
    // Set for the established (Default) source playlists (dulo/common/dlhd). When present, the
    // playlist's channels live in the PlaylistChannel collection (queried by this `source`). Unset for
    // legacy/mock playlists.
    source: { type: String, default: null, index: true },
    // HDHomeRun device fields — set ONLY for an HDHomeRun-import playlist (source:'hdhomerun'); null for every
    // other playlist. `deviceUrl` is the LAN base origin (e.g. http://192.168.1.50) the sync + stream remux
    // reach; it is a DEVICE ADDRESS, not the hosted url, so the settings domain→url cascade (cascadePlaylistUrls)
    // leaves it untouched. `deviceTunerCount` is the discover.json TunerCount (the concurrent-stream cap honored
    // by the remux); `deviceName` is the FriendlyName (display). See restapi-sources/SKILL.md (HDHomeRun).
    deviceUrl: { type: String, default: null },
    deviceTunerCount: { type: Number, default: null },
    deviceName: { type: String, default: null },
    // Remote-URL import source — set ONLY for a remote-URL m3u import playlist (source:'url'); null for every
    // other playlist. The upstream `.m3u`/`.m3u8` URL the create import fetched, persisted so a manual
    // "Sync now" (POST /api/custom-playlists/:id/sync) or a scheduled sync can RE-FETCH + reconcile this
    // playlist's channels from the same upstream. Unlike `deviceUrl` (a LAN device address), this is an
    // import SOURCE URL, not the hosted url — so the settings domain→url cascade (cascadePlaylistUrls)
    // leaves it untouched. Explicit null for every non-'url' playlist (never fabricated).
    remoteUrl: { type: String, default: null },
    // Does this playlist require authentication to stream? Source-intrinsic — set from
    // adapter.requiresAuth by upsertPlaylistRow ($set, refreshed every sync). false for non-auth playlists.
    authentication: { type: Boolean, required: true, default: false },
    // Current auth status — a mirror of the owning playlistauths.status === 'active'. Written by the auth
    // lifecycle (PlaylistAuthState.save → Playlist write-back); $setOnInsert false on first provision so a
    // re-sync never clobbers the live value. The playlistauths doc remains the authority.
    isAuthenticated: { type: Boolean, required: true, default: false },
    // Per-playlist externalPlayer video configuration selector: 'default' (use the global 'app' videoconfig set
    // on the Settings screen) or 'app_<playlistId>' (a Custom config doc edited in the playlist editor). Read at
    // stream time (resolvePlaylistConfigId) to pick the engine/args for THIS playlist's external clients; the
    // in-app player is unaffected. The Custom doc lifecycle (create-on-Custom / delete-on-Default / cascade-on-
    // delete) is owned by the playlist routes. Stored value is 'default' or 'app_<id>'.
    videoconfig: { type: String, default: 'default' },
  },
  { versionKey: false },
);

export const Playlist = model('Playlist', PlaylistSchema);
