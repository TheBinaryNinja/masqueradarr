import { Router } from 'express';
import { logger } from '../sources/core/logger.js';
import { EpgSource, type EpgSourceDoc } from '../models/EpgSource.js';
import { Program } from '../models/Program.js';
import { EpgChannel } from '../models/EpgChannel.js';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import { Cronjob, cronjobId } from '../models/Cronjob.js';
import { removeCronjob } from '../scheduler/index.js';
import {
  fetchProviders,
  fetchGrid,
  buildGridUrl,
  fillTime,
  summarizeGrid,
  type GracenoteProvider,
} from '../epg/gracenote.js';
import { fetchRegions, summarizeEpgpw } from '../epg/epgpw.js';
import { syncPrograms, syncEpgpwSource, syncEpgSource } from '../epg/syncEpgSource.js';
import {
  validateXmltv,
  validateXmltvUrl,
  writeXmltvEpg,
  syncXmltvUrl,
  decodeXmltvBody,
} from '../epg/xmltvIngest.js';
import { resolveProgramOffset } from '../settings/programOffset.js';
import { recomposeAllExports } from '../m3u/compose.js';

export const epgSourcesRouter = Router();

const GRID_TIMESPAN = 6; // hours of guide pulled per Gracenote sync (the stored url's timespan)
const PREVIEW_TIMESPAN = 3; // shorter window for the in-modal preview summary

// Slugify a user-supplied name into a deterministic id segment (lowercase, runs of non-alphanumerics → '-').
// Keeps the Custom EPG-source ids stable + idempotent (re-adding the same name upserts the same row).
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
}

// Next list-order ordinal for a newly created source — one past the current max so it lands at the end of
// the drag-ordered list (re-adding an existing id is an upsert, so $setOnInsert keeps the original slot).
async function nextOrder(): Promise<number> {
  const top = (await EpgSource.findOne({}, { order: 1, _id: 0 }).sort({ order: -1 }).lean()) as {
    order?: number;
  } | null;
  return (top?.order ?? -1) + 1;
}

