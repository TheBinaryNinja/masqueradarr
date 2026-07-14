# Settings

Settings holds the workspace-wide configuration that affects the whole application. The most important
control here — the **Domain** — has wide-reaching effects, so it's worth understanding before you
change anything.

## What's on screen

Settings is split into three tabs. **General** holds the everyday knobs — your public **Domain**,
display name, time zone, DNS nameservers, and appearance — plus **backups** and **maintenance**.
**Video Config** gathers everything about playback: the **channel probe scheduler**, the in-app
**video player** (standard or **Debug**), and the default **video / proxy engine** every playlist
inherits. **Advanced** holds **geolocation**, source sign-in, the **DaddyLive Player Source** default,
and the **Custom Tags** manager. Changes save to the single application settings record.

## Key controls and where their effects ripple

- **Domain** — the public address players use to reach this server. This is **load-bearing**: it's
  built into every published playlist URL, so **changing the domain cascades and rewrites the URL of
  every playlist** automatically. Set it to your real public address once; only change it if the
  server's address genuinely changes (and expect every user's links to update as a result).
- **Time zone / locale** — controls how schedules and times are interpreted and displayed across the
  app, including the scheduler that runs your automatic syncs.
- **DNS nameservers** — the resolvers the server uses for its own outbound requests to providers. Leave
  the defaults unless a provider is only reachable through a specific resolver.
- **Video player** (on the **Video Config** tab) — which player the channel slide-out preview uses: the
  standard **In-app** player, or a **Debug** player that adds a live hls.js status readout and event log.
  Reach for Debug only when a channel won't play in the app; it shows exactly where the stream stalls. This
  only affects the in-app preview, never what your users' own players do.
- **Video / proxy engine** (on the **Video Config** tab) — the default streaming knobs (buffering, retries,
  output handling) applied to playback across the app. Individual playlists can **override** these from their
  own drawer, so this is the fallback every playlist inherits until it sets its own.
- **Source sign-in** — for sources that require an authenticated session, Settings is where you sign in.
  The app captures only the session tokens needed to resolve streams; your password goes straight to the
  provider, not into the app's database.
- **DaddyLive Player Source** (on the **Advanced** tab) — DaddyLive channels each expose several
  interchangeable **players** (redundant feeds of the same stream). This sets the workspace **default**:
  **Auto** uses Player 1 and falls back through the rest if it's down, or you can pin a specific Player
  **1–6**. Override it for one channel from the channel editor (**Playlists → open a channel → Player
  source**).
- **Custom Tags** (on the **Advanced** tab) — create, rename, and delete the app-wide labels you assign to
  playlists, sources, and channels. See **Custom Tags** for the full picture.
- **Backup & restore** — generate a **full-system backup** (a single gzip file you download) any time, or
  schedule one to be written to disk automatically. **Restore** from an uploaded file or a saved one to roll
  the whole workspace back.
- **Maintenance** — housekeeping actions: **rebuild database indexes** across every collection, and a
  danger-zone **reset** that wipes the workspace clean. Use these deliberately.
- **Theme / appearance** — light or dark mode and related display tweaks. (The dark-mode toggle in the
  top bar is the same setting.)

## What drives the context you see

Settings is a single, persisted configuration record. It's seeded from environment defaults on first
boot if empty, then whatever you save here wins. Source sign-in options only appear for sources that
actually need authentication.

## How to point the app at your real address

1. Open **Settings** and set **Domain** to your public URL (for example `https://tv.example.com`).
2. Save. The app rewrites every playlist's published URL to use the new domain.
3. Verify on a **Playlist** (or a user's Dashboard) that the integration URLs now show the new domain.

> **Caution:** Because the domain change rewrites all playlist URLs, any links your users have already
> saved in their players will point at the old address until they re-copy the updated URLs.

## Related screens

- **Playlists** — whose URLs the domain setting rewrites.
- **Users** — each user's integration URLs are built from this domain plus their token.
- **Custom Tags** — the app-wide labels managed here, in the Advanced tab's Custom Tags card.
