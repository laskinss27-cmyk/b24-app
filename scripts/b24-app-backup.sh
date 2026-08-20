#!/usr/bin/env bash

set -Eeuo pipefail

export PATH=/usr/local/bin:/usr/bin:/bin
umask 077

readonly DB_NAME=b24_app
readonly BACKUP_DIR=/root/core-backups/b24_app
readonly SECRETS_DIR=/root/b24-app-secrets
readonly DUMP_CONFIG="$SECRETS_DIR/backup-dump.cnf"
readonly DOCKER_NETWORK=erpnext_frappe_network
readonly MARIADB_IMAGE=mariadb:11.8
readonly LOCK_FILE=/run/lock/b24-app-backup.lock

temp_dump=
temp_checksum=
published_dump=
published_checksum=
completed=0

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

cleanup() {
  local exit_code=$?

  if [[ -n "$temp_dump" ]]; then
    rm -f -- "$temp_dump"
  fi
  if [[ -n "$temp_checksum" ]]; then
    rm -f -- "$temp_checksum"
  fi
  if [[ "$completed" != 1 ]]; then
    if [[ -n "$published_checksum" ]]; then
      rm -f -- "$published_checksum"
    fi
    if [[ -n "$published_dump" ]]; then
      rm -f -- "$published_dump"
    fi
  fi

  exit "$exit_code"
}

trap cleanup EXIT

for command_name in docker gzip zgrep sha256sum mktemp flock stat grep; do
  command -v "$command_name" >/dev/null || {
    log "ERROR: required command is missing: $command_name"
    exit 1
  }
done

[[ -d "$BACKUP_DIR" && -w "$BACKUP_DIR" ]] || {
  log "ERROR: backup directory is unavailable: $BACKUP_DIR"
  exit 1
}
[[ -r "$DUMP_CONFIG" ]] || {
  log "ERROR: dump config is unavailable: $DUMP_CONFIG"
  exit 1
}
[[ "$(stat -c '%a' "$DUMP_CONFIG")" == 600 ]] || {
  log "ERROR: dump config must have mode 600"
  exit 1
}
[[ "$(stat -c '%U:%G' "$DUMP_CONFIG")" == root:root ]] || {
  log "ERROR: dump config must be owned by root:root"
  exit 1
}
if grep -Eq '^[[:space:]]*database[[:space:]]*=' "$DUMP_CONFIG"; then
  log "ERROR: dump config must not contain database= when --databases is used"
  exit 1
fi

docker network inspect "$DOCKER_NETWORK" >/dev/null
docker image inspect "$MARIADB_IMAGE" >/dev/null

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "ERROR: another b24_app backup is already running"
  exit 75
fi

stamp=$(date -u '+%Y%m%d_%H%M%S')
final_dump="$BACKUP_DIR/${stamp}-${DB_NAME}-database.sql.gz"
final_checksum="${final_dump}.sha256"
[[ ! -e "$final_dump" && ! -e "$final_checksum" ]] || {
  log "ERROR: backup target already exists"
  exit 1
}

temp_dump=$(mktemp "$BACKUP_DIR/.b24_app.XXXXXX.sql.gz")
temp_checksum=$(mktemp "$BACKUP_DIR/.b24_app.XXXXXX.sha256")

if ! docker run --rm --network "$DOCKER_NETWORK" \
  -v "$SECRETS_DIR:/run/b24-app-secrets:ro" \
  "$MARIADB_IMAGE" \
  mariadb-dump --defaults-extra-file=/run/b24-app-secrets/backup-dump.cnf \
    --single-transaction \
    --quick \
    --skip-lock-tables \
    --triggers \
    --hex-blob \
    --default-character-set=utf8mb4 \
    --databases "$DB_NAME" \
  | gzip -9 > "$temp_dump"; then
  log "ERROR: mariadb dump failed"
  exit 1
fi

gzip -t "$temp_dump"

expected_database_count=$(zgrep -Ec '^CREATE DATABASE .*`b24_app`' "$temp_dump" || true)
all_database_count=$(zgrep -Ec '^CREATE DATABASE ' "$temp_dump" || true)
use_database_count=$(zgrep -Ec '^USE `b24_app`;' "$temp_dump" || true)
if [[ "$expected_database_count" != 1 || "$all_database_count" != 1 || "$use_database_count" != 1 ]]; then
  log "ERROR: dump does not contain exactly one expected b24_app database"
  exit 1
fi

table_count=$(zgrep -Ec '^CREATE TABLE ' "$temp_dump" || true)
checksum_line=$(sha256sum "$temp_dump")
checksum=${checksum_line%% *}
printf '%s  %s\n' "$checksum" "$(basename "$final_dump")" > "$temp_checksum"
chmod 600 "$temp_dump" "$temp_checksum"

mv "$temp_dump" "$final_dump"
published_dump="$final_dump"
temp_dump=
mv "$temp_checksum" "$final_checksum"
published_checksum="$final_checksum"
temp_checksum=

(
  cd "$BACKUP_DIR"
  sha256sum -c "$(basename "$final_checksum")" >/dev/null
)

completed=1
log "backup verified: $final_dump"
log "size_bytes=$(stat -c '%s' "$final_dump") table_definitions=$table_count"
printf 'B24_APP_BACKUP_FILE=%s\n' "$final_dump"
