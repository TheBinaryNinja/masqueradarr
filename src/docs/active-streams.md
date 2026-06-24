# Active Streams

The Active Streams screen is a real-time monitor of everything currently being watched through the
server. It answers "who is streaming what, right now, and is it healthy?"

## What's on screen

Each active session appears as a row showing the **channel**, the **playlist/source** it came from, the
**viewer**, current **bitrate**, **uptime**, and a health indicator. Sessions appear the instant a
player starts pulling a stream and disappear shortly after it stops.

## What drives the context you see

This screen is **live telemetry pushed over a WebSocket** — there is no refresh button because it
updates itself continuously. The data is held in memory on the server (it is not a database report), so
it always reflects the present moment. Viewers are tracked by how recently their player polled the
stream, so a session that goes idle ages out on its own.

An **empty screen is normal** when nobody is watching — it does not indicate a problem.

## Reading session health

- A **healthy** session shows a steady bitrate and climbing uptime.
- A session flagged as failing (the "bad" state) is one the server couldn't keep fed — these are the
  ones worth investigating. They also drive the live pulse dot next to **Active Streams** in the
  sidebar.

## How to investigate a problem stream

1. Find the session flagged as unhealthy.
2. Note its channel and source.
3. Open **View logs** (sidebar) and filter to that source/category to see why the upstream stream
   failed or rebuffered.
4. Cross-check the channel on its **Playlist** detail screen — a channel that's gone **down** there is
   the root cause, not the player.

## Related screens

- **History / Metrics** — once a session ends, it's recorded there with full quality-of-experience
  detail.
- **Dashboard** — the Activity panel shows a compact version of this same live-session feed.
