import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This module lives at <root>/sources/paths.{ts,js} in BOTH dev (server/src) and prod (server/dist).
// The committed seed assets sit at server/seed-data/sources — i.e. two levels up from here, then
// seed-data/sources. The Docker runtime stage copies server/seed-data → /app/seed-data alongside
// /app/dist, so this same relative resolution holds in the container.
const here = dirname(fileURLToPath(import.meta.url));

/** Root of the committed seed assets (server/seed-data; copied to /app/seed-data in the Docker runtime). */
export const SEED_DATA_DIR = resolve(here, '..', '..', 'seed-data');

/** Directory holding the committed <id>.snapshot.json offline fallbacks (syncLive's offline source). */
export const SEED_SOURCES_DIR = resolve(SEED_DATA_DIR, 'sources');

export function snapshotFile(sourceId: string): string {
  return resolve(SEED_SOURCES_DIR, `${sourceId}.snapshot.json`);
}

/**
 * The dulo→gracenote EPG-link crosswalk (committed seed data). dulo's afterSync applies its HIGH-tier rows
 * to never-touched dulo PlaylistChannels once per channel after a sync. Generated offline by
 * scripts/dulo-epg-crosswalk.ts (npm run crosswalk:dulo-epg).
 */
export const DULO_EPG_ADDON_FILE = resolve(SEED_DATA_DIR, 'dulo-playlist-addon.json');

/**
 * The dlhd→gracenote EPG-link crosswalk (committed seed data). dlhd's afterSync applies its HIGH-tier rows
 * to never-touched dlhd PlaylistChannels once per channel after a sync. Generated offline by
 * scripts/dlhd-epg-crosswalk.ts (npm run crosswalk:dlhd-epg). Same shape + apply sequence as dulo's;
 * dlhd is anonymous and has no native guide, so its channels link to the existing US Gracenote sources.
 */
export const DLHD_EPG_ADDON_FILE = resolve(SEED_DATA_DIR, 'dlhd-playlist-addon.json');

/**
 * The dami→gracenote EPG-link crosswalk (committed seed data). dami's afterSync applies its HIGH-tier rows to
 * never-touched dami PlaylistChannels once per channel after a sync. dami channel ids ARE DaddyLive ids, so
 * this is derived from dlhd-playlist-addon.json (rows re-id'd dlhd:→dami:); its linear channels link to the
 * existing US Gracenote sources, same shape + apply sequence as dlhd's.
 */
export const DAMI_EPG_ADDON_FILE = resolve(SEED_DATA_DIR, 'dami-playlist-addon.json');

/**
 * The samsung→gracenote EPG-link crosswalk (committed seed data). samsung's afterSync applies its HIGH-tier
 * rows to never-touched samsung PlaylistChannels once per channel after a sync, BEFORE its own XMLTV self-EPG
 * fills the rest. Generated offline from FastChannels' gracenote_map.csv (samsung rows). NOT committed yet — the
 * crosswalk call no-ops gracefully (applyEpgCrosswalk catches the missing file) until this lands, so samsung's
 * per-region XMLTV self-EPG is the guide in the meantime. Same shape + apply sequence as dlhd's.
 */
export const SAMSUNG_EPG_ADDON_FILE = resolve(SEED_DATA_DIR, 'samsung-playlist-addon.json');

/**
 * The vizio→gracenote EPG-link crosswalk (committed seed data). vizio's afterSync applies its HIGH-tier rows to
 * never-touched vizio PlaylistChannels once per channel after a sync, BEFORE its own /api/airings self-EPG fills
 * the rest. Vizio's catalog carries a real `tmsStationId` (Gracenote station id) per channel, so this addon can
 * be derived directly from the catalog (a follow-up generator). NOT committed yet — the crosswalk call no-ops
 * gracefully (applyEpgCrosswalk catches the missing file) until it lands, so vizio's airings self-EPG is the
 * guide in the meantime. Same shape + apply sequence as dlhd's.
 */
export const VIZIO_EPG_ADDON_FILE = resolve(SEED_DATA_DIR, 'vizio-playlist-addon.json');

/**
 * The lg→gracenote EPG-link crosswalk (committed seed data). lg's afterSync applies its HIGH-tier rows to
 * never-touched lg PlaylistChannels once per channel after a sync, BEFORE its own inline-program self-EPG fills
 * the rest. NOT committed yet — the crosswalk call no-ops gracefully (applyEpgCrosswalk catches the missing file)
 * until it lands, so lg's schedulelist self-EPG is the guide in the meantime. Same shape + apply sequence as dlhd's.
 */
export const LG_EPG_ADDON_FILE = resolve(SEED_DATA_DIR, 'lg-playlist-addon.json');

/**
 * The vidaa→gracenote EPG-link crosswalk (committed seed data). vidaa's afterSync applies its HIGH-tier rows to
 * never-touched vidaa PlaylistChannels once per channel after a sync, BEFORE its own /epg/grid self-EPG fills the
 * rest. Vidaa's catalog carries a `tva-stationId` (a Gracenote-adjacent station id) per channel, so this addon can
 * be derived directly from the catalog (a follow-up generator). NOT committed yet — the crosswalk call no-ops
 * gracefully (applyEpgCrosswalk catches the missing file) until it lands, so vidaa's grid self-EPG is the guide in
 * the meantime. Same shape + apply sequence as dlhd's.
 */
export const VIDAA_EPG_ADDON_FILE = resolve(SEED_DATA_DIR, 'vidaa-playlist-addon.json');

