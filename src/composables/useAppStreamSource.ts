import { ref, computed, watch, onBeforeUnmount, type Ref } from 'vue';
import { token } from './useAuth';

// useAppStreamSource — the shared "turn a token-free proxy path into a live, authenticated, slate-free URL"
// primitive for the in-app players (VidstackPlayer + DebugHlsPlayer). It owns the two load-bearing behaviors
// that used to live inline in HlsPlayer.vue:
//
//   1. Token append — the playlist download is token-free but the streams inside are token-gated, so a `/api/`
//      src gets `?token=<session token>` appended (streamGate accepts the session token or a per-user
//      streamToken on ?token=).
//   2. Establishing gate — the proxy serves a B-Roll slate (a 1280×720 ffmpeg card) while a channel is
//      establishing, then hands off to the live variant. That slate→live handoff (different resolution/codec/
//      DTS timeline) is a fatal decode error in hls.js's MSE pipeline ("buffers not in DTS sequence"). So we
//      poll the entry (which also drives the server-side resolve + registers the viewer + kicks ffprobe) and
//      only expose the src once it's serving real content (no `__broll__` slate segments). The slate therefore
//      never enters the browser media buffer.
//
// A generation id cancels superseded loads (rapid channel switches) so a stale prime loop can't expose the
// wrong stream. The consumer binds its media engine to `gatedSrc`: it's null while idle/establishing and the
// authenticated live URL once it's safe to attach.

export interface AppStreamSource {
  // The authenticated live URL, or null while idle / still establishing. Bind the media engine to this.
  gatedSrc: Ref<string | null>;
  // True while the establishing gate is polling (between a new src and it going live).
  connecting: Ref<boolean>;
  // True when the establishing gate hit its 30s deadline still slating AND the caller opted into failOnDeadline
  // (VidstackPlayer). Lets the consumer surface a "failed to establish" error instead of attaching the slate.
  establishFailed: Ref<boolean>;
  // The token-appended src regardless of the gate (exposed for consumers that want the raw URL).
  authenticatedSrc: Ref<string | null>;
  // Re-run the load for the current src (e.g. a manual retry).
  reload: () => void;
}

export function useAppStreamSource(
  src: Ref<string | null>,
  opts: { gate?: boolean; failOnDeadline?: boolean } = {},
): AppStreamSource {
  const gate = opts.gate ?? true;
  // When true, hitting the 30s establishing deadline surfaces establishFailed instead of best-effort attaching
  // the still-slating stream (whose slate→live handoff is a fatal decode error in hls.js). Opt-in so
  // DebugHlsPlayer keeps its raw slate-included observation.
  const failOnDeadline = opts.failOnDeadline ?? false;
  const gatedSrc = ref<string | null>(null);
  const connecting = ref(false);
  const establishFailed = ref(false);
  // Generation token: bumped on every teardown/reload so any in-flight prime loop for a superseded src bails
  // instead of exposing the wrong stream.
  let loadId = 0;

  const authenticatedSrc = computed<string | null>(() => {
    if (!src.value) return null;
    const activeToken = token.value || localStorage.getItem('auth_token');
    if (!activeToken) return src.value;

    if (src.value.startsWith('/api/')) {
      try {
        const url = new URL(src.value, window.location.origin);
        url.searchParams.set('token', activeToken);
        return url.pathname + url.search;
      } catch {
        return src.value;
      }
    }
    return src.value;
  });

  // Poll the entry until it's serving real content (master or media playlist with no B-Roll slate segments),
  // so the slate never enters the MSE buffer. The fetch itself drives the server-side resolve and refreshes
  // the viewer heartbeat. Returns true when ready to attach, false if superseded.
  async function waitForLive(url: string, myId: number): Promise<'live' | 'timeout' | 'superseded'> {
    const deadline = Date.now() + 30_000; // cap the establishing wait so a stuck channel still terminates
    for (;;) {
      if (myId !== loadId) return 'superseded';
      let text = '';
      try {
        text = await (await fetch(url, { cache: 'no-store' })).text();
      } catch {
        /* transient — retry below */
      }
      if (myId !== loadId) return 'superseded';
      const isPlaylist = text.includes('#EXTM3U');
      const establishing = text.includes('__broll__'); // the B-Roll slate's segment marker
      if (isPlaylist && !establishing) return 'live'; // serving the real master/media playlist → safe to attach
      if (Date.now() > deadline) return 'timeout'; // gave up waiting (failed/slow channel)
      await new Promise((f) => setTimeout(f, 1500));
    }
  }

  function teardown() {
    loadId++; // cancel any in-flight prime loop
    gatedSrc.value = null;
    connecting.value = false;
    establishFailed.value = false;
  }

  function load(url: string | null) {
    teardown(); // bumps loadId, clears gatedSrc
    if (!url) return;
    const myId = loadId;
    if (!gate) {
      // Diagnostic bypass: expose the raw handoff (slate included) instead of waiting it out.
      gatedSrc.value = url;
      return;
    }
    connecting.value = true;
    void (async () => {
      const res = await waitForLive(url, myId);
      if (myId !== loadId) return; // superseded by a newer load / teardown
      connecting.value = false;
      if (res === 'live') {
        gatedSrc.value = url;
      } else if (res === 'timeout') {
        // Deadline hit while still slating. Fail honestly if opted in (VidstackPlayer surfaces an error + Retry);
        // otherwise preserve the legacy best-effort attach (DebugHlsPlayer observes the raw slate→live handoff).
        if (failOnDeadline) establishFailed.value = true;
        else gatedSrc.value = url;
      }
    })();
  }

  watch(authenticatedSrc, (u) => load(u), { immediate: true });
  onBeforeUnmount(teardown);

  return { gatedSrc, connecting, establishFailed, authenticatedSrc, reload: () => load(authenticatedSrc.value) };
}
