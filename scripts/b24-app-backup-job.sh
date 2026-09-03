#!/usr/bin/env bash

set -Eeuo pipefail

export PATH=/usr/local/bin:/usr/bin:/bin
umask 077

readonly SYNC_DIR=/root/sync
readonly BACKUP_DIR=/root/core-backups/b24_app
readonly BACKUP_SCRIPT="$SYNC_DIR/b24-app-backup.sh"
readonly DISK_UPLOADER="$SYNC_DIR/b24-app-backup-disk.ts"
readonly LOCK_FILE=/run/lock/b24-app-backup-job.lock
readonly MAX_LOCAL_BACKUPS=14
readonly RETENTION_MODE=${B24_APP_BACKUP_RETENTION:-on}

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

for command_name in flock npx sha256sum find sort rm sed grep chmod basename; do
  command -v "$command_name" >/dev/null || {
    log "ERROR: required command is missing: $command_name"
    exit 1
  }
done

[[ -x "$BACKUP_SCRIPT" && -r "$DISK_UPLOADER" && -d "$BACKUP_DIR" ]] || {
  log "ERROR: b24_app backup job prerequisites are unavailable"
  exit 1
}

[[ "$RETENTION_MODE" == on || "$RETENTION_MODE" == off ]] || {
  log "ERROR: B24_APP_BACKUP_RETENTION must be on or off"
  exit 1
}

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "ERROR: another b24_app backup job is already running"
  exit 75
fi

backup_output=$(/usr/bin/bash "$BACKUP_SCRIPT")
printf '%s\n' "$backup_output"
dump_path=$(printf '%s\n' "$backup_output" | sed -n 's/^B24_APP_BACKUP_FILE=//p')
[[ "$dump_path" == "$BACKUP_DIR"/*-b24_app-database.sql.gz ]] || {
  log "ERROR: backup script returned an unexpected path"
  exit 1
}
[[ -f "$dump_path" && -f "$dump_path.sha256" ]] || {
  log "ERROR: dump/checksum pair is incomplete"
  exit 1
}

disk_output=$(
  cd "$SYNC_DIR"
  npx --no-install tsx "$DISK_UPLOADER" "$dump_path" "$dump_path.sha256"
)
printf '%s\n' "$disk_output"
grep -q '^disk verified:' <<<"$disk_output" || {
  log "ERROR: Bitrix24 Disk verification marker is missing"
  exit 1
}
printf 'uploaded_at=%s\n%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$disk_output" > "$dump_path.uploaded"
chmod 600 "$dump_path.uploaded"

if [[ "$RETENTION_MODE" == on ]]; then
  mapfile -t dumps < <(
    find "$BACKUP_DIR" -maxdepth 1 -type f -name '*-b24_app-database.sql.gz' -printf '%f\n' | sort -r
  )
  for dump_name in "${dumps[@]}"; do
    [[ -f "$BACKUP_DIR/$dump_name.sha256" ]] || {
      log "ERROR: refusing retention for incomplete local pair: $dump_name"
      exit 1
    }
  done

  for ((index = MAX_LOCAL_BACKUPS; index < ${#dumps[@]}; index += 1)); do
    dump_name=${dumps[$index]}
    [[ -f "$BACKUP_DIR/$dump_name.uploaded" ]] || {
      log "ERROR: refusing to remove a backup without upload proof: $dump_name"
      exit 1
    }
    (
      cd "$BACKUP_DIR"
      sha256sum -c "$dump_name.sha256" >/dev/null
    )
    rm -f -- \
      "$BACKUP_DIR/$dump_name" \
      "$BACKUP_DIR/$dump_name.sha256" \
      "$BACKUP_DIR/$dump_name.uploaded"
    log "local retention removed: $dump_name"
  done
else
  log "local retention skipped"
fi

log "backup job complete: $(basename "$dump_path")"
