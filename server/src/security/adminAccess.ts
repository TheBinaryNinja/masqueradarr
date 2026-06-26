import { Playlist } from '../models/Playlist.js';
import { User } from '../models/User.js';

// Admin access-materialization helpers (the "admin ⇒ all playlists" invariant). An admin account holds
// EVERY playlist materialized into its stored access arrays (allowedPlaylists for Global-endpoint playlists,
// allowedCustomPlaylists for Custom-endpoint ones) — not merely via the role bypass in the read/stream/
// compose gates. The Global/Custom split mirrors the SPA's globalMemberIds/nonGlobalPlaylists: a playlist
// belongs to allowedPlaylists iff its endpoint === 'global' (the default), else allowedCustomPlaylists.
// Compared lowercase for defense-in-depth against a pre-normalization capitalized 'Global'/'Custom' doc.

// Is a playlist a Global-endpoint one? Default (missing) endpoint is 'global'. Lowercase compare.
function isGlobalEndpoint(endpoint?: string | null): boolean {
    return (endpoint ?? 'global').toLowerCase() === 'global';
}

// The CURRENT full-access materialization: every playlist id, split into the Global vs. Custom arrays by the
// endpoint rule. Used when an account becomes (or is created as) an admin — its arrays are set to this.
export async function listAllPlaylistAccess(): Promise<{
    allowedPlaylists: string[];
    allowedCustomPlaylists: string[];
}> {
    const playlists = (await Playlist.find({}, { id: 1, endpoint: 1 }).lean()) as Array<{
        id: string;
        endpoint?: string | null;
    }>;
    const allowedPlaylists: string[] = [];
    const allowedCustomPlaylists: string[] = [];
    for (const p of playlists) {
        if (isGlobalEndpoint(p.endpoint)) allowedPlaylists.push(p.id);
        else allowedCustomPlaylists.push(p.id);
    }
    return { allowedPlaylists, allowedCustomPlaylists };
}

// Auto-grant a newly-created playlist to every admin account: $addToSet its id into the appropriate array
// (Global → allowedPlaylists, Custom → allowedCustomPlaylists) for all role:'admin' users. Idempotent
// ($addToSet never duplicates). Call best-effort/non-fatal after a Playlist row is created.
export async function grantPlaylistToAdmins(playlistId: string, endpoint?: string | null): Promise<void> {
    const field = isGlobalEndpoint(endpoint) ? 'allowedPlaylists' : 'allowedCustomPlaylists';
    await User.updateMany({ role: 'admin' }, { $addToSet: { [field]: playlistId } });
}
