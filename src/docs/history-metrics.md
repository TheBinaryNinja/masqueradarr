# History / Metrics

This screen is your streaming **quality-of-experience (QoE) analytics** dashboard. Where Active Streams
shows the present, History / Metrics shows the past: every completed viewing session and what the
experience was like.

## What's on screen

- **Stat cards** — headline totals across the recorded history (sessions, viewers, data served, and
  similar rollups).
- **Buffer histogram** — a distribution of buffering events, so you can see at a glance whether streams
  generally play smoothly or stutter.
- **Problem channels** — the channels with the worst experience, surfaced so you can fix the noisy few.
- **Session table** — every recorded session; selecting a row opens a **session-detail** panel with the
  full timeline for that view.
- **View modes** — a toggle between **Sessions** (individual views) and **User Metrics** (rolled up
  per user), so you can analyze either by event or by person.

## What drives the context you see

Every session here comes from **persisted view-session history** — when a live stream ends, it's
written to the database with its quality detail, then aggregated for these views. So this screen grows
over time and reflects real past usage; a fresh install with no completed streams will be empty.

## Key controls and what they do

- **Sessions / User Metrics toggle** — switches the whole screen between per-session and per-user
  rollup presentations of the same underlying history.
- **Selecting a session row** — opens the detail panel; close it to return to the table.
- **Problem-channels entries** — point you at the channels to prioritize; cross-reference them on
  **Playlists** or **Channel Mapping**.

## How to find what's hurting your viewers

1. Start at the **buffer histogram** — a long tail toward high buffering means trouble.
2. Open **Problem channels** to see which specific channels are responsible.
3. Click a representative **session** for that channel to read its detailed timeline.
4. Fix at the source (re-sync the playlist, check the upstream) and watch the next sessions improve.
