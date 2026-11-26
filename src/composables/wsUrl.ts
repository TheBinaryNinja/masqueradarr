import { token } from './useAuth';

export function apiWsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = new URL(path, `${proto}://${location.host}`);
  const activeToken = token.value || localStorage.getItem('auth_token');
  if (activeToken) url.searchParams.set('token', activeToken);
  return url.toString();
}
