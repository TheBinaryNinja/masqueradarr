import { Router } from 'express';
import {
  ProxyConfig,
  PROXY_CONFIG_DEFAULT_ID,
  CUSTOM_PROXY_CONFIG_PREFIX,
  type ProxyConfigDoc,
} from '../models/ProxyConfig.js';
import { envDefaults, toRuntimeProxyConfig, toExternalPatch } from '../proxyconfig/translate.js';

// The proxy-config surface for the durable video data plane (the Rust sidecar). Two-tier keyed docs:
//   · _id 'app'              — the (Default) config, edited on Settings → Advanced.
//   · _id 'app_<playlistId>' — a (Custom) per-playlist override, edited in the playlist drawer.
// Every read/write crosses the internal<->external boundary through the translation layer
// (proxyconfig/translate.ts): GET projects the stored doc (toRuntimeProxyConfig), PUT validates the body into
// a whitelisted $set patch (toExternalPatch), both seed missing fields from env defaults (envDefaults). The
// resolved config reaches Rust in the resolve GRANT, not through this route (Rust never reads Mongo).
//
// Gating (index.ts): WRITES (PUT/DELETE) are admin-only; GET is available to any authenticated user. The
// (Default) is upserted-on-read (it always exists conceptually); a (Custom) GET 404s when absent so the
// drawer can show "inheriting Default". A NEW Custom is created by the drawer PUT-ing the full effective
// config, so a first write starts as a copy of the Default, not env defaults.

export const proxyConfigsRouter = Router();

// A valid id is the Default singleton or a non-empty per-playlist Custom key (`app_<playlistId>`).
function isValidId(id: string): boolean {
  return id === PROXY_CONFIG_DEFAULT_ID || (id.startsWith(CUSTOM_PROXY_CONFIG_PREFIX) && id.length > CUSTOM_PROXY_CONFIG_PREFIX.length);
}

proxyConfigsRouter.get('/:id?', async (req, res, next) => {
  try {
    const id = (req.params as Record<string, string | undefined>).id ?? PROXY_CONFIG_DEFAULT_ID;
    if (!isValidId(id)) return res.status(400).json({ error: 'invalid_id' });

    if (id === PROXY_CONFIG_DEFAULT_ID) {
      // The Default always resolves — upsert it from env defaults on first read (mirrors GET /api/settings).
      const doc = (await ProxyConfig.findOneAndUpdate(
        { _id: id },
        { $setOnInsert: envDefaults() },
        { upsert: true, new: true },
      ).lean()) as ProxyConfigDoc | null;
      if (!doc) return next(new Error('proxy config upsert returned no document'));
      return res.json(toRuntimeProxyConfig(doc));
    }

    // A Custom override: return it if it exists, else 404 (the playlist inherits the Default).
    const doc = (await ProxyConfig.findById(id).lean()) as ProxyConfigDoc | null;
    if (!doc) return res.status(404).json({ error: 'not_found' });
    res.json(toRuntimeProxyConfig(doc));
  } catch (err) {
    next(err);
  }
});

proxyConfigsRouter.put('/:id?', async (req, res, next) => {
  try {
    const id = (req.params as Record<string, string | undefined>).id ?? PROXY_CONFIG_DEFAULT_ID;
    if (!isValidId(id)) return res.status(400).json({ error: 'invalid_id' });

    const patch = toExternalPatch(req.body);
    if (!patch.ok) return res.status(400).json({ error: patch.error });
    const $set = patch.$set;

    // Seed defaults only for fields not being $set this call — $set and $setOnInsert may not touch the same
    // path (Mongo rejects the conflict). This also seeds a brand-new Custom doc's untouched fields.
    const $setOnInsert: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(envDefaults())) {
      if (!(k in $set)) $setOnInsert[k] = v;
    }
    const update: Record<string, unknown> = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($setOnInsert).length) update.$setOnInsert = $setOnInsert;

    const doc = (await ProxyConfig.findOneAndUpdate({ _id: id }, update, {
      upsert: true,
      new: true,
    }).lean()) as ProxyConfigDoc | null;
    if (!doc) return next(new Error('proxy config upsert returned no document'));
    res.json(toRuntimeProxyConfig(doc));
  } catch (err) {
    next(err);
  }
});

// Delete a (Custom) override so the playlist reverts to the Default. The Default itself cannot be deleted.
proxyConfigsRouter.delete('/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (id === PROXY_CONFIG_DEFAULT_ID) return res.status(400).json({ error: 'cannot_delete_default' });
    if (!isValidId(id)) return res.status(400).json({ error: 'invalid_id' });
    await ProxyConfig.deleteOne({ _id: id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