/**
 * The whale→gracenote EPG-link crosswalk (committed seed data). whale's afterSync applies its HIGH-tier rows to
 * never-touched whale PlaylistChannels once per channel after a sync, BEFORE its own /epg self-EPG fills the
 * rest. NOT committed yet — the crosswalk call no-ops gracefully (applyEpgCrosswalk catches the missing file)
 * until it lands, so whale's schedule self-EPG is the guide in the meantime. Same shape + apply sequence as dlhd's.
 */
export const WHALE_EPG_ADDON_FILE = resolve(SEED_DATA_DIR, 'whale-playlist-addon.json');

/**
 * The xumo→gracenote EPG-link crosswalk (committed seed data). xumo's afterSync applies its HIGH-tier rows to
 * never-touched xumo PlaylistChannels once per channel after a sync, BEFORE its own paginated market self-EPG
 * fills the rest. NOT committed yet — the crosswalk call no-ops gracefully (applyEpgCrosswalk catches the missing
 * file) until it lands, so xumo's market self-EPG is the guide in the meantime. Same shape + apply sequence as dlhd's.
 */
export const XUMO_EPG_ADDON_FILE = resolve(SEED_DATA_DIR, 'xumo-playlist-addon.json');

/**
 * The freelivesports→gracenote EPG-link crosswalk (committed seed data). freelivesports' afterSync applies its
 * HIGH-tier rows to never-touched freelivesports PlaylistChannels once per channel after a sync, BEFORE its own
 * inline-program self-EPG fills the rest. NOT committed yet — the crosswalk call no-ops gracefully
 * (applyEpgCrosswalk catches the missing file) until it lands, so freelivesports' catalog self-EPG is the guide in
 * the meantime. Same shape + apply sequence as dlhd's.
 */
export const FREELIVESPORTS_EPG_ADDON_FILE = resolve(SEED_DATA_DIR, 'freelivesports-playlist-addon.json');

/**
 * The distro→gracenote EPG-link crosswalk (committed seed data). distro's afterSync applies its HIGH-tier rows to
 * never-touched distro PlaylistChannels once per channel after a sync, BEFORE its own query.php self-EPG fills the
 * rest. NOT committed yet — the crosswalk call no-ops gracefully (applyEpgCrosswalk catches the missing file)
 * until it lands, so distro's schedule self-EPG is the guide in the meantime. Same shape + apply sequence as dlhd's.
 */
export const DISTRO_EPG_ADDON_FILE = resolve(SEED_DATA_DIR, 'distro-playlist-addon.json');

/**
 * The stirr→gracenote EPG-link crosswalk (committed seed data). stirr's afterSync applies its HIGH-tier rows to
 * never-touched stirr PlaylistChannels once per channel after a sync, BEFORE its own per-channel two-tier self-EPG
 * fills the rest. NOT committed yet — the crosswalk call no-ops gracefully (applyEpgCrosswalk catches the missing
 * file) until it lands, so stirr's two-tier self-EPG is the guide in the meantime. Same shape + apply sequence as dlhd's.
 */
export const STIRR_EPG_ADDON_FILE = resolve(SEED_DATA_DIR, 'stirr-playlist-addon.json');

/**
 * The tcl→gracenote EPG-link crosswalk (committed seed data). tcl's afterSync applies its HIGH-tier rows to
 * never-touched tcl PlaylistChannels once per channel after a sync, BEFORE its own per-category schedule self-EPG
 * fills the rest. NOT committed yet — the crosswalk call no-ops gracefully (applyEpgCrosswalk catches the missing
 * file) until it lands, so tcl's schedule self-EPG is the guide in the meantime. Same shape + apply sequence as dlhd's.
 */
export const TCL_EPG_ADDON_FILE = resolve(SEED_DATA_DIR, 'tcl-playlist-addon.json');

/**
 * The pluto→gracenote EPG-link crosswalk (committed seed data). pluto's afterSync applies its HIGH-tier rows to
 * never-touched pluto PlaylistChannels once per channel after a sync, BEFORE its own per-region timelines self-EPG
 * fills the rest. NOT committed yet — the crosswalk call no-ops gracefully (applyEpgCrosswalk catches the missing
 * file) until it lands, so pluto's timelines self-EPG is the guide in the meantime. Same shape + apply sequence as dlhd's.
 */
export const PLUTO_EPG_ADDON_FILE = resolve(SEED_DATA_DIR, 'pluto-playlist-addon.json');

/**
 * The roku→gracenote EPG-link crosswalk (committed seed data). roku's afterSync applies its HIGH-tier rows to
 * never-touched roku PlaylistChannels once per channel after a sync, BEFORE its own per-channel linearSchedule
 * self-EPG fills the rest. NOT committed yet — the crosswalk call no-ops gracefully (applyEpgCrosswalk catches the
 * missing file) until it lands, so roku's linearSchedule self-EPG is the guide in the meantime. Same shape + apply
 * sequence as dlhd's.
 */
export const ROKU_EPG_ADDON_FILE = resolve(SEED_DATA_DIR, 'roku-playlist-addon.json');

/**
 * The plex→gracenote EPG-link crosswalk (committed seed data). plex's afterSync applies its HIGH-tier rows to
 * never-touched plex PlaylistChannels once per channel after a sync, BEFORE its own per-channel grid self-EPG fills
 * the rest. NOT committed yet — the crosswalk call no-ops gracefully (applyEpgCrosswalk catches the missing file)
 * until it lands, so plex's grid self-EPG is the guide in the meantime. Same shape + apply sequence as dlhd's.
 */
export const PLEX_EPG_ADDON_FILE = resolve(SEED_DATA_DIR, 'plex-playlist-addon.json');
