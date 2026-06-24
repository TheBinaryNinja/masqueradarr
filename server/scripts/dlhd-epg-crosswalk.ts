// Generate the committed dlhd→gracenote EPG-link crosswalk (server/seed-data/dlhd-playlist-addon.json):
// score every built-in `dlhd` source channel against the loaded gracenote EPG channels by display-name
// similarity, and emit candidate matches (score >= 50), tiered high (>=80) / medium (50-79). dlhd's
// afterSync (sources/adapters/dlhd.ts) applies the HIGH-tier rows to never-touched channels after a sync;
// medium rows are NOT auto-applied — they're for manual review. This generator is READ-ONLY against Mongo;
// its only write is the crosswalk file. dlhd is anonymous and carries no native guide, so its channels link
// to the EXISTING US Gracenote sources already in Mongo (DITV + OTA) — nothing is fetched here.
//
// The scorer is the SAME composite matcher dulo uses (a Node port of src/screens/MappingScreen.vue). dlhd
// names differ from dulo's in ONE way that matters: dulo tags country as a trailing "… | USA" / "| CA" pipe,
// whereas dlhd tags it as a trailing WORD ("ESPN USA", "CNN USA", "Canal+ Sport 2 SK", "ESPN Brasil"). The
// Gracenote lineups are US-only, so:
//   (1) FOREIGN-COUNTRY GATE — a dlhd name carrying a recognized non-US country token (uk, france, brasil,
//       poland, cz, sk, nl, …) is SKIPPED outright. This is the crux: without it, stripping the country word
//       would collapse "ESPN Brasil" → "espn" and wrongly link Brazilian ESPN to the US ESPN guide.
//   (2) US-tag strip — a trailing "usa"/"us" is dropped (DROP_TAGS) so "ESPN USA" → "espn" matches DITV ESPN.
// Bracketed callsign hints tokenize naturally ("National Geographic (NGC)" → [national, geographic, ngc]),
// so the callSign whole-token bonus + the curated alias map fire with no extra code. The channel-number bonus
// is omitted (dlhd channels carry no channel number), same as dulo.
//
// Usage (from server/):  npm run crosswalk:dlhd-epg
//                        tsx scripts/dlhd-epg-crosswalk.ts
// Requires the same Mongo config the server uses (MASQUERADARR_CONFIG env, else ./config.local.json).

import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { connect, disconnect } from '../src/db.js';
import { SourceChannel } from '../src/models/SourceChannel.js';
import { EpgSource } from '../src/models/EpgSource.js';
import { EpgChannel } from '../src/models/EpgChannel.js';
import { DLHD_EPG_ADDON_FILE } from '../src/sources/paths.js';

// Committed seed data (server/seed-data); dlhd's afterSync (sources/adapters/dlhd.ts) applies it after a sync.
const OUT_PATH = DLHD_EPG_ADDON_FILE;
const HIGH = 80; // confident tier
const MEDIUM = 50; // lowest score written to the file; below this = miss (reported to stdout only)

type EpgLean = {
  affiliateName: string;
  callSign: string | null;
  channelId: string;
  channelNo: string | null;
  source: string;
};

// --- Scorer (port of the matcher in src/screens/MappingScreen.vue ~L189-259) -------------------------
// Identical weighting to dulo's crosswalk; see header for the dlhd-specific name handling.
const DROP_TAGS = new Set([
  'hd', 'fhd', 'uhd', 'sd', '4k', '8k', 'hevc', 'h265', 'h264', 'hq', // quality/format
  'usa', 'us', // US country suffix dropped so "ESPN USA" -> "espn" (FOREIGN countries are EXCLUDED, see gate)
]);
// Redundant descriptor words gracenote's terse names omit. Stripped only when something remains (coreTokens);
// deliberately NOT including distinguishing words (sports/news/world/east/west…) so variants stay in review.
const DESCRIPTORS = new Set(['channel', 'network', 'central', 'the']);

