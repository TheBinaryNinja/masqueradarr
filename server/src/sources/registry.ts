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
import directAdapter from './adapters/direct.js';
import hdhomerunAdapter from './adapters/hdhomerun/index.js';
import type { SourceAdapter } from './types.js';

// `direct` and `hdhomerun` are synthetic (proxy-only) sources — they provide a /api/v1/<id>/… stream route
// for user-imported playlists but have no catalog, so boot init + the manifest skip them (they are not
// syncable source playlists). `direct` passes imported URLs straight through; `hdhomerun` remuxes a local
// tuner's raw MPEG-TS to HLS (adapters/hdhomerun/). Both back custom-type playlists whose channels carry
// origin:'<id>' for routing.
export const SOURCES: SourceAdapter[] = [duloAdapter, dlhdAdapter, tubiAdapter, damiAdapter, samsungAdapter, vizioAdapter, lgAdapter, directAdapter, hdhomerunAdapter];

export function getSource(id: string): SourceAdapter | undefined {
  return SOURCES.find((s) => s.id === id);
}
