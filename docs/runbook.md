# 📕 Runbook — развернуть, восстановить, обновить

Пошаговые процедуры для ответственного (без контекста авторов). Аварийные «что-то лежит» — в [SOS.md](SOS.md).
Как всё связано — в [network.md](network.md).

Всё живёт на **одном VPS** (`201.51.12.57`, Ubuntu 22.04). Источник кода/конфигов — **GitHub**
(`github.com/laskinss27-cmyk/b24-app`). Источник данных — **бэкап** (на VPS `/root/core-backups` + Б24-Диск).
Личные компьютеры в процедурах НЕ используются.

---

## Доступ и секреты

- **Вход на VPS:** `ssh root@201.51.12.57` по ssh-ключу (завести заранее у ответственного; пароль не используем).
- **Секреты НЕ в git.** Это `/root/erpnext/backend.env` и `/root/sync/.env` на VPS. При развёртывании с нуля
  их заполняют вручную (список ключей — внизу, «Переменные окружения»). Значения берутся из Б24 (OAuth-данные
  приложения) и ядра (API-токен).

---

## Локальная сборка / проверка (на машине разработчика)

```powershell
cd D:\Projects\b24-app
npm run typecheck   # все workspaces
npm run build       # backend tsc + frontend vite → packages/frontend/dist
```
Backend раздаёт собранный фронт; в проде всё пакуется в docker-образ из `Dockerfile`.

---

## A. Развернуть с нуля (новый/чистый VPS)

Предусловия: Ubuntu 22.04, root, интернет.

```bash
# 1. базовый софт
apt-get update && apt-get install -y docker.io docker-compose-plugin git nginx certbot python3-certbot-nginx
systemctl enable --now docker

# 2. код из GitHub
git clone https://github.com/laskinss27-cmyk/b24-app.git /root/b24-app
cd /root/b24-app

# 3. ЯДРО ERPNext: разложить compose и поднять стек
mkdir -p /root/erpnext
cp deploy/pwd.yml /root/erpnext/pwd.yml
cd /root/erpnext && docker compose -p erpnext -f pwd.yml up -d
#    дождаться healthy:  docker ps   (erpnext-db-1 → healthy)
```
Затем **восстановить данные ядра из бэкапа** — раздел B. (Совсем новая установка без бэкапа: `create-site`
в исходном compose создаёт пустой site, но у нас всегда есть бэкап → идём через restore.)

```bash
# 4. BACKEND: собрать образ из исходников и запустить
cd /root/b24-app && docker build -t b24-app:latest .
#    создать /root/erpnext/backend.env (см. «Переменные окружения») и заполнить
docker run -d --name b24-backend --network erpnext_frappe_network \
  -p 127.0.0.1:3000:8080 --env-file /root/erpnext/backend.env \
  --restart unless-stopped b24-app:latest

# 5. ДВЕРЬ: nginx + сертификат
cp deploy/nginx-b24.conf /etc/nginx/sites-available/b24
ln -sf /etc/nginx/sites-available/b24 /etc/nginx/sites-enabled/b24
rm -f /etc/nginx/sites-enabled/default
ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp; ufw --force enable
nginx -t && systemctl reload nginx
certbot --nginx -d 201.51.12.57.sslip.io --non-interactive --agree-tos -m <email> --redirect

# 6. СИНК + БЭКАП
mkdir -p /root/sync && cp scripts/sync.sh scripts/core-backup.sh scripts/core-backup-disk.ts /root/sync/
#    создать /root/sync/.env (см. ниже); в /root/sync выполнить: npm install
( crontab -l 2>/dev/null | grep -vE "sync.sh|core-backup.sh";
  echo "7 * * * * /root/sync/sync.sh";
  echo "0 12 * * * /usr/bin/bash /root/sync/core-backup.sh" ) | crontab -

# 7. команда status
cp /root/b24-app/scripts/sos-status.sh /usr/local/bin/status && chmod +x /usr/local/bin/status

# 8. проверка
status
curl -I https://201.51.12.57.sslip.io/health        # → 200
```

**9. Привязать приложение в Б24** (если сервер/домен новый): в карточке локального приложения Б24 указать
обработчик `https://201.51.12.57.sslip.io/app/handler` и установку `https://201.51.12.57.sslip.io/install`,
сохранить, переустановить — backend сам перепривяжет placement'ы. После смены домена на портале — **Ctrl+Shift+R**
(иначе кеш Б24 даёт «Ошибка при показе приложения»).

> Другой домен (свой, не sslip.io): поменять `server_name` в nginx-конфиге, `-d` у certbot,
> `PUBLIC_BASE_URL` в `backend.env` и URL в карточке Б24.

---

## B. Восстановление данных ядра из бэкапа

Бэкапы: локально `/root/core-backups/` (БД — 14 копий, файлы — 4) и на **Б24-Диске** (дамп БД).
Состав: `<stamp>-frontend-database.sql.gz` (+ при недельном: `-files.tar`, `-private-files.tar`).

