// Generate the committed zlive→station-id EPG-link crosswalk (server/seed-data/zlive-playlist-addon.json).
// zlive publishes no guide data at all (no tvg ids, no logos, no numbers), so its linear channels can only be
// linked to guides the operator ALREADY has. The zlive adapter's afterSync (and the post-guide-sync re-link)
// applies the HIGH rows through sources/epgCrosswalk.ts applyStationCrosswalk — see that header for how a
// station id resolves against DITV / other Gracenote lineups / Jesmann guides. Medium rows are written for
// review and never auto-applied.
//
// Why a station-id crosswalk (and not the dlhd/dulo name scorer): zlive's names are short and brand-only, and a
// third of the catalog is foreign. The scorer, ported and run against the live DITV + NYC OTA grids, scored 41
// right, 28 of 32 medium rows WRONG, and — worse — sends unmarked foreign channels to US guides ("TNT Sports 1"
// and "Fox Sports 503" both land on FS1). So every row here comes from a CURATED decision, never a fuzzy one:
//   (1) US_PINS — 76 hand-verified Gracenote station ids for the US channels (41 the scorer also got right, 35
//       it misses or mislinks: "AE" → A&E, "HBO Movies" → HBOMVHD, "Showtime" → Paramount+ with Showtime…),
//       pinned to the DITV national lineup, or to the NYC OTA lineup for the broadcast networks (zlive's ABC is
//       the East feed — a captured frame matched WABC's schedule; FOX has no national feed, so WNYW).
//   (2) SCOPES — a curated COUNTRY SCOPE per foreign channel. The channel is then matched BY NAME, but only
//       inside the Jesmann 7-day "Standard" guide(s) of that country, whose <channel id> IS the Gracenote station
//       id. Scoping is the whole trick: "TNT Sports 1" is looked up in the UK/IE guides and can never meet US TNT;
//       "Fox Sports 503" is Foxtel's AU channel, never FS1; "DAZN 1" means a different station in Germany, Spain
//       and Italy. Overrides cover names the scope alone can't bridge (Polsat's 2024 rename, beIN FR numbering,
//       Foxtel's branded 501/502/504, Ireland's "ROI" Premier Sports feeds).
// Only the <channel> header of each Jesmann file is read — the body is streamed and cut at the first
// <programme>, so a 25-350 MB guide costs a few hundred KB (up to ~4 MB for the US files).
//
// Confidence: HIGH only when the scoped lookup is unambiguous — the channel identity is known and every
// candidate station is a quality/platform twin of one channel (the HD one is kept). MEDIUM when the identity is
// assumed rather than confirmed (`review`), or when the picked station ALSO answers another zlive channel's
// lookup in a different market (German vs Spanish "DAZN 1" — the Spain guide lists both stations). Merely being
// listed in another country's guide is NOT a signal: Germany's guide carries UK Sky Sports stations, for one.
// Unmatched channels are reported, never guessed.
//
// Inputs: a SAVED copy of zlive's catalog (cast.<domain>/channels.json — the same JSON the adapter lists). This
// script never contacts zlive: it keeps a restreamer leech list, so the catalog is fetched by hand from a machine
// that may, and passed in. The only network traffic is the Jesmann headers (cdn.epg.guru). No Mongo.
//
// Usage (from server/):  npm run crosswalk:zlive-stations -- --catalog /path/to/channels.json [--dry-run]
//                        tsx scripts/zlive-station-crosswalk.ts --catalog /path/to/channels.json [--out file]
// (--catalog may also come from env ZLIVE_CATALOG_FILE.) Refuses to write when a Jesmann header fails to load or
// the catalog has no linear channels, so a bad run can never replace the committed file with a degraded one.

import { readFileSync, writeFileSync } from 'node:fs';
import { ZLIVE_EPG_ADDON_FILE } from '../src/sources/paths.js';

// --- Constants -------------------------------------------------------------------------------------------

// Mirrors JESMANN_CDN_BASE in src/composables/jesmannCatalog.ts (the SPA package can't be imported from here).
const JESMANN_CDN_BASE = 'https://cdn.epg.guru';
const HEADER_BYTE_CAP = 8 * 1024 * 1024; // Range cap; the largest header seen (UnitedStates) is ~3.8 MB
const FETCH_TIMEOUT_MS = 60_000;
const UA = 'masqueradarr-crosswalk (+https://github.com/TheBinaryNinja/masqueradarr)';

// The two Gracenote lineups the US pins target. Both ids are the same on every install (the OTA id does not
// encode the ZIP — its station ids do, so NYC rows only link for an NYC OTA source; the applier's guard skips
// them elsewhere rather than linking a wrong market).
const DITV_EPG = 'gracenote:DITV:USA-DITV-DEFAULT';
const OTA_EPG = 'gracenote:lineupId:USA-lineupId-DEFAULT';

// zlive's own slug rule (the adapter's: catalog id minus a leading "auto-" then "evt-"). Rows are keyed
// `zlive:<slug>` — the PlaylistChannel _id the adapter's normalize writes.
const SLUG_RE = /^[A-Za-z0-9_-]+$/;
const slugOf = (catalogId: string): string => catalogId.replace(/^auto-/, '').replace(/^evt-/, '');
const isEventId = (catalogId: string): boolean => /^(?:auto-)?evt-/.test(catalogId);

