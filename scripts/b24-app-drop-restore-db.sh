#!/usr/bin/env bash

set -Eeuo pipefail

export PATH=/usr/local/bin:/usr/bin:/bin

readonly DB_CONTAINER=erpnext-db-1
readonly BACKEND_CONTAINER=b24-backend

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

root_sql() {
  local sql=$1

  docker exec "$DB_CONTAINER" sh -lc '
    password=${MARIADB_ROOT_PASSWORD:-${MYSQL_ROOT_PASSWORD:-}}
    test -n "$password"
    exec mariadb --protocol=socket -uroot -p"$password" \
      --batch --skip-column-names -e "$1"
  ' sh "$sql"
}

[[ $# == 1 ]] || fail "usage: $0 <restore-database>"
restore_db=$1

for command_name in docker grep; do
  command -v "$command_name" >/dev/null || fail "required command is missing: $command_name"
done

[[ "$restore_db" =~ ^b24_app_restore_[0-9]{8}_[0-9]{6}$ ]] || {
  fail "database must match b24_app_restore_YYYYMMDD_HHMMSS"
}
[[ "${B24_APP_CONFIRM_DROP_RESTORE_DB:-}" == "$restore_db" ]] || {
  fail "B24_APP_CONFIRM_DROP_RESTORE_DB must exactly match the restore database"
}

if docker inspect "$BACKEND_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -Fq "$restore_db"; then
  fail "backend environment references the restore database"
fi

schema_exists=$(root_sql "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = '$restore_db'")
[[ "$schema_exists" == 1 ]] || fail "restore database does not exist exactly once"

root_sql "DROP DATABASE \`$restore_db\`"
schema_exists=$(root_sql "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = '$restore_db'")
[[ "$schema_exists" == 0 ]] || fail "restore database still exists after DROP"

log "removed isolated restore database: $restore_db"
