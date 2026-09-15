// DaddyLive hop-2 extractor self-check — the unit gate for adapters/dlhd/embedExtractors.ts.
//
// Runs one SYNTHETIC page per embed family through extractMasterUrls (offline, no network) and asserts the
// family's playlist URL comes out FIRST, from the expected extractor, in bounded time. The pages are built here
// from each family's documented shape (see the extractor comments), never copied from a provider, so they carry
// no live tokens and can be committed. `--dir` runs real captured pages instead, which DO carry signed URLs —
// keep those out of the repo.
//
// Usage (from server/):  tsx scripts/dlhd-extractor-check.ts             (offline unit gate)
//                        tsx scripts/dlhd-extractor-check.ts --dir <path> (print candidates for every *.html)

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractMasterUrls } from '../src/sources/adapters/dlhd/embedExtractors.js';

const URL_ = 'https://edge7.cdn.example/hls/abc123.m3u8?s=SIGNATURE&e=1789000000';
const PAGE = 'https://embed.example/e/abc123';
const BUDGET_MS = 250;

const b64 = (s: string): string => Buffer.from(s, 'latin1').toString('base64');
const b64url = (s: string): string => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The `_econfig` chunk shuffle, ENCODE side: JSON → base64 → N equal parts → each part base64'd with a junk
// character at index K → laid out so that decoding chunk i lands at ORDER[i] → base64 of the whole. The JSON is
// padded so every part is the same whole number of base64 triplets, as the equal-chunk decode requires.
function shuffle(config: object, n: number, k: number, order: number[]): string {
  let json = JSON.stringify(config);
  while (b64(json).length % (n * 4) !== 0) json += ' ';
  const text = b64(json);
  const size = text.length / n;
  const parts = Array.from({ length: n }, (_, i) => text.slice(i * size, (i + 1) * size));
  const chunks = order.map((slot) => {
    const enc = b64(parts[slot]);
    return enc.slice(0, k) + 'Q' + enc.slice(k);
  });
  return b64(chunks.join(''));
}

const filler = { swarm_id: 'xs_abc123', p2p: true, pops: ['x'.repeat(1500)], hframes: ['', 'https://ads.example/x'] };

const XOR = 210;
const SUB = 84;
const xorJs = `var SIGNED_URL = "${URL_}"; jwplayer("p").setup({ file: SIGNED_URL });`;
const xorBytes = [...xorJs].map((c) => ((c.charCodeAt(0) + SUB) % 256) ^ XOR);

const head = URL_.split('?')[0];
const tail = `?${URL_.split('?')[1]}`;
const parts = [URL_.slice(0, 30), URL_.slice(30, 60), URL_.slice(60)];

