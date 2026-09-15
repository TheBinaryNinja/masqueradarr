
export interface StreamRoutableChannel {
  source: string;
  origin?: string | null;
  streamEntryUrl?: string | null;
}

export function appPlayerProxyPath(ch: StreamRoutableChannel): string | null {
  const src = ch.origin || ch.source;
  if (!ch.streamEntryUrl || !src) return null;
  return `/api/v1/${src}/${encodeURIComponent(ch.streamEntryUrl)}`;
}
