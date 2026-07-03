# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# docker/app.Dockerfile — masqueradarr "app stack" image (iflip721/masqueradarr)
#
# Three-stage build:
#   1) spa-build    — Vue 3 + Vite SPA  → /spa/dist        (root package.json)
#   2) server-build — Express API (tsc) → /server/dist     (server/package.json)
#   3) runtime      — prod-only Node; serves API + built SPA on :3000
#
# SYNC NOTE: docker/aio.Dockerfile (the self-contained "all-in-one" variant: app + mongod + config bootstrap
# in one container) MIRRORS the spa-build/server-build stages and the app half of runtime below — keep
# the two in sync whenever either changes. Both images now share the same Debian (bookworm) base, so the ONLY
# intentional divergence is the config-bootstrap: this standard image self-provisions config.json via a
# node-only entrypoint (docker/app-entrypoint.sh → /app/config/config.json, regenerated from .env each boot);
# the AIO image uses its root supervisor (docker/aio-entrypoint.sh → /data/config.json). Do NOT "re-sync"
# those two — it would break one.
#
# Runtime layout (must match server/src/paths.ts publicDir/composeDir and sources/paths.ts SEED_SOURCES_DIR):
#   /app/dist/        compiled server  (dist/index.js, dist/sources/paths.js)
#   /app/public/      built SPA        (resolve(<dist>,'..','public')              => /app/public; read-only)
#   /app/compose/     composed .m3u exports (resolve(<dist>,'..','compose')        => /app/compose; node-writable)
#   /app/config/      generated config.json (MASQUERADARR_CONFIG; node-writable, written at boot by app-entrypoint.sh)
#   /app/seed-data/   source snapshots (resolve(<dist>,'..','..','seed-data','sources') — syncLive offline fallback)
#   /app/package.json server pkg (type:module) + node_modules (express, mongoose, ws, puppeteer-core)
#   (Chromium is the distro apt package — /usr/bin/chromium — for the dulo streamed-login browser, loginBrowser.ts)
#
# Node pin: 22.x LTS. ALL stages are Debian bookworm (build: node:22.11.0-bookworm-slim; runtime:
# node:22-bookworm-slim). The base is glibc so the externalPlayer engine can use GPU hardware acceleration across
# every vendor — NVIDIA NVENC (the NVIDIA Container Toolkit injects glibc driver libs that a musl/Alpine runtime
# cannot dlopen), AMD VAAPI, and Intel QSV. The dulo streamed-login browser drives Debian's `chromium` apt package
# via puppeteer-core. Keep the Node major in lockstep with CLAUDE.md.
# -----------------------------------------------------------------------------
ARG NODE_IMAGE=node:22.11.0-bookworm-slim

# ---- Stage 1: build the SPA (root package) ----------------------------------
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

# ---- Stage 2: build the server (server package) -----------------------------
FROM ${NODE_IMAGE} AS server-build
WORKDIR /server
COPY server/package.json server/package-lock.json ./
RUN npm ci                              # devDeps (typescript) to compile the server
COPY server/tsconfig.json ./
COPY server/src/ ./src/
RUN npm run build                       # tsc -p .  -> /server/dist

# ---- Stage 2b: build the Rust video-proxy sidecar (masq-proxy) --------------
# Debian bookworm base → glibc, matching the runtime stage so the binary loads (a musl/Alpine build would
# not run on the glibc runtime — the same base constraint as the Node stages). This is the durable video
# DATA PLANE that node spawns + supervises on loopback (server/src/proxy/sidecar.ts); the control plane
# (resolve/policy/auth) stays in Node. `COPY proxy/ ./` pulls the whole crate (Cargo.toml + src, and
# Cargo.lock when committed); cargo generates a lock if absent. Produces /proxy/target/release/masq-proxy.
FROM rust:1-bookworm AS proxy-build
WORKDIR /proxy
COPY proxy/ ./
RUN cargo build --release

