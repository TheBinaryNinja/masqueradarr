// schedule.ts — fetch + parse the DaddyLive SCHEDULE (live events) that backs the dlhd self-EPG.
//
// dlhd's 24/7 channel catalog (parseDirectory.ts) carries NO program data — its only guide is the daily
// schedule of live events, server-rendered on the mirror homepage and lazily extended by a handful of
// secondary `/schedule-api.php?source=<src>` feeds. Each event has a UK-local start time, a title, a
// category, and a set of channel links (`/watch.php?id=N`) whose ids are the SAME id space as the 24/7
// catalog — so they link straight onto dlhd PlaylistChannels.
//
// KEYLESS by design: the documented `schedule-generated.php` is domain-gated ("allowed Domain only") and
// `daddyapi.php` needs an API key, but the homepage schedule + the `schedule-api.php` fragments are exactly
// what the site's own page fetches — reachable server-side with the existing Referer/UA gate. The active
// mirror rotates, so everything reads getBase()/getReferer() at USE time (never captured at import).
//
// A LEAF-ish module: imports only config + ensureMirror + the shared entity decoder + logger (no model,
// no adapter) so the import graph stays acyclic (schedule ← epg/dlhd ← adapters/dlhd).

import { UA, getBase, getReferer } from './config.js';
import { ensureMirror } from './mirrorDirectory.js';
import { decodeEntities } from './parseDirectory.js';
import { logger } from '../../core/logger.js';

