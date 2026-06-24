// Inbound XMLTV ingestion — parse + validate a user-supplied XMLTV document (an uploaded file or a remote
// URL) into the epgchannels + programs stores. The INBOUND twin of epgpw.ts (which parses epg.pw's
// per-channel XML); here we accept a WHOLE <tv> document. Times arrive as "YYYYMMDDHHMMSS ±HHMM" — the
// offset is OPTIONAL in XMLTV — so parseXmltvTime reuses epgpw's parseEpgpwTime for the with-offset case and
// falls back to a no-offset (UTC) form. Two source kinds use this: 'xml file' (a one-shot upload) and
// 'remote url' (re-fetchable). See restapi.md + restapi-sources.md + schemas.md §3.4/§3.5.
//
// STREAMING (the load-bearing design): real-world XMLTV guides can be ENORMOUS — a single Jesmann national
// guide decompresses to 2–10 GB of XML. So the 'remote url' path NEVER buffers the whole document: it streams
// `fetch → (gz?) zlib.createGunzip → a saxes SAX parser → batched insertMany`, keeping peak RAM bounded by
// the batch size regardless of file size (channels are accumulated whole — they're tiny relative to
// programmes — programmes flush every PROGRAMME_BATCH rows). The legacy buffer-everything DOM path
// (fast-xml-parser via parseXmltv) is retained ONLY for the 'xml file' UPLOAD path, where the browser already
// gzipped the file under a 64 MB compressed body limit (decodeXmltvBody bounds its decompression).
//
// PER-SOURCE REPLACE — partial-on-failure tradeoff: the streaming path does deleteMany({source}) UP FRONT,
// then streamed batched inserts. A mid-stream failure therefore leaves the source PARTIALLY replaced; the
// caller (syncEpgSource) marks the source status:'error' and rethrows, so the next good sync replaces it
// cleanly. We accept partial-replace-on-failure (vs. a temp-collection swap) because Program/EpgChannel are
// shared collections scoped by `source`, not per-source collections — a rename swap isn't available, and a
// status:'error' source with stale-but-present rows is preferable to one with no guide at all until the retry.

import { Readable } from 'node:stream';
import { createGunzip, gunzipSync } from 'node:zlib';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { EpgChannel, type EpgChannelDoc } from '../models/EpgChannel.js';
import { Program, type ProgramDoc } from '../models/Program.js';
import { parseEpgpwTime } from './epgpw.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const XMLTV_HEADERS: Record<string, string> = {
  'User-Agent': UA,
  Accept: 'application/xml,text/xml,application/gzip,*/*;q=0.8',
};

// Streaming-pipeline tuning.
//
// Memory is no longer the constraint (we stream + flush) — these guard against a pathological / runaway file
// and bound the per-flush write size. PROGRAMME_BATCH is the insertMany batch; MAX_PROGRAMMES is a HIGH
// runaway ceiling (a legitimate multi-day national guide tops out well under 1 M programmes per source — even
// Jesmann's 3-day UnitedStates is ~600 k — so 20 M leaves enormous headroom while still stopping an infinite
// / garbage stream). MAX_ELAPSED_MS caps total wall-clock on a slow/stalled transfer.
const PROGRAMME_BATCH = 5_000;
export const MAX_PROGRAMMES = 20_000_000;
const MAX_ELAPSED_MS = 30 * 60 * 1000; // 30 min hard cap on a single streamed sync

// Cap on the DECOMPRESSED body for the buffer-everything UPLOAD path ONLY (the 'xml file' path still decodes
// the whole gzip in memory; the browser ships it under a 64 MB compressed body limit). The STREAMING path
// ('remote url') does NOT use this — it is bounded by the streaming guards above, not by a fixed byte ceiling
// (that's the whole point: a 2–10 GB Jesmann guide must pass). gunzipSync's maxOutputLength is the gzip-bomb
// guard for the upload path. Kept generous so a hand-uploaded national guide still fits.
export const MAX_XMLTV_BYTES = 256 * 1024 * 1024;

// Human label for the cap, derived from the constant so the limit lives in exactly one place.
const MAX_XMLTV_LABEL = `${Math.round(MAX_XMLTV_BYTES / 1024 / 1024)} MB`;

