# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# docker/aio.Dockerfile — masqueradarr "all-in-one" image (iflip721/masqueradarr)
#
# A SELF-CONTAINED build that merges all three docker-compose services — app + mongod + config-init —
# into ONE container, so the whole app runs from a single `docker run` with one data volume and no
# external MongoDB:
#
#   docker run -d --name masqueradarr -p 3000:3000 -v masqueradarr-data:/data iflip721/masqueradarr:latest
#
# To publish on a different host port, change the LEFT side of -p, e.g. `-p 8080:3000` (the container
# always serves on 3000 internally; the compose stack's MASQUERADARR_PORT env var does not apply here).
#
# Unlike a layered build, this needs NO prerequisite image — build it directly:
#   docker build -f docker/aio.Dockerfile -t iflip721/masqueradarr:latest .
#
# !! The spa-build / server-build stages and the APP HALF of the runtime stage MIRROR
#    docker/app.Dockerfile. KEEP THE TWO IN SYNC whenever either changes. Both images now share the
#    node:22-bookworm-slim glibc base (app.Dockerfile moved off Alpine so the externalPlayer engine can do
#    GPU hwaccel — NVENC needs glibc), so the runtime BASE is no longer a divergence. The only intentional
#    divergence left is the all-in-one delta: mongod + gosu + the /data redirect + the supervisor entrypoint,
#    and no `USER node` line because the entrypoint starts as root to chown the data volume.
#
# All-in-one specifics:
#   - mongod 7.0 (server only) runs --auth, bound to 127.0.0.1 ONLY (never port-exposed).
#   - A bash supervisor (docker/aio-entrypoint.sh) runs config-init -> mongod -> ready-gate -> node
#     under tini, dropping both long-lived processes to the `node` uid (1000) via gosu.
#   - One /data volume holds the DB (/data/db), composed exports (/data/compose via a symlink from the
#     non-overridable /app/compose), the config (/data/config.json), and the embedded mongo creds.
#
# AVX NOTE: on amd64, mongod 7.0 requires a CPU with AVX (same constraint as the standard mongo:7.0.15
# image). On hosts without AVX, use the multi-container compose stack instead.
# -----------------------------------------------------------------------------
ARG NODE_IMAGE=node:22.11.0-bookworm-slim

# ---- mongod binary source: the official multi-arch mongo image (amd64 + arm64) ----
# MongoDB ships arm64 ONLY via its Ubuntu builds — the Debian apt repo is amd64-only (its bookworm
# InRelease advertises no arm64), which is why an apt install fails the arm64 build. The official
# `mongo` image is multi-arch and built from those Ubuntu (jammy) packages, so we copy mongod out of it
# per target arch. The jammy binary runs on the bookworm runtime below (glibc is forward-compatible and
# the openssl 3 ABI matches; libcurl4 added there satisfies its last dep — verified). Pinned to 7.0.15
# to match docker-compose.yml's MONGO = 7.0.15.
FROM mongo:7.0.15 AS mongo

# ---- Stage 1: build the SPA (root package) — MIRRORS docker/app.Dockerfile ----
FROM ${NODE_IMAGE} AS spa-build
WORKDIR /spa
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.node.json vite.config.ts index.html ./
COPY src/ ./src/
# APP_VERSION = the published image tag (passed by the docker-build-all skill). Baked into the SPA as
# import.meta.env.VITE_APP_VERSION so the sidebar shows which release is running; 'dev' if unset.
ARG APP_VERSION=dev
ENV VITE_APP_VERSION=$APP_VERSION
RUN npm run build                       # vue-tsc -b && vite build -> /spa/dist

# ---- Stage 2: build the server (server package) — MIRRORS docker/app.Dockerfile ----
FROM ${NODE_IMAGE} AS server-build
WORKDIR /server
COPY server/package.json server/package-lock.json ./
RUN npm ci                              # devDeps (typescript) to compile the server
COPY server/tsconfig.json ./
COPY server/src/ ./src/
RUN npm run build                       # tsc -p .  -> /server/dist

# ---- Stage 3: runtime (app + mongod + config-init supervisor) ----
# Debian (bookworm) base — same as app.Dockerfile (both are glibc). This image additionally MUST stay glibc
# regardless of the app image: the mongod binary copied in from the official mongo image (the `mongo` stage) is
# a glibc build and won't run on musl. The dulo browser here is Debian's apt `chromium` (same as app.Dockerfile).
# mongod is copied (not apt-installed) because MongoDB's Debian repo has no arm64.
FROM node:22-bookworm-slim AS runtime
# BACKUPS_DIR redirects the scheduled-backup target into the single /data volume (the server seeds
# settings.backupLocation from this env default). The standard image instead defaults to /backups (a
# bind-mountable dir created in app.Dockerfile) — an intentional all-in-one delta, like the /data redirect.
ENV NODE_ENV=production \
    MASQUERADARR_CONFIG=/data/config.json \
    BACKUPS_DIR=/data/backups \
    CHROMIUM_PATH=/usr/bin/chromium \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility \
    DISPLAY=:99
WORKDIR /app
ARG TARGETARCH

