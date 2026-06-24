// Pure XMLTV serialization — the EpgChannel → <channel> and Program → <programme> field mapping, with NO
// DB or fs access (so it stays trivially testable). The EPG analogue of m3u/serialize.ts. The caller
// (epg/composeGuide.ts) owns the join + ordering + de-dupe; this module only renders strings. Encoding is
// the repo invariant: UTF-8, LF only, no BOM, trailing '\n' (xmltvDocument adds it). See
// .claude/skills/xmltv/SKILL.md §1–§8 for the wire format and every field rule.

import type { EpgChannelDoc } from '../models/EpgChannel.js';
import type { ProgramDoc } from '../models/Program.js';

// §8 escaping — every dynamic string is escaped before it touches the document. A single raw '&', '<' or
// '"' makes the WHOLE guide fail to parse (clients reject the entire file, not just the bad entry).
function xmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function xmlAttr(s: string): string {
  return xmlText(s).replace(/"/g, '&quot;');
}

// '±HHMM' → signed minutes (0 on a malformed value). The inverse of the stamp written at sync time.
export function offsetToMinutes(offset: string): number {
  const m = /^([+-])(\d{2})(\d{2})$/.exec(String(offset).trim());
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -mins : mins;
}

// §5 time format — epoch ms (UTC) + a stored '±HHMM' offset → 'YYYYMMDDHHMMSS ±HHMM' (note the space before
// the offset). The DIGITS are the program's wall-clock AT that offset (the UTC instant shifted by the offset,
// read back via getUTC*) and the suffix tags it — so the timestamp round-trips to the correct UTC instant in
// any client. A '+0000' offset (the default / unset case, or a legacy row) reduces to plain UTC.
export function xmltvTime(ms: number, offset: string = '+0000'): string {
  const suffix = /^[+-]\d{4}$/.test(offset) ? offset : '+0000';
  const d = new Date(ms + offsetToMinutes(suffix) * 60000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    String(d.getUTCFullYear()) +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds()) +
    ' ' +
    suffix
  );
}

// §4.1 <episode-num> — Gracenote gives 1-based season/episode strings; EPG-PW gives neither (both null).
// Emit the human 'onscreen' form whenever both are present, plus the machine zero-based 'xmltv_ns' form when
// both parse to finite numbers. Never fabricate S00E00 when null.
function episodeNumEls(season: string | null, episode: string | null): string[] {
  if (season == null || episode == null) return [];
  const els = [`<episode-num system="onscreen">S${xmlText(season.padStart(2, '0'))}E${xmlText(episode.padStart(2, '0'))}</episode-num>`];
  const sn = Number(season);
  const en = Number(episode);
  if (Number.isFinite(sn) && Number.isFinite(en)) {
    els.push(`<episode-num system="xmltv_ns">${sn - 1}.${en - 1}.</episode-num>`);
  }
  return els;
}

// §3 — one EpgChannel → its <channel> block. `bareId` is the BARE tvg_id (the join key the M3U emits, NOT
// the composite _id); `logoUrl` comes from the LINKED PlaylistChannel (epgchannels has no logo). callSign /
// channelNo become extra <display-name>s only when non-null. Always buildable (affiliateName is required).
export function channelEl(epg: EpgChannelDoc, bareId: string, logoUrl: string | null): string {
  const lines = [`  <channel id="${xmlAttr(bareId)}">`, `    <display-name>${xmlText(epg.affiliateName)}</display-name>`];
  if (epg.callSign != null) lines.push(`    <display-name>${xmlText(epg.callSign)}</display-name>`);
  if (epg.channelNo != null) lines.push(`    <display-name>${xmlText(epg.channelNo)}</display-name>`);
  if (logoUrl != null) lines.push(`    <icon src="${xmlAttr(logoUrl)}" />`);
  lines.push('  </channel>');
  return lines.join('\n');
}

// §4 — one Program → its <programme> block, re-tagged to the BARE channel id (so it matches its <channel id>).
// Returns null to DROP an unbuildable airing (NaN/non-finite start or stop — §5). Optional elements are
// omitted (never fabricated) when their source field is null; seriesId/callSign/channelNo/source are NOT emitted.
export function programmeEl(p: ProgramDoc, bareId: string): string | null {
  if (!Number.isFinite(p.start) || !Number.isFinite(p.end)) return null;
  const lines = [
    `  <programme start="${xmltvTime(p.start, p.offset)}" stop="${xmltvTime(p.end, p.offset)}" channel="${xmlAttr(bareId)}">`,
    `    <title lang="en">${xmlText(p.title)}</title>`,
  ];
  if (p.episodeTitle != null) lines.push(`    <sub-title lang="en">${xmlText(p.episodeTitle)}</sub-title>`);
  if (p.shortDesc != null) lines.push(`    <desc lang="en">${xmlText(p.shortDesc)}</desc>`);
  lines.push(`    <category lang="en">${xmlText(p.cat)}</category>`);
  for (const el of episodeNumEls(p.season, p.episode)) lines.push(`    ${el}`);
  if (p.rating != null) lines.push(`    <rating><value>${xmlText(p.rating)}</value></rating>`);
  lines.push('  </programme>');
  return lines.join('\n');
}

// §1 — assemble the full <tv> document from pre-rendered <channel> + <programme> blocks. All channels come
// before all programmes (a hard XMLTV rule). XML declaration first; DOCTYPE conventional. UTF-8/LF/no-BOM
// with a trailing newline. An empty store → a valid <tv> with no children (never a malformed/partial doc).
export function xmltvDocument(channelEls: string[], programmeEls: string[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
    '<tv generator-info-name="TVApp2" source-info-name="TVApp2 EPG">',
    ...channelEls,
    ...programmeEls,
    '</tv>',
  ];
  return lines.join('\n') + '\n';
}