// Decode a raw XMLTV UPLOAD body (an in-memory buffer) → its text. Transparently gunzips a gzip body (magic
// bytes 1f 8b) — uploads ship gzipped — capping the decompressed output at MAX_XMLTV_BYTES (a gzip-bomb
// guard: gunzipSync's maxOutputLength throws before allocating past the ceiling). A non-gzip body is decoded
// as UTF-8 and length-checked. The REMOTE-URL path does NOT call this (it streams — see fetchXmltvStream).
export function decodeXmltvBody(buf: Buffer): string {
  const gz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  let xml: Buffer;
  if (gz) {
    try {
      xml = gunzipSync(buf, { maxOutputLength: MAX_XMLTV_BYTES });
    } catch (err) {
      throw new Error(`Could not decompress the gzip body — ${(err as Error).message}`);
    }
  } else {
    xml = buf;
  }
  if (xml.byteLength > MAX_XMLTV_BYTES) throw new Error(`Content exceeds the ${MAX_XMLTV_LABEL} limit.`);
  return xml.toString('utf-8');
}

// ──────────────────────────────────────────────────────────────────────
// Wire shapes (parsed XMLTV)
// ──────────────────────────────────────────────────────────────────────

export interface XmltvChannel {
  id: string;
  displayName: string;
  icon: string | null;
}

export interface XmltvProgramme {
  channel: string;
  start: string;
  stop: string;
  title: string;
  desc: string | null;
  category: string | null;
}

export interface XmltvSampleItem {
  channelNo: string | null;
  callSign: string | null;
  title: string;
  start: number; // epoch ms
  end: number; // epoch ms
}

export interface XmltvValidation {
  ok: boolean;
  channelCount: number;
  programmeCount: number;
  sample: XmltvSampleItem[];
  errors: string[];
}

// ──────────────────────────────────────────────────────────────────────
// DOM parser (legacy upload path only)
// ──────────────────────────────────────────────────────────────────────

// Keep <channel>/<programme> ALWAYS arrays (so a single-entry file still iterates), keep ids/times as
// strings (a channel id like "12.1" must not become a number), and let fast-xml-parser fold CDATA into text.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === 'channel' || name === 'programme',
});

// Pull the first text value out of a fast-xml-parser node, whatever its shape: a bare string, an array of
// nodes (repeated <display-name>/<title>/<category> → first wins), or an object carrying '#text' + attrs.
function text(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.length ? text(v[0]) : '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('#text' in o) return text(o['#text']);
  }
  return '';
}

function toXmltvChannel(c: Record<string, unknown>): XmltvChannel | null {
  const id = String(c['@_id'] ?? '').trim();
  if (!id) return null;
  const displayName = text(c['display-name']) || id;
  let icon: string | null = null;
  const ic = Array.isArray(c.icon) ? c.icon[0] : c.icon;
  if (ic && typeof ic === 'object') {
    const src = String((ic as Record<string, unknown>)['@_src'] ?? '').trim();
    if (src) icon = src;
  }
  return { id, displayName, icon };
}

function toXmltvProgramme(p: Record<string, unknown>): XmltvProgramme | null {
  const channel = String(p['@_channel'] ?? '').trim();
  if (!channel) return null;
  const start = String(p['@_start'] ?? '').trim();
  const stop = String(p['@_stop'] ?? '').trim();
  const title = text(p.title) || 'Program';
  const desc = p.desc != null ? text(p.desc) || null : null;
  const category = p.category != null ? text(p.category) || null : null;
  return { channel, start, stop, title, desc, category };
}

// Parse a whole XMLTV document → its channels + programmes (buffer-everything; UPLOAD path / validate only).
// Throws only on a hard parser failure. Drops channels with no id and programmes with no channel ref.
export function parseXmltv(xml: string): { channels: XmltvChannel[]; programmes: XmltvProgramme[] } {
  const root = parser.parse(xml) as Record<string, unknown>;
  const tv = (root?.tv ?? {}) as Record<string, unknown>;
  const rawChannels = (Array.isArray(tv.channel) ? tv.channel : tv.channel ? [tv.channel] : []) as Record<
    string,
    unknown
  >[];
  const rawProgrammes = (Array.isArray(tv.programme)
    ? tv.programme
    : tv.programme
      ? [tv.programme]
      : []) as Record<string, unknown>[];
  const channels = rawChannels
    .map(toXmltvChannel)
    .filter((c): c is XmltvChannel => c !== null);
  const programmes = rawProgrammes
    .map(toXmltvProgramme)
    .filter((p): p is XmltvProgramme => p !== null);
  return { channels, programmes };
}

