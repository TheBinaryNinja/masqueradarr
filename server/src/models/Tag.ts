// Tag — a user-managed custom label, shared across the app (Playlists, EPG Sources, Channels). The tag is
// an opaque, stable business-key `id` (crypto.randomUUID, decoupled from the display `name` so a rename is a
// single-doc write with no reference churn — the same posture as PlaylistChannel.failoverGroupId). Records
// reference a tag BY id (a `tags: string[]` array on Playlist / EpgSource / PlaylistChannel); the id→name
// resolution happens in the UI + search. A delete cascades a `$pull` of the id from every referencing record
// (services/tags.ts cascadeDeleteTag). All tags render as one magenta pill variant — there is no per-tag color.

import { Schema, model } from 'mongoose';

export interface TagDoc {
  id: string; // opaque crypto.randomUUID business key (separate from Mongo _id)
  name: string; // display label (unique case-insensitively, route-enforced)
  order: number; // list ordinal for the manager + picker (drag-reorder is a future add)
}

const TagSchema = new Schema<TagDoc>(
  {
    id: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    order: { type: Number, required: true, default: 0 },
  },
  { versionKey: false },
);

export const Tag = model<TagDoc>('Tag', TagSchema);
