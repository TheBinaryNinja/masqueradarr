import mitt from 'mitt';
import type { Channel } from '../data';

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
  // A user was created / updated / deleted through the shared useUsers store (or any surface that mutates
  // /api/users). Lets every consumer of the USERS singleton react, and the store itself runs a debounced
  // background fetchUsers() reconcile to pick up server-derived fields (recomposed slug, timestamps). The
  // optional id names the affected user. The reconcile fetch does NOT re-emit, so this never loops.
  'tvapp:users-changed': { id?: string };
  // A failover parent's EPG edit cascaded to its children server-side (the edit route returned
  // `_cascadedChildren`). Emitted by ChannelDrawer (App-level, over any screen) so open screens holding a
  // LOCAL channel list (PlaylistDetailScreen) can merge the updated children without a refetch.
  'tvapp:failover-cascade': { source: string; children: Channel[] };
  // Channels were hard-deleted (bulk editor, or the single-channel drawer's Remove). Emitted so a screen
  // holding a LOCAL channel list (PlaylistDetailScreen) drops the rows without a refetch. `source` is the
  // owning playlist id; `ids` are the deleted channel ids.
  'tvapp:channels-deleted': { source: string; ids: string[] };
};
export const bus = mitt<Events>();
