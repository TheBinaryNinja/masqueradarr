// HDHomeRun tuner management — the admin-only CRUD registry for emulated tuners (mounted at
// /api/hdhomerun-tuners). Each tuner wires exactly one Playlist to a downstream DVR app (Plex/Emby); the
// serving surface (discover.json/lineup.json) + UDP discovery live elsewhere (routes/hdhrServe.ts,
// hdhomerun/discovery.ts) and read these rows. Modeled on routes/tags.ts (CRUD skeleton) with the
// device-entity validation posture of routes/import.ts.

import { Router } from 'express';
import { HdhrTuner, type HdhrTunerDoc, HDHR_TUNER_MIN, HDHR_TUNER_MAX } from '../models/HdhrTuner.js';
import { Playlist } from '../models/Playlist.js';
import { User } from '../models/User.js';
import { generateSlug } from '../security/crypto.js';
import { generateDeviceId } from '../hdhomerun/deviceId.js';
import type { AuthRequest } from '../middleware/auth.js';

export const hdhomerunRouter = Router();

const MAX_NAME = 64;

interface ParsedInput {
  friendlyName?: string;
  tunerCount?: number;
  playlistId?: string;
  ownerUsername?: string;
  enabled?: boolean;
  regenerateDeviceId?: boolean;
}

// Validate a create/update body into a normalized patch, or an { error } to surface as 400/404/409. `partial`
// (PUT) treats every field as optional; create requires friendlyName + playlistId.
async function validate(
  body: unknown,
  partial: boolean,
  selfId: string | null,
  requesterUsername: string,
): Promise<{ ok: true; patch: ParsedInput } | { ok: false; status: number; error: string }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: ParsedInput = {};

  if (b.friendlyName !== undefined || !partial) {
    const name = typeof b.friendlyName === 'string' ? b.friendlyName.trim() : '';
    if (!name) return { ok: false, status: 400, error: 'friendlyName (non-empty string) required' };
    if (name.length > MAX_NAME) return { ok: false, status: 400, error: 'friendlyName too long' };
    patch.friendlyName = name;
  }

  if (b.tunerCount !== undefined) {
    const n = b.tunerCount;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < HDHR_TUNER_MIN || n > HDHR_TUNER_MAX) {
      return { ok: false, status: 400, error: `tunerCount must be an integer ${HDHR_TUNER_MIN}-${HDHR_TUNER_MAX}` };
    }
    patch.tunerCount = n;
  }

  if (b.playlistId !== undefined || !partial) {
    const pid = typeof b.playlistId === 'string' ? b.playlistId.trim() : '';
    if (!pid) return { ok: false, status: 400, error: 'playlistId required' };
    const pl = await Playlist.exists({ id: pid });
    if (!pl) return { ok: false, status: 400, error: 'playlist_not_found' };
    // One-to-one: reject wiring a playlist that already backs a DIFFERENT tuner (the unique index is the
    // backstop; this yields a clean 409 instead of a duplicate-key 500).
    const wired = await HdhrTuner.findOne({ playlistId: pid }, { id: 1, _id: 0 }).lean();
    if (wired && wired.id !== selfId) return { ok: false, status: 409, error: 'playlist_already_wired' };
    patch.playlistId = pid;
  }

  // Owner defaults to the requesting admin on create. On either path, the named account must exist and have
  // streamTokenEnabled (its streamToken authorizes the tuner's streams at the proxy gate). Non-admin owners
  // must additionally have the wired playlist's providers in allowedPlaylists — enforced by streamGate at
  // play time, not re-validated here (channels/providers can change post-create; admin is the default).
  const ownerName = b.ownerUsername !== undefined ? b.ownerUsername : partial ? undefined : requesterUsername;
  if (ownerName !== undefined) {
    const uname = typeof ownerName === 'string' ? ownerName.trim().toLowerCase() : '';
    if (!uname) return { ok: false, status: 400, error: 'ownerUsername (string) required' };
    const owner = await User.findOne({ username: uname }, { username: 1, streamTokenEnabled: 1, _id: 0 }).lean();
    if (!owner) return { ok: false, status: 400, error: 'owner_not_found' };
    if (!owner.streamTokenEnabled) return { ok: false, status: 400, error: 'owner_stream_token_disabled' };
    patch.ownerUsername = owner.username;
  }

  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return { ok: false, status: 400, error: 'enabled must be boolean' };
    patch.enabled = b.enabled;
  }

  if (b.regenerateDeviceId !== undefined) {
    if (typeof b.regenerateDeviceId !== 'boolean') return { ok: false, status: 400, error: 'regenerateDeviceId must be boolean' };
    patch.regenerateDeviceId = b.regenerateDeviceId;
  }

  return { ok: true, patch };
}

