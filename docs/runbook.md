# Runbook

Рабочие процедуры подключения, обновления и восстановления. Для быстрой аварийной диагностики см. [SOS.md](SOS.md).

## Адреса и пути

Ниже используются обезличенные заполнители. Это **не готовые команды и не фактические пути**: перед запуском процедуры оператор обязан подставить значения из закрытой конфигурации окружения. Заполнители записаны в угловых скобках, чтобы их нельзя было случайно принять за рабочий путь.

| Назначение | Значение |
|---|---|
| VPS | `root@<APP_HOST>` |
| публичный URL | `https://app.example.com` |
| репозиторий на VPS | `<APP_REPO>` |
| ERPNext Compose | `<ERP_COMPOSE_FILE>` |
| исходный env для первого запуска | `<BACKEND_ENV>` |
| служебные скрипты | `<SERVICE_DIR>` |
| локальные бэкапы | `<BACKUP_DIR>` |
| nginx | `<NGINX_SITE_FILE>` |

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

Ниже описано **обновление уже работающего** `b24-backend`. Процедура не зависит от пути к старому env-файлу: она снимает root-only копию фактического окружения, state-volume и публичный URL с текущего контейнера. Для первого запуска, когда текущего контейнера ещё нет, используется явно проверенный `<BACKEND_ENV>` из закрытой конфигурации.

Перед запуском задать только фактический путь репозитория. Команда намеренно завершится до остановки backend, если переменная не задана, репозиторий содержит незакоммиченные отслеживаемые изменения, текущий контейнер не подключён к ERPNext или имя rollback уже занято.

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

: "${APP_REPO:?set APP_REPO from the private production configuration}"
cd "$APP_REPO"

git diff --quiet
git diff --cached --quiet
if git ls-files --others --exclude-standard -- \
  packages package.json package-lock.json tsconfig.base.json Dockerfile .dockerignore \
  | grep -q .; then
  echo "untracked files would enter the Docker build context" >&2
  exit 1
fi
git fetch origin
git checkout main
git merge --ff-only origin/main

COMMIT=$(git rev-parse --short HEAD)
ROLLBACK="b24-backend-prev-before-$COMMIT"

docker container inspect b24-backend >/dev/null
if docker container inspect "$ROLLBACK" >/dev/null 2>&1; then
  echo "rollback container already exists: $ROLLBACK" >&2
  exit 1
fi
docker inspect --format '{{json .NetworkSettings.Networks}}' b24-backend \
  | grep -q '"erpnext_frappe_network"'

STATE_DIR=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/state"}}{{.Source}}{{end}}{{end}}' b24-backend)
PUBLIC_URL=$(docker exec b24-backend printenv PUBLIC_BASE_URL)
test -n "$STATE_DIR"
test -n "$PUBLIC_URL"

umask 077
ENV_SNAPSHOT=$(mktemp /tmp/b24-backend-env.XXXXXX)
trap 'rm -f "$ENV_SNAPSHOT"' EXIT
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' b24-backend > "$ENV_SNAPSHOT"
test -s "$ENV_SNAPSHOT"

docker build -t "b24-app:$COMMIT" .

restore_previous() {
  docker rm -f b24-backend >/dev/null 2>&1 || true
  docker rename "$ROLLBACK" b24-backend
  docker start b24-backend
  curl --fail --retry 15 --retry-delay 1 --retry-all-errors http://127.0.0.1:3000/health
  curl --fail --retry 5 --retry-delay 1 --retry-all-errors "${PUBLIC_URL%/}/health"
}

docker stop b24-backend
if ! docker rename b24-backend "$ROLLBACK"; then
  docker start b24-backend
  exit 1
fi

if ! docker run -d \
  --name b24-backend \
  --network erpnext_frappe_network \
  -p 127.0.0.1:3000:8080 \
  -v "$STATE_DIR:/app/state" \
  --env-file "$ENV_SNAPSHOT" \
  --restart unless-stopped \
  "b24-app:$COMMIT"; then
  restore_previous
  exit 1
fi