# App runtime deps: tini (PID 1, forwards SIGTERM to graceful shutdown), ffmpeg (a baseline — the B-Roll slate
# encoder AND the externalPlayer engine — externalEngine.ts/externalTsEngine.ts — that remuxes/transcodes client
# streams; the actual engine binary is the jellyfin-ffmpeg overlay below), ca-certificates, xvfb (virtual X
# server for the dulo streamed-login browser, which runs HEADFUL — aio-entrypoint.sh starts Xvfb on DISPLAY=:99
# before node), and chromium + fonts-liberation (the distro browser puppeteer-core drives for the dulo login,
# executablePath=CHROMIUM_PATH=/usr/bin/chromium). app.Dockerfile installs the same browser the same way (apt on
# bookworm) — the two images now share the base. libva2 + va-driver-all + vainfo give a VAAPI baseline + the
# vainfo diagnostic; intel-gpu-tools + radeontop are the LIVE GPU monitors for the Dashboard "GPU Performance"
# card (stats/gpu.ts — intel_gpu_top + AMD radeontop fallback; AMD primary is sysfs, NVIDIA uses the
# toolkit-injected nvidia-smi). (MIRROR app.Dockerfile's VAAPI additions.) intel-gpu-tools is x86-only and has
# NO arm64 Debian package, so it installs ONLY when TARGETARCH=amd64 (else the arm64 build fails to locate it);
# on arm64 stats/gpu.ts just falls back off intel_gpu_top.
# vlc = the SECONDARY externalPlayer engine (cvlc, headless; WS7 — MIRROR app.Dockerfile). ffmpeg stays the
# recommended default; VLC's health is coarser. Large package (Qt/X deps) — baked in by choice so the engine
# works out-of-the-box; the code degrades VLC→direct-relay gracefully if it were ever absent.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ffmpeg vlc ca-certificates xvfb chromium fonts-liberation \
      libva2 va-driver-all vainfo radeontop \
 && if [ "${TARGETARCH}" = "amd64" ]; then \
      apt-get install -y --no-install-recommends intel-gpu-tools; \
    fi \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# jellyfin-ffmpeg = the multi-vendor ffmpeg/ffprobe overlay (MIRROR app.Dockerfile) that bundles its OWN GPU
# runtime (VAAPI, Intel QSV via iHD/oneVPL, NVIDIA NVENC/NVDEC) — this is what unlocks NVENC, which the apt
# ffmpeg lacks. Fetched per target arch + pinned for reproducible builds; symlinked into /usr/local/bin (ahead
# of /usr/bin on PATH) so the engine, B-Roll, and probe pick it up by bare name. For NVIDIA run the nvidia
# container runtime + pass the GPU; boot detection (videoconfig/hwDetect.ts) lists what's usable.
ARG JELLYFIN_FFMPEG_VERSION=7.1.4-3
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && curl -fsSL -o /tmp/jellyfin-ffmpeg.deb \
      "https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${JELLYFIN_FFMPEG_VERSION}/jellyfin-ffmpeg7_${JELLYFIN_FFMPEG_VERSION}-bookworm_${TARGETARCH}.deb" \
 && apt-get install -y --no-install-recommends /tmp/jellyfin-ffmpeg.deb \
 && ln -sf /usr/lib/jellyfin-ffmpeg/ffmpeg  /usr/local/bin/ffmpeg \
 && ln -sf /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe \
 && apt-get purge -y --auto-remove curl \
 && rm -f /tmp/jellyfin-ffmpeg.deb \
 && rm -rf /var/lib/apt/lists/*

# Prod-only server deps (MIRROR app.Dockerfile): express, mongoose, ws, puppeteer-core. puppeteer-core ships no
# browser binary — the dulo login uses the distro `chromium` installed above — so nothing to download here.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# All-in-one additions: gosu (per-process privilege drop) + libcurl4 (the one mongod runtime lib not
# already in node:bookworm-slim). The Node runtime already present does the mongod readiness probe and
# the first-boot user creation via the transitive mongodb driver, so no mongosh is needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu libcurl4 \
 && rm -rf /var/lib/apt/lists/*

# mongod 7.0 (server only) — the binary lifted from the official multi-arch mongo image (see the `mongo`
# stage). COPY --from selects the matching-arch mongod per build platform.
COPY --from=mongo /usr/bin/mongod /usr/bin/mongod

# Compiled server + built SPA + committed source snapshots (MIRROR app.Dockerfile).
COPY --from=server-build /server/dist  ./dist
COPY --from=spa-build    /spa/dist     ./public
COPY server/seed-data                  ./seed-data

# /app/compose is non-overridable (server/src/paths.ts resolves it relative to the compiled module),
# so redirect it into the single /data volume. The app's boot mkdirSync + every export write then land
# on the mounted volume through this symlink. (No /app/compose mkdir+chown and NO `USER node` here —
# unlike app.Dockerfile — because the entrypoint runs as root to chown /data on a fresh bind-mount,
# then gosu-drops both processes to uid 1000.) The backups dir needs NO symlink: BACKUPS_DIR (set in the
# runtime ENV above) points the backup target straight at /data/backups, which aio-entrypoint.sh creates +
# chowns to uid 1000 on boot alongside /data/db.
RUN ln -s /data/compose /app/compose

COPY docker/aio-entrypoint.sh /usr/local/bin/aio-entrypoint.sh
RUN chmod +x /usr/local/bin/aio-entrypoint.sh

VOLUME ["/data"]
EXPOSE 3000
# 27017 deliberately NOT exposed — mongod is loopback-only (--bind_ip 127.0.0.1 in the entrypoint).

# Same HTTP liveness as the standard image (the body also reports mongo connected/disconnected). Longer
# start-period because mongod init + the readiness wait delay first serve.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini stays PID 1 (reaps zombies, forwards SIGTERM/SIGINT). The entrypoint orchestrates config-init +
# mongod + node and drops both to uid 1000 via gosu. USER stays root so the entrypoint can chown the
# data dir on a fresh bind-mount before dropping privileges. CMD [] clears any inherited default args
# (the script owns process startup).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/aio-entrypoint.sh"]
CMD []
