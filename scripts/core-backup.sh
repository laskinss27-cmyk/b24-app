#!/usr/bin/env bash
# Бэкап ядра ERPNext (корп-VPS). Хранение РЯДОМ С ЯДРОМ на этом же VPS + офсайт БД на Б24 Диск.
#  БД    : КАЖДЫЙ запуск (database.sql.gz) — все 729 таблиц = ВСЕ документы и проводки.
#          → локально /root/core-backups (14 копий) + Б24 Диск (независимый офсайт от гибели VPS).
#  ФАЙЛЫ : раз в неделю (вс) или флаг --with-files (files.tar + private-files.tar, фото/вложения ~236M).
#          → локально (4 копии). Офсайта нет: фото восстановимы из Б24 синком.
# Восстановление: docs/restore — bench --site frontend restore <db.sql.gz> \
#                 [--with-public-files <files.tar>] [--with-private-files <private-files.tar>]
export PATH=/usr/local/bin:/usr/bin:/bin
LOG=/root/sync/core-backup.log
ts(){ date '+%Y-%m-%d %H:%M:%S'; }
log(){ echo "[$(ts)] $*" >> "$LOG"; }

DEST=/root/core-backups
SITE=frontend
CT=erpnext-backend-1
BROOT=/home/frappe/frappe-bench
mkdir -p "$DEST"

# Файлы — раз в неделю (вс=7) или ручной форс
WITH_FILES=0
[ "$(date +%u)" = "7" ] && WITH_FILES=1
[ "$1" = "--with-files" ] && WITH_FILES=1

# 1) дамп
if [ "$WITH_FILES" = 1 ]; then BACKUP="bench --site $SITE backup --with-files"; else BACKUP="bench --site $SITE backup"; fi
if ! docker exec "$CT" sh -lc "$BACKUP" >/dev/null 2>&1; then log "ERROR: bench backup упал"; exit 1; fi

# 2) STAMP последнего дампа + забрать ВСЕ артефакты с этим префиксом
LATEST=$(docker exec "$CT" sh -lc "ls -1t $BROOT/sites/$SITE/private/backups/*-database.sql.gz | head -1" 2>/dev/null)
[ -z "$LATEST" ] && { log "ERROR: дамп не найден"; exit 1; }
DBBASE=$(basename "$LATEST")
STAMP=${DBBASE%-database.sql.gz}
for f in $(docker exec "$CT" sh -lc "ls -1 $BROOT/sites/$SITE/private/backups/${STAMP}*" 2>/dev/null); do
  b=$(basename "$f")
  docker cp "$CT:$f" "$DEST/$b" 2>/dev/null && log "забрано: $b ($(du -h "$DEST/$b"|cut -f1))"
done

# 3) ротация локально: БД 14, архивы файлов 4
ls -1t "$DEST"/*-database.sql.gz 2>/dev/null   | tail -n +15 | xargs -r rm -f
ls -1t "$DEST"/*-files.tar 2>/dev/null         | tail -n +5  | xargs -r rm -f
ls -1t "$DEST"/*-private-files.tar 2>/dev/null | tail -n +5  | xargs -r rm -f

# 4) офсайт БД на Б24 Диск (единственный внешний адрес; защита от гибели VPS)
DBPATH="$DEST/$DBBASE"
if [ -f /root/sync/core-backup-disk.ts ]; then
  if (cd /root/sync && npx tsx core-backup-disk.ts "$DBPATH" >>"$LOG" 2>&1); then log "Б24 Диск БД: ок"; else log "WARN: Б24 Диск не прошёл"; fi
fi

log "готово (with_files=$WITH_FILES)"
