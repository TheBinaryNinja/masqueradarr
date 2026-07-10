/**
 * Regenerates every README diagram. Run:  node docs/diagrams/_gen.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { C, svg, header, lane, card, edge, pill, legend, text, diamond, step, measure, cardHeight } from './_lib.mjs';

const OUT = dirname(fileURLToPath(import.meta.url));
const write = (name, s) => { writeFileSync(join(OUT, name), s + '\n'); console.log('✓', name); };

const ROLE = {
  client: [C.ash, 'Client'],
  node: [C.teal, 'Node — control plane'],
  rust: [C.amber, 'Rust — data plane'],
  store: [C.green, 'Datastore'],
  upstream: [C.dim, 'Upstream / external'],
  deny: [C.risk, 'Deny / error path'],
};
const L = (...keys) => keys.map((k) => ROLE[k]);

/* ── 1 · architecture overview ──────────────────────────────────────────── */
{
  const W = 1000, H = 700;
  let b = header(W, 'Primary architecture', 'server/src/index.ts · proxy/');

  b += lane({ x: 32, y: 76, w: 936, h: 104, label: 'CLIENTS' });
  const browser = card({ x: 270, y: 100, w: 220, rail: C.ash, title: 'Browser', sub: ['Vue 3 SPA · management UI'] });
  const iptv = card({ x: 510, y: 100, w: 220, rail: C.ash, title: 'IPTV clients', sub: ['TiviMate · VLC · Plex · Jellyfin'] });

  b += lane({ x: 32, y: 236, w: 936, h: 232, label: 'MASQUERADARR CONTAINER', color: C.teal });
  const mongo = card({ x: 60, y: 252, w: 190, rail: C.green, title: 'MongoDB', sub: ['playlists · channels · EPG', 'users · settings · logs'] });
  const node = card({ x: 340, y: 252, w: 320, rail: C.teal, title: 'Express 4 API — Node', sub: ['control plane', 'auth · sources · EPG · telemetry'] });
  const rust = card({ x: 340, y: 372, w: 320, rail: C.amber, title: 'masq-proxy — Rust', sub: ['data plane · sidecar process', 'fetch · rewrite · pipe bytes'] });

  b += lane({ x: 32, y: 520, w: 936, h: 104, label: 'UPSTREAM' });
  const up = card({ x: 340, y: 544, w: 320, rail: C.dim, title: 'Upstream IPTV sources', sub: ['dulo · DaddyLive · Pluto · Roku · …'] });

  b += edge([[380, 157], [380, 250]], { color: 'ash' });
  b += edge([[620, 157], [620, 250]], { color: 'ash' });
  b += edge([[731, 128], [900, 128], [900, 300], [662, 300]], { color: 'ash' });
  b += edge([[338, 288], [252, 288]], { color: 'green', head: 'both' });
  b += edge([[440, 324], [440, 370]], { color: 'teal' });
  b += edge([[560, 370], [560, 324]], { color: 'amber' });
  b += edge([[500, 444], [500, 542]], { color: 'amber' });

  b += browser.svg + iptv.svg + mongo.svg + node.svg + rust.svg + up.svg;

  b += pill(380, 196, '/api/* · WebSockets');
  b += pill(620, 196, 'token-gated .m3u + XMLTV');
  b += pill(780, 300, 'stream bytes · /api/ext/v1');
  b += pill(440, 347, 'gate + relay', { color: C.teal });
  b += pill(560, 347, 'seams · loopback', { color: C.amber });
  b += pill(500, 493, 'resolve · fetch · rewrite · pipe', { color: C.amber });

  b += legend(32, 662, L('client', 'node', 'rust', 'store', 'upstream'));
  write('architecture-overview.svg', svg(W, H, b));
}

