#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# docker/aio-entrypoint.sh — masqueradarr "all-in-one" supervisor.
#
# Runs mongod (localhost-only, --auth) + the Node app together in ONE container as the unprivileged
# `node` user (uid/gid 1000). The container starts as root ONLY long enough to fix data-dir ownership
# on a fresh bind-mount, then drops privileges to `node` via gosu for BOTH processes.
#
# Startup ordering is load-bearing: server/src/db.ts does a single no-retry mongoose.connect with a
# 5s server-selection timeout and server/src/index.ts treats a failed connect as FATAL (exit 1). So we
# start mongod and WAIT until it accepts TCP on 27017 BEFORE launching node.
#
# Shutdown ordering is load-bearing too: stop node FIRST (so index.ts's SIGTERM handler runs its
# orderly teardown incl. `await disconnect()`), THEN mongod (clean WiredTiger checkpoint).
#
# tini stays PID 1 (reaps zombies, forwards SIGTERM/SIGINT to this script). See docker/aio.Dockerfile.
# -----------------------------------------------------------------------------
set -euo pipefail

NODE_UID=node                            # uid/gid 1000 in node:*-bookworm-slim
DATA_DIR=/data
DB_DIR=/data/db
COMPOSE_DIR=/data/compose
BACKUPS_DIR="${BACKUPS_DIR:-/data/backups}"   # scheduled-backup target (settings.backupLocation seed)
CONFIG_PATH="${MASQUERADARR_CONFIG:-/data/config.json}"
SECRET_PATH=/data/.mongo-secret          # first-boot sentinel + credential store (user\npass)
MONGO_HOST=127.0.0.1
MONGO_PORT=27017
WT_CACHE="${MONGO_CACHE_GB:-}"           # optional WiredTiger cache cap for memory-constrained hosts

log() { printf '[aio] %s\n' "$*"; }

# 1. As root: ensure data dirs exist and are owned by uid 1000. A fresh named volume arrives
#    root-owned; a host bind mount arrives owned by the host uid. mongod needs /data/db writable;
#    node needs /data/compose writable (the boot mkdirSync + every export write run as uid 1000) and
#    /data/backups writable (the scheduled-backup target, BACKUPS_DIR — same uid).
mkdir -p "$DB_DIR" "$COMPOSE_DIR" "$BACKUPS_DIR"
chown "$NODE_UID:$NODE_UID" "$DATA_DIR" "$DB_DIR" "$COMPOSE_DIR" "$BACKUPS_DIR" 2>/dev/null || true

# 2. Start mongod — always --auth, bound to loopback only (never port-exposed).
#    NO --logpath: mongod treats --logpath as a *rotatable* file (it reopens/seeks it for rotation),
#    so /dev/stdout (a pipe under Docker's logging driver, reopened via /proc/self/fd/1 after gosu drops
#    to uid 1000) fails with "FileNotOpen: Can't initialize rotatable log file". Omitting --logpath makes
#    mongod log to stdout by default (what the official mongo image does) — captured by `docker logs`.
MONGO_ARGS=(--dbpath "$DB_DIR" --bind_ip "$MONGO_HOST" --port "$MONGO_PORT" --auth)
[ -n "$WT_CACHE" ] && MONGO_ARGS+=(--wiredTigerCacheSizeGB "$WT_CACHE")
log "starting mongod: ${MONGO_ARGS[*]}"
gosu "$NODE_UID" mongod "${MONGO_ARGS[@]}" &
MONGO_PID=$!

# 3. Wait (bounded ~30s) until mongod accepts TCP, using the Node runtime already present (no mongosh).
log "waiting for mongod on ${MONGO_HOST}:${MONGO_PORT} ..."
READY=0
for _ in $(seq 1 60); do
  kill -0 "$MONGO_PID" 2>/dev/null || { log "FATAL: mongod exited during startup"; exit 1; }
  if gosu "$NODE_UID" node -e 'const s=require("net").connect(27017,"127.0.0.1");s.setTimeout(800);
      s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1));
      s.on("timeout",()=>{s.destroy();process.exit(1)});'; then READY=1; break; fi
  sleep 0.5
done
[ "$READY" -eq 1 ] || { log "FATAL: mongod not ready in time"; kill "$MONGO_PID" 2>/dev/null || true; exit 1; }
log "mongod is accepting connections"