// A checksum-valid DeviceID not already taken (retry on the astronomically rare collision).
async function freshDeviceId(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const id = generateDeviceId();
    if (!(await HdhrTuner.exists({ deviceId: id }))) return id;
  }
  return generateDeviceId();
}

// A unique unguessable path slug for the /hdhr/<id>/ serving URL.
async function freshSlug(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const id = generateSlug(16);
    if (!(await HdhrTuner.exists({ id }))) return id;
  }
  return generateSlug(20);
}

// Attach the wired playlist's display name (best-effort) for the management UI.
async function enrich(tuners: HdhrTunerDoc[]): Promise<Array<HdhrTunerDoc & { playlistName: string | null }>> {
  const ids = [...new Set(tuners.map((t) => t.playlistId))];
  const pls = await Playlist.find({ id: { $in: ids } }, { id: 1, name: 1, _id: 0 }).lean();
  const nameById = new Map(pls.map((p) => [p.id, p.name as string]));
  return tuners.map((t) => ({ ...t, playlistName: nameById.get(t.playlistId) ?? null }));
}

// GET / — all tuners (newest first), enriched with the wired playlist name.
hdhomerunRouter.get('/', async (_req, res, next) => {
  try {
    const tuners = await HdhrTuner.find({}, { _id: 0 }).sort({ createdAt: -1 }).lean<HdhrTunerDoc[]>();
    res.json(await enrich(tuners));
  } catch (err) {
    next(err);
  }
});

// POST / — create a tuner. Generates the slug id + a checksum-valid DeviceID.
hdhomerunRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const requester = req.user?.username ?? '';
    const v = await validate(req.body, false, null, requester);
    if (!v.ok) return res.status(v.status).json({ error: v.error });
    const doc: Partial<HdhrTunerDoc> = {
      id: await freshSlug(),
      deviceId: await freshDeviceId(),
      friendlyName: v.patch.friendlyName!,
      tunerCount: v.patch.tunerCount ?? 2,
      playlistId: v.patch.playlistId!,
      ownerUsername: v.patch.ownerUsername!,
      enabled: v.patch.enabled ?? true,
    };
    const created = await HdhrTuner.create(doc);
    res.status(201).json((await enrich([created.toObject()]))[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /:id — allow-list update. `regenerateDeviceId:true` mints a new DeviceID.
hdhomerunRouter.put('/:id', async (req: AuthRequest, res, next) => {
  try {
    const requester = req.user?.username ?? '';
    const v = await validate(req.body, true, String(req.params.id), requester);
    if (!v.ok) return res.status(v.status).json({ error: v.error });
    const set: Record<string, unknown> = {};
    if (v.patch.friendlyName !== undefined) set.friendlyName = v.patch.friendlyName;
    if (v.patch.tunerCount !== undefined) set.tunerCount = v.patch.tunerCount;
    if (v.patch.playlistId !== undefined) set.playlistId = v.patch.playlistId;
    if (v.patch.ownerUsername !== undefined) set.ownerUsername = v.patch.ownerUsername;
    if (v.patch.enabled !== undefined) set.enabled = v.patch.enabled;
    if (v.patch.regenerateDeviceId) set.deviceId = await freshDeviceId();
    if (Object.keys(set).length === 0) return res.status(400).json({ error: 'no_fields' });
    const doc = await HdhrTuner.findOneAndUpdate(
      { id: req.params.id },
      { $set: set },
      { new: true, projection: { _id: 0 } },
    ).lean<HdhrTunerDoc>();
    if (!doc) return res.status(404).json({ error: 'not_found' });
    res.json((await enrich([doc]))[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id — remove the tuner (single doc; nothing else references it).
hdhomerunRouter.delete('/:id', async (req, res, next) => {
  try {
    const doc = await HdhrTuner.findOneAndDelete({ id: req.params.id }, { projection: { _id: 0, id: 1 } }).lean();
    if (!doc) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