```bash
ls -1t /root/core-backups/*-database.sql.gz | head      # выбрать свежий
STAMP=20260626_040326-frontend                          # подставить нужный

docker cp /root/core-backups/${STAMP}-database.sql.gz   erpnext-backend-1:/tmp/
docker cp /root/core-backups/${STAMP}-files.tar         erpnext-backend-1:/tmp/ 2>/dev/null
docker cp /root/core-backups/${STAMP}-private-files.tar erpnext-backend-1:/tmp/ 2>/dev/null

# restore ПЕРЕЗАПИШЕТ текущую БД ядра — делать осознанно, сверить дату дампа!
docker exec erpnext-backend-1 bench --site frontend restore /tmp/${STAMP}-database.sql.gz \
  --with-public-files /tmp/${STAMP}-files.tar \
  --with-private-files /tmp/${STAMP}-private-files.tar \
  --db-root-username root --db-root-password admin
#    (без файлов — убрать строки --with-*)

# сверка: данные на месте
docker exec erpnext-db-1 mariadb -uroot -padmin -N _4ff8fdf982a62c5c \
  -e 'SELECT (SELECT COUNT(*) FROM `tabStock Ledger Entry`) sle, (SELECT COUNT(*) FROM `tabDelivery Note`) dn'
```
> Дамп только на Б24-Диске? Скачать из приложения «Диск» в Б24 в `/root/core-backups/` и далее по шагам.

---

## C. Деплой / откат backend

Backend собирается из исходников.

```bash
# ДЕПЛОЙ:
cd /root/b24-app && git pull && docker build -t b24-app:latest .
docker rm -f b24-backend
docker run -d --name b24-backend --network erpnext_frappe_network -p 127.0.0.1:3000:8080 \
  --env-file /root/erpnext/backend.env --restart unless-stopped b24-app:latest
status

# ОТКАТ (вернуться на рабочий коммит):
cd /root/b24-app && git log --oneline -10        # найти заведомо рабочий коммит
git checkout <коммит> && docker build -t b24-app:latest . && docker rm -f b24-backend && \
docker run -d --name b24-backend --network erpnext_frappe_network -p 127.0.0.1:3000:8080 \
  --env-file /root/erpnext/backend.env --restart unless-stopped b24-app:latest
```
> `ERPNEXT_URL=http://frontend:8080` и сеть `erpnext_frappe_network` — одинаковы на любой машине, не менять.

---

## Переменные окружения (заполнить при развёртывании; значения НЕ в git)

**`/root/erpnext/backend.env`** (приложение):
```
NODE_ENV=production
PORT=8080
HOST=0.0.0.0
PORTAL_DOMAIN=umniydom.bitrix24.ru
PUBLIC_BASE_URL=https://201.51.12.57.sslip.io
APP_SECTION_URL=https://umniydom.bitrix24.ru/devops/placement/502/
INVENTORY_NOTIFY=off
APP_CLIENT_ID=<из карточки приложения Б24>
APP_CLIENT_SECRET=<из карточки приложения Б24>
ERPNEXT_URL=http://frontend:8080
ERPNEXT_TOKEN=token <api_key>:<api_secret>      # отдельный пользователь ядра (аудит)
```
**`/root/sync/.env`** (синк/бэкап):
```
DEV_WEBHOOK=https://umniydom.bitrix24.ru/rest/<user>/<token>/
ERPNEXT_URL=http://localhost:8080
ERPNEXT_TOKEN=token <api_key>:<api_secret>
```
> Токен ядра: в ERPNext User → API Access → Generate Keys (под отдельным пользователем — для аудита).

---

## Диагностика

- **Быстрый осмотр**: команда `status` на VPS (см. [SOS.md](SOS.md)) — ядро/backend/дверь/сертификат/контейнеры/синк разом.
- **Логи приложения**: `docker logs --tail 50 b24-backend` (пишущие роуты логируют шаги). Ядро: `docker logs --tail 50 erpnext-backend-1`.
- **«Вкладка пустая» / «таймаут»** — флап фронтового BX24 (см. b24-rest-grabli.md); данные должны идти через `/api/*`, не через BX24.
- **«Ошибка при показе приложения»** после смены настроек — кеш Б24, лечится Ctrl+Shift+R (см. SOS.md п.7).
- **Канарейка**: новое видят только `BETA_USER_IDS` — «у менеджера не появилось» это норма, а не баг.

---

## Правила проекта (не нарушать)

1. Не писать код без обсуждения и явного «добро».
2. **Не удалять сущности портала** (сделки/контакты/заказы/документы) — зачистка тестов за владельцем;
   единственное исключение — авто-дубль от `sale.order.add` с гардом.
3. Write-тесты — только на тестовых сделках, с отчётом о созданных ID.
4. Прод-деплой — по слову владельца.
5. Меняешь поведение — правишь `docs/` в том же коммите.
6. Никогда: `docker compose down -v`, `docker volume rm`, `docker system prune --volumes` (сносят данные ядра).
