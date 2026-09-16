import {
    globalMemberIds,
    nonGlobalPlaylists,
    buildPublishedGroups,
    type PublishedUrlUser,
    type PublishedGroup,
    type PublishedRow,
} from './usePublishedUrls';


export {
    globalMemberIds,
    nonGlobalPlaylists,
    buildPublishedGroups,
};
export type { PublishedUrlUser, PublishedGroup, PublishedRow };

export function hasGlobalAccess(user: { allowedPlaylists?: string[] | null }): boolean {
    const allowed = user.allowedPlaylists || [];
    const members = globalMemberIds.value;
    return members.length > 0 && members.every((id) => allowed.includes(id));
}

export function toggleGlobal(allowedPlaylists: string[], on: boolean): string[] {
    if (on) {
        return Array.from(new Set([...allowedPlaylists, ...globalMemberIds.value]));
    }
    const members = new Set(globalMemberIds.value);
    return allowedPlaylists.filter((id) => !members.has(id));
}

export function toggleCustom(allowedCustomPlaylists: string[], id: string, on: boolean): string[] {
    const has = allowedCustomPlaylists.includes(id);
    if (on && !has) return [...allowedCustomPlaylists, id];
    if (!on && has) return allowedCustomPlaylists.filter((x) => x !== id);
    return allowedCustomPlaylists.slice();
}
