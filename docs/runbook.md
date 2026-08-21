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

Ручной `POST /api/admin/sql-migration/supply/shadow-compare` дополнительно требует `B24_APP_SUPPLY_SHADOW_COMPARE=on` и OAuth точного владельца приложения. Без переменной безопасный default — `off`; при `B24_APP_DB_MODE=off` маршрут также закрыт. Включение флага требует отдельного согласованного пересоздания backend из фактического env текущего контейнера. Маршрут читает ERPNext только по API и SQL runtime credential только через `SELECT`, не запускает migration/backfill и не меняет ответ рабочего снаба.

Операторское правило получения OAuth для owner-only диагностики: initial placement `AUTH_ID` не использовать даже после reload/new tab — он уже неоднократно оказывался stale. Нужны только `domain` и `accessToken`, созданные frontend после инициализации SDK через `BX24.getAuth()`. Если изолированный browser context не показывает глобальный `BX24`, до действия включить узкое наблюдение сети и взять auth из одного штатного JSON POST frontend к собственному backend после SDK init, например `/api/supply/orders` или `/api/stock/form-data`; placement POST не подходит. Токен держать только в памяти, не выводить и не сохранять в файл/log/shell history, наблюдение сразу остановить, после единственного разрешённого запроса очистить browser runtime. Если такого запроса нет, остановиться и запросить решение пользователя; не перебирать initial token, reload, вкладки или webhook.

Постоянный owner OAuth vault — отдельный opt-in и не включается одним деплоем кода. Без `B24_APP_OAUTH_VAULT=on` `/install` не сохраняет токены, а диагностические маршруты ведут себя как раньше. Для активации нужны существующие `APP_CLIENT_ID`/`APP_CLIENT_SECRET`, новый случайный `B24_APP_OPERATOR_TOKEN` длиной не менее 32 символов и право локального приложения `entity`. Operator token хранится только в production secret/env, никогда не передаётся frontend, не выводится в terminal/log и не подставляется в URL.

Безопасная активация выполняется отдельным согласованным этапом:

1. Развернуть проверенный image сначала с `B24_APP_OAUTH_VAULT=off`, сохранив rollback container и весь фактический env/mount/network текущего backend.
2. Сгенерировать server-only operator token, добавить `B24_APP_OAUTH_VAULT=on` и `B24_APP_OPERATOR_TOKEN` при следующем согласованном пересоздании. Убедиться, что backend стартует, а `/app/state/oauth/owner.v1.enc` ещё отсутствует.
3. В настройках существующего локального приложения подтвердить scope «Хранилище данных» (`entity`) и один раз переустановить/переавторизовать приложение от имени точного владельца. URL или секрет входящего webhook для этого не используется.
4. Проверить только безопасные признаки: log `[install] owner OAuth vault initialized` без значений токенов, каталог `/app/state/oauth` с mode `0700`, файл `owner.v1.enc` с mode `0600`, ciphertext не содержит portal/access/refresh plaintext. Содержимое файла не печатать.
5. Выполнить один разрешённый read-only owner endpoint через internal localhost, передав bearer только из памяти процесса. После этого подтвердить успешный `user.current`, отсутствие токенов в логах и штатные health/public health/ERP read/network checks.

При проблеме вернуть `B24_APP_OAUTH_VAULT=off` или rollback container; workflow продолжит принимать пользовательский OAuth как прежде. Зашифрованный файл не удалять без отдельного разрешения: его потеря требует только повторной авторизации, но удаление необратимо для текущей OAuth-сессии. Vault не является источником workflow-данных и не переключает Bitrix/ERP/SQL reads или writes.

Disabled-каркас `b24-app:596bddb` развёрнут 2026-08-20 с сохранением предыдущего контейнера как `b24-backend-prev-before-596bddb`. После замены независимо подтверждены internal/public `/health`, `/ready` со статусом `database: disabled`, авторизованный ERPNext read, bind mount `/srv/b24-state:/app/state`, порт `127.0.0.1:3000`, restart policy `unless-stopped` и членство в `erpnext_frappe_network`. У нового контейнера `restart_count=0`; единственная переменная с префиксом `B24_APP_DB_` — `B24_APP_DB_MODE=off`. Это не переключение чтений или записей на SQL.

В 11:16:38 UTC одноразовый контейнер с отдельным migrator credential выполнил ручной runner. До запуска в `b24_app` было 0 таблиц, после — ровно одна `b24_app_schema_migrations` с 0 строк; каталог образа содержал 0 доменных `.sql`. Одноразовый контейнер удалён, production backend не перезапускался и остался в `MODE=off`.

