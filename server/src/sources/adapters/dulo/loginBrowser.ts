// DuloLoginBrowser — a server-launched real Chromium, streamed into the SPA so the user signs in to the
// ACTUAL dulo.tv login page rendered server-side. Their password goes straight into dulo and never touches
// Masqueradarr (preserving the "tokens only, never a password" invariant in auth.ts / models/PlaylistAuth.ts). The
// resulting Supabase session is intercepted from the page's network (or localStorage) and handed to
// duloAuth.signIn() — the SAME capture pipeline the old bookmarklet fed, just without the bookmarklet.
//
// Transport: Chrome DevTools Protocol screencast (Page.startScreencast → screencastFrame JPEG over a
// WebSocket) driven via page.createCDPSession(). No VNC — CDP screencast handles the streaming; the
// browser runs HEADFUL under a virtual display (Xvfb in the Docker runtime) because Google's "Continue with
// Google" gate blocks headless. The same CDP session lets us read the token call off the page's network.
//
// Recon (2026-06-12, see the plan): dulo is a Vite SPA ("amri.gg"); its login is a full page at
// https://dulo.tv/login (email/password + Google/Discord OAuth); it stores the Supabase session under a
// CUSTOM `amri-*` localStorage key (NOT `sb-*-auth-token`); the Supabase URL/anon key live in the bundle and
// are not exposed before sign-in. So capture is host-agnostic (match the GoTrue token path, read the apikey
// header) and the localStorage fallback scans every key for a value carrying an access_token.
//
// Lifecycle is lazy + bounded: Chromium launches ONLY when a client attaches a WebSocket (never at boot —
// the puppeteer-core/puppeteer-extra/stealth imports are dynamic so a box without the browser still boots and
// just degrades this feature), a single session runs at a time, tearing down on capture / WS close / a time cap.
// The runtime browser + Xvfb dependency is documented in styles-backend.md's Docker contract.

import type { Browser, BrowserContext, Page, CDPSession, HTTPResponse, KeyInput } from 'puppeteer-core';
import { WebSocket } from 'ws';
import { duloAuth, type CapturePayload } from './auth.js';
import { logger } from '../../core/logger.js';

const tag = 'dulo:login';
const LOGIN_URL = 'https://dulo.tv/login';
const LIVE_URL = 'https://dulo.tv/live'; // navigated to after sign-in to provoke the client's activate-device
const APP_HOST = 'dulo.tv';
const VIEWPORT_W = 1280;
const VIEWPORT_H = 800;
const HARD_CAP_MS = 5 * 60_000; // a session may not linger past this, even if the WS stays open
const LS_POLL_MS = 1_500; // localStorage fallback poll interval
// After the Supabase token is captured we wait for dulo's own client to call activate-device so we can
// reuse its real deviceFingerprint (the fix for `device_mismatch`). The screencast stays live during this
// window so the user can confirm "use this device" if dulo prompts; on timeout we finalize token-only.
const DEVICE_WAIT_MS = 90_000;
const WS_BACKPRESSURE_BYTES = 8_000_000; // drop a frame rather than buffer unbounded when the client is slow

// puppeteer-extra's published types import from the full 'puppeteer' package, which we don't install (we use
// puppeteer-core). A minimal local launcher shape keeps us type-safe on what we actually call without dragging
// in that unresolved type dependency — the Browser it returns IS the puppeteer-core Browser.
type Launcher = {
  use(plugin: unknown): Launcher;
  launch(options: Record<string, unknown>): Promise<Browser>;
};

// The puppeteer-extra launcher (puppeteer-core + the stealth plugin) is built exactly once and module-cached —
// re-creating it / re-registering the plugin on every login session would stack the plugin's evasions.
let cachedLauncher: Launcher | null = null;

// ──────────────────────────────────────────────────────────────────────
// Outbound (server → client) message helpers — text JSON for control, binary for JPEG frames.
// ──────────────────────────────────────────────────────────────────────

type StreamState = 'connecting' | 'live' | 'captured' | 'busy' | 'error';

