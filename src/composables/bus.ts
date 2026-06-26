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
  // A video config was just persisted (useVideoConfig debounced PUT resolved OK) — listeners re-read so a
  // live view of the configs (the Settings → Encoder Diagram) reflects the edit without a page refresh.
  'tvapp:videoconfig-saved': { configId: string };
};
export const bus = mitt<Events>();