# 4. FIRST BOOT (no /data/.mongo-secret): resolve creds, create the root user via MongoDB's localhost
#    exception, THEN commit the secret. Creating the user before writing the secret means a transient
#    failure leaves no secret -> next boot retries cleanly (the exception is still open, no user yet).
#    MONGO_ROOT_USER/MONGO_ROOT_PASS apply on FIRST BOOT ONLY (parity with the compose stack); after
#    that the embedded creds live in /data/.mongo-secret. Unset pass -> a strong random one.
if [ ! -s "$SECRET_PATH" ]; then
  MUSER="${MONGO_ROOT_USER:-tvapp}"
  MPASS="${MONGO_ROOT_PASS:-$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')}"
  log "first boot — seeding mongo root user '$MUSER' via localhost exception"
  gosu "$NODE_UID" env MUSER="$MUSER" MPASS="$MPASS" node -e '
    const { MongoClient } = require("mongodb");
    (async () => {
      const c = new MongoClient("mongodb://127.0.0.1:27017");
      await c.connect();
      try {
        await c.db("admin").command({
          createUser: process.env.MUSER,
          pwd: process.env.MPASS,
          roles: [{ role: "root", db: "admin" }],
        });
      } finally { await c.close(); }
    })().catch((e) => { console.error("[aio] createUser failed:", e.message); process.exit(1); });'
  printf '%s\n%s\n' "$MUSER" "$MPASS" > "$SECRET_PATH"
  chown "$NODE_UID:$NODE_UID" "$SECRET_PATH"
  chmod 600 "$SECRET_PATH"
else
  MUSER="$(sed -n 1p "$SECRET_PATH")"
  MPASS="$(sed -n 2p "$SECRET_PATH")"
fi

# 5. config-init: (re)write config.json UNLESS it already targets the embedded loopback mongod.
#    server/src/config.ts requires the file to exist before node starts (mongoUri has no env override).
#    Mirrors docker-compose.yml's config-init idempotency — leave a correct config alone, regenerate a
#    stale one (e.g. an `@mongo:` config left on a shared /data volume by the compose stack). The creds
#    come from /data/.mongo-secret (resolved above), so a regen still matches the seeded mongo user.
if [ ! -s "$CONFIG_PATH" ] || ! grep -q '@127.0.0.1:' "$CONFIG_PATH"; then
  log "config-init: writing $CONFIG_PATH (embedded authed mongod)"
  URI="$(gosu "$NODE_UID" env MUSER="$MUSER" MPASS="$MPASS" node -e \
    'const e=encodeURIComponent;process.stdout.write(`mongodb://${e(process.env.MUSER)}:${e(process.env.MPASS)}@127.0.0.1:27017/masqueradarr?authSource=admin`)')"
  cat > "$CONFIG_PATH" <<JSON
{
  "mongoUri": "${URI}",
  "port": ${PORT:-3000},
  "logLevel": "${LOG_LEVEL:-info}"
}
JSON
  chown "$NODE_UID:$NODE_UID" "$CONFIG_PATH"
else
  log "config-init: $CONFIG_PATH already targets the embedded mongod — leaving alone"
fi

# 5b. Start Xvfb (virtual X server) as the node uid so the dulo streamed-login browser can run HEADFUL
#     (Google's "Continue with Google" gate blocks headless). Lightweight + started once; the browser launches
#     lazily on first WS connect, well after the display is ready. DISPLAY=:99 comes from docker/aio.Dockerfile.
#     If Xvfb can't start the app still runs; only the streamed login degrades.
log "starting Xvfb on ${DISPLAY:-:99}"
gosu "$NODE_UID" Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!

# 6. Start the app as node.
log "starting node app"
gosu "$NODE_UID" node dist/index.js &
NODE_PID=$!

# 7. Shutdown: node FIRST (lets index.ts flush the log store + await disconnect()), then mongod.
sd=0
shutdown() {
  [ "$sd" -eq 1 ] && return
  sd=1
  log "signal — stopping node"
  kill -TERM "$NODE_PID" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$NODE_PID" 2>/dev/null || break; sleep 0.25; done
  kill -KILL "$NODE_PID" 2>/dev/null || true
  log "stopping mongod"
  kill -TERM "$MONGO_PID" 2>/dev/null || true
  for _ in $(seq 1 80); do kill -0 "$MONGO_PID" 2>/dev/null || break; sleep 0.25; done
  kill -KILL "$MONGO_PID" 2>/dev/null || true
  [ -n "${XVFB_PID:-}" ] && kill -TERM "$XVFB_PID" 2>/dev/null || true
  log "shutdown complete"
}
trap 'shutdown' TERM INT

# 8. If EITHER process dies on its own, tear down the other and exit non-zero so the container stops
#    (no half-alive container) and the restart policy recycles it.
while :; do
  kill -0 "$NODE_PID"  2>/dev/null || { log "node exited unexpectedly — tearing down mongod"; shutdown; exit 1; }
  kill -0 "$MONGO_PID" 2>/dev/null || { log "mongod exited unexpectedly — tearing down node"; shutdown; exit 1; }
  sleep 1
done
