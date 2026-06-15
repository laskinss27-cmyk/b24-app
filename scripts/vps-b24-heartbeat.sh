#!/bin/bash
# Heartbeat ядра ERPNext — ЖИВЁТ НА VPS (194.226.97.154), не на ноутбуке.
# Простукивает ядро через обратный тоннель (localhost:18080 -> ноутбук:8080) и шлёт
# Сергею уведомление в Б24 при СМЕНЕ статуса (доступно <-> недоступно). Цель — узнавать
# о падении сразу, даже когда ноутбук выключен (тогда тоннель мёртв, VPS это видит).
#
# Установка (выполняется автоматикой при деплое; здесь для истории):
#   scp/cat -> /root/b24-heartbeat.sh ; chmod +x ; cron: */5 * * * * /root/b24-heartbeat.sh
# Дебаунс: тревога DOWN только после 2 подряд неудач (~10 мин) — не дёргаем на моргание тоннеля.

WH="https://umniydom.bitrix24.ru/rest/1858/vy2p3f18422jnukg"
USER_ID=1858
PROBE="http://localhost:18080/api/method/ping"
STATE_FILE=/root/b24-heartbeat.state   # формат: "ALERTED FAILS" напр. "UP 0"
LOG=/root/b24-heartbeat.log
DOWN_STRIKES=2                          # сколько подряд неудач до тревоги

now() { date '+%Y-%m-%d %H:%M:%S'; }

notify() {
	# im.notify (to/message) — системное уведомление. im.notify.personal на этом портале
	# не существует (проверено 2026-06-15); нужен scope im у вебхука.
	curl -s --max-time 20 -d "to=$USER_ID" --data-urlencode "message=$1" \
		"$WH/im.notify.json" >/dev/null 2>&1
}

ping=$(curl -s --connect-timeout 8 --max-time 15 "$PROBE" 2>/dev/null)
if echo "$ping" | grep -q pong; then cur=UP; else cur=DOWN; fi

if [ -f "$STATE_FILE" ]; then read -r alerted fails < "$STATE_FILE"; fi
[ -z "$alerted" ] && alerted=UP
[ -z "$fails" ] && fails=0

echo "[$(now)] probe=$cur (alerted=$alerted fails=$fails)" >> "$LOG"

if [ "$cur" = DOWN ]; then
	fails=$((fails + 1))
	if [ "$fails" -ge "$DOWN_STRIKES" ] && [ "$alerted" != DOWN ]; then
		notify "⚠️ Ядро ERPNext НЕДОСТУПНО ($(now) МСК). Проверь: ноутбук включён? Docker? мост? Окна остатков/реализаций могут не работать."
		alerted=DOWN
		echo "[$(now)] -> ТРЕВОГА DOWN отправлена" >> "$LOG"
	fi
else
	fails=0
	if [ "$alerted" = DOWN ]; then
		notify "✅ Ядро ERPNext снова доступно ($(now) МСК)."
		alerted=UP
		echo "[$(now)] -> recovery UP отправлено" >> "$LOG"
	fi
fi

echo "$alerted $fails" > "$STATE_FILE"

# лог не разъедается: хвост 500 строк
tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
