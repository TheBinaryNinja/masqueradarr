# Settings

Settings holds the workspace-wide configuration that affects the whole application. The most important
control here — the **Domain** — has wide-reaching effects, so it's worth understanding before you
change anything.

## What's on screen

The workspace settings, grouped by area: your public **Domain**, time/locale options, source
authentication (where applicable), and appearance. Changes save to the single application settings
record.

## Key controls and where their effects ripple

- **Domain** — the public address players use to reach this server. This is **load-bearing**: it's
  built into every published playlist URL, so **changing the domain cascades and rewrites the URL of
  every playlist** automatically. Set it to your real public address once; only change it if the
  server's address genuinely changes (and expect every user's links to update as a result).
- **Time zone / locale** — controls how schedules and times are interpreted and displayed across the
  app, including the scheduler that runs your automatic syncs.
- **Source sign-in (dulo login)** — for sources that require an authenticated session, Settings is
  where you sign in. The app captures only the session tokens needed to resolve streams; your password
  goes straight to the provider, not to TVApp2's database.
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
