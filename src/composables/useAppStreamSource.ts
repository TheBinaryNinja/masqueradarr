import { ref, computed, watch, nextTick, onBeforeUnmount, type Ref } from 'vue';
import { token } from './useAuth';

// useAppStreamSource — the shared "turn a token-free proxy path into an authenticated, playable URL" primitive
// for the in-app players (VidstackPlayer + DebugHlsPlayer). The playlist download is token-free but the streams
// inside are token-gated, so a `/api/` src gets `?token=<session token>` appended (streamGate accepts the session
// token or a per-user streamToken on ?token=). The stream resolves on demand server-side when the media engine
// fetches it, so we expose the authenticated URL immediately — the consumer binds its media engine to `gatedSrc`
// (null while idle). `reload()` re-attaches the current src for a manual retry.

export interface AppStreamSource {
  // The authenticated stream URL, or null while idle. Bind the media engine to this.
  gatedSrc: Ref<string | null>;
  // The token-appended src (same value as gatedSrc; exposed for consumers that want the raw URL).
  authenticatedSrc: Ref<string | null>;
  // Re-attach the current src (e.g. a manual retry): briefly clears gatedSrc so an unchanged URL still forces
  // the media engine to detach + re-attach.
  reload: () => void;
}

export function useAppStreamSource(src: Ref<string | null>): AppStreamSource {
  const gatedSrc = ref<string | null>(null);

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

  // Expose the authenticated URL to the media engine as soon as it's known (and whenever src/token change).
  watch(authenticatedSrc, (u) => { gatedSrc.value = u; }, { immediate: true });

  // Manual retry: null the src, then restore it next tick so the `:src` binding changes even when the URL is
  // identical — forcing the media engine to detach and re-attach.
  function reload() {
    const u = authenticatedSrc.value;
    gatedSrc.value = null;
    void nextTick(() => { gatedSrc.value = u; });
  }

  onBeforeUnmount(() => { gatedSrc.value = null; });

  return { gatedSrc, authenticatedSrc, reload };
}
