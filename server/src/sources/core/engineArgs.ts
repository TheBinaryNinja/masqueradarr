// Shared ffmpeg argv builder for the external-player engine — used by both the loopback-HLS engine
// (externalEngine.ts) and the raw-TS passthrough (externalTsEngine.ts). The OPERATIVE config is a single
// ffmpeg arg STRING (videoconfig.ffmpeg.advancedArgs, or a built-in default); spawn (no shell) needs an argv
// ARRAY. This tokenizes the string (double/single-quote aware), substitutes the spawn placeholders
// (<INPUT> <UA> <OUTDIR> <M3U8> <SEG>), and injects two run-time concerns the operator's args don't carry:
//   (a) the `-progress <pipe>` health stream (on the fd the caller picks — pipe:1 for the file-output HLS
//       engine where stdout is free; pipe:3 for the raw-TS engine where stdout carries the TS bytes);
//   (b) a `-headers` input option with the adapter's NON-UA gate headers (Referer/Origin) before the `-i`,
//       since ffmpeg fetches the upstream DIRECTLY (bypassing the proxy) and must clear the adapter's gate.

// freezedetect tuning (fixed globally; env-overridable for power users). `noise` is the change threshold
// (-60dB ≡ ratio 0.001, the ffmpeg default); `durationS` is the minimum frozen span before it reports — a
// built-in debounce. The engine spawns the filter only when freezeDetect is enabled in the videoconfig.
export const FREEZE_NOISE = process.env.EXT_FREEZE_NOISE || '-60dB';
export const FREEZE_DURATION_S = Number(process.env.EXT_FREEZE_DUR || 2);

// Input probe depth (env-overridable). Some live sources (e.g. tubi) expose a mid-GOP live edge whose
// SPS/PPS (video size) + audio sample-rate aren't visible inside ffmpeg's default probe window, so a
// `-c copy` mux fails to write its header ("Could not write header (incorrect codec parameters?)" → exit
// 234). Larger -probesize/-analyzeduration let ffmpeg resolve the params before muxing. Injected before
// -i, per-flag, unless the operator already set it in advancedArgs.
export const PROBE_SIZE = process.env.EXT_PROBESIZE || '10M';
export const ANALYZE_DURATION = process.env.EXT_ANALYZEDURATION || '10M';

// Tokenize an arg string into an argv array with quote awareness (quotes group spaces, then are stripped).
// No backslash-escape handling — the temp paths + URLs the placeholders carry don't need it; this is
// admin-only config (requireAdmin).
export function tokenizeArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false; // whether cur is a real (possibly empty) token, e.g. from ""
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (has || cur) {
        out.push(cur);
        cur = '';
        has = false;
      }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

// Per-token substring replace, so a token like "<OUTDIR>/seg_%05d.ts" expands correctly.
export function substitute(token: string, map: Record<string, string>): string {
  let t = token;
  for (const [k, v] of Object.entries(map)) t = t.split(`<${k}>`).join(v);
  return t;
}

export interface BuildArgvContext {
  placeholders: Record<string, string>; // <KEY> substitutions (INPUT/UA/OUTDIR/M3U8/SEG, engine-dependent)
  headers: Record<string, string>; // adapter upstream headers (User-Agent is skipped — carried by -user_agent)
  progressPipe?: string; // fd for -progress (default pipe:1; raw-TS uses pipe:3 to keep stdout for TS bytes)
  statsPeriodS?: number; // -stats_period (default 1)
  // Extra ffmpeg INPUT options (flag/value pairs) to insert before -i — currently driven by the videoconfig
  // "ExtPicky Override" toggle (['-extension_picky','0'] so disguised-extension segments like dlhd's .js/.jpg
  // parse). Source-agnostic: the route decides the value; this builder just injects it (skipping any flag the
  // operator already set in advancedArgs, so their value wins). Empty/absent ⇒ nothing added.
  inputArgs?: string[];
  // When set, append a DECODE-ONLY freezedetect analysis output (`-f null`) that writes freeze metadata to
  // this pipe fd (e.g. 'pipe:3' for the HLS engine, 'pipe:4' for raw-TS). It runs alongside the operator's
  // real output (which may be `-c copy`) — the input decodes once for the tap; the served stream is untouched.
  // ffmpeg-only. Absent ⇒ no tap. Skipped if the operator already put `freezedetect` in their args.
  freezePipe?: string;
}

