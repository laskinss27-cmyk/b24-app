#!/usr/bin/env bash
export PATH=/usr/local/bin:/usr/bin:/bin
cd /root/sync || exit 0
LOG=/root/sync/sync.log
ts() { date '+%Y-%m-%d %H:%M:%S'; }
# Защита от наложения: предыдущий синк ещё идёт → пропускаем (не плодим параллельные прогоны).
exec 9>/root/sync/.lock
flock -n 9 || { echo "[$(ts)] SKIP: предыдущий синк ещё идёт (flock)" >> "$LOG"; exit 0; }
if ! curl -s --max-time 5 http://localhost:8080/api/method/ping 2>/dev/null | grep -q pong; then
  echo "[$(ts)] SKIP: ядро не отвечает" >> "$LOG"; exit 0
fi
echo "[$(ts)] синк начат" >> "$LOG"

# Фаза с ЖЁСТКИМ таймаутом 600с: запуск в своей process-group (setsid) + сторож,
# который по истечении валит ВСЮ группу (kill -KILL -pgid). Старый `timeout 600 npx …`
# убивал только npx, а внук-node сиротел и висел сутками, держа flock (зомби 2026-06-18).
run_phase() {
  local label="$1" pat="$2"; shift 2
  local out="/tmp/sync_phase_${label}.out"
  # 9>&- закрывает lock-fd у детей: даже осиротевший сторож/процесс НЕ держит flock,
  # поэтому замок снимается ровно при выходе sync.sh (а не висит до конца sleep 600).
  setsid npx tsx erp-migrate-catalog.ts "$@" > "$out" 2>&1 9>&- &
  local pid=$!
  ( sleep 600; kill -KILL -"$pid" 2>/dev/null ) 9>&- &   # -pid = вся группа фазы
  local wd=$!
  wait "$pid"; local rc=$?
  pkill -P "$wd" 2>/dev/null; kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null  # сторож + его sleep
  [ "$rc" -ge 128 ] && echo "[$(ts)] ${label}: ⛔ убит по таймауту (rc=$rc)" >> "$LOG"
  grep -iE "$pat" "$out" | sed "s/^/[$(ts)] ${label}: /" >> "$LOG"
}

run_phase items 'ИТОГ товаров|FATAL'                          --items
run_phase stock 'строк к загрузке|Stock Reconciliation|FATAL' --stock
run_phase check 'ИТОГ:|СОШЛ|расхожд|FATAL'                    --check

tail -1000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