// XMLTV time → epoch ms. With an offset ("YYYYMMDDHHMMSS ±HHMM") reuse epgpw's parser; otherwise accept the
// offset-less forms ("YYYYMMDDHHMMSS" / "...HHMM" / "YYYYMMDD") and treat them as UTC. NaN on failure.
export function parseXmltvTime(s: string): number {
  const str = String(s).trim();
  if (!str) return NaN;
  const withOffset = parseEpgpwTime(str);
  if (!Number.isNaN(withOffset)) return withOffset;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/.exec(str);
  if (!m) return NaN;
  const [, yy, mo, dd, hh, mm, ss] = m;
  return Date.UTC(
    Number(yy),
    Number(mo) - 1,
    Number(dd),
    Number(hh ?? '0'),
    Number(mm ?? '0'),
    Number(ss ?? '0'),
  );
}

// ──────────────────────────────────────────────────────────────────────
// Mappers (shared by the DOM upload path AND the streaming path's per-element build)
// ──────────────────────────────────────────────────────────────────────

// Build one EpgChannelDoc from a parsed channel. The deterministic _id "<sourceId>:<id>" makes a re-sync
// upsert instead of duplicate; XMLTV has no call-sign/channel-number field → both null (never fabricated).
function buildEpgChannel(c: XmltvChannel, sourceId: string): EpgChannelDoc {
  return {
    _id: `${sourceId}:${c.id}`,
    callSign: null,
    affiliateName: c.displayName || c.id,
    channelId: c.id,
    channelNo: null,
    source: sourceId,
  };
}

// Build one ProgramDoc from a parsed programme, or null when its start/stop is unparseable (skip — like
// EPG-PW). `channelId` is the composite "<sourceId>:<channel>" key == epgchannels._id (the guide join key);
// `offset` is the operator's UTC offset stamped onto every row (start/end stay UTC epoch-ms).
function buildProgram(p: XmltvProgramme, sourceId: string, offset: string): ProgramDoc | null {
  const start = parseXmltvTime(p.start);
  const end = parseXmltvTime(p.stop);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return {
    channelId: `${sourceId}:${p.channel}`,
    start,
    end,
    offset,
    title: p.title,
    cat: p.category || 'Other',
    source: sourceId,
    callSign: null,
    channelNo: null,
    shortDesc: p.desc,
    rating: null,
    seriesId: null,
    season: null,
    episode: null,
    episodeTitle: null,
  };
}

export function mapXmltvToEpgChannels(channels: XmltvChannel[], sourceId: string): EpgChannelDoc[] {
  const byId = new Map<string, EpgChannelDoc>();
  for (const c of channels) {
    const doc = buildEpgChannel(c, sourceId);
    if (!byId.has(doc._id)) byId.set(doc._id, doc);
  }
  return [...byId.values()];
}

export function mapXmltvToPrograms(programmes: XmltvProgramme[], sourceId: string, offset: string): ProgramDoc[] {
  const docs: ProgramDoc[] = [];
  for (const p of programmes) {
    const doc = buildProgram(p, sourceId, offset);
    if (doc) docs.push(doc);
  }
  return docs;
}

// ──────────────────────────────────────────────────────────────────────
// Validation (the modal's pre-flight) — DOM path
// ──────────────────────────────────────────────────────────────────────

