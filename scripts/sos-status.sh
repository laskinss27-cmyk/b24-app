#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  B24-APP — «ГЛАЗА»: одна команда показывает состояние всей системы по-русски.
#  Запуск на спейре (домашний сервер): просто `status`  (алиас в ~/.bashrc)
#  Только ЧТЕНИЕ — ничего не меняет, запускать можно сколько угодно раз.
#  Что чинить при ⛔ — см. docs/SOS.md.
# ─────────────────────────────────────────────────────────────────────────────
set -o pipefail
ENV=~/sync/.env
ok=0; bad=0
green() { printf '  \033[32m✅ %s\033[0m\n' "$1"; ok=$((ok+1)); }
red()   { printf '  \033[31m⛔ %s\033[0m\n' "$1"; bad=$((bad+1)); }
warn()  { printf '  \033[33mℹ️  %s\033[0m\n' "$1"; }
info()  { printf '     %s\n' "$1"; }
hdr()   { printf '\n\033[1m[%s]\033[0m\n' "$1"; }
# Сколько минут ноут включён (для отличия «синк ещё не гонялся после старта» от настоящего сбоя).
upmin=$(( $(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0) / 60 ))

printf '\033[1m═══════════════════════════════════════════\033[0m\n'
printf '\033[1m  B24-APP — состояние системы\033[0m\n'
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
pub=$(curl -s --max-time 12 -o /dev/null -w '%{http_code}' https://194-226-97-154.regru.cloud/health)
[ "$pub" = "200" ] && green "снаружи доступна (HTTP 200)" || { red "снаружи НЕ доступна (код: ${pub:-нет})"; info "→ проверь туннель ниже и VPS; docs/SOS.md «Приложение лежит у всех»"; }

# 4) Туннель ноут → VPS
hdr "Туннель на VPS (reg.ru)"
t=$(systemctl is-active b24-tunnel 2>/dev/null)
[ "$t" = "active" ] && green "туннель active" || { red "туннель НЕ активен (статус: ${t:-нет})"; info "→ docs/SOS.md «Туннель отвалился»"; }

# 5) Контейнеры Docker
# create-site и configurator — ОДНОРАЗОВЫЕ (отрабатывают раз при установке и штатно
# выключаются). Их Exited — это норма, поломкой НЕ считаем. Смотрим только рабочие сервисы.
hdr "Контейнеры Docker (рабочие сервисы)"
INIT='create-site|configurator'
total_svc=$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -vE "$INIT" | grep -c .)
up_svc=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -vE "$INIT" | grep -c .)
if [ "$up_svc" -eq "$total_svc" ] && [ "$up_svc" -ge 10 ]; then
  green "все рабочие контейнеры подняты ($up_svc)"
else
  red "поднято $up_svc из $total_svc рабочих контейнеров"
  docker ps -a --format '{{.Names}}\t{{.Status}}' 2>/dev/null | grep -vE "$INIT" | grep -ivE 'Up ' | sed 's/^/     ⤷ лежит: /'
  info "→ docs/SOS.md «Контейнер упал»"
fi

# 6) Синхронизация остатков Б24 → ядро (cron, ежечасно)
hdr "Синхронизация остатков (ежечасно)"
LOG=~/sync/sync.log
if [ -f "$LOG" ]; then
  age=$(( ( $(date +%s) - $(stat -c %Y "$LOG") ) / 60 ))
  when=$(date -r "$LOG" '+%Y-%m-%d %H:%M')
  if [ "$age" -le 75 ]; then
    green "синк свежий — последний прогон $when (${age} мин назад)"
  elif [ "$upmin" -lt 70 ]; then
    # Ноут недавно включён — синк просто ещё не успел отработать после старта, нагонит в ближайший :07.
    warn "синк нагонит после включения (ноут поднят ${upmin} мин назад; последний прогон $when) — это норма"
  else
    red "синк давно не отрабатывал — последний $when (${age} мин назад, ожидается раз в час)"; info "→ docs/SOS.md «Синк встал»"
  fi
  info "итог последнего прогона:"
  tail -n 2 "$LOG" | sed 's/^/        /'
else
  red "лог синка не найден ($LOG)"
fi

# 7) Ресурсы ноутбука
hdr "Ресурсы ноутбука"
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
