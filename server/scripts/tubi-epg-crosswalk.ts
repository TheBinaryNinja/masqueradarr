// Generate / refine the committed tubi→gracenote EPG-link crosswalk (server/seed-data/tubi-playlist-addon.json).
// tubi's afterSync (sources/adapters/tubi.ts) applies the HIGH-tier rows to never-touched tubi PlaylistChannels
// after a sync, BEFORE its own inline self-EPG fills the rest (the dlhd two-tier pattern). This generator is
// READ-ONLY against Mongo; its only write is the crosswalk file.
//
// Unlike the dlhd/dulo crosswalks (which fuzzy-name-match against Mongo), tubi's link is DETERMINISTIC: it is
// ported from FastChannels' community gracenote_map.csv, whose `tubi` rows carry an EXACT Gracenote station id
// (tmsid) per Tubi content_id. So this script does not score names — it JOINS:
//   FC (content_id → tmsid)  ⋈  Mongo EpgChannel(channelId == tmsid, source ∈ the loaded Gracenote lineups)
// to pick the CORRECT `epg` source id per row. A tmsid present in more than one loaded lineup prefers a DITV
// lineup (the dominant US guide), else the first by id. A tmsid not present in any loaded Gracenote source is
// still WRITTEN (targeting the DITV default) so it auto-links on a LATER sync once that lineup is added — the
// guarded applier (sources/epgCrosswalk.ts) skips a row whose (epg, tvg_id) isn't a real epgchannels doc, so a
// defaulted/wrong-lineup guess can never produce a FALSE link. The stdout report lists resolved vs. defaulted.
//
// The tmsid map is read from FastChannels' CSV — path via env FASTCHANNELS_GRACENOTE_MAP_PATH, else the sibling
// repo's ../FastChannels/app/data/gracenote_map.csv. (Re-run after FC refreshes its map to re-port the rows.)
// All rows are confidence:'high' (an exact tmsid is not a guess); there is no medium tier here.
//
// Usage (from server/):  npm run crosswalk:tubi-epg
//                        tsx scripts/tubi-epg-crosswalk.ts
// Requires the same Mongo config the server uses (MASQUERADARR_CONFIG env, else ./config.local.json), with the
// US Gracenote EPG sources already synced into it.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { connect, disconnect } from '../src/db.js';
import { EpgSource } from '../src/models/EpgSource.js';
import { EpgChannel } from '../src/models/EpgChannel.js';
import { TUBI_EPG_ADDON_FILE } from '../src/sources/paths.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = TUBI_EPG_ADDON_FILE;

// FastChannels' community map (provider,key,tmsid,time_shift,notes). Env override mirrors FC's own env name.
const FC_MAP_PATH =
  process.env.FASTCHANNELS_GRACENOTE_MAP_PATH ||
  resolve(here, '..', '..', '..', 'FastChannels', 'app', 'data', 'gracenote_map.csv');

// The DITV lineup is the dominant US guide; default unresolved rows here so they re-link once it's present.
const DEFAULT_EPG = 'gracenote:DITV:USA-DITV-DEFAULT';

type FcRow = { contentId: string; tmsid: string; name: string };
type AddonRow = {
  source: 'tubi';
  id: string;
  tvg_id: string;
  epg: string;
  tubi_name: string;
  tmsid: string;
  score: number;
  confidence: 'high';
};

/** Parse the FC CSV and keep only the `tubi` rows. Names carry no commas in practice; join the tail defensively. */
function readFcTubiRows(): FcRow[] {
  const text = readFileSync(FC_MAP_PATH, 'utf8');
  const lines = text.split(/\r?\n/).slice(1).filter(Boolean); // drop the header
  const out: FcRow[] = [];
  for (const line of lines) {
    const parts = line.split(',');
    if (parts[0] !== 'tubi') continue;
    const contentId = (parts[1] ?? '').trim();
    const tmsid = (parts[2] ?? '').trim();
    const name = parts.slice(4).join(',').trim(); // notes column (display name)
    if (!contentId || !tmsid) continue;
    out.push({ contentId, tmsid, name });
  }
  return out;
}

async function main(): Promise<void> {
  const fc = readFcTubiRows();

  const { mongoUri } = loadConfig();
  await connect(mongoUri);

  // Every loaded Gracenote lineup's channels: build tmsid (channelId) → the lineup source id(s).
  const gracenoteIds = (
    await EpgSource.find({ source: 'Gracenote' }, { id: 1 }).lean<{ id: string }[]>()
  ).map((s) => s.id);
  const epgChannels = await EpgChannel.find(
    { source: { $in: gracenoteIds } },
    { channelId: 1, source: 1 },
  ).lean<{ channelId: string; source: string }[]>();

  const byTmsid = new Map<string, string[]>();
  for (const e of epgChannels) {
    const arr = byTmsid.get(e.channelId) ?? [];
    arr.push(e.source);
    byTmsid.set(e.channelId, arr);
  }

  // Prefer a DITV lineup when a tmsid is in several; else the first by id; else the DITV default (unresolved).
  const pickEpg = (tmsid: string): { epg: string; resolved: boolean } => {
    const sources = byTmsid.get(tmsid);
    if (!sources || !sources.length) return { epg: DEFAULT_EPG, resolved: false };
    const ditv = sources.find((s) => s.includes('DITV'));
    return { epg: ditv ?? [...sources].sort()[0], resolved: true };
  };

  const rows: AddonRow[] = [];
  const unresolved: FcRow[] = [];
  for (const r of fc) {
    const { epg, resolved } = pickEpg(r.tmsid);
    if (!resolved) unresolved.push(r);
    rows.push({
      source: 'tubi',
      id: `tubi:${r.contentId}`,
      tvg_id: r.tmsid,
      epg,
      tubi_name: r.name,
      tmsid: r.tmsid,
      score: 100,
      confidence: 'high',
    });
  }

  rows.sort((a, b) => a.tubi_name.localeCompare(b.tubi_name));
  writeFileSync(OUT_PATH, `${JSON.stringify(rows, null, 2)}\n`);

  const bySource: Record<string, number> = {};
  for (const r of rows) bySource[r.epg] = (bySource[r.epg] || 0) + 1;

  console.log(
    `[tubi-crosswalk] FC tubi rows=${fc.length}  gracenote sources=${gracenoteIds.length} ` +
      `[${gracenoteIds.join(', ')}]  gracenote epgchannels=${epgChannels.length}`,
  );
  console.log(`[tubi-crosswalk] resolved=${rows.length - unresolved.length}  defaulted(unresolved)=${unresolved.length}`);
  console.log(`[tubi-crosswalk] rows by gracenote source: ${JSON.stringify(bySource)}`);
  console.log(`[tubi-crosswalk] wrote ${rows.length} rows → ${OUT_PATH}`);
  if (unresolved.length) {
    console.log(`\n--- defaulted to ${DEFAULT_EPG} (tmsid not in a loaded Gracenote lineup; re-links on a later sync) ---`);
    unresolved.forEach((r) => console.log(`  ${r.tmsid}  ${r.name}`));
  }

  await disconnect();
}

main().catch(async (err) => {
  console.error(`[tubi-epg-crosswalk] ${(err as Error).message}`);
  await disconnect().catch(() => {});
  process.exit(1);
});
