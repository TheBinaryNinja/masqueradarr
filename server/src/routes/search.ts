// Global search — one admin-only endpoint spanning Playlists, Playlist Channels, EPG Sources, and EPG
// channels (GET /api/search?q=<term>). Powers the topbar search box. Server-side because EPG channels are
// deliberately NOT loaded client-side (a large guide is hundreds of MB); the other surfaces could be filtered
// client-side but are folded in here so results are one consistent, role-scoped (admin) payload.
//
// Results are GROUPED for display: `groups` holds channel / epg-channel matches bucketed by their owning
// parent resource (a playlist / an EPG source), and `topLevel` holds direct playlist / EPG-source name
// matches. Each row carries the ids its click handler needs (no re-lookup on the client).
//
// No text index exists (EpgChannel/PlaylistChannel indexes are source-leading), so each bucket is a
// case-insensitive regex scan — bounded by a fetch cap + a per-group row limit + a q.length >= 2 floor.

import { Router } from 'express';
import { Playlist } from '../models/Playlist.js';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import { EpgSource } from '../models/EpgSource.js';
import { EpgChannel } from '../models/EpgChannel.js';

export const searchRouter = Router();

const MATCH_CAP = 300; // max docs fetched per channel/epg-channel bucket (bounds memory on a broad query)
const ROW_LIMIT = 25; // max rows shown per parent group (the rest surface as "+N more")
const TOP_LIMIT = 25; // max direct playlist / EPG-source name matches

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ResultRow {
  type: 'playlist' | 'epg-source' | 'channel' | 'epg-channel';
  id: string;
  label: string;
  sublabel: string;
  playlistId?: string;
  epgSourceId?: string;
}
interface ResultGroup {
  kind: 'playlist' | 'epg-source';
  id: string;
  label: string;
  rows: ResultRow[];
  total: number;
}

// Group flat rows by a key, keeping insertion order, capping each group's rows at ROW_LIMIT while tracking
// the true (pre-cap) total. `label` resolves a group key to its display name.
function bucket(
  rows: Array<ResultRow & { _key: string }>,
  kind: ResultGroup['kind'],
  label: (key: string) => string,
): ResultGroup[] {
  const byKey = new Map<string, ResultGroup>();
  for (const r of rows) {
    let g = byKey.get(r._key);
    if (!g) {
      g = { kind, id: r._key, label: label(r._key), rows: [], total: 0 };
      byKey.set(r._key, g);
    }
    g.total += 1;
    if (g.rows.length < ROW_LIMIT) {
      const { _key, ...row } = r;
      g.rows.push(row);
    }
  }
  return [...byKey.values()];
}

searchRouter.get('/', async (req, res, next) => {
  try {
    const q = (typeof req.query.q === 'string' ? req.query.q : '').trim();
    if (q.length < 2) {
      return res.json({ groups: [], topLevel: { playlists: [], epgSources: [] } });
    }
    const rx = new RegExp(escapeRegExp(q), 'i');

    // Label maps (small collections) — playlist id → name, epg source id → name.
    const [playlists, epgSources] = await Promise.all([
      Playlist.find({}, { _id: 0, id: 1, name: 1, endpoint: 1, source: 1 }).lean<
        Array<{ id: string; name: string; endpoint?: string; source?: string | null }>
      >(),
      EpgSource.find({}, { _id: 0, id: 1, name: 1, source: 1, lineupId: 1 }).lean<
        Array<{ id: string; name: string; source?: string | null; lineupId?: string | null }>
      >(),
    ]);
    const playlistName = new Map(playlists.map((p) => [p.id, p.name]));
    const epgSourceName = new Map(epgSources.map((e) => [e.id, e.name]));

    // Channel + epg-channel matches (bucketed by parent), plus the direct name matches.
    const [chDocs, epgChDocs] = await Promise.all([
      PlaylistChannel.find(
        { $or: [{ tvg_name: rx }, { tvg_id: rx }, { group: rx }, { channelNo: rx }] },
        { _id: 1, tvg_name: 1, tvg_id: 1, group: 1, channelNo: 1, source: 1 },
      )
        .limit(MATCH_CAP)
        .lean<
          Array<{
            _id: string;
            tvg_name: string;
            tvg_id: string | null;
            group: string | null;
            channelNo: string | null;
            source: string;
          }>
        >(),
      EpgChannel.find(
        { $or: [{ callSign: rx }, { affiliateName: rx }, { channelId: rx }, { channelNo: rx }] },
        { _id: 1, callSign: 1, affiliateName: 1, channelId: 1, channelNo: 1, source: 1 },
      )
        .limit(MATCH_CAP)
        .lean<
          Array<{
            _id: string;
            callSign: string | null;
            affiliateName: string;
            channelId: string;
            channelNo: string | null;
            source: string;
          }>
        >(),
    ]);

    const chRows = chDocs.map((c) => ({
      _key: c.source,
      type: 'channel' as const,
      id: c._id,
      label: c.tvg_name,
      sublabel: [c.group, c.channelNo ? `#${c.channelNo}` : null].filter(Boolean).join(' · '),
      playlistId: c.source,
    }));
    const epgChRows = epgChDocs.map((c) => ({
      _key: c.source,
      type: 'epg-channel' as const,
      id: c._id,
      label: c.callSign || c.affiliateName || c.channelId,
      sublabel: [c.affiliateName, c.channelNo ? `#${c.channelNo}` : null].filter(Boolean).join(' · '),
      epgSourceId: c.source,
    }));

    const groups: ResultGroup[] = [
      ...bucket(chRows, 'playlist', (k) => playlistName.get(k) ?? k),
      ...bucket(epgChRows, 'epg-source', (k) => epgSourceName.get(k) ?? k),
    ];

    const topLevel = {
      playlists: playlists
        .filter((p) => rx.test(p.name))
        .slice(0, TOP_LIMIT)
        .map((p) => ({
          type: 'playlist' as const,
          id: p.id,
          label: p.name,
          sublabel: [p.endpoint, isCustomTag(p.source) ? p.source : null].filter(Boolean).join(' · '),
        })),
      epgSources: epgSources
        .filter((e) => rx.test(e.name) || (e.lineupId != null && rx.test(e.lineupId)))
        .slice(0, TOP_LIMIT)
        .map((e) => ({
          type: 'epg-source' as const,
          id: e.id,
          label: e.name,
          sublabel: e.source ?? '',
        })),
    };

    res.json({ groups, topLevel });
  } catch (err) {
    next(err);
  }
});

// A custom playlist's `source` is a type tag ('clone'/'file'/'url'/'hdhomerun'/'local'); a Default source
// playlist's `source` is its source id (== its own id). Only surface the tag for the custom types.
function isCustomTag(source: string | null | undefined): boolean {
  return !!source && ['clone', 'file', 'url', 'hdhomerun', 'local', 'import'].includes(source.toLowerCase());
}