verify_release() {
  curl --fail --retry 15 --retry-delay 1 --retry-all-errors http://127.0.0.1:3000/health || return 1
  curl --fail --retry 5 --retry-delay 1 --retry-all-errors "${PUBLIC_URL%/}/health" || return 1
  test "$(docker inspect --format '{{.Config.Image}}' b24-backend)" = "b24-app:$COMMIT" || return 1
  docker inspect --format '{{json .NetworkSettings.Networks}}' b24-backend \
    | grep -q '"erpnext_frappe_network"' || return 1
  docker exec b24-backend node -e '
    const base = String(process.env.ERPNEXT_URL || "").replace(/\/$/, "");
    const token = String(process.env.ERPNEXT_TOKEN || "");
    fetch(base + "/api/resource/Company?fields=%5B%22name%22%5D&limit_page_length=1", {
      headers: { Authorization: token },
    }).then((response) => {
      if (!response.ok) throw new Error(`ERPNext HTTP ${response.status}`);
      return response.json();
    }).then((payload) => {
      console.log(JSON.stringify({ ok: true, rows: Array.isArray(payload.data) ? payload.data.length : 0 }));
    }).catch((error) => { console.error(error.message); process.exit(1); });
  ' || return 1
}

if ! verify_release; then
  restore_previous
  exit 1
fi

rm -f "$ENV_SNAPSHOT"
trap - EXIT
```

Предыдущий контейнер остаётся остановленным под именем из `$ROLLBACK`. Не удалять его до отдельного подтверждения стабильности релиза. Успешный `verify_release` уже подтверждает все обязательные условия: внутренний и публичный health, ожидаемый образ, членство в `erpnext_frappe_network` и авторизованный read-only запрос к ERPNext.

```bash
docker ps --filter name=b24-backend
docker inspect --format '{{.Config.Image}}' b24-backend
docker inspect --format '{{json .NetworkSettings.Networks}}' b24-backend
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

По состоянию на 2026-08-20 рабочий cron независимо запускает `/root/sync/core-backup.sh` ежедневно в 12:00 UTC и `/root/sync/b24-app-backup-job.sh` в 12:30 UTC. Первый делает bench site backup ERPNext, раз в неделю добавляет файлы, выгружает результат на Диск Битрикс24 и сохраняет 14 DB/4 file backups. Второй создаёт отдельный `b24_app` dump, проверяет внешний read-back и применяет свой retention. Перед операцией всё равно заново проверить фактический crontab и содержимое скриптов: путь не является переносимой настройкой нового сервера.

Проверка:

```bash
crontab -l
sed -n '1,240p' /root/sync/core-backup.sh
sed -n '1,260p' /root/sync/b24-app-backup-job.sh
find /root/sync -maxdepth 2 -type f -name '*.log' -o -name '*.sql.gz'
```

`sync.sh` сохранён как миграционный инструмент, но в рабочем crontab отсутствует и автоматически не запускается.

### Отдельная база `b24_app`

Bench backup не включает отдельную базу `b24_app`. До её первых авторитетных записей оператор обязан расширить фактический backup script отдельным consistent dump, проверкой архива/checksum, внешней копией и retention, а затем выполнить restore drill в отдельную временную БД. Runtime, migrator и backup используют разных ограниченных пользователей; root не передаётся backend.

На 2026-08-20 schema и три роли provisioned. Проверенные root-only credentials хранятся в `/root/b24-app-secrets`; не выводить их в shell history, логи или Git. Production backend на commit `596bddb` работает в `B24_APP_DB_MODE=readiness` с отдельным runtime credential, имеющим только `USAGE + SELECT`. SQL используется только для `/ready` (`SELECT 1`); workflow queries, backfill и записи не включены. Отдельный runner image `b24-app:5b9a6d8` применил четыре supply identity/graph migrations; production содержит 5 tables, 4 migration rows и 0 domain rows.

Standalone `/root/sync/b24-app-backup.sh` пишет только в root-only `/root/core-backups/b24_app`. Для dump используется отдельный `/root/b24-app-secrets/backup-dump.cnf` без поля `database=`; это исключает конфликт с `mariadb-dump --databases`. Ручные архивы лежат в `manual/`, диагностический — в `diagnostic/`, поэтому ERPNext retention их не видит.