// Jesmann 7-day Standard regions (file = /7daygracenote/<key>.xml): every market a scope below names, plus the two
// US guides the pins are cross-checked against. Keys are the file names; values the SPA catalog's display names
// (what an operator picks in Add EPG → Jesmann, and what the `regions` field of each row lists).
const REGIONS = {
  UnitedKingdom: 'United Kingdom',
  Ireland: 'Ireland',
  France: 'France',
  Germany: 'Germany',
  Italy: 'Italy',
  Spain: 'Spain',
  Poland: 'Poland',
  Australia: 'Australia',
  Canada: 'Canada',
  Brazil: 'Brazil',
  UnitedStates: 'United States',
  'UnitedStates-Locals': 'United States - Locals',
} as const;
type RegionKey = keyof typeof REGIONS;
const REGION_KEYS = Object.keys(REGIONS) as RegionKey[];

const UKIE: RegionKey[] = ['UnitedKingdom', 'Ireland'];
const US: RegionKey[] = ['UnitedStates', 'UnitedStates-Locals'];

// --- (1) US pins: hand-verified Gracenote station ids ---------------------------------------------------
// Verified against the live DITV national (548 ch) and NYC OTA (164 ch) grids; 75 of 76 are also present in
// Jesmann's UnitedStates file (the generator re-checks and reports). `alt` lists extra station ids for the SAME
// channel, emitted as later rows (no pinned epg) so a guide that carries only the alternate still links.

type UsPin = { slug: string; lineup: 'DITV' | 'OTA'; station: string; callSign: string; alt?: string[]; note?: string };

