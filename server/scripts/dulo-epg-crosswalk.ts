// Generate the committed dulo→gracenote EPG-link crosswalk (server/seed-data/dulo-playlist-addon.json):
// score every built-in `dulo` source channel against the loaded gracenote EPG channels by display-name
// similarity, and emit candidate matches (score >= 50), tiered high (>=80) / medium (50-79). dulo's
// afterSync (sources/adapters/dulo.ts) applies the HIGH-tier rows to never-touched channels after a sync;
// medium rows are NOT auto-applied — they're for manual review (a wrong best-guess like Aspire->INSPIRE
// lands there). This generator is READ-ONLY against Mongo; its only write is the crosswalk file.
//
// The scorer is a Node port of the composite matcher in src/screens/MappingScreen.vue (the UI Channel
// Mapping screen) — that .vue stays the source of truth; frontend code can't be imported across the package
// boundary, so it's copied. ONE addition: dulo names carry a trailing "… HD | USA" / "| CA" suffix, so the
// dropped-token set is extended with country codes (usa/us/uk/ca). The channel-number bonus is omitted
// because dulo channels carry no channel number.
//
// Usage (from server/):  npm run crosswalk:dulo-epg
//                        tsx scripts/dulo-epg-crosswalk.ts
// Requires the same Mongo config the server uses (MASQUERADARR_CONFIG env, else ./config.local.json).

import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { connect, disconnect } from '../src/db.js';
import { SourceChannel } from '../src/models/SourceChannel.js';
import { EpgSource } from '../src/models/EpgSource.js';
import { EpgChannel } from '../src/models/EpgChannel.js';
import { DULO_EPG_ADDON_FILE } from '../src/sources/paths.js';

// Committed seed data (server/seed-data); dulo's afterSync (sources/adapters/dulo.ts) applies it after a sync.
const OUT_PATH = DULO_EPG_ADDON_FILE;
const HIGH = 80; // confident tier
const MEDIUM = 50; // lowest score written to the file; below this = miss (reported to stdout only)

type EpgLean = {
  affiliateName: string;
  callSign: string | null;
  channelId: string;
  channelNo: string | null;
  source: string;
};

// --- Scorer (enhanced port of the matcher in src/screens/MappingScreen.vue ~L189-259) ----------------
// Divergences from the .vue, to lift recall on gracenote's terse callsign-style names:
//   (1) country codes dropped so dulo's "| USA" / "| CA" suffix is ignored;
//   (2) generic descriptor tokens (channel/network/central/the) dropped so "Tennis Channel" matches
//       "TENNIS" and spurious shared-"network" matches (NFL Network -> DABL NETWORK) die;
//   (3) each dulo name is scored against BOTH affiliateName and callSign on descriptor-stripped tokens,
//       best wins — and because the shared generic "network" is stripped from both sides, inflated junk
//       like "NFL Network" -> "DABL NETWORK" collapses to ~0 instead of riding the common token into review.
//   (4) a curated callSign->brand alias map (CALLSIGN_ALIASES) bridges gracenote's cryptic DITV callsigns
//       (NGC=Nat Geo, APL=Animal Planet, TOON=Cartoon Network, FNC=Fox News…). The live raw /api/grid was
//       inspected directly: its channels carry NO fuller name field (affiliateName is empty for cable rows),
//       so these abbreviations are the only available signal — hence a hand-verified map, not more fetching.
const DROP_TAGS = new Set([
  'hd', 'fhd', 'uhd', 'sd', '4k', '8k', 'hevc', 'h265', 'h264', 'hq', // quality/format
  'usa', 'us', 'uk', 'ca', // country (dulo suffix)
]);
// Redundant descriptor words gracenote's terse names omit. Stripped only when something remains (coreTokens);
// deliberately NOT including distinguishing words (sports/news/world/east/west…) so variants stay in review.
const DESCRIPTORS = new Set(['channel', 'network', 'central', 'the']);
const COUNTRY_PREFIX = /^(?:us|usa|uk|ca)\s*[:|-]\s*/;

// Lowercase, expand '&', strip a leading country/region prefix, drop quality/country tags; return the
// surviving word tokens (collapsed-string metrics are derived in nameSim).
function normalizeName(s: string): { tokens: string[] } {
  const cleaned = (s || '').toLowerCase().replace(/&/g, ' and ').replace(COUNTRY_PREFIX, ' ');
  const tokens = cleaned.split(/[^a-z0-9]+/).filter((t) => t && !DROP_TAGS.has(t));
  return { tokens };
}

// Descriptor-stripped token list — but never reduced to nothing (a bare "Channel" keeps its tokens).
function coreTokens(tokens: string[]): string[] {
  const c = tokens.filter((t) => !DESCRIPTORS.has(t));
  return c.length ? c : tokens;
}

