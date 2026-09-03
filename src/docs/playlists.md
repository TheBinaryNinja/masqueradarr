# Playlists

Playlists are the heart of the app. A **playlist** is a source of channels, and every playlist is one of a
few **kinds**:

- **Built-in (source)** — a provider that ships with the app. It arrives as an empty shell and fills in when
  you sync it.
- **Clone** — an independent copy of another playlist that you can curate separately. You can clone any of
  the kinds below or a built-in source.
- **URL import** — an M3U playlist hosted at any reachable address.
- **File upload** — an M3U file you upload directly. There's nothing to sync — the file *is* the catalog.
- **HDHomeRun** — a local (or reachable remote) HDHomeRun tuner. Once connected, its channel line-up is
  negotiated automatically.

The last four — **Clone**, **URL import**, **File upload**, and **HDHomeRun** — are the **custom** playlist
kinds. Use one of these whenever you want channels that don't come from a built-in provider, or when you want
tighter control over exactly what a playlist contains.

> **Heads up:** HDHomeRun tuners connect and import their line-up today, but live playback from them is still
> being finalized — treat HDHomeRun playlists as import-ready rather than watch-ready for now.

## Global vs. custom endpoints

Built-in source playlists are **Global** — they roll up together into a single combined M3U your users can
subscribe to. Custom playlists are **Custom-endpoint** — each one publishes its own M3U. This distinction is
a playlist's **scope**, and it drives how the playlist is **composed** (into the shared Global M3U, or into
its own file) and how you grant access to it.

Whether a playlist can **Sync** is a **separate** question: it depends only on whether the playlist has a
**live upstream to pull from** — its *kind* — not on its scope. So a built-in you've switched to Custom still
syncs from its provider, and a URL import you've set to Global still syncs from its address; a **file
upload**, with no upstream, has nothing to sync either way.

## Sync

- **Sync** — fetches the current catalog for **one** playlist (the row you ran it on) and populates or
  updates its channels. This is the action that makes channels appear everywhere else: the **Dashboard**
  counts, **Channel Mapping**, and the published M3U your users download. A sync also **prunes** channels the
  provider has dropped, and it **preserves your edits** — it refreshes provider-derived fields but keeps the
  names, numbers, statuses, and guide links you've set.
- **Sync Global** — runs that same sync across **all** Global playlists at once.

## Compose

- **Compose** — assembles all **Active** channels in **one** playlist into that playlist's own published
  `.m3u` file. This is what your IPTV client actually downloads.
- **Compose Global** — rolls up all Active channels across **every** Global playlist into the single combined
  Global `.m3u`, so the whole Global line-up is reachable through one subscription URL.

## What's on screen

### List view
Every playlist as a row: its **name**, **kind**, **status**, **channel count**, and its **schedule** chips.
Rows are grouped by **kind** (built-in, clone, file, URL, HDHomeRun), and you can shape the list to taste:

- **Pin** a playlist with the **pin button** on its row to lift it into a **PINNED** section above the kind
  groups — handy for the handful you reach for most.
- **Play** a playlist with the **play button** on its row to open it in the **Ultimate Video Player** — a
  dedicated player window scoped to that playlist, starting on its first channel in the player's current
  sort order. It's there whatever **Settings → Video Config → Video player** is set to, and it's greyed out
  on a playlist that has no channels yet. Relaunching reuses the same player window rather than piling up
  pop-ups, so allow pop-ups for masqueradarr. The same button sits on the Dashboard's Playlists panel.
- **Drag** a row by its grip to reorder it within its section; the order you set is saved. (Reordering
  pauses while a search filter is active.)
- Toggle **A–Z** in the toolbar to sort rows alphabetically **within each kind group** instead. It's a
  Settings-backed preference, remembered across sessions — and dragging a row to reorder turns it back off,
  keeping your manual order.

Each row's menu carries the per-playlist actions — **Sync** / **Compose** (for the playlists that have
them), **Assign access** and **Get access** (see *Related screens → Users*), **Edit**, and **Delete**.

### Detail view
The channels inside one playlist — each with its name, number, logo, guide link, and live status. This is
the **channel workbench** where you edit individual channels, bulk-edit, build groups, and run syncs. See
**Channels, Groups & Failover** for the full walkthrough.

## What drives the context you see

A built-in playlist starts as a **zero-channel shell** and only fills in after a **Sync**. The rows you see
are the live, editable copy of the provider's catalog. Channels you've edited are **preserved across
re-syncs** — a sync updates provider-derived fields but keeps your edits.

## Key controls and where their effects ripple

- **Sync now** — fetches the provider's current catalog and populates/updates this playlist's channels, as
  described above. This is the action that makes channels appear on the Dashboard, in Channel Mapping, and in
  the published M3U.
- **Schedule** — set an interval so the app re-syncs (and recomposes) automatically. The chosen schedule
  shows as chips here and on the Dashboard, and runs in the background via the server's scheduler.
- **Restore Defaults** (also labelled **Reset**) — a clean-slate re-fetch. It **discards your local edits**
  *and* forgets any channel deletions (see **Channels, Groups & Failover → Deleting channels**), bringing the
  playlist back to exactly what the provider serves.
- **Clone** — creates a custom playlist: an independent copy of selected channels you can curate. Clones are
  real playlists you manage separately; each channel remembers its origin provider so streams still resolve
  correctly.
- **Editing channels** — done in the detail view. You can rename, renumber, disable, delete, group, and add
  failover backups to channels. The full editing model lives in **Channels, Groups & Failover**.
- **Edit** (from a row's menu) — opens the playlist's Edit drawer, where — among its settings — you assign
  **Tags** and can toggle **Apply to all channels** to push the playlist's tags down onto every channel it
  contains (see **Custom Tags**).
- **Delete** (from a row's menu) — removes the whole playlist. For a **built-in** it first shows an
  **affected-areas report** — the users, mappings, and composed files that depend on it — so you can see the
  blast radius before confirming; the delete then cascades to those access grants and mappings.

> **Caution:** **Delete** and **Restore Defaults** are not the same thing. Delete removes the playlist itself
> and everything hanging off it; **Restore Defaults** keeps the playlist and just re-fetches it from the
> provider. Reach for Delete only when you want the playlist gone for good.

## How to add and publish a playlist

1. Click **Add playlist** (here or on the Dashboard) and pick or configure the kind of source.
2. Open the new playlist and run **Sync now** — its channels populate.
3. (Optional) Edit channel names/numbers, disable ones you don't want, or file them into **groups**.
4. (Optional) Open **Channel Mapping** to attach guide data.
5. (Optional) Set a **Schedule** so the playlist stays fresh automatically.
6. Grant users access on this screen (**Assign access** in the row's menu). The playlist's published **M3U
   URL** now serves these channels to everyone you've granted.

## Related screens

- **Channels, Groups & Failover** — edit, group, and add backups to the channels inside a playlist.
- **Channel Mapping** — link these channels to EPG guide data.
- **Settings** — the **Domain** there determines the published URL of every playlist.
- **Users** — grant specific users access to specific playlists (via **Assign access** on this screen).
- **Custom Tags** — the labels you assign in a playlist's Edit drawer (and optionally cascade to its channels).
