// HdhrTuner — one emulated HDHomeRun network tuner. masqueradarr advertises each tuner over UDP discovery
// (port 65001) and serves its `discover.json`/`lineup.json` at /hdhr/<id>/… so a downstream DVR app (Plex,
// Emby, Jellyfin, Channels) treats a wired Playlist — its channels AND its EPG — as a physical SiliconDust
// tuner. This is the INVERSE of the `hdhomerun` source adapter (which imports FROM a real device).
//
// `id` is an unguessable path slug (the serving-URL secret, since lineup.json embeds the owner's streamToken —
// same posture as the token-free User.slug m3u download). `deviceId` is a checksum-valid 8-hex HDHomeRun
// DeviceID (the tuner's "physical address"). `playlistId` is UNIQUE — a Playlist backs at most one tuner and
// a tuner exactly one Playlist. `ownerUsername` names the account whose streamToken authorizes the tuner's
// streams at the proxy gate.

import { Schema, model } from 'mongoose';

export interface HdhrTunerDoc {
  id: string; // unguessable path slug — the /hdhr/<id>/ serving secret
  deviceId: string; // 8-hex checksum-valid HDHomeRun DeviceID (uppercase)
  friendlyName: string; // FriendlyName shown during discovery
  tunerCount: number; // advertised TunerCount / concurrent-stream cap (1..12)
  playlistId: string; // wired Playlist.id (one-to-one)
  ownerUsername: string; // account whose streamToken authorizes this tuner's streams
  enabled: boolean; // disabled → skipped by discovery + 404 on serve
  createdAt: Date;
  updatedAt: Date;
}

export const HDHR_TUNER_MIN = 1;
export const HDHR_TUNER_MAX = 12;

const HdhrTunerSchema = new Schema<HdhrTunerDoc>(
  {
    id: { type: String, required: true, unique: true, index: true },
    deviceId: { type: String, required: true, unique: true, index: true },
    friendlyName: { type: String, required: true },
    tunerCount: { type: Number, required: true, default: 2, min: HDHR_TUNER_MIN, max: HDHR_TUNER_MAX },
    // Unique: a Playlist may back at most one tuner (the one-to-one wiring invariant).
    playlistId: { type: String, required: true, unique: true, index: true },
    ownerUsername: { type: String, required: true },
    enabled: { type: Boolean, required: true, default: true },
  },
  { versionKey: false, timestamps: true },
);

export const HdhrTuner = model<HdhrTunerDoc>('HdhrTuner', HdhrTunerSchema);
