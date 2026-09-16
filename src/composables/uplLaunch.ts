import { pushToast } from './useToast';

const WINDOW_NAME = 'masq-upl';
const WINDOW_FEATURES = 'popup=yes,width=1440,height=900';

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
