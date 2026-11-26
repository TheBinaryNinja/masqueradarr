import { pushToast } from './useToast';
import { FEATURES } from '../data';

const WINDOW_NAME = 'masq-rebel';
const WINDOW_FEATURES = 'popup=yes,width=1366,height=900';

const CONNECTING_HTML =
  '<!doctype html><title>Rebel IPTV</title><body style="margin:0;display:grid;place-items:center;height:100vh;' +
  'background:#0f1115;color:#aab0bd;font:15px system-ui,sans-serif">Connecting to Rebel IPTV…</body>';

export function rebelUiOrigin(): string | null {
  const ui = FEATURES.value.rebelIptv.ui;
  if (!ui) return null;
  if (ui.publicUrl) return ui.publicUrl.replace(/\/+$/, '');
  return `http://${location.hostname}:${ui.port}`;
}

export async function openRebelIptv(): Promise<void> {
  const origin = rebelUiOrigin();
  const w = window.open('', WINDOW_NAME, WINDOW_FEATURES);
  if (!w) {
    pushToast({ tone: 'warn', title: 'Pop-up blocked', text: 'Allow pop-ups for this site to open Rebel IPTV.' });
    return;
  }
  try {
    w.opener = null;
  } catch {
  }
  try {
    w.document.open();
    w.document.write(CONNECTING_HTML);
    w.document.close();
  } catch {
  }
  try {
    if (!origin) throw new Error('Rebel IPTV is not enabled');
    const res = await fetch('/api/rebel-iptv/ui-ticket', { method: 'POST' });
    const body = (await res.json().catch(() => ({}))) as { path?: string; message?: string; error?: string };
    if (!res.ok || !body.path) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
    w.location.replace(`${origin}${body.path}`);
    w.focus();
  } catch (err) {
    try {
      w.close();
    } catch {
    }
    pushToast({ tone: 'bad', title: 'Could not open Rebel IPTV', text: (err as Error).message });
  }
}