После metadata migration полный backup job создал `20260820_112406-b24_app-database.sql.gz`: gzip/checksum прошли, dump содержит ровно одну metadata-таблицу и 0 data rows, Bitrix Disk read-back подтверждён для dump ID `103522` и checksum ID `103520`. Dump восстановлен в изолированную `b24_app_restore_20260820_112406`; совпали таблица, строки, charset/collation, колонки и индексы, source остался 1/0. После проверки guarded-скрипт удалил только временную schema; restore schema больше нет. Это закрывает backup/restore gate для metadata-only readiness, но не для будущих авторитетных доменных данных.

В 11:33:35 UTC backend config-only переключён на `B24_APP_DB_MODE=readiness` без смены image. Runtime env содержит только восемь разрешённых `B24_APP_DB_*` ключей и не содержит migration credentials; grants отдельно подтверждены как `USAGE + SELECT`. Internal/public `/health` и `/ready` (`database: up`), ERPNext read, network, port и state mount успешны; schema осталась 1 metadata table / 0 rows, `restart_count=0`. Предыдущий `MODE=off` контейнер сохранён как `b24-backend-prev-before-readiness-20260820-1131`; более ранний `b24-app:aabda51` также не удалён.

В 12:57:52 UTC после отдельного разрешения one-shot container `b24-app-migrate-5b9a6d8` с root-only `migrator.env` применил ровно `0001`-`0004` и завершился с exit code 0. Scheduled backup `20260820_123002-b24_app-database.sql.gz` до DDL имел валидные checksum/gzip, `.uploaded` и одну metadata table. Независимый post-check после DDL подтвердил 5 tables, 4 migration rows с ожидаемыми hashes, 54 columns, 5 FK, 20 CHECK, 21 indexes, 5/5 InnoDB `utf8mb4_unicode_ci` и 0 строк во всех четырёх domain tables. Рабочий backend не перезапускался и остался `b24-app:596bddb`, `B24_APP_DB_MODE=readiness`, `restart_count=0`; internal/public health/readiness, ERPNext read и `erpnext_frappe_network` успешны. Backfill, workflow SQL reads/writes, deploy и source switch не выполнялись.

В 13:10:30 UTC post-DDL backup job создал `20260820_131030-b24_app-database.sql.gz` размером 2511 bytes с 5 table definitions; checksum/gzip и внешний read-back подтверждены, Disk IDs `103618/103616`. Restore drill в `b24_app_restore_20260820_131030` независимо подтвердил совпадающие charset/collation и signatures 5 tables, 54 columns, 21 indexes, 5 FK, 20 CHECK, четыре migration hashes и 0 domain rows. После отдельного разрешения guarded cleanup удалил только temporary restore schema, exited runner и два root-only parity staging-файла. Backup сохранён; post-check показал restore schema count 0, production 5 tables / 4 migrations / 0 domain rows, backend `running`/`restart_count=0`, зелёные health/readiness, ERPNext read и network.

В 13:57 UTC read-only diagnostic image `b24-app:98eee50` развёрнут с сохранением `b24-backend-prev-before-98eee50` (`b24-app:596bddb`). Обязательные internal/public health, readiness, ERP read, state mount, port, restart policy и network checks успешны; restart count 0. В 14:21:54 UTC один owner OAuth dry-run прочитал ERPNext 383 + Bitrix transfers 108, построил 491 documents / 974 lines / 495 links / 692 allocations и вернул `readyToApply=false` с 64 issues. После запроса SQL rows остались `0|0|0|0`, migrations 4; временный SSH tunnel закрыт, OAuth runtime очищен. Полный разбор — в [`sql-supply-backfill-dry-run-2026-08-20.md`](sql-supply-backfill-dry-run-2026-08-20.md). Writer/backfill/source switch не выполнялись.

В 14:59 UTC read-only image `b24-app:38ce403` развёрнут с сохранением `b24-backend-prev-before-38ce403` (`b24-app:98eee50`). Internal/public health, readiness, ERP read, state mount, port, restart policy и network checks успешны; restart count 0. Один owner OAuth dry-run в 15:06:45 UTC полностью прочитал ERPNext 392 + Bitrix transfers 110 + transfer requests 5 и построил 505 documents / 991 lines / 508 links / 705 allocations. Errors сократились с 64 до 35: устранены все 29 ожидаемых standalone/manual false blockers без новых issue. Post-check подтвердил migrations 4 и SQL rows `0|0|0|0`; SSH tunnel закрыт, OAuth runtime очищен. Writer/backfill/source switch не выполнялись.