/* ── 3 · source lifecycle ───────────────────────────────────────────────── */
{
  const W = 1040, H = 596;
  let b = header(W, 'Lifecycle — how a built-in source reaches the UI', 'server/src/sources/core/buildSource.ts');

  b += lane({ x: 32, y: 84, w: 976, h: 268, label: 'CATALOG PIPELINE', color: C.teal });
  b += lane({ x: 32, y: 388, w: 976, h: 116, label: 'PLAYBACK', color: C.amber });

  const cw = 222;
  const c1 = card({ x: 52, y: 108, w: cw, rail: C.teal, title: '1 · Provision', sub: ['POST /api/sources/:id/provision', 'ensureShellRow → creates a', 'zero-channel Playlist doc'], subMono: false });
  const c2 = card({ x: 290, y: 108, w: cw, rail: C.teal, title: '2 · Sync now', sub: ['syncLive → listChannels()', 'live fetch, else committed', 'seed snapshot (playlist → warn)'] });
  const c3 = card({ x: 528, y: 108, w: cw, rail: C.teal, title: '3 · Normalize', sub: ['adapter.normalize(raw)', '→ sourcechannels', 'pristine synced reference'] });
  const c4 = card({ x: 766, y: 108, w: cw, rail: C.teal, title: '4 · Project', sub: ['toPlaylistChannel', '→ playlistchannels', 'user edits kept ($setOnInsert)'] });

  const afterSync = card({ x: 528, y: 250, w: cw, rail: C.green, title: 'adapter.afterSync()', sub: ['epgsources · epgchannels', 'programs — self-EPG sources'] });
  const spa = card({ x: 766, y: 250, w: cw, rail: C.ash, title: 'SPA', sub: ['GET /api/playlists/:id/channels'] });

  const stores = card({
    x: 52, y: 250, w: 460, rail: C.green, dashed: true, fill: C.carbon, title: 'Two channel stores back every playlist',
    sub: ['sourcechannels — pristine reference, $set on every sync', 'playlistchannels — editable + UI-facing, $setOnInsert', 'so user edits survive a re-sync'],
  });

  const proxy = card({
    x: 52, y: 411, w: 936, rail: C.amber, title: 'Stream request — live',
    sub: ['/api/v1/:source/:encUrl   ·   streamGate → proxyRelay → masq-proxy (Rust)', 'resolve seam → adapter.resolveStream → fetch · rewrite · pipe   (HLS + raw-TS)'],
  });

  for (const x of [274, 512, 750]) b += edge([[x, 150], [x + 14, 150]], { color: 'teal', r: 0 });
  b += edge([[639, 194], [639, 249]], { color: 'green' });
  b += edge([[877, 194], [877, 249]], { color: 'ash' });
  b += edge([[877, 307], [877, 410]], { color: 'ash' });

  b += c1.svg + c2.svg + c3.svg + c4.svg + afterSync.svg + spa.svg + stores.svg + proxy.svg;
  b += pill(639, 222, 'self-EPG only', { color: C.green });
  b += pill(877, 370, 'stream request');
  b += text(52, 532, 'Stream URLs are never stored — a channel keeps its origin source and is resolved on demand at play time.', { fill: C.dim, size: 9.6 });

  b += legend(32, 566, L('node', 'store', 'client', 'rust'));
  write('source-lifecycle.svg', svg(W, H, b));
}

/* ── 4 · guide composition ──────────────────────────────────────────────── */
{
  const W = 880, H = 800;
  let b = header(W, 'Guide composition — a guide can never drift from its M3U', 'server/src/epg/composeGuide.ts');

  const mid = 280, cw = 320, left = 60, right = 500;
  const m = card({ x: mid, y: 92, w: cw, rail: C.teal, titleMono: true, title: 'composeM3u(surface)', sub: ['Global union · or one Custom playlist', 'writes the Active channel set'] });
  const g = card({ x: mid, y: 210, w: cw, rail: C.teal, titleMono: true, title: 'composeGuide(channels, path)', sub: ['runs off the same channel set', 'as a sibling of the .m3u'] });
  const s = card({ x: mid, y: 328, w: cw, rail: C.teal, title: 'Select', sub: ['keep Active + (tvg_id, epg)-linked', 'key = <epg>:<tvg_id>'] });
  const ch = card({ x: left, y: 446, w: cw, rail: C.green, title: 'Channels', sub: ['epgchannels → <channel>', 'dedupe by bare tvg_id · first-wins'] });
  const pr = card({ x: right, y: 446, w: cw, rail: C.green, title: 'Programmes', sub: ['programs → <programme>', 're-tag to the bare tvg_id'] });
  const tv = card({ x: mid, y: 564, w: cw, rail: C.teal, title: 'Merge + advertise', sub: ['<tv> written beside the .m3u', 'advertised via x-tvg-url', 'token-free · not per-user'] });
  const cr = card({ x: mid, y: 682, w: cw, rail: C.green, title: 'Credit each source', sub: ['lastXmlAt · xmlGeneratedCount++'] });

  b += edge([[440, 163], [440, 208]], { color: 'teal' });
  b += edge([[440, 281], [440, 326]], { color: 'teal' });
  b += edge([[440, 399], [440, 420], [220, 420], [220, 444]], { color: 'teal' });
  b += edge([[440, 399], [440, 420], [660, 420], [660, 444]], { color: 'teal' });
  b += edge([[220, 517], [220, 538], [440, 538], [440, 562]], { color: 'green' });
  b += edge([[660, 517], [660, 538], [440, 538], [440, 562]], { color: 'green' });
  b += edge([[440, 650], [440, 680]], { color: 'teal' });

  b += m.svg + g.svg + s.svg + ch.svg + pr.svg + tv.svg + cr.svg;
  b += pill(440, 186, 'the same Active channels', { color: C.teal });

  b += step(mid + cw - 14, 342, '1');
  b += step(left + cw - 14, 460, '2', C.green);
  b += step(right + cw - 14, 460, '3', C.green);
  b += step(mid + cw - 14, 578, '4');
  b += step(mid + cw - 14, 696, '5', C.green);

  b += legend(32, 762, [[C.teal, 'Compose path'], [C.green, 'Guide data (epgchannels · programs)']]);
  write('guide-composition.svg', svg(W, H, b));
}

