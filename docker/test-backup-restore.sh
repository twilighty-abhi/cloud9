#!/usr/bin/env bash
# Self-test for docker/backup.sh + docker/restore.sh without Docker: a fake `docker` on PATH runs the
# in-container `node -e` commands locally (with this repo's better-sqlite3) and records stop/up calls.
#
#   bash docker/test-backup-restore.sh          # needs: node, npm deps installed (node_modules), gzip
#
# Covers: backup while a writer holds un-checkpointed WAL data, integrity check, gzip + chmod 600,
# rotation (KEEP), BACKUP_REMOTE to a directory + an unreachable rsync target, restore swap + files moved aside,
# corrupt backup rejected with exit 2 and the live DB untouched.
set -Eeuo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"
WRITER_PID=""
trap '[ -n "$WRITER_PID" ] && kill "$WRITER_PID" 2>/dev/null; rm -rf "$T"' EXIT
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; exit 1; }

mkdir -p "$T/compose/data" "$T/bin" "$T/remote"
cp "$REPO/docker-compose.yml" "$T/compose/"
cat >"$T/bin/docker" <<'SHIM'
#!/usr/bin/env bash
# fake docker: `docker compose exec|run ... node <args>` → local node; stop/up → logged
echo "docker $*" >>"$FAKE_DOCKER_LOG"
[ "$1" = compose ] || exit 1; shift
case "$1" in
  exec|run) while [ $# -gt 0 ] && [ "$1" != node ]; do shift; done; exec "$@" ;;
  stop|up) exit 0 ;;
  *) exit 0 ;;
esac
SHIM
chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH" NODE_PATH="$REPO/node_modules" FAKE_DOCKER_LOG="$T/docker.log"
export COMPOSE_DIR="$T/compose" HOST_DATA="$T/compose/data" CONTAINER_DATA="$T/compose/data" \
       BACKUP_DIR="$T/backups" HEALTH_URL="" APP_UID="$(id -u)"
DB="$T/compose/data/cloud9.db"

count() { node -e 'const D=require("better-sqlite3");const d=new D(process.argv[1],{readonly:true});console.log(d.prepare("select count(*) n from sessions").get().n)' "$1"; }

# A "live app": WAL mode, auto-checkpoint off, 5 committed rows that exist ONLY in the -wal file, connection kept open.
node -e '
const D = require("better-sqlite3"); const d = new D(process.argv[1]);
d.pragma("journal_mode = WAL"); d.pragma("wal_autocheckpoint = 0");
d.exec("create table quizzes(id integer primary key); create table sessions(id integer primary key, code text)");
d.pragma("wal_checkpoint(TRUNCATE)");
const ins = d.prepare("insert into sessions(code) values (?)"); for (let i = 0; i < 5; i++) ins.run("S" + i);
console.log("writer ready"); setInterval(() => {}, 1000);
' "$DB" >"$T/writer.log" 2>&1 &
WRITER_PID=$!
for _ in $(seq 1 50); do grep -q ready "$T/writer.log" 2>/dev/null && break; sleep 0.1; done
[ -s "$DB-wal" ] || fail "writer did not leave data in the WAL"

# 1) backup while the writer is open (a plain cp of cloud9.db alone would see 0 rows)
cp "$DB" "$T/plain-copy.db"
[ "$(count "$T/plain-copy.db")" = 0 ] && pass "plain cp of cloud9.db misses WAL rows (control)"
KEEP=2 BACKUP_REMOTE="$T/remote" bash "$REPO/docker/backup.sh" >/dev/null
B1="$(ls -1 "$T/backups"/c9-*.db.gz | tail -1)"
gzip -dc "$B1" >"$T/b1.db"
[ "$(count "$T/b1.db")" = 5 ] && pass "online backup includes the 5 WAL-only rows" || fail "backup row count"
[ "$(stat -c %a "$B1")" = 600 ] && pass "backup is mode 600" || fail "mode $(stat -c %a "$B1")"
[ "$(stat -c %a "$T/backups")" = 700 ] && pass "BACKUP_DIR is mode 700" || fail "dir mode"
[ -f "$T/remote/$(basename "$B1")" ] && pass "off-box copy (directory target) present" || fail "remote copy missing"
[ ! -e "$T/compose/data/.backup-tmp/$(basename "${B1%.gz}")" ] && pass "temp copy removed from data dir" || fail "temp left"
grep -q "\] done" "$T/backups/backup.log" && pass "log written" || fail "log"

# 2) rotation: 3 more runs with KEEP=2 → 2 kept
for _ in 1 2 3; do sleep 1.1; KEEP=2 bash "$REPO/docker/backup.sh" >/dev/null; done
[ "$(ls -1 "$T/backups"/c9-*.db.gz | wc -l)" = 2 ] && pass "rotation keeps KEEP=2" || fail "rotation"

# 3) remote failure → exit 3, local backup kept
set +e; sleep 1.1; BACKUP_REMOTE="nobody@invalid.invalid:/x" bash "$REPO/docker/backup.sh" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" = 3 ] && pass "unreachable BACKUP_REMOTE → exit 3" || fail "remote failure rc=$rc"

# 4) missing DB → exit 2
set +e; DB_NAME=nope.db bash "$REPO/docker/backup.sh" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" = 2 ] && pass "missing database → exit 2" || fail "missing db rc=$rc"

kill "$WRITER_PID"; wait "$WRITER_PID" 2>/dev/null || true; WRITER_PID=""

# 5) change the live DB, then restore the first backup
node -e 'const D=require("better-sqlite3");const d=new D(process.argv[1]);d.prepare("insert into sessions(code) values (?)").run("LATER");d.close()' "$DB"
[ "$(count "$DB")" = 6 ] || fail "setup live=6"
bash "$REPO/docker/restore.sh" --yes "$T/remote/$(basename "$B1")" >/dev/null
[ "$(count "$DB")" = 5 ] && pass "restore brings back the backup (5 rows)" || fail "restore count"
ASIDE="$(ls -d "$T/compose/data"/pre-restore-* | head -1)"
[ "$(count "$ASIDE/cloud9.db")" = 6 ] && pass "previous DB kept in pre-restore-*" || fail "aside"
grep -q "compose stop app" "$T/docker.log" && grep -q "compose up -d --no-build app" "$T/docker.log" && pass "app stopped then started" || fail "stop/up"

# 6) corrupt backup → exit 2, live DB untouched, app never stopped
head -c 4096 /dev/urandom | gzip >"$T/corrupt.db.gz"
: >"$T/docker.log"
set +e; bash "$REPO/docker/restore.sh" --yes "$T/corrupt.db.gz" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" = 2 ] && pass "corrupt backup rejected (exit 2)" || fail "corrupt rc=$rc"
[ "$(count "$DB")" = 5 ] && ! grep -q "compose stop" "$T/docker.log" && pass "live DB untouched, app not stopped" || fail "corrupt touched live"

echo "ALL PASS"
