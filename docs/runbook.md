# Runbook

Рабочие процедуры подключения, обновления и восстановления. Для быстрой аварийной диагностики см. [SOS.md](SOS.md).

## Адреса и пути

Ниже используются обезличенные примеры. Рабочие адреса, пути и расписания хранятся в закрытой конфигурации окружения.

| Назначение | Значение |
|---|---|
| VPS | `root@<APP_HOST>` |
| публичный URL | `https://app.example.com` |
| репозиторий на VPS | `/srv/b24-app` |
| ERPNext Compose | `/srv/erpnext/pwd.yml` |
| env backend | `/srv/b24-config/backend.env` |
| служебные скрипты | `/srv/b24-service` |
| локальные бэкапы | `/srv/b24-backups` |
| nginx | `/etc/nginx/sites-available/b24-app` |

Доступ выполняется по SSH-ключу. Пароли, API-ключи, OAuth-секреты и вебхуки в команды, логи и Git не копируются.

## Проверка перед деплоем

В чистом состоянии исходников:

```bash
npm ci
npm run typecheck
npm -w @b24-app/backend test
npm run build
```

Незакоммиченные пользовательские файлы не включаются в коммит и образ случайно.

## Деплой backend

Вместо тега `COMMIT` используется короткий hash уже отправленного коммита из `main`.

```bash
cd /srv/b24-app
git fetch origin
git checkout main
git pull --ff-only origin main

COMMIT=$(git rev-parse --short HEAD)
docker build -t b24-app:$COMMIT .

docker stop b24-backend
docker rename b24-backend b24-backend-prev-before-$COMMIT

docker run -d \
  --name b24-backend \
  --network erpnext_frappe_network \
  -p 127.0.0.1:3000:8080 \
  --env-file /srv/b24-config/backend.env \
  --restart unless-stopped \
  b24-app:$COMMIT

curl --fail http://127.0.0.1:3000/health
curl --fail https://app.example.com/health
```

Предыдущий контейнер остаётся остановленным для отката. После проверки нужно убедиться, что новый контейнер имеет статус `Up` и использует ожидаемый образ:

```bash
docker ps --filter name=b24-backend
docker inspect --format '{{.Config.Image}}' b24-backend
```

## Откат backend

Сначала определить сохранённое имя:

```bash
docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}' | grep b24-backend
```

Затем остановить неудачную версию и вернуть сохранённый контейнер:

```bash
docker stop b24-backend
docker rename b24-backend b24-backend-failed-COMMIT
docker rename b24-backend-prev-before-COMMIT b24-backend
docker start b24-backend

curl --fail http://127.0.0.1:3000/health
curl --fail https://app.example.com/health
```

Не удалять сохранённый контейнер, пока причина сбоя не установлена.

## Подключение локального приложения Битрикс24

В настройках локального серверного приложения портала указываются:

- обработчик приложения: `https://app.example.com/app/handler`;
- обработчик установки: `https://app.example.com/install`;
- обработчик удаления: `https://app.example.com/uninstall`, если поле доступно;
- OAuth client ID и secret должны совпадать с закрытым env-файлом backend.

Права приложения должны покрывать используемые CRM, placement, задачи, пользователей, каталог, хранилища и Диск. Не расширять права без необходимости.

После сохранения настроек приложение устанавливает администратор портала. Установка привязывает вкладку сделки и пункты меню. Если названия или обработчики placement изменились, приложение должен один раз открыть администратор: backend выполнит сверку привязок. После изменения URL полезно выполнить полное обновление страницы Битрикс24.

## Переменные backend

Эталон структуры — [deploy/backend.env.example](../deploy/backend.env.example). Основные обязательные значения:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
PORTAL_DOMAIN=portal.example.bitrix24.ru
PUBLIC_BASE_URL=https://app.example.com
APP_CLIENT_ID=...
APP_CLIENT_SECRET=...
ERPNEXT_URL=http://frontend:8080
ERPNEXT_TOKEN=token ...
```

`APP_SECTION_URL`, `SUPPLY_SECTION_URL` и `REPAIRS_SECTION_URL` необязательны. Не сохранять неподтверждённые числовые placement-ID.

После изменения env контейнер нужно пересоздать: простой `docker restart` не перечитывает `--env-file`.

## ERPNext

Рабочий Compose-проект:

```bash
cd /srv/erpnext
docker compose -p erpnext -f pwd.yml ps
docker compose -p erpnext -f pwd.yml up -d
```

Операции `down -v`, удаление Docker volumes и очистка volumes запрещены: они уничтожают данные ядра.

## Резервное копирование

В рабочем crontab настроен запуск `/srv/b24-service/core-backup.sh`. Точное расписание хранится вне репозитория. Каждый день создаётся дамп БД; периодически добавляются публичные и приватные файлы. Политика ротации и внешнего хранения задаётся закрытой конфигурацией.

Проверка:

```bash
tail -100 /srv/b24-service/core-backup.log
ls -lhtr /srv/b24-backups | tail
```

`sync.sh` сохранён как миграционный инструмент, но в рабочем crontab отсутствует и автоматически не запускается.

## Восстановление ERPNext

Восстановление перезаписывает рабочую БД. Перед началом:

1. остановить пользовательские операции;
2. записать выбранный timestamp бэкапа;
3. сделать дополнительный свежий бэкап;
4. проверить наличие дампа и, при необходимости, архивов файлов;
5. подтвердить процедуру с ответственным.

Базовая команда выполняется внутри `erpnext-backend-1`:

```bash
bench --site frontend restore /path/to/database.sql.gz \
  --with-public-files /path/to/files.tar \
  --with-private-files /path/to/private-files.tar \
  --db-root-username root \
  --db-root-password 'ACTUAL_PASSWORD'
```

Актуальный пароль берётся из рабочей конфигурации сервера, не из документации. После восстановления проверяются `ping`, количество Item, последние складские документы и оба health-check приложения.

## Первичное развёртывание нового VPS

Новую площадку поднимают только из:

- `main` репозитория;
- файлов `deploy/`;
- свежего проверенного бэкапа ERPNext;
- отдельно переданных env и ключей.

Порядок: Docker и Compose → ERPNext → восстановление данных → backend → nginx и TLS → health-check → подключение Битрикс24 → тестовая сделка. Конкретные версии образов фиксируются в [deploy/pwd.yml](../deploy/pwd.yml); перед развёртыванием их не обновляют одновременно с переносом.
