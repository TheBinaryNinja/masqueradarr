# Custom Tags

**Tags** are free-form labels you attach to **playlists**, **EPG sources**, and individual
**channels** to organize and find things your own way — by provider, region, quality, "kids", "needs
review", whatever suits you. They're purely for your benefit as an operator: a tag is a fast way to
group and search across the app, and it shows up as a small **magenta pill** wherever the thing it's
on appears.

## What's on screen

Tags are managed in one place — the **Custom Tags** card on **Settings → Advanced**. It lists every
tag you've created, each with a live **usage count** (how many playlists, sources, and channels
currently wear it), and lets you **create**, **rename**, and **delete** them. You don't tag things
*here*, though — you assign a tag from the editor of whatever you're tagging (see below).

## What drives the context you see

There is **one shared tag registry** for the whole workspace, so the same tag can sit on a playlist,
an EPG source, and a channel at the same time. Two things follow from that:

- Every tag looks the same — a **magenta pill**. There's no per-tag color; the name carries the meaning.
- A tag is referenced by a stable id, not by its text. So **renaming a tag updates it everywhere at
  once**, and **deleting a tag removes it from every playlist, source, and channel** it was on — there
  are no stray copies left to clean up.

## Key controls and where their effects ripple

- **Create / rename / delete** — from the **Settings → Advanced → Custom Tags** card. Renames and
  deletes cascade instantly across everything the tag touches.
- **Assign tags** — from the **Tags** field in each editor: the **playlist Edit drawer**, the
  **single-channel drawer**, the **bulk-channel editor**, and the **EPG-source Edit drawer**. Click a
  chip to toggle the tag on or off; you can also type a new name to create and assign a tag in one step.
- **Bulk assignment** — in the bulk-channel editor the chips are **tri-state**: a solid chip is on
  *every* selected channel, a dashed chip is on *some* of them, and a plain chip is on none. Clicking
  cycles add-to-all → remove-from-all → leave-as-is, so you only change what you mean to.
- **Apply to all channels** — the **playlist Edit drawer** carries this toggle beside its Tags field.
  Turn it on and the playlist's tags are **added onto every channel in it** — additive, so each channel
  keeps any tags of its own. It re-applies whenever you change the playlist's tags or switch it back on.

> **Note:** Tags are for **finding and organizing inside the app** — they're searchable and can cascade
> onto a playlist's channels, but they **never appear in your published M3U or XMLTV**, and they aren't a
> category axis (that's what **groups** are for; see **Channels, Groups & Failover**).

> **Tip:** Type a tag's name into the **top-bar search** and you'll pull up everything wearing it —
> playlists, sources, and channels together. Tagging is the quickest way to make an ad-hoc set of things
> findable in one go.

## How to tag and find things

1. Open **Settings → Advanced → Custom Tags** and **create** the tags you want to use.
2. Open the thing you want to label — a playlist, an EPG source, or a channel — and pick your tags from
   its **Tags** field. (Or select several channels and tag them together in the bulk editor.)
3. (Optional) On a playlist, turn on **Apply to all channels** to push its tags down onto every channel.
4. Later, type a tag name into the **top-bar search** to jump to everything carrying it.

## Related screens

- **Settings** — the **Custom Tags** card (create, rename, delete) lives on the Advanced tab.
- **Playlists** — assign tags in a playlist's Edit drawer, with **Apply to all channels**.
- **Channels, Groups & Failover** — tag a single channel, or many at once, in the channel workbench.
- **EPG Sources** — assign tags in an EPG source's Edit panel.
