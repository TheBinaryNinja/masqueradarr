# Users

The Users screen is where you create accounts for the people who will consume your streams and control
exactly which playlists each one can access. TVApp2 has two roles — **admin** and **user** — and a
per-user access list on top of the role.

## What's on screen

Each account as a row: its **username**, **role**, and the playlists it's been granted. From here you
create, edit, and remove users and manage their access.

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
- **Allowed playlists** — pick which playlists this user can access. This directly determines the
  channels on **their** Dashboard and the contents of **their** published M3U URL.
- **Stream token** — each user has a personal token that protects their streams. Their published
  playlist **downloads without a login** but only **streams for their token**. Regenerating it (here or
  by the user on their Dashboard) immediately invalidates their old links.

## How to onboard a new viewer

1. Click **Add user**, set a username, password, and the **user** role.
2. Grant the **allowed playlists** they should receive.
3. Save. The user can now log in; their Dashboard shows exactly those playlists' channels and their
   personal integration URLs.
4. Share how to log in — they handle copying their own playlist link from their Dashboard.

## Related screens

- **Playlists** — the playlists you grant access to here.
- **Dashboard (user view)** — what the people you create will actually see.
