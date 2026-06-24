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

# ---- Stage 3: runtime -------------------------------------------------------
# Debian (bookworm) base — glibc, so the externalPlayer engine gets GPU hardware acceleration across all vendors:
# NVIDIA NVENC works (the NVIDIA Container Toolkit injects glibc driver libs — libnvidia-encode / libcuda — that a
# musl/Alpine runtime cannot dlopen), alongside AMD VAAPI and Intel QSV. This converges the base with the AIO image
# (bookworm because its copied-in mongod is glibc-only); the only remaining divergence is the config bootstrap (see
# SYNC NOTE). The dulo streamed-login browser drives Debian's apt `chromium`. Trade-off: the image is ~0.5–0.7 GB
# larger than the former Alpine runtime.
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MASQUERADARR_CONFIG=/app/config/config.json \
    CHROMIUM_PATH=/usr/bin/chromium \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility \
    DISPLAY=:99
WORKDIR /app
ARG TARGETARCH

# tini = correct PID 1 (forwards SIGTERM/SIGINT to the graceful-shutdown handler in index.ts; Debian's apt
# installs it at /usr/bin/tini — see ENTRYPOINT).
# ffmpeg = needed by the B-Roll slate encoder (sources/core/broll.ts) AND the externalPlayer engine
#   (externalEngine.ts / externalTsEngine.ts) that remuxes/transcodes third-party-client streams; the stream
#   probe (streamProbe.ts) needs the matching ffprobe. The B-Roll text is rasterized in pure Node (no drawtext/
#   freetype). The apt ffmpeg is a baseline only — it has NO NVENC (that needs proprietary nv-codec-headers at
#   build time). NVENC (+ a curated multi-vendor VAAPI/QSV runtime) comes from jellyfin-ffmpeg, overlaid below
#   and symlinked onto /usr/local/bin so every consumer that spawns `ffmpeg`/`ffprobe` by bare name uses it.
#   libva2 + va-driver-all + vainfo give a VAAPI baseline + the vainfo diagnostic. For NVIDIA run the nvidia
#   container runtime + pass the GPU; for AMD/Intel pass /dev/dri (docker-compose.yml). Boot detection
#   (videoconfig/hwDetect.ts) then lists only what's actually usable on the host.
# intel-gpu-tools + radeontop = LIVE GPU usage monitors for the Dashboard "GPU Performance" card
#   (stats/gpu.ts): intel_gpu_top (Intel render/video engine %) and radeontop (AMD utilization fallback when
#   sysfs gpu_busy_percent is absent). AMD's primary path is /sys/class/drm sysfs (no binary); NVIDIA needs no
#   monitor here — nvidia-smi is injected at runtime by the NVIDIA Container Toolkit (utility capability).
#   intel-gpu-tools is x86-only (Intel GPUs don't exist on arm64) and HAS NO arm64 Debian package, so it is
#   installed ONLY when TARGETARCH=amd64 — otherwise the arm64 build fails with "Unable to locate package".
#   On arm64 stats/gpu.ts simply finds no intel_gpu_top and degrades to the AMD/NVIDIA paths.
# vlc = the SECONDARY externalPlayer engine (cvlc, headless; WS7) — operators can switch the engine to VLC in
#   Settings → Video Configuration. ffmpeg is the recommended default (cleaner -progress health); VLC's health is
#   coarser (segment/byte cadence). NOTE: `vlc` is a large package (Qt/X deps) — it's baked in by choice so the
#   engine works out-of-the-box; remove it to slim the image if VLC is never used (the code then degrades
#   VLC→direct-relay gracefully, logged once).
# chromium (+ fonts-liberation) = the distro browser the dulo streamed-login drives via puppeteer-core
# (executablePath=CHROMIUM_PATH=/usr/bin/chromium); nss/freetype/harfbuzz arrive transitively with chromium.
# xvfb = virtual framebuffer / X server for that browser, which runs HEADFUL (Google's "Continue with Google"
# gate blocks headless). app-entrypoint.sh starts Xvfb on DISPLAY=:99 before node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini ffmpeg vlc ca-certificates xvfb chromium fonts-liberation \
      libva2 va-driver-all vainfo radeontop \
 && if [ "${TARGETARCH}" = "amd64" ]; then \
      apt-get install -y --no-install-recommends intel-gpu-tools; \
    fi \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# jellyfin-ffmpeg = a multi-vendor ffmpeg/ffprobe that bundles its OWN GPU runtime (VAAPI, Intel QSV via
# iHD/oneVPL, and NVIDIA NVENC/NVDEC) — this is what actually unlocks NVENC, which the apt ffmpeg lacks (and is
# why the runtime is glibc/Debian, not musl/Alpine). The .deb is fetched per target arch (amd64/arm64) and pinned
# for reproducible builds (bump JELLYFIN_FFMPEG_VERSION to upgrade). It installs under /usr/lib/jellyfin-ffmpeg;
# we symlink ffmpeg+ffprobe into /usr/local/bin (ahead of /usr/bin on PATH) so the engine, B-Roll encoder, and
# stream probe pick it up by bare name with no code change. curl is purged after use (keeps the image curl-free).
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

# Prod-only server deps (express, mongoose, ws, puppeteer-core). puppeteer-core ships no browser binary — the
# dulo login uses the distro `chromium` installed above — so there's no browser download to skip here.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled server + built SPA + committed source snapshots (syncLive offline fallback).
COPY --from=server-build /server/dist  ./dist
COPY --from=spa-build    /spa/dist ./public
COPY server/seed-data                  ./seed-data

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