В 16:49 UTC read-only image `b24-app:b799329` развёрнут с сохранением `b24-backend-prev-before-b799329` (`b24-app:c9a3c0b`). Build выполнен из чистого `origin/main` archive; production untracked cleanup scripts сохранены и не попали в image. Internal/public health, readiness, официальный ERP read, `/srv/b24-state:/app/state`, `127.0.0.1:3000`, `unless-stopped` и `erpnext_frappe_network` успешны; restart count 0. Один owner OAuth dry-run в 17:01:10 UTC получил 510 documents / 991 lines / 520 links / 705 allocations, 6 errors и 17 warnings. Production log содержит один запрос/complete; post-check подтвердил 4 migrations и SQL domain rows `0|0|0|0`. Tunnel, OAuth runtime и временные файлы удалены. Writer/backfill/source switch не выполнялись.

В 17:10 UTC два read-only официальных ERP прохода (второй только из-за обрезки первого диагностического вывода) подтвердили все четыре stale keys: старая версия `MAT-MR-2026-00002@2026-07-17...`, один canceled Purchase Receipt и три canceled Stock Entry; текущая draft-заявка создана 21 июля и не имеет общих SKU. Текущий PO с именем из старой receipt также создан позже неё и содержит другой SKU. OAuth и SQL не использовались, backend не перезапускался, временные файлы удалены. Результат и локальная модель записаны в [`sql-supply-stale-request-audit-2026-08-20.md`](sql-supply-stale-request-audit-2026-08-20.md); focused `26/26`, полный backend `212/212` и typecheck успешны. На момент этого аудита production planner ещё не был изменён.

Commit `9b6b80c` опубликован и развёрнут как read-only `b24-app:9b6b80c`; rollback `b24-app:b799329` сохранён в `b24-backend-prev-before-9b6b80c`. Первый switch автоматически вернул rollback из-за неверного JSON-path только во временном readiness-check; canary и повторный switch после исправления проверки прошли. Internal/public health, readiness `up`, официальный ERPNext GET, `/srv/b24-state:/app/state`, `127.0.0.1:3000`, `unless-stopped`, restart count 0 и `erpnext_frappe_network` подтверждены.

Один полный owner OAuth dry-run в `2026-08-20T18:09:17.389Z` прочитал ERPNext `392`, `ctv_transfers` `110`, `ctv_tr_requests` `5` и построил 510 documents / 991 lines / 518 links / 705 allocations, 2 errors и 20 warnings; plan hash `4352ad2267a21df6884df8a25b1387a1088f9b37c16d2c98ef23b73cbd36359d`. Четыре более ранних POST завершились на устаревшем initial placement OAuth до чтения источников; успешный запрос использовал live `BX24.getAuth()`. Post-check подтвердил 4 migration rows и SQL domain rows `0|0|0|0`. Writer/backfill/source switch не выполнялись; `readyToApply=false` из-за двух live `missing_line_match`.

Commit `4579048` опубликован и развёрнут как read-only `b24-app:4579048`; rollback `b24-app:9b6b80c` сохранён в `b24-backend-prev-before-4579048`. Первый canary-check опередил готовность HTTP listener и завершился без production switch; одноразовый deploy-скрипт получил retry, после чего canary и switch прошли. Internal/public health, readiness `up`, официальный ERPNext GET, `/srv/b24-state:/app/state`, `127.0.0.1:3000`, `unless-stopped`, restart count 0 и `erpnext_frappe_network` подтверждены.

Один полный owner OAuth dry-run в `2026-08-20T18:38:35.406Z` прочитал ERPNext `392`, `ctv_transfers` `110`, `ctv_tr_requests` `5` и построил 510 documents / 991 lines / 518 links / 705 allocations, 0 errors и 22 warnings; plan hash `beb0d8563674cefeff40b78fa7969e37e2572c3ec0bf96cdfefcc250cf9b1881`. Production log содержит ровно один вход и один `complete`. Post-check подтвердил runtime без migration credentials, 4 migration rows и SQL domain rows `0|0|0|0`. `readyToApply=true` не запускал writer/backfill/source switch; OAuth runtime и временные файлы удалены.