// All EPG sources (read-only list), in the user's drag-defined order. Sorted by the `order` ordinal with
// `name` as the stable tiebreaker so legacy rows (all order:0 until first reordered) still list deterministically.
epgSourcesRouter.get('/', async (_req, res, next) => {
  try {
    const docs = await EpgSource.find({}, { _id: 0 }).sort({ order: 1, name: 1 }).lean();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// Persist a new list order (the EPG Sources screen's drag-to-reorder). Body: { ids: string[] } — the full
// ordered sequence of EpgSource ids; each doc's `order` is rewritten to its index in that array (a single
// bulkWrite). Unknown ids are skipped; the response is the freshly re-sorted list so the SPA can reconcile.
// MUST be registered BEFORE PUT /:id so '/reorder' isn't captured as an :id.
epgSourcesRouter.put('/reorder', async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ids = b.ids;
    if (!Array.isArray(ids) || ids.some((v) => typeof v !== 'string')) {
      return res.status(400).json({ error: 'ids (string[]) required' });
    }
    const ops = (ids as string[]).map((id, index) => ({
      updateOne: { filter: { id }, update: { $set: { order: index } } },
    }));
    if (ops.length) await EpgSource.bulkWrite(ops);
    const docs = await EpgSource.find({}, { _id: 0 }).sort({ order: 1, name: 1 }).lean();
    res.json(docs);
  } catch (err) {
    next(err);
  }
});

// Update an EPG source's user-editable fields (name / interval / auto). The cron schedule itself lives in
// the /api/cronjobs resource (the Edit drawer makes both calls); this keeps the source row lean.
epgSourcesRouter.put('/:id', async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const $set: Record<string, unknown> = {};
    if (b.name !== undefined) {
      if (typeof b.name !== 'string' || !b.name.trim()) {
        return res.status(400).json({ error: 'name (non-empty string) required' });
      }
      $set.name = b.name.trim();
    }
    if (b.interval !== undefined) {
      if (typeof b.interval !== 'string' || !b.interval.trim()) {
        return res.status(400).json({ error: 'interval (non-empty string) required' });
      }
      $set.interval = b.interval.trim();
    }
    if (b.auto !== undefined) {
      if (typeof b.auto !== 'boolean') {
        return res.status(400).json({ error: 'auto (boolean) required' });
      }
      $set.auto = b.auto;
    }
    if (!Object.keys($set).length) {
      return res.status(400).json({ error: 'no editable fields provided (name, interval, auto)' });
    }
    const doc = (await EpgSource.findOneAndUpdate(
      { id: req.params.id },
      { $set },
      { new: true, projection: { _id: 0 } },
    ).lean()) as EpgSourceDoc | null;
    if (!doc) return res.status(404).json({ error: 'not_found' });
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// Cascade-delete an EPG source and ALL its dependents, in this exact order:
//   1. Unlink playlistchannels linked to this EPG source (clear tvg_id + epg, flip epgState 'unmatched') so
//      no orphaned linkage remains.
//   2. Remove this source's programs        (deleteMany({ source: id })).
//   3. Remove this source's epgchannels      (deleteMany({ source: id })).
//   4. Remove the epgsource row itself.
//   5. Delete + unschedule the source's sync cronjob (epg-source:<id>) — leaving a schedule behind would
//      orphan a job for a now-deleted source.
// Idempotent + safe to call for a source that has no linked channels. Exported so a built-in playlist delete
// (which must drop the playlist's bound self-EPG source) shares the EXACT same cascade — one source of truth.
// The caller is responsible for the not-found guard before calling this.
export async function cascadeDeleteEpgSource(id: string): Promise<void> {
  // 1. Unlink playlistchannels linked to this source. A playlistchannel's EPG link is the 2-factor pair
  //    (tvg_id = epgchannels.channelId, epg = epgchannels.source); the `epg` field already scopes the link
  //    to its owning EPG source, so `{ epg: id }` matches exactly — and only — this source's links. No
  //    cross-source over-match (two sources publishing the same channelId stay distinct via `epg`). We also
  //    flip epgState to 'unmatched' — the channel WAS matched to this now-deleted source, so post-unlink it
  //    is genuinely unmatched (not back to the seed `null` "never matched" state).
  await PlaylistChannel.updateMany(
    { epg: id },
    { $set: { tvg_id: null, epg: null, epgState: 'unmatched' } },
  );

  // 2. Programs · 3. EpgChannels · 4. the source row.
  await Program.deleteMany({ source: id });
  await EpgChannel.deleteMany({ source: id });
  await EpgSource.deleteOne({ id });

  // 5. The sync cronjob (epg-source:<id>), if any: delete + unschedule so no orphaned schedule re-runs for a
  //    now-deleted source.
  const jobId = cronjobId('epg-source', id);
  await Cronjob.deleteOne({ _id: jobId });
  removeCronjob(jobId);

  logger.info('epg', `deleted EPG source ${id} (cascade)`);
}

// Delete an EPG source and CASCADE its dependents (the shared cascadeDeleteEpgSource above).
// 404 if the source doesn't exist; 204 on success.
epgSourcesRouter.delete('/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const src = (await EpgSource.findOne({ id }).lean()) as EpgSourceDoc | null;
    if (!src) return res.status(404).json({ error: 'not_found' });
    await cascadeDeleteEpgSource(id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Gracenote provider lookup for a ZIP (the user picks one of these). Proxied server-side (CORS + WAF).
epgSourcesRouter.get('/gracenote/providers', async (req, res, next) => {
  try {
    const postalCode = typeof req.query.postalCode === 'string' ? req.query.postalCode.trim() : '';
    if (!postalCode) return res.status(400).json({ error: 'postalCode query parameter required' });
    const country = (typeof req.query.country === 'string' && req.query.country) || 'USA';
    const aid = (typeof req.query.aid === 'string' && req.query.aid) || 'orbebb';
    const lang = (typeof req.query.lang === 'string' && req.query.lang) || 'en-us';
    const result = await fetchProviders(country, postalCode, aid, lang);
    res.json(result);
  } catch (err) {
    logger.warn('epg', `gracenote providers failed: ${(err as Error).message}`);
    res.status(502).json({ error: 'gracenote_unreachable' });
  }
});

// Short listings summary for a chosen provider (drives the modal preview).
epgSourcesRouter.get('/gracenote/preview', async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const headendId = (q.headendId ?? '').trim();
    const lineupId = (q.lineupId ?? '').trim();
    const postalCode = (q.postalCode ?? '').trim();
    if (!headendId || !lineupId || !postalCode) {
      return res.status(400).json({ error: 'headendId, lineupId and postalCode required' });
    }
    const provider: GracenoteProvider = {
      type: q.type ?? '',
      device: q.device ?? '',
      lineupId,
      name: q.name ?? '',
      location: q.location ?? '',
      timezone: q.timezone ?? '',
      postalCode,
      headendId,
    };
    const url = fillTime(
      buildGridUrl(provider, {
        aid: q.aid || 'orbebb',
        country: q.country || 'USA',
        lang: q.lang || 'en-us',
        timespan: PREVIEW_TIMESPAN,
      }),
      Math.floor(Date.now() / 1000),
    );
    const grid = await fetchGrid(url);
    res.json(summarizeGrid(grid));
  } catch (err) {
    logger.warn('epg', `gracenote preview failed: ${(err as Error).message}`);
    res.status(502).json({ error: 'gracenote_unreachable' });
  }
});

// EPG-PW region list (the user picks one). Proxied server-side (epg.pw serves HTML). The global
// "All channels" entry is dropped upstream in fetchRegions.
epgSourcesRouter.get('/epgpw/regions', async (_req, res, next) => {
  try {
    const regions = await fetchRegions();
    res.json({ regions });
  } catch (err) {
    logger.warn('epg', `epgpw regions failed: ${(err as Error).message}`);
    res.status(502).json({ error: 'epgpw_unreachable' });
  }
});

// Short summary for a chosen EPG-PW region (channel count + a small program sample) — drives the modal preview.
epgSourcesRouter.get('/epgpw/preview', async (req, res, next) => {
  try {
    const href = typeof req.query.href === 'string' ? req.query.href.trim() : '';
    if (!href) return res.status(400).json({ error: 'href query parameter required' });
    const region = (typeof req.query.region === 'string' && req.query.region) || null;
    res.json(await summarizeEpgpw(href, region));
  } catch (err) {
    logger.warn('epg', `epgpw preview failed: ${(err as Error).message}`);
    res.status(502).json({ error: 'epgpw_unreachable' });
  }
});

// Create (or re-add) a Gracenote EPG source and sync its programs immediately. Idempotent by deterministic
// id = gracenote:<headendId>:<lineupId>; re-running replaces the source's programs (scoped by `source`).
// An EPG-PW source (body.source 'epg-pw', case-insensitive) takes the EPG-PW branch (full inline channel + program sync).
epgSourcesRouter.post('/', async (req, res, next) => {
  try {
    // A raw gzip/xml body is an uploaded XMLTV file (the 'xml file' path); its source/name/filename ride as
    // query params. Every other source kind (EPG-PW, remote url, Gracenote) stays a plain JSON body.
    const isRaw = Buffer.isBuffer(req.body);
    const b = (isRaw ? {} : (req.body ?? {})) as Record<string, unknown>;
    const q = req.query as Record<string, unknown>;
    const qstr = (v: unknown) => (typeof v === 'string' ? v : '');
    const source = isRaw ? qstr(q.source) : typeof b.source === 'string' ? b.source : '';

    // The operator's UTC offset stamped onto every program written by the inline create-sync below
    // (settings.offset; '+0000' when unset). `offsetDefaulted` rides back in the response so the SPA can
    // warn that guide times defaulted to UTC. See settings/programOffset.ts.
    const { offset, defaulted: offsetDefaulted } = await resolveProgramOffset();

    // New sources land at the end of the drag-ordered list ($setOnInsert only — a re-add keeps its slot).
    const order = await nextOrder();

    // ── EPG-PW branch ──────────────────────────────────────────────────
    // The kind discriminator is the lowercase canonical 'epg-pw'; accept either casing from older
    // clients (case-insensitive) so a stale SPA payload still routes correctly.
    if (source.toLowerCase() === 'epg-pw') {
      const href = typeof b.href === 'string' ? b.href.trim() : '';
      const region = typeof b.region === 'string' ? b.region.trim() : '';
      if (!href || !region) {
        return res.status(400).json({ error: 'region and href (string) required' });
      }
      const id = `epg-pw:lineupId:${region}-lineupId-DEFAULT`;
      const url = `https://epg.pw/index.html?lang=en`;

      // Fetch + write channels/programs first so a network failure leaves no broken source behind.
      let counts: { channels: number; programs: number };
      try {
        counts = await syncEpgpwSource(id, href, offset);
      } catch (err) {
        logger.warn('epg', `epgpw create sync failed: ${(err as Error).message}`);
        return res.status(502).json({ error: 'epgpw_unreachable' });
      }

      const doc = (await EpgSource.findOneAndUpdate(
        { id },
        {
          $set: {
            id,
            name: `EPG-PW-${region}`,
            url,
            channels: counts.channels,
            programs: counts.programs,
            lastSync: new Date().toISOString(),
            status: 'good',
            auto: false,
            interval: 'manual',
            builtin: false,
            source: 'epg-pw', // lowercase kind discriminator (UI shows the pretty 'EPG-PW' brand label)
            location: href, // area href — reused nullable field, needed to re-sync
            lineup_Type: 'Default',
            postalCode: null,
            aid: null,
            headendId: null,
            lineupId: `${region}-lineupId-DEFAULT`,
            country: region,
            device: null,
            timezone: null,
            languagecode: 'en',
          },
          // Seed the lifetime sync counters on first create (the inline sync above just succeeded);
          // a later re-add preserves any accumulated counts rather than resetting them.
          $setOnInsert: { syncSuccessCount: 1, syncFailCount: 0, order },
        },
        { upsert: true, new: true, projection: { _id: 0 } },
      ).lean()) as EpgSourceDoc | null;
      if (!doc) return next(new Error('epg source upsert returned no document'));
      return res.json({ ...doc, offsetDefaulted });
    }

    // ── Custom: uploaded XMLTV file (source 'xml file') ────────────────
    // A one-shot uploaded guide. Validate the content, write its channels/programs, then upsert the row.
    // Nothing to re-fetch later → no schedule; re-imports come through POST /:id/upload.
    if (source === 'xml file') {
      let content: string;
      try {
        content = isRaw ? decodeXmltvBody(req.body) : typeof b.content === 'string' ? b.content : '';
      } catch (err) {
        return res.status(400).json({ error: 'invalid_xmltv', issues: [(err as Error).message] });
      }
      const name = (isRaw ? qstr(q.name) : typeof b.name === 'string' ? b.name : '').trim();
      if (!content || !name) {
        return res.status(400).json({ error: 'name and content (string) required' });
      }
      const validation = validateXmltv(content);
      if (!validation.ok) {
        return res.status(400).json({ error: 'invalid_xmltv', issues: validation.errors });
      }
      const id = `xml-file:${slugify(name)}`;
      const counts = await writeXmltvEpg(content, id, offset);
      const rawFilename = (isRaw ? qstr(q.filename) : typeof b.filename === 'string' ? b.filename : '').trim();
      const filename = rawFilename || `${name}.xml`;
      const doc = (await EpgSource.findOneAndUpdate(
        { id },
        {
          $set: {
            id,
            name,
            url: filename, // the original filename (display only — there is no re-fetchable URL)
            channels: counts.channels,
            programs: counts.programs,
            lastSync: new Date().toISOString(),
            status: 'good',
            auto: false,
            interval: 'manual',
            builtin: false,
            source: 'xml file',
            location: null,
            lineup_Type: null,
            postalCode: null,
            aid: null,
            headendId: null,
            lineupId: null,
            country: null,
            device: null,
            timezone: null,
            languagecode: null,
          },
          $setOnInsert: { syncSuccessCount: 1, syncFailCount: 0, order },
        },
        { upsert: true, new: true, projection: { _id: 0 } },
      ).lean()) as EpgSourceDoc | null;
      if (!doc) return next(new Error('epg source upsert returned no document'));
      return res.json({ ...doc, offsetDefaulted });
    }

    // ── Custom: remote XMLTV URL (source 'remote url') OR Jesmann picker (source 'jesmann') ──────────────
    // Both are re-fetchable XMLTV URLs synced through the identical machinery (syncXmltvUrl + per-source
    // replace; re-syncs go through syncEpgSource). They differ only in the stored kind discriminator and the
    // deterministic id namespace, so a 'jesmann' source is type-distinct from a genuine 'remote url' source
    // (the Custom tab's Remote URL feature owns 'remote url'; the Jesmann guided picker owns 'jesmann').
    if (source === 'remote url' || source === 'jesmann') {
      const url = typeof b.url === 'string' ? b.url.trim() : '';
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!url || !name) {
        return res.status(400).json({ error: 'name and url (string) required' });
      }
      const idPrefix = source === 'jesmann' ? 'jesmann' : 'remote-url';
      const id = `${idPrefix}:${slugify(name)}`;
      let counts: { channels: number; programs: number };
      try {
        counts = await syncXmltvUrl(id, url, offset);
      } catch (err) {
        logger.warn('epg', `xmltv url create sync failed: ${(err as Error).message}`);
        return res.status(502).json({ error: 'xmltv_unreachable' });
      }
      const interval = (typeof b.interval === 'string' && b.interval) || 'manual';
      const doc = (await EpgSource.findOneAndUpdate(
        { id },
        {
          $set: {
            id,
            name,
            url,
            channels: counts.channels,
            programs: counts.programs,
            lastSync: new Date().toISOString(),
            status: 'good',
            auto: false,
            interval,
            builtin: false,
            source, // 'remote url' or 'jesmann' — kept distinct so the SOURCE chip / sync gate differentiate them
            location: null,
            lineup_Type: null,
            postalCode: null,
            aid: null,
            headendId: null,
            lineupId: null,
            country: null,
            device: null,
            timezone: null,
            languagecode: null,
          },
          $setOnInsert: { syncSuccessCount: 1, syncFailCount: 0, order },
        },
        { upsert: true, new: true, projection: { _id: 0 } },
      ).lean()) as EpgSourceDoc | null;
      if (!doc) return next(new Error('epg source upsert returned no document'));
      return res.json({ ...doc, offsetDefaulted });
    }

    // ── Gracenote branch (default) ─────────────────────────────────────
    const headendId = typeof b.headendId === 'string' ? b.headendId.trim() : '';
    const lineupId = typeof b.lineupId === 'string' ? b.lineupId.trim() : '';
    const postalCode = typeof b.postalCode === 'string' ? b.postalCode.trim() : '';
    if (!headendId || !lineupId || !postalCode) {
      return res.status(400).json({ error: 'headendId, lineupId and postalCode (string) required' });
    }
    const country = (typeof b.country === 'string' && b.country) || 'USA';
    const aid = (typeof b.aid === 'string' && b.aid) || 'orbebb';
    const lang = (typeof b.languagecode === 'string' && b.languagecode) || 'en-us';
    const interval = (typeof b.interval === 'string' && b.interval) || 'manual';
    const provider: GracenoteProvider = {
      type: typeof b.type === 'string' ? b.type : '',
      device: typeof b.device === 'string' ? b.device : '',
      lineupId,
      name: typeof b.name === 'string' ? b.name : '',
      location: typeof b.location === 'string' ? b.location : '',
      timezone: typeof b.timezone === 'string' ? b.timezone : '',
      postalCode,
      headendId,
    };

    const id = `gracenote:${headendId}:${lineupId}`;
    const urlTemplate = buildGridUrl(provider, { aid, country, lang, timespan: GRID_TIMESPAN });

    // Fetch + write programs first so a WAF/network failure leaves no broken source behind.
    let counts: { channels: number; programs: number };
    try {
      counts = await syncPrograms(id, urlTemplate, offset);
    } catch (err) {
      logger.warn('epg', `gracenote create sync failed: ${(err as Error).message}`);
      return res.status(502).json({ error: 'gracenote_unreachable' });
    }

    const displayName = provider.name + (provider.location ? ` — ${provider.location}` : '');
    const doc = (await EpgSource.findOneAndUpdate(
      { id },
      {
        $set: {
          id,
          name: displayName || `Gracenote ${headendId}`,
          url: urlTemplate,
          channels: counts.channels,
          programs: counts.programs,
          lastSync: new Date().toISOString(),
          status: 'good',
          auto: false,
          interval,
          builtin: false,
          source: 'gracenote', // lowercase kind discriminator (UI shows the pretty 'Gracenote' brand label)
          location: provider.location || null,
          lineup_Type: provider.type || null,
          postalCode,
          aid,
          headendId,
          lineupId,
          country,
          device: provider.device || null,
          timezone: provider.timezone || null,
          languagecode: lang,
        },
        // Seed the lifetime sync counters on first create (the inline sync above just succeeded);
        // a later re-add preserves any accumulated counts rather than resetting them. `order` lands the
        // new source at the end of the drag-ordered list (kept on a re-add via $setOnInsert).
        $setOnInsert: { syncSuccessCount: 1, syncFailCount: 0, order },
      },
      { upsert: true, new: true, projection: { _id: 0 } },
    ).lean()) as EpgSourceDoc | null;
    if (!doc) return next(new Error('epg source upsert returned no document'));
    res.json({ ...doc, offsetDefaulted });
  } catch (err) {
    next(err);
  }
});

// Re-sync a source's programs on demand (Gracenote OR EPG-PW), dispatched through the shared syncEpgSource.
epgSourcesRouter.post('/:id/sync', async (req, res, next) => {
  try {
    const src = (await EpgSource.findOne({ id: req.params.id }).lean()) as EpgSourceDoc | null;
    if (!src) return res.status(404).json({ error: 'not_found' });
    // Lowercase the stored kind for comparison so legacy capitalized rows ('Gracenote'/'EPG-PW') that
    // pre-date the normalization still dispatch (the boot migration rewrites them, this is belt-and-braces).
    const kind = (src.source ?? '').toLowerCase();
    // 'xml file' has nothing to re-fetch — it re-imports via POST /:id/upload, not here. 'jesmann' is a
    // re-fetchable XMLTV URL (same machinery as 'remote url'), so it syncs here too.
    if (kind !== 'gracenote' && kind !== 'epg-pw' && kind !== 'remote url' && kind !== 'jesmann') {
      return res.status(400).json({ error: 'sync supported only for gracenote / epg-pw / remote url / jesmann sources' });
    }
    try {
      // syncEpgSource sets status:'error' and rethrows on failure (it does not throw past here on success).
      const { source: doc, offsetDefaulted } = await syncEpgSource(src.id);
      return res.json({ ...doc, offsetDefaulted });
    } catch (err) {
      logger.error('epg', `sync failed: ${(err as Error).message}`);
      const code =
        kind === 'epg-pw'
          ? 'epgpw_unreachable'
          : kind === 'remote url' || kind === 'jesmann'
            ? 'xmltv_unreachable'
            : 'gracenote_unreachable';
      return res.status(502).json({ error: code });
    }
  } catch (err) {
    next(err);
  }
});

// Recompose all XMLTV guides on demand. Guides are PLAYLIST-scoped siblings of the composed M3U files (each
// merges programme data across every EPG source its channels link to), so an EPG-data change rebuilds them
// all: recompose every export surface (Global union + each Custom), which
// re-emits each guide and advances the xml* run-stats of whichever sources contributed. `id` anchors the
// action to a source (404 if unknown), but the recompose is global. See .claude/skills/xmltv/SKILL.md.
epgSourcesRouter.post('/:id/compose-guides', async (req, res, next) => {
  try {
    const src = (await EpgSource.findOne({ id: req.params.id }, { _id: 0, id: 1 }).lean()) as {
      id: string;
    } | null;
    if (!src) return res.status(404).json({ error: 'not_found' });
    await recomposeAllExports();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Validate an XMLTV document (uploaded `content` OR a remote `url`) WITHOUT persisting — the Custom Add /
// Upload modal's pre-flight. Returns { ok, channelCount, programmeCount, sample, errors } so the UI can
// surface specific issues before the user commits. The XMLTV analogue of POST /api/import/m3u/preview.
epgSourcesRouter.post('/xmltv/validate', async (req, res, next) => {
  try {
    if (Buffer.isBuffer(req.body)) {
      // Raw gzip/xml upload — gunzip + decode + DOM-validate. A bad-gzip / over-limit body is surfaced as a
      // validation issue (the modal already renders errors[]) rather than a hard error.
      let xml: string;
      try {
        xml = decodeXmltvBody(req.body);
      } catch (err) {
        return res.json({ ok: false, channelCount: 0, programmeCount: 0, sample: [], errors: [(err as Error).message] });
      }
      return res.json(validateXmltv(xml));
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const url = typeof b.url === 'string' ? b.url.trim() : '';
    const content = typeof b.content === 'string' ? b.content : '';
    // A pasted `content` body is DOM-validated; a `url` is STREAM-validated (bounded memory — a 2–10 GB
    // remote guide is never buffered just to count its channels/programmes).
    if (content) return res.json(validateXmltv(content));
    if (url) {
      try {
        return res.json(await validateXmltvUrl(url));
      } catch (err) {
        logger.warn('epg', `xmltv validate fetch failed: ${(err as Error).message}`);
        return res.status(502).json({ error: 'xmltv_unreachable' });
      }
    }
    return res.status(400).json({ error: 'content or url (string) required' });
  } catch (err) {
    next(err);
  }
});

// Re-import an uploaded-file ('xml file') source from a freshly uploaded XMLTV document — the detail-screen
// Upload action (the Sync replacement for a static upload). Validates, replaces the source's epgchannels +
// programs, refreshes counts/lastSync, and bumps the success counter. Rejects non-'xml file' sources.
epgSourcesRouter.post('/:id/upload', async (req, res, next) => {
  try {
    const src = (await EpgSource.findOne({ id: req.params.id }).lean()) as EpgSourceDoc | null;
    if (!src) return res.status(404).json({ error: 'not_found' });
    if (src.source !== 'xml file') return res.status(400).json({ error: 'not_an_xml_file_source' });
    // Raw gzip/xml upload (filename via query) or the legacy JSON { content, filename }.
    const isRaw = Buffer.isBuffer(req.body);
    const b = (isRaw ? {} : (req.body ?? {})) as Record<string, unknown>;
    let content: string;
    try {
      content = isRaw ? decodeXmltvBody(req.body) : typeof b.content === 'string' ? b.content : '';
    } catch (err) {
      return res.status(400).json({ error: 'invalid_xmltv', issues: [(err as Error).message] });
    }
    if (!content) return res.status(400).json({ error: 'content (string) required' });
    const validation = validateXmltv(content);
    if (!validation.ok) return res.status(400).json({ error: 'invalid_xmltv', issues: validation.errors });
    const { offset, defaulted: offsetDefaulted } = await resolveProgramOffset();
    const counts = await writeXmltvEpg(content, src.id, offset);
    const rawFilename = isRaw
      ? typeof req.query.filename === 'string'
        ? req.query.filename.trim()
        : ''
      : typeof b.filename === 'string'
        ? b.filename.trim()
        : '';
    const filename = rawFilename || src.url;
    const doc = (await EpgSource.findOneAndUpdate(
      { id: src.id },
      {
        $set: {
          channels: counts.channels,
          programs: counts.programs,
          lastSync: new Date().toISOString(),
          status: 'good',
          url: filename,
        },
        $inc: { syncSuccessCount: 1 },
      },
      { new: true, projection: { _id: 0 } },
    ).lean()) as EpgSourceDoc | null;
    res.json({ ...doc, offsetDefaulted });
  } catch (err) {
    next(err);
  }
});