const US_PINS: UsPin[] = [
  // Scorer-verified (the name scorer also reaches these at >= 80; pinned so a scorer tweak can't move them).
  { slug: 'acc-network', lineup: 'DITV', station: '111871', callSign: 'ACC' },
  { slug: 'amc', lineup: 'DITV', station: '10021', callSign: 'AMC' },
  { slug: 'animal-planet', lineup: 'DITV', station: '57394', callSign: 'APLHD' },
  { slug: 'axs-tv', lineup: 'DITV', station: '28506', callSign: 'AXSTV' },
  { slug: 'bbc-america', lineup: 'DITV', station: '64492', callSign: 'BBCAHD' },
  { slug: 'big-ten-network', lineup: 'DITV', station: '56783', callSign: 'BIGTEN' },
  { slug: 'boomerang', lineup: 'DITV', station: '21883', callSign: 'BOOM' },
  { slug: 'bravo', lineup: 'DITV', station: '10057', callSign: 'BRAVO' },
  { slug: 'cartoon-network', lineup: 'DITV', station: '60048', callSign: 'TOONHD' },
  { slug: 'cnbc', lineup: 'DITV', station: '10139', callSign: 'CNBC' },
  { slug: 'comedy-central', lineup: 'DITV', station: '10149', callSign: 'COMEDY' },
  { slug: 'disney-channel', lineup: 'DITV', station: '59684', callSign: 'DISNHD' },
  { slug: 'disney-junior', lineup: 'DITV', station: '74885', callSign: 'DJCHHD' },
  { slug: 'disney-xd', lineup: 'DITV', station: '60006', callSign: 'DXDHD' },
  { slug: 'espn', lineup: 'DITV', station: '10179', callSign: 'ESPN' },
  { slug: 'espn2', lineup: 'DITV', station: '12444', callSign: 'ESPN2' },
  { slug: 'espnews', lineup: 'DITV', station: '16485', callSign: 'ESPNEWS' },
  { slug: 'espnu', lineup: 'DITV', station: '45654', callSign: 'ESPNU' },
  { slug: 'food-network', lineup: 'DITV', station: '12574', callSign: 'FOOD' },
  { slug: 'fox-sports-1', lineup: 'DITV', station: '82547', callSign: 'FS1HD' },
  { slug: 'fox-sports-2', lineup: 'DITV', station: '59305', callSign: 'FS2HD' },
  { slug: 'fx', lineup: 'DITV', station: '14321', callSign: 'FX' },
  { slug: 'fxm', lineup: 'DITV', station: '14988', callSign: 'FXM' },
  { slug: 'fxx', lineup: 'DITV', station: '17927', callSign: 'FXX' },
  { slug: 'golf-channel', lineup: 'DITV', station: '14899', callSign: 'GOLF' },
  { slug: 'hbo', lineup: 'DITV', station: '10240', callSign: 'HBO' },
  { slug: 'hgtv', lineup: 'DITV', station: '14902', callSign: 'HGTV' },
  { slug: 'mlb-network', lineup: 'DITV', station: '62085', callSign: 'MLBHDA' },
  { slug: 'mtv', lineup: 'DITV', station: '10986', callSign: 'MTV' },
  { slug: 'nba-tv', lineup: 'DITV', station: '32281', callSign: 'NBATV' },
  { slug: 'nfl-network', lineup: 'DITV', station: '45399', callSign: 'NFLHD' },
  { slug: 'nhl-network', lineup: 'DITV', station: '58690', callSign: 'NHLHD' },
  { slug: 'nickelodeon', lineup: 'DITV', station: '59432', callSign: 'NIKHD' },
  { slug: 'nicktoons', lineup: 'DITV', station: '30420', callSign: 'NIKTON' },
  { slug: 'starz', lineup: 'DITV', station: '12719', callSign: 'STARZ' },
  { slug: 'syfy', lineup: 'DITV', station: '11097', callSign: 'SYFY' },
  { slug: 'tbs', lineup: 'DITV', station: '11867', callSign: 'TBS' },
  { slug: 'telemundo', lineup: 'OTA', station: '54437', callSign: 'WNJUDT' },
  // DITV carries the SD Tennis Channel only; Jesmann's US file carries the HD station instead.
  { slug: 'tennis-channel', lineup: 'DITV', station: '33395', callSign: 'TENNIS', alt: ['60316'] },
  { slug: 'tnt', lineup: 'DITV', station: '11164', callSign: 'TNT' },
  { slug: 'trutv', lineup: 'DITV', station: '10153', callSign: 'TRUTV' },

  // Curated: the right station exists but zlive's name defeats (or misleads) the scorer.
  { slug: 'ae-network', lineup: 'DITV', station: '10035', callSign: 'AETV', note: 'zlive "AE" = A&E' },
  { slug: 'american-heroes-channel', lineup: 'DITV', station: '18284', callSign: 'AHC' },
  { slug: 'cbs-sports-network', lineup: 'DITV', station: '16365', callSign: 'CBSSN' },
  { slug: 'discovery-channel', lineup: 'DITV', station: '11150', callSign: 'DSC' },
  { slug: 'discovery-family', lineup: 'DITV', station: '16618', callSign: 'DFC' },
  { slug: 'espn-deportes', lineup: 'DITV', station: '25595', callSign: 'ESPND' },
  { slug: 'fox-deportes', lineup: 'DITV', station: '15377', callSign: 'FXDEP' },
  { slug: 'freeform', lineup: 'DITV', station: '10093', callSign: 'FREEFRM' },
  { slug: 'hbo-comedy', lineup: 'DITV', station: '59839', callSign: 'HBOCHD', note: 'the scorer picks Comedy Central at 79' },
  { slug: 'hbo-drama', lineup: 'DITV', station: '10243', callSign: 'HBODRMA', note: 'ex HBO Signature' },
  { slug: 'hbo-latino', lineup: 'DITV', station: '24553', callSign: 'HBOLAT' },
  { slug: 'hbo-movies', lineup: 'DITV', station: '59845', callSign: 'HBOMVHD', note: 'ex HBO Zone' },
  { slug: 'nick-jr', lineup: 'DITV', station: '19211', callSign: 'NICJR' },
  { slug: 'racer-network', lineup: 'DITV', station: '61036', callSign: 'RACERHD' },
  { slug: 'showtime', lineup: 'DITV', station: '11115', callSign: 'PARSHO', note: 'now Paramount+ with Showtime' },
  { slug: 'showtime-2', lineup: 'DITV', station: '11116', callSign: 'SHO2' },
  { slug: 'showtime-extreme', lineup: 'DITV', station: '18086', callSign: 'SHOWX' },
  { slug: 'showtime-family-zone', lineup: 'DITV', station: '103892', callSign: 'FAMZHD' },
  { slug: 'showtime-next', lineup: 'DITV', station: '68342', callSign: 'NEXTHD' },
  { slug: 'starz-cinema', lineup: 'DITV', station: '67236', callSign: 'STRZCIH' },
  { slug: 'starz-comedy', lineup: 'DITV', station: '57569', callSign: 'STZCHD' },
  { slug: 'starz-kids-and-family', lineup: 'DITV', station: '57581', callSign: 'STZKHD' },
  { slug: 'teenick', lineup: 'DITV', station: '59036', callSign: 'TNCK' },
  { slug: 'the-weather-channel', lineup: 'DITV', station: '11187', callSign: 'WEATH', note: 'the scorer picks FOX WEATHER' },
  { slug: 'tudn', lineup: 'DITV', station: '75176', callSign: 'TUDNU' },
  { slug: 'tyc-sports-internacional', lineup: 'DITV', station: '111046', callSign: 'TYCINUH' },
  { slug: 'usa-network', lineup: 'DITV', station: '11207', callSign: 'USA', note: 'the scorer picks MYNETWORKTV' },
  { slug: 'wapa-america', lineup: 'DITV', station: '44322', callSign: 'WAPAUS' },
  { slug: 'willow-cricket', lineup: 'DITV', station: '80621', callSign: 'WLLOHD', note: 'resolver alias willow-usa' },
  { slug: 'willow-cricket-2', lineup: 'DITV', station: '100316', callSign: 'WILLOW2' },

  // Broadcast networks (East feed). NBC has a market-neutral national East stream on DITV; ABC/CBS/FOX/CW have
  // none there, so they pin the NYC O&O on the OTA lineup (the committed dlhd/dulo addons assume NYC too).
  { slug: 'nbc', lineup: 'DITV', station: '109718', callSign: 'NBCESTR' },
  { slug: 'abc', lineup: 'OTA', station: '20453', callSign: 'WABCDT' },
  { slug: 'cbs', lineup: 'OTA', station: '16689', callSign: 'WCBSDT' },
  { slug: 'fox', lineup: 'OTA', station: '20360', callSign: 'WNYWDT', note: 'no national FOX feed exists; WNYW' },
  { slug: 'cw', lineup: 'OTA', station: '20373', callSign: 'WPIXDT', note: 'WPIX local news (10pm ET) may differ from the network feed' },
];

// --- (2) Foreign scopes: country + name, matched inside that country's Jesmann guide --------------------
// `names` (default: the zlive name minus a parenthetical and trailing country tags) are compared after stripping
// quality tokens (HD/SD/UHD/4K) and punctuation; `formerNames` is consulted only when `names` finds nothing
// (renames); `callSigns` replaces name matching where the NAME is shared by several markets' stations.
// `review` = identity assumed, not confirmed (→ medium). `regions: []` = no Jesmann guide carries the market.

