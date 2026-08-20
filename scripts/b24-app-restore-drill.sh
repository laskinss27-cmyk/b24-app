#!/usr/bin/env bash

set -Eeuo pipefail

export PATH=/usr/local/bin:/usr/bin:/bin

readonly SOURCE_DB=b24_app
readonly BACKUP_DIR=/root/core-backups/b24_app
readonly DB_CONTAINER=erpnext-db-1

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

root_import() {
  local database_name=$1

  docker exec -i "$DB_CONTAINER" sh -lc '
    password=${MARIADB_ROOT_PASSWORD:-${MYSQL_ROOT_PASSWORD:-}}
    test -n "$password"
    exec mariadb --protocol=socket -uroot -p"$password" "$1"
  ' sh "$database_name"
}

[[ $# == 2 ]] || fail "usage: $0 <absolute-dump-path> <restore-database>"

dump_path=$1
restore_db=$2
checksum_path="${dump_path}.sha256"

[[ "$dump_path" == "$BACKUP_DIR"/*-b24_app-database.sql.gz ]] || {
  fail "dump must be a b24_app archive inside $BACKUP_DIR"
}
[[ "$restore_db" =~ ^b24_app_restore_[0-9]{8}_[0-9]{6}$ ]] || {
  fail "restore database must match b24_app_restore_YYYYMMDD_HHMMSS"
}
[[ "$restore_db" != "$SOURCE_DB" ]] || fail "source database name is forbidden"

for command_name in docker gzip zgrep sha256sum sed stat; do
  command -v "$command_name" >/dev/null || fail "required command is missing: $command_name"
done

[[ -f "$dump_path" && -f "$checksum_path" ]] || fail "dump or checksum is missing"
[[ "$(stat -c '%a' "$dump_path")" == 600 ]] || fail "dump must have mode 600"
[[ "$(stat -c '%a' "$checksum_path")" == 600 ]] || fail "checksum must have mode 600"
[[ "$(stat -c '%U:%G' "$dump_path")" == root:root ]] || fail "dump must be owned by root:root"
[[ "$(stat -c '%U:%G' "$checksum_path")" == root:root ]] || fail "checksum must be owned by root:root"

(
  cd "$BACKUP_DIR"
  sha256sum -c "$(basename "$checksum_path")" >/dev/null
)
gzip -t "$dump_path"

expected_database_count=$(zgrep -Ec '^CREATE DATABASE .*`b24_app`' "$dump_path" || true)
all_database_count=$(zgrep -Ec '^CREATE DATABASE ' "$dump_path" || true)
use_database_count=$(zgrep -Ec '^USE `b24_app`;' "$dump_path" || true)
[[ "$expected_database_count" == 1 && "$all_database_count" == 1 && "$use_database_count" == 1 ]] || {
  fail "dump does not contain exactly one expected b24_app database"
}
dump_tables=$(zgrep -Ec '^CREATE TABLE ' "$dump_path" || true)

root_sql 'SELECT 1' >/dev/null
schema_exists=$(root_sql "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = '$restore_db'")
[[ "$schema_exists" == 0 ]] || fail "restore database already exists: $restore_db"

source_tables_before=$(root_sql "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$SOURCE_DB'")
root_sql "CREATE DATABASE \`$restore_db\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
log "created isolated restore database: $restore_db"

zcat "$dump_path" \
  | sed -e '/^CREATE DATABASE /d' -e '/^USE `b24_app`;/d' \
  | root_import "$restore_db"

source_tables_after=$(root_sql "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$SOURCE_DB'")
[[ "$source_tables_after" == "$source_tables_before" ]] || {
  fail "source b24_app table count changed during restore drill"
}

restored_tables=$(root_sql "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$restore_db'")
[[ "$restored_tables" == "$dump_tables" ]] || {
  fail "restored table count differs from dump: dump=$dump_tables restored=$restored_tables"
}
schema_settings=$(root_sql "SELECT CONCAT(DEFAULT_CHARACTER_SET_NAME, '/', DEFAULT_COLLATION_NAME) FROM information_schema.schemata WHERE schema_name = '$restore_db'")
[[ "$schema_settings" == 'utf8mb4/utf8mb4_unicode_ci' ]] || {
  fail "unexpected restored schema settings: $schema_settings"
}

log "restore verified: database=$restore_db table_definitions=$restored_tables"
log "source unchanged: database=$SOURCE_DB table_definitions=$source_tables_after"
log "temporary restore database was intentionally preserved"
