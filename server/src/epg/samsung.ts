// Samsung TV Plus self-EPG — builds the 'samsung' guide from Matt Huisman's per-region XMLTV mirror
// (i.mjh.nz/SamsungTVPlus/<region>.xml.gz), then hands ALREADY-MAPPED docs to fastSelfEpg's writer. Unlike
// tubi (programs embedded in the catalog) Samsung's guide is a SEPARATE per-region fetch — so this module
// fetches + gunzips + parses each region's XMLTV via the EXISTING shared parser (epg/xmltvIngest.ts), accumulates
// across regions, then writes ONCE (a single per-source REPLACE — it must NOT stream per region, since the
// streaming path's up-front deleteMany({source}) would wipe sibling regions).
//
// ⚠️ Composite guide-key convention (composeGuide.ts): EpgChannel._id / Program.channelId are "samsung:<chId>",
// joined to a PlaylistChannel by `${epg}:${tvg_id}`. The <programme channel> ids ARE the catalog channel ids, so
// linkFastSelfEpg's tvg_id=<chId> matches each PlaylistChannel _id "samsung:<chId>".
//
// Guide-richness note: the shared mapXmltvToPrograms keeps title/desc/first-category but DROPS XMLTV
// rating/sub-title/episode-num/icon (a thinner guide than FastChannels) — enriching that is a follow-up (the
// Tubi-U2-style uplift) and must not fork the shared mapper here.

import {
  decodeXmltvBody,
  parseXmltv,
  mapXmltvToEpgChannels,
  mapXmltvToPrograms,
  type XmltvChannel,
  type XmltvProgramme,
} from './xmltvIngest.js';
import { writeFastEpg } from './fastSelfEpg.js';
import { logger } from '../sources/core/logger.js';
import { EPG_URL, UA, samsungRegions } from '../sources/adapters/samsung/config.js';
import type { EpgChannelDoc } from '../models/EpgChannel.js';
import type { ProgramDoc } from '../models/Program.js';

export const SAMSUNG_EPG_NAME = 'Samsung TV Plus Schedule';
export const SAMSUNG_EPG_URL = 'https://i.mjh.nz/SamsungTVPlus/';

const SOURCE_ID = 'samsung';

// Fetch a region's gzip XMLTV → decoded string. decodeXmltvBody handles the gzip magic-byte sniff + size cap.
async function fetchRegionXml(region: string): Promise<string> {
  const res = await fetch(EPG_URL.replace('{region}', region), { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return decodeXmltvBody(Buffer.from(await res.arrayBuffer()));
}

/**
 * Fetch every requested region's XMLTV, parse via the shared parser, and return mapped docs (one merged set —
 * the caller writes them in a single REPLACE). A per-region failure is logged and SKIPPED (never throws the
 * whole guide). Any programme-referenced channel absent from the <channel> blocks is synthesized so the guide
 * join + self-link never orphan a program (mjh.nz files may omit <channel> elements).
 */
export async function fetchSamsungEpg(
  regions: string[],
  offset: string,
): Promise<{ channelDocs: EpgChannelDoc[]; programDocs: ProgramDoc[] }> {
  const allChannels: XmltvChannel[] = [];
  const allProgrammes: XmltvProgramme[] = [];
  for (const region of regions) {
    try {
      const { channels, programmes } = parseXmltv(await fetchRegionXml(region));
      allChannels.push(...channels);
      allProgrammes.push(...programmes);
    } catch (err) {
      logger.warn('epg', `[${SOURCE_ID}] EPG region '${region}' skipped: ${(err as Error).message}`);
    }
  }

  const channelDocs = mapXmltvToEpgChannels(allChannels, SOURCE_ID);
  const programDocs = mapXmltvToPrograms(allProgrammes, SOURCE_ID, offset);

  const have = new Set(channelDocs.map((c) => c.channelId));
  for (const p of allProgrammes) {
    if (have.has(p.channel)) continue;
    have.add(p.channel);
    channelDocs.push({
      _id: `${SOURCE_ID}:${p.channel}`,
      callSign: null,
      affiliateName: p.channel,
      channelId: p.channel,
      channelNo: null,
      source: SOURCE_ID,
    });
  }

  return { channelDocs, programDocs };
}

/**
 * Standalone EPG sync (the EPG Sources "Sync" button + scheduler path, dispatched from syncEpgSource on
 * src.source === 'samsung'). Re-fetches the per-region XMLTV and per-source replaces the guide. EPG-ONLY: never
 * touches the samsung playlist or its channel links (that direction is the playlist sync's afterSync hook).
 */
export async function syncSamsungEpg(
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number; channelIds: string[] }> {
  const { channelDocs, programDocs } = await fetchSamsungEpg(samsungRegions(), offset);
  return writeFastEpg(sourceId, channelDocs, programDocs);
}