type Scope = {
  slug: string;
  regions: RegionKey[];
  names?: string[];
  formerNames?: string[];
  callSigns?: string[];
  review?: string;
  uncovered?: string;
};

const UNCONFIRMED = 'channel identity assumed, not confirmed';

const SCOPES: Scope[] = [
  // UK / Ireland — Sky Sports and TNT Sports (UK's, never US TNT). The shared UK+IE station wins when it exists,
  // so a row resolves with either country's guide.
  { slug: 'skysportsf1-uk', regions: UKIE },
  { slug: 'sky-sports-f1', regions: UKIE },
  { slug: 'sky-sports-plus', regions: UKIE },
  { slug: 'sky-sports-action', regions: UKIE },
  { slug: 'sky-sports-cricket', regions: UKIE },
  { slug: 'sky-sports-football', regions: UKIE },
  { slug: 'sky-sports-golf', regions: UKIE },
  { slug: 'sky-sports-main-event', regions: UKIE },
  { slug: 'sky-sports-mix', regions: UKIE },
  { slug: 'sky-sports-news', regions: UKIE }, // exact name: never Germany's "Sky Sport News" also in the UK file
  { slug: 'sky-sports-premier-league', regions: UKIE },
  { slug: 'sky-sports-racing', regions: UKIE },
  { slug: 'sky-sports-tennis', regions: UKIE },
  { slug: 'tnt-sports-1', regions: UKIE },
  { slug: 'tnt-sports-2', regions: UKIE },
  { slug: 'tnt-sports-3', regions: UKIE },
  { slug: 'tnt-sports-4', regions: UKIE },
  { slug: 'bbc-one-london', regions: UKIE },
  { slug: 'bbc-two', regions: UKIE },
  { slug: 'cbeebies', regions: UKIE },
  // zlive's "IE" feeds are the Republic-of-Ireland channels (Gracenote lists them separately as "ROI").
  { slug: 'premier-sports-1-ie', regions: ['Ireland'], names: ['Premier Sports 1 ROI'] },
  { slug: 'premier-sports-2-ie', regions: ['Ireland'], names: ['Premier Sports 2 ROI'] },

  // France — beIN SPORTS France numbers its channels 1/2/3 (zlive: "beIN Sports Francais N").
  { slug: 'bein-sports-francais-1', regions: ['France'], names: ['beIN Sports 1'] },
  { slug: 'bein-sports-francais-2', regions: ['France'], names: ['beIN Sports 2'] },
  { slug: 'bein-sports-francais-3', regions: ['France'], names: ['beIN Sports 3'] },

  // Germany
  { slug: 'dazn-1-germany', regions: ['Germany'] },
  { slug: 'dazn-2-germany', regions: ['Germany'] },
  { slug: 'sky-sport-bundesliga', regions: ['Germany'] },
  { slug: 'sportdigital-fussball', regions: ['Germany'] },

  // Italy
  { slug: 'dazn-1-italia', regions: ['Italy'], names: ['DAZN 1 Italy'] },
  { slug: 'sky-sport-24', regions: ['Italy'] },
  { slug: 'sky-sport-uno', regions: ['Italy'] },
  { slug: 'motogp-channel', regions: ['Italy'], names: ['Sky Sport MotoGP'], review: `${UNCONFIRMED} (Sky Sport MotoGP, Italy)` },

  // Spain — Movistar+ channels (M+ is the newer brand; Gracenote still says "Movistar"). Spain's "DAZN 1/2"
  // share their display name with the German DAZN stations also listed in the Spain file, so pin the callsign.
  { slug: 'dazn-1-spain', regions: ['Spain'], callSigns: ['DAZN1ES'] },
  { slug: 'dazn-2-spain', regions: ['Spain'], callSigns: ['DAZN2ES'] },
  { slug: 'dazn-f1', regions: ['Spain'] },
  { slug: 'dazn-laliga', regions: ['Spain'], names: ['DAZN La Liga', 'DAZN LaLiga'] },
  { slug: 'movistar-deportes', regions: ['Spain'], names: ['Movistar Deportes', 'M+ Deportes'] },
  { slug: 'movistar-deportes-2', regions: ['Spain'], names: ['Movistar Deportes 2', 'M+ Deportes 2'] },
  { slug: 'movistar-deportes-3', regions: ['Spain'], names: ['Movistar Deportes 3', 'M+ Deportes 3'] },
  { slug: 'movistar-laliga', regions: ['Spain'], names: ['Movistar LaLiga', 'M+ LaLiga', 'M+ LaLiga TV'] },
  { slug: 'movistar-plus', regions: ['Spain'], names: ['Movistar Plus+', 'Movistar Plus'] },

  // Poland — Polsat renamed its sports channels on 2024-04-26 (Sport → Sport 1, Extra → 2, News → 3); the old
  // names are the fallback for a guide that hasn't caught up.
  { slug: 'canal-sport-pl', regions: ['Poland'] },
  { slug: 'canal-sport-2-pl', regions: ['Poland'] },
  { slug: 'canal-sport-3-pl', regions: ['Poland'] },
  { slug: 'canal-sport-4-pl', regions: ['Poland'] },
  { slug: 'canal-sport-5-pl', regions: ['Poland'] },
  { slug: 'canal-sport-6-pl', regions: ['Poland'] },
  { slug: 'canal-extra-1', regions: ['Poland'] },
  { slug: 'canal-extra-2', regions: ['Poland'] },
  { slug: 'polsat-sport-1', regions: ['Poland'], formerNames: ['Polsat Sport'] },
  { slug: 'polsat-sport-2', regions: ['Poland'], formerNames: ['Polsat Sport Extra'] },
  { slug: 'polsat-sport-3', regions: ['Poland'], formerNames: ['Polsat Sport News'] },
  { slug: 'polsat-sport-fight', regions: ['Poland'] },
  { slug: 'eleven-sports-1', regions: ['Poland'], review: `${UNCONFIRMED} (Eleven Sports, Poland)` },
  { slug: 'eleven-sports-2', regions: ['Poland'], review: `${UNCONFIRMED} (Eleven Sports, Poland)` },
  { slug: 'eleven-sports-3', regions: ['Poland'], review: `${UNCONFIRMED} (Eleven Sports, Poland)` },
  { slug: 'eleven-sports-4', regions: ['Poland'], review: `${UNCONFIRMED} (Eleven Sports, Poland)` },

  // Australia — "Fox Sports 50x" are Foxtel's channel numbers (never the US FS1/FS2); 501/502/504 carry brands.
  { slug: 'fox-sports-501-cricket', regions: ['Australia'], names: ['FOX Cricket'] },
  { slug: 'fox-sports-502-league', regions: ['Australia'], names: ['FOX League'] },
  { slug: 'fox-sports-503', regions: ['Australia'] },
  { slug: 'fox-sports-504-footy', regions: ['Australia'], names: ['FOX Footy'] },
  { slug: 'fox-sports-505', regions: ['Australia'] },
  { slug: 'fox-sports-506', regions: ['Australia'] },
  { slug: 'fox-sports-507', regions: ['Australia'] },

  // Canada / Brazil
  { slug: 'tsn1', regions: ['Canada'], names: ['TSN 1'] },
  { slug: 'premiere', regions: ['Brazil'], names: ['Premiere Clubes'], review: `${UNCONFIRMED} (Premiere Clubes, Brazil)` },

  // US channels that aren't on the DITV lineup — name-matched in Jesmann's US guides instead.
  { slug: 'nbc-sports-bay-area', regions: US },
  { slug: 'nbc-sports-philadelphia', regions: US },
  { slug: 'showtime-women', regions: US },
  { slug: 'bein-sports', regions: US, review: `${UNCONFIRMED} (beIN SPORTS USA; beIN runs in many markets)` },
  { slug: 'discovery-turbo', regions: US, review: `${UNCONFIRMED} (US Discovery Turbo, not a LatAm/AU/BR feed)` },

  // Markets / feeds no station-id guide covers — reported, never matched.
  { slug: 'apple-tv', regions: [], uncovered: 'streaming-only F1 feed (no Gracenote station)' },
  { slug: 'apple-tv-uhd', regions: [], uncovered: 'streaming-only F1 feed (no Gracenote station)' },
  { slug: 'dazn-1-usa', regions: [], uncovered: 'streaming-only (no Gracenote station)' },
  { slug: 'ufc-fight-pass-24-7', regions: [], uncovered: 'streaming-only (no Gracenote station)' },
  { slug: 'wapa-deportes', regions: [], uncovered: 'Puerto Rico cable channel (in neither DITV nor Jesmann US)' },
  ...['1', '2', '3', '4', '5', '6', '7', '8', '9', 'select'].map(
    (n): Scope => ({ slug: `sky-sport-${n}-nz`, regions: [], uncovered: 'no Jesmann guide for New Zealand' }),
  ),
  ...['1', '2', '3', '4', '5'].map(
    (n): Scope => ({ slug: `sport-tv${n}`, regions: [], uncovered: 'no Jesmann guide for Portugal' }),
  ),
  { slug: 'dazn-1-portugal', regions: [], uncovered: 'no Jesmann guide for Portugal' },
  ...['1', '2', '3'].map(
    (n): Scope => ({ slug: `go3-sport-${n}`, regions: [], uncovered: 'no Jesmann guide for the Baltics' }),
  ),
  ...['', '-2', '-3', '-4', '-5'].map(
    (n): Scope => ({ slug: `sony-sports-network${n}`, regions: [], uncovered: 'no Jesmann guide for India' }),
  ),
];

