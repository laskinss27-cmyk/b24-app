#!/usr/bin/env bash
# Тянет свежий дамп ядра со спейра на этот ноут — вторая физическая копия на другом железе.
# Работает, когда ноут в одной LAN со спейром (на работе, 192.168.0.69). Запуск: bash scripts/pull-core-backup.sh
DEST="/d/b24-core-backups"
KEY="$HOME/.ssh/b24_homeserver"
SPARE="rey@192.168.0.69"
mkdir -p "$DEST"
LATEST=$(ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=8 "$SPARE" 'ls -1t ~/core-backups/*-database.sql.gz | head -1' 2>/dev/null)
[ -z "$LATEST" ] && { echo "не нашёл дамп на спейре (спейр в сети?)"; exit 1; }
scp -i "$KEY" -o BatchMode=yes "$SPARE:$LATEST" "$DEST/" && echo "скачано: $DEST/$(basename "$LATEST")"
# ротация локально — последние 14
ls -1t "$DEST"/*-database.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
