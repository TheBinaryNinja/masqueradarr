import { VideoConfig, type VideoConfigDoc } from '../models/VideoConfig.js';
import { VIDEO_CONFIG_ID, DEFAULT_FFMPEG_ARGS } from './translate.js';
import { logger } from '../sources/core/logger.js';

// Provision a videoconfig doc on first use so Mongoose applies every sub-schema default (the comprehensive
// option catalog → explicit nulls) plus the seeded engine args. Two seed rules by id:
//   • 'app' (the global Default) — seed from the built-in DEFAULT_* args (as before). SHARED by the GET/PUT
//     route (routes/videoConfig.ts) and boot HW detection (hwDetect.ts) so both seed identically — hwDetect
//     must NOT create a half-seeded doc the route would then return verbatim.
//   • 'app_<playlistId>' (a per-playlist Custom config) — seed by COPYING the current global Default so the
//     admin tweaks from their known-good baseline ("copy current Default"). Centralized here so both the GET
//     auto-provision path and the playlist-PUT lifecycle produce identical seeded docs.
// Race-safe: a concurrent create throws a duplicate key, which we swallow and re-fetch.
export async function ensureVideoConfig(id: string = VIDEO_CONFIG_ID): Promise<VideoConfigDoc | null> {
  const existing = await VideoConfig.findById(id).lean();
  if (existing) return existing as VideoConfigDoc;
  try {
    if (id === VIDEO_CONFIG_ID) {
      await VideoConfig.create({
        _id: VIDEO_CONFIG_ID,
        ffmpeg: { advancedArgs: DEFAULT_FFMPEG_ARGS },
      });
      logger.info('settings', 'videoconfig provisioned (defaults seeded)');
    } else {
      // Copy the live global Default (every field except _id). Fall back to the built-in defaults if 'app'
      // isn't provisioned yet (ensureVideoConfig('app') both seeds it and returns the doc to copy).
      const base = await ensureVideoConfig(VIDEO_CONFIG_ID);
      const copy: Record<string, unknown> = base
        ? { ...(base as unknown as Record<string, unknown>) }
        : { ffmpeg: { advancedArgs: DEFAULT_FFMPEG_ARGS } };
      delete copy._id;
      await VideoConfig.create({ _id: id, ...copy });
      logger.info('settings', `videoconfig provisioned (${id}, copied from ${VIDEO_CONFIG_ID})`);
    }
  } catch {
    /* concurrent create lost the race → re-fetch below */
  }
  return (await VideoConfig.findById(id).lean()) as VideoConfigDoc | null;
}
