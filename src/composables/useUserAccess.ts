import {
    globalMemberIds,
    nonGlobalPlaylists,
    buildPublishedGroups,
    type PublishedUrlUser,
    type PublishedGroup,
    type PublishedRow,
} from './usePublishedUrls';

// ── Per-user access helpers (pure) ───────────────────────────────────────────────────────────────────────
// The framework-light building blocks both the admin Users drawer and the Phase-2 Playlists modals consume,
// so the access semantics live in ONE place. "Global access" is not a single playlist row — it is the UNION
// of every endpoint:'global' source playlist (globalMemberIds); granting Global = putting every Global-member
// id into allowedPlaylists (the read filter, the stream gate, and per-user compose all key on
// allowedPlaylists.includes(<sourceId>)). These helpers encode exactly that, plus the per-custom toggle.
//
// This module is the single import surface for Phase 2: it re-exports the PLAYLISTS-derived sets, the pure
// group builder, and the published-URL types alongside the access helpers.

export {
    globalMemberIds,
    nonGlobalPlaylists,
    buildPublishedGroups,
};
export type { PublishedUrlUser, PublishedGroup, PublishedRow };

// True iff the user holds EVERY Global member id in allowedPlaylists (and at least one Global member exists).
// Mirrors the Users screen's `hasGlobalAccess` computed.
export function hasGlobalAccess(user: { allowedPlaylists?: string[] | null }): boolean {
    const allowed = user.allowedPlaylists || [];
    const members = globalMemberIds.value;
    return members.length > 0 && members.every((id) => allowed.includes(id));
}

// Add (on) or remove (off) the ENTIRE Global member set from an allowedPlaylists array, leaving any non-Global
// entries untouched. Returns a new array. Mirrors the Users screen's `toggleGlobalAccess`.
export function toggleGlobal(allowedPlaylists: string[], on: boolean): string[] {
    if (on) {
        return Array.from(new Set([...allowedPlaylists, ...globalMemberIds.value]));
    }
    const members = new Set(globalMemberIds.value);
    return allowedPlaylists.filter((id) => !members.has(id));
}

// Add (on) or remove (off) a single custom-playlist id from an allowedCustomPlaylists array. Returns a new
// array; a no-op (already present and on, or already absent and off) returns a shallow copy. Mirrors the Users
// screen's `toggleCustomPlaylistSelection`.
export function toggleCustom(allowedCustomPlaylists: string[], id: string, on: boolean): string[] {
    const has = allowedCustomPlaylists.includes(id);
    if (on && !has) return [...allowedCustomPlaylists, id];
    if (!on && has) return allowedCustomPlaylists.filter((x) => x !== id);
    return allowedCustomPlaylists.slice();
}
