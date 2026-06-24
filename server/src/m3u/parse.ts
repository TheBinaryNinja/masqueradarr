// Inbound EXTM3U parsing — the INVERSE of serialize.ts. Reads a raw `.m3u`/`.m3u8` document (uploaded or
// fetched) into plain channel records the import route turns into PlaylistChannel docs. Pure (no DB/fs), so
// it stays trivially testable. This is origination branch (d) of the m3u contract — "inbound external .m3u"
// (see .claude/skills/m3u/SKILL.md §6). It is deliberately LENIENT: a malformed line is skipped, never fatal.

export interface ParsedM3uEntry {
  name: string; // display name (the text after the EXTINF comma; falls back to tvg-name, then the URL)
  url: string; // the stream URL line (http/https only — others are dropped)
  tvgId: string | null; // tvg-id="" → PlaylistChannel.tvg_id (EPG link factor 1; epg stays null until mapped)
  tvgLogo: string | null; // tvg-logo="" → logoUrl
  groupTitle: string | null; // group-title="" (or a preceding #EXTGRP) → group
  tvgChno: string | null; // tvg-chno="" / channel-number="" → channelNo (displayed channel number)
}

export interface ParsedM3u {
  entries: ParsedM3uEntry[];
  guideUrl: string | null; // x-tvg-url / url-tvg from the #EXTM3U header — captured for a future EPG follow-up
}

// One #EXTINF line → { attrs, name }. Attributes are parsed FIRST (globally), then the display name is the
// text after the first comma that FOLLOWS the last attribute — so a comma inside a quoted value (e.g.
// group-title="News, US") never truncates the name. With no attributes the comma after the duration is used.
function parseExtinf(line: string): { attrs: Record<string, string>; name: string } {
  const body = line.slice(line.indexOf(':') + 1); // drop the "#EXTINF:" prefix
  const attrs: Record<string, string> = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    attrs[m[1].toLowerCase()] = m[2];
    lastIndex = re.lastIndex;
  }
  const commaIdx = body.indexOf(',', lastIndex);
  const name = commaIdx >= 0 ? body.slice(commaIdx + 1).trim() : '';
  return { attrs, name };
}

// Pull x-tvg-url / url-tvg off the #EXTM3U header line (either spelling; case-insensitive).
function parseHeaderGuideUrl(line: string): string | null {
  const m = line.match(/(?:x-tvg-url|url-tvg)="([^"]*)"/i);
  return m && m[1] ? m[1] : null;
}

function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

/**
 * Parse a raw EXTM3U document into channel records. CRLF-tolerant; comment/blank lines are ignored. An
 * entry is the pairing of an `#EXTINF` line (attributes + display name) with the next non-comment URL line;
 * a bare URL with no preceding `#EXTINF` still yields an entry (name derived from the URL). Non-http(s) URLs
 * are dropped. A `#EXTGRP:` line sets the group for the next entry when it carries no group-title.
 */
export function parseM3u(text: string): ParsedM3u {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const entries: ParsedM3uEntry[] = [];
  let guideUrl: string | null = null;

  let pending: { attrs: Record<string, string>; name: string } | null = null;
  let pendingGroup: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      const upper = line.toUpperCase();
      if (upper.startsWith('#EXTM3U')) {
        guideUrl = guideUrl ?? parseHeaderGuideUrl(line);
      } else if (upper.startsWith('#EXTINF:')) {
        pending = parseExtinf(line);
      } else if (upper.startsWith('#EXTGRP:')) {
        pendingGroup = line.slice(line.indexOf(':') + 1).trim() || null;
      }
      // Any other directive (#KODIPROP, #EXTVLCOPT, …) is ignored for v1.
      continue;
    }

    // A URL line — pair it with the pending #EXTINF (or stand alone).
    const url = line;
    if (isHttpUrl(url)) {
      const attrs = pending?.attrs ?? {};
      const name = pending?.name || attrs['tvg-name'] || url.split('/').pop() || url;
      entries.push({
        name,
        url,
        tvgId: attrs['tvg-id'] || null,
        tvgLogo: attrs['tvg-logo'] || null,
        groupTitle: attrs['group-title'] || pendingGroup || null,
        tvgChno: attrs['tvg-chno'] || attrs['channel-number'] || null,
      });
    }
    pending = null;
    pendingGroup = null;
  }

  return { entries, guideUrl };
}