// Build the ffmpeg argv from the operative args string + spawn context.
export function buildFfmpegArgv(args: string, ctx: BuildArgvContext): string[] {
  const argv = tokenizeArgs(args).map((t) => substitute(t, ctx.placeholders));

  // (b) adapter gate headers before -i (skip UA — handled by -user_agent; skip entirely if user set -headers).
  if (!argv.includes('-headers')) {
    const extra = Object.entries(ctx.headers).filter(([k]) => k.toLowerCase() !== 'user-agent');
    if (extra.length) {
      const value = extra.map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
      const iIdx = argv.indexOf('-i');
      if (iIdx >= 0) argv.splice(iIdx, 0, '-headers', value);
    }
  }

  // (b2) per-source ffmpeg INPUT options before -i (e.g. dlhd's -extension_picky 0 via the ExtPicky Override
  // videoconfig toggle). Inject the whole set unless the operator already set one of its flags in advancedArgs
  // (their value wins, mirroring the -headers/-progress skip-if-present rule). Flags are even-indexed tokens.
  if (ctx.inputArgs?.length) {
    const alreadySet = ctx.inputArgs.some((tok, k) => k % 2 === 0 && argv.includes(tok));
    const iIdx = argv.indexOf('-i');
    if (!alreadySet && iIdx >= 0) argv.splice(iIdx, 0, ...ctx.inputArgs);
  }

  // (b3) deeper input probing before -i (-probesize/-analyzeduration) so sources with a mid-GOP live edge
  // (tubi) get full codec params before the muxer writes its header — otherwise `-c copy` fails with
  // "Could not write header (incorrect codec parameters?)". Per-flag skip if the operator already set it.
  {
    const iIdx = argv.indexOf('-i');
    if (iIdx >= 0) {
      const probe: string[] = [];
      if (!argv.includes('-probesize')) probe.push('-probesize', PROBE_SIZE);
      if (!argv.includes('-analyzeduration')) probe.push('-analyzeduration', ANALYZE_DURATION);
      if (probe.length) argv.splice(iIdx, 0, ...probe);
    }
  }

  // (c) decode-only freezedetect analysis tap as a SECOND output appended at the end (operator's real output
  // already built above). It maps video only (`-map 0:v:0?` optional so audio-only channels don't hard-fail;
  // `-an -sn`), runs `freezedetect` then prints its frame metadata to the dedicated pipe via the `metadata`
  // filter — `file=pipe\\:N` bypasses `-loglevel` (the default `-loglevel error` would otherwise suppress
  // freezedetect's info logs), and the colon inside the URL value is double-escaped (`\\:`, see below) while the
  // option-separator colons in `n=…:d=…` / `mode=print:file=…` are NOT. `-f null -` discards the decoded frames (analysis only). Skipped
  // if the operator already set their own freezedetect.
  const tail: string[] = [];
  if (ctx.freezePipe && !argv.some((t) => t.includes('freezedetect'))) {
    // The filtergraph string is parsed in TWO levels: the outer graph parser strips ONE backslash, then the
    // per-filter args splitter treats `:` as the option separator. So the colon in the pipe URL must reach the
    // inner level as `\:` — which means emitting `\\:` here (a single `\:` is eaten by the outer level, leaving a
    // bare `pipe:N` that the splitter breaks into `file=pipe` + a stray `N` → "No option name near 'N'" → the
    // whole spawn dies with EINVAL/exit 234). Validated on jellyfin-ffmpeg 7.1.4.
    const pipeEsc = ctx.freezePipe.replace(':', '\\\\:');
    const vf = `freezedetect=n=${FREEZE_NOISE}:d=${FREEZE_DURATION_S},metadata=mode=print:file=${pipeEsc}`;
    tail.push('-map', '0:v:0?', '-an', '-sn', '-vf', vf, '-f', 'null', '-');
  }

  // (a) health stream as global options at the front (separate fd from stderr logs → clean to parse).
  const head: string[] = [];
  if (!argv.includes('-progress')) head.push('-progress', ctx.progressPipe ?? 'pipe:1', '-stats_period', String(ctx.statsPeriodS ?? 1));
  return [...head, ...argv, ...tail];
}

// Build the VLC (cvlc) argv from the operative args string + spawn context. VLC's vocabulary differs from
// ffmpeg's: NO -progress (health is cadence-derived — engineHealth.noteProducerAlive), and gate headers can't
// be injected generically. UA rides the args' own `--http-user-agent "<UA>"`; we additionally set
// `--http-referrer` from the adapter's Referer (covers dlhd) when the user didn't already specify it. VLC has
// no generic Origin-header support, so sources gated on Origin (dulo) may fail to authenticate via VLC — a
// documented limitation of the secondary engine. Global options must precede the input MRL, so the referrer is
// prepended.
export function buildVlcArgv(args: string, ctx: { placeholders: Record<string, string>; headers: Record<string, string> }): string[] {
  const argv = tokenizeArgs(args).map((t) => substitute(t, ctx.placeholders));
  const referer = ctx.headers['Referer'] || ctx.headers['referer'];
  if (referer && !argv.some((a) => a.startsWith('--http-referrer') || a.startsWith(':http-referrer'))) {
    argv.unshift(`--http-referrer=${referer}`);
  }
  return argv;
}