// Non-US country / region tokens. A dlhd name carrying ANY of these as a whole token is skipped — the
// Gracenote DITV + OTA lineups are US-only, so a foreign channel can only ever produce a FALSE link
// (e.g. "ESPN Brasil" → US ESPN). Full names + only the unambiguous 2-letter codes seen in the catalog
// (cz/sk/nl/pl/pt/fr/br/uk/gb) — common English words (in/is/no/it/at/be/de) are deliberately excluded.
const FOREIGN_COUNTRIES = new Set([
  'uk', 'gb', 'england', 'scotland', 'wales', 'ireland', 'eire',
  'france', 'fr', 'afrique', 'africa',
  'portugal', 'pt', 'poland', 'pl',
  'czech', 'czechia', 'cz', 'slovakia', 'sk',
  'canada', 'canadian',
  'brazil', 'brasil', 'br', 'argentina', 'mexico', 'mexican',
  'chile', 'colombia', 'peru', 'venezuela', 'uruguay', 'ecuador', 'bolivia', 'paraguay',
  'netherlands', 'nl', 'holland', 'belgium', 'belgique',
  'spain', 'espana', 'espanol', 'italy', 'italia', 'italiano',
  'germany', 'deutschland', 'austria', 'switzerland', 'suisse',
  'sweden', 'norway', 'denmark', 'finland', 'nordic', 'iceland',
  'turkey', 'greece', 'romania', 'russia', 'russian', 'ukraine', 'hungary', 'croatia', 'serbia',
  'slovenia', 'bulgaria', 'albania', 'macedonia',
  'india', 'indian', 'pakistan', 'arabia', 'arabic', 'arab', 'qatar', 'emirates', 'uae', 'ksa', 'mena',
  'australia', 'australian', 'zealand',
  'japan', 'japanese', 'korea', 'korean', 'china', 'chinese', 'taiwan', 'thailand', 'philippines',
  'malaysia', 'indonesia', 'vietnam', 'israel', 'iran',
  // Unambiguous trailing 2-letter region codes (e.g. "Fox Sports 1 MX", "FOX Sports 502 AU", "ESPN 1 NL").
  // English-word / US-channel collisions are deliberately EXCLUDED: id (=Investigation Discovery), my, in,
  // de, at, be, it, es, se, no, co, ch.
  'mx', 'au', 'nz', 'za', 'ph', 'sg', 'hk', 'ru', 'tr', 'gr', 'ro', 'hu', 'hr', 'rs', 'si', 'bg', 'ua',
  'cl', 've', 'ar', 'uy', 'ec', 'pe', 'fi', 'dk', 'jp', 'kr', 'cn', 'tw', 'th', 'vn', 'il', 'ie',
]);

// Curated gracenote callSign -> canonical brand. gracenote's DITV lineup names cable channels by cryptic
// callsigns no string-similarity can reach (verified: the raw /api/grid has no fuller name field). Keyed by
// callSign lowercased to alphanumerics (HD/SD variants share a brand); each value is matched against the dlhd
// name via the same scorer. Conservative + unambiguous national channels only (shared with dulo's crosswalk).
const CALLSIGN_ALIASES: Record<string, string> = {
  // sports
  nflnet: 'nfl network', nflhd: 'nfl network',
  nflrz: 'nfl redzone', nflnrzd: 'nfl redzone',
  nhlnet: 'nhl network', nhlhd: 'nhl network',
  mlbn: 'mlb network', mlbna: 'mlb network', mlbhd: 'mlb network', mlbhda: 'mlb network',
  fs1: 'fox sports 1', fs1hd: 'fox sports 1',
  fs2: 'fox sports 2', fs2hd: 'fox sports 2',
  fsp: 'fox soccer plus',
  // entertainment / movies
  toon: 'cartoon network', toonhd: 'cartoon network',
  boom: 'boomerang',
  disn: 'disney channel', disnhd: 'disney channel',
  dxd: 'disney xd', dxdhd: 'disney xd',
  djch: 'disney junior', djchhd: 'disney junior',
  nik: 'nickelodeon', nikhd: 'nickelodeon', nikp: 'nickelodeon',
  nikton: 'nicktoons', tnck: 'teen nick',
  fxm: 'fx movies',
  par: 'paramount network', parhd: 'paramount network',
  cmtv: 'cmt', cmtvhd: 'cmt',
  hall: 'hallmark channel', hallhd: 'hallmark channel',
  hmys: 'hallmark mystery', hmyshd: 'hallmark mystery',
  rvlt: 'revolt', rvlthd: 'revolt',
  // factual / news
  ngc: 'national geographic', ngchd: 'national geographic',
  ngwild: 'nat geo wild', ngwihd: 'nat geo wild',
  apl: 'animal planet', aplhd: 'animal planet',
  life: 'lifetime', lifehd: 'lifetime',
  cook: 'cooking channel', cookhd: 'cooking channel',
  fnc: 'fox news', fnchd: 'fox news',
  fbn: 'fox business', fbnhd: 'fox business',
  newsmx: 'newsmax', newsmxh: 'newsmax',
  espnews: 'espn news',
  bbca: 'bbc america', bbcahd: 'bbc america',
  bbcwdeh: 'bbc news',
  aspre: 'aspire', asprehd: 'aspire',
};