Job `/root/sync/b24-app-backup-job.sh` в 12:30 UTC загружает dump/checksum в изолированную папку Bitrix Disk `b24_app_backups`, скачивает их обратно и сравнивает SHA-256. Только затем создаётся `.uploaded` и применяется локальный retention 14 пар; внешний retention также ограничен 14 парами и строгим шаблоном внутри этой папки. Предыдущий crontab сохранён root-only в `/root/sync/crontab.before-b24-app-20260820`.

20 августа 2026 года обе cron-команды вручную прогнаны последовательно с тем же окружением и логированием. ERPNext job заняла 21 секунду, создала валидный `20260820_072540-frontend-database.sql.gz`, получила успешный Disk ID и штатно сохранила 14 локальных DB-копий, удалив только старейшую `20260806_090004-frontend-database.sql.gz`. `b24_app` job заняла 4 секунды, создала `20260820_102633-b24_app-database.sql.gz`, проверила gzip/checksum, внешний read-back SHA-256 и `.uploaded`. После rehearsal cron service active, процессов backup не осталось, оба health, ERP read, MariaDB health и network check прошли. Это проверяет сами cron-команды; факт первого запуска именно планировщиком всё равно подтверждается по следующей записи в логах.

Restore drill пустого dump выполнен в `b24_app_restore_20260820_084026`: charset/collation и 0 таблиц совпали, рабочая `b24_app` осталась с 0 таблиц. Guard-скрипт запретил рабочее имя и повторный restore; после отдельного разрешения cleanup-скрипт удалил только временную schema. Backup gate ещё не закрыт для авторитетных данных: нужен повторный drill после появления доменных migrations/данных, измеренные RPO/RTO и фактическая проверка ветки retention после превышения лимита.

Полный gate, порядок восстановления и отката описаны в [sql-migration.md](sql-migration.md). На текущем этапе `B24_APP_DB_MODE=readiness`; это dependency probe без переключения источников. ERPNext backup script не изменён, добавлена только независимая `b24_app` backup job.

Disabled-каркас `b24-app:596bddb` развёрнут 2026-08-20 с сохранением предыдущего контейнера как `b24-backend-prev-before-596bddb`. После замены независимо подтверждены internal/public `/health`, `/ready` со статусом `database: disabled`, авторизованный ERPNext read, bind mount `/srv/b24-state:/app/state`, порт `127.0.0.1:3000`, restart policy `unless-stopped` и членство в `erpnext_frappe_network`. У нового контейнера `restart_count=0`; единственная переменная с префиксом `B24_APP_DB_` — `B24_APP_DB_MODE=off`. Это не переключение чтений или записей на SQL.

В 11:16:38 UTC одноразовый контейнер с отдельным migrator credential выполнил ручной runner. До запуска в `b24_app` было 0 таблиц, после — ровно одна `b24_app_schema_migrations` с 0 строк; каталог образа содержал 0 доменных `.sql`. Одноразовый контейнер удалён, production backend не перезапускался и остался в `MODE=off`.

После metadata migration полный backup job создал `20260820_112406-b24_app-database.sql.gz`: gzip/checksum прошли, dump содержит ровно одну metadata-таблицу и 0 data rows, Bitrix Disk read-back подтверждён для dump ID `103522` и checksum ID `103520`. Dump восстановлен в изолированную `b24_app_restore_20260820_112406`; совпали таблица, строки, charset/collation, колонки и индексы, source остался 1/0. После проверки guarded-скрипт удалил только временную schema; restore schema больше нет. Это закрывает backup/restore gate для metadata-only readiness, но не для будущих авторитетных доменных данных.

В 11:33:35 UTC backend config-only переключён на `B24_APP_DB_MODE=readiness` без смены image. Runtime env содержит только восемь разрешённых `B24_APP_DB_*` ключей и не содержит migration credentials; grants отдельно подтверждены как `USAGE + SELECT`. Internal/public `/health` и `/ready` (`database: up`), ERPNext read, network, port и state mount успешны; schema осталась 1 metadata table / 0 rows, `restart_count=0`. Предыдущий `MODE=off` контейнер сохранён как `b24-backend-prev-before-readiness-20260820-1131`; более ранний `b24-app:aabda51` также не удалён.