// Validate an XMLTV STRING WITHOUT persisting (the UPLOAD content path). `ok` requires: well-formed XML · a
// <tv> root · ≥1 <channel> · ≥1 <programme> · ≥1 parseable programme time. `errors[]` carries specific,
// human-readable issues (a leading "Warning:" line is informational and does NOT block `ok`). `sample[]`
// mirrors the EPG-PW preview shape so the Add modal reuses its summary-card markup.
export function validateXmltv(xml: string): XmltvValidation {
  const empty = { channelCount: 0, programmeCount: 0, sample: [] as XmltvSampleItem[] };
  if (xml.length > MAX_XMLTV_BYTES) {
    return { ok: false, ...empty, errors: [`Content exceeds the ${MAX_XMLTV_LABEL} limit.`] };
  }
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    const msg = (valid && typeof valid === 'object' && valid.err?.msg) || 'malformed XML';
    return { ok: false, ...empty, errors: [`File is not valid XML — ${msg}`] };
  }

  let parsed: { channels: XmltvChannel[]; programmes: XmltvProgramme[] };
  try {
    parsed = parseXmltv(xml);
  } catch (err) {
    return { ok: false, ...empty, errors: [`Could not parse XMLTV — ${(err as Error).message}`] };
  }

  const errors: string[] = [];
  if (!/<tv[\s>]/i.test(xml)) errors.push('Missing <tv> root element — this is not an XMLTV document.');
  const { channels, programmes } = parsed;
  if (!channels.length) errors.push('No <channel> elements found.');
  if (!programmes.length) errors.push('No <programme> elements found.');

  const nameById = new Map(channels.map((c) => [c.id, c.displayName]));
  const declared = new Set(channels.map((c) => c.id));
  const sample: XmltvSampleItem[] = [];
  let parseableTimes = 0;
  let unknownRefs = 0;
  for (const p of programmes) {
    const start = parseXmltvTime(p.start);
    const end = parseXmltvTime(p.stop);
    if (!Number.isNaN(start) && !Number.isNaN(end)) parseableTimes++;
    if (!declared.has(p.channel)) unknownRefs++;
    if (sample.length < 5 && !Number.isNaN(start)) {
      sample.push({
        channelNo: null,
        callSign: nameById.get(p.channel) ?? p.channel,
        title: p.title,
        start,
        end: Number.isNaN(end) ? start : end,
      });
    }
  }
  if (programmes.length && parseableTimes === 0) {
    errors.push('Programme start/stop times are not in XMLTV format (YYYYMMDDHHMMSS).');
  }
  if (unknownRefs > 0) {
    errors.push(`Warning: ${unknownRefs} programme(s) reference channels not declared in the file.`);
  }

  const ok = errors.every((e) => e.startsWith('Warning:'));
  return { ok, channelCount: channels.length, programmeCount: programmes.length, sample, errors };
}

// ──────────────────────────────────────────────────────────────────────
// Streaming SAX parser (the large-guide path)
// ──────────────────────────────────────────────────────────────────────

// A saxes-driven streaming reader over an XMLTV byte stream. It tracks the CURRENT open <channel>/<programme>
// (attributes + the inner <display-name>/<icon>/<title>/<desc>/<category> text it cares about) and, on each
// close tag, hands back the finished XmltvChannel / XmltvProgramme. Everything else is ignored. Memory is
// bounded to the one element being built. The class is parser-state only — DB/flush is the caller's job.
class XmltvSaxReader {
  private readonly sax: SaxesParser;
  channelCount = 0;
  programmeCount = 0;

  // Current open element scratch.
  private chan: { id: string; displayName: string; icon: string | null } | null = null;
  private prog: { channel: string; start: string; stop: string; title: string; desc: string | null; category: string | null } | null = null;
  private cur: string | null = null; // the inner text tag we're collecting ('display-name'|'title'|'desc'|'category')
  private buf = '';

  constructor(
    private readonly onChannel: (c: XmltvChannel) => void,
    private readonly onProgramme: (p: XmltvProgramme) => void,
  ) {
    this.sax = new SaxesParser({ position: false });
    this.sax.on('opentag', (t) => this.open(t));
    this.sax.on('closetag', (t) => this.close(t.name));
    this.sax.on('text', (s) => {
      if (this.cur) this.buf += s;
    });
    this.sax.on('cdata', (s) => {
      if (this.cur) this.buf += s;
    });
    // Let a hard XML error surface to the stream consumer (write() rethrows below via the saxes error event).
    this.sax.on('error', (e) => {
      throw e;
    });
  }

  private attr(t: SaxesTagPlain, name: string): string {
    const v = t.attributes[name];
    return typeof v === 'string' ? v.trim() : '';
  }