/* ── 5 · internal seams ─────────────────────────────────────────────────── */
{
  const W = 1040, H = 640;
  let b = header(W, 'The internal seams — loopback, shared secret', 'server/src/routes/internal.ts');

  b += lane({ x: 32, y: 84, w: 368, h: 476, label: 'NODE — CONTROL PLANE', color: C.teal });
  b += lane({ x: 648, y: 84, w: 360, h: 476, label: 'RUST — DATA PLANE', color: C.amber });

  // the seam itself: an airlock column straddling the two planes
  b += `<rect x="416" y="240" width="192" height="300" rx="12" fill="${C.carbon}" stroke="${C.teal}" stroke-opacity="0.45" stroke-width="1.2"/>`;
  b += text(512, 266, '/api/internal/*', { fill: C.teal, size: 11.6, weight: 600, mono: true, anchor: 'middle' });
  b += text(512, 281, 'loopback · x-masq-secret', { fill: C.dim, size: 8.8, anchor: 'middle' });

  const port = (cy, name, note, color = C.teal, dashed = false) =>
    `<rect x="432" y="${cy - 18}" width="160" height="36" rx="7" fill="${C.card}" stroke="${color}" stroke-opacity="0.42" stroke-width="1"${dashed ? ' stroke-dasharray="4 3"' : ''}/>`
    + text(444, cy + 3.6, name, { fill: color, size: 10.4, weight: 600, mono: true })
    + text(580, cy + 3.4, note, { fill: C.dim, size: 8.6, anchor: 'end' });

  const gate = card({ x: 48, y: 100, w: 336, rail: C.teal, title: 'streamGate', sub: ['stream-token access ladder'] });
  const relay = card({ x: 48, y: 190, w: 336, rail: C.teal, title: 'proxyRelay', sub: ['reverse-proxy + client identity'] });
  const resolve = card({ x: 48, y: 282, w: 336, rail: C.teal, title: 'adapter resolve', sub: ['dulo auth · dlhd scrape · SourceProxy bag'] });
  const tel = card({ x: 48, y: 356, w: 336, rail: C.teal, title: 'telemetry authority', sub: ['streamState · ViewSession · WS'] });
  const logs = card({ x: 48, y: 430, w: 336, rail: C.teal, title: 'log store', sub: ['proxy category · level-gated'] });

  const engine = card({ x: 664, y: 190, w: 328, rail: C.amber, title: 'serve_stream', sub: ['fetch · manifest rewrite · segment pipe'] });
  const rsl = card({ x: 664, y: 270, w: 156, rail: C.amber, title: 'RSL durability', sub: ['retry · failover', 'read-ahead buffer'] });
  const ts = card({ x: 836, y: 270, w: 156, rail: C.amber, title: 'tsmux', sub: ['raw MPEG-TS', 'distribution'] });
  const inv = card({
    x: 664, y: 372, w: 328, rail: C.dim, dashed: true, fill: C.carbon, title: 'Invariant',
    sub: ['Rust never reads MongoDB.', 'Node resolves proxyconfigs into the grant.'],
  });

  b += edge([[216, 157], [216, 188]], { color: 'teal' });
  b += edge([[385, 218], [662, 218]], { color: 'teal' });
  b += edge([[742, 247], [742, 268]], { color: 'amber' });
  b += edge([[914, 247], [914, 268]], { color: 'amber' });

  // the seam bus: one trunk down the gutter, four taps into the ports
  b += `<path d="${['M 663 218', 'L 637 218', 'Q 628 218 628 227', 'L 628 518'].join(' ')}" fill="none" stroke="${C.teal}" stroke-width="1.5" opacity="0.5"/>`;
  for (const cy of [310, 384, 458]) b += edge([[628, cy], [594, cy]], { color: 'teal', r: 0 });
  b += edge([[628, 518], [594, 518]], { color: 'dim', dash: '4 3', r: 0 });
  for (const cy of [310, 384, 458, 518]) b += `<circle cx="628" cy="${cy}" r="2.4" fill="${C.teal}" opacity="${cy === 518 ? 0.45 : 0.9}"/>`;

  for (const cy of [310, 384, 458]) b += edge([[430, cy], [386, cy]], { color: 'teal', r: 0 });
  b += edge([[430, 518], [408, 518], [408, 128], [386, 128]], { color: 'dim', dash: '4 3' });

  b += gate.svg + relay.svg + resolve.svg + tel.svg + logs.svg + engine.svg + rsl.svg + ts.svg + inv.svg;

  b += port(310, '/resolve', '→ grant');
  b += port(384, '/telemetry', 'batched');
  b += port(458, '/log', 'batched');
  b += port(518, '/authorize', 'edge mode only', C.dim, true);
  b += pill(523, 218, '127.0.0.1:8787');

  b += text(32, 586, 'The telemetry + log responses echo the current log level — a verbosity change on the Settings screen reaches the sidecar within one flush, no restart.', { fill: C.dim, size: 9.6 });
  b += legend(32, 614, [...L('node', 'rust'), [C.dim, 'Edge mode only']]);
  write('internal-seams.svg', svg(W, H, b));
}

