import { ref, computed, watch, nextTick, onBeforeUnmount, type Ref } from 'vue';
import { token } from './useAuth';


export interface AppStreamSource {
  gatedSrc: Ref<string | null>;
  authenticatedSrc: Ref<string | null>;
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

  watch(authenticatedSrc, (u) => { gatedSrc.value = u; }, { immediate: true });

  function reload() {
    const u = authenticatedSrc.value;
    gatedSrc.value = null;
    void nextTick(() => { gatedSrc.value = u; });
  }

  onBeforeUnmount(() => { gatedSrc.value = null; });

  return { gatedSrc, authenticatedSrc, reload };
}
