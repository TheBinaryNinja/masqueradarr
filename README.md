<div align="center">
<img src="docs/img/masqueradarr.png">
  <p><em>Aggregating scattered IPTV sources behind a single, trusted identity.</em></p>
  <div style="display:flex; justify-content:center; align-items:center; gap:15px;">
    <a>
      <img alt="GitHub Actions Workflow Status" src="https://img.shields.io/github/actions/workflow/status/TheBinaryNinja/masqueradarr/build-test.yml?style=for-the-badge&logo=github&logoSize=auto&label=TEST&color=246B7E&labelColor=black">
    </a>
    <a>
      <img alt="GitHub Actions Workflow Status" src="https://img.shields.io/github/actions/workflow/status/TheBinaryNinja/masqueradarr/docker-publish.yml?style=for-the-badge&logo=github&label=Release&color=246B7E&labelColor=black&logoSize=auto">
    </a>
    <img alt="Docker Image Version (tag)" src="https://img.shields.io/docker/v/iflip721/masqueradarr/dev?sort=date&style=for-the-badge&logo=Docker&color=964D44&logoSize=auto308EA8&labelColor=black">
    <img alt="Docker Image Version (tag)" src="https://img.shields.io/docker/v/iflip721/masqueradarr/latest?sort=date&style=for-the-badge&logo=Docker&color=246B7E&logoSize=auto&labelColor=black">
  </div>
  <br />
  <div style="display:flex; justify-content:center; align-items:center; gap:15px;">
    <a href="https://github.com/TheBinaryNinja/masqueradarr/releases">
      <img src="https://img.shields.io/badge/GitHub_Releases-masqueradarr_repo-246B7E?style=for-the-badge&logo=github&logoSize=auto&link=https%3A%2F%2Fgithub.com%2FTheBinaryNinja%2Fmasqueradarr%2Freleases&labelColor=black" alt="Static Badge">
    </a>
    <a href="https://hub.docker.com/r/iflip721/masqueradarr">
      <img src="https://img.shields.io/badge/Docker_Hub_Releases-masqueradarr-246B7E?style=for-the-badge&logo=docker&logoSize=auto&link=https%3A%2F%2Fhub.docker.com%2Fr%2Fiflip721%2Fmasqueradarr&labelColor=black" alt="Static Badge">
    </a>
  </div>
  <br />
</div>

# What is `masqueradarr`
<div style="display:flex; justify-content:left; align-items:justify; gap:15px;">
    <a href="https://discord.gg/baD3HGpkcD">
      <img src="https://img.shields.io/badge/masqueradarr-join_discord-3F48AD?style=for-the-badge&logo=discord&logoSize=auto&link=https%3A%2F%2Fdiscord.gg%2FUEx4fEVwg4308EA8&labelColor=black" alt="Static Badge">
    </a>
    <a>
      <img alt="Discord" src="https://img.shields.io/discord/1519879505886576690?style=for-the-badge&logo=discord&logoSize=auto&color=3F48AD&labelColor=black">
    </a>
    
</div>

**masqueradarr** is a self-hosted IPTV aggregator. It pulls channel playlists (M3U) and guide
data (EPG/XMLTV) from a range of online IPTV services, normalizes them into one catalog, and
serves them back as a single, unified, standards-compliant playlist + guide — behind one trusted
identity that your media apps and IPTV clients can talk to.

