# Channels, Groups & Failover

Open any **playlist** and you land on its channel workbench — the table where you curate what your users
actually receive. This is where you edit individual channels, bulk-edit many at once, file channels into
**groups**, build **failover backups**, and delete the ones you don't want.

> **Note:** Two different things are called a *group* here, and it helps to keep them straight. A
> **category group** is the folder a channel is filed under in the playlist (the `group-title` your IPTV
> player shows in its category list). A **failover group** is a channel plus one or more silent backups that
> take over if it stops working. This page covers both.

## What's on screen

- **The channel table** — one row per channel: a **select checkbox**, its **number**, **logo**, **name**,
  **category group**, **guide link**, and **live status**. Sort by **name**, **channel number**, or
  **group**, and narrow the list with the **group dropdown** and search box above the table.
- **Guide-match filter** — a segmented **All / Matched / Unmatched** control filters the table by whether a
  channel is linked to guide data. It's a **view filter only** (it changes what you see, not the channels
  themselves), and **Unmatched** also includes channels that have never been evaluated for a match.
- **The selection toolbar** — the moment you check one or more rows, a toolbar appears with an **{n}
  selected** pill and these actions:
  - **Group** — builds a **failover group** from the selection ("Configure a failover group from the
    selection").
  - **Create** / **Append** — on a built-in source playlist, spin the selected channels off into a **new
    clone** playlist, or **append** them to an existing custom playlist. (Hidden on a clone — you're already
    in one.)
  - **Edit** — opens the **bulk editor** (set status, assign a category group, remove EPG matches, manage
    groups, or delete).
  - **Clear** — deselects everything.
- **Select-all / range select** — the checkbox in the header toggles every row currently in view; hold
  **Ctrl/Cmd + Shift** while clicking a second row to select the whole range between it and your last click.

## Editing one channel

Click a **row** (anywhere but its checkbox) to open the single-channel drawer. Along the top it shows a
live picture of the channel so you can judge it before you publish it:

- An embedded **player** that streams the channel through the proxy.
- A live **bitrate chart** so you can watch the stream's health in real time.
- **Technical Details** probed from the stream — video and audio codecs, frame rate, and container. These
  appear once the channel has been played and probed at least once. The resolved **stream URL** is always
  shown here — read-only for built-in sources, an editable link input for custom playlists.
- **Status chips** — the live phase (connecting / establishing / buffering / live / failed), whether it's
  matched to guide data, whether it's playable, its resolution, its source, and a **failover** pill when the
  channel is a parent or a backup child.

Below that are the editable fields:

- **Status** — Active or Disabled. Saves the instant you change it.
- **Display name** and **Channel number**.
- **TVG-ID (EPG link)** — the guide identity. For a **failover child** this is **locked** and marked
  *inherited*: a backup always carries its parent's guide identity, so the server won't let you edit it
  directly. Changing a normal channel's TVG-ID unlinks any existing guide match.
- **Group** — the category group this channel is filed under (see below).
- **Player source** — for **DaddyLive** channels only, picks which of DaddyLive's interchangeable players the
  channel uses (**Auto**, or Player **1–6**), or leaves it on the workspace default set in **Settings →
  Advanced**. Channels from other sources don't show this field.
- **Tags** — the app-wide labels on this channel; add or remove them from the chip picker (type a name to
  create a new one on the spot). See **Custom Tags**.

At the bottom, **Remove** deletes just this channel (a two-step confirm). **Save changes** writes only the
fields you touched.

## Bulk editing

Select several rows and click **Edit** to change them all at once. The drawer lists the channels being
edited, then offers:

- **Set status** — Active or Disabled for the whole selection. If the selection is mixed, it shows "mixed —
  leave unchanged" so you don't flatten differences by accident.
- **Assign to a group** — pick a category group for every selected channel (or type a new one to create it).
  Leave it on "leave unchanged" to skip.
- **Remove EPG match** — clears the guide link on the selected channels. It shows how many of them are
  currently linked so you know the impact.
- **Tags** — add or remove app-wide labels across the whole selection. The chips are **tri-state**: solid =
  on every selected channel, dashed = on some, plain = on none; clicking cycles add-to-all → remove-from-all
  → leave (see **Custom Tags**).
- **Player source** — for **DaddyLive** channels in the selection, set which player they use, all at once.
- **Apply to N channels** — writes the status / group / EPG changes above.
- **Manage groups** — the shared group panel (see below).
- **Delete N channels** — the destructive action, guarded by a two-step confirm (see *Deleting channels*).

### How to bulk-edit channels

1. Check the rows you want (use the header checkbox, or Ctrl/Cmd + Shift-click to grab a range).
2. Click **Edit** in the selection toolbar.
3. Set a **status**, choose a **group**, and/or tick **Remove EPG match** as needed.
4. Click **Apply to N channels**. The table updates in place.

## Category groups

A **category group** is the folder a channel appears under in the published playlist — the category your
IPTV player lists in its sidebar. Groups are **first-class and persisted**: an empty group is a real object
you can create up front, not just a label that exists because some channel happens to use it.

You manage them from the **Manage groups** panel, which appears in both the single-channel drawer and the
bulk editor (they share one registry, so a group you create in one shows up in the other immediately). Each
group row shows a live **member count** and lets you:

- **Rename** — relabels every channel in the group at once.
- **Delete group** — removes the group but **keeps the channels**; it only clears their group assignment.
- **Add an empty group** — creates a new, memberless group you can assign channels to later.

Assign channels to a group either one at a time (the **Group** field in the single-channel drawer) or in
bulk (**Assign to a group** in the bulk editor).

> **Tip:** Empty groups **survive a re-sync**, so you can build your whole category taxonomy first and file
> channels into it afterward — the next sync won't wipe the folders out. The playlist header's **Groups**
> count includes empty ones.

> **Note:** The published playlist lists categories **alphabetically**. The order groups appear in the
> Manage panel is just for your convenience here — it does not change the order players show them in.

### How to organize channels into groups

1. Open the **Manage groups** panel (from either editor) and **Add** the group names you want.
2. Select the channels for a group, click **Edit**, and use **Assign to a group**.
3. Repeat for each group. Rename or delete groups any time — changes apply across the whole playlist.

## Failover groups

A **failover group** makes one channel resilient by giving it silent backups. It has one **parent** — the
only channel that's actually published and served — and an ordered list of **children**: hidden backups the
server tries, in order, if the parent's stream won't establish. Backups can even come from a different
provider. Children **inherit the parent's guide identity**, and once a working stream is found, playback
**sticks with the winner** instead of flapping.

### How to build a failover group

1. Select the parent channel **plus** the channels you want as its backups (two or more rows total).
2. Click **Group** in the selection toolbar.
3. Choose which channel is the **parent**; **drag** the children to set the order they'll be tried in.
4. **Save**. The parent keeps its place in the table; the children are folded in behind it.

From a parent row's menu you can later **Edit group** (reopen this dialog) or **Disband** it (dissolve the
group and return every channel to standing on its own). Inside the dialog you can **promote** a child to
become the new parent.

