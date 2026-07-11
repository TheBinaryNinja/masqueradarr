# Settings

Settings holds the workspace-wide configuration that affects the whole application. The most important
control here — the **Domain** — has wide-reaching effects, so it's worth understanding before you
change anything.

## What's on screen

Settings is split into a **General** tab and an **Advanced** tab. General holds the everyday knobs — your
public **Domain**, display name, time zone, DNS nameservers, appearance, and the built-in video player —
plus **backups** and **maintenance**. Advanced holds geolocation, source sign-in, and the default
**video/proxy** configuration. Changes save to the single application settings record.

## Key controls and where their effects ripple

- **Domain** — the public address players use to reach this server. This is **load-bearing**: it's
  built into every published playlist URL, so **changing the domain cascades and rewrites the URL of
  every playlist** automatically. Set it to your real public address once; only change it if the
  server's address genuinely changes (and expect every user's links to update as a result).
- **Time zone / locale** — controls how schedules and times are interpreted and displayed across the
  app, including the scheduler that runs your automatic syncs.
- **DNS nameservers** — the resolvers the server uses for its own outbound requests to providers. Leave
  the defaults unless a provider is only reachable through a specific resolver.
- **Video / proxy configuration** — the default streaming knobs (buffering, retries, output handling)
  applied to playback across the app. Individual playlists can **override** these from their own drawer, so
  this is the fallback every playlist inherits until it sets its own.
- **Source sign-in** — for sources that require an authenticated session, Settings is where you sign in.
  The app captures only the session tokens needed to resolve streams; your password goes straight to the
  provider, not into the app's database.
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