// --- Name normalization ----------------------------------------------------------------------------------

const QUALITY_TOKENS = new Set(['hd', 'fhd', 'uhd', 'sd', '4k']);
// Trailing country tags zlive appends to a name ("CANAL+ Sport 2 PL", "DAZN 1 Germany"); dropped for the
// default lookup name only — the scope, not the tag, decides the country.
const COUNTRY_TAGS = new Set(['uk', 'ie', 'pl', 'nz', 'us', 'usa', 'germany', 'italia', 'italy', 'spain', 'portugal']);

// Lowercase ASCII word tokens; "&" → "and"; a '+' stays glued to its word so "Sky Sports+" ≠ "Sky Sports".
function tokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\s+\+/g, '+')
    .split(/[^a-z0-9+]+/)
    .filter(Boolean);
}
const nameKey = (s: string): string => tokens(s).filter((t) => !QUALITY_TOKENS.has(t)).join(' ');

function defaultKey(zliveName: string): string {
  const t = tokens(zliveName.replace(/\([^)]*\)/g, ' ')).filter((x) => !QUALITY_TOKENS.has(x));
  while (t.length > 1 && COUNTRY_TAGS.has(t[t.length - 1])) t.pop();
  return t.join(' ');
}

// 0 = HD (the feed kept when twins exist), 1 = SD/unmarked, 2 = UHD/4K (often event-only, so least preferred).
function qualityRank(name: string): number {
  const t = tokens(name);
  if (t.includes('uhd') || t.includes('4k')) return 2;
  if (t.includes('hd') || t.includes('fhd')) return 0;
  return 1;
}

