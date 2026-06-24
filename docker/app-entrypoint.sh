#!/bin/sh
# -----------------------------------------------------------------------------
# docker/app-entrypoint.sh — standard "app stack" config bootstrap.
#
# Self-provisions the infra config (config.json) on every boot, then execs the Node app.
# Replaces the former one-shot `config-init` compose service: the app now writes its own
# config, so the compose stack needs no sidecar and no host config bind-mount.
#
# Runs as USER node (uid 1000) under tini — MASQUERADARR_CONFIG points at a dir this user owns
# (mkdir+chown in docker/app.Dockerfile), so no root/gosu is needed (unlike the AIO supervisor
# in docker/aio-entrypoint.sh, which must start as root to chown /data and run mongod). config.json
# is 100% derived from env (no persisted secret), so an unconditional regen is always correct —
# no idempotency / leave-alone branch (those exist in AIO/compose only because they wrote to a
# *shared persistent* volume that another stack might own; here the file is image-internal).
#
# mongoUri precedence:
#   1) MONGO_URI            — full connection string, used verbatim (external host / Atlas).
#   2) MONGO_HOST/PORT/...  — assembled from parts (host defaults to compose's `mongo`).
# Credentials are URL-encoded via Node's encodeURIComponent (handles @ : / ? # in passwords —
# the latent bug in the old printf-based config-init, which did no encoding).
# -----------------------------------------------------------------------------
set -eu

CONFIG_PATH="${MASQUERADARR_CONFIG:-/app/config/config.json}"

if [ -n "${MONGO_URI:-}" ]; then
    URI="$MONGO_URI"
else
    URI="$(MONGO_ROOT_USER="${MONGO_ROOT_USER:-}" MONGO_ROOT_PASS="${MONGO_ROOT_PASS:-}" \
        MONGO_HOST="${MONGO_HOST:-mongo}" MONGO_PORT="${MONGO_PORT:-27017}" MONGO_DB="${MONGO_DB:-MASQUERADARR}" \
        node -e 'const e=encodeURIComponent,u=e(process.env.MONGO_ROOT_USER||""),p=e(process.env.MONGO_ROOT_PASS||""),a=u?`${u}:${p}@`:"";process.stdout.write(`mongodb://${a}${process.env.MONGO_HOST}:${process.env.MONGO_PORT}/${process.env.MONGO_DB}?authSource=admin`)')"
fi

URI="$URI" PORT="${PORT:-3000}" LOG_LEVEL="${LOG_LEVEL:-info}" CONFIG_PATH="$CONFIG_PATH" \
    node -e 'require("node:fs").writeFileSync(process.env.CONFIG_PATH,JSON.stringify({mongoUri:process.env.URI,port:Number(process.env.PORT)||3000,logLevel:process.env.LOG_LEVEL||"info"},null,2)+"\n")'
echo "[app-entrypoint] wrote ${CONFIG_PATH} (mongo host: ${MONGO_HOST:-mongo})"

# Start Xvfb (virtual X server) so the dulo streamed-login browser can run HEADFUL — see docker/app.Dockerfile.
# Background + a brief readiness wait; node stays the `exec` target so tini's SIGTERM still reaches index.ts's
# graceful-shutdown handler (do NOT wrap node in xvfb-run — that would insert a layer and break the signal path).
# If Xvfb can't start the app still boots; the login browser just degrades with a clear error.
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
for _ in $(seq 1 20); do
    if [ -e /tmp/.X11-unix/X99 ]; then break; fi
    sleep 0.2
done
echo "[app-entrypoint] Xvfb on ${DISPLAY:-:99}"

exec "$@"
