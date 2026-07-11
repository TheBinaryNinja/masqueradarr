// Global search — the client half of the server GET /api/search endpoint (admin-only). Types shared by the
// topbar search box (App.vue) and the results dropdown (SearchResults.vue). Results are grouped: `groups`
// holds channel / epg-channel matches bucketed by their owning parent resource; `topLevel` holds direct
// playlist / EPG-source name matches. Each row carries the ids its click handler needs.

export interface SearchRow {
  type: 'playlist' | 'epg-source' | 'channel' | 'epg-channel';
  id: string;
  label: string;
  sublabel: string;
  playlistId?: string; // present on type 'channel'
  epgSourceId?: string; // present on type 'epg-channel'
}

export interface SearchGroup {
  kind: 'playlist' | 'epg-source';
  id: string;
  label: string;
  rows: SearchRow[];
  total: number; // true match count (rows is capped) → drives the "+N more" line
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
