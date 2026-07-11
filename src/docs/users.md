# Users

The Users screen is where you create accounts for the people who will consume your streams and manage each
account's identity, role, and stream token. There are two roles — **admin** and **user** — with a per-user
access list layered on top. One thing to know up front: you **grant** the actual playlist access on the
**Playlists** screen, not here (see below).

## What's on screen

Each account as a row: its **username**, **role**, and a summary of the playlists it currently holds. From
here you create, edit, and remove users, **enable or disable** each user's stream token, and review a
read-only summary of the playlists they hold. (Users regenerate their own token on their **Dashboard**; the
actual published links live on the **Playlists** screen via **Get access**.) The access itself is toggled on
the **Playlists** screen.

## What drives the context you see

This is the full account list. Every account here can sign in; what they can *do* afterward is governed
by two layers working together:

- **Role** — an **admin** sees and manages everything (all screens). A **user** is restricted to the
  Dashboard and only ever sees their own assigned channels.
- **Per-user access list** — even within the user role, each account is granted specific playlists, so
  two users can have completely different channel line-ups.

## Key controls and where their effects ripple

- **Add user** — creates an account with a username, password, and role.
- **Role** — set **admin** to give full management access, or **user** for a consumer account. This
  decides which screens and nav items that person sees when they log in.
- **Access (granted on Playlists)** — which playlists a user can reach is granted **per playlist on the
  Playlists screen** via **Assign access**, not on this screen. What you grant there directly determines the
  channels on **their** Dashboard and the contents of **their** published M3U URL. This screen shows a
  read-only summary of what each user currently holds.
- **Stream token** — each user has a personal token that protects their streams. Their published
  playlist **downloads without a login** but only **streams for their token**. From this screen an admin can
  **enable or disable** the token; the user regenerates it on their own **Dashboard**, which immediately
  invalidates their old links.

## How to onboard a new viewer

1. Click **Add user**, set a username, password, and the **user** role. Save.
2. Go to the **Playlists** screen. For each playlist they should receive, open its row menu → **Assign
   access** and toggle the user on. (Granting a Global playlist grants the whole Global line-up at once.)
3. The user can now log in; their Dashboard shows exactly those playlists' channels and their personal
   integration URLs. You can also grab their links directly via **Get access** on a playlist row.
4. Share how to log in — they handle copying their own playlist link from their Dashboard.

## Related screens

- **Playlists** — where you actually grant each user access (**Assign access** / **Get access**).
- **Dashboard (user view)** — what the people you create will actually see.