const TIMEOUT_MS = Number(process.env.DLHD_SCHEDULE_TIMEOUT_MS || 15_000);
// Secondary feeds the homepage lazy-loads via /schedule-api.php?source=<src> ({ success, html }). Parsed
// with the SAME selectors as the inline main schedule; non-dlhd ids are dropped at parse time. Override/
// disable with DLHD_SCHEDULE_EXTRA_SOURCES (empty string = main schedule only).
const EXTRA_SOURCES = String(
  process.env.DLHD_SCHEDULE_EXTRA_SOURCES ?? 'extra,extra_plus,extra_ppv,extra_sd,extra_backup',
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** One channel link inside an event. `id` is the numeric DaddyLive id (= 24/7 catalog id). */
export interface DlhdScheduleChannel {
  id: string;
  name: string;
}

/** One parsed schedule event (one airing of a live event on one or more channels). */
export interface DlhdScheduleEvent {
  dayKey: string; // e.g. "Thursday 18th June 2026 - Schedule Time UK GMT" (the date drives the airing date)
  time: string; // "HH:MM" (UK local — see epg/dlhd.ts parseScheduleTime)
  title: string;
  category: string;
  channels: DlhdScheduleChannel[];
}

export interface DlhdSchedule {
  events: DlhdScheduleEvent[];
  meta: { base: string; sources: string[]; fetchedAt: string };
}

/** Strip nested tags, decode HTML entities, collapse whitespace. */
function clean(s: string): string {
  return decodeEntities(
    String(s ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/** Pull channel links (`<a … href="/watch.php?id=N" …>` or `…/stream-N.php`) out of an event fragment. */
function parseChannelsFromFragment(frag: string): DlhdScheduleChannel[] {
  const out: DlhdScheduleChannel[] = [];
  const seen = new Set<string>();
  for (const a of frag.matchAll(/<a\b([^>]*)>/gi)) {
    const attrs = a[1] || '';
    const idM = attrs.match(/(?:[?&]id=|stream-)(\d+)/i);
    if (!idM) continue;
    const id = idM[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const nameM = attrs.match(/\btitle="([^"]*)"/i) || attrs.match(/\bdata-ch="([^"]*)"/i);
    out.push({ id, name: nameM ? clean(nameM[1]) : id });
  }
  return out;
}

/**
 * Parse a schedule HTML document/fragment (the homepage main schedule OR a schedule-api.php `html` payload)
 * into flat events. The markup nests day → category → event; we collect the three marker types with their
 * positions, walk them in document order tracking the current day/category, and slice each event's channels
 * from its marker to the next. Attribute order/whitespace vary, so per-field extraction beats one mega-regex
 * (same robustness rationale as parseDirectory.ts).
 */
export function parseScheduleHtml(html: string): DlhdScheduleEvent[] {
  interface Tok {
    pos: number;
    kind: 'day' | 'cat' | 'evt';
    time?: string;
    title?: string;
  }
  const toks: Tok[] = [];

  for (const m of html.matchAll(/<div class="schedule__dayTitle">([\s\S]*?)<\/div>/gi)) {
    toks.push({ pos: m.index ?? 0, kind: 'day', title: clean(m[1]) });
  }
  // Category name lives in `.card__meta` inside a `.schedule__catHeader` — require the header nearby so a
  // stray `.card__meta` elsewhere on the page can't be mistaken for a category.
  for (const m of html.matchAll(/schedule__catHeader[\s\S]{0,300}?card__meta">([\s\S]*?)<\/div>/gi)) {
    toks.push({ pos: m.index ?? 0, kind: 'cat', title: clean(m[1]) });
  }
  // Event header → time → title. The header carries a long inline onclick + data-title, so allow a generous
  // gap before the time span; the lazy quantifier binds to THIS event's first data-time.
  for (const m of html.matchAll(
    /class="schedule__event"[\s\S]{0,2000}?data-time="(\d{1,2}:\d{2})"[\s\S]{0,200}?class="schedule__eventTitle">([\s\S]*?)<\/span>/gi,
  )) {
    toks.push({ pos: m.index ?? 0, kind: 'evt', time: m[1], title: clean(m[2]) });
  }

  toks.sort((a, b) => a.pos - b.pos);

  const events: DlhdScheduleEvent[] = [];
  let day = '';
  let cat = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'day') {
      day = t.title || '';
      cat = '';
      continue;
    }
    if (t.kind === 'cat') {
      cat = t.title || '';
      continue;
    }
    // event: its channels run from this marker to the next marker (next event / category / day).
    const end = i + 1 < toks.length ? toks[i + 1].pos : html.length;
    const channels = parseChannelsFromFragment(html.slice(t.pos, end));
    if (!t.time || !t.title || !channels.length) continue;
    events.push({ dayKey: day, time: t.time, title: t.title, category: cat || 'Live', channels });
  }
  return events;
}

async function getText(url: string, headers: Record<string, string>): Promise<string> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Fetch + parse the dlhd schedule from the active mirror: the inline homepage schedule (primary) plus the
 * secondary `/schedule-api.php?source=<src>` feeds (best-effort each). Returns all events across feeds
 * (the program builder dedupes per channel). Throws only if the PRIMARY (homepage) feed fails — a live-only
 * EPG sync should fail loudly rather than replace a good guide with a half-empty one.
 */
export async function fetchDlhdSchedule(): Promise<DlhdSchedule> {
  await ensureMirror().catch(() => undefined); // best-effort; getBase() falls back to the last/default base
  const base = getBase();
  const events: DlhdScheduleEvent[] = [];
  const sources: string[] = [];

  // (1) Primary: the main schedule is server-rendered inline on the mirror homepage.
  try {
    events.push(...parseScheduleHtml(await getText(`${base}/`, { Referer: getReferer(), 'User-Agent': UA })));
    sources.push('main');
  } catch (err) {
    throw new Error(`dlhd schedule (main) fetch failed at ${base}: ${(err as Error).message}`);
  }

  // (2) Secondary: the homepage lazy-loads these via fetch(credentials:'same-origin'); mirror that with the
  // mirror's own Referer/Origin + Accept. Each returns { success, html } — best-effort, never fatal.
  for (const src of EXTRA_SOURCES) {
    try {
      const res = await fetch(`${base}/schedule-api.php?source=${encodeURIComponent(src)}`, {
        headers: { Referer: getReferer(), Origin: base, Accept: 'application/json', 'User-Agent': UA },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { success?: boolean; html?: unknown };
      if (json?.success && typeof json.html === 'string') {
        events.push(...parseScheduleHtml(json.html));
        sources.push(src);
      }
    } catch (err) {
      logger.warn('epg', `dlhd schedule extra '${src}' failed (skipped): ${(err as Error).message}`);
    }
  }

  return { events, meta: { base, sources, fetchedAt: new Date().toISOString() } };
}