const FAMILIES: Array<{ name: string; extractor: string; html: string }> = [
  { name: 'daddy premiumtv (atob)', extractor: 'base64', html: `<script>var src = window.atob('${b64(URL_)}');</script>` },
  {
    name: 'econfig, stream.js v0.0.26 layout (N=4 K=3 [2,0,3,1])',
    extractor: 'shuffledConfig',
    html: `<script id="config">window._econfig='${shuffle({ ...filler, stream_url: URL_ }, 4, 3, [2, 0, 3, 1])}';</script>`,
  },
  {
    name: 'econfig, rotated layout (N=5 K=1 [4,2,0,1,3])',
    extractor: 'shuffledConfig',
    html: `<script>window._cfg="${shuffle({ ...filler, stream_url: URL_ }, 5, 1, [4, 2, 0, 1, 3])}";</script>`,
  },
  {
    name: 'XOR byte-array eval',
    extractor: 'xorEval',
    html:
      `<script>var _a=[${xorBytes.join(',')}],_b=${XOR},_c=${SUB},_d="",_i;` +
      `for(_i=0;_i<_a.length;_i++){_d+=String.fromCharCode(((_a[_i] ^ _b) - _c + 256) % 256);}window["ev"+"al"](_d);</script>`,
  },
  {
    name: 'p.a.c.k.e.d',
    extractor: 'packed',
    html: `<script>eval(function(p,a,c,k,e,d){return p}('0 1="2://3.4/5/6.7?8"',10,9,'var|src|https|edge7|cdn.example|hls|abc123|m3u8|s=SIGNATURE&e=1789000000'.split('|'),0,{}))</script>`,
  },
  {
    name: 'chunked atob (cdnlivetv)',
    extractor: 'chunkedAtob',
    html:
      `<script>function dq(s){return atob(s.replace(/-/g,'+').replace(/_/g,'/'))}` +
      `var k1='${b64url(parts[0])}';var k2='${b64url(parts[1])}';var k3='${b64url(parts[2])}';` +
      `var src=dq(k1)+dq(k2)+dq(k3); var _p2pMode=true;</script>`,
  },
  {
    name: 'char array + element text (igniteandship)',
    extractor: 'charArrayJoin',
    html:
      `<span id="tk" style="display:none">${tail}</span><script>function gs() {` +
      `return(["${[...head].map((c) => (c === '/' ? '\\/' : c)).join('","')}"].join("") + document.getElementById("tk").innerHTML);` +
      `} player.load({source: gs()});</script>`,
  },
  { name: 'hex escapes', extractor: 'hexEscape', html: `<script>var u="${[...URL_].map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')}";</script>` },
  { name: 'escaped slashes (wideiptv)', extractor: 'plaintext', html: `<script>const cfg = { channelSlug: "abc", streamUrl: "${URL_.replace(/\//g, '\\/')}" };</script>` },
  {
    name: 'decoy .m3u8 in clear + the real one in a config → the decoded one ranks first',
    extractor: 'shuffledConfig',
    html:
      `<script>var preroll="https://ads.example/pre.m3u8";</script>` +
      `<script>window._econfig='${shuffle({ ...filler, stream_url: URL_ }, 4, 3, [2, 0, 3, 1])}';</script>`,
  },
];

const NEGATIVES: Array<{ name: string; html: string }> = [
  { name: 'domain-locked 403 page', html: '<h1>403 - Access Denied</h1><p>This content is not available on your domain.</p>' },
  { name: 'script-built iframe', html: `<script>var code = '<iframe src="' + window.location.href + '"></iframe>';</script>` },
  { name: 'long base64 that is not a config', html: `<script>var x='${b64('z'.repeat(3000))}';</script>` },
];

function unitGate(): void {
  let failed = 0;
  const report = (ok: boolean, line: string): void => {
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`);
  };
  for (const f of FAMILIES) {
    const t = performance.now();
    const got = extractMasterUrls(f.html, PAGE);
    const ms = performance.now() - t;
    const first = got[0];
    const ok = first?.url === URL_ && first.extractor === f.extractor && ms < BUDGET_MS;
    report(ok, `${f.name} — ${first ? `${first.extractor} → ${first.url === URL_ ? 'the URL' : first.url}` : 'nothing'} (${ms.toFixed(0)} ms)`);
  }
  for (const n of NEGATIVES) {
    const got = extractMasterUrls(n.html, PAGE);
    report(got.length === 0, `${n.name} — ${got.length ? got.map((c) => `${c.extractor}: ${c.url}`).join(', ') : 'no candidates'}`);
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
}

function runDir(dir: string): void {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.html')).sort()) {
    const html = readFileSync(join(dir, f), 'utf8');
    const t = performance.now();
    const got = extractMasterUrls(html, PAGE);
    console.log(`${f}  (${html.length} B, ${(performance.now() - t).toFixed(0)} ms)`);
    for (const c of got) console.log(`   ${c.extractor.padEnd(15)} ${c.url}`);
    if (!got.length) console.log('   — no candidates');
  }
}

const dirArg = process.argv.indexOf('--dir');
if (dirArg !== -1 && process.argv[dirArg + 1]) runDir(process.argv[dirArg + 1]);
else unitGate();