  private open(t: SaxesTagPlain): void {
    switch (t.name) {
      case 'channel':
        this.chan = { id: this.attr(t, 'id'), displayName: '', icon: null };
        break;
      case 'programme':
        this.prog = {
          channel: this.attr(t, 'channel'),
          start: this.attr(t, 'start'),
          stop: this.attr(t, 'stop'),
          title: '',
          desc: null,
          category: null,
        };
        break;
      case 'icon':
        if (this.chan && !this.chan.icon) {
          const src = this.attr(t, 'src');
          if (src) this.chan.icon = src;
        }
        break;
      case 'display-name':
      case 'title':
      case 'desc':
      case 'category':
        // Only collect the FIRST of repeated tags (matches the DOM path's "first wins").
        this.cur = t.name;
        this.buf = '';
        break;
      default:
        break;
    }
  }

  private close(name: string): void {
    // Finish an inner text tag.
    if (name === this.cur) {
      const v = this.buf.trim();
      this.buf = '';
      this.cur = null;
      if (this.chan && name === 'display-name' && !this.chan.displayName) this.chan.displayName = v;
      else if (this.prog) {
        if (name === 'title' && !this.prog.title) this.prog.title = v;
        else if (name === 'desc' && this.prog.desc == null) this.prog.desc = v || null;
        else if (name === 'category' && this.prog.category == null) this.prog.category = v || null;
      }
      return;
    }
    if (name === 'channel' && this.chan) {
      const { id } = this.chan;
      if (id) {
        this.channelCount++;
        this.onChannel({ id, displayName: this.chan.displayName || id, icon: this.chan.icon });
      }
      this.chan = null;
    } else if (name === 'programme' && this.prog) {
      const { channel } = this.prog;
      if (channel) {
        this.programmeCount++;
        this.onProgramme({
          channel,
          start: this.prog.start,
          stop: this.prog.stop,
          title: this.prog.title || 'Program',
          desc: this.prog.desc,
          category: this.prog.category,
        });
      }
      this.prog = null;
    }
  }

  write(chunk: string): void {
    this.sax.write(chunk);
  }

  end(): void {
    this.sax.close();
  }
}

export interface StreamIngestCounts {
  channels: number;
  programs: number;
}

// Stream an XMLTV byte stream → REPLACE the owning source's epgchannels + programs, with BOUNDED memory.
// Channels are accumulated WHOLE (they're tiny relative to programmes — a national guide has thousands of
// channels but hundreds of thousands of programmes) and de-duped by composite _id; programmes are flushed to
// Mongo via insertMany every PROGRAMME_BATCH rows so peak RAM never scales with file size. deleteMany({source})
// runs UP FRONT (see the module header's partial-replace tradeoff). Throws on a hard XML error, the runaway
// guards (MAX_PROGRAMMES / MAX_ELAPSED_MS), or a DB failure — leaving the source partially replaced for the
// caller to mark status:'error'. Returns the WRITTEN counts (parseable programmes only — NaN-timed dropped).
export async function streamXmltvToEpg(
  stream: Readable,
  sourceId: string,
  offset: string,
): Promise<StreamIngestCounts> {
  const startedAt = Date.now();
  const channelById = new Map<string, EpgChannelDoc>();
  let pending: ProgramDoc[] = [];
  let writtenPrograms = 0;
  let seenProgrammes = 0;

  // Clear the source up front, then stream-replace. (Partial-on-failure: documented in the module header.)
  await Program.deleteMany({ source: sourceId });
  await EpgChannel.deleteMany({ source: sourceId });

  const flush = async (): Promise<void> => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    await Program.insertMany(batch, { ordered: false });
    writtenPrograms += batch.length;
  };

  const reader = new XmltvSaxReader(
    (c) => {
      const doc = buildEpgChannel(c, sourceId);
      if (!channelById.has(doc._id)) channelById.set(doc._id, doc);
    },
    (p) => {
      seenProgrammes++;
      if (seenProgrammes > MAX_PROGRAMMES) {
        throw new Error(`xmltv stream aborted: exceeded ${MAX_PROGRAMMES.toLocaleString()} programmes`);
      }
      const doc = buildProgram(p, sourceId, offset);
      if (doc) pending.push(doc);
    },
  );

  // Feed decoded UTF-8 chunks to the SAX parser, flushing programme batches as they fill. The await between
  // chunks is what keeps memory bounded — backpressure on the insertMany pauses consumption.
  stream.setEncoding('utf-8');
  for await (const chunk of stream as AsyncIterable<string>) {
    if (Date.now() - startedAt > MAX_ELAPSED_MS) {
      throw new Error(`xmltv stream aborted: exceeded ${Math.round(MAX_ELAPSED_MS / 60000)} min time limit`);
    }
    reader.write(chunk);
    while (pending.length >= PROGRAMME_BATCH) {
      // Drain a full batch (the SAX callback may have queued several batches' worth in one chunk).
      const batch = pending.slice(0, PROGRAMME_BATCH);
      pending = pending.slice(PROGRAMME_BATCH);
      await Program.insertMany(batch, { ordered: false });
      writtenPrograms += batch.length;
    }
  }
  reader.end();
  await flush();

  // Insert the accumulated channels last (de-duped, far fewer than programmes).
  const channelDocs = [...channelById.values()];
  if (channelDocs.length) await EpgChannel.insertMany(channelDocs, { ordered: false });

  return { channels: channelDocs.length, programs: writtenPrograms };
}

