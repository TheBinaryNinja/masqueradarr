
export interface SearchRow {
  type: 'playlist' | 'epg-source' | 'channel' | 'epg-channel';
  id: string;
  label: string;
  sublabel: string;
  playlistId?: string;
  epgSourceId?: string;
}

export interface SearchGroup {
  kind: 'playlist' | 'epg-source';
  id: string;
  label: string;
  rows: SearchRow[];
  total: number;
}

export interface SearchResponse {
  groups: SearchGroup[];
  topLevel: { playlists: SearchRow[]; epgSources: SearchRow[] };
}

export function searchIsEmpty(r: SearchResponse | null): boolean {
  return !r || (!r.groups.length && !r.topLevel.playlists.length && !r.topLevel.epgSources.length);
}

export async function runSearch(q: string): Promise<SearchResponse> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  return (await res.json()) as SearchResponse;
}
