// The single enumeration of source adapters Masqueradarr knows about. Ported from
// ../d-combine/sources/registry.mjs. Adding a source (next: Phase 3 common) = write a new
// adapter under adapters/ and add it here; the boot init, sources router (manifest + proxy mounts),
// and SPA all iterate this list, so nothing else needs to change.

import duloAdapter from './adapters/dulo.js';
import dlhdAdapter from './adapters/dlhd.js';
import tubiAdapter from './adapters/tubi.js';
import damiAdapter from './adapters/dami.js';
import samsungAdapter from './adapters/samsung.js';
import vizioAdapter from './adapters/vizio.js';
import lgAdapter from './adapters/lg.js';
import vidaaAdapter from './adapters/vidaa.js';
import whaleAdapter from './adapters/whale.js';
import xumoAdapter from './adapters/xumo.js';
import freeLiveSportsAdapter from './adapters/freelivesports.js';
import distroAdapter from './adapters/distro.js';
import stirrAdapter from './adapters/stirr.js';
import tclAdapter from './adapters/tcl.js';
import plutoAdapter from './adapters/pluto.js';
import rokuAdapter from './adapters/roku.js';
import plexAdapter from './adapters/plex.js';
import directAdapter from './adapters/direct.js';
import hdhomerunAdapter from './adapters/hdhomerun/index.js';
import localAdapter from './adapters/local/index.js';
import type { SourceAdapter } from './types.js';

// `direct`, `hdhomerun`, and `local` are synthetic (proxy-only) sources — they provide a /api/v1/<id>/…
// stream route for user-created playlists but have no catalog, so boot init + the manifest skip them (they
// are not syncable source playlists, and `local` never appears in the Add Playlist Built-In list). `direct`
// passes imported URLs straight through; `hdhomerun` remuxes a local tuner's raw MPEG-TS to HLS
// (adapters/hdhomerun/); `local` resolves a Local Now `localnow://` sentinel to a fresh signed CDN master per
// play (adapters/local/). All three back custom-type playlists whose channels carry origin:'<id>' for routing.
export const SOURCES: SourceAdapter[] = [duloAdapter, dlhdAdapter, tubiAdapter, damiAdapter, samsungAdapter, vizioAdapter, lgAdapter, vidaaAdapter, whaleAdapter, xumoAdapter, freeLiveSportsAdapter, distroAdapter, stirrAdapter, tclAdapter, plutoAdapter, rokuAdapter, plexAdapter, directAdapter, hdhomerunAdapter, localAdapter];

export function getSource(id: string): SourceAdapter | undefined {
  return SOURCES.find((s) => s.id === id);
}
