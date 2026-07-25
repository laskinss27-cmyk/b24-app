#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  B24-APP — «ГЛАЗА»: одна команда показывает состояние всей системы по-русски.
#  Запуск на VPS: просто `status` (установлен в /usr/local/bin/status)
#  Только ЧТЕНИЕ — ничего не меняет, запускать можно сколько угодно раз.
#  Что чинить при ⛔ — см. docs/SOS.md.
# ─────────────────────────────────────────────────────────────────────────────
set -o pipefail
ENV=/root/sync/.env
DOMAIN="${PUBLIC_HOSTNAME:?PUBLIC_HOSTNAME is required}"
CERT=/etc/letsencrypt/live/$DOMAIN/cert.pem
ok=0; bad=0
green() { printf '  \033[32m✅ %s\033[0m\n' "$1"; ok=$((ok+1)); }
red()   { printf '  \033[31m⛔ %s\033[0m\n' "$1"; bad=$((bad+1)); }
warn()  { printf '  \033[33mℹ️  %s\033[0m\n' "$1"; }
info()  { printf '     %s\n' "$1"; }
hdr()   { printf '\n\033[1m[%s]\033[0m\n' "$1"; }
printf '\033[1m═══════════════════════════════════════════\033[0m\n'
printf '\033[1m  B24-APP — состояние системы (корп-VPS)\033[0m\n'
printf '  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
printf '\033[1m═══════════════════════════════════════════\033[0m\n'

# 1) Ядро ERPNext (склад, каталог, остатки)
hdr "Ядро ERPNext (склад и каталог)"
if [ "$(curl -s --max-time 8 http://localhost:8080/api/method/ping)" = '{"message":"pong"}' ]; then
  green "ядро отвечает (pong)"
  TOKEN=$(grep -E '^ERPNEXT_TOKEN=' "$ENV" 2>/dev/null | cut -d= -f2- | tr -d '"\r')
  URL=$(grep  -E '^ERPNEXT_URL='   "$ENV" 2>/dev/null | cut -d= -f2- | tr -d '"\r')
  [ -z "$URL" ] && URL="http://localhost:8080"
  if [ -n "$TOKEN" ]; then
    cnt=$(curl -s --max-time 10 -H "Authorization: $TOKEN" "$URL/api/method/frappe.client.get_count?doctype=Item" | grep -oE '"message":[0-9]+' | grep -oE '[0-9]+')
    [ -n "$cnt" ] && info "товаров в каталоге: $cnt" || info "число товаров посмотреть не вышло (но ядро живо)"
  fi
else
  red "ядро НЕ отвечает на localhost:8080"
  info "→ см. docs/SOS.md, раздел «Ядро не отвечает»"
fi

# 2) Backend (наше приложение)
hdr "Backend (само приложение)"
code=$(curl -s --max-time 8 -o /dev/null -w '%{http_code}' http://localhost:3000/health)
[ "$code" = "200" ] && green "backend здоров (HTTP 200)" || { red "backend не отвечает (код: ${code:-нет})"; info "→ docs/SOS.md, «Контейнер упал»"; }

# 3) Публичная дверь (через неё Битрикс достаёт приложение снаружи)
hdr "Публичная дверь (для Битрикса)"
pub=$(curl -s --max-time 12 -o /dev/null -w '%{http_code}' https://$DOMAIN/health)
[ "$pub" = "200" ] && green "снаружи доступна (HTTP 200, https://$DOMAIN)" || { red "снаружи НЕ доступна (код: ${pub:-нет})"; info "→ docs/SOS.md «Дверь снаружи недоступна»"; }

# 4) nginx + TLS-сертификат
hdr "Дверь nginx + сертификат"
n=$(systemctl is-active nginx 2>/dev/null)
[ "$n" = "active" ] && green "nginx active" || { red "nginx НЕ активен (статус: ${n:-нет})"; info "→ systemctl restart nginx"; }
if [ -f "$CERT" ]; then
  end=$(openssl x509 -enddate -noout -in "$CERT" 2>/dev/null | cut -d= -f2)
  if [ -n "$end" ]; then
    days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
    if   [ "$days" -gt 14 ]; then green "сертификат действует ещё $days дн."
    elif [ "$days" -gt 0 ];  then warn "сертификат истекает через $days дн. (должен продлиться сам; проверь: certbot renew)"
    else red "сертификат ПРОСРОЧЕН"; info "→ certbot renew --force-renewal && systemctl reload nginx"; fi
  fi
else
  warn "файл сертификата не найден ($CERT) — возможно домен другой"
fi

# 5) Обязательные контейнеры Docker.
# Остановленные b24-backend-prev-* / b24-backend-failed-* сохранены для отката и не являются аварией.
hdr "Контейнеры Docker (рабочие сервисы)"
required=(
  b24-backend
  erpnext-backend-1
  erpnext-db-1
  erpnext-frontend-1
  erpnext-queue-long-1
  erpnext-queue-short-1
  erpnext-redis-cache-1
  erpnext-redis-queue-1
  erpnext-scheduler-1
  erpnext-websocket-1
)
missing=0
for ct in "${required[@]}"; do
  running=$(docker inspect -f '{{.State.Running}}' "$ct" 2>/dev/null)
  if [ "$running" != "true" ]; then
    red "$ct не запущен"
    missing=$((missing+1))
  fi
done
[ "$missing" -eq 0 ] && green "все обязательные контейнеры подняты (${#required[@]})"

# 6) Бэкап ядра (ежедневно)
hdr "Бэкап ядра (ежедневно)"
BK=/root/core-backups
last=$(ls -1t "$BK"/*-database.sql.gz 2>/dev/null | head -1)
if [ -n "$last" ]; then
  bage=$(( ( $(date +%s) - $(stat -c %Y "$last") ) / 3600 ))
  bwhen=$(date -r "$last" '+%Y-%m-%d %H:%M')
  cnt=$(ls -1 "$BK"/*-database.sql.gz 2>/dev/null | grep -c .)
  if [ "$bage" -le 30 ]; then green "свежий бэкап БД: $bwhen (копий: $cnt)"
  else warn "последний бэкап БД $bwhen (${bage}ч назад; ежедневный в 12:00 UTC / 15:00 МСК) — проверь /root/sync/core-backup.log"; fi
else
  red "бэкапы БД не найдены ($BK)"; info "→ bash /root/sync/core-backup.sh"
fi

# 7) Ресурсы VPS
hdr "Ресурсы VPS"
df -h / | awk 'NR==2{printf "     💾 диск: занято %s, свободно %s\n",$5,$4}'
free -h | awk '/^Mem:/{printf "     🧠 память: свободно %s из %s\n",$7,$2}'

# Итог
printf '\033[1m═══════════════════════════════════════════\033[0m\n'
if [ "$bad" -eq 0 ]; then
  printf '\033[1;32m  ИТОГ: всё работает ✅  (проверок пройдено: %s)\033[0m\n' "$ok"
else
  printf '\033[1;31m  ИТОГ: есть проблемы ⛔ (%s) — смотри ⛔ выше и docs/SOS.md\033[0m\n' "$bad"
fi
printf '\033[1m═══════════════════════════════════════════\033[0m\n'
