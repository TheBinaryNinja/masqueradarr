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
#    docker/app.Dockerfile. KEEP THE TWO IN SYNC whenever either changes. Both images share the
#    node:22-bookworm-slim glibc base (required by this image's copied-in mongod, which is glibc-only), so the
#    runtime BASE is not a divergence. The only intentional divergence left is the all-in-one delta: mongod +
#    gosu + the /data redirect + the supervisor entrypoint,
#    and no `USER node` line because the entrypoint starts as root to chown the data volume.
#    (app.Dockerfile carries the same RUNTIME_IMAGE/RUST_IMAGE args; MONGO_IMAGE is aio-only.)
#
# All-in-one specifics:
#   - mongod (server only) runs --auth, bound to 127.0.0.1 ONLY (never port-exposed).
#   - A bash supervisor (docker/aio-entrypoint.sh) runs config-init -> mongod -> ready-gate -> node
#     under tini, dropping both long-lived processes to the `node` uid (1000) via gosu.
#   - One /data volume holds the DB (/data/db), composed exports (/data/compose via a symlink from the
#     non-overridable /app/compose), the config (/data/config.json), and the embedded mongo creds.
#
# AVX NOTE: on amd64, mongod 5.0+ requires a CPU with AVX (same constraint as the standard mongo:7.0.15
# image), so the DEFAULT build will not start on older Atom/Celeron/pre-2011 Xeon hosts or on a
# hypervisor exposing a kvm64/qemu64 CPU model — mongod dies instantly with SIGILL ("Illegal
# instruction"). Those hosts want the mongo4.4-* tags built by .github/workflows/docker-publish-mongo44.yml
# (4.4 predates the AVX requirement), or the multi-container compose stack with `image: mongo:4.4`.
# -----------------------------------------------------------------------------

# ---- Base-image matrix (build args) ----
# The DEFAULTS below reproduce the standard mongo-7 image exactly — the normal workflow passes only
# APP_VERSION. `Build and Publish Mongo 4.4` overrides all four TOGETHER, because they are not
# independent: MONGO_IMAGE's Ubuntu base decides which OpenSSL the copied-in mongod needs, and the Rust
# sidecar is dynamically linked against the RUNTIME glibc, so RUST_IMAGE must track RUNTIME_IMAGE or
# masq-proxy fails to load with `GLIBC_2.34 not found`.
#
#   MONGO_IMAGE               ->  needs         ->  RUNTIME_IMAGE / NODE_IMAGE  ->  RUST_IMAGE
#   mongo:7.0.15  (jammy 22.04, glibc 2.35)  OpenSSL 3    node:22*-bookworm-slim     rust:1-bookworm
#   mongo:4.4.30-focal (focal 20.04, glibc 2.31)  OpenSSL 1.1  node:22*-bullseye-slim  rust:1-bullseye
#
# (bullseye reaches EOL ~2026-08-31; once Debian moves it to archive.debian.org the runtime apt blocks
# below will 404 on that variant only — fix is an sources.list rewrite to archive.debian.org plus
# `-o Acquire::Check-Valid-Until=false`. The default bookworm build is unaffected.)
ARG NODE_IMAGE=node:22.11.0-bookworm-slim
ARG RUNTIME_IMAGE=node:22-bookworm-slim
ARG RUST_IMAGE=rust:1-bookworm
ARG MONGO_IMAGE=mongo:7.0.15

# ---- mongod binary source: the official multi-arch mongo image (amd64 + arm64) ----
# MongoDB ships arm64 ONLY via its Ubuntu builds — the Debian apt repo is amd64-only (its bookworm
# InRelease advertises no arm64), which is why an apt install fails the arm64 build. The official
# `mongo` image is multi-arch and built from those Ubuntu packages, so we copy mongod out of it per
# target arch. The Ubuntu binary runs on the Debian runtime below because glibc is forward-compatible
# and the OpenSSL ABI is paired by the matrix above (7.0/jammy needs libssl3, which bookworm has;
# 4.4/focal needs libssl1.1, which bullseye has) — libcurl4, added in the runtime, satisfies its last
# dep in both cases. The 7.0.15 default matches docker-compose.yml's MONGO = 7.0.15.
FROM ${MONGO_IMAGE} AS mongo

# ---- Stage 1: build the SPA (root package) — MIRRORS docker/app.Dockerfile ----
FROM ${NODE_IMAGE} AS spa-build
WORKDIR /spa
COPY package.json package-lock.json ./
RUN npm ci
# Both HTML entry points (vite.config.ts build.rollupOptions.input): index.html = the SPA,
# player.html = the Ultimate Player window. Listed by name, so a new entry must be added here too.
COPY tsconfig.json tsconfig.node.json vite.config.ts index.html player.html ./
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

