// DuloAuth — the stateful auth/session layer for the dulo.tv adapter.
//
// dulo.tv reworked Live TV: the catalog no longer carries a stream URL. A stream is now minted per
// play by a Supabase-authenticated, device-bound, expiring "playback session". This module owns all of
// that state (which the stateless SourceAdapter contract deliberately can't carry) and exposes a single
// resolvePlayback(channelId) the adapter calls from resolveStream().
//
// Flow (every call sends browser-like headers — dulo is behind bot gating):
//   1. ensureFreshToken()  — refresh the Supabase access_token via the refresh_token when near expiry.
//   2. ensureDevice()      — POST /api/live-tv/activate-device once; cache the returned deviceId.
//   3. resolvePlayback()   — POST /api/live-tv/playback-session { deviceFingerprint, channelId }
//                            → { playbackUrl, expiresAt }.  Resolution is lazy/per-play; the playbackUrl
//                            expires in minutes and burns the account's single Live TV session, so it is
//                            NEVER resolved at sync time.
//
// Only tokens are persisted (models/PlaylistAuth.ts) — never a password. The SPA captures the already
// signed-in Supabase session from dulo.tv and hands us the tokens (see routes/sources.ts auth endpoints).
//
// NOTE (verify with a real account): Supabase rotates refresh tokens, so a server refresh and dulo's own
// browser tab can invalidate each other's refresh token — re-capture may be needed occasionally. The
// playbackUrl host + whether its segments need extra headers is the other open unknown (see dulo.ts).

import { randomUUID } from 'node:crypto';
import { PlaylistAuth as PlaylistAuthModel, type PlaylistAuthDoc } from '../../../models/PlaylistAuth.js';
import { Playlist } from '../../../models/Playlist.js';
import { logger } from '../../core/logger.js';

const DULO_ORIGIN = 'https://dulo.tv';
const DULO_BASE = process.env.DULO_API_BASE || 'https://dulo.tv/api';
const DEVICE_NAME = process.env.DULO_DEVICE_NAME || 'Masqueradarr';
const ANON_KEY_ENV = process.env.DULO_SUPABASE_ANON_KEY || null;
// Shared with the dulo streamed-login browser (loginBrowser.ts) so the captured-session UA matches the
// UA the server later sends on activate-device / playback-session / token-refresh.
export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFRESH_MARGIN_MS = 60_000; // refresh when <60s of access_token life remains
const tag = 'dulo:auth';

export interface DuloStatus {
  signedIn: boolean;
  status: string; // mirrors PlaylistAuthDoc.status
  deviceActive: boolean;
  deviceName: string | null;
  expiresAt: number | null;
  blockReason: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

export interface CapturePayload {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null; // seconds or ms epoch; derived from the JWT when absent
  supabaseUrl?: string | null;
  anonKey?: string | null;
  // Device identity captured from dulo's OWN web client during the streamed login (loginBrowser.ts
  // intercepts its activate-device call). dulo binds playback to the fingerprint its client registered,
  // so reusing it is what makes playback-session match — a self-invented UUID gets `device_mismatch`.
  // All optional: absent on the paste fallback / already-signed-in path, where we fall back to the
  // doc's randomUUID fingerprint and re-activate server-side.
  deviceFingerprint?: string | null;
  deviceId?: string | null;
  deviceName?: string | null;
}

function browserHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'User-Agent': UA, Origin: DULO_ORIGIN, Referer: `${DULO_ORIGIN}/live`, ...extra };
}

function decodeJwt(token: string): { exp?: number; iss?: string; ref?: string } {
  try {
    const part = token.split('.')[1];
    if (!part) return {};
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const p = JSON.parse(json) as Record<string, unknown>;
    return {
      exp: typeof p.exp === 'number' ? p.exp : undefined,
      iss: typeof p.iss === 'string' ? p.iss : undefined,
      ref: typeof p.ref === 'string' ? p.ref : undefined,
    };
  } catch {
    return {};
  }
}

function deriveSupabaseUrl(token: string, provided?: string | null): string | null {
  if (provided) return provided.replace(/\/+$/, '');
  const { iss, ref } = decodeJwt(token);
  if (iss) return iss.replace(/\/auth\/v1\/?$/, '');
  if (ref) return `https://${ref}.supabase.co`;
  return null;
}

// Normalize an expiry that may arrive as seconds or ms (or be absent → read the JWT `exp`) into ms epoch.
function expiryMs(provided: number | null | undefined, token: string): number | null {
  let n = provided ?? undefined;
  if (n == null) n = decodeJwt(token).exp;
  if (n == null) return null;
  return n < 1e12 ? n * 1000 : n;
}

// Per-playlist authenticated-session state. Parameterized by the owning `source` (the Playlist.source /
// playlistauths._id key) so it is no longer hard-keyed to dulo; the dulo singleton is `duloAuth` below.
class PlaylistAuthState {
  private cache: PlaylistAuthDoc | null = null;
  private refreshing: Promise<string> | null = null;
  private activating: Promise<void> | null = null;

