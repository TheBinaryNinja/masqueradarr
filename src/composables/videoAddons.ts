// externalPlayer "Addons" — the CLIENT display catalog (the picker chips). Behavior lives server-side in
// server/src/videoconfig/addonCatalog.ts; the two are keyed by the same lowercase ids (the id string is the
// contract, mirroring the videoPresets.ts / DEFAULT_*_ARGS split). This file is display-only: label, help
// copy, the output modes the addon applies to (greys the chip otherwise), and a human-readable preview of the
// flags it adds. Selecting chips is MULTI-SELECT (a videoconfig.addons string[]); the server composes the
// actual ffmpeg flag-splices on top of advancedArgs at spawn time.
//
// Keep ids + appliesTo in sync with addonCatalog.ts when adding/removing an addon.

export interface VideoAddon {
  id: string; // MUST match a server AddonDef.id (lowercase)
  label: string; // chip text
  description: string; // tooltip / help copy
  appliesTo: ('hls' | 'ts')[]; // greys the chip when it excludes the current Output mode
  flagsPreview: string; // human-readable "what it adds" (the read-only effective-flags line)
}

export const VIDEO_ADDONS: VideoAddon[] = [
  {
    id: 'persistent-http-off',
    label: 'Persistent HTTP off',
    description:
      'Force a fresh HTTP connection per segment. Fixes SSAI ad breaks where the feed switches CDN host ' +
      "mid-stream (ffmpeg's “Cannot reuse HTTP connection for different host”). Near-zero cost — recommended " +
      'for ad-supported sources (Tubi, Pluto, …).',
    appliesTo: ['hls', 'ts'],
    flagsPreview: '-http_persistent 0 -http_multiple 0',
  },
  {
    id: 'segment-resilience',
    label: 'Segment resilience',
    description:
      'Retry failed segment / connection fetches instead of dropping the stream. Helps flaky upstreams and ' +
      'the transient errors around an ad splice.',
    appliesTo: ['hls', 'ts'],
    flagsPreview: '-seg_max_retry 3 -reconnect_on_network_error 1 -reconnect_max_retries 8',
  },
  {
    id: 'discontinuity-tolerance',
    label: 'Discontinuity tolerance',
    description:
      'Tolerate timestamp / discontinuity jumps at ad splices under stream-copy (ignore & discard corrupt ' +
      'input timestamps, re-base the output timeline). Experimental — if the picture still freezes on ad ' +
      'breaks, switch to the “Normalize (ad-splice safe)” transcode preset above (the guaranteed fix).',
    appliesTo: ['hls', 'ts'],
    flagsPreview: '-fflags +igndts+discardcorrupt -avoid_negative_ts make_zero -max_muxing_queue_size 1024',
  },
];