// Stream-COUNT an XMLTV byte stream without persisting — the bounded-memory pre-flight for a remote URL (the
// streaming analogue of validateXmltv, which buffers). Returns the same XmltvValidation shape: counts, a small
// sample, and `ok` (≥1 channel + ≥1 programme + ≥1 parseable time). Stops reading once the sample is full AND
// enough has been seen to decide `ok`, so even a 10 GB guide is cheap to validate.
export async function streamValidateXmltv(stream: Readable): Promise<XmltvValidation> {
  const nameById = new Map<string, string>();
  const sample: XmltvSampleItem[] = [];
  let channelCount = 0;
  let programmeCount = 0;
  let parseableTimes = 0;
  let unknownRefs = 0;
  // We only need enough to decide ok + fill 5 samples; cap the programmes we inspect so validate stays O(1).
  const INSPECT_LIMIT = 50_000;

  const reader = new XmltvSaxReader(
    (c) => {
      channelCount++;
      if (!nameById.has(c.id)) nameById.set(c.id, c.displayName);
    },
    (p) => {
      programmeCount++;
      if (programmeCount > INSPECT_LIMIT) return; // counted past here but no longer inspected
      const start = parseXmltvTime(p.start);
      const end = parseXmltvTime(p.stop);
      if (!Number.isNaN(start) && !Number.isNaN(end)) parseableTimes++;
      if (!nameById.has(p.channel)) unknownRefs++;
      if (sample.length < 5 && !Number.isNaN(start)) {
        sample.push({
          channelNo: null,
          callSign: nameById.get(p.channel) ?? p.channel,
          title: p.title,
          start,
          end: Number.isNaN(end) ? start : end,
        });
      }
    },
  );

  try {
    stream.setEncoding('utf-8');
    for await (const chunk of stream as AsyncIterable<string>) {
      reader.write(chunk);
    }
    reader.end();
  } catch (err) {
    return {
      ok: false,
      channelCount,
      programmeCount,
      sample,
      errors: [`Could not parse XMLTV — ${(err as Error).message}`],
    };
  }

  const errors: string[] = [];
  if (!channelCount) errors.push('No <channel> elements found.');
  if (!programmeCount) errors.push('No <programme> elements found.');
  if (programmeCount && parseableTimes === 0) {
    errors.push('Programme start/stop times are not in XMLTV format (YYYYMMDDHHMMSS).');
  }
  if (unknownRefs > 0) {
    errors.push(`Warning: ${unknownRefs} programme(s) reference channels not declared in the file.`);
  }
  const ok = errors.every((e) => e.startsWith('Warning:'));
  return { ok, channelCount, programmeCount, sample, errors };
}

// Parse + REPLACE the owning source's epgchannels then programs from an in-memory XMLTV STRING (the UPLOAD
// path — buffer-everything; the 'xml file' source). The streaming path (streamXmltvToEpg) is used for remote
// URLs. Returns the written counts.
export async function writeXmltvEpg(
  xml: string,
  sourceId: string,
  offset: string,
): Promise<{ channels: number; programs: number }> {
  const { channels, programmes } = parseXmltv(xml);
  const channelDocs = mapXmltvToEpgChannels(channels, sourceId);
  const programDocs = mapXmltvToPrograms(programmes, sourceId, offset);

  await EpgChannel.deleteMany({ source: sourceId });
  if (channelDocs.length) await EpgChannel.insertMany(channelDocs, { ordered: false });

  await Program.deleteMany({ source: sourceId });
  if (programDocs.length) await Program.insertMany(programDocs, { ordered: false });

  return { channels: channelDocs.length, programs: programDocs.length };
}

