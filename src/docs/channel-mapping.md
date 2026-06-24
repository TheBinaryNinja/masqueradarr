# Channel Mapping

Channel Mapping is where you connect each **playlist channel** (from a source) to the matching **EPG
channel** (from a guide source), so your channels display the correct program schedule. It's a
two-sided workbench: your channels on one side, guide channels on the other.

## What's on screen

- **Two columns** — playlist channels on one side, EPG (guide) channels on the other.
- **Source filters** on both sides — narrow each column to a single source so you're comparing apples
  to apples.
- **Per-column search** — type to find a specific channel in either list.
- **A–Z jump bars** — quick alphabetical navigation; the active letter highlights as you scroll.
- **Match scoring** — the screen suggests likely matches using a composite score, so the best
  candidates surface first.

## What drives the context you see

The guide side is the **real, synced EPG channel store** — so it only shows channels for guide sources
you've already synced (see **EPG Sources**). The suggested matches come from an intelligent scoring of
names and identifiers; they're suggestions, not automatic links — you confirm them.

## Key controls and where their effects ripple

- **Linking a channel** — attaches a guide channel to a playlist channel. The link is a persisted
  **two-factor pair** (the guide id plus its source), saved immediately. Once linked, that channel
  shows program data in the published guide and its **Unmatched** count on the Dashboard drops.
- **Many-to-one linking** — several playlist channels can point at the same EPG channel (useful when
  the same network appears in multiple playlists).
- **Source filters / search / A–Z bars** — purely to help you find the right pair faster; they don't
  change any data.

## How to map a channel

1. Use the **source filter** on the left to focus on one playlist.
2. Pick a channel that's unmatched.
3. Look at the **suggested** guide matches (highest score first) on the right, or **search** for the
   channel by name.
4. **Link** the correct guide channel. The pairing saves right away.
5. Repeat for the remaining unmatched channels — track your progress by the **Unmatched** stat on the
   Dashboard.

## Related screens

- **EPG Sources** — where the guide channels on the right come from; sync them first.
- **Playlists** — where the channels on the left come from.