В 12:57:52 UTC после отдельного разрешения one-shot container `b24-app-migrate-5b9a6d8` с root-only `migrator.env` применил ровно `0001`-`0004` и завершился с exit code 0. Scheduled backup `20260820_123002-b24_app-database.sql.gz` до DDL имел валидные checksum/gzip, `.uploaded` и одну metadata table. Независимый post-check после DDL подтвердил 5 tables, 4 migration rows с ожидаемыми hashes, 54 columns, 5 FK, 20 CHECK, 21 indexes, 5/5 InnoDB `utf8mb4_unicode_ci` и 0 строк во всех четырёх domain tables. Рабочий backend не перезапускался и остался `b24-app:596bddb`, `B24_APP_DB_MODE=readiness`, `restart_count=0`; internal/public health/readiness, ERPNext read и `erpnext_frappe_network` успешны. Backfill, workflow SQL reads/writes, deploy и source switch не выполнялись.

В 13:10:30 UTC post-DDL backup job создал `20260820_131030-b24_app-database.sql.gz` размером 2511 bytes с 5 table definitions; checksum/gzip и внешний read-back подтверждены, Disk IDs `103618/103616`. Restore drill в `b24_app_restore_20260820_131030` независимо подтвердил совпадающие charset/collation и signatures 5 tables, 54 columns, 21 indexes, 5 FK, 20 CHECK, четыре migration hashes и 0 domain rows. После отдельного разрешения guarded cleanup удалил только temporary restore schema, exited runner и два root-only parity staging-файла. Backup сохранён; post-check показал restore schema count 0, production 5 tables / 4 migrations / 0 domain rows, backend `running`/`restart_count=0`, зелёные health/readiness, ERPNext read и network.

В 13:57 UTC read-only diagnostic image `b24-app:98eee50` развёрнут с сохранением `b24-backend-prev-before-98eee50` (`b24-app:596bddb`). Обязательные internal/public health, readiness, ERP read, state mount, port, restart policy и network checks успешны; restart count 0. В 14:21:54 UTC один owner OAuth dry-run прочитал ERPNext 383 + Bitrix transfers 108, построил 491 documents / 974 lines / 495 links / 692 allocations и вернул `readyToApply=false` с 64 issues. После запроса SQL rows остались `0|0|0|0`, migrations 4; временный SSH tunnel закрыт, OAuth runtime очищен. Полный разбор — в [`sql-supply-backfill-dry-run-2026-08-20.md`](sql-supply-backfill-dry-run-2026-08-20.md). Writer/backfill/source switch не выполнялись.

В 14:59 UTC read-only image `b24-app:38ce403` развёрнут с сохранением `b24-backend-prev-before-38ce403` (`b24-app:98eee50`). Internal/public health, readiness, ERP read, state mount, port, restart policy и network checks успешны; restart count 0. Один owner OAuth dry-run в 15:06:45 UTC полностью прочитал ERPNext 392 + Bitrix transfers 110 + transfer requests 5 и построил 505 documents / 991 lines / 508 links / 705 allocations. Errors сократились с 64 до 35: устранены все 29 ожидаемых standalone/manual false blockers без новых issue. Post-check подтвердил migrations 4 и SQL rows `0|0|0|0`; SSH tunnel закрыт, OAuth runtime очищен. Writer/backfill/source switch не выполнялись.

### Текущее состояние `/app/state`

Read-only аудит 2026-08-20 подтвердил bind mount `/srv/b24-state:/app/state`, но не нашёл его копирования в `core-backup.sh`, отдельном cron или backup timer. Это отдельный существующий риск: договоры, contract sequences, шаблоны и operation log нельзя считать восстановимыми из описанного выше ERPNext backup. Исправление state backup не смешивать с SQL provision; провести отдельный restore drill и только после него обновить этот статус.

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