21 августа локально подготовлены migration `0005` и атомарный supply mirror writer/checkpoint. Изолированный MariaDB 11.8 rehearsal подтвердил первый apply, no-op повтор, update существующих identities, полный rollback и DML-only grants. На production этот change set не применялся: текущий image остаётся `b24-app:4579048`, migration rows `4`, SQL domain rows `0|0|0|0`, backfill user отсутствует, workflow продолжает читать Bitrix/ERPNext. Подробности — в [`sql-supply-mirror-writer-2026-08-21.md`](sql-supply-mirror-writer-2026-08-21.md).

Перед `0005` commit `d46475d` опубликован без deploy. Safety job `20260821_072214-b24_app-database.sql.gz` (2513 bytes) прошёл локальные gzip/checksum и Bitrix Disk read-back, IDs `103718/103716`; dump содержит пять текущих tables, четыре migration rows и 0 domain rows. Hash committed `0005` — `885e8222db301725daf7fa3ef792ddbdc07328f0afaad5f1d6e6991e35a5fd97`. Post-check подтвердил internal/public health, readiness, ERPNext read, `b24-app:4579048`, restart count 0 и отсутствие migration/backfill env. Migration, credential, deploy и backfill не выполнялись.

После отдельного разрешения 21 августа создан `b24_app_backfill`@`%` только с `SELECT/INSERT/UPDATE` на `b24_app.*`. Root-only credentials находятся в `/root/b24-app-secrets/backfill.env` и `backfill.cnf`, mode `600`; backend env их не получил. Отдельный login успешен; реальные `DELETE` и DDL отклонены, schema privileges вне `b24_app` отсутствуют. Counts до/после `0|0|0|0|4`, probe table отсутствует. Post-check подтвердил internal/public health, readiness, ERPNext API, network, `b24-app:4579048`, running/restart 0. Migration `0005`, deploy, mirror apply и source switch не выполнялись; временные scripts удалены.

После следующего отдельного разрешения one-shot container `b24-app-migrate-d46475d-0005` применил только `0005_create_supply_mirror_checkpoints.sql` с hash `885e8222db301725daf7fa3ef792ddbdc07328f0afaad5f1d6e6991e35a5fd97` и завершился `exit 0`. Production теперь содержит 6 tables / 5 migrations; checkpoint и четыре workflow tables пусты. Post-DDL job создал `20260821_074553-b24_app-database.sql.gz` (2782 bytes, 6 definitions), прошёл checksum/gzip и Disk read-back, IDs `103730/103728`. Restore в `b24_app_restore_20260821_074553` дал полное совпадение settings/signatures: 66 columns, 37 index rows, 5 FK, 22 CHECK, 5 migrations и rows `0|0|0|0|0`. Restore schema, exited runner и image сохранены до отдельного cleanup; staging удалён. Backend не менялся: `b24-app:4579048`, readiness, internal/public health, ERP API, network и restart 0 зелёные. Mirror apply/source switch не выполнялись. Build/operator warnings зафиксированы в [`sql-supply-mirror-writer-2026-08-21.md`](sql-supply-mirror-writer-2026-08-21.md) и не исправлялись в этом этапе.

Параллельный deploy `0162f23` из ветки, основанной на `aabda51`, ошибочно заменил ID отдела снабжения `10` на ID сервисного центра `12` и временно убрал из runtime 22 commits SQL/dry-run истории: internal/public `/ready` стали 404. MariaDB сохранила `6/5/0`, backup/restore/credentials остались целы; `4579048` был корректно сохранён как rollback. Патч был перенесён поверх актуальной `main`, но его ошибочное тестовое ожидание `[12]` также прошло в `740403a`; тесты доказывали согласованность кода с fixture, а не фактическую оргструктуру Bitrix24.

`740403a` был развёрнут с `B24_APP_DB_MODE=readiness`, department ID `12`, writer source и `0001`-`0005`; writer не вызывался. Перед первым mirror apply его internal/public health и `/ready`, официальный ERP read, `/srv/b24-state`, `127.0.0.1:3000`, `unless-stopped`, restart 0 и `erpnext_frappe_network` были подтверждены независимо. Полный журнал и посторонние build-наблюдения — в [`sql-supply-mirror-writer-2026-08-21.md`](sql-supply-mirror-writer-2026-08-21.md).