It is the direct successor to **[TVApp2](https://github.com/TheBinaryNinja/tvapp2)**, which is now
**deprecated**. masqueradarr is not a fork or a patch — it is a ground-up re-architecture of the same
idea, carrying the project into the `*arr` self-hosted media family (Sonarr, Radarr, …) it's named for.

| Swag Pack | Location to full swag pack |
| --- | --- |
| 📦 Icon Pack | 🔗 [masqueradarr icon pack](/docs/icons/README.md) |
| 📦 Font Pack | 🔗 [masqueradarr font pack](/docs/font-packs/README.md) |
| 📦 Emblem-Sets | 🔗 [masqueradarr emblem-sets](/docs/emblem-sets/README.md) |
| 📦 Label-Sets | 🔗 [masqueradarr label-sets](/docs/label-sets/README.md) |

<img src="docs/img/screenshots/v2-login.png">

> [!NOTE] 
> View more [screenshots](/docs/img/screenshots) of the current system including the updated branding and layout.

# Evolution — **masqueradarr**

### Where it started: **TVApp2**

TVApp2 was a single, self-contained Docker container whose job was simple and effective: on a
schedule, **scrape a handful of IPTV providers** (TheTvApp, TVPass, MoveOnJoy), **download and
regenerate flat `.m3u` and `.xml` files**, and serve them over a small web interface so that
Jellyfin, Plex, or Emby could ingest them. It was a Node.js app on an **Alpine Linux** base,
supervised by **s6-overlay**, configured almost entirely through **environment variables**, with
HDHomeRun emulation and HD/SD quality toggles. It did one thing well — keep static playlists fresh.

That model had ceilings. Streams were **static URLs** baked into files, so anything behind a login,
a device check, an expiring token, or a rotating mirror couldn't be served. There was **no database**,
**no real UI** beyond file links, **no per-user access control**, **no live observability** of who was
watching what, and **no transcoding** for clients that couldn't play the upstream format. Every new
provider meant bespoke scraping glued into the core.

### Where it's going: masqueradarr

masqueradarr keeps the original promise — *aggregate scattered IPTV sources into one playlist + guide* —
and rebuilds everything underneath it to lift those ceilings:

- **Static files → a live, resolve-on-demand engine.** Instead of writing dead URLs to disk,
  masqueradarr resolves each stream **at play time** through an HLS proxy. That's what makes
  **authenticated** and **rotating** sources possible — e.g. an in-app, server-streamed Chromium
  captures a real login session, and per-play signed URLs are minted on demand.
- **Flat config → MongoDB + a real management SPA.** State lives in MongoDB; the front end is a
  **Vue 3 single-page app** with full screens for Dashboard, Active Streams, History / Metrics,
  Playlists, EPG Sources, Channel Mapping, Users, and Settings.
- **Bespoke scrapers → a source-agnostic adapter framework.** Adding a provider is one adapter file
  plus one registry line; the generic core (sync, proxy, B-Roll, telemetry) never branches per source.
- **File server → an API + two delivery surfaces.** An in-app player **and** an external-client
  engine that transcodes for TiviMate / Kodi / VLC, with **GPU hardware acceleration** (NVENC / VAAPI / QSV).
- **Env-var toggles → users, roles & per-user access.** Real authentication (scrypt), session vs.
  stream tokens, and per-user tokenized playlist access.
- **Blind scheduling → live observability.** WebSocket-pushed viewer/bandwidth/buffering telemetry,
  ffprobe stream monitoring, a B-Roll placeholder slate while a channel buffers, and MongoDB-backed
  application logs.

### At a glance

| | **TVApp2** (deprecated) | **masqueradarr** |
|---|---|---|
| **Role** | Static M3U/XMLTV regenerator | Live IPTV aggregator + delivery platform |
| **Streams** | Static URLs written to files | Resolve-on-demand via HLS proxy |
| **State** | Flat files, no DB | MongoDB (Mongoose 8) |
| **Frontend** | Links to generated files | Vue 3 + Vite management SPA |
| **Backend** | Node.js scripts | Express 4 API (ESM, TypeScript) |
| **Sources** | Hard-coded scrapers (TheTvApp, TVPass, MoveOnJoy) | Pluggable adapters (dulo, dlhd, tubi) + URL / HDHomeRun / file imports |
| **Guide data** | One bundled XMLTV grabber | Gracenote, EPG-PW, Jesmann, Custom XMLTV + self-EPG |
| **Auth** | None | scrypt users, roles, per-user access lists |
| **Auth'd sources** | Not possible | Supported (streamed-login session capture) |
| **External clients** | Pass-through only | ffmpeg/VLC transcode engine, GPU HW accel |
| **Observability** | Logs | Live WS telemetry, history/metrics, ffprobe, system stats, app logs |
| **Backup** | None | Full-system gzip backup / restore + scheduled backups |
| **Base image** | Alpine + s6-overlay | Debian bookworm (glibc) + tini |
| **Config** | Environment variables | DB-backed settings + minimal `.env` bootstrap |

### Architecture

masqueradarr is **two independently-built, independently-versioned npm packages** that the Docker
image stitches together — *not* a workspace, and they never import across the boundary:

- **`/` (root)** — the **Vue 3 + Vite SPA** (the management front end; `hls.js`, `vue-router`, `mitt`).
- **`server/`** — the **Express 4 + Mongoose 8 API** (ESM, TypeScript `strict`), which serves the
  built SPA, the `/api/*` REST surface, the HLS proxy + external-player engine, and five WebSockets
  (login-stream, stream-stats, logs-stream, probe-progress, system-stats).

Key subsystems:

- **Sources adapter framework** — a source-agnostic core (sync → normalize → dedupe → proxy) with
  per-provider adapters. Current sources: **dulo** (authenticated, resolve-on-demand), **dlhd**
  (anonymous, scraped from a rotating mirror), and **tubi** (anonymous FAST channels that carry their
  own inline EPG); plus two synthetic, proxy-only sources — **direct** (passes user-imported stream
  URLs straight through) and **hdhomerun** (remuxes a local tuner's MPEG-TS to HLS) — that back
  bring-your-own playlists.
- **Channel model** — a pristine synced reference (`sourcechannels`) projected into an editable,
  UI-facing store (`playlistchannels`); user edits survive re-syncs.
- **EPG + scheduler** — multiple guide ingesters behind one shared sync path — **Gracenote**,
  **EPG-PW**, **Jesmann**, and user-supplied **Custom XMLTV** (file upload or re-fetchable remote URL,
  streamed so multi-GB national guides parse with bounded memory) — plus the self-built guides that
  **tubi** and **dlhd** carry. All driven by a `croner`-backed runtime scheduler over a persisted
  `cronjobs` collection.
- **Composition + export** — composes Global, per-user, and custom `.m3u` playlists with matching
  XMLTV guide siblings for downstream clients.
- **externalPlayer engine** — ffmpeg / VLC transcode for third-party IPTV clients on a dedicated
  mount, with boot-time hardware-encoder detection.
- **Backup & maintenance** — full-system gzip backup / restore, scheduled backups, and Mongo
  index-rebuild / workspace-reset maintenance actions.

### Migration status

The rename and re-architecture are **in flight**. The codebase, brand, and runtime are masqueradarr;
the **published Docker repositories still carry the `tvapp2` names** (`iflip721/tvapp2-app-stack` for
the standard image, `iflip721/tvapp2` for the all-in-one) until the registry rename completes. If
you're coming from TVApp2: there is **no in-place upgrade path** — masqueradarr is a new application
with a new data model (MongoDB instead of flat files), so stand it up fresh and re-add your sources
through the UI.

### Lineage & credits

masqueradarr is the successor to **[TVApp2](https://github.com/TheBinaryNinja/tvapp2)** by
[TheBinaryNinja](https://github.com/TheBinaryNinja), and inherits its core aggregation framework
(ported from the sibling project). TVApp2 remains available, archived, and deprecated —
all new development happens here.

# Features

**Aggregation & delivery**

- Pulls **M3U playlists** and **EPG / XMLTV** guide data from multiple IPTV providers and normalizes
  them into one catalog.
- **Resolve-on-demand streaming** — each stream is resolved at play time through an HLS proxy (no dead
  URLs on disk), which is what makes **authenticated**, **token-gated**, and **rotating-mirror** sources
  possible.
- **Two delivery surfaces** — an in-app slide-out player and an external-client engine for TiviMate /
  Kodi / VLC / Emby / Jellyfin / Plex.
- **Composition + export** — builds Global, per-user, and custom `.m3u` playlists, each with a matching
  XMLTV guide sibling advertised via `x-tvg-url`.

**Pluggable sources**

- A **source-agnostic adapter framework**: adding a provider is one adapter file plus one registry line;
  the generic core (sync → normalize → dedupe → proxy) never branches per source.
- **dulo** — authenticated, resolve-on-demand; the login session is captured in-app via a server-streamed
  real Chromium (the password goes straight to the provider, only tokens are persisted).
- **dlhd** — anonymous, scraped from a rotating mirror with a Referer-gated multi-hop resolve and a
  self-built EPG.
- **tubi** — anonymous FAST channels scraped live, carrying their own inline EPG (guide + per-play
  signed, AES-128 manifests re-resolved on demand).

**Custom playlists** (bring your own)

- **Clone** — hand-pick channels from any synced source into a curated playlist; the channels are
  independent copies (so edits don't disturb the originals) but streams still route through the real adapter.
- **Import** — pull in any remote **M3U URL** (re-syncable), upload a static **`.m3u` file**, or expose a
  local **HDHomeRun** tuner (its raw MPEG-TS remuxed to HLS).
- Every custom playlist rides the same per-user, token-gated **`.m3u` + XMLTV** export machinery as the
  built-in sources.

**Guide data (EPG)**

- Ingests guide data from **Gracenote**, **EPG-PW**, **Jesmann** (guided picker), and any **Custom XMLTV**
  source — an uploaded file or a re-fetchable remote URL, streamed so multi-GB national guides parse with
  bounded memory — plus the self-built guides that **tubi** and **dlhd** carry.
- **Channel Mapping** links channels to guide data with composite match-scoring and many-to-one EPG
  linking; the link survives re-syncs.

**Management SPA** (Vue 3)

- Full screens for **Dashboard, Active Streams, History / Metrics, Playlists, EPG Sources, Channel
  Mapping, Users,** and **Settings**.
- An editable channel store where **user edits survive re-syncs**, and shared progress modals for the
  long-running sync / compose operations.

**Users & access control**

- **scrypt** authentication, **admin / user** roles, and **per-user access lists** (allowed playlists /
  custom playlists).
- A session-token vs. stream-token split, and per-user **tokenized M3U access** (token-free download,
  token-gated stream).

**Observability**

- WebSocket-pushed **viewer / bandwidth / buffering telemetry** and **ffprobe** stream monitoring.
- Live **system-performance** push (CPU / memory / GPU) on the Dashboard, including per-vendor GPU usage.
- Persisted **view-session history** + per-user metrics, and **MongoDB-backed application logs** (12
  categories, 14-day TTL) with a live log drawer.
- A **B-Roll placeholder slate** burned into real HLS while an in-app channel is establishing or
  re-buffering — so even headless clients see something.

**Transcoding**

- An optional per-playlist **ffmpeg / VLC engine** for external clients — **loopback-HLS** (default) or
  **raw MPEG-TS** output.
- Multi-vendor **GPU hardware acceleration** (NVENC / VAAPI / QSV) with boot-time encoder detection, so
  the UI only offers what the host can actually do.

**Scheduling**

- A `croner`-backed runtime scheduler over a persisted `cronjobs` collection: playlist re-sync, EPG
  re-sync, M3U / XMLTV recompose, and scheduled backups.

**Backup & restore**

- One-click **full-system backup** — a gzipped snapshot of every collection, downloaded or written to a
  configured backup directory on a schedule.
- **Restore** from an uploaded backup or a saved file; the restore re-orchestrates the dependent
  subsystems (boot init, DNS, scheduler) in place.
- **Maintenance** actions from Settings: rebuild MongoDB indexes, or reset the workspace (wipe content,
  keep users / settings).

# Getting started

masqueradarr ships as Docker images. There are two deployment shapes.

#### Option A — Compose stack (app + MongoDB)

1. Copy the env template and fill it in:

   ```bash
   cp .env.example .env
   ```

   At minimum set `MONGO_ROOT_USER` / `MONGO_ROOT_PASS`, your `DOMAIN`, and the host volume paths
   (`COMPOSE_PATH`, `BACKUPS_PATH`, `MONGO_DATA_PATH`) — each host dir must be writable by **uid 1000**
   (the container's `node` user). To publish on a host port other than `3000`, set `MASQUERADARR_PORT`
   (and update `DOMAIN` to match).

2. Bring it up:

   ```bash
   docker compose up -d
   ```

3. Open `http://localhost:3000` (or your `DOMAIN`; the host port reflects `MASQUERADARR_PORT`). The app
   **self-provisions** its `config.json` from the `.env` on every boot — there is no host config file to
   manage.

#### Option B — All-in-one (single container)

A second image bundles **app + MongoDB + config bootstrap** into one container, so the whole stack runs
from a single `docker run` with no external database — ideal for a quick trial or a small home server. One
`/data` volume persists the database, exports, config, and credentials. See **Migration status** above for
the current published image name. *(On amd64, the bundled MongoDB 7.0 requires a CPU with AVX; on hosts
without it, use the compose stack.)*

To publish on a different host port, change the left side of the `-p` mapping — e.g. `-p 8080:3000`
(the container always serves on `3000` internally; `MASQUERADARR_PORT` only applies to the compose stack).

#### First run

On first launch there are **no users** — the app reports `needsSetup` and the SPA walks you through
creating the **first admin account**. After that:

1. **Add a playlist** — the Add Playlist modal offers every built-in source plus custom playlists
   (clone / file / URL / HDHomeRun).
2. For an **authenticated** source (dulo), capture a login session from **Settings** (a server-streamed
   Chromium signs you in; only tokens are stored).
3. **Sync now** to populate channels, then optionally add **EPG Sources** and link guide data on the
   **Channel Mapping** screen.
4. Create **Users** with per-user access lists — each gets a personal **tokenized `.m3u` + XMLTV guide
   URL** for their IPTV client.

> [!IMPORTANT]
> This sample enviornment variable is also included in the release notes and the `main` branch repository: `.env.example` \
> Ensure you update `COMPOSE_PATH` `BACKUPS_PATH` `MONGO_DATA_PATH` with the appropriate folders for your system. \
> \
> For the best experience, create each folder path assigned to `COMPOSE_PATH` `BACKUPS_PATH` `MONGO_DATA_PATH` before composing the docker stack. 
> ```bash
> mkdir compose && chown -R 1000:1000 ./compose && chmod -R 777 ./compose
> mkdir backups && chown -R 1000:1000 ./backups && chmod -R 777 ./backups
> mkdir mongo && chown -R 999:999 ./mongo && chmod -R 777 ./mongo
> ```

### Environment variables

```yaml
# EXAMPLE .env.example
#
# App settings seeded into the Mongo `settings` doc on first provisioning only
# ($setOnInsert — changing these after the first boot has no effect; edit in the
# Settings UI instead). Distinct from the infra config in config.json.
# Host directory for composed .m3u + XMLTV guide exports (bind-mounted to
# /app/compose) so they survive a container rebuild. Must be writable by the
# container's `node` user (uid 1000): e.g.
#   mkdir -p </absolute/path/> && sudo chown -R 1000:1000 </absolute/path/>
# BACKUPS_PATH is the analogous host directory for scheduled backups (bind-mounted
# to /backups, the settings.backupLocation default) — same uid-1000 writability
# caveat as COMPOSE_PATH; defaults to ./backups if left unset.
# ------------------------------------------------------------------------------------------

DISPLAY_NAME=masqueradarr
# DOMAIN is the URL clients use to reach the app — keep its port in sync with MASQUERADARR_PORT
# (e.g. http://localhost:8080 if you publish on 8080).
DOMAIN=http://localhost:3000
# Host port the app is published on (maps to the container's fixed internal 3000).
# Change this if 3000 is already taken on your host, then update DOMAIN to match.
MASQUERADARR_PORT=3000
TZ=America/New_York
COMPOSE_PATH=/absolute/path/to/masqueradarr-vols/compose
BACKUPS_PATH=/absolute/path/to/masqueradarr-vols/backups
APP_USER_ID=1000
APP_GROUP_ID=1000

# Outbound-fetch DNS nameserver(s) for the app's OUTBOUND requests (M3U/EPG fetches, mirror
# directory scrapes, HLS proxy) are NOT configured here — there is no NAMESERVER env. On first
# provision the persisted `settings.nameservers` is seeded with a hardcoded default of
# 8.8.8.8,8.8.4.4 (Google public DNS); edit it on the Settings screen afterwards (Mongo wins; the
# change applies live, no restart). Affects global fetch() only — not MongoDB or the ffmpeg/Chromium
# subprocesses. DNS_LOG_LEVEL (1|2|3) still seeds `settings.dnsLogLevel` on first provision: 1 =
# lifecycle + issues only, 2 = + per-host resolution deduped, 3 = every lookup (shown in the View
# logs drawer, core category).
# ------------------------------------------------------------------------------------------

DNS_LOG_LEVEL=2

# MongoDB root credentials. Seed the `mongo` service's root user AND drive the app's config
# bootstrap: the app self-provisions config.json in-container on boot (docker/app-entrypoint.sh)
# as mongodb://<user>:<pass>@mongo:27017/masqueradarr?authSource=admin (creds URL-encoded — special
# chars in the password are safe). There is no separate config-init service and no host config
# mount; config.json lives at /app/config/config.json inside the container, regenerated each boot.
# MONGO_HOST_PORT = Host port that maps to mongod's 27017 (override if 27017 is taken).
# MONGO_DATA_PATH = Host directory for persistent MongoDB data (bind-mounted to /data/db).
# ------------------------------------------------------------------------------------------

MONGO_ROOT_USER=masqueradarr
MONGO_ROOT_PASS=changeme
MONGO_HOST_PORT=27017
MONGO_DATA_PATH=/absolute/path/to/masqueradarr-vols/mongo
MONGO_USER_ID=999
MONGO_GROUP_ID=999

# Optional: point the app at an external/remote Mongo instead of the compose `mongo` service.
# Set MONGO_URI to a full connection string (used verbatim — e.g. an Atlas mongodb+srv:// URI),
# or just MONGO_HOST/MONGO_HOST_PORT/MONGO_DB to assemble it from the creds.
# ------------------------------------------------------------------------------------------
# MONGO_PORT=27017
# MONGO_HOST=mongo
# MONGO_DB=masqueradarr
# MONGO_URI=mongodb://MONGO_ROOT_USER:MONGO_ROOT_PASS@MONGO_HOST:MONGO_PORT/MONGO_DB?authSource=admin

```

### Docker compose

```yaml
services:
  masqueradarr:
    # SPECIFY THE IMAGE TAG TO USE ':dev' or ':latest'
    # image: iflip721/masqueradarr:latest
    image: iflip721/masqueradarr:dev
    user: "${APP_USER_ID:-1000}:${APP_GROUP_ID:-1000}"
    # build:
    #   context: .
    #   dockerfile: docker/app.Dockerfile
    environment:
      MONGO_ROOT_USER: ${MONGO_ROOT_USER}
      MONGO_ROOT_PASS: ${MONGO_ROOT_PASS}
      DISPLAY_NAME: ${DISPLAY_NAME:-masqueradarr}
      DOMAIN: ${DOMAIN:-http://localhost:3000}
      TZ: ${TZ:-America/New_York}
      DNS_LOG_LEVEL: ${DNS_LOG_LEVEL:-2}
    ports:
      - "${MASQUERADARR_PORT:-3000}:3000"
    volumes:
      - ${COMPOSE_PATH:-./compose}:/app/compose:rw
      - ${BACKUPS_PATH:-./backups}:/backups:rw
    depends_on:
      mongo:
        condition: service_healthy
    networks: [masqueradarr-net]
    restart: unless-stopped
    # ── Hardware-accelerated transcoding (WS6, opt-in) ──────────────────────────────────────────────────
    # The externalPlayer engine (Settings → Video Configuration → Hardware acceleration) can offload transcoding
    # to a GPU. The image already bundles a multi-vendor ffmpeg (jellyfin-ffmpeg: VAAPI/QSV/NVENC) on a glibc
    # base, so no special image tag is needed — just pass the GPU. The server detects usable encoders at boot →
    # videoconfig.hwAccel.detected (the card offers only those). Enable ONE of the following (left commented — a
    # `devices:` entry for a missing node stops the container from starting, so don't uncomment on a GPU-less host):
    #   • Intel Quick Sync / AMD VAAPI — pass the render node and join the group that owns it so uid 1000 can open it:
    #       devices: ["/dev/dri:/dev/dri"]
    #       group_add: ["${RENDER_GID:-44}"]   # GID owning /dev/dri/renderD128 on the host: stat -c '%g' /dev/dri/renderD128
    #   • NVIDIA NVENC — install nvidia-container-toolkit on the host (the image already ships an nvenc-enabled
    #     ffmpeg + NVIDIA_DRIVER_CAPABILITIES=compute,video,utility baked in), then:
    #       deploy:
    #         resources:
    #           reservations:
    #             devices: [{ driver: nvidia, count: all, capabilities: [gpu] }]

  mongo:
    # If you have issues using MongoDB 7.x due to legacy hardware switch value for MongoDB 4.x or highe
    image: mongo:7.0.15
    user: "${MONGO_USER_ID:-999}:${MONGO_GROUP_ID:-999}"
    environment:
      MONGO_INITDB_ROOT_USERNAME: ${MONGO_ROOT_USER}
      MONGO_INITDB_ROOT_PASSWORD: ${MONGO_ROOT_PASS}
    ports:
      - "${MONGO_HOST_PORT:-27017}:27017"
    volumes:
      - ${MONGO_DATA_PATH:-mongo-data}:/data/db
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping').ok"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks: [masqueradarr-net]
    restart: unless-stopped

volumes:
  # Fallback named volume — used only when MONGO_DATA_PATH is unset.
  mongo-data:

networks:
  masqueradarr-net:
```

### Configuration

All runtime settings live in **MongoDB** and are editable on the **Settings** screen (domain, DNS
nameservers, video configuration, backups, …). The `.env` only **bootstraps infrastructure on first
boot**:

| Variable | Purpose |
|---|---|
| `MONGO_ROOT_USER` / `MONGO_ROOT_PASS` | MongoDB root credentials; also assemble the app's `mongoUri`. |
| `DOMAIN` | Public base URL written into composed playlist / guide links. |
| `DISPLAY_NAME` | App display name. |
| `TZ` | Container timezone (used by the scheduler). |
| `COMPOSE_PATH` | Host dir for composed `.m3u` + XMLTV exports (uid-1000 writable). |
| `BACKUPS_PATH` | Host dir for scheduled backups. |
| `MONGO_DATA_PATH` | Host dir for persistent MongoDB data. |
| `MONGO_HOST_PORT` | Host port mapped to mongod (default `27017`). |
| `MONGO_URI` / `MONGO_HOST` | Optional — point the app at an external / Atlas MongoDB instead of the compose `mongo` service. |
| `DNS_LOG_LEVEL` | Outbound-DNS trace verbosity (`1`–`3`); seeds the setting on first boot. |

> App-settings vars are seeded with `$setOnInsert` — they apply on the **first provision only**. Change
> them in the Settings UI afterward; a redeploy won't clobber UI changes.

### Development

The repo is **two independently-built npm packages** (not a workspace):

```bash
# Frontend (repo root) — Vite dev server on :5173, proxies /api → http://localhost:3000
npm install && npm run dev

# Backend (server/) — tsx watch on :3000 (needs a reachable MongoDB)
cd server && npm install && npm run dev
```

There is **no test runner and no linter** — correctness is verified by `npm run build` (type-check) in
each package and by running the app.

---

# Playlists

> **Scope:** the playlist data model — what a playlist *is*, the built-in vs. custom kinds, how guide
> data binds to it, and how per-user access is granted. The catalog (`playlistchannels`) and the export
> surface (`.m3u` + XMLTV guide sibling) meet here.

### How Playlists work

A **Playlist** is a row in the `playlists` collection — the *envelope* (name, hosted URL, endpoint mode,
schedule, state). Its **channels live separately** in `playlistchannels`, queried by the playlist's
`source` (or clone) id. A playlist row with no channels is a valid, paused shell.

- **Two channel stores back every playlist.** A sync writes a pristine, source-of-truth `sourcechannels`
  reference, then projects it into the editable, UI-facing `playlistchannels`. You edit the latter (rename,
  disable, channel #, EPG link) and your edits **survive a re-sync**: a sync `$set`s source-derived fields,
  `$setOnInsert`s the user-editable ones, and prunes channels that vanished upstream.
- **Hosted URL + endpoint mode.** A `global`-endpoint playlist is served through the one consolidated Global
  M3U endpoint; a `custom`-endpoint playlist is served at its own path. The `url` ("HOSTED AT") always
  prepends `settings.domain`, so changing the domain in **Settings cascades** to every playlist's URL.
- **State + schedule.** `state:false` pauses the endpoint (downstream clients get a 404). `interval` + `auto`
  drive the scheduler; a manual **Sync now** is always available.
- **Streaming is resolve-on-demand.** A channel's stream URL is *derived* (`/api/v1/<source>/<enc-entry>`),
  never stored, so the proxy resolves the real upstream at play time. Every channel keeps an `origin` source,
  so a cloned or imported channel still routes through the right adapter.

### What kinds of playlists are possible

| Kind | `source` tag | Created via | Channels |
|---|---|---|---|
| **(Default) source playlist** | `dulo` / `dlhd` / `tubi` | Add Playlist → **Built-In** (provisions a zero-channel shell; populates on first **Sync now**) | Synced from the adapter; `id === source` |
| **Clone** | `clone` | Add Playlist → **Clone** — hand-pick channels from any synced source | Independent COPIES in `playlistchannels`; `origin` = the provider source for routing |
| **URL import** | `url` | Add Playlist → **URL** — fetch a remote `.m3u` / `.m3u8` | Parsed from the upstream; re-syncable via the stored `remoteUrl` |
| **File upload** | `file` | Add Playlist → **File** — upload a static `.m3u` | Parsed once from the uploaded file |
| **HDHomeRun** | `hdhomerun` | Add Playlist → **HDHomeRun** — point at a LAN tuner (`deviceUrl`) | Discovered from the device; raw MPEG-TS remuxed to HLS, capped at the tuner count |

Built-in defaults are **Global-endpoint** by default; the custom kinds are **Custom-endpoint** and ride the
per-playlist export machinery (their own path + guide sibling). All the type tags (`clone`/`file`/`url`/
`hdhomerun`) and modes (`global`/`custom`) are stored **lowercase**.

### Playlists + EPG Sources with Playlist Binding

Guide data reaches a playlist through **two distinct mechanisms** — keep them separate:

1. **Channel-level guide linking (the everyday case).** EPG attaches to a playlist through its *channels*,
   not the playlist row. Each channel carries a 2-factor **`(tvg_id, epg)`** link — set on the **Channel
   Mapping** screen (or self-linked by sources that ship their own EPG). At compose time the guide is built
   from exactly the channels that carry a link, so "which EPG sources feed this playlist" is simply
   *whichever sources its channels are mapped to* — many sources can contribute to one playlist's guide.
2. **Playlist-bound EPG sources (`playlistBinding`).** **tubi** and **dlhd** carry their *own* inline guide.
   When you sync such a playlist, its `afterSync` hook writes the guide **and** upserts a matching EPG source
   row flagged **`playlistBinding: true`**, then self-links the playlist's channels to it. These rows are
   *owned by the playlist's sync* — the playlist drives their refresh cadence, so the EPG Sources screen
   hides their manual-sync + schedule controls. You never add or schedule them by hand.

### Assigning Playlist access to users

- Access is a **per-user allow-list**, split to mirror the endpoint modes: `allowedPlaylists`
  (Global-endpoint playlists) and `allowedCustomPlaylists` (Custom-endpoint playlists).
- You assign membership on the **Playlists screen** (per playlist — it was moved here off the Users screen),
  not by editing the user.
- **Admins ⇒ every playlist.** An admin account's allow-lists are *materialized* to hold every playlist id
  (a real invariant, not just a role bypass), and creating a new playlist auto-grants it to all admins — so
  an admin always sees the full catalog.
- Each user gets a personal, **tokenized** `.m3u` + XMLTV guide URL for their IPTV client: the **download is
  token-free**, but the **stream is token-gated** to that user's allowed playlists.

---

# EPG Sources

> **Scope:** the guide-data subsystem — what an EPG source *is*, the provider kinds, the one shared sync
> path, how playlist-bound self-EPG differs, and how guide data is woven into a playlist's `.m3u` at
> compose time. The XMLTV wire format itself is the sibling of the M3U export.

### How EPG Sources work

An **EPG source** is a row in `epgsources` registering one guide provider. A sync writes two collections:
**`epgchannels`** (one row per guide channel) and **`programs`** (the airings), both keyed by a composite
**`<epg>:<tvg_id>`** id so multiple sources never collide.

- **One shared sync path.** Every kind goes through `syncEpgSource.ts`, whether triggered by a manual
  **Sync now** or by a scheduler tick; it maintains the per-source `syncSuccessCount` / `syncFailCount` and
  `status`.
- **A sync is a per-source replace.** The source's old channels/programs are swapped for the fresh pull. The
  streaming-XMLTV path replaces up-front, so a mid-stream failure marks the source `error` and the next good
  sync heals it cleanly (the shared `epgchannels`/`programs` collections are scoped by `source`).
- **Reorder + run-stats.** The EPG Sources screen is drag-to-reorder (`order`); the guide-generation
  run-stats (`lastXmlAt`, `xmlGeneratedCount`, `xmlFailCount`) are credited during compose (below).

### What kinds of EPG Sources are possible

The `source` discriminator (stored lowercase):

| Kind | Added via | Notes |
|---|---|---|
| **gracenote** | Add EPG Source → **Gracenote** | Provider/lineup grid; provenance fields (headend / lineup / postal / country / …) let the grid URL be rebuilt + re-synced |
| **epg-pw** | Add EPG Source → **EPG-PW** | epg.pw per-channel XML |
| **jesmann** | Add EPG Source → **Jesmann** (guided picker) | Large national XMLTV guides, **streamed** so multi-GB files parse with bounded memory |
| **xml file** | Add EPG Source → **Custom** (upload) | One-shot uploaded XMLTV document |
| **remote url** | Add EPG Source → **Custom** (URL) | Re-fetchable remote XMLTV URL (streamed, gzip-aware) |
| **tubi** / **dlhd** | *(automatic)* — the playlist's `afterSync` | **Playlist-bound** self-EPG (`playlistBinding:true`); not user-added |

### EPG Sources with a Playlist Binding + the syncing process

- **Standalone sources** (gracenote / epg-pw / jesmann / custom XMLTV) sync on demand or on a `cronjobs`
  schedule, independent of any playlist.
- **Playlist-bound sources** (tubi / dlhd) have **no manual sync of their own.** They are written by the
  *playlist's* `afterSync` hook off the same listing that playlist sync already fetched, and the bound source
  row is re-asserted (`playlistBinding:true`) on every playlist sync. To refresh a bound guide you **sync its
  playlist** — the EPG Sources screen deliberately hides their sync/schedule controls because the playlist
  owns the cadence.
- Either way, the *binding between guide data and a playlist's channels* is the channel-level
  **`(tvg_id, epg)`** link — Channel Mapping for user-added sources, self-linked for tubi/dlhd.

### How EPG Sources are ingested into playlists during a compose

Guide data only reaches a downstream client at **compose** time, and composition is **playlist-scoped**: a
guide is written as a **sibling of the M3U** by `composeGuide()`, which runs off the *same Active channel set*
`composeM3u()` just wrote (the Global union, or one Custom playlist) — so a guide can never drift from its M3U.

```mermaid
graph LR
    M["composeM3u(surface)<br/>Active channels"] --> G["composeGuide(sameChannels, path)"]
    G --> S["keep Active + (tvg_id, epg)-linked<br/>key = &lt;epg&gt;:&lt;tvg_id&gt;"]
    S --> C["epgchannels → &lt;channel&gt;<br/>(dedupe by bare tvg_id, first-wins)"]
    S --> P["programs → &lt;programme&gt;<br/>(re-tag to bare tvg_id)"]
    C --> X["&lt;tv&gt; written beside the .m3u"]
    P --> X
    X --> A["M3U advertises it via x-tvg-url<br/>token-free, NOT per-user"]
    X --> R["credit each source:<br/>lastXmlAt + xmlGeneratedCount++"]
```

Per composed surface:

1. **Select** — keep only **Active** channels that carry a 2-factor **`(tvg_id, epg)`** link; index them by
   the composite key `<epg>:<tvg_id>`.
2. **Channels** — resolve each key's `epgchannels` row (display-name / call-sign / channel-no) and emit one
   `<channel>`, **de-duped by the bare `tvg_id`** (first-wins — two sources can publish the same id and a
   player can't disambiguate anyway). A channel linked to an `epgchannels` row that isn't synced yet is
   skipped, never orphaned.
3. **Programmes** — pull the `programs` for those keys and emit `<programme>`s, **re-tagged to the bare
   `tvg_id`** so each airing matches its `<channel id>`.
4. **Merge + advertise** — the result merges programme data from **every EPG source the playlist's channels
   link to** into one `<tv>` document written next to the `.m3u`, advertised via **`x-tvg-url`**. The guide is
   **token-free** and **not per-user** (a superset of any one user's channels is harmless).
5. **Credit** — every contributing source gets `lastXmlAt` + `xmlGeneratedCount++` (or `xmlFailCount++` on
   failure).

---

# Video Engine

> **Scope:** how a stream session opened by a **IPTV client** (TiviMate, IPTV Client, VLC, UHF, IPTV One,
> ffmpeg-tier players) is served and made observable — the **externalPlayer** path. This is the engine half of
> the appPlayer / externalPlayer split (the "robust-donut" rollout); its sibling is the in-app slide-out player.
> This doc traces only what is externalPlayer-specific.
>
> **One-line:** external clients subscribe to a per-user `.m3u` whose channel URLs are the **`/api/ext/v1`**
> mount (the M3U composer writes them, carrying `&pl=<owningPlaylistId>` so the per-playlist config is selectable).
> The external HLS path is **composer-free + engine-driven** — there is **no B-Roll slate** on external (that's the
> in-app `/api/v1` path only). When an engine is enabled in **Settings → Video Configuration**, those sessions are
> routed through a shared per-channel **ffmpeg or VLC** process that transcodes/normalizes **and** captures
> loading/buffering/failed health for an otherwise-opaque client — output as **loopback HLS** (default) or an
> opt-in **raw MPEG-TS socket**. With no engine enabled, `/api/ext` is a plain **B-Roll-free direct relay**, so
> external clients keep working either way; a resolve/engine failure is a clean error (**502**), not a slate.

### Plain language

A TiviMate/IPTV Client/VLC user downloads their personal playlist file from TVApp2 and the app plays its channels.
Those channels point at a special server URL (`/api/ext/...`) that TVApp2 writes specifically for outside
apps. The problem this solves: an outside app is a **black box** — it never tells the server "I'm buffering" or
"this failed," and it may need a different video format than the source provides.

So TVApp2 can put a **media engine** (ffmpeg, or optionally VLC) in the middle. The engine pulls the channel
once, optionally re-encodes it to something every player accepts, and — crucially — **watches its own health**
(is it keeping up? did it stall? did it die?) so the server can show that session's state on the **Active
Streams** and **History** screens, exactly like an in-app session. One engine process is shared by everyone
watching that channel.

Unlike the in-app player, the external path does **not** show the broadcast-style "holding card" (B-Roll) while
a channel is starting up or failing — an outside app supplies its own loading/error UI, so the server just hands
over the stream and, if it can't, returns a clean error (the in-app player keeps the slate). There are two ways
to hand the bytes over:

- **HLS (default)** — the engine writes a normal HLS stream the server already knows how to serve and count.
  Works for almost every modern client (TiviMate, IPTV Client, VLC, Emby). The server fetches the engine's output and
  rewrites/serves it through the same proxy plumbing the in-app path uses — but **without** the B-Roll composer.
- **Raw TS (opt-in)** — the classic "IPTV link": one long-held connection streaming MPEG-TS, for older
  raw-only clients. This needs its own connection-counting because such a client never re-polls.

If GPU hardware is present, the engine can offload re-encoding to it (NVENC / Intel QSV / VAAPI); the server
detects what's usable at startup so the Settings screen only offers real options. If no engine is turned on,
nothing changes — the URL just relays the source straight through.

### Functional flow

```mermaid
graph TD
    A["IPTV client (TiviMate/IPTV Client/VLC/…)<br/>downloads per-user .m3u → GET /api/ext/v1/&lt;src&gt;/&lt;enc&gt;?token=&amp;pl="] --> B["stream-access gate (routes/sources.ts)<br/>same token model as /api/v1"]
    B -->|401/403| Bx["plain-text error"]
    B --> C0["resolvePlaylistConfigId(?pl)<br/>→ configId: 'app' | 'app_&lt;pl&gt;'"]
    C0 --> C["getVideoConfigCached(configId) (5s TTL, per-id)"]
    C --> D{"enabledEngine?"}
    D -->|"null (off)"| R["B-Roll-free DIRECT RELAY<br/>(serveEntry returns adapter master)"]
    D -->|ffmpeg / vlc| E{"output?"}

    E -->|"hls (default)"| F["serveEntry = makeExternalHlsEntry<br/>resolveStream · noteViewer · ensureProbe<br/>(externalEngine.ts) — COMPOSER-FREE, no B-Roll"]
    F -->|resolve/engine fail| Fx["clean 502 (no slate)"]
    F --> G["spawn ffmpeg/cvlc (shared per channel+config)<br/>key = streamKey#configId · advancedArgs → buildFfmpegArgv/buildVlcArgv"]
    G --> H["live HLS window → 127.0.0.1 loopback dir"]
    H --> P["proxy handler direct-hop: fetch loopback master<br/>· child-rewrite /api/ext/v1 (+ &amp;token= &amp;pl=) · serve bytes<br/>engine owns streamState (no composer)"]
    R --> P
    P --> A

    E -->|"ts (opt-in)"| J["createExternalTsHandler → ensureTsStream<br/>(externalTsEngine.ts)"]
    J --> K["spawn ffmpeg -f mpegts pipe:1 / cvlc dst=/dev/stdout"]
    K --> L["188-aligned RING BUFFER (byte-capped)"]
    L --> M["fan-out to N client sockets (per-client cursor<br/>+ backpressure + skip-forward) · video/mp2t"]
    M --> A

    G -. health .-> N["engineHealth: ffmpeg -progress (pipe:1 / pipe:3)<br/>VLC cadence noteProducerAlive + watchdog<br/>→ streamState live/buffer/failed"]
    K -. health .-> N
    P -. poll-recency: noteViewer/noteBytes .-> T["streamTelemetry → ViewSession playerType=externalPlayer"]
    M -. socket-liveness: noteSocketViewerOpen/Bytes/Close .-> T
    N -.-> T
    T --> U["Active Streams (External pill) + History"]

    HW["boot hwDetect.ts: ffmpeg -encoders ∩ /dev nodes<br/>→ videoconfig.hwAccel.detected"] -. gates HW presets .-> C
```