// Lowercase, expand '&', drop quality/US tags; return the surviving word tokens (collapsed-string metrics
// are derived in nameSim). No leading country-prefix strip (dlhd tags country as a trailing word, gated below).
function normalizeName(s: string): { tokens: string[] } {
  const cleaned = (s || '').toLowerCase().replace(/&/g, ' and ');
  const tokens = cleaned.split(/[^a-z0-9]+/).filter((t) => t && !DROP_TAGS.has(t));
  return { tokens };
}

// Descriptor-stripped token list — but never reduced to nothing (a bare "Channel" keeps its tokens).
function coreTokens(tokens: string[]): string[] {
  const c = tokens.filter((t) => !DESCRIPTORS.has(t));
  return c.length ? c : tokens;
}

// True if the name carries a recognized non-US country/region token (the foreign-country gate — see header).
function hasForeignCountry(name: string): boolean {
  const toks = (name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return toks.some((t) => FOREIGN_COUNTRIES.has(t));
}

// Sørensen–Dice coefficient over character bigrams (0–1) — order-tolerant, ideal for short names.
function dice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const ba = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); ba.set(g, (ba.get(g) || 0) + 1); }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const c = ba.get(g) || 0;
    if (c > 0) { overlap++; ba.set(g, c - 1); }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

// Jaccard overlap of word-token sets (0–1) — catches reordering / abbreviation that bigrams miss.
function jaccard(ta: string[], tb: string[]): number {
  if (!ta.length && !tb.length) return 1;
  const sa = new Set(ta), sb = new Set(tb);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0;
}

// Classic edit distance — small DP, only ever run on short collapsed names.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

// Name-similarity (0–1) between two token lists: Sørensen–Dice (chars) + token Jaccard + normalized
// Levenshtein — the .vue's exact weighting. Exact collapsed-string match short-circuits to 1.
function nameSim(ta: string[], tb: string[]): number {
  const sa = ta.join(''), sb = tb.join('');
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  const lv = 1 - levenshtein(sa, sb) / Math.max(sa.length, sb.length);
  return 0.55 * dice(sa, sb) + 0.30 * jaccard(ta, tb) + 0.15 * lv;
}

// Composite 0–100 score for a dlhd channel name vs a gracenote EPG channel: best name-similarity over
// {affiliateName, callSign}, each compared on descriptor-stripped tokens, plus the call-sign whole-token
// bonus. The bonus tests the un-stripped dlhd tokens.
function matchScore(dlhdName: string, e: EpgLean): number {
  const full = normalizeName(dlhdName).tokens;
  if (!full.length) return 0;
  const L = coreTokens(full);
  let base = 0;
  for (const name of e.callSign ? [e.affiliateName, e.callSign] : [e.affiliateName]) {
    const E = coreTokens(normalizeName(name).tokens);
    if (E.length) base = Math.max(base, nameSim(L, E));
  }
  // Curated callSign->brand alias: bridges gracenote's cryptic DITV callsigns (NGC, APL, TOON, FNC…) that
  // carry no fuller name in the raw grid. The alias is tied to one callSign, so it can only attract its
  // intended brand — no cross-channel false positives.
  if (e.callSign) {
    const alias = CALLSIGN_ALIASES[e.callSign.toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (alias) base = Math.max(base, nameSim(L, coreTokens(normalizeName(alias).tokens)));
  }
  // Bonus: the EPG call sign appears as a whole token in the dlhd name.
  if (e.callSign) {
    const cs = e.callSign.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cs && full.includes(cs)) base += 0.12;
  }
  return Math.round(Math.min(1, base) * 100);
}

// --- Crosswalk build ---------------------------------------------------------------------------------

interface Row {
  source: 'dlhd';
  id: string;
  tvg_id: string;
  epg: string;
  dlhd_name: string;
  match_name: string;
  call_sign: string | null;
  score: number;
  confidence: 'high' | 'medium';
}

