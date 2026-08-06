// Global fetch interceptor that attaches the Bearer auth token to every request, so the data helpers
// (data.ts getJson, the composables) never have to think about headers.
//
// Extracted from main.ts so BOTH entry points can install it: the SPA (main.ts) and the standalone Ultimate
// Player window (upl/main.ts). The token is read from localStorage per call rather than captured once, so a
// login/logout in another tab is picked up without a reload — and because localStorage is per-origin, the
// same-origin player popup shares the SPA's session for free.
//
// NOTE this only covers fetch(). Media engines load segments via their own XHR/<video src>, which is why
// stream URLs additionally carry `?token=` (see composables/useAppStreamSource.ts).

let installed = false;

export function installAuthFetch(): void {
  if (installed) return; // idempotent — never wrap our own wrapper
  installed = true;

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const token = localStorage.getItem('auth_token');
    if (token) {
      init = init || {};
      init.headers = init.headers || {};
      if (init.headers instanceof Headers) {
        init.headers.set('Authorization', `Bearer ${token}`);
      } else if (Array.isArray(init.headers)) {
        const idx = init.headers.findIndex((h) => h[0].toLowerCase() === 'authorization');
        if (idx !== -1) {
          init.headers.splice(idx, 1);
        }
        init.headers.push(['Authorization', `Bearer ${token}`]);
      } else {
        (init.headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
      }
    }
    return originalFetch(input, init);
  };
}