/* ── 6 · stream request flow ────────────────────────────────────────────── */
{
  const W = 940, H = 1056;
  let b = header(W, 'How a stream request flows', 'streamGate → relay → masq-proxy');

  const p = card({ x: 250, y: 92, w: 340, rail: C.ash, title: 'Player', sub: ['GET /api/ext/v1/<source>/<enc-url>', '?token=…  &  ?pl=…'] });
  const g = card({ x: 250, y: 196, w: 340, rail: C.teal, title: 'streamGate', sub: ['valid token? user enabled?', "source in the user's allow-list?"] });
  const x = card({ x: 672, y: 196, w: 228, rail: C.risk, title: '401 / 403', sub: ['plain text, so a media', 'player surfaces the reason'] });
  const r = card({ x: 250, y: 306, w: 340, rail: C.teal, title: 'proxyRelay', sub: ['→ 127.0.0.1:8787', 'inject client identity + secret'] });
  const res = card({ x: 40, y: 505, w: 300, rail: C.teal, title: 'resolve seam → grant', sub: ['masterUrl · upstreamHeaders', 'allowHosts · proxyConfig'] });
  const f = card({ x: 250, y: 615, w: 340, rail: C.amber, title: 'fetch upstream', sub: ['retry 502 / 503 / 504 · mirror failover', 'failover-group walk'] });
  const rw = card({ x: 40, y: 824, w: 320, rail: C.amber, title: 'rewrite child URIs', sub: ['re-embed token + pl', 'grow the SSRF allow-set'], minH: 70.8 });
  const seg = card({ x: 500, y: 824, w: 340, rail: C.amber, title: 'relabel + pipe bytes', sub: ['bounded read-ahead buffer'], minH: 70.8 });
  const out = card({ x: 250, y: 934, w: 340, rail: C.ash, title: 'bytes → player', sub: ['durable HLS / raw-TS pipe'] });

  b += edge([[420, 163], [420, 195]], { color: 'ash' });
  b += edge([[591, 232], [670, 232]], { color: 'risk', dash: '4 3', r: 0 });
  b += edge([[420, 267], [420, 305]], { color: 'teal' });
  b += edge([[420, 377], [420, 401]], { color: 'teal' });
  b += edge([[420, 470], [420, 487], [190, 487], [190, 504]], { color: 'teal' });
  b += edge([[520, 436], [720, 436], [720, 650], [592, 650]], { color: 'amber' });
  b += edge([[190, 576], [190, 596], [420, 596], [420, 614]], { color: 'teal' });
  b += edge([[420, 686], [420, 713]], { color: 'amber' });
  b += edge([[300, 748], [200, 748], [200, 823]], { color: 'amber' });
  b += edge([[540, 748], [670, 748], [670, 823]], { color: 'amber' });
  b += edge([[200, 895], [200, 914], [420, 914], [420, 933]], { color: 'amber' });
  b += edge([[670, 895], [670, 914], [420, 914], [420, 933]], { color: 'amber' });

  b += diamond(420, 436, 200, 68, 'ENTRY or HOP?', { color: C.ash });
  b += diamond(420, 748, 240, 68, 'manifest or segment?', { color: C.ash });
  b += p.svg + g.svg + x.svg + r.svg + res.svg + f.svg + rw.svg + seg.svg + out.svg;

  b += pill(631, 232, 'deny', { color: C.risk });
  b += pill(420, 286, 'allow', { color: C.teal });
  b += pill(300, 487, 'ENTRY', { color: C.teal });
  b += pill(720, 540, 'HOP', { color: C.amber });
  b += pill(200, 785, 'manifest', { color: C.amber });
  b += pill(670, 785, 'segment', { color: C.amber });

  b += legend(32, 1022, L('client', 'node', 'rust', 'deny'));
  write('stream-request-flow.svg', svg(W, H, b));
}

