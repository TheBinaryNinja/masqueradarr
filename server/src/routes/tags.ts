// Custom tags — the admin-only CRUD registry for user-managed labels (mounted at /api/tags). Tags are shared
// app-wide and assigned to Playlists / EPG Sources / Channels by opaque Tag.id (the `tags: string[]` array on
// each record). Create / rename / delete here; assignment lives on the respective record edit routes. A rename
// is a single-doc write (records reference by id, so every row reflects it) — only DELETE cascades
// (services/tags.ts cascadeDeleteTag). Uniqueness is enforced case-insensitively in-route, like the group routes.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { Tag, type TagDoc } from '../models/Tag.js';
import { cascadeDeleteTag } from '../services/tags.js';

export const tagsRouter = Router();

// GET / — all tags, ordered for the manager + picker.
tagsRouter.get('/', async (_req, res, next) => {
  try {
    const tags = await Tag.find({}, { _id: 0 }).sort({ order: 1, name: 1 }).lean();
    res.json(tags);
  } catch (err) {
    next(err);
  }
});

// POST / { name } — create a tag. Trimmed + non-empty; rejects a case-insensitive duplicate name (409). The
// opaque id is a randomUUID (decoupled from the name so a later rename never churns references).
tagsRouter.post('/', async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name (non-empty string) required' });
    const existing = await Tag.findOne({ name: new RegExp(`^${escapeRegExp(name)}$`, 'i') }, { _id: 0, id: 1 }).lean();
    if (existing) return res.status(409).json({ error: 'tag_exists' });
    const last = await Tag.findOne({}, { _id: 0, order: 1 }).sort({ order: -1 }).lean();
    const order = (last?.order ?? -1) + 1;
    const tag: TagDoc = { id: randomUUID(), name, order };
    await Tag.create(tag);
    res.status(201).json(tag);
  } catch (err) {
    next(err);
  }
});

// PUT /:id { name } — rename a tag. No cascade: records reference the tag by id, so the new name resolves
// everywhere automatically. Rejects a case-insensitive collision with a DIFFERENT tag (409). 404 if missing.
tagsRouter.put('/:id', async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name (non-empty string) required' });
    const collision = await Tag.findOne(
      { name: new RegExp(`^${escapeRegExp(name)}$`, 'i'), id: { $ne: req.params.id } },
      { _id: 0, id: 1 },
    ).lean();
    if (collision) return res.status(409).json({ error: 'tag_exists' });
    const doc = (await Tag.findOneAndUpdate(
      { id: req.params.id },
      { $set: { name } },
      { new: true, projection: { _id: 0 } },
    ).lean()) as TagDoc | null;
    if (!doc) return res.status(404).json({ error: 'not_found' });
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// DELETE /:id — remove the tag and $pull its id from every referencing record (playlists / epg sources /
// channels). 404 if the tag doesn't exist; 204 on success.
tagsRouter.delete('/:id', async (req, res, next) => {
  try {
    const tag = await Tag.findOne({ id: req.params.id }, { _id: 0, id: 1 }).lean();
    if (!tag) return res.status(404).json({ error: 'not_found' });
    await cascadeDeleteTag(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