// Coarse buckets for the miss report (reporting only — not part of the matcher).
function missBucket(name: string): string {
  if (/^18\+|\bplayer\b|player-?\d+/i.test(name)) return '18+ / player placeholder';
  if (/^#?24\/7\b|\bvod\b/i.test(name)) return '24/7 pop-up / VOD';
  return 'other (no US match)';
}

async function main(): Promise<void> {
  const { mongoUri } = loadConfig();
  await connect(mongoUri);

  const dlhd = await SourceChannel.find({ source: 'dlhd' }, { _id: 1, name: 1 }).lean<
    { _id: string; name: string }[]
  >();
  const gracenoteIds = (
    await EpgSource.find({ source: 'Gracenote' }, { id: 1 }).lean<{ id: string }[]>()
  ).map((s) => s.id);
  const epg = await EpgChannel.find(
    { source: { $in: gracenoteIds } },
    { affiliateName: 1, callSign: 1, channelId: 1, channelNo: 1, source: 1 },
  ).lean<EpgLean[]>();

  console.log(
    `[crosswalk] dlhd channels=${dlhd.length}  gracenote sources=${gracenoteIds.length} ` +
      `[${gracenoteIds.join(', ')}]  gracenote epgchannels=${epg.length}`,
  );

  const rows: Row[] = [];
  const misses: { name: string; bucket: string }[] = [];

  for (const ch of dlhd) {
    // Foreign-country gate FIRST — a non-US channel can only ever produce a false link to a US lineup.
    if (hasForeignCountry(ch.name)) {
      misses.push({ name: ch.name, bucket: 'foreign (non-US lineup)' });
      continue;
    }
    let best: EpgLean | null = null;
    let bestScore = -1;
    for (const e of epg) {
      const s = matchScore(ch.name, e);
      if (s > bestScore) { bestScore = s; best = e; }
    }
    if (best && bestScore >= MEDIUM) {
      rows.push({
        source: 'dlhd',
        id: ch._id,
        tvg_id: best.channelId,
        epg: best.source,
        dlhd_name: ch.name,
        match_name: best.affiliateName,
        call_sign: best.callSign,
        score: bestScore,
        confidence: bestScore >= HIGH ? 'high' : 'medium',
      });
    } else {
      misses.push({ name: ch.name, bucket: missBucket(ch.name) });
    }
  }

  // Both tiers are written; sort strongest-first (then by name) so the high block leads and the medium
  // review candidates trail down to the 50 cutoff. The `confidence` field labels each row.
  rows.sort((a, b) => b.score - a.score || a.dlhd_name.localeCompare(b.dlhd_name));
  writeFileSync(OUT_PATH, `${JSON.stringify(rows, null, 2)}\n`);

  const highRows = rows.filter((r) => r.confidence === 'high');
  const medRows = rows.filter((r) => r.confidence === 'medium');
  const bySource: Record<string, number> = {};
  for (const r of rows) bySource[r.epg] = (bySource[r.epg] || 0) + 1;

  // --- Feasibility report (stdout) ---
  console.log(
    `\n[crosswalk] tiers — high(>=${HIGH})=${highRows.length}  ` +
      `medium(${MEDIUM}-${HIGH - 1})=${medRows.length}  none(<${MEDIUM})=${misses.length}  of ${dlhd.length}`,
  );
  console.log(`[crosswalk] written rows by gracenote source: ${JSON.stringify(bySource)}`);
  console.log(`[crosswalk] wrote ${rows.length} rows (high + medium) → ${OUT_PATH}`);

  console.log(`\n--- high tier (${highRows.length}) — auto-applied by afterSync ---`);
  highRows.forEach((r) => console.log(`  ${r.score}  ${r.dlhd_name}  =>  ${r.match_name} [${r.call_sign ?? '-'}]`));

  console.log(`\n--- medium tier (${medRows.length}) — written, review before applying ---`);
  medRows.forEach((r) => console.log(`  ${r.score}  ${r.dlhd_name}  =>  ${r.match_name} [${r.call_sign ?? '-'}]`));

  const buckets: Record<string, number> = {};
  for (const m of misses) buckets[m.bucket] = (buckets[m.bucket] || 0) + 1;
  console.log(`\n--- misses (${misses.length}) by bucket ---`);
  for (const [b, n] of Object.entries(buckets).sort((a, z) => z[1] - a[1])) console.log(`  ${b}: ${n}`);

  await disconnect();
}

main().catch(async (err) => {
  console.error(`[dlhd-epg-crosswalk] ${(err as Error).message}`);
  await disconnect().catch(() => {});
  process.exit(1);
});
