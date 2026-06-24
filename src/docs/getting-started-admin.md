# Day-one Setup (Admin)

Welcome to **TVApp2** — a self-hosted IPTV aggregator. It pulls M3U playlists and EPG guide data from
online IPTV services, lets you curate and remap them, and re-publishes clean, stream-ready playlists +
guide data to your own players and to the users you create.

This page walks an administrator through first-run setup, in order. Each step links to a screen that
has its own detailed section in this guide.

## What you're setting up

On a fresh install the database starts **empty**. Built-in source playlists appear as **zero-channel
shell rows** and only populate after your first **Sync now**. Nothing is pre-seeded — the app fills in
as you connect sources.

## First-run, in order

1. **Create the first admin account.** On first launch the app routes you to a one-time **Setup**
   screen. Pick a username and password — this becomes the administrator account. You are taken to
   **Login**; sign in.
2. **Set your domain.** Open **Settings** and set the **Domain** to the public address your players
   will reach this server at (for example `https://tv.example.com`). This is important: the domain is
   woven into every published playlist URL, and **changing it later rewrites every playlist's URL
   automatically**. Set it correctly once, up front.
3. **Add a playlist source.** Go to **Playlists → Add playlist** (the button is also on the Dashboard).
   Built-in sources appear as empty shells until you sync them.
4. **Sync now.** On the playlist, run **Sync now**. This fetches the live catalog and populates its
   channels. Until you do this, the playlist shows zero channels everywhere.
5. **Add EPG (guide) sources.** Go to **EPG Sources → Add EPG Source** to bring in program guide data
   (Gracenote or EPG-PW). Sync them the same way.
6. **Map channels to the guide.** Open **Channel Mapping** to link your playlist channels to the EPG
   channels so each channel shows the right "now/next" program information.
7. **Create users.** In **Users**, add the people who will consume your streams. Set each one's
   username, password, and role (**user** for a viewer, **admin** for another manager). Each user gets
   their own published, token-protected playlist URL.
8. **(Optional) Schedule refreshes.** On a playlist or EPG source, open its schedule to have the app
   re-sync automatically on an interval, so your catalog and guide stay fresh without manual syncs.
9. **(CRITICAL) Assign allowed playlists to each user.** Creating a user is **not** enough — you must
   then grant that account which playlists it may use, on the **Users** screen (open the user's edit
   drawer). There are two controls:
   - **Allowed Global Playlist** — a single checkbox that grants the whole Global line-up.
   - **Allowed Custom Playlists** — a checklist for granting individual Clone / custom playlists.

   These map to the account's per-user access lists (`allowedPlaylists` / `allowedCustomPlaylists`) and
   decide three things at once for that user: which playlists appear on **their** Dashboard, what their
   published M3U URL actually contains, and which channels their personal **stream token** is allowed to
   play. **A standard user with nothing granted sees an empty Dashboard, gets a channel-less M3U, and
   cannot stream anything** — so this step is what turns a new account into a working one.

   > **Note:** This applies only to **user**-role accounts. The **admin** role bypasses these lists and
   > always sees and streams every playlist, so you don't need to grant an admin anything here.

## Where context comes from

Most screens show **live** data the moment it exists and nothing before that. If a panel looks empty,
the usual cause is "this source hasn't been synced yet." Run a sync and the panels fill in.

> **Tip:** The **View logs** button in the sidebar opens a live, filterable log of everything the
> server is doing — invaluable while you're first wiring up sources.