> **Note:** Failover is on by default. Deleting a group's parent — or its last remaining child — automatically
> **disbands** the group. When a channel **leaves** a group this way, it **reverts to its own guide identity**
> — the TVG-ID it carried before it joined — rather than keeping the parent's inherited link. You can watch
> failover happen live on the **Active Streams** screen, where a session shows a **failover → {backup name}**
> badge while it's running on a backup.

## Deleting channels & Restore Defaults

Deleting a channel — from the single-channel **Remove** button or the bulk **Delete N channels** — is
permanent, and it's **tombstoned**: the channel's identity is remembered so a later **Sync** will **not**
bring it back, even though it's still present upstream. That's what makes a delete stick.

The undo is the playlist's **Restore Defaults** (also labelled **Reset**). It forgets every tombstone —
so previously-deleted channels return on the next sync — but it also **discards all of your edits** and
re-fetches from scratch. Treat it as a clean slate, not a gentle "un-delete".

> **Note:** Three related actions, easy to mix up: **Disabled** hides a channel from the published playlist
> but keeps it and survives every sync — fully reversible. **Delete** removes it and tombstones it, so syncs
> won't restore it. **Restore Defaults** is the nuclear reset — it brings deleted channels back but throws
> away every edit on the playlist.

## Related screens

- **Playlists** — where you add, sync, compose, and schedule the playlist these channels live in.
- **Channel Mapping** — link channels to guide data (map a failover **parent**; its children inherit).
- **Active Streams** — watch these channels play in real time, including failover in action.
- **Custom Tags** — the app-wide labels you assign to channels here, one at a time or in bulk.