/* ── 7 + 8 · topologies (identical skeletons so the inversion reads at a glance) ── */
const topology = ({ file, title, subtitle, laneLabel, laneColor, left, right, edges, caption }) => {
  const W = 880, H = 500;
  let b = header(W, title, subtitle);
  b += lane({ x: 40, y: 200, w: 800, h: 220, label: laneLabel, color: laneColor });
  const client = card({ x: 280, y: 84, w: 320, rail: C.ash, title: 'Clients', sub: ['public :3000 · DOMAIN unchanged'] });
  const lc = card({ x: 60, y: 232, w: 280, rail: left.rail, title: left.title, sub: left.sub, minH: 85.2 });
  const rc = card({ x: 540, y: 232, w: 280, rail: right.rail, title: right.title, sub: right.sub, minH: 85.2 });
  const ln = card({ x: 60, y: 344, w: 280, rail: C.dim, dashed: true, fill: C.carbon, title: left.note.title, sub: left.note.sub });
  const rn = card({ x: 540, y: 344, w: 280, rail: C.dim, dashed: true, fill: C.carbon, title: right.note.title, sub: right.note.sub });
  for (const e of edges) b += edge(e.pts, { color: e.color, dash: e.dash });
  b += client.svg + lc.svg + rc.svg + ln.svg + rn.svg;
  for (const e of edges) b += pill(e.px, e.py, e.label, { color: e.pc || C.ash });
  b += text(W / 2, 450, caption, { fill: C.dim, size: 9.8, anchor: 'middle' });
  b += legend(32, 478, L('client', 'node', 'rust'));
  write(file, svg(W, H, b));
};

topology({
  file: 'topology-default.svg',
  title: 'Default topology — Node is the front door', subtitle: 'MASQ_EDGE unset',
  laneLabel: 'MASQ_EDGE OFF — DEFAULT', laneColor: C.teal,
  left: {
    rail: C.teal, title: 'Node — public front door', sub: ['0.0.0.0:3000', 'SPA · /api/* · WS · gate · relay'],
    note: { title: 'Token gate', sub: ['Express middleware', 'strictly per-request revocation'] },
  },
  right: {
    rail: C.amber, title: 'masq-proxy — loopback sidecar', sub: ['127.0.0.1:8787', '/health · /probe · stream engine'],
    note: { title: 'Blast radius', sub: ['critical-path for streaming only', 'a crash pauses playback, nothing else'] },
  },
  edges: [
    { pts: [[440, 141], [440, 172], [260, 172], [260, 231]], color: 'ash', label: 'all traffic · :3000', px: 350, py: 172 },
    { pts: [[341, 256], [538, 256]], color: 'teal', label: 'relay stream bytes', px: 440, py: 256, pc: C.teal },
    { pts: [[539, 294], [342, 294]], color: 'amber', label: 'seams · loopback', px: 440, py: 294, pc: C.amber },
  ],
  caption: 'Every streamed byte is handled twice — Rust → Node → client.',
});

