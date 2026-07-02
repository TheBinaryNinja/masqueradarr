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
  // Extra ffmpeg INPUT options (flag/value pairs) to insert before -i — driven by the videoconfig "ExtPicky
  // Override" toggle (['-extension_picky','0'] so disguised-extension segments like dlhd's .js/.jpg parse) AND
  // the selected addons' inputFlags (persistent-http-off / segment-resilience; addonCatalog.ts). The route
  // concatenates them; this builder inserts each flag/value PAIR unless its flag is already set in advancedArgs
  // (per-flag skip, so the operator's value wins). Empty/absent ⇒ nothing added.
  inputArgs?: string[];
  // Addon `-fflags` flag NAMES (e.g. ['genpts','igndts','discardcorrupt'] for discontinuity-tolerance) to MERGE
  // into the single -fflags token (union with the base preset's flags, usually +genpts) — never a second
  // -fflags. Absent/empty ⇒ nothing merged.
  fflags?: string[];
  // Addon OUTPUT/muxer options (flag/value pairs, e.g. ['-avoid_negative_ts','make_zero','-max_muxing_queue_size','1024']
  // for discontinuity-tolerance) inserted at the START of the output-options section (right after `-i <url>`),
  // per-flag skip-if-operator-set. Binds to the operator's real output; the freezedetect tap is unaffected.
  outputArgs?: string[];
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

  // (b2) ffmpeg INPUT options before -i (flag/value pairs) — dlhd's -extension_picky 0 (ExtPicky Override) plus
  // the selected addons' inputFlags. PER-FLAG skip: insert a pair only when its flag isn't already in
  // advancedArgs (so an operator value always wins, and a multi-addon set isn't dropped wholesale because one
  // flag happened to be set). Flags are even-indexed tokens; values odd.
  if (ctx.inputArgs?.length && argv.includes('-i')) {
    const add: string[] = [];
    for (let k = 0; k + 1 < ctx.inputArgs.length; k += 2) {
      const flag = ctx.inputArgs[k];
      if (!argv.includes(flag)) add.push(flag, ctx.inputArgs[k + 1]);
    }
    if (add.length) argv.splice(argv.indexOf('-i'), 0, ...add);
  }

  // (b4) merge addon -fflags (e.g. igndts+discardcorrupt for discontinuity-tolerance) into the SINGLE -fflags
  // token — union with the base preset's flags (usually +genpts), dedup, never a second -fflags. If the base
  // has no -fflags, insert one before -i.
  if (ctx.fflags?.length) {
    const fIdx = argv.indexOf('-fflags');
    if (fIdx >= 0 && fIdx + 1 < argv.length) {
      const have = argv[fIdx + 1].split('+').filter(Boolean);
      for (const f of ctx.fflags) if (!have.includes(f)) have.push(f);
      argv[fIdx + 1] = '+' + have.join('+');
    } else if (argv.includes('-i')) {
      argv.splice(argv.indexOf('-i'), 0, '-fflags', '+' + [...new Set(ctx.fflags)].join('+'));
    }
  }

  // (b5) addon OUTPUT/muxer flags inserted at the START of the output-options section (right after `-i <url>`),
  // per-flag skip-if-operator-set. Binds to the operator's real (first) output; the freezedetect tap (step c,
  // appended AFTER the whole argv with its own options) is unaffected.
  if (ctx.outputArgs?.length && argv.includes('-i')) {
    const add: string[] = [];
    for (let k = 0; k + 1 < ctx.outputArgs.length; k += 2) {
      const flag = ctx.outputArgs[k];
      if (!argv.includes(flag)) add.push(flag, ctx.outputArgs[k + 1]);
    }
    if (add.length) argv.splice(argv.indexOf('-i') + 2, 0, ...add);
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
