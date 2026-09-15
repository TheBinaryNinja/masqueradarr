import { computed, type ComputedRef, type Ref } from 'vue';
import { PLAYLISTS, type Playlist } from '../data';
import { domain, epgEndpoint } from './useSettings';
import { userM3uUrl } from './useAuth';


export interface PublishedUrlUser {
    username: string;
    slug: string;
    allowedPlaylists: string[];
    allowedCustomPlaylists: string[];
}

export interface PublishedRow {
    url: string;
    hint: string;
    copyLabel: string;
}

export interface PublishedGroup {
    key: string;
    name: string;
    kind: 'Global' | 'Custom';
    m3u: PublishedRow;
    epg: PublishedRow;
}

export function normalizeEndpointPath(pathname: string): string {
    const segs = (pathname ?? '').split('/').filter(Boolean);
    if (segs.length && segs[segs.length - 1].includes('.')) segs.pop();
    return segs.join('/');
}

export function originBase(): string {
    return domain.value.replace(/\/+$/, '');
}

export function customM3uUrl(playlist: Playlist, user: PublishedUrlUser): string {
    const base = (playlist.url || originBase()).replace(/\/+$/, '');
    return `${base}/${user.username}-${user.slug}.m3u`;
}

export function customGuideUrl(playlist: Playlist): string {
    let pathname = '';
    try {
        pathname = new URL(playlist.url, originBase()).pathname;
    } catch {
        pathname = '';
    }
    const customPath = normalizeEndpointPath(pathname) || 'unknown';
    return `${originBase()}/custom/${customPath}/epg/playlist.xml`;
}

export const globalMemberIds = computed(() => PLAYLISTS.value.filter((p) => p.endpoint === 'global').map((p) => p.id));
export const nonGlobalPlaylists = computed(() => PLAYLISTS.value.filter((p) => p.endpoint !== 'global'));

export function buildPublishedGroups(user: PublishedUrlUser | null): PublishedGroup[] {
    if (!user) return [];

    const allowed = user.allowedPlaylists || [];
    const hasGlobal =
        globalMemberIds.value.length > 0 && globalMemberIds.value.every((id) => allowed.includes(id));
    const allowedCustom = user.allowedCustomPlaylists || [];

    const out: PublishedGroup[] = [];
    if (hasGlobal) {
        out.push({
            key: 'global',
            name: 'Global',
            kind: 'Global',
            m3u: {
                url: userM3uUrl(user),
                hint: "Token-free download URL; the user's stream token is baked into the channels inside.",
                copyLabel: 'Global Playlist M3U',
            },
            epg: {
                url: epgEndpoint.value,
                hint: 'Global, token-free guide URL — one URL works for every player.',
                copyLabel: 'Global EPG Guide',
            },
        });
    }
    for (const p of nonGlobalPlaylists.value) {
        if (!allowedCustom.includes(p.id)) continue;
        out.push({
            key: `custom-${p.id}`,
            name: p.name,
            kind: 'Custom',
            m3u: {
                url: customM3uUrl(p, user),
                hint: "Token-free download URL; the user's stream token is baked into the channels inside.",
                copyLabel: `${p.name} Playlist M3U`,
            },
            epg: {
                url: customGuideUrl(p),
                hint: 'Token-free guide URL for this custom playlist.',
                copyLabel: `${p.name} EPG Guide`,
            },
        });
    }
    return out;
}

export function usePublishedUrls(
    getUser: ComputedRef<PublishedUrlUser | null> | Ref<PublishedUrlUser | null> | (() => PublishedUrlUser | null),
): ComputedRef<PublishedGroup[]> {
    const read = (): PublishedUrlUser | null =>
        typeof getUser === 'function' ? getUser() : getUser.value;

    return computed<PublishedGroup[]>(() => buildPublishedGroups(read()));
}