// Curated gracenote callSign -> canonical brand. gracenote's DITV lineup names cable channels by cryptic
// callsigns no string-similarity can reach (verified: the raw /api/grid has no fuller name field). Keyed by
// callSign lowercased to alphanumerics (HD/SD variants share a brand); each value is matched against the dulo
// name via the same scorer. Conservative + unambiguous national channels only — several are independently
// confirmed by the user's own manual links (bbca→BBC America, bbcwdeh→BBC News, asprehd→Aspire).
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

// Composite 0–100 score for a dulo channel name vs a gracenote EPG channel: best name-similarity over
// {affiliateName, callSign}, each compared on descriptor-stripped tokens, plus the call-sign whole-token
// bonus (as in the .vue). The bonus tests the un-stripped dulo tokens.
function matchScore(duloName: string, e: EpgLean): number {
  const full = normalizeName(duloName).tokens;
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
  // Bonus: the EPG call sign appears as a whole token in the dulo name.
  if (e.callSign) {
    const cs = e.callSign.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cs && full.includes(cs)) base += 0.12;
  }
  return Math.round(Math.min(1, base) * 100);
}

// --- Crosswalk build ---------------------------------------------------------------------------------

interface Row {
  source: 'dulo';
  id: string;
  tvg_id: string;
  epg: string;
  dulo_name: string;
  match_name: string;
  call_sign: string | null;
  score: number;
  confidence: 'high' | 'medium';
}

// Coarse buckets for the miss report (reporting only — not part of the matcher).
function missBucket(name: string): string {
  if (/\|\s*ca\b/i.test(name)) return 'canadian (| CA)';
  if (/^24\/7\b/i.test(name)) return '24/7 pop-up / VOD';
  if (/\b(new york|los angeles|chicago|\d+)\b/i.test(name)) return 'local-affiliate naming';
  return 'other';
}

async function main(): Promise<void> {
  const { mongoUri } = loadConfig();
  await connect(mongoUri);

  const dulo = await SourceChannel.find({ source: 'dulo' }, { _id: 1, name: 1 }).lean<
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
    `[crosswalk] dulo channels=${dulo.length}  gracenote sources=${gracenoteIds.length} ` +
      `[${gracenoteIds.join(', ')}]  gracenote epgchannels=${epg.length}`,
  );

  const rows: Row[] = [];
  const misses: { name: string; bucket: string }[] = [];

  for (const ch of dulo) {
    let best: EpgLean | null = null;
    let bestScore = -1;
    for (const e of epg) {
      const s = matchScore(ch.name, e);
      if (s > bestScore) { bestScore = s; best = e; }
    }
    if (best && bestScore >= MEDIUM) {
      rows.push({
        source: 'dulo',
        id: ch._id,
        tvg_id: best.channelId,
        epg: best.source,
        dulo_name: ch.name,
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
  rows.sort((a, b) => b.score - a.score || a.dulo_name.localeCompare(b.dulo_name));
  writeFileSync(OUT_PATH, `${JSON.stringify(rows, null, 2)}\n`);

  const highRows = rows.filter((r) => r.confidence === 'high');
  const medRows = rows.filter((r) => r.confidence === 'medium');
  const bySource: Record<string, number> = {};
  for (const r of rows) bySource[r.epg] = (bySource[r.epg] || 0) + 1;

  // --- Feasibility report (stdout) ---
  console.log(
    `\n[crosswalk] tiers — high(>=${HIGH})=${highRows.length}  ` +
      `medium(${MEDIUM}-${HIGH - 1})=${medRows.length}  none(<${MEDIUM})=${misses.length}  of ${dulo.length}`,
  );
  console.log(`[crosswalk] written rows by gracenote source: ${JSON.stringify(bySource)}`);
  console.log(`[crosswalk] wrote ${rows.length} rows (high + medium) → ${OUT_PATH}`);

  console.log(`\n--- medium tier (${medRows.length}) — written, review before applying ---`);
  medRows.forEach((r) => console.log(`  ${r.score}  ${r.dulo_name}  =>  ${r.match_name} [${r.call_sign ?? '-'}]`));

  const buckets: Record<string, string[]> = {};
  for (const m of misses) (buckets[m.bucket] ??= []).push(m.name);
  console.log(`\n--- misses (${misses.length}) by bucket ---`);
  for (const [b, names] of Object.entries(buckets)) {
    console.log(`  ${b}: ${names.length}`);
    names.sort().forEach((n) => console.log(`      ${n}`));
  }

  await disconnect();
}

main().catch(async (err) => {
  console.error(`[dulo-epg-crosswalk] ${(err as Error).message}`);
  await disconnect().catch(() => {});
  process.exit(1);
});