# ---- Stage 2b: build the Rust video-proxy sidecar (masq-proxy) — MIRRORS docker/app.Dockerfile ----
# Debian base → glibc, and it MUST be the SAME Debian release as RUNTIME_IMAGE: masq-proxy is dynamically
# linked, so a bookworm-built binary (glibc 2.36) will not load on a bullseye runtime (glibc 2.31). That
# is the whole reason RUST_IMAGE exists as an arg — it moves with RUNTIME_IMAGE, never on its own. There
# is no OpenSSL coupling here: the crate uses rustls + RustCrypto, not system OpenSSL (proxy/Cargo.toml).
# The durable video DATA PLANE that node spawns + supervises on loopback (server/src/proxy/sidecar.ts).
# Produces /proxy/target/release/masq-proxy. cargo-chef splits the dependency compile into its own
# gha-cacheable layer (busts only on Cargo.toml/Cargo.lock change). See app.Dockerfile for the full
# rationale (keep the two in sync).
FROM ${RUST_IMAGE} AS chef
RUN cargo install cargo-chef --locked
WORKDIR /proxy

FROM chef AS planner
COPY proxy/ ./
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS proxy-build
COPY --from=planner /proxy/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json   # deps only — the gha-cached layer
COPY proxy/ ./
RUN cargo build --release                                 # only the masq-proxy crate recompiles

# ---- Stage 3: runtime (app + mongod + config-init supervisor) ----
# Debian base (bookworm by default) — same as app.Dockerfile (both are glibc). This image additionally MUST
# stay glibc regardless of the app image: the mongod binary copied in from the official mongo image (the
# `mongo` stage) is a glibc build and won't run on musl. It must also ship the OpenSSL major that mongod was
# linked against — see the base-image matrix at the top; that pairing is why RUNTIME_IMAGE and MONGO_IMAGE
# are overridden together and never one at a time. The dulo browser here is Debian's apt `chromium` (same as
# app.Dockerfile). mongod is copied (not apt-installed) because MongoDB's Debian repo has no arm64.
FROM ${RUNTIME_IMAGE} AS runtime
# BACKUPS_DIR redirects the scheduled-backup target into the single /data volume (the server seeds
# settings.backupLocation from this env default). The standard image instead defaults to /backups (a
# bind-mountable dir created in app.Dockerfile) — an intentional all-in-one delta, like the /data redirect.
ENV NODE_ENV=production \
    MASQUERADARR_CONFIG=/data/config.json \
    BACKUPS_DIR=/data/backups \
    CHROMIUM_PATH=/usr/bin/chromium \
    DISPLAY=:99
WORKDIR /app
ARG TARGETARCH

# App runtime deps (MIRROR app.Dockerfile): tini (PID 1, forwards SIGTERM to graceful shutdown), ca-certificates,
# xvfb (virtual X server for the dulo streamed-login browser, which runs HEADFUL — aio-entrypoint.sh starts Xvfb
# on DISPLAY=:99 before node), and chromium + fonts-liberation (the distro browser puppeteer-core drives for the
# dulo login, executablePath=CHROMIUM_PATH=/usr/bin/chromium). (Video-engine teardown: ffmpeg/ffprobe + the
# jellyfin-ffmpeg overlay + all GPU-hwaccel deps — NVIDIA_DRIVER_CAPABILITIES, libva2/va-driver-all/vainfo,
# intel-gpu-tools, radeontop — were removed. No video is served until a new playback engine is rebuilt.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates xvfb chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Prod-only server deps (MIRROR app.Dockerfile): express, mongoose, ws, puppeteer-core. puppeteer-core ships no
# browser binary — the dulo login uses the distro `chromium` installed above — so nothing to download here.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# All-in-one additions: gosu (per-process privilege drop) + libcurl4 (the one mongod runtime lib not
# already in the node:*-slim base). This line is variant-agnostic and MUST NOT name an libssl package:
# libcurl4 itself Depends on libssl3 in bookworm and on libssl1.1 in bullseye, which is exactly what
# mongod 7.0 and 4.4 respectively link against — so the matrix at the top drags in the right one for free,
# whereas a hardcoded libssl would break the other variant. The Node runtime already present does the
# mongod readiness probe and the first-boot user creation via the transitive mongodb driver, so no mongosh
# is needed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu libcurl4 \
 && rm -rf /var/lib/apt/lists/*

# mongod (server only) — the binary lifted from the official multi-arch mongo image named by MONGO_IMAGE
# (see the `mongo` stage). COPY --from selects the matching-arch mongod per build platform.
COPY --from=mongo /usr/bin/mongod /usr/bin/mongod

# Compiled server + built SPA + committed source snapshots (MIRROR app.Dockerfile).
COPY --from=server-build /server/dist  ./dist
COPY --from=spa-build    /spa/dist     ./public
COPY server/seed-data                  ./seed-data

# Rust video-proxy sidecar — spawned + supervised by node on loopback (server/src/proxy/sidecar.ts). MIRRORS
# app.Dockerfile. The aio entrypoint gosu-drops node to uid 1000; the child inherits that uid and execs this
# root-owned 0755 binary. node forwards shutdown to the child; the supervisor stops node first, then mongod.
COPY --from=proxy-build /proxy/target/release/masq-proxy /usr/local/bin/masq-proxy

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
