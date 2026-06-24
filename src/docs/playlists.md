# Playlists

Playlists are the heart of TVApp2. A **playlist** is a source of channels from one of the following providers — `built-in`, `clone`, `file`, `remote url`, or `hdhomerun`

- `built-in` providers ship with the application sync'd by the user
- `clone` providers are copies of existing playlists that allow for more detailed cusotmizations - a `clone` can be created from any of the listed provders
- `file` providers are simply `m3u` filetype playlists uploaded - sync options are not available for `file` providers
- `remote url` providers are `m3u` filetype playlists that are hosted from any availble domain
- `hdhomerun` providers connect securely to a local or remote (if accessible) HDHomeRun device - playlists are auto-negotiated from HDHomeRun devices after a successful connection

If you are looking for a **custom playlist** option, use one of the **custom provider** types: `clone`, `file`, `remote url`, or `hdhomerun`. Each of these providers are considered a custom playlist, also referred to as a **custom provider**, with options to always customize further for more granular control over content.

## Sync Global & Sync

**Sync Global** will synchronize and update available channels within all playlists in the Global category.
**Sync** will synchronize and update avaialable channels within one playlist - the playlist row that was sync'd.

## Compose Global & Compose

**Compose Global** will compose all _Active_ channels within all playlists in the Global category - this acts as a roll-up for all Global playlsts to be accessed through a single `playlist.m3u` filetype.
**Compose** will compose all _Active_ channels within the playlist row into 

## What's on screen

### List view
Every playlist as a row: its **name**, **source/type**, **status**, **channel count**, and its
**schedule** chips. Built-in providers and your custom providers live side by side here.

### Detail view
The channels inside one playlist, each with its name, number, logo, guide link, and live status. This
is where you edit individual channels and run syncs.

## What drives the context you see

A built-in playlist starts as a **zero-channel shell** and only fills in after a **Sync**. The
channel rows you see are the live, editable copy of the provider's catalog. Channels you've edited are
**preserved across re-syncs** — a sync updates provider-derived fields but keeps your edits.

## Key controls and where their effects ripple

- **Sync now** — fetches the provider's current catalog and populates/updates this playlist's channels.
  This is the action that makes channels appear everywhere else: on the **Dashboard** counts, in
  **Channel Mapping**, and in the published M3U your users download. A sync also **prunes** channels the
  provider has dropped.
- **Schedule** — set an interval so the app re-syncs automatically. The chosen schedule shows as chips
  here and on the Dashboard, and is run by the server's scheduler in the background.
- **Reset** — drops this playlist's channels and re-syncs from scratch (discards local edits).
- **Clone** — creates a custom playlist: an independent copy of selected channels you can curate.
  Clones are real playlists you manage separately; their channels are copies (keyed to the clone), and
  each remembers its origin provider so streams still route correctly.
- **Editing a channel** (in detail view) — change its name, number, status, or guide link. Setting a
  channel to **Disabled** removes it from the published playlist without deleting it; your edits survive
  the next sync.

## How to add and publish a playlist

1. Click **Add playlist** (here or on the Dashboard) and pick/configure the source.
2. Open the new playlist and run **Sync now** — channels populate.
3. (Optional) Edit channel names/numbers or disable ones you don't want.
4. (Optional) Open **Channel Mapping** to attach guide data.
5. (Optional) Set a **Schedule** so it stays fresh automatically.
6. The playlist's published **M3U URL** (visible to the users you grant access) now serves these
   channels.

## Related screens

- **Channel Mapping** — link these channels to EPG guide data.
- **Settings** — the **Domain** there determines the published URL of every playlist.
- **Users** — grant specific users access to specific playlists.