topology({
  file: 'topology-edge.svg',
  title: 'Edge topology — Rust is the front door', subtitle: 'MASQ_EDGE=1',
  laneLabel: 'MASQ_EDGE=1 — INVERTED', laneColor: C.amber,
  left: {
    rail: C.amber, title: 'masq-proxy — public edge', sub: ['0.0.0.0:3000', 'serves /api/v1 + /api/ext/v1', 'in-process · token-gated'],
    note: { title: 'loopback :8787', sub: ['/health · /probe · unchanged', 'the probe scheduler keeps working'] },
  },
  right: {
    rail: C.teal, title: 'Node — internal', sub: ['127.0.0.1:8080', 'SPA · /api/* · WS', 'control plane'],
    note: { title: 'Token gate', sub: ['Rust auth cache · 30s TTL', 'inbound x-masq-* ignored'] },
  },
  edges: [
    { pts: [[400, 141], [400, 162], [250, 162], [250, 231]], color: 'ash', label: 'stream mounts', px: 325, py: 162 },
    { pts: [[480, 141], [480, 188], [300, 188], [300, 231]], color: 'ash', label: 'SPA · /api/* · .m3u · WS', px: 390, py: 188 },
    { pts: [[341, 260], [538, 260]], color: 'amber', label: 'reverse-proxy · WS splice', px: 440, py: 260, pc: C.amber },
    { pts: [[341, 298], [538, 298]], color: 'teal', dash: '4 3', label: 'authorize · 30s TTL', px: 440, py: 298, pc: C.teal },
  ],
  caption: "Rust owns the public socket — Node's event loop leaves the byte path.",
});

