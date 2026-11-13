#!/usr/bin/env bash
# Cloud 9 — restore the SQLite database from a backup made by docker/backup.sh (or any .db / .db.gz copy).
#
#   sudo /opt/cloud9/docker/restore.sh /var/backups/cloud9/c9-20261114T180000Z.db.gz
#   sudo /opt/cloud9/docker/restore.sh --yes <file>      # no confirmation prompt
#
# Steps: unpack the backup into ./data/.restore-tmp → PRAGMA integrity_check in a one-off container
#        (the live app keeps running if the backup is bad) → stop the app → move the current
#        cloud9.db, -wal and -shm to ./data/pre-restore-<time>/ → move the backup in → start the app
#        → wait for /healthz. If the swap fails, the previous files are put back.
#
# This replaces ALL data (quizzes, sessions, results) with the backup's content. Live players are
# disconnected for a few seconds and reconnect automatically.
#
# Settings (environment variables, all optional): COMPOSE_DIR, SERVICE (app), DB_NAME (cloud9.db),
# HOST_DATA ($COMPOSE_DIR/data), CONTAINER_DATA (/data), APP_UID (1000, owner of the restored file),
# HEALTH_URL (http://127.0.0.1:3000/healthz, empty = skip the wait).
#
# Exit codes: 0 restored · 1 usage / cancelled · 2 backup unreadable or failed integrity check (nothing changed)
#             3 swap or start failed (previous files restored when possible; see messages)
set -Eeuo pipefail
umask 027

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$(dirname "$SCRIPT_DIR")}"
SERVICE="${SERVICE:-app}"
DB_NAME="${DB_NAME:-cloud9.db}"
HOST_DATA="${HOST_DATA:-$COMPOSE_DIR/data}"
CONTAINER_DATA="${CONTAINER_DATA:-/data}"
APP_UID="${APP_UID:-1000}"
HEALTH_URL="${HEALTH_URL-http://127.0.0.1:3000/healthz}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [restore] $*"; }
die() { local code="$1"; shift; log "ERROR: $*"; exit "$code"; }

YES=0
if [ "${1:-}" = "--yes" ] || [ "${1:-}" = "-y" ]; then YES=1; shift; fi
SRC="${1:-}"
[ -n "$SRC" ] || { echo "usage: $0 [--yes] <backup.db|backup.db.gz>" >&2; exit 1; }
[ -f "$SRC" ] || die 1 "backup not found: $SRC"
[ -f "$COMPOSE_DIR/docker-compose.yml" ] || die 1 "no docker-compose.yml in COMPOSE_DIR=$COMPOSE_DIR"
[ -d "$HOST_DATA" ] || die 1 "data dir not found: $HOST_DATA"
cd "$COMPOSE_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP_REL=".restore-tmp"
CAND="$HOST_DATA/$TMP_REL/$DB_NAME"
mkdir -p "$HOST_DATA/$TMP_REL"
rm -f "$CAND" "$CAND-wal" "$CAND-shm"

# 1) Unpack the candidate next to the live DB (same filesystem → atomic mv later).
case "$SRC" in
  *.gz) gzip -dc -- "$SRC" >"$CAND" || die 2 "cannot decompress $SRC" ;;
  *)    cp -- "$SRC" "$CAND" || die 2 "cannot copy $SRC" ;;
esac
[ "$(id -u)" = 0 ] && chown -R "$APP_UID:$APP_UID" "$HOST_DATA/$TMP_REL"
chmod 640 "$CAND"

# 2) Integrity check in a one-off container (works whether or not the app is up; the live DB is untouched).
JS='
const Database = require("better-sqlite3");
const db = new Database(process.argv[1], { readonly: true, fileMustExist: true });
const res = db.pragma("integrity_check", { simple: true });
const t = db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name IN (?, ?)").all("table", "quizzes", "sessions").length;
const s = t === 2 ? db.prepare("SELECT count(*) AS n FROM sessions").get().n : -1;
db.close();
if (res !== "ok") { console.error("integrity_check: " + res); process.exit(2); }
if (t !== 2) { console.error("not a Cloud 9 database (quizzes/sessions tables missing)"); process.exit(2); }
console.log("ok sessions=" + s);
'
if ! OUT="$(docker compose run --rm --no-deps -T "$SERVICE" node -e "$JS" "$CONTAINER_DATA/$TMP_REL/$DB_NAME" 2>&1)"; then
  rm -f "$CAND"
  die 2 "backup failed the check, nothing changed: $OUT"
fi
log "backup verified ($OUT)"

if [ "$YES" != 1 ]; then
  echo "This REPLACES the live database ($HOST_DATA/$DB_NAME) with $SRC and restarts the app."
  read -r -p "Type RESTORE to continue: " ans
  [ "$ans" = "RESTORE" ] || { rm -f "$CAND"; die 1 "cancelled, nothing changed"; }
fi

# 3) Stop the app (graceful: flushes pending answers), then move the current files aside.
log "stopping $SERVICE"
docker compose stop "$SERVICE" || die 3 "docker compose stop failed, nothing changed"
ASIDE="$HOST_DATA/pre-restore-$STAMP"
mkdir -p "$ASIDE"
moved=()
for f in "$DB_NAME" "$DB_NAME-wal" "$DB_NAME-shm"; do
  if [ -e "$HOST_DATA/$f" ]; then mv -- "$HOST_DATA/$f" "$ASIDE/$f"; moved+=("$f"); fi
done
log "previous files moved to $ASIDE (${moved[*]:-none})"

rollback() {
  log "rolling back to the previous database"
  rm -f "$HOST_DATA/$DB_NAME" "$HOST_DATA/$DB_NAME-wal" "$HOST_DATA/$DB_NAME-shm"
  for f in "${moved[@]}"; do mv -- "$ASIDE/$f" "$HOST_DATA/$f"; done
  docker compose up -d --no-build "$SERVICE" || true
}

# 4) Swap in and start.
if ! mv -- "$CAND" "$HOST_DATA/$DB_NAME"; then rollback; die 3 "could not move the backup into place"; fi
log "starting $SERVICE"
if ! docker compose up -d --no-build "$SERVICE"; then rollback; die 3 "docker compose up failed"; fi

# 5) Wait for the app to answer.
if [ -n "$HEALTH_URL" ] && command -v curl >/dev/null 2>&1; then
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then log "healthy: $(curl -fsS --max-time 2 "$HEALTH_URL")"; break; fi
    sleep 2
  done
  curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1 || die 3 "app not healthy after 60 s — check 'docker compose logs --tail=100 $SERVICE'; previous DB is in $ASIDE"
fi
log "done. Previous database kept in $ASIDE (delete it once you are happy)."