# ---- Stage 3: runtime -------------------------------------------------------
# Debian (bookworm) base — glibc, matching the AIO image (bookworm because its copied-in mongod is glibc-only);
# the only remaining divergence is the config bootstrap (see SYNC NOTE). The dulo streamed-login browser drives
# Debian's apt `chromium`. (The video engine + all ffmpeg/GPU-hwaccel deps were removed in the video-engine
# teardown — see the runtime deps below; the base stays Debian for mongod parity, not for NVENC.)
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MASQUERADARR_CONFIG=/app/config/config.json \
    CHROMIUM_PATH=/usr/bin/chromium \
    DISPLAY=:99
WORKDIR /app
ARG TARGETARCH

# tini = correct PID 1 (forwards SIGTERM/SIGINT to the graceful-shutdown handler in index.ts; Debian's apt
# installs it at /usr/bin/tini — see ENTRYPOINT).
# chromium (+ fonts-liberation) = the distro browser the dulo streamed-login drives via puppeteer-core
# (executablePath=CHROMIUM_PATH=/usr/bin/chromium); nss/freetype/harfbuzz arrive transitively with chromium.
# xvfb = virtual framebuffer / X server for that browser, which runs HEADFUL (Google's "Continue with Google"
# gate blocks headless). app-entrypoint.sh starts Xvfb on DISPLAY=:99 before node.
# (Video-engine teardown: ffmpeg/ffprobe + the jellyfin-ffmpeg overlay + all GPU-hwaccel deps —
# NVIDIA_DRIVER_CAPABILITIES, libva2/va-driver-all/vainfo, intel-gpu-tools, radeontop — were removed. No video
# is served until a new playback engine is rebuilt.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini ca-certificates xvfb chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Prod-only server deps (express, mongoose, ws, puppeteer-core). puppeteer-core ships no browser binary — the
# dulo login uses the distro `chromium` installed above — so there's no browser download to skip here.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled server + built SPA + committed source snapshots (syncLive offline fallback).
COPY --from=server-build /server/dist  ./dist
COPY --from=spa-build    /spa/dist ./public
COPY server/seed-data                  ./seed-data

# Rust video-proxy sidecar — spawned + supervised by node on loopback (server/src/proxy/sidecar.ts). Root-owned
# 0755, so USER node can exec it. No entrypoint change: node forwards its own SIGTERM-driven shutdown to the child.
COPY --from=proxy-build /proxy/target/release/masq-proxy /usr/local/bin/masq-proxy

# /app/compose is the runtime write target for composed .m3u exports — m3u/compose.ts creates dirs + writes
# files under composeDir as USER node (the manual "Compose m3u" button + the playlist-m3u cron tick), and
# index.ts mkdirSync's it at boot. /app/config is where app-entrypoint.sh writes the generated config.json
# (MASQUERADARR_CONFIG) before launching node. /backups is the default scheduled-backup target dir
# (settings.backupLocation; node-writable; bind-mountable via BACKUPS_PATH in docker-compose.yml so backups
# survive a rebuild). /app itself is root-owned (WORKDIR), so ALL THREE dirs MUST be pre-created and chowned
# to node here — otherwise the boot mkdir / config write / every export or backup write fail with EACCES.
# In compose, /app/compose is bind-mounted to a host path via COMPOSE_PATH (docker-compose.yml) so exports
# survive a rebuild; this pre-create + chown stays as the mount point and the ownership fallback for a bare
# `docker run` without the mount. /app/config is image-internal (never mounted) and regenerated from .env on
# every boot. SPA assets in /app/public stay root-owned/read-only.
RUN mkdir -p /app/compose /app/config /backups && chown node:node /app/compose /app/config /backups

# Config bootstrap: replaces the former one-shot `config-init` compose service. Runs as USER node, writes
# config.json from .env, then execs CMD (`node dist/index.js`). See header SYNC NOTE — AIO has its own.
COPY docker/app-entrypoint.sh /usr/local/bin/app-entrypoint.sh
RUN chmod +x /usr/local/bin/app-entrypoint.sh

USER node
EXPOSE 3000

# Liveness: HTTP server up (body also reports mongo connected/disconnected). Uses Node's global fetch since
# this slim image ships no wget/curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/app-entrypoint.sh"]
CMD ["node", "dist/index.js"]
