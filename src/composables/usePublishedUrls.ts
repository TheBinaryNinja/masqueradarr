import { computed, type ComputedRef, type Ref } from 'vue';
import { PLAYLISTS, type Playlist } from '../data';
import { domain, epgEndpoint } from './useSettings';
import { userM3uUrl } from './useAuth';

// ── Shared published-URL derivation ─────────────────────────────────────────────────────────────────────
// One source of truth for the per-user "published URLs" — the token-free M3U download + EPG/guide URL pairs
// a user can drop into an IPTV player. Both the admin Users screen and the user Dashboard derive IDENTICAL
// URLs from this module: every URL is a pure function of data the SPA already has (the user's identity +
// allow-lists + the loaded PLAYLISTS + the operator domain), so there is no new data-model field and no
// backend call. The two URLs that belong to the SAME playlist are grouped into ONE card (PublishedGroup) so
// the playlist name is the grouping cue carried by the card header, not repeated on every field label.

// The minimal user-like shape this module needs — satisfied by both UserProfile (useAuth) and the admin
// User row, AND by a synthetic "live form state" object (identity from the edited row, membership from the
// live checkbox refs) so the admin modal's cards update as boxes toggle.
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

// Strip the trailing dotted filename segment of a pathname — the frontend twin of the server's
// normalizeEndpointPath(); keeps the per-custom guide path identical to what customGuidePath() composes.
export function normalizeEndpointPath(pathname: string): string {
    const segs = (pathname ?? '').split('/').filter(Boolean);
    if (segs.length && segs[segs.length - 1].includes('.')) segs.pop();
    return segs.join('/');
}

// Domain origin without a trailing slash — the absolutize prefix for the guide path (which is domain-rooted,
// not relative to the playlist's custom base) and the fallback base for a custom playlist with an empty url.
export function originBase(): string {
    return domain.value.replace(/\/+$/, '');
}

// Per-custom published M3U URL: the custom HOSTED-AT base + the user's flat per-user filename.
export function customM3uUrl(playlist: Playlist, user: PublishedUrlUser): string {
    const base = (playlist.url || originBase()).replace(/\/+$/, '');
    return `${base}/${user.username}-${user.slug}.m3u`;
}

// Per-custom published guide URL: domain + the surface-anchored custom guide path (keeps the custom/ prefix).
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

// The set of source ids that form the Global union (every endpoint:'global' source playlist).
export const globalMemberIds = computed(() => PLAYLISTS.value.filter((p) => p.endpoint === 'global').map((p) => p.id));
// Everything NOT part of the Global union — the Custom/clone playlists (and any non-Global source playlist).
export const nonGlobalPlaylists = computed(() => PLAYLISTS.value.filter((p) => p.endpoint !== 'global'));

// Build the ordered, conditional PublishedGroup[] for a user-like object. `getUser` is a getter (so callers
// can drive membership reactively — the admin modal passes live form state, the Dashboard passes currentUser).
// Returns [] when there is no user (e.g. a brand-new, not-yet-saved row).
//   1. Global card (M3U + global EPG XML) — ONLY when the user has every Global member id in allowedPlaylists.
//   2. then one card per allowedCustomPlaylists entry, in nonGlobalPlaylists order.
export function usePublishedUrls(
    getUser: ComputedRef<PublishedUrlUser | null> | Ref<PublishedUrlUser | null> | (() => PublishedUrlUser | null),
): ComputedRef<PublishedGroup[]> {
    const read = (): PublishedUrlUser | null =>
        typeof getUser === 'function' ? getUser() : getUser.value;

    return computed<PublishedGroup[]>(() => {
        const u = read();
        if (!u) return [];

        const allowed = u.allowedPlaylists || [];
        const hasGlobal =
            globalMemberIds.value.length > 0 && globalMemberIds.value.every((id) => allowed.includes(id));
        const allowedCustom = u.allowedCustomPlaylists || [];

        const out: PublishedGroup[] = [];
        // Global first — conditional on the user holding the full Global union.
        if (hasGlobal) {
            out.push({
                key: 'global',
                name: 'Global',
                kind: 'Global',
                m3u: {
                    url: userM3uUrl(u),
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
        // Then each allowed custom playlist, in the order it appears in the (non-Global) list.
        for (const p of nonGlobalPlaylists.value) {
            if (!allowedCustom.includes(p.id)) continue;
            out.push({
                key: `custom-${p.id}`,
                name: p.name,
                kind: 'Custom',
                m3u: {
                    url: customM3uUrl(p, u),
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
    });
}
