// dulo browser-handoff PAIRING — the durable path for Google/Discord/social accounts.
//
// Google (and other social IdPs) block sign-in inside any automated/embedded browser BY DESIGN, so the only
// durable way to authenticate a social dulo account is to let the user sign in with their OWN real browser
// (where Google just works) and hand the resulting Supabase session back to masqueradarr. This module mints a
// short-lived, single-use PAIRING CODE and builds the one-click bookmarklet / console snippet the user runs on
// dulo.tv to POST their session to the code-gated callback (routes/sources.ts).
//
// SECURITY: the bookmarklet carries only the pairing CODE (high-entropy, single-use, ~10-min TTL) + the
// callback URL — NEVER the admin's session token. A leaked code can at most establish dulo auth on THIS
// instance within its short window, once. The callback route itself is unauthenticated (escapes the admin
// gate) precisely so the user's own browser can reach it; the code is the bearer.

import { randomBytes } from 'node:crypto';

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const codes = new Map<string, number>(); // code → expiresAt (ms epoch)

function sweep(now: number): void {
  for (const [code, exp] of codes) if (exp <= now) codes.delete(code);
}

export const duloPairing = {
  /** Mint a fresh single-use pairing code. */
  mint(): { code: string; expiresAt: number } {
    const now = Date.now();
    sweep(now);
    const code = randomBytes(24).toString('base64url'); // 32 url-safe chars, ~192 bits
    const expiresAt = now + CODE_TTL_MS;
    codes.set(code, expiresAt);
    return { code, expiresAt };
  },

  /** Atomically validate + consume a code. Returns true only if it was present and unexpired. */
  consume(code: string): boolean {
    if (!code) return false;
    const now = Date.now();
    const exp = codes.get(code);
    if (exp == null) return false;
    codes.delete(code); // single-use — always remove on a hit
    return exp > now;
  },
};

// The client-side harvester: find the dulo Supabase session in localStorage, then POST it to the code-gated
// callback — falling back to copying it to the clipboard when a direct POST can't work (mixed content on a
// plain-http LAN instance, or a network/CORS failure). Built server-side with the code + callback baked in via
// JSON.stringify (safe escaping). Runs on dulo.tv, so masqueradarr's CSP never applies to it.
function harvesterBody(code: string, callbackUrl: string): string {
  const CB = JSON.stringify(callbackUrl);
  const CODE = JSON.stringify(code);
  return (
    `(function(){var CB=${CB},CODE=${CODE};` +
    `function f(){for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i),v=localStorage.getItem(k);` +
    `if(v&&v.indexOf("access_token")>-1){try{var o=JSON.parse(v),s=o.currentSession||o.session||o;` +
    `if(s&&s.access_token)return s}catch(e){}}}return null}` +
    `var s=f();if(!s){alert("Sign in to dulo.tv first, then run this again.");return}` +
    `function clip(){var t=JSON.stringify({access_token:s.access_token,refresh_token:s.refresh_token,expires_at:s.expires_at});` +
    `(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){` +
    `alert("Copied your dulo session. Paste it into masqueradarr under Paste session.")},function(){` +
    `prompt("Copy this, then paste into masqueradarr under Paste session:",t)})}` +
    `var mixed=location.protocol==="https:"&&CB.indexOf("http:")===0;if(mixed){clip();return}` +
    `fetch(CB,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({` +
    `code:CODE,accessToken:s.access_token,refreshToken:s.refresh_token||null,expiresAt:s.expires_at||null,` +
    `userAgent:navigator.userAgent})}).then(function(r){r.ok?` +
    `alert("Connected to masqueradarr! You can close this tab."):` +
    `(alert("Pairing failed ("+r.status+") — copying your session instead."),clip())}).catch(function(){clip()})})();`
  );
}

/** A draggable `javascript:` bookmarklet (drag to the bookmarks bar, click on dulo.tv). */
export function buildBookmarklet(code: string, callbackUrl: string): string {
  return 'javascript:' + encodeURIComponent(harvesterBody(code, callbackUrl));
}

/** The same harvester as a raw snippet to paste into the browser DevTools console. */
export function buildSnippet(code: string, callbackUrl: string): string {
  return harvesterBody(code, callbackUrl);
}
