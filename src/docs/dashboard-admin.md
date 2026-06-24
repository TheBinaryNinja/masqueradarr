# Dashboard (Admin)

The Dashboard is your landing screen and a live, at-a-glance health check of the whole system. As an
administrator you see the operational view: counters, your sources, and live activity.

## What's on screen

- **Stat cards** (top row) — quick counters that summarize the system: number of **Playlists**, total
  **Channels**, **Channels live**, **Channels down**, **EPG sources**, and **Unmatched** (channels with
  no guide link yet). These are computed from the data already loaded into the app; they update as
  syncs and streams change the underlying numbers.
- **Playlists panel** — each playlist source with its status, channel count, and its sync/compose
  schedule chips. The **schedule chips** reflect what you've configured on each playlist's schedule.
- **EPG Sources panel** — each guide source with its program counts and metadata.
- **Activity panel** (right) — two live sub-sections:
  - **Active Sessions** — who is watching right now, with bitrate and uptime. This is pushed live over
    a WebSocket, so it moves in real time without refreshing.
  - **History** — recently completed viewing sessions (last 24h).

## What drives the context you see

The stat cards and panels are **derived from synced data** — they only show real numbers once sources
have been synced. The Activity panel is **real-time telemetry**: sessions appear the instant a player
starts pulling a stream and clear when it stops. An empty Activity panel simply means nobody is
watching at this moment.

## Key controls and where they lead

- **Add playlist** (top-right of the header on this screen) — opens the Add Playlist flow. New sources
  show up immediately in the Playlists panel and on the **Playlists** screen.
- **View all / Add** buttons on the Playlists and EPG panels — jump to the full **Playlists** or
  **EPG Sources** screens, where the real management happens.
- Clicking a playlist or EPG source row opens its detail screen.

## How to read system health quickly

1. Glance at **Channels live** vs **Channels down** — a rising "down" count points to a source problem;
   open **Active Streams** or **View logs** to investigate.
2. Check **Unmatched** — a high number means channels lack guide data; head to **Channel Mapping** to
   link them.
3. Watch **Active Sessions** to confirm real viewers are connecting as expected.
