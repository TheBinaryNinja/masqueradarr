// Ultimate Player launch — the ONE place that opens the standalone player.html window.
//
// Three surfaces launch the player now (the channel slide-out, the Playlists rows, the Dashboard Playlists
// panel), and the parts of this that are easy to get wrong should not be copy-pasted three times:
//
// window.open MUST be called synchronously from the click handler: await anything first and pop-up blockers
// treat it as unsolicited. One fixed window name means relaunching re-navigates and focuses the existing
// window rather than stacking new ones; since only the hash differs, no reload fires and the player picks
// the change up via its `hashchange` listener.
//
// `popup=yes` is already the most chrome a script can remove — it drops the tab strip, bookmarks bar,
// toolbar and menu. Do NOT add `location=no,toolbar=no,menubar=no`: every current browser IGNORES them and
// force-shows a read-only origin chip on any pop-up, as anti-spoofing rather than as a preference. The
// player window's F key / Full screen button is the supported way to get rid of that last strip.
//
// pushToast is a module-level singleton function (see useToast.ts), so this needs no `use*()` hook shape and
// can be called from a plain handler.
import { pushToast } from './useToast';

const WINDOW_NAME = 'masq-upl';
const WINDOW_FEATURES = 'popup=yes,width=1440,height=900';

// `playlistId` is the owning playlist id for both playlist kinds (a custom playlist's channels are keyed by
// its id; a (Default) playlist is provisioned with id === source), which is what lets the popup load the
// right channel list + guide.
//
// `channelId` is OPTIONAL. Omit it to launch a playlist without picking a channel: UplApp.boot() falls back
// to the first row of `orderedChannels` — i.e. the first channel in the viewer's current rail sort order —
// so a playlist-scoped launch needs nothing extra on the player side.
export function openUltimatePlayer(playlistId: string, channelId?: string): void {
  if (!playlistId) return;
  const url = `/player.html#pl=${encodeURIComponent(playlistId)}`
    + (channelId ? `&ch=${encodeURIComponent(channelId)}` : '');
  const w = window.open(url, WINDOW_NAME, WINDOW_FEATURES);
  if (w) {
    w.focus();
  } else {
    pushToast({
      tone: 'warn',
      title: 'Pop-up blocked',
      text: 'Allow pop-ups for this site to open the Ultimate Video Player.',
    });
  }
}
