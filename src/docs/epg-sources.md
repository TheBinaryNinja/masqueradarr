# EPG Sources

EPG (Electronic Program Guide) sources supply the **program data** — the "now playing / up next"
schedule — that makes your channels show what's on. This screen has a **list** view (all guide sources)
and a **detail** view (one source's channels and programs).

## What's on screen

### List view
Each guide source as a row: its **name**, **type**, **status**, and counts of guide **channels** and
**programs** it holds.

### Detail view
The channels within one EPG source and the programs attached to them, plus the source's schedule and
last-sync information.

## What drives the context you see

Program data only exists after a source is **synced**, just like playlists. TVApp2 ingests two kinds of
guide source — **Gracenote** and **EPG-PW** — behind a shared pipeline, and a freshly added source is
empty until its first sync pulls the schedule.

## Key controls and where their effects ripple

- **Add EPG Source** — opens the Add EPG Source modal where you choose the provider and configure it.
  New sources appear immediately in this list and on the Dashboard.
- **Sync** — fetches the latest guide channels and programs for the source. This is what populates the
  program data that later binds to your playlist channels via **Channel Mapping**.
- **Schedule** (Edit / schedule drawer) — re-sync the guide automatically on an interval, run by the
  server scheduler. Guides go stale quickly, so a schedule is recommended.
- **Delete** — removes the source **and cascades** to delete its guide channels and programs. Any
  channel mappings that pointed at it lose their guide link, so re-map those channels afterward.

## How program data reaches your channels

1. **Add EPG Source** and choose Gracenote or EPG-PW.
2. **Sync** it so its guide channels and programs load.
3. Open **Channel Mapping** and link each playlist channel to the matching EPG channel.
4. Your published **guide** (XMLTV) now carries program data for the mapped channels, and players show
   the schedule.

## Related screens

- **Channel Mapping** — the screen that actually connects guide channels to playlist channels.
- **Playlists** — the channels that consume this guide data.