  constructor(private readonly source: string) {}

  /** The owning Playlist's ObjectId hex (informational), or null if the playlist row isn't provisioned yet. */
  private async ownerObjectId(): Promise<string | null> {
    const pl = await Playlist.findOne({ id: this.source }, { _id: 1 }).lean<{ _id: unknown }>();
    return pl?._id != null ? String(pl._id) : null;
  }

  /** Load the singleton row, creating a signed-out shell (with a fresh device fingerprint) if absent. */
  private async load(): Promise<PlaylistAuthDoc> {
    if (this.cache) return this.cache;
    const existing = await PlaylistAuthModel.findById(this.source).lean<PlaylistAuthDoc>();
    if (existing) {
      this.cache = existing;
      return existing;
    }
    const fresh: PlaylistAuthDoc = {
      _id: this.source,
      playlistSource: this.source,
      playlist_id: await this.ownerObjectId(),
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      supabaseUrl: null,
      anonKey: ANON_KEY_ENV,
      deviceFingerprint: randomUUID(),
      deviceId: null,
      deviceName: DEVICE_NAME,
      status: 'signed_out',
      blockReason: null,
      lastError: null,
      updatedAt: new Date().toISOString(),
    };
    await PlaylistAuthModel.updateOne({ _id: this.source }, { $set: fresh }, { upsert: true });
    this.cache = fresh;
    return fresh;
  }

  private async save(patch: Partial<PlaylistAuthDoc>): Promise<PlaylistAuthDoc> {
    const current = await this.load();
    // Keep playlist_id eventually-consistent: backfill it once the owning Playlist row exists.
    const playlist_id = current.playlist_id ?? (await this.ownerObjectId());
    const next: PlaylistAuthDoc = {
      ...current,
      ...patch,
      playlistSource: this.source,
      playlist_id,
      updatedAt: new Date().toISOString(),
    };
    const { _id, ...rest } = next;
    await PlaylistAuthModel.updateOne({ _id: this.source }, { $set: rest }, { upsert: true });
    this.cache = next;
    // Cross-collection mirror (store + write-back): reflect the auth status onto the owning playlist's
    // `isAuthenticated` flag whenever status changes. The playlistauths doc stays the authority; this is a
    // sanctioned derivation written for the UI/API (like the settings domain→playlist-url cascade). A no-op
    // when the playlist row isn't provisioned yet.
    if (patch.status !== undefined) {
      await Playlist.updateOne(
        { source: this.source },
        { $set: { isAuthenticated: patch.status === 'active' } },
      );
    }
    return next;
  }

  /** Store a captured Supabase session, then register the device. Returns the resulting status. */
  async signIn(payload: CapturePayload): Promise<DuloStatus> {
    if (!payload || typeof payload.accessToken !== 'string' || !payload.accessToken) {
      throw new Error('accessToken (string) required');
    }
    const patch: Partial<PlaylistAuthDoc> = {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken ?? null,
      expiresAt: expiryMs(payload.expiresAt, payload.accessToken),
      supabaseUrl: deriveSupabaseUrl(payload.accessToken, payload.supabaseUrl),
      anonKey: payload.anonKey ?? ANON_KEY_ENV,
      status: 'active',
      blockReason: null,
      lastError: null,
      // Default: clear the cached deviceId so ensureDevice() re-activates under the new identity.
      deviceId: null,
    };
    // Prefer the device identity captured from dulo's own client (see CapturePayload). Reusing the real
    // fingerprint is the fix for `device_mismatch`; carrying the captured deviceId lets ensureDevice()
    // short-circuit so we don't disturb dulo's binding with a redundant server-side activation.
    if (payload.deviceFingerprint) patch.deviceFingerprint = payload.deviceFingerprint;
    if (payload.deviceName) patch.deviceName = payload.deviceName;
    if (payload.deviceId) patch.deviceId = payload.deviceId;
    await this.save(patch);
    try {
      const token = await this.ensureFreshToken();
      await this.ensureDevice(token); // no-op when a captured deviceId was persisted above
    } catch (err) {
      logger.warn(tag, `device activation after sign-in failed: ${(err as Error).message}`);
    }
    return this.status();
  }

  async signOut(): Promise<DuloStatus> {
    await this.save({
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      deviceId: null,
      status: 'signed_out',
      blockReason: null,
      lastError: null,
    });
    return this.status();
  }

