// Resolve the EFFECTIVE proxy config for a stream, applying the two-tier fallback: a (Custom) per-playlist doc
// (app_<pl>) if one exists, else the (Default) singleton (app), else the env defaults (the Default not seeded
// yet — a boot race). Doc-level fallback (a Custom doc FULLY overrides the Default for that playlist), matching
// the videoconfig ancestor and the PlaylistAuth per-playlist singleton idiom.
//
// `pl` is the OWNING PLAYLIST ID the composed M3U stamps as `?pl=` (m3u/serialize.ts — === the channel's
// `source`: the source key for a Default playlist, the clone id for a custom one). The resolve seam calls this
// to embed the resolved config in the grant; the SPA config panels read the raw docs directly via the route.

import { ProxyConfig, PROXY_CONFIG_DEFAULT_ID, CUSTOM_PROXY_CONFIG_PREFIX, type ProxyConfigDoc } from '../models/ProxyConfig.js';
import { envDefaults, toRuntimeProxyConfig, type RuntimeProxyConfig } from './translate.js';

export async function resolveProxyConfig(pl?: string): Promise<RuntimeProxyConfig> {
  if (pl) {
    const custom = (await ProxyConfig.findById(CUSTOM_PROXY_CONFIG_PREFIX + pl).lean()) as ProxyConfigDoc | null;
    if (custom) return toRuntimeProxyConfig(custom);
  }
  const def = (await ProxyConfig.findById(PROXY_CONFIG_DEFAULT_ID).lean()) as ProxyConfigDoc | null;
  if (def) return toRuntimeProxyConfig(def);
  return envDefaults();
}
