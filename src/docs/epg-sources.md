# EPG Sources

EPG (Electronic Program Guide) sources supply the **program data** — the "now playing / up next"
schedule — that makes your channels show what's on. This screen has a **list** view (all guide sources)
and a **detail** view (one source's channels and programs).

## What's on screen

### List view
Each guide source as a row. A **status dot** (green = good, amber = warn, red = bad, grey = idle) sits before
the **name**, with a **built-in** badge on sources that ship with the app. The line beneath shows the
provenance **SOURCE** and **LINEUPID** chips, then the **sync-interval** pill, a **Playlist-bound** badge
(when a playlist drives the guide), and any **magenta tag pills** you've assigned. The row ends with its
**channels** and **programs** counts and **last sync** time. You can **drag rows to reorder** the list (the
order is saved automatically) — handy for keeping your most-used guides at the top; reordering is available
when no search filter is active.

### Detail view
The channels within one EPG source and the programs attached to them, plus the source's schedule and
last-sync information.

## What drives the context you see

Program data only exists after a source is **synced**, just like playlists. The app ingests several kinds
of guide source behind one shared pipeline — **Gracenote**, **EPG-PW**, **Jesmann** (a guided picker), an
**XML file** you upload, a **remote URL**, and **playlist-bound** guides (a source that carries its own
EPG). A freshly added source is empty until its first sync pulls the schedule.

> **Note:** A **playlist-bound** source belongs to a playlist that supplies its own guide. It links its
> channels automatically, so its manual sync controls are hidden — the playlist drives the cadence.

## Key controls and where their effects ripple

- **Add EPG Source** — opens the Add EPG Source modal where you choose the provider and configure it.
  New sources appear immediately in this list and on the Dashboard.
- **Sync** — fetches the latest guide channels and programs for the source. This is what populates the
  program data that later binds to your playlist channels via **Channel Mapping**. (A one-shot **XML file**
  source has nothing to re-fetch, so its menu offers **Upload XML** instead — to replace the file.)
- **Edit** — opens a slide-out panel that folds the source's **Name**, **Sync schedule**, and **Tags** into
  one place. There's no Save button — every field **saves automatically** as you change it (the footer reads
  *"Changes save automatically"*, and **Done** just closes the panel). The **Sync schedule** sets an interval
  so the server re-syncs the guide on its own; guides go stale quickly, so a schedule is recommended. (The
  schedule is hidden for one-shot XML uploads and playlist-bound guides, and read-only for the built-in
  source.)
- **Tags** — assign app-wide labels to a source from that same Edit panel; they're searchable and appear as
  magenta pills on the row. See **Custom Tags**.
- **Delete** — removes the source **and cascades** to delete its guide channels and programs, after a
  **confirmation** step. Any channel mappings that pointed at it lose their guide link, so re-map those
  channels afterward.

> **Note:** A source's menu only offers what it supports. **Built-in** sources (they ship preconfigured and
> update with the app) and **playlist-bound** guides (a playlist drives their cadence) can't be synced or
> deleted here — they show **Edit** only.

## How program data reaches your channels

1. **Add EPG Source** and choose a provider (Gracenote, EPG-PW, Jesmann, an XML upload, or a remote URL).
2. **Sync** it so its guide channels and programs load.
3. Open **Channel Mapping** and link each playlist channel to the matching EPG channel.
4. Your published **guide** (XMLTV) now carries program data for the mapped channels, and players show
   the schedule.

> **Heads up:** Large or remote XML guides import as a stream, with timeouts and guards for a slow or
> oversized feed. If an import fails, the message names the cause — an unreachable host, an HTTP or TLS
> error, a timeout, a parse failure, or a file that's simply too large — so you know whether to retry or
> fix the source.

> **Tip:** For channels with **failover backups**, map the **parent** only — its backup children inherit
> the parent's guide identity automatically (see **Channels, Groups & Failover**).

## Related screens

- **Channel Mapping** — the screen that actually connects guide channels to playlist channels.
- **Playlists** — the channels that consume this guide data.
- **Custom Tags** — the app-wide labels you assign to a source from its Edit panel.
