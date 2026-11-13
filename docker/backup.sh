#!/usr/bin/env bash
# Cloud 9 — online, WAL-safe SQLite backup of the running app container.
#
#   sudo /opt/cloud9/docker/backup.sh            # one backup now
#   BACKUP_REMOTE=user@laptop:/backups/cloud9 sudo -E /opt/cloud9/docker/backup.sh
#
# Steps: better-sqlite3 .backup() inside the app container (safe while players are playing)
#        → PRAGMA integrity_check on the copy → move it OUT of ./data → gzip → chmod 600
#        → keep the newest $KEEP → optional off-box copy ($BACKUP_REMOTE).
#
# Settings (environment variables, all optional):
#   COMPOSE_DIR     directory with docker-compose.yml            (default: the repo this script is in)
#   BACKUP_DIR      where backups are kept on the host            (default: /var/backups/cloud9, mode 700)
#   KEEP            number of backups to keep in BACKUP_DIR       (default: 14)
#   BACKUP_REMOTE   off-box copy target, empty = none:
#                     user@host:/path      → rsync over SSH (key auth; cron has no agent)
#                     rclone:remote:path   → rclone copy (e.g. rclone:r2:cloud9-backups)
#                     /mnt/storagebox/c9   → cp into a mounted directory (another disk / network mount)
#   BACKUP_LOG      log file                                       (default: $BACKUP_DIR/backup.log)
#   SERVICE         compose service name                           (default: app)
#   DB_NAME         database file name in the data dir             (default: cloud9.db)
#   HOST_DATA       host side of the /data bind mount              (default: $COMPOSE_DIR/data)
#   CONTAINER_DATA  container side of the bind mount               (default: /data)
#
# Exit codes: 0 ok · 1 bad config / lock held · 2 backup or integrity check failed (no new backup kept)
#             3 backup ok locally but the off-box copy failed
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$(dirname "$SCRIPT_DIR")}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/cloud9}"
KEEP="${KEEP:-14}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"
SERVICE="${SERVICE:-app}"
DB_NAME="${DB_NAME:-cloud9.db}"
HOST_DATA="${HOST_DATA:-$COMPOSE_DIR/data}"
CONTAINER_DATA="${CONTAINER_DATA:-/data}"

log() { local m; m="$(date -u +%Y-%m-%dT%H:%M:%SZ) [backup] $*"; echo "$m"; [ -n "${BACKUP_LOG:-}" ] && echo "$m" >>"$BACKUP_LOG" || true; }
die() { local code="$1"; shift; log "ERROR: $*"; exit "$code"; }

[[ "$KEEP" =~ ^[0-9]+$ ]] && [ "$KEEP" -ge 1 ] || { echo "KEEP must be a positive integer" >&2; exit 1; }
[ -f "$COMPOSE_DIR/docker-compose.yml" ] || { echo "no docker-compose.yml in COMPOSE_DIR=$COMPOSE_DIR" >&2; exit 1; }
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR" || { echo "cannot create BACKUP_DIR=$BACKUP_DIR" >&2; exit 1; }
BACKUP_LOG="${BACKUP_LOG:-$BACKUP_DIR/backup.log}"

# One run at a time (cron + a manual run must not race).
if command -v flock >/dev/null 2>&1; then
  exec 9>"$BACKUP_DIR/.lock"
  flock -n 9 || die 1 "another backup is running (lock $BACKUP_DIR/.lock)"
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="c9-$STAMP.db"
TMP_REL=".backup-tmp"                       # inside the data dir, the only place the container can write
HOST_TMP="$HOST_DATA/$TMP_REL/$NAME"
cleanup() { rm -f "$HOST_TMP" "$HOST_TMP-journal" 2>/dev/null || true; }
trap cleanup EXIT

cd "$COMPOSE_DIR"
log "start: $SERVICE:$CONTAINER_DATA/$DB_NAME → $BACKUP_DIR/$NAME.gz (keep $KEEP)"

# 1) Online backup + 2) integrity check, both inside the container (it has node + better-sqlite3).
#    .backup() uses SQLite's backup API, so committed WAL content is included and the copy is consistent.
JS='
const fs = require("fs"), path = require("path"), Database = require("better-sqlite3");
const [src, dst] = process.argv.slice(1);
fs.mkdirSync(path.dirname(dst), { recursive: true });
const db = new Database(src, { fileMustExist: true });
db.backup(dst).then(() => {
  db.close();
  const copy = new Database(dst, { readonly: true });
  const res = copy.pragma("integrity_check", { simple: true });
  const n = copy.prepare("SELECT count(*) AS n FROM sqlite_master").get().n;
  copy.close();
  if (res !== "ok") { console.error("integrity_check: " + res); process.exit(2); }
  console.log("ok tables=" + n + " bytes=" + fs.statSync(dst).size);
}).catch((e) => { console.error(e && e.message || e); process.exit(2); });
'
if ! OUT="$(docker compose exec -T "$SERVICE" node -e "$JS" "$CONTAINER_DATA/$DB_NAME" "$CONTAINER_DATA/$TMP_REL/$NAME" 2>&1)"; then
  die 2 "backup/integrity check failed: $OUT"
fi
log "copy verified ($OUT)"
[ -s "$HOST_TMP" ] || die 2 "backup file not found on the host at $HOST_TMP (check HOST_DATA)"

# 3) Move off the data volume, compress, lock down.
mv "$HOST_TMP" "$BACKUP_DIR/$NAME"
gzip -f "$BACKUP_DIR/$NAME"
chmod 600 "$BACKUP_DIR/$NAME.gz"
gzip -t "$BACKUP_DIR/$NAME.gz" || die 2 "gzip test failed for $BACKUP_DIR/$NAME.gz"
log "saved $BACKUP_DIR/$NAME.gz ($(du -h "$BACKUP_DIR/$NAME.gz" | cut -f1))"

# 4) Rotation: keep the newest $KEEP (names sort by time).
mapfile -t OLD < <(ls -1 "$BACKUP_DIR"/c9-*.db.gz 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))")
if [ "${#OLD[@]}" -gt 0 ]; then rm -f -- "${OLD[@]}"; log "rotated out ${#OLD[@]} old backup(s)"; fi

# 5) Off-box copy (a backup on the same disk does not survive losing the server).
if [ -n "$BACKUP_REMOTE" ]; then
  if [[ "$BACKUP_REMOTE" == /* ]]; then
    if ! { mkdir -p "$BACKUP_REMOTE" && cp "$BACKUP_DIR/$NAME.gz" "$BACKUP_REMOTE/"; } >>"$BACKUP_LOG" 2>&1; then die 3 "copy to $BACKUP_REMOTE failed (local backup kept)"; fi
  elif [[ "$BACKUP_REMOTE" == rclone:* ]]; then
    if ! rclone copy "$BACKUP_DIR/$NAME.gz" "${BACKUP_REMOTE#rclone:}" >>"$BACKUP_LOG" 2>&1; then die 3 "rclone copy to ${BACKUP_REMOTE#rclone:} failed (local backup kept)"; fi
  else
    if ! rsync -a -e "ssh -o BatchMode=yes -o ConnectTimeout=15" "$BACKUP_DIR/$NAME.gz" "$BACKUP_REMOTE/" >>"$BACKUP_LOG" 2>&1; then die 3 "rsync to $BACKUP_REMOTE failed (local backup kept)"; fi
  fi
  log "copied off-box to $BACKUP_REMOTE"
else
  log "BACKUP_REMOTE not set: backup is on this server only"
fi

log "done"
