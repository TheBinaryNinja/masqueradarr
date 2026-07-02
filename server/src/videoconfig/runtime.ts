import { VideoConfig, type VideoConfigDoc } from '../models/VideoConfig.js';
import { Playlist } from '../models/Playlist.js';
import { VIDEO_CONFIG_ID } from './translate.js';

// Hot-path reads of the videoconfig for the /api/ext (externalPlayer) engine. The proxy resolves a channel on
// establish, so this is low-frequency, but a short-TTL cache keeps a burst of first-plays from each hitting
// Mongo and lets a PUT take effect within the TTL (or immediately via invalidate). The config is now keyed by
// id: 'app' is the global Default; 'app_<playlistId>' is a per-playlist Custom doc. DB reads live here, in the
// videoconfig layer — the engine cores (sources/core/external*Engine.ts) stay DB-free; sources.ts wires these
// readers into the resolve seam.

const TTL_MS = 5_000;

// Per-id videoconfig doc cache. One slot per id ('app' + each 'app_<playlistId>'), so a custom playlist's
// config is cached independently of the global Default.
const cache = new Map<string, { doc: VideoConfigDoc | null; at: number }>();

/** The videoconfig doc for `id` (default 'app'), or null if not provisioned / Mongo unreachable. Cached for
 *  TTL_MS per id; on a read error the last good value is served stale so a Mongo hiccup never breaks streaming. */
export async function getVideoConfigCached(id: string = VIDEO_CONFIG_ID): Promise<VideoConfigDoc | null> {
  const now = Date.now();
  const hit = cache.get(id);
  if (hit && now - hit.at < TTL_MS) return hit.doc;
  try {
    const doc = (await VideoConfig.findById(id).lean()) as VideoConfigDoc | null;
    cache.set(id, { doc, at: now });
    return doc;
  } catch {
    return hit?.doc ?? null; // serve stale on error — a null doc just means the engine spawns from built-in defaults
  }
}

/** Drop a cached videoconfig doc so a PUT/DELETE is visible before the TTL lapses (called by the routes). */
export function invalidateVideoConfig(id: string = VIDEO_CONFIG_ID): void {
  cache.delete(id);
}

// Per-playlist → config-id resolution. Maps a playlist's `videoconfig` field to the videoconfig doc id that
// governs its external streams: 'default'/missing/unknown-playlist ⇒ 'app' (the global Default), else the
// stored 'app_<playlistId>'. Cached briefly (TTL_MS) so the hot stream path doesn't hit Mongo per request.
const plCache = new Map<string, { id: string; at: number }>();

/** Resolve the videoconfig id that governs `playlistId`'s external streams ('app' or 'app_<playlistId>'). */
export async function resolvePlaylistConfigId(playlistId: string): Promise<string> {
  const now = Date.now();
  const hit = plCache.get(playlistId);
  if (hit && now - hit.at < TTL_MS) return hit.id;
  let id = VIDEO_CONFIG_ID;
  try {
    const pl = (await Playlist.findOne({ id: playlistId }, { _id: 0, videoconfig: 1 }).lean()) as
      | { videoconfig?: string }
      | null;
    const v = pl?.videoconfig;
    id = v && v !== 'default' ? v : VIDEO_CONFIG_ID; // 'default'/missing/no-such-playlist → the global Default
  } catch {
    id = hit?.id ?? VIDEO_CONFIG_ID; // serve stale / fall back to Default on a Mongo hiccup
  }
  plCache.set(playlistId, { id, at: now });
  return id;
}

/** Drop a cached playlist→config-id mapping (called when a playlist's videoconfig field changes). */
export function invalidatePlaylistConfig(playlistId: string): void {
  plCache.delete(playlistId);
}
