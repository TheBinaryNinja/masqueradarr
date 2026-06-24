import mitt from 'mitt';

export interface RestoreItem { kind: string; text: string }
type Events = {
  'tvapp:restore-start': { items: RestoreItem[] };
  'tvapp:restore-done': void;
  // A playlist's auth state changed (signed in / out on Settings) — listeners re-read playlists so the
  // per-playlist auth badge reflects the new isAuthenticated.
  'tvapp:auth-changed': { source: string };
  // Open the Docs slide-out panel (App.vue owns the drawer). An optional section id deep-links to a
  // specific doc section; omit it to default to the current screen's section.
  'tvapp:docs-open': { section?: string };
};
export const bus = mitt<Events>();