  /** Return a valid access_token, refreshing via Supabase when it is within the expiry margin. */
  async ensureFreshToken(): Promise<string> {
    const s = await this.load();
    if (!s.accessToken) throw new Error('not authenticated — sign in to dulo first');
    if (s.expiresAt == null || s.expiresAt - Date.now() > REFRESH_MARGIN_MS) return s.accessToken;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const s = await this.load();
    if (!s.refreshToken || !s.supabaseUrl || !s.anonKey) {
      await this.save({ status: 'reauth_required', lastError: 'cannot refresh (missing refresh token / supabase config)' });
      throw new Error('cannot refresh session — re-authenticate with dulo');
    }
    let res: Response;
    try {
      res = await fetch(`${s.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: s.anonKey, Authorization: `Bearer ${s.anonKey}` },
        body: JSON.stringify({ refresh_token: s.refreshToken }),
      });
    } catch (err) {
      await this.save({ status: 'error', lastError: `refresh fetch failed: ${(err as Error).message}` });
      throw err;
    }
    if (!res.ok) {
      await this.save({ status: 'reauth_required', lastError: `refresh HTTP ${res.status}` });
      throw new Error(`session refresh failed (HTTP ${res.status}) — re-authenticate`);
    }
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_at?: number;
      expires_in?: number;
    };
    if (!data.access_token) {
      await this.save({ status: 'reauth_required', lastError: 'refresh returned no access_token' });
      throw new Error('session refresh returned no token — re-authenticate');
    }
    const expiresAt =
      data.expires_at != null
        ? data.expires_at * 1000
        : data.expires_in != null
          ? Date.now() + data.expires_in * 1000
          : expiryMs(undefined, data.access_token);
    await this.save({
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? s.refreshToken,
      expiresAt,
      status: 'active',
      lastError: null,
    });
    logger.ok(tag, 'refreshed access token');
    return data.access_token;
  }

  /** Register this server as a device on the account once; cache the returned deviceId. */
  async ensureDevice(accessToken: string): Promise<string> {
    const s = await this.load();
    if (s.deviceId) return s.deviceId;
    if (this.activating) {
      await this.activating;
      return (await this.load()).deviceId ?? '';
    }
    this.activating = (async () => {
      const res = await fetch(`${DULO_BASE}/live-tv/activate-device`, {
        method: 'POST',
        headers: browserHeaders({ 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` }),
        body: JSON.stringify({ deviceFingerprint: s.deviceFingerprint, deviceName: s.deviceName || DEVICE_NAME }),
      });
      if (res.status === 401) {
        await this.save({ status: 'reauth_required', lastError: 'activate-device 401' });
        throw new Error('device activation unauthorized — re-authenticate');
      }
      if (!res.ok) throw new Error(`activate-device failed (HTTP ${res.status})`);
      const data = (await res.json().catch(() => ({}))) as { device?: { id?: string; device_name?: string } };
      await this.save({
        deviceId: data.device?.id ?? null,
        deviceName: data.device?.device_name ?? s.deviceName ?? DEVICE_NAME,
        status: 'active',
      });
      logger.ok(tag, `device activated (${data.device?.id ?? 'no id returned'})`);
    })().finally(() => {
      this.activating = null;
    });
    await this.activating;
    return (await this.load()).deviceId ?? '';
  }

  /** Resolve a fresh, expiring playback master URL for one channel. Throws (→ proxy 502) on failure. */
  async resolvePlayback(channelId: string): Promise<{ playbackUrl: string; expiresAt: string | null }> {
    const token = await this.ensureFreshToken();
    const s = await this.ensureDeviceLoaded(token);
    const res = await fetch(`${DULO_BASE}/live-tv/playback-session`, {
      method: 'POST',
      headers: browserHeaders({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }),
      body: JSON.stringify({ deviceFingerprint: s.deviceFingerprint, channelId }),
    });
    if (res.status === 401) {
      await this.save({ status: 'reauth_required', lastError: 'playback-session 401' });
      throw new Error('playback unauthorized — re-authenticate with dulo');
    }
    if (res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { block?: { reason?: string }; error?: string };
      const reason = body.block?.reason || body.error || 'access blocked';
      await this.save({ status: 'blocked', blockReason: reason });
      throw new Error(`playback blocked: ${reason}`);
    }
    if (!res.ok) throw new Error(`playback-session failed (HTTP ${res.status})`);
    const data = (await res.json().catch(() => ({}))) as { playbackUrl?: string; expiresAt?: string };
    if (!data.playbackUrl) throw new Error('playback-session returned no playbackUrl');
    if (s.status !== 'active' || s.blockReason) await this.save({ status: 'active', blockReason: null, lastError: null });
    return { playbackUrl: data.playbackUrl, expiresAt: data.expiresAt ?? null };
  }

  private async ensureDeviceLoaded(token: string): Promise<PlaylistAuthDoc> {
    await this.ensureDevice(token);
    return this.load();
  }

  async status(): Promise<DuloStatus> {
    const s = await this.load();
    return {
      signedIn: !!s.accessToken,
      status: s.status,
      deviceActive: !!s.deviceId,
      deviceName: s.deviceName,
      expiresAt: s.expiresAt,
      blockReason: s.blockReason,
      lastError: s.lastError,
      updatedAt: s.updatedAt,
    };
  }
}

export const duloAuth = new PlaylistAuthState('dulo');