// ──────────────────────────────────────────────────────────────────────
// Remote fetch (the 'remote url' path) — STREAMING
// ──────────────────────────────────────────────────────────────────────

// Open a STREAM of decoded (UTF-8) XMLTV text for a URL, with bounded memory. Prefers the smaller `.gz`
// transfer when the URL doesn't already end in `.gz` (try `<url>.gz` first, fall back to the given URL on a
// non-OK status — many Jesmann mirrors serve both, but per-market/Team-Sports files have NO `.gz`). The body
// is detected as gzip by `.gz` suffix, Content-Encoding, or the 1f 8b magic bytes and piped through
// zlib.createGunzip(); otherwise the raw `.xml` is streamed. Honors the global undici DNS dispatcher. Throws
// a tagged error on a non-OK status (→ the route maps it to 502 xmltv_unreachable). Returns a Node Readable of
// DECODED gzip-or-raw bytes (NOT setEncoding'd yet — the caller sets utf-8).
export async function fetchXmltvStream(url: string): Promise<Readable> {
  const isGzUrl = /\.gz(\?|#|$)/i.test(url);

  // Try the smaller `.gz` first for a non-`.gz` URL; fall back to the original on any non-OK / fetch error.
  const candidates = isGzUrl ? [url] : [`${url}.gz`, url];
  let res: Response | null = null;
  let lastErr: Error | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const r = await fetch(candidate, { headers: XMLTV_HEADERS, redirect: 'follow' });
      if (r.ok) {
        res = r;
        break;
      }
      // Drain a non-OK body so the socket can be reused; record the failure.
      await r.body?.cancel().catch(() => {});
      lastErr = new Error(`xmltv fetch: HTTP ${r.status}`);
    } catch (err) {
      lastErr = new Error(`xmltv fetch failed: ${(err as Error).message}`);
    }
  }
  if (!res || !res.body) throw lastErr ?? new Error('xmltv fetch failed: no response body');

  const raw = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);

  // Decide gzip by SNIFFING the first 2 bytes (1f 8b) — the only reliable signal. Mirrors are inconsistent:
  // some serve `.xml.gz` with NO Content-Encoding (fetch does NOT auto-decode → bytes are still gzip-framed →
  // we gunzip); some set `Content-Encoding: gzip` (undici DOES auto-decode → bytes are already plain XML → we
  // stream raw). Sniffing the wire bytes after any undici auto-decode handles both without double-decoding.
  const head = (await raw[Symbol.asyncIterator]().next()) as IteratorResult<Buffer>;
  const firstChunk: Buffer = head.done ? Buffer.alloc(0) : head.value;
  const looksGz = firstChunk.length > 1 && firstChunk[0] === 0x1f && firstChunk[1] === 0x8b;

  // Re-prepend the peeked chunk, then optionally gunzip. Build a fresh Readable that yields the head then the
  // rest of the source so no bytes are lost.
  const recombined = Readable.from((async function* () {
    if (!head.done) yield firstChunk;
    for await (const c of raw) yield c as Buffer;
  })());

  return looksGz ? recombined.pipe(createGunzip()) : recombined;
}

// Fetch a remote XMLTV URL + REPLACE the source's channels/programs by STREAMING — the 'remote url' re-sync
// path (dispatched from syncEpgSource and run inline at create time). Bounded memory regardless of guide size.
export async function syncXmltvUrl(
  sourceId: string,
  url: string,
  offset: string,
): Promise<{ channels: number; programs: number }> {
  const stream = await fetchXmltvStream(url);
  return streamXmltvToEpg(stream, sourceId, offset);
}

// Stream-validate a remote XMLTV URL without persisting — the bounded-memory pre-flight for the Custom Add
// modal's `{ url }` validate. Throws a tagged fetch error on a non-OK status (→ 502 xmltv_unreachable).
export async function validateXmltvUrl(url: string): Promise<XmltvValidation> {
  const stream = await fetchXmltvStream(url);
  return streamValidateXmltv(stream);
}