function sendJson(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket went away mid-send — teardown is handled by the close/error handlers */
    }
  }
}

function clamp(n: number, max: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > max ? max : n;
}

// ──────────────────────────────────────────────────────────────────────
// The session manager — one active session at a time.
// ──────────────────────────────────────────────────────────────────────

// Device identity intercepted from dulo's own activate-device call (request body + response).
interface DeviceCapture {
  deviceFingerprint?: string;
  deviceId?: string | null;
  deviceName?: string | null;
}

interface Session {
  ws: WebSocket;
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  cdp: CDPSession | null;
  captured: boolean; // the Supabase token has been captured (held in pendingToken)
  finalized: boolean; // signIn has run (or is running) — teardown follows
  provoked: boolean; // we've navigated to Live TV to trigger activate-device
  pendingToken: CapturePayload | null; // captured session, awaiting the device identity before signIn
  deviceCapture: DeviceCapture | null; // dulo's real device identity, once intercepted
  tornDown: boolean;
  hardCap: ReturnType<typeof setTimeout> | null;
  lsPoll: ReturnType<typeof setInterval> | null;
  deviceWait: ReturnType<typeof setTimeout> | null; // post-token deadline to finalize token-only
}

class DuloLoginBrowser {
  private current: Session | null = null;

  /** Wire a freshly-upgraded WebSocket to a streamed login session. Rejects a second concurrent client. */
  attach(ws: WebSocket): void {
    if (this.current) {
      sendJson(ws, { type: 'status', state: 'busy', message: 'a dulo login session is already in progress' });
      try {
        ws.close(1013, 'busy'); // 1013 = Try Again Later
      } catch {
        /* ignore */
      }
      return;
    }

    const session: Session = {
      ws,
      browser: null,
      context: null,
      page: null,
      cdp: null,
      captured: false,
      finalized: false,
      provoked: false,
      pendingToken: null,
      deviceCapture: null,
      tornDown: false,
      hardCap: null,
      lsPoll: null,
      deviceWait: null,
    };
    this.current = session;

    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // we never expect binary from the client
      void this.handleInput(session, data.toString());
    });
    ws.on('close', () => void this.teardown(session, 'ws_close'));
    ws.on('error', () => void this.teardown(session, 'ws_error'));

    sendJson(ws, { type: 'status', state: 'connecting' });
    void this.launch(session);
  }

  /** Tear down the single active session (called by shutdown()). */
  async closeAll(): Promise<void> {
    if (this.current) await this.teardown(this.current, 'shutdown');
  }

  // ── internals ──────────────────────────────────────────────────────

  private async launch(session: Session): Promise<void> {
    let puppeteer: Launcher;
    try {
      // Dynamic import so module load (and server boot) never depends on the browser/plugins being present.
      // puppeteer-extra wraps puppeteer-core (no bundled browser — we point it at the distro Chromium installed
      // in the Docker image via CHROMIUM_PATH) and lets us layer puppeteer-extra-plugin-stealth's maintained
      // evasions (Sec-CH-UA client hints, codecs, iframe.contentWindow, hardwareConcurrency, …) on its NATIVE
      // rails — a superset of the hand-rolled init script this used to carry. Built once + module-cached. The
      // import namespace is cast to a minimal shape (see `Launcher`) so puppeteer-extra's 'puppeteer' type
      // dependency never has to resolve.
      if (cachedLauncher) {
        puppeteer = cachedLauncher;
      } else {
        const { addExtra } = (await import('puppeteer-extra')) as unknown as { addExtra(p: unknown): Launcher };
        const puppeteerCore = (await import('puppeteer-core')).default;
        const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
        puppeteer = addExtra(puppeteerCore);
        puppeteer.use(StealthPlugin());
        cachedLauncher = puppeteer;
      }
    } catch (err) {
      logger.warn(tag, `puppeteer unavailable: ${(err as Error).message}`);
      sendJson(session.ws, { type: 'status', state: 'error', message: 'streamed login unavailable (browser engine not installed)' });
      await this.teardown(session, 'no_puppeteer');
      return;
    }

    try {
      session.browser = await puppeteer.launch({
        // executablePath points at the distro Chromium baked into the Docker image (CHROMIUM_PATH: Debian's apt
        // /usr/bin/chromium — same path in app.Dockerfile and aio.Dockerfile, both bookworm). puppeteer-core
        // ships NO bundled browser, so this must resolve to a real binary; if unset the launch throws and the
        // feature degrades cleanly (caught below). HEADFUL: running headed (under Xvfb in the Docker runtime) is the
        // biggest lever against Google's "Continue with Google" gate after navigator.webdriver.
        // --disable-blink-features=AutomationControlled still drops the webdriver flag. (--disable-gpu is gone on
        // purpose — it forced a software "SwiftShader" WebGL renderer, itself a bot tell.) NO --disable-web-security:
        // it's a detectable anomaly + a security risk. --lang=en-US keeps Accept-Language self-consistent.
        executablePath: process.env.CHROMIUM_PATH || undefined,
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--lang=en-US',
        ],
      });
      // Deliberately NOT setting userAgent: a hardcoded UA (auth.ts's Chrome/124) mismatched the Chromium build
      // and the real Sec-CH-UA client hints, a strong bot signal. The native UA is self-consistent and the stealth
      // plugin normalizes the residual UA/client-hint tells. (auth.ts keeps a UA for the server-side dulo API calls
      // — that path is unaffected.) The former manual navigator.webdriver/plugins/permissions/WebGL init script was
      // removed: the stealth plugin covers those evasions, and re-defining them on top can throw. Puppeteer takes
      // viewport/locale/timezone at the PAGE level (no newContext options equivalent), so set them right after the
      // page opens, before any navigation.
      session.context = await session.browser.createBrowserContext();
      const page = await session.context.newPage();
      session.page = page;
      await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1 });
      await page.emulateTimezone('America/New_York');
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    } catch (err) {
      logger.error(tag, `launch failed: ${(err as Error).message}`);
      sendJson(session.ws, { type: 'status', state: 'error', message: 'failed to start the login browser' });
      await this.teardown(session, 'launch_error');
      return;
    }

    // Capture the Supabase token off the page network — works for the main frame and any OAuth popup.
    session.page.on('response', (res) => void this.onResponse(session, res));
    session.page.on('popup', (popup) => {
      popup?.on('response', (res) => void this.onResponse(session, res));
    });

    await this.startScreencast(session);

    // Hard cap so an abandoned session can never pin a Chromium open indefinitely.
    session.hardCap = setTimeout(() => {
      sendJson(session.ws, { type: 'status', state: 'error', message: 'login session timed out' });
      void this.teardown(session, 'hard_cap');
    }, HARD_CAP_MS);

    // localStorage fallback: covers an already-signed-in account where no fresh token call fires.
    session.lsPoll = setInterval(() => void this.pollLocalStorage(session), LS_POLL_MS);

    sendJson(session.ws, { type: 'meta', w: VIEWPORT_W, h: VIEWPORT_H });
    sendJson(session.ws, { type: 'status', state: 'live' });

    try {
      await session.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      // Don't fail the session on a slow/blocked nav — the screencast shows whatever rendered (incl. a
      // bot-gate/CAPTCHA the user can solve live).
      logger.warn(tag, `initial navigation issue: ${(err as Error).message}`);
    }
  }

  private async startScreencast(session: Session): Promise<void> {
    const { page, ws } = session;
    if (!page || !session.context) return;
    try {
      session.cdp = await page.createCDPSession();
      session.cdp.on('Page.screencastFrame', (frame: { data: string; sessionId: number }) => {
        // Ack first (always) — an un-acked frame stalls the whole screencast.
        session.cdp?.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > WS_BACKPRESSURE_BYTES) return; // client is behind — drop this frame
        try {
          ws.send(Buffer.from(frame.data, 'base64'));
        } catch {
          /* ignore — close/error handler will tear down */
        }
      });
      await session.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 60,
        maxWidth: VIEWPORT_W,
        maxHeight: VIEWPORT_H,
        everyNthFrame: 1,
      });
    } catch (err) {
      logger.error(tag, `screencast failed: ${(err as Error).message}`);
      sendJson(ws, { type: 'status', state: 'error', message: 'failed to start the screen stream' });
      await this.teardown(session, 'screencast_error');
    }
  }

  // ── input forwarding (client → page) ───────────────────────────────

  private async handleInput(session: Session, raw: string): Promise<void> {
    const page = session.page;
    if (!page || session.tornDown) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    try {
      if (msg.type === 'mouse') {
        const x = clamp(Number(msg.x), VIEWPORT_W);
        const y = clamp(Number(msg.y), VIEWPORT_H);
        const button = (['left', 'middle', 'right'][Number(msg.button) || 0] ?? 'left') as 'left' | 'middle' | 'right';
        if (msg.action === 'move') await page.mouse.move(x, y);
        else if (msg.action === 'down') {
          await page.mouse.move(x, y);
          await page.mouse.down({ button });
        } else if (msg.action === 'up') await page.mouse.up({ button });
        else if (msg.action === 'wheel') await page.mouse.wheel({ deltaX: Number(msg.dx) || 0, deltaY: Number(msg.dy) || 0 });
      } else if (msg.type === 'key') {
        const key = typeof msg.key === 'string' ? msg.key : '';
        if (!key) return;
        // A single printable char → sendCharacter (dispatches keypress+input for that char, no key-code
        // mapping / modifier tracking — Puppeteer's analog of Playwright's insertText, handles case/symbols).
        // A named key (Enter/Backspace/Tab/Arrow…) → press it.
        if (key.length === 1) await page.keyboard.sendCharacter(key);
        else await page.keyboard.press(key as KeyInput).catch(() => {});
      } else if (msg.type === 'close') {
        await this.teardown(session, 'client_close');
      }
    } catch {
      /* a stray input after teardown / navigation — ignore */
    }
  }

  // ── token + device capture ─────────────────────────────────────────
  // Two things must be captured for streaming to work: (1) the Supabase session token, and (2) the device
  // identity dulo's OWN client registers (it binds playback to that fingerprint — a self-invented UUID gets
  // `device_mismatch`). So token capture no longer signs in immediately; it holds the token, navigates to
  // Live TV to provoke dulo's activate-device, and finalize() runs once the device identity is intercepted
  // (or a timeout elapses → token-only, the prior behavior).

  private async onResponse(session: Session, res: HTTPResponse): Promise<void> {
    if (session.tornDown) return;
    const url = res.url();

    // 1. dulo's device activation — capture its real deviceFingerprint (request) + deviceId/name (response).
    if (/\/live-tv\/activate-device\b/.test(url)) {
      await this.onActivateDevice(session, res);
      return;
    }
    // 2. dulo's playback session — diagnostic only: log the request KEY NAMES (no values) so a future
    //    protocol change is visible in the server log. dulo's client may fire this on a Live TV preview.
    if (/\/live-tv\/playback-session\b/.test(url)) {
      this.logPlaybackShape(res);
      return;
    }

    // 3. GoTrue session endpoints (host-agnostic — *.supabase.co, a custom auth domain, or proxied):
    //    password/pkce/id_token grants hit /auth/v1/token; magic links hit /auth/v1/verify.
    if (session.captured) return;
    if (!/\/auth\/v1\/(token|verify)\b/.test(url) && !/\/token\?(?:[^#]*&)?grant_type=/.test(url)) return;
    let body: { access_token?: string; refresh_token?: string; expires_at?: number; expires_in?: number };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return; // not JSON (e.g. an error/redirect) — wait for the real token response
    }
    if (!body || typeof body.access_token !== 'string' || !body.access_token) return;

    let supabaseUrl: string | null = null;
    let anonKey: string | null = null;
    try {
      const u = new URL(url);
      // Only trust the response origin as the GoTrue base when it isn't the dulo app host (where it'd be a
      // proxied path); otherwise let duloAuth.signIn derive the base from the JWT `iss` claim.
      if (u.host !== APP_HOST) supabaseUrl = u.origin;
      anonKey = res.request().headers()['apikey'] ?? null;
    } catch {
      /* ignore — signIn backfills from the JWT */
    }

    await this.onTokenCaptured(session, {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresAt: body.expires_at ?? body.expires_in ?? null,
      supabaseUrl,
      anonKey,
    });
  }

  /** Intercept dulo's activate-device: read the fingerprint it sends + the deviceId it gets back. */
  private async onActivateDevice(session: Session, res: HTTPResponse): Promise<void> {
    if (session.finalized) return;
    const cap: DeviceCapture = { ...(session.deviceCapture ?? {}) };
    try {
      const post = res.request().postData();
      if (post) {
        const reqBody = JSON.parse(post) as { deviceFingerprint?: string; deviceName?: string };
        if (typeof reqBody.deviceFingerprint === 'string' && reqBody.deviceFingerprint) {
          cap.deviceFingerprint = reqBody.deviceFingerprint;
        }
        if (cap.deviceName == null && typeof reqBody.deviceName === 'string') cap.deviceName = reqBody.deviceName;
      }
    } catch {
      /* no/!JSON body — fingerprint stays unset */
    }
    try {
      const data = (await res.json()) as { device?: { id?: string; device_name?: string } };
      if (data?.device) {
        cap.deviceId = data.device.id ?? null;
        if (typeof data.device.device_name === 'string') cap.deviceName = data.device.device_name;
      }
    } catch {
      /* non-JSON (e.g. an error) response — deviceId stays unset */
    }
    if (!cap.deviceFingerprint && cap.deviceId == null) return; // nothing useful captured
    session.deviceCapture = cap;
    logger.info(
      tag,
      `captured dulo device identity (fingerprint=${cap.deviceFingerprint ? 'yes' : 'no'}, id=${cap.deviceId ?? 'none'})`,
    );
    if (session.pendingToken) await this.finalize(session); // token already in hand → done
  }

  /** Diagnostic: log dulo's playback-session request shape (key names only, never values). */
  private logPlaybackShape(res: HTTPResponse): void {
    try {
      const post = res.request().postData();
      if (!post) return;
      const keys = Object.keys(JSON.parse(post) as Record<string, unknown>).sort().join(',');
      logger.info(tag, `dulo playback-session request keys: [${keys}] (status ${res.status()})`);
    } catch {
      /* ignore */
    }
  }

  /** Hold the captured token, then wait for the device identity before signing in. */
  private async onTokenCaptured(session: Session, payload: CapturePayload): Promise<void> {
    if (session.captured || session.tornDown) return;
    session.captured = true;
    session.pendingToken = payload;
    sendJson(session.ws, {
      type: 'status',
      state: 'live',
      message: 'Signed in — finishing device setup. If dulo asks, choose to use this device.',
    });
    if (session.deviceCapture) {
      await this.finalize(session); // device already intercepted (rare ordering) → done
      return;
    }
    this.startDeviceWait(session);
    void this.provokeDeviceActivation(session);
  }

  /** Navigate to Live TV so dulo's client registers (activate-device) the device we then reuse. */
  private async provokeDeviceActivation(session: Session): Promise<void> {
    if (session.provoked || session.finalized || session.tornDown) return;
    session.provoked = true;
    const page = session.page;
    if (!page) return;
    // Let dulo's SPA persist the session to localStorage before a full reload, so the reloaded /live page
    // finds the session instead of bouncing back to /login.
    await new Promise((r) => setTimeout(r, 1500));
    if (session.finalized || session.tornDown) return; // device captured (or torn down) during the wait
    try {
      await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      // The screencast still shows whatever rendered (incl. a "use this device" prompt the user can click).
      logger.warn(tag, `live-tv navigation issue (device provoke): ${(err as Error).message}`);
    }
  }

  /** After the token lands, bound how long we wait for activate-device before finalizing token-only. */
  private startDeviceWait(session: Session): void {
    if (session.deviceWait) return;
    session.deviceWait = setTimeout(() => {
      if (session.finalized || session.tornDown) return;
      logger.warn(tag, 'device activation not observed before timeout — finalizing token-only (playback may need re-auth)');
      void this.finalize(session);
    }, DEVICE_WAIT_MS);
  }

  /** Sign in with the captured token + (when available) dulo's real device identity, then tear down. */
  private async finalize(session: Session): Promise<void> {
    if (session.finalized || session.tornDown) return;
    if (!session.pendingToken) return; // need a token before we can store anything
    session.finalized = true;
    if (session.deviceWait) {
      clearTimeout(session.deviceWait);
      session.deviceWait = null;
    }
    const payload: CapturePayload = { ...session.pendingToken, ...(session.deviceCapture ?? {}) };
    try {
      const status = await duloAuth.signIn(payload);
      const how = session.deviceCapture?.deviceFingerprint ? 'with device identity' : 'token-only';
      logger.ok(tag, `captured dulo session via streamed login (${how})`);
      sendJson(session.ws, { type: 'captured', status });
      sendJson(session.ws, { type: 'status', state: 'captured' });
    } catch (err) {
      logger.error(tag, `signIn after capture failed: ${(err as Error).message}`);
      sendJson(session.ws, { type: 'status', state: 'error', message: 'captured the session but failed to store it' });
    } finally {
      // Give the socket a tick to flush the status frames, then tear down.
      setTimeout(() => void this.teardown(session, 'captured'), 250);
    }
  }

  private async pollLocalStorage(session: Session): Promise<void> {
    const page = session.page;
    if (!page || session.captured || session.tornDown) return;
    let found: { accessToken: string; refreshToken: string | null; expiresAt: number | null } | null = null;
    try {
      found = await page.evaluate(() => {
        for (const k of Object.keys(localStorage)) {
          const v = localStorage.getItem(k);
          if (!v || v.indexOf('access_token') === -1) continue;
          try {
            const o = JSON.parse(v);
            const s = o?.currentSession ?? o?.session ?? o;
            if (s && typeof s.access_token === 'string' && s.access_token) {
              return {
                accessToken: s.access_token as string,
                refreshToken: (s.refresh_token as string) ?? null,
                expiresAt: (s.expires_at as number) ?? null,
              };
            }
          } catch {
            /* not the session blob */
          }
        }
        return null;
      });
    } catch {
      return; // page navigating/closed — try again next tick
    }
    if (found) {
      // No anonKey/supabaseUrl available from localStorage — signIn derives the base from the JWT `iss` and
      // falls back to DULO_SUPABASE_ANON_KEY for the anon key (refresh may need a later re-capture; the
      // network path above carries the anonKey on a fresh sign-in, which is the common case).
      await this.onTokenCaptured(session, { ...found, supabaseUrl: null, anonKey: null });
    }
  }

  private async teardown(session: Session, reason: string): Promise<void> {
    if (session.tornDown) return;
    session.tornDown = true;
    if (this.current === session) this.current = null;
    if (session.hardCap) clearTimeout(session.hardCap);
    if (session.lsPoll) clearInterval(session.lsPoll);
    if (session.deviceWait) clearTimeout(session.deviceWait);
    try {
      await session.cdp?.send('Page.stopScreencast').catch(() => {});
    } catch {
      /* ignore */
    }
    try {
      await session.context?.close();
    } catch {
      /* ignore */
    }
    try {
      await session.browser?.close();
    } catch {
      /* ignore */
    }
    try {
      if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
        session.ws.close(1000, reason);
      }
    } catch {
      /* ignore */
    }
    logger.info(tag, `session torn down (${reason})`);
  }
}

export const duloLoginBrowser = new DuloLoginBrowser();