/* ── 2 · adapter taxonomy ───────────────────────────────────────────────── */
{
  const W = 800;
  const SLOT = [52, 290, 528], CW = 220, GAP = 18;
  const spanW = (n) => CW * n + GAP * (n - 1);

  // one hue per adapter shape; identity gets mist (not dim) so its ids stay legible
  const G = { syn: C.ash, auth: C.risk, scrape: C.green, sentinel: C.teal, macro: C.amber, ident: C.mist };

  const glossary = (x, y, w, items) => {
    let cx = x, cy = y, out = '';
    for (const [term, def] of items) {
      const bw = measure(term, 8.4, true) + 15, dw = measure(def, 9.2) + 20;
      if (cx > x && cx + bw + 6 + dw > x + w) { cx = x; cy += 21; }
      out += `<rect x="${cx}" y="${cy - 11}" width="${bw}" height="16" rx="5" fill="${C.ash}" fill-opacity="0.09" stroke="${C.ash}" stroke-opacity="0.3"/>`
        + text(cx + bw / 2, cy, term, { fill: C.ash, size: 8.4, mono: true, anchor: 'middle', ls: 0.3 })
        + text(cx + bw + 7, cy, def, { fill: C.dim, size: 9.2 });
      cx += bw + 7 + dw;
    }
    return { svg: out, bottom: cy };
  };

  const A = (id, label, sub, badges, color) => ({ id, label, sub, badges, color });
  const N = (title, sub, span = 1) => ({ note: true, title, sub, span });

  const rowsOf = (items) => {
    const rows = []; let row = [], used = 0;
    for (const it of items) {
      const s = it.span || 1;
      if (used + s > 3) { rows.push(row); row = []; used = 0; }
      row.push(it); used += s;
    }
    if (row.length) rows.push(row);
    return rows;
  };

  const renderRows = (y, items, color) => {
    let cy = y, out = '';
    for (const row of rowsOf(items)) {
      const h = Math.max(...row.map((it) => cardHeight({ sub: it.sub, badges: it.badges || [] })));
      let slot = 0;
      for (const it of row) {
        const w = spanW(it.span || 1);
        out += card({
          x: SLOT[slot], y: cy, w, minH: h, rail: it.note ? C.dim : it.color,
          dashed: !!it.note, fill: it.note ? C.carbon : C.card,
          title: it.note ? it.title : it.id, titleMono: !it.note,
          titleColor: it.note ? C.ash : (it.color || color),
          titleRight: it.note ? null : it.label,
          sub: it.sub, badges: it.badges || [],
        }).svg;
        slot += it.span || 1;
      }
      cy += h + 14;
    }
    return { svg: out, bottom: cy - 14 };
  };

  const band = (y, { label, color, desc, items }) => {
    const inner = renderRows(y + 40, items, color);
    const h = inner.bottom - y + 18;
    return { svg: lane({ x: 34, y, w: 732, h, label, color }) + text(52, y + 25, desc, { fill: C.dim, size: 9.4 }) + inner.svg, bottom: y + h };
  };

  const tier = (y, label, desc, color) => {
    const lw = label.length * (10.5 * 0.66 + 1.6);
    const dx = 48 + lw + 16;
    return `<rect x="34" y="${y - 9}" width="4" height="14" rx="2" fill="${color}"/>`
      + text(48, y + 3, label, { fill: C.mist, size: 10.5, weight: 700, ls: 1.6 })
      + text(dx, y + 3, desc, { fill: C.dim, size: 9.4 })
      + `<line x1="${dx + desc.length * 5.2 + 14}" y1="${y - 2}" x2="766" y2="${y - 2}" stroke="${C.steel}" stroke-width="1"/>`;
  };

  const rule = (y, label, color) => {
    const lw = label.length * (9 * 0.62 + 1.2) + 24;
    return `<line x1="34" y1="${y}" x2="766" y2="${y}" stroke="${C.steel}" stroke-width="1" stroke-dasharray="4 4"/>`
      + `<rect x="34" y="${y - 8}" width="${lw}" height="16" rx="5" fill="${C.bg}" stroke="${C.bracket}"/>`
      + text(34 + lw / 2, y + 3.4, label, { fill: color, size: 9, weight: 600, anchor: 'middle', ls: 1.2 });
  };

  let b = header(W, 'Channel adapter architecture — pluggable sources', 'server/src/sources/registry.ts');
  b += card({
    x: 240, y: 84, w: 320, rail: C.teal, titleMono: true, title: 'registry.ts',
    sub: ['SOURCES: SourceAdapter[]', 'the generic core never branches per source'],
  }).svg;

  let y = 190;
  b += tier(y, 'SYNTHETIC', 'proxy-only · no catalog · no shell row · manifest omits', C.ash);
  const syn = renderRows(y + 20, [
    A('direct', 'Imported', ['identity resolveStream', 'any https upstream allowed'], ['NO SHELL', 'PASSTHRU'], G.syn),
    A('hdhomerun', 'HDHomeRun', ['local OTA / cable tuner', 'lineup import · playback dormant'], ['NO SHELL', 'NEEDS REMUX'], G.syn),
    A('local', 'Local Now', ['localnow://id?slug sentinel', '→ rotating CDN master'], ['NO SHELL', 'DYN SSRF'], G.syn),
  ], G.syn);
  b += syn.svg; y = syn.bottom + 42;

  b += tier(y, 'BUILT-IN', 'syncable catalog · Provision → Sync now → playlistchannels', C.teal);
  y += 34;
  b += rule(y, 'AUTHENTICATED · requiresAuth', C.risk); y += 20;
  const au = renderRows(y, [
    A('dulo', 'dulo.tv', ['Supabase session + device fp', 'captured via headful Chromium', 'dulo://channel/id → playbackUrl'], ['AUTH', 'XWALK', 'DYN SSRF'], G.auth),
    N('Gracenote crosswalk only', ['dulo publishes no guide of its own — its channels link to the', 'Gracenote EPG source through the Mapping screen. It is the only', 'adapter with a credential-capture surface (DuloLoginDrawer).'], 2),
  ], G.auth);
  b += au.svg; y = au.bottom + 30;

  b += rule(y, 'ANONYMOUS · no auth surface', C.dim); y += 22;

  for (const spec of [
    {
      label: 'SCRAPE-BASED', color: G.scrape, desc: 'catalog from HTML / a rotating mirror · resolution via multi-hop scrape',
      items: [
        A('dlhd', 'DaddyLive', ['scraped rotating-mirror HTML', 'watch.php?id → 3-hop Referer', 'segments disguised img / pdf'], ['SELF-EPG', 'XWALK', '18+ OFF'], G.scrape),
        A('dami', 'Dami.TV', ['own catalog · /papi/api/streams', '~878 ch · ISO country groups', 'reuses dlhd resolveStream'], ['SELF-EPG', 'XWALK'], G.scrape),
        N('Hard dependency', ['dami leans on dlhd’s mirror', 'and resolve leaves — the two', 'can never be forked apart']),
      ],
    },
    {
      label: 'API SENTINEL', color: G.sentinel, desc: 'catalog stores an opaque sentinel · one API call per play · dynamic SSRF allow-set',
      items: [
        A('tubi', 'Tubi.TV', ['tubi://channel/id', '→ Tubi API per play', 'programs[] on raw catalog rows'], ['SELF-EPG'], G.sentinel),
        A('xumo', 'Xumo Play', ['broadcast.json sentinel', '→ 3-hop API resolve', 'paginated market guide'], ['SELF-EPG'], G.sentinel),
        A('stirr', 'STIRR', ['/playable sentinel', '→ 1-hop POST per play', 'two-tier per-channel guide'], ['SELF-EPG'], G.sentinel),
        A('tcl', 'TCL TV+', ['format-stream-url sentinel', '→ 1-hop POST per play', 'category + batched detail'], ['SELF-EPG'], G.sentinel),
        A('pluto', 'Pluto TV', ['pluto://region/id', 'region boot (cached) + URL', 'per-region timelines guide'], ['SELF-EPG', 'XWALK'], G.sentinel),
        A('roku', 'The Roku Channel', ['roku://id', 'session boot (cached) + playId', 'content-proxy fanout guide'], ['SELF-EPG'], G.sentinel),
      ],
    },
    {
      label: 'MACRO-FILL', color: G.macro, desc: 'catalog stores an HLS URL with macro slots · filled per play · dynamic SSRF allow-set',
      items: [
        A('samsung', 'Samsung TV Plus', ['jmp2.uk redirect → CDN master', 'follow redirect per play'], ['SELF-EPG', 'XWALK'], G.macro),
        A('lg', 'LG Channels', ['HLS URL with {MACRO} slots', 'macro expand per play'], ['SELF-EPG'], G.macro),
        A('whale', 'Whale TV+', ['HLS URL with macro slots', 'separate /epg fetch (Vidaa)'], ['SELF-EPG'], G.macro),
        A('distro', 'Distro TV', ['__MACRO__ VAST slots', 'tvg_id-keyed self-EPG'], ['SELF-EPG'], G.macro),
        A('freelivesports', null, ['device / cb / ref macro slots', 'inline program self-EPG'], ['SELF-EPG'], G.macro),
        N('Macro slots', ['device ids, cache-busters and', 'VAST refs — never persisted']),
      ],
    },
    {
      label: 'IDENTITY / DIRECT', color: G.ident, desc: 'catalog already carries the real HLS master · resolveStream is identity + host pre-allow',
      items: [
        A('vizio', 'Vizio WatchFree+', ['channelUrls[0] IS the master', 'EPG: /api/airings schedule'], ['SELF-EPG', 'PRE-ALLOW'], G.ident),
        A('vidaa', 'Vidaa Free TV', ['macros expanded at catalog time', 'self-EPG via uid'], ['SELF-EPG', 'XWALK', 'PRE-ALLOW'], G.ident),
        N('Still on the seam', ['identity sources resolve through', 'the same seam — stream URLs are', 'never stored on disk']),
      ],
    },
  ]) {
    const r = band(y, spec);
    b += r.svg; y = r.bottom + 30;
  }

  const gl = glossary(34, y + 10, 732, [
    ['SELF-EPG', 'adapter.afterSync() writes its own guide'],
    ['XWALK', 'Gracenote crosswalk wired'],
    ['DYN SSRF', 'allow-set grown at resolve time'],
    ['PRE-ALLOW', 'static upstream host allow'],
    ['NO SHELL', 'no Playlist shell row'],
    ['NEEDS REMUX', 'catalog import only · playback dormant'],
  ]);
  b += gl.svg;
  b += legend(34, gl.bottom + 34, [[G.syn, 'Synthetic'], [G.auth, 'Authenticated'], [G.scrape, 'Scrape'], [G.sentinel, 'API sentinel'], [G.macro, 'Macro-fill'], [G.ident, 'Identity']]);
  write('adapter-taxonomy.svg', svg(W, gl.bottom + 58, b));
}
