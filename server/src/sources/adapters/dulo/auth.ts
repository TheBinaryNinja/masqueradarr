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
// A proactive KEEPALIVE (startDuloKeepalive at boot) additionally rotates the token KEEPALIVE_LEAD_MS
// ahead of each `exp` so the session survives idle stretches — without it, only play time refreshed and
// an untouched session died at the ~1h boundary. See the keepalive section at the bottom of the class.
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
// Supabase config resolution + runtime discovery. dulo periodically migrates its whole Supabase project
// (rotating the project URL + public `sb_publishable_` key together); rather than baking those values into
// env/infra config, we resolve them here (captured-with-session → runtime-discovered → committed seed) and
// discover the current pair from dulo's live bundle when a refresh 401s at the apikey gate. See supabaseConfig.ts.
import { currentAnonKey, currentSupabaseUrl, discoverSupabaseConfig } from './supabaseConfig.js';
// Where dulo lives today. dulo rebrands periodically, so the domain is an operator setting
// (Settings.duloDomain) cached in ./config.ts — read through getApiBase()/browserHeaders() at USE time so
// a domain change is honored without a restart. The old DULO_API_BASE env override is gone with it.
import { getApiBase, browserHeaders } from './config.js';

const DEVICE_NAME = process.env.DULO_DEVICE_NAME || 'Masqueradarr';
const REFRESH_MARGIN_MS = 60_000; // refresh when <60s of access_token life remains
const TRANSIENT_BACKOFF_MS = 60_000; // after a transient refresh failure, don't retry for this long

// ── Proactive keepalive tuning ──
// KEEPALIVE_LEAD_MS is how far AHEAD of the JWT `exp` the background keepalive rotates the token —
// deliberately distinct from REFRESH_MARGIN_MS (the lazy play-path net): with the keepalive armed the
// lazy margin only matters when the process was down/asleep across the expiry boundary.
const KEEPALIVE_LEAD_MS = Number(process.env.DULO_REFRESH_LEAD_MS || 300_000); // 5 min
const KEEPALIVE_MIN_DELAY_MS = 5_000; // never arm closer than now+5s (past-due / clock-skew clamp)
const KEEPALIVE_MAX_ARM_MS = 43_200_000; // re-check at least every 12h; also dodges Node's 2^31−1 setTimeout overflow (fires immediately)
const tag = 'dulo:auth';