// How a scope recognises its channel's station: by callsign when pinned, else by name tiers — `names` (or the
// default derived from the zlive name) first, `formerNames` only when that tier finds nothing.
type Matcher = { callSigns: Set<string> | null; tiers: string[][] };

function matcherFor(scope: Scope, zliveName: string): Matcher {
  if (scope.callSigns) return { callSigns: new Set(scope.callSigns.map((c) => c.toUpperCase())), tiers: [] };
  const primary = scope.names ? scope.names.map(nameKey) : [defaultKey(zliveName)];
  return { callSigns: null, tiers: [primary, (scope.formerNames ?? []).map(nameKey)] };
}

// The stations a matcher accepts, and which name tier produced them (1 = matched by a former name).
function matchStations(m: Matcher, pool: Station[]): { hits: Station[]; tier: number } {
  const { callSigns } = m;
  if (callSigns) return { hits: pool.filter((s) => !!s.callSign && callSigns.has(s.callSign.toUpperCase())), tier: 0 };
  for (const [tier, keys] of m.tiers.entries()) {
    if (!keys.length) continue;
    const hits = pool.filter((s) => keys.includes(nameKey(s.name)));
    if (hits.length) return { hits, tier };
  }
  return { hits: [], tier: 0 };
}

// --- Jesmann channel headers -----------------------------------------------------------------------------

type Station = { id: string; name: string; callSign: string | null };

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