После отдельного разрешения первый production supply mirror был выполнен one-shot операторским процессом, не backend runtime. Свежий полный план прочитал ERPNext `398`, `ctv_transfers` `110`, `ctv_tr_requests` `5`, получил hash `181e72d285b576b9b22c00993d88eb9451ceb10f669bfcc2366a4e2cf35d02e6`, `516` documents / `1002` lines / `527` links / `716` allocations, `0` errors / `22` historical warnings. Атомарный apply создал один checkpoint; точный повтор hash вернул no-op. Независимая проверка подтвердила counts `516|1002|527|716|1|5`, свободный lock, нулевые orphan counts и выборочные полные graph chains. Runtime остался `b24-app:740403a` в `B24_APP_DB_MODE=readiness`; SQL-чтения workflow, HTTP apply route и source switch не включались, временные OAuth/capture/env-файлы удалены.

Post-apply job `/root/sync/b24-app-backup-job.sh` создал `/root/core-backups/b24_app/20260821_090845-b24_app-database.sql.gz` размером `163253` bytes; gzip/checksum и внешний Bitrix Disk read-back успешны, dump ID `103800`, checksum ID `103798`. Официальный restore drill восстановил его только в `b24_app_restore_20260821_090845`. Source и restore точно совпали по charset/collation, 6 tables, 66 columns, 37 indexes, 40 constraints, 22 CHECK, 5 FK, всем шести row checksums и counts/hash. Restore schema намеренно сохранена до отдельного cleanup-разрешения; прежняя `b24_app_restore_20260821_074553`, migration runner/image и безопасные staging-артефакты также не удалялись.

После подтверждённого отказа доступа реального сотрудника снабжения commit `280e5e4` вернул `SUPPLY_DEPARTMENT_ID=10` и развёрнут как `b24-app:280e5e4`. До switch прошли focused access `10/10`, backend `221/221`, frontend `117/117`, workspace typecheck и production build. Текущий `b24-backend` работает с restart count 0, `unless-stopped`, `/srv/b24-state:/app/state`, `127.0.0.1:3000` и `erpnext_frappe_network`; internal/public health и readiness, официальный ERP read и department ID в image подтверждены. Живые логи после switch показали HTTP 200 для supply placement, access control, stock form, suppliers и orders (`58` заявок); ошибок приложения нет.

Деплой не менял SQL-режим или данные: `B24_APP_DB_MODE=readiness`, counts `516|1002|527|716|1|5`, checkpoint `181e72d285b576b9b22c00993d88eb9451ceb10f669bfcc2366a4e2cf35d02e6`, warnings `22`, orphan checks `0|0|0`, lock свободен. Source switch, shadow read, migration и mirror write не выполнялись. Rollback `b24-backend-prev-before-280e5e4` с image `b24-app:740403a` сохранён в exited 0; canary и env snapshot удалены. Первые мгновенные canary/release checks опередили готовность HTTP listener; встроенные retries прошли, откат не потребовался.

Commit `2823a57` с read-only supply mirror reader/comparator foundation и точечным правом создания каталога был развёрнут без env/source switch; rollback `b24-backend-prev-before-2823a57` сохранил `b24-app:280e5e4`. Internal/public health и `/ready`, официальный ERP read, network, state, port и restart 0 прошли; comparator ещё не имел runtime route.

Commit `147f876` добавил только owner-only ручной `POST /api/admin/sql-migration/supply/shadow-compare` и развёрнут с эффективным `B24_APP_SUPPLY_SHADOW_COMPARE=off`. До и после switch прошли internal/public health и `/ready` (`database: up`) и официальный ERPNext read; независимо подтверждены image, restart 0, `unless-stopped`, `/srv/b24-state:/app/state`, `127.0.0.1:3000` и `erpnext_frappe_network`. Неавторизованный endpoint отвечает `403`; config из собранного image возвращает `off`. Shadow compare, migration, mirror write и source switch не запускались. Rollback `b24-backend-prev-before-147f876` сохраняет `b24-app:2823a57` в exited state.

Первая production-попытка shadow compare временно пересоздала тот же `147f876` с флагом `on`, сохранив исходный контейнер целиком. Pre/post-switch health/readiness, ERP GET, network/mount/port/restart и SQL checkpoint/counts прошли. Единственный owner POST использовал initial placement `AUTH_ID` и был отклонён `403` за `1.86 ms` до запуска comparator или чтения источников; повтор не выполнялся. Исходный контейнер возвращён с флагом `off`, а неуспешный `b24-backend-shadow-on-first-compare-403` сохранён exited 0. SQL остался `516|1002|527|716|1|5` с тем же hash; OAuth и временные scripts удалены. Следующая попытка требует отдельного разрешения и только актуального token из живого SDK-authenticated API request.

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