export interface DuloStatus {
  signedIn: boolean;
  status: string; // mirrors PlaylistAuthDoc.status
  deviceActive: boolean;
  deviceBound: boolean; // activate-device has succeeded and this device holds the account slot
  deviceName: string | null;
  expiresAt: number | null;
  hasRefreshToken: boolean; // false = the capture omitted refresh_token, so the session cannot outlive `exp`
  nextRefreshAt: number | null; // ms epoch of the next scheduled proactive refresh (null = keepalive disarmed)
  sharedFamily: boolean; // session shares a refresh-token family with the user's own tab (rotation risk)
  refreshBackoffUntil: number | null; // ms epoch; a transient refresh failure is being backed off until then
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
  // The real browser UA at capture time (loginBrowser reads browser.userAgent()); replayed on server-side
  // API calls for coherence. Absent on the paste path → the module default UA is used.
  userAgent?: string | null;
  // Where the session came from: 'streamed' (dedicated throwaway browser context — its own refresh-token
  // family), or 'paste' / 'handoff' (shares the user's own tab's family → rotation-collision risk).
  origin?: 'streamed' | 'paste' | 'handoff' | null;
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
  return currentSupabaseUrl();
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
  // Proactive-keepalive state (see the keepalive section below): `keepaliveEnabled` is flipped by
  // start/stopKeepalive(); the timer/next-at pair is the armed beat, surfaced as status.nextRefreshAt.
  private keepaliveEnabled = false;
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveNextAt: number | null = null;

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
      anonKey: currentAnonKey(),
      deviceFingerprint: randomUUID(),
      deviceId: null,
      deviceName: DEVICE_NAME,
      deviceBound: false,
      userAgent: null,
      sharedFamily: false,
      refreshBackoffUntil: null,
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
    // The keepalive follows every state transition (all writes flow through save(), like the
    // isAuthenticated mirror above): token/backoff changes re-aim the timer; a sign-out or a dead
    // refresh token disarms it. See scheduleKeepalive().
    this.scheduleKeepalive(next);
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
      // Never null: falls through to the runtime-discovered / committed-seed value so paste/handoff sessions can still refresh.
      anonKey: currentAnonKey(payload.anonKey),
      userAgent: payload.userAgent ?? null,
      // paste/handoff sessions share the user's own tab's refresh-token family (rotation-collision risk);
      // a streamed-login session runs in a dedicated throwaway context with its own family.
      sharedFamily: payload.origin === 'paste' || payload.origin === 'handoff',
      refreshBackoffUntil: null,
      status: 'active',
      blockReason: null,
      lastError: null,
      // Default: clear the cached deviceId + bound flag so ensureDevice() re-activates under the new identity.
      deviceId: null,
      deviceBound: false,
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
      deviceBound: false,
      refreshBackoffUntil: null,
      sharedFamily: false,
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
    // Within the refresh margin. If a recent refresh failed transiently AND the current token is still
    // technically valid, ride the existing token rather than hammering Supabase during the backoff window.
    if (
      s.refreshBackoffUntil != null &&
      Date.now() < s.refreshBackoffUntil &&
      s.expiresAt != null &&
      s.expiresAt > Date.now()
    ) {
      return s.accessToken;
    }
    return this.runRefresh();
  }

  /** Single-flight wrapper around refresh() — shared by the lazy path (ensureFreshToken), the keepalive
   *  tick, and the play-path 401 retries, so concurrent callers coalesce onto one Supabase grant. */
  private runRefresh(): Promise<string> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  // Classify a refresh failure: TRANSIENT (network / 429 / 5xx) → keep the session 'active', set a backoff,
  // and ride the old token; PERMANENT (4xx invalid_grant / reused-or-rotated refresh token) → 'reauth_required'
  // with a precise lastError. This stops a momentary Supabase blip or a rotation-collision from silently
  // logging the user out, while still surfacing a genuine revocation as a clear, one-click re-auth.
  private async refresh(): Promise<string> {
    const s = await this.load();
    const firstKey = currentAnonKey(s.anonKey);
    if (!s.refreshToken || !s.supabaseUrl) {
      await this.save({ status: 'reauth_required', lastError: 'cannot refresh (missing refresh token / supabase url)' });
      throw new Error('cannot refresh session — re-authenticate with dulo');
    }
    const post = (key: string) =>
      fetch(`${s.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
        body: JSON.stringify({ refresh_token: s.refreshToken }),
      });
    // The anon key that will be persisted on success — corrected below if a rotated-key retry succeeds.
    let usedKey = firstKey;
    let res: Response;
    try {
      res = await post(firstKey);
      // Rotated-project self-heal. A 401 here is the apikey GATE rejecting the session's stored key after
      // dulo migrated Supabase projects — the refresh token itself isn't evaluated yet. Recover in two
      // tiers, adopting any response that clears the gate (a 400 invalid_grant means the key was fine and
      // the grant is the real problem → stop and surface it):
      //   A. the current best-known key (runtime-discovered cache / committed seed), no network, if it
      //      differs from the stored one;
      //   B. a live DISCOVERY of dulo's current bundle — but only usable when the discovered project URL
      //      matches THIS session's project (a different project means the refresh token is from a
      //      decommissioned project and is genuinely dead → fall through to reauth_required / re-paste).
      if (res.status === 401) {
        const tried = new Set([firstKey]);
        // Tier A — the current best-known key (discovered cache / committed seed), no network.
        const known = currentAnonKey(); // ignores the stored snapshot
        if (!tried.has(known)) {
          logger.warn(tag, 'refresh 401 at apikey gate — retrying with current known dulo Supabase key');
          res = await post(known);
          tried.add(known);
          if (res.status !== 401) usedKey = known;
        }
        // Tier B — live discovery, usable only for THIS session's project.
        if (res.status === 401) {
          const cfg = await discoverSupabaseConfig();
          if (cfg && cfg.supabaseUrl === s.supabaseUrl && !tried.has(cfg.anonKey)) {
            logger.warn(tag, 'refresh still 401 — retrying with freshly discovered dulo Supabase key');
            res = await post(cfg.anonKey);
            if (res.status !== 401) usedKey = cfg.anonKey;
          }
        }
      }
    } catch (err) {
      // Transient network failure — keep the session, back off, ride the old token if it hasn't expired.
      await this.save({
        refreshBackoffUntil: Date.now() + TRANSIENT_BACKOFF_MS,
        lastError: `refresh network error (will retry): ${(err as Error).message}`,
      });
      if (s.accessToken && (s.expiresAt == null || s.expiresAt > Date.now())) return s.accessToken;
      throw err;
    }
    if (res.status === 429 || res.status >= 500) {
      // Transient server-side failure — same treatment as a network blip.
      await this.save({
        refreshBackoffUntil: Date.now() + TRANSIENT_BACKOFF_MS,
        lastError: `refresh transient HTTP ${res.status} (will retry)`,
      });
      if (s.accessToken && (s.expiresAt == null || s.expiresAt > Date.now())) return s.accessToken;
      throw new Error(`session refresh temporarily unavailable (HTTP ${res.status})`);
    }
    if (!res.ok) {
      // Permanent rejection (e.g. 400 invalid_grant / refresh_token_not_found / already-used) — the refresh
      // token is dead (often a rotation collision with the user's own dulo tab). Prompt a precise re-auth.
      const body = (await res.text().catch(() => '')).slice(0, 200);
      await this.save({ status: 'reauth_required', refreshBackoffUntil: null, lastError: `refresh rejected (HTTP ${res.status}): ${body || 'no body'}` });
      throw new Error(`session refresh failed (HTTP ${res.status}) — re-authenticate`);
    }
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_at?: number;
      expires_in?: number;
    };
    if (!data.access_token) {
      await this.save({ status: 'reauth_required', refreshBackoffUntil: null, lastError: 'refresh returned no access_token' });
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
      anonKey: usedKey, // persists a rotated-key correction (a no-op when the stored key already worked)
      refreshBackoffUntil: null,
      status: 'active',
      lastError: null,
    });
    logger.ok(tag, usedKey !== firstKey ? 'refreshed access token (recovered rotated anon key)' : 'refreshed access token');
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
      const post = (token: string) =>
        fetch(`${getApiBase()}/live-tv/activate-device`, {
          method: 'POST',
          headers: browserHeaders(s.userAgent, { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }),
          body: JSON.stringify({ deviceFingerprint: s.deviceFingerprint, deviceName: s.deviceName || DEVICE_NAME }),
        });
      let res = await post(accessToken);
      if (res.status === 401) {
        // One forced refresh + retry: a 401 despite a locally-valid JWT means the token was invalidated
        // ahead of `exp` — recoverable iff the refresh token still works. A rejected forced refresh has
        // already flipped 'reauth_required' inside refresh().
        const fresh = await this.runRefresh().catch(() => null);
        if (fresh) res = await post(fresh);
      }
      if (res.status === 401) {
        await this.save({ status: 'reauth_required', deviceBound: false, lastError: 'activate-device 401 (after forced token refresh)' });
        throw new Error('device activation unauthorized — re-authenticate');
      }
      if (!res.ok) {
        await this.save({ deviceBound: false });
        throw new Error(`activate-device failed (HTTP ${res.status})`);
      }
      const data = (await res.json().catch(() => ({}))) as { device?: { id?: string; device_name?: string } };
      // Phase-0 finding: a self-invented server-side fingerprint is accepted here (dulo enforces
      // single-active-device, not client attestation), so this reliably binds the account slot to us.
      await this.save({
        deviceId: data.device?.id ?? null,
        deviceName: data.device?.device_name ?? s.deviceName ?? DEVICE_NAME,
        deviceBound: true,
        status: 'active',
      });
      logger.ok(tag, `device activated (${data.device?.id ?? 'no id returned'})`);
    })().finally(() => {
      this.activating = null;
    });
    await this.activating;
    return (await this.load()).deviceId ?? '';
  }

  /** Force a fresh device activation (drops the cached deviceId so ensureDevice re-registers our slot).
   *  Recovers a `device_mismatch` after another device evicted us, without a full re-sign-in. */
  async reactivateDevice(): Promise<DuloStatus> {
    await this.save({ deviceId: null, deviceBound: false });
    const token = await this.ensureFreshToken();
    await this.ensureDevice(token);
    return this.status();
  }

  /** Resolve a fresh, expiring playback master URL for one channel. Throws (→ proxy 502) on failure. */
  async resolvePlayback(channelId: string): Promise<{ playbackUrl: string; expiresAt: string | null }> {
    const token = await this.ensureFreshToken();
    const s = await this.ensureDeviceLoaded(token);
    const post = (tok: string) =>
      fetch(`${getApiBase()}/live-tv/playback-session`, {
        method: 'POST',
        headers: browserHeaders(s.userAgent, { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }),
        body: JSON.stringify({ deviceFingerprint: s.deviceFingerprint, channelId }),
      });
    let res = await post(token);
    if (res.status === 401) {
      // Same one-shot self-heal as ensureDevice(): force a refresh and retry once before declaring the
      // session dead (`s` needs no re-read — UA/fingerprint don't rotate with the token).
      const fresh = await this.runRefresh().catch(() => null);
      if (fresh) res = await post(fresh);
    }
    if (res.status === 401) {
      await this.save({ status: 'reauth_required', lastError: 'playback-session 401 (after forced token refresh)' });
      throw new Error('playback unauthorized — re-authenticate with dulo');
    }
    if (res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { block?: { reason?: string }; error?: string; reason?: string };
      const reason = body.block?.reason || body.error || body.reason || 'access blocked';
      // `device_mismatch` here means another device evicted our Live-TV slot (dulo is single-active-device).
      // Flag the device unbound so the UI can offer a one-click "Re-activate device" to reclaim it.
      const evicted = /device_mismatch|device/i.test(reason);
      await this.save({ status: 'blocked', blockReason: reason, ...(evicted ? { deviceBound: false } : {}) });
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
      deviceBound: !!s.deviceBound,
      deviceName: s.deviceName,
      expiresAt: s.expiresAt,
      hasRefreshToken: !!s.refreshToken,
      nextRefreshAt: this.keepaliveNextAt,
      sharedFamily: !!s.sharedFamily,
      refreshBackoffUntil: s.refreshBackoffUntil ?? null,
      blockReason: s.blockReason,
      lastError: s.lastError,
      updatedAt: s.updatedAt,
    };
  }

  // ── Proactive keepalive ─────────────────────────────────────────────────────────────────────────
  // Lazy refresh alone lets an idle session die: past `exp` with nobody playing, nothing rotates the
  // refresh token, and by the next viewing session the stored token can be generations stale (or the
  // family revoked outright) → manual re-paste. The keepalive refreshes KEEPALIVE_LEAD_MS ahead of
  // `exp`, indefinitely — once the capture tab is closed (WITHOUT signing out) the server is the
  // family's sole owner and keeps the session alive forever. It lives INSIDE the class because
  // rotations must land in this.cache via save(); save() is also the single choke point that
  // (re)aims/disarms the timer on every state transition.
  // NOTE single-process assumption: two servers sharing one playlistauths doc would rotate against
  // each other — the one that falls ≥2 generations behind trips Supabase's reuse detection and the
  // WHOLE family is revoked. Run one server per database.

  /** Arm from persisted state. Called once at boot (index.ts); idempotent. */
  async startKeepalive(): Promise<void> {
    this.keepaliveEnabled = true;
    this.cache = null; // authoritative DB read at boot
    this.scheduleKeepalive(await this.load());
    logger.info(
      tag,
      this.keepaliveNextAt
        ? `keepalive armed — next token refresh ${new Date(this.keepaliveNextAt).toISOString()}`
        : 'keepalive idle (no refreshable session)',
    );
  }

  /** Disarm + disable (graceful shutdown). */
  stopKeepalive(): void {
    this.keepaliveEnabled = false;
    this.disarmKeepalive();
  }

  /** Forget the in-memory doc AND re-derive the schedule from the DB. Call after an EXTERNAL write of
   *  the playlistauths row (playlist-delete cascade, backup restore) — otherwise the stale cache would
   *  resurrect the deleted doc via save()'s upsert and the timer would keep refreshing a dead session. */
  invalidate(): void {
    this.cache = null;
    if (!this.keepaliveEnabled) return;
    void this.load()
      .then((s) => this.scheduleKeepalive(s))
      .catch((err) => logger.warn(tag, `keepalive re-evaluate after invalidate failed: ${(err as Error).message}`));
  }

  private disarmKeepalive(): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = null;
    this.keepaliveNextAt = null;
  }

  /** (Re)aim the timer from a doc. Disarms when nothing is refreshable; KEEPS running while
   *  'blocked'/'error' (device eviction ≠ token death — the session stays warm so reclaiming the slot
   *  just works). A transient-failure backoff wins over the lead: retry just after it lapses. */
  private scheduleKeepalive(s: PlaylistAuthDoc): void {
    if (!this.keepaliveEnabled) return;
    if (!s.accessToken || !s.refreshToken || s.status === 'signed_out' || s.status === 'reauth_required' || s.expiresAt == null) {
      this.disarmKeepalive();
      return;
    }
    let at = s.expiresAt - KEEPALIVE_LEAD_MS;
    if (s.refreshBackoffUntil != null && s.refreshBackoffUntil > Date.now()) at = Math.max(at, s.refreshBackoffUntil + 1_000);
    const delay = Math.min(Math.max(at - Date.now(), KEEPALIVE_MIN_DELAY_MS), KEEPALIVE_MAX_ARM_MS);
    this.disarmKeepalive();
    this.keepaliveNextAt = Date.now() + delay;
    const timer = setTimeout(() => void this.keepaliveTick(), delay);
    if (typeof timer.unref === 'function') timer.unref(); // never keeps the process alive on its own
    this.keepaliveTimer = timer;
  }

  /** Bounded fallback beat for when a keepalive step failed BEFORE any classified state was persisted
   *  (a persisted outcome re-aims/disarms via save() → scheduleKeepalive on its own). */
  private armRetry(): void {
    if (!this.keepaliveEnabled || this.keepaliveTimer) return;
    this.keepaliveNextAt = Date.now() + TRANSIENT_BACKOFF_MS;
    const timer = setTimeout(() => void this.keepaliveTick(), TRANSIENT_BACKOFF_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.keepaliveTimer = timer;
  }

  /** One beat: re-read from Mongo BYPASSING the cache (picks up external deletes/restores — the cost is
   *  one findById per beat), refresh when inside the lead window, else re-aim. */
  private async keepaliveTick(): Promise<void> {
    this.keepaliveTimer = null;
    this.keepaliveNextAt = null;
    let s: PlaylistAuthDoc;
    try {
      this.cache = null;
      s = await this.load();
    } catch (err) {
      // Mongo blip before any decision could be made — nothing is armed and nothing was persisted, so
      // re-arm a bounded retry ourselves or the keepalive dies silently.
      logger.warn(tag, `keepalive re-read failed (retrying in ${TRANSIENT_BACKOFF_MS / 1000}s): ${(err as Error).message}`);
      this.armRetry();
      return;
    }
    if (!this.keepaliveEnabled) return;
    if (!s.accessToken || !s.refreshToken || s.status === 'signed_out' || s.status === 'reauth_required') return;
    if (s.expiresAt == null || s.expiresAt - Date.now() > KEEPALIVE_LEAD_MS) {
      this.scheduleKeepalive(s); // woke early (12h recheck / a play-path refresh rotated meanwhile) — re-aim
      return;
    }
    logger.info(tag, 'keepalive: refreshing access token ahead of expiry');
    await this.runRefresh().catch((err) => {
      // refresh() persists its classification, and that save() re-armed (transient) or disarmed
      // (permanent) the timer. If NEITHER landed (e.g. the Mongo write inside refresh() failed), the
      // beat would end with a live session and no timer — defensively re-arm a bounded retry.
      logger.warn(tag, `keepalive refresh failed: ${(err as Error).message}`);
      const st = this.cache?.status;
      if (st !== 'reauth_required' && st !== 'signed_out') this.armRetry();
    });
  }
}

export const duloAuth = new PlaylistAuthState('dulo');

// Boot/shutdown seam for index.ts (the repo's start*/stop* idiom — see logStore/streamTelemetry). The
// keepalive lives on the instance (rotations must land in its cache via save()), so these just delegate
// to the dulo singleton.
export function startDuloKeepalive(): Promise<void> {
  return duloAuth.startKeepalive();
}
export function stopDuloKeepalive(): void {
  duloAuth.stopKeepalive();
}
