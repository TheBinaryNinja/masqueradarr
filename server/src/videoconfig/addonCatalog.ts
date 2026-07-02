// externalPlayer "Addons" — the SERVER source of truth for addon BEHAVIOR (the client display catalog lives in
// src/composables/videoAddons.ts, keyed by the same lowercase ids; the id string is the contract between them,
// mirroring the videoPresets.ts / DEFAULT_*_ARGS split). An addon is an ADDITIVE, copy-compatible, order-
// independent ffmpeg flag splice composed ON TOP of the operative advancedArgs at spawn time. Adding a future
// addon = one AddonDef entry.
//
// Each addon's mutation is structured into THREE buckets matching the three placement sites in
// engineArgs.buildFfmpegArgv: input flags (before -i), fflags (merged into the single -fflags token), and
// output/muxer flags (after -i, in the output section). composeAddonArgs() collects every selected addon's
// mutation (in REGISTRY order, so the resulting argv is deterministic regardless of the order chips were
// toggled) and filters by the current output mode. Every splice is per-flag skip-if-already-present in
// buildFfmpegArgv, so an operator flag in advancedArgs always wins — advancedArgs stays authoritative.

export type VideoOutput = 'hls' | 'ts';

// A structured, additive mutation. NOT a "transform" — an addon may never replace the codec / rewrite the
// pipeline (that is the Normalize transcode PRESET, not an addon — see .claude/plans/videoconfig-addons.md §4).
export interface AddonArgMutation {
  inputFlags?: string[]; // inserted BEFORE -i (flag/value pairs), per-flag skip-if-operator-set
  fflags?: string[]; // flag NAMES merged into the single -fflags token (e.g. 'igndts', 'discardcorrupt')
  outputFlags?: string[]; // inserted in the OUTPUT section after -i (flag/value pairs), per-flag skip
}

export interface AddonDef {
  id: string; // lowercase, stable — the persisted value + client contract (repo LOWERCASE rule)
  appliesTo: VideoOutput[]; // output modes the addon is valid for (['hls','ts'] = both)
  mutation: AddonArgMutation;
  conflicts?: string[]; // ids that cannot be co-selected (none in v1; shape reserved)
  requires?: string[]; // ids that must also be selected (none in v1; shape reserved)
}

// The initial addon set — the confirmed ad-break resilience fixes (see the plan's Investigation basis). All
// default OFF (opt-in): VideoConfig.addons seeds []. The upstream INPUT is HLS regardless of our output, and
// the muxer flags apply to either output, so all three appliesTo both.
export const VIDEO_ADDONS: AddonDef[] = [
  {
    // Finding #1 — PROVEN: SSAI ad splices switch the segment host (content CDN → ad CDN); ffmpeg's HLS
    // demuxer default (http_persistent=1) then errors "Cannot reuse HTTP connection for different host".
    // Forcing a fresh connection per segment eliminates it (captured: 8 host-mismatch errors → 0).
    id: 'persistent-http-off',
    appliesTo: ['hls', 'ts'],
    mutation: { inputFlags: ['-http_persistent', '0', '-http_multiple', '0'] },
  },
  {
    // Option 2 — ride transient segment/connection errors at the splice instead of stalling (seg reload +
    // reconnect on network error, bounded retries).
    id: 'segment-resilience',
    appliesTo: ['hls', 'ts'],
    mutation: { inputFlags: ['-seg_max_retry', '3', '-reconnect_on_network_error', '1', '-reconnect_max_retries', '8'] },
  },
  {
    // Finding #2 / Option 3 — EXPERIMENTAL (needs the live-break A/B before we trust it rides the splice). The
    // ad content's discontinuous DTS makes the muxer flag "Packet corrupt" and freeze out_time under -c copy;
    // ignoring/discarding the bad input timestamps + re-basing the output timeline is the copy-path smoother.
    // If it still freezes, the guaranteed fix is the "Normalize (ad-splice safe)" transcode PRESET.
    id: 'discontinuity-tolerance',
    appliesTo: ['hls', 'ts'],
    mutation: {
      fflags: ['genpts', 'igndts', 'discardcorrupt'],
      outputFlags: ['-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '1024'],
    },
  },
];

// Validator whitelist (translate.ts drops any id not in this set).
export const ADDON_IDS = new Set(VIDEO_ADDONS.map((a) => a.id));

// Collect the three flag buckets from the selected addon ids for the given output mode. Iterates the REGISTRY
// order (not `selected` order) for a deterministic argv; ignores unknown ids and ids whose appliesTo excludes
// `output`. buildFfmpegArgv does the per-flag skip-if-present + the -fflags merge — this just gathers.
export function composeAddonArgs(
  selected: string[],
  output: VideoOutput,
): { inputFlags: string[]; fflags: string[]; outputFlags: string[] } {
  const set = new Set(selected);
  const inputFlags: string[] = [];
  const fflags: string[] = [];
  const outputFlags: string[] = [];
  for (const def of VIDEO_ADDONS) {
    if (!set.has(def.id) || !def.appliesTo.includes(output)) continue;
    if (def.mutation.inputFlags) inputFlags.push(...def.mutation.inputFlags);
    if (def.mutation.fflags) fflags.push(...def.mutation.fflags);
    if (def.mutation.outputFlags) outputFlags.push(...def.mutation.outputFlags);
  }
  return { inputFlags, fflags, outputFlags };
}
