# Settings

Settings holds the workspace-wide configuration that affects the whole application. The most important
control here — the **Domain** — has wide-reaching effects, so it's worth understanding before you
change anything.

## What's on screen

Settings is split into three tabs. **General** holds the everyday knobs — your public **Domain**,
display name, time zone, DNS nameservers, and appearance — plus **backups** and **maintenance**.
**Video Config** gathers everything about playback: the **channel probe scheduler**, the
**video player** (standard, **Ultimate**, or **Debug**), and the default **video / proxy engine** every
playlist inherits. **Advanced** holds **geolocation**, the **Playlist Domain / Configuration** JSON, source
sign-in, and the **Custom Tags** manager. Changes save to the single application settings record.

## Key controls and where their effects ripple

- **Domain** — the public address players use to reach this server. This is **load-bearing**: it's
  built into every published playlist URL, so **changing the domain cascades and rewrites the URL of
  every playlist** automatically. Set it to your real public address once; only change it if the
  server's address genuinely changes (and expect every user's links to update as a result).
- **Time zone / locale** — controls how schedules and times are interpreted and displayed across the
  app, including the scheduler that runs your automatic syncs.
- **DNS nameservers** — the resolvers the server uses for its own outbound requests to providers. Leave
  the defaults unless a provider is only reachable through a specific resolver.
- **Video player** (on the **Video Config** tab) — which player the channel slide-out preview uses:
  - **In-app video player** — the standard player embedded in the slide-out.
  - **Ultimate video player** — the slide-out's player and bitrate chart are replaced by a single **Launch
    Ultimate Video Player** button that opens a dedicated player window: full-size video, the channel list
    and guide for the playlist you launched from, a channel switcher you can pull out from the right edge,
    and a **what's on now / next** strip under the picture. Best when you actually want to *watch* a
    channel rather than glance at it. Allow pop-ups for this site or the window can't open.
    This setting only governs the **slide-out**. The **play button** on every playlist row — on Playlists
    and on the Dashboard's Playlists panel — opens the Ultimate player scoped to that playlist whatever
    this is set to, so you can leave the slide-out on the in-app player and still launch the big one.
    The channel switcher lists channels **A–Z by name**; the **A–Z** button in its header flips it to
    **channel-number** order (**#**), with unnumbered channels last. Channel numbers come from the provider
    and are often meaningless in a clone playlist, which is why name order is the default; your choice is
    remembered in this browser. Sound is on by default and your volume / mute choice is remembered between
    channels and windows. If the browser blocks audio on load — most do, until you've interacted with the
    page — the picture says so and one click on that banner (or the **M** key) turns sound on. The window
    opens without a tab strip, toolbar or bookmarks bar; the thin strip showing the site address is forced
    on by the browser itself and can't be turned off from the app, so use **Full screen** (or the **F** key)
    for a completely bare window.
  - **Debug video player** — adds a live hls.js status readout and event log. Reach for it only when a
    channel won't play; it shows exactly where the stream stalls.

  This only affects the preview inside this app, never what your users' own players do.
- **Video / proxy engine** (on the **Video Config** tab) — the default streaming knobs (buffering, retries,
  output handling) applied to playback across the app. Individual playlists can **override** these from their
  own drawer, so this is the fallback every playlist inherits until it sets its own.
- **Source sign-in** — for sources that require an authenticated session, Settings is where you sign in.
  The app captures only the session tokens needed to resolve streams; your password goes straight to the
  provider, not into the app's database.
- **Playlist Domain / Configuration** (on the **Advanced** tab) — one JSON document, shown with syntax
  colouring, holding the per-playlist settings for **DaddyLive**, **Dulo.tv** and **ZLive**. Each entry has:
  - `enable` — `false` **hides** that playlist: it disappears from **Add Playlist** and its settings are hidden
    (for Dulo.tv, the sign-in card). A playlist you already added keeps syncing and playing.
  - `domain` — the site the provider runs on today, as a bare host. When a provider moves, change it
    here and re-Sync the playlist. For Dulo.tv, saving a new domain **signs the dulo session out** (you'll be
    warned first) because a session belongs to the site it came from.
  - `extendedProperties` — the provider's own options: DaddyLive's `defaultPlayer` (`"auto"` or a player
    number — its players are independent providers, and a per-channel choice in the channel editor still
    wins) and ZLive's `concurrency` (how many different ZLive channels may play at once; `0` = no limit).

  **Test** checks every listed domain — using what's in the editor, saved or not — and reports, per provider,
  the address tried, the HTTP status, the response time and how many channels it serves. **Save** applies the
  whole document at once; mistakes are listed by path (for example `zlive.extendedProperties.concurrency`) and
  nothing is saved until they're fixed. The saved document is kept with your settings and backups, and mirrored
  to `playlist-config.json` on the server.
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