// Jesmann's 7-day Standard channel block: <channel id="<gnid>"><display-name>Name</display-name>
// <display-name>CALLSIGN</display-name>…<gnid>…</gnid></channel>. The LAST display-name is the callsign
// (a middle one, when present, is an affiliate alias like "ABC"). A block whose id isn't a pure station id
// (the 7d IPTV variants key by name) is skipped — it could never match a station-id row.
function parseChannels(xml: string): Station[] {
  const out: Station[] = [];
  for (const m of xml.matchAll(/<channel\b[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g)) {
    const id = decodeXml(m[1]);
    if (!/^\d+$/.test(id)) continue;
    const names = [...m[2].matchAll(/<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g)].map((n) => decodeXml(n[1]));
    if (!names.length) continue;
    out.push({ id, name: names[0], callSign: names.length > 1 ? names[names.length - 1] : null });
  }
  return out;
}

// Stream one guide and stop at the first <programme>: everything before it is the channel header. The Range
// header bounds the transfer even if the cut never comes; identity encoding keeps that Range byte-exact.
async function fetchChannelHeader(region: RegionKey): Promise<Station[]> {
  const url = `${JESMANN_CDN_BASE}/7daygracenote/${region}.xml`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${HEADER_BYTE_CAP - 1}`, 'Accept-Encoding': 'identity', 'User-Agent': UA },
      signal: ctrl.signal,
    });
    if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('empty response body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let cut = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const from = Math.max(0, text.length - '<programme'.length);
      text += decoder.decode(value, { stream: true });
      cut = text.indexOf('<programme', from);
      if (cut !== -1 || text.length > HEADER_BYTE_CAP) break;
    }
    await reader.cancel().catch(() => {});
    if (cut === -1) throw new Error(`no <programme> within the first ${HEADER_BYTE_CAP} bytes — header incomplete`);
    return parseChannels(text.slice(0, cut));
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

// --- Crosswalk build -------------------------------------------------------------------------------------

interface Row {
  source: 'zlive';
  id: string;
  tvg_id: string;
  epg?: string;
  zlive_name: string;
  match_name: string;
  call_sign: string | null;
  regions: string[];
  confidence: 'high' | 'medium';
  note?: string;
}

type Miss = { slug: string; name: string; reason: string };

function parseArgs(argv: string[]): { catalog: string | null; out: string; dryRun: boolean } {
  let catalog: string | null = process.env.ZLIVE_CATALOG_FILE || null;
  let out = ZLIVE_EPG_ADDON_FILE;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (!v) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--catalog') catalog = value();
    else if (flag === '--out') out = value();
    else if (flag === '--dry-run') dryRun = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return { catalog, out, dryRun };
}

// Accepts the catalog as zlive serves it (a bare array of { id, name, … }) or wrapped as { channels: [...] }.
function readCatalog(file: string): { slug: string; name: string }[] {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : (parsed as { channels?: unknown })?.channels;
  if (!Array.isArray(list)) throw new Error(`${file} is not a zlive channels.json array`);
  const seen = new Set<string>();
  const out: { slug: string; name: string }[] = [];
  for (const raw of list as { id?: unknown; name?: unknown }[]) {
    if (typeof raw?.id !== 'string' || typeof raw.name !== 'string') continue;
    if (isEventId(raw.id)) continue; // events are ephemeral streams, never linear channels
    const slug = slugOf(raw.id);
    if (!SLUG_RE.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, name: raw.name.trim() });
  }
  return out;
}

async function main(): Promise<void> {
  const { catalog: catalogFile, out: outFile, dryRun } = parseArgs(process.argv.slice(2));
  if (!catalogFile) {
    throw new Error('pass --catalog <saved channels.json> (or ZLIVE_CATALOG_FILE) — this script never fetches zlive');
  }
  const catalog = readCatalog(catalogFile);
  if (!catalog.length) throw new Error(`no linear channels in ${catalogFile} — refusing to write`);

  // Curation sanity: a slug may be pinned OR scoped, never both.
  const pinBySlug = new Map(US_PINS.map((p) => [p.slug, p]));
  const scopeBySlug = new Map(SCOPES.map((s) => [s.slug, s]));
  for (const slug of pinBySlug.keys()) {
    if (scopeBySlug.has(slug)) throw new Error(`curation error: ${slug} is in both US_PINS and SCOPES`);
  }

  // Load every Jesmann header up front; any failure aborts BEFORE anything is written.
  const presence = new Map<string, Set<RegionKey>>(); // station id → regions listing it
  const byRegion = new Map<RegionKey, Station[]>();
  const info = new Map<string, Station>();
  for (const region of REGION_KEYS) {
    let stations: Station[];
    try {
      stations = await fetchChannelHeader(region);
    } catch (err) {
      throw new Error(`Jesmann ${region} header failed (${(err as Error).message}) — refusing to write`);
    }
    if (!stations.length) throw new Error(`Jesmann ${region} header has no station-id channels — refusing to write`);
    byRegion.set(region, stations);
    for (const s of stations) {
      if (!presence.has(s.id)) presence.set(s.id, new Set());
      presence.get(s.id)!.add(region);
      if (!info.has(s.id)) info.set(s.id, s);
    }
    console.log(`[zlive-crosswalk] Jesmann ${REGIONS[region]}: ${stations.length} stations`);
  }
  const regionsOf = (station: string): RegionKey[] => REGION_KEYS.filter((r) => presence.get(station)?.has(r));

  // Every scoped channel's lookup, for the cross-market collision check below.
  const lookups = catalog.flatMap((c) => {
    const scope = scopeBySlug.get(c.slug);
    return scope?.regions.length ? [{ slug: c.slug, scope, matcher: matcherFor(scope, c.name) }] : [];
  });

  const rows: Row[] = [];
  const misses: Miss[] = [];
  const audit: string[] = [];
  const catalogSlugs = new Set(catalog.map((c) => c.slug));

  for (const ch of catalog) {
    const id = `zlive:${ch.slug}`;
    const pin = pinBySlug.get(ch.slug);
    if (pin) {
      // A US pin: the station is fixed; Jesmann only supplies the display name and which guides carry it.
      const station = info.get(pin.station);
      if (!station) audit.push(`${ch.name}: station ${pin.station} is in no fetched Jesmann guide (DITV/OTA only)`);
      rows.push({
        source: 'zlive',
        id,
        tvg_id: pin.station,
        epg: pin.lineup === 'DITV' ? DITV_EPG : OTA_EPG,
        zlive_name: ch.name,
        match_name: station?.name ?? pin.callSign,
        call_sign: pin.callSign,
        regions: regionsOf(pin.station).map((r) => REGIONS[r]),
        confidence: 'high',
        ...(pin.note ? { note: pin.note } : {}),
      });
      for (const alt of pin.alt ?? []) {
        const s = info.get(alt);
        if (!s) {
          audit.push(`${ch.name}: alternate station ${alt} is in no fetched Jesmann guide — alternate dropped`);
          continue;
        }
        rows.push({
          source: 'zlive',
          id,
          tvg_id: alt,
          zlive_name: ch.name,
          match_name: s.name,
          call_sign: s.callSign,
          regions: regionsOf(alt).map((r) => REGIONS[r]),
          confidence: 'high',
          note: `alternate station for guides without ${pin.station}`,
        });
      }
      continue;
    }

    const scope = scopeBySlug.get(ch.slug);
    if (!scope) {
      misses.push({ slug: ch.slug, name: ch.name, reason: 'not curated (new zlive channel? add a US pin or a scope)' });
      continue;
    }
    if (!scope.regions.length) {
      misses.push({ slug: ch.slug, name: ch.name, reason: scope.uncovered ?? 'no guide region' });
      continue;
    }

    // Candidate stations: the scope's guides only, by callsign when pinned, else by name (then former name).
    const pool = new Map<string, Station>();
    for (const r of scope.regions) for (const s of byRegion.get(r) ?? []) if (!pool.has(s.id)) pool.set(s.id, s);
    const { hits: candidates, tier } = matchStations(matcherFor(scope, ch.name), [...pool.values()]);
    if (!candidates.length) {
      const scopeLabel = scope.regions.map((r) => REGIONS[r]).join(' + ');
      misses.push({ slug: ch.slug, name: ch.name, reason: `not in the Jesmann ${scopeLabel} guide` });
      continue;
    }

    // Pick among twins: HD › SD › UHD; then a station listed only in the scope's guides over one other markets
    // list too (the likelier home feed when names tie); then the one more of the scope's guides carry (so either
    // the UK or the Irish guide resolves it); then the lowest (oldest) id.
    const outside = (s: Station) => regionsOf(s.id).filter((r) => !scope.regions.includes(r));
    const inside = (s: Station) => regionsOf(s.id).filter((r) => scope.regions.includes(r));
    candidates.sort(
      (a, b) =>
        qualityRank(a.name) - qualityRank(b.name) ||
        Number(outside(a).length > 0) - Number(outside(b).length > 0) ||
        inside(b).length - inside(a).length ||
        Number(a.id) - Number(b.id),
    );
    const chosen = candidates[0];
    const notes: string[] = [];
    let confidence: Row['confidence'] = 'high';
    if (scope.review) {
      confidence = 'medium';
      notes.push(scope.review);
    }
    // Collision: another zlive channel, scoped to a DIFFERENT market, would accept this very station in a guide
    // that lists it — the two lookups can't both own it, so neither is trusted blind.
    const clash = lookups.find(
      (o) =>
        o.slug !== ch.slug &&
        !o.scope.regions.some((r) => scope.regions.includes(r)) &&
        o.scope.regions.some((r) => presence.get(chosen.id)?.has(r)) &&
        matchStations(o.matcher, [chosen]).hits.length > 0,
    );
    if (clash) {
      confidence = 'medium';
      notes.push(
        `station also answers ${clash.slug}'s lookup in ${clash.scope.regions.map((r) => REGIONS[r]).join(' + ')} ` +
          `— may be that market's feed`,
      );
    }
    if (tier === 1) notes.push('matched by its former name');
    if (candidates.length > 1) {
      audit.push(
        `${ch.name}: ${chosen.id} "${chosen.name}" over ` +
          candidates.slice(1).map((s) => `${s.id} "${s.name}" [${s.callSign ?? '-'}]`).join(', '),
      );
    }
    rows.push({
      source: 'zlive',
      id,
      tvg_id: chosen.id,
      zlive_name: ch.name,
      match_name: chosen.name,
      call_sign: chosen.callSign,
      regions: regionsOf(chosen.id).map((r) => REGIONS[r]),
      confidence,
      ...(notes.length ? { note: notes.join('; ') } : {}),
    });
  }

  // High block first, then medium; by name within a block. The sort is stable, so a channel's alternates stay
  // right after its primary row — the applier takes the FIRST row per channel that resolves.
  const conf = (r: Row) => (r.confidence === 'high' ? 0 : 1);
  rows.sort((a, b) => conf(a) - conf(b) || a.zlive_name.localeCompare(b.zlive_name) || a.id.localeCompare(b.id));
  if (!dryRun) writeFileSync(outFile, `${JSON.stringify(rows, null, 2)}\n`);

  // --- Coverage report (stdout) ---
  const channelsWith = (c: Row['confidence']) => new Set(rows.filter((r) => r.confidence === c).map((r) => r.id));
  const high = channelsWith('high');
  const medium = channelsWith('medium');
  const pinnedHigh = new Set(rows.filter((r) => r.epg).map((r) => r.id)).size;
  console.log(
    `\n[zlive-crosswalk] catalog: ${catalog.length} linear channels  →  high ${high.size} ` +
      `(US pinned ${pinnedHigh} + scoped ${high.size - pinnedHigh})  medium ${medium.size}  unmatched ${misses.length}`,
  );
  console.log(`[zlive-crosswalk] ${dryRun ? 'dry run — not written' : `wrote ${rows.length} rows → ${outFile}`}`);

  const stale = [...pinBySlug.keys(), ...scopeBySlug.keys()].filter((s) => !catalogSlugs.has(s));
  if (stale.length) console.log(`[zlive-crosswalk] curated but absent from this catalog (renamed/dropped?): ${stale.join(', ')}`);

  // Which guide an operator needs for which channels: high channels whose station each guide carries.
  console.log('\n--- high channels linkable per guide (the applier prefers DITV › other gracenote › jesmann) ---');
  const highRows = rows.filter((r) => r.confidence === 'high');
  const perGuide = (pred: (r: Row) => boolean) => new Set(highRows.filter(pred).map((r) => r.id)).size;
  console.log(`  Gracenote DITV (${DITV_EPG}): ${perGuide((r) => r.epg === DITV_EPG)} pinned`);
  console.log(`  Gracenote OTA, NYC ZIP (${OTA_EPG}): ${perGuide((r) => r.epg === OTA_EPG)} pinned`);
  for (const region of REGION_KEYS) {
    const n = perGuide((r) => r.regions.includes(REGIONS[region]));
    if (n) console.log(`  Jesmann · ${REGIONS[region]} · 7d Standard: ${n}`);
  }

  const print = (label: string, list: Row[]) => {
    console.log(`\n--- ${label} (${list.length} rows) ---`);
    for (const r of list) {
      console.log(
        `  ${r.zlive_name}  =>  ${r.tvg_id} "${r.match_name}" [${r.call_sign ?? '-'}]` +
          `${r.epg ? `  ${r.epg}` : ''}  {${r.regions.join(', ') || '-'}}${r.note ? `  — ${r.note}` : ''}`,
      );
    }
  };
  print('high — auto-applied', highRows);
  print('medium — written, never auto-applied; review', rows.filter((r) => r.confidence === 'medium'));

  const buckets = new Map<string, Miss[]>();
  for (const m of misses) buckets.set(m.reason, [...(buckets.get(m.reason) ?? []), m]);
  console.log(`\n--- unmatched (${misses.length}) ---`);
  for (const [reason, list] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${reason}: ${list.length}`);
    for (const m of list) console.log(`      ${m.name}  (${m.slug})`);
  }

  if (audit.length) {
    console.log(`\n--- audit: twin picks + curation notes (${audit.length}) ---`);
    for (const line of audit) console.log(`  ${line}`);
  }
}

main().catch((err) => {
  console.error(`[zlive-station-crosswalk] ${(err as Error).message}`);
  process.exit(1);
});
