#!/usr/bin/env bash
# Бэкап ядра ERPNext: дамп → локальная ротация (14) → офсайт на VPS (7) → Б24 Диск.
# Запуск: bash ~/sync/core-backup.sh   (ставится в cron, см. crontab).
export PATH=/usr/local/bin:/usr/bin:/bin
LOG=/home/rey/sync/core-backup.log
ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

DEST=/home/rey/core-backups
SITE=frontend
CT=erpnext-backend-1
VPS=root@194.226.97.154
VPSKEY=/home/rey/.ssh/vps_tunnel
VPSDIR=/root/core-backups
mkdir -p "$DEST"

# 1) дамп внутри контейнера
if ! docker exec "$CT" sh -lc "bench --site $SITE backup" >/dev/null 2>&1; then
  log "ERROR: bench backup упал"; exit 1
fi

# 2) забрать свежий дамп на хост
BROOT=/home/frappe/frappe-bench
LATEST=$(docker exec "$CT" sh -lc "ls -1t $BROOT/sites/$SITE/private/backups/*-database.sql.gz | head -1" 2>/dev/null)
[ -z "$LATEST" ] && { log "ERROR: дамп не найден в контейнере"; exit 1; }
BASE=$(basename "$LATEST")
docker cp "$CT:$LATEST" "$DEST/$BASE" || { log "ERROR: docker cp"; exit 1; }
SIZE=$(du -h "$DEST/$BASE" | cut -f1)
log "локально: $BASE ($SIZE)"

# 3) ротация локально — оставляем последние 14
ls -1t "$DEST"/*-database.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -f

# 4) офсайт на VPS (+ротация 7)
if ssh -i "$VPSKEY" -o BatchMode=yes -o ConnectTimeout=10 "$VPS" "mkdir -p $VPSDIR" 2>>"$LOG" \
   && scp -i "$VPSKEY" -o BatchMode=yes -o ConnectTimeout=15 "$DEST/$BASE" "$VPS:$VPSDIR/" 2>>"$LOG"; then
  ssh -i "$VPSKEY" -o BatchMode=yes "$VPS" "ls -1t $VPSDIR/*-database.sql.gz | tail -n +8 | xargs -r rm -f" 2>>"$LOG"
  log "VPS: ок"
else
  log "WARN: VPS scp не прошёл"
fi

# 5) Б24 Диск (через helper на Node — добавляется отдельно)
if [ -f /home/rey/sync/core-backup-disk.ts ]; then
  if (cd /home/rey/sync && npx tsx core-backup-disk.ts "$DEST/$BASE" >>"$LOG" 2>&1); then
    log "Б24 Диск: ок"
  else
    log "WARN: Б24 Диск не прошёл"
  fi
fi

log "готово"
