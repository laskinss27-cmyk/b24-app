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

21 августа отдельно разрешён Tilda mapping foundation без deploy и без Tilda write. Safety backup `20260821_140011-b24_app-database.sql.gz` прошёл Disk read-back. One-shot migrator применил только `0006_create_tilda_product_mappings.sql` (`b96e52a710b8ca2549f8271110d2cf801e4b90f81a881328a7e1a797ed6023f5`); post-DDL restore `b24_app_restore_20260821_140418` совпал по структуре и всем table checksums. DML-only backfill записал `177|134 confirmed|43 ignored|0 unresolved`, повтор сохранил checksum `616442171`. Post-backfill dump `20260821_141039-b24_app-database.sql.gz` и restore `b24_app_restore_20260821_141039` подтвердили те же строки и полную parity семи таблиц. Fresh official ERP preview: 134 offers, 16 skipped stock-bearing ignored, 63 zero, 71 positive, total 1274, hash `4889fd511f150c38441426704cf035d0263b85d22f63599663f0ee49aec82110`; audit `/root/b24-app-audits/20260821-1408-tilda-stock-preview.json`. Runtime остался `b24-app:ef4fecb`, readiness-only, restart 0, без Tilda/one-shot env; health/readiness/public health/ERP/network зелёные. Retention штатно удалил две старейшие пары `20260820_085056` и `20260820_085654` локально и на Disk; 14 актуальных пар сохранены. Exited credential-bearing one-shot containers удалены, restore schemas/staging сохранены. Следующий gate — свежий Tilda CSV backup и отдельно разрешённая публикация только количеств.

После отдельного разрешения первый production supply mirror был выполнен one-shot операторским процессом, не backend runtime. Свежий полный план прочитал ERPNext `398`, `ctv_transfers` `110`, `ctv_tr_requests` `5`, получил hash `181e72d285b576b9b22c00993d88eb9451ceb10f669bfcc2366a4e2cf35d02e6`, `516` documents / `1002` lines / `527` links / `716` allocations, `0` errors / `22` historical warnings. Атомарный apply создал один checkpoint; точный повтор hash вернул no-op. Независимая проверка подтвердила counts `516|1002|527|716|1|5`, свободный lock, нулевые orphan counts и выборочные полные graph chains. Runtime остался `b24-app:740403a` в `B24_APP_DB_MODE=readiness`; SQL-чтения workflow, HTTP apply route и source switch не включались, временные OAuth/capture/env-файлы удалены.

Post-apply job `/root/sync/b24-app-backup-job.sh` создал `/root/core-backups/b24_app/20260821_090845-b24_app-database.sql.gz` размером `163253` bytes; gzip/checksum и внешний Bitrix Disk read-back успешны, dump ID `103800`, checksum ID `103798`. Официальный restore drill восстановил его только в `b24_app_restore_20260821_090845`. Source и restore точно совпали по charset/collation, 6 tables, 66 columns, 37 indexes, 40 constraints, 22 CHECK, 5 FK, всем шести row checksums и counts/hash. Restore schema намеренно сохранена до отдельного cleanup-разрешения; прежняя `b24_app_restore_20260821_074553`, migration runner/image и безопасные staging-артефакты также не удалялись.

После подтверждённого отказа доступа реального сотрудника снабжения commit `280e5e4` вернул `SUPPLY_DEPARTMENT_ID=10` и развёрнут как `b24-app:280e5e4`. До switch прошли focused access `10/10`, backend `221/221`, frontend `117/117`, workspace typecheck и production build. Текущий `b24-backend` работает с restart count 0, `unless-stopped`, `/srv/b24-state:/app/state`, `127.0.0.1:3000` и `erpnext_frappe_network`; internal/public health и readiness, официальный ERP read и department ID в image подтверждены. Живые логи после switch показали HTTP 200 для supply placement, access control, stock form, suppliers и orders (`58` заявок); ошибок приложения нет.

Деплой не менял SQL-режим или данные: `B24_APP_DB_MODE=readiness`, counts `516|1002|527|716|1|5`, checkpoint `181e72d285b576b9b22c00993d88eb9451ceb10f669bfcc2366a4e2cf35d02e6`, warnings `22`, orphan checks `0|0|0`, lock свободен. Source switch, shadow read, migration и mirror write не выполнялись. Rollback `b24-backend-prev-before-280e5e4` с image `b24-app:740403a` сохранён в exited 0; canary и env snapshot удалены. Первые мгновенные canary/release checks опередили готовность HTTP listener; встроенные retries прошли, откат не потребовался.

Commit `2823a57` с read-only supply mirror reader/comparator foundation и точечным правом создания каталога был развёрнут без env/source switch; rollback `b24-backend-prev-before-2823a57` сохранил `b24-app:280e5e4`. Internal/public health и `/ready`, официальный ERP read, network, state, port и restart 0 прошли; comparator ещё не имел runtime route.

Commit `147f876` добавил только owner-only ручной `POST /api/admin/sql-migration/supply/shadow-compare` и развёрнут с эффективным `B24_APP_SUPPLY_SHADOW_COMPARE=off`. До и после switch прошли internal/public health и `/ready` (`database: up`) и официальный ERPNext read; независимо подтверждены image, restart 0, `unless-stopped`, `/srv/b24-state:/app/state`, `127.0.0.1:3000` и `erpnext_frappe_network`. Неавторизованный endpoint отвечает `403`; config из собранного image возвращает `off`. Shadow compare, migration, mirror write и source switch не запускались. Rollback `b24-backend-prev-before-147f876` сохраняет `b24-app:2823a57` в exited state.

Первая production-попытка shadow compare временно пересоздала тот же `147f876` с флагом `on`, сохранив исходный контейнер целиком. Pre/post-switch health/readiness, ERP GET, network/mount/port/restart и SQL checkpoint/counts прошли. Единственный owner POST использовал initial placement `AUTH_ID` и был отклонён `403` за `1.86 ms` до запуска comparator или чтения источников; повтор не выполнялся. Исходный контейнер возвращён с флагом `off`, а неуспешный `b24-backend-shadow-on-first-compare-403` сохранён exited 0. SQL остался `516|1002|527|716|1|5` с тем же hash; OAuth и временные scripts удалены. Следующая попытка требует отдельного разрешения и только актуального token из живого SDK-authenticated API request.

Commit `ef4fecb` с opt-in rotating owner OAuth vault развёрнут без его активации: production имеет явный `B24_APP_OAUTH_VAULT=off`, не имеет `B24_APP_OPERATOR_TOKEN`, а `/app/state/oauth/owner.v1.enc` отсутствует. Canary с read-only state mount прошёл internal health/readiness и официальный ERP read до switch. После switch независимо подтверждены image `b24-app:ef4fecb`, restart `0`, `unless-stopped`, bind mount `/srv/b24-state:/app/state`, порт `127.0.0.1:3000`, `erpnext_frappe_network`, internal/public health, readiness `database: up` и официальный ERP read. Rollback `b24-backend-prev-before-ef4fecb` сохраняет `b24-app:147f876` в exited state. SQL checkpoint остался `516|1002|527|716|1|5`, hash `181e72d285b576b9b22c00993d88eb9451ceb10f669bfcc2366a4e2cf35d02e6`, sources `398|110|5`, warnings `22`. App reauthorization, token capture/refresh, shadow compare, migrations, mirror writes и source switch не выполнялись. Deploy-скрипт после успешной строки `deployed=ef4fecb` получил только завершающую CRLF shell-ошибку временного файла; полный независимый post-check прошёл. Наблюдавшиеся npm engine/audit и Vite chunk warnings оставлены как посторонние build warnings и в этом этапе не исправлялись.

21 августа тот же image `b24-app:ef4fecb` отдельным config-only switch переведён в `B24_APP_OAUTH_VAULT=on`; случайный operator token длиной 64 символа создан и сохранён только в production env без вывода значения. Предыдущая конфигурация сохранена как exited rollback `b24-backend-prev-before-oauth-vault-on-20260821-1225` с тем же image и `B24_APP_OAUTH_VAULT=off`. После ручной переустановки локального приложения Bitrix24 ID `54` с уже выбранным scope `entity` журнал подтвердил точного владельца, создание vault и повторную привязку ожидаемых placements. Зашифрованный envelope `/srv/b24-state/oauth/owner.v1.enc` создан с mode `0600` в каталоге mode `0700`; структура AES-256-GCM валидна, открытых маркеров access/refresh token, OAuth host или portal domain нет. Внутренний operator POST к выключенному shadow endpoint вернул ожидаемый `503 disabled`: vault успешно расшифрован и владелец подтверждён, но comparator и чтение источников не запускались. Post-check подтвердил running/restart `0`, `unless-stopped`, state mount, локальный порт, `erpnext_frappe_network`, internal/public health, readiness `database: up` и официальный ERP Item GET `200` с одной строкой. SQL остался `516|1002|527|716|1|5` с тем же hash, sources `398|110|5` и warnings `22`; migrations, mirror writes и source switch не выполнялись. Временный activation script после своей успешной финальной строки завершился только из-за CRLF в конце файла; независимая проверка всех перечисленных инвариантов прошла.

Первый успешный owner shadow compare выполнен ровно один раз через временный canary того же `ef4fecb`; production-контейнер не менялся, state был подключён canary только read-only, а shadow flag оставался выключен в production. Полный план от `12:43:38 UTC` дал `552|1064|563|753`, `22` warnings и hash `22ad151b5f2881b525d84c687583bcd23948dbc18f66219734f8091abda0f831`; checkpoint от `09:03:35 UTC` ожидаемо устарел (`516|1002|527|716`). Результат `mismatch`, `comparable=true`, `planErrors=0`, всего `233` differences; первые `100` ограничены контрактом, поэтому полный parity не заявлен. Root-only отчёт `/root/b24-app-audits/20260821-124338-supply-shadow-report.json` имеет mode `0600` и SHA-256 `6109cf4c0cee74107a4c575c7392ca0fca6a4acbe32f285adc0e555ac7167f9a`. Canary и временный env удалены. Повторный post-check подтвердил прежний SQL counts/hash, internal/public health, readiness, официальный ERP read, network/mount/port и restart `0`; DML, migration и source switch не выполнялись. Детали и следующий gate записаны в [`sql-supply-shadow-read-2026-08-21.md`](sql-supply-shadow-read-2026-08-21.md).

Перед refresh mirror safety job добавил двенадцатый dump `20260821_124850-b24_app-database.sql.gz`; при лимите `14` retention не сработал ни локально, ни на Bitrix Disk. Checksum/gzip, внешний read-back и сохранность старейшего локального dump подтверждены; Disk IDs `103948/103946`. Новый owner dry-run повторил hash `22ad151b5f2881b525d84c687583bcd23948dbc18f66219734f8091abda0f831`, sources `425|119|5`, rows `552|1064|563|753`, `0` errors, `22` warnings и `readyToApply=true`. После него SQL остался `516|1002|527|716|1|5` с прежним hash, health/readiness зелёные. Это только safety/pre-DML gate; mirror apply не выполнялся.

После отдельного разрешения one-shot DML-only runner применил точный plan `22ad…f831` одной транзакцией; повтор того же in-memory plan был no-op. SQL теперь `552|1064|563|753|2|5`, latest sources `425|119|5`, warnings `22`, orphan counts `0|0|0`, lock свободен. Два ранних runner-прохода безопасно остановились до writer на несовместимых диагностических запросах (`current_user` alias и отсутствующая `ROUTINE_PRIVILEGES`); counts/hash оставались прежними. Успешный runner вывел полный success JSON, а внешний shell code `1` возник только из-за проверки env до `EXIT trap`; env и `--rm` container независимо подтверждены отсутствующими, apply не повторялся. Post-apply dump `20260821_125943-b24_app-database.sql.gz` (`173731` bytes) прошёл checksum/gzip и Disk read-back, IDs `103952/103950`. Restore `b24_app_restore_20260821_125943` совпал с source по структуре, counts/latest hash и checksums всех таблиц и сохранён до cleanup. Повторный shadow compare дал точный `match`, `0` differences/errors; root-only audit `/root/b24-app-audits/20260821-130225-supply-shadow-report-match.json`, SHA-256 `8755697d248189ebb4242307c0dd8fcaa4ee6200a73647faf2411427b2f01381`. Before/after focused tests `56/56`; production `ef4fecb`, restart `0`, network/mount/port, internal/public health, readiness и ERP read зелёные, shadow flag `off`, source switch не выполнялся.

2 сентября после отдельного разрешения commit `ecc37d4` развёрнут как
`b24-app:ecc37d4`; rollback `b24-backend-prev-before-ecc37d4` сохранён.
Migration `0022` добавила полные canonical transfer payloads и повторно прошла
как no-op. Свежий owner plan
`e306a97fcc490e3c28d34690e502d5a30ad1506e27f5386d56a6e63fb1dc10a6`
применён one-shot DML-only user: sources `665|182|14`, latest rows
`862|1582|890|1188|182`, `0` errors, `22` warnings, orphan counts `0|0|0|0`.
Runtime full compare и request shadow resolver дали `match`; рабочий ответ всё
ещё `legacy`, так как `B24_APP_SUPPLY_SQL_READ=shadow`. Pre/post backups
`20260902_130703` и `20260902_131829` прошли checksum, внешний read-back и
полный restore hash parity; retention не запускался, backup/rollback сохранены.
Финально подтверждены internal/public health, readiness database/reservations,
официальный ERP read, `/srv/b24-state`, `127.0.0.1:3000`, `unless-stopped`,
restart `0`, runtime `SELECT` only и `erpnext_frappe_network`. Подробный журнал и
следующий gate: [`sql-supply-verified-read-foundation-2026-09-02.md`](sql-supply-verified-read-foundation-2026-09-02.md).

Позже 2 сентября первый gate переключения на `verified` обнаружил `42` свежих
differences и остановился без switch. После backup/restore mirror обновлён
guarded plan `8f8af8fe66fc6895137607ddbb9a2385421d987b7374b2226adb80a2a4a8fb56`:
sources `669|183|14`, latest rows `867|1594|893|1191|183`, `0` errors,
`22` warnings. Config-only switch того же `b24-app:ecc37d4` сохранил shadow как
`b24-backend-prev-before-verified-20260902-1340` и включил
`B24_APP_SUPPLY_SQL_READ=verified`. Реальные shadow/verified
`/api/supply/orders` вернули по `99` orders и одинаковый canonical hash
`1a0a57a59916e44f5a33aadd9ebac36302dfdf35c4e2dd5a2c43322000fdcd7f`;
логи подтвердили соответственно `responseSource=legacy` и `sql`. Финально
restart `0`, internal/public health, readiness, ERP read, runtime `SELECT`,
network/state/port зелёные, fallback/error `0`. Backups `20260902_133752` и
`20260902_134425` прошли внешний read-back и restore parity без retention;
rollback и backups сохранены. Независимый SQL source switch и write-path
миграция ещё не выполнялись.

### Автоматическая проекция остатков Tilda — включена 2026-08-21

Локальный кандидат запускает ровно один reconciliation cycle и не встроен в
startup/HTTP backend. Он требует `TILDA_STOCK_SYNC=on`, отдельный
`b24_app_tilda_sync` credential и migration `0007`. Скрипт
`scripts/tilda-stock-sync-job.sh` также ничего не планирует сам: cron появляется
только отдельным изменением на production. Backend container ради worker не
нужно заменять — один и тот же version-pinned image можно сначала проверить как
one-shot, оставив рабочий `b24-backend` без restart.

Порядок первой активации:

1. Зафиксировать baseline: полный backend test/typecheck/build, текущий public
   parity, health/readiness, официальный ERP read, network и restart count.
2. Запустить фактический `b24_app` backup job и проверить checksum, gzip и
   внешний Disk read-back.
3. Применить только `0007_create_tilda_stock_sync_runs.sql` существующим ручным
   migration runner. Не добавлять migration credential в постоянный backend.
4. Повторить backup и изолированный restore drill, включая migration hash,
   структуру `tilda_stock_sync_runs`, 177 mappings и checksum domain tables.
5. Создать отдельного пользователя. Выдать только `SELECT` на
   `tilda_product_mappings` и `SELECT, INSERT, UPDATE` на
   `tilda_stock_sync_runs`; проверить отсутствие global grants, workflow DML,
   DDL и `DELETE`.
6. Создать root-owned mode `0600` env-файл по фактическим значениям production.
   Он содержит DB host/port/name/mode, имя runtime user только для проверки
   разделения ролей, отдельные Tilda DB credentials, ERP API token, официальный
   public-catalog URL и CommerceML credentials. Runtime DB password, migrator,
   backfill и backup secrets worker не нужны.
7. Запустить version-pinned image вручную с `TILDA_SYNC_TRIGGER=manual` в
   `erpnext_frappe_network`. При текущем parity ожидается `no_op`: Tilda write не
   вызывается. Независимо подтвердить 132 совпадения, две точные unlimited строки,
   неизменный content hash и корректную audit row.
8. Только после отдельного разрешения установить wrapper root-owned с mode
   `0700` и добавить
   строку `*/2 * * * *` с фиксированным image tag и абсолютным env path. После
   первого запуска проверить cron log, SQL audit, public parity и отсутствие
   credential-bearing exited containers.

Для остановки удалить/закомментировать одну cron-строку; backend и ERPNext
продолжают работать без изменений. Host `flock` и MariaDB `GET_LOCK` не дают
проходам пересекаться. Ошибка чтения, изменение формы каталога или отсутствие
ERP Item завершают цикл до Tilda write. Ошибка после публикации запускает
проверяемый rollback. Таблицу аудита при оперативном откате не удалять.

Фактическая production-активация прошла все восемь ворот выше. До `0007`
создан и проверен backup
`/root/core-backups/b24_app/20260821_165454-b24_app-database.sql.gz`; после DDL —
`20260821_170009-b24_app-database.sql.gz`. Второй dump восстановлен в сохранённую
изолированную schema `b24_app_restore_20260821_170009`: совпали 8 таблиц,
100 колонок, 51 index row, 54 constraint, 31 CHECK, все table checksum,
7 migration rows, 177 mappings и workflow counts `552|1064|563|753|2`.
Migration `0007` применена one-shot runner с hash
`e779aca97b15a90286beca000b6c8ab1dac92fd72eba6aab6d1a2f0784258466`.

Отдельный `b24_app_tilda_sync` имеет только `SELECT` на mappings и
`SELECT,INSERT,UPDATE` на sync journal; `DELETE`, DDL и workflow DML отклонены.
Root-only env `/root/b24-app-secrets/tilda-sync.env` имеет mode `0600`, wrapper
`/root/sync/tilda-stock-sync-job.sh` — `0700` и SHA-256
`58c943f6d36702b2c678b97c5f9cad0069cd3d2c6a9e62485d47f9866cbeed09`.
Целевой Tilda-проект подтверждён как `Shelly Россия` (`projectid=5103503`);
проект `Просмарт` не использовался и не изменялся.

Ручной cycle из exact image `b24-app:faffa98` завершился `no_op`: 132 targets,
0 differences, 2 сохранённые unlimited строки, projection hash
`4889fd511f150c38441426704cf035d0263b85d22f63599663f0ee49aec82110`
и content hash
`9665ff7ff329cccd1553c9a6671596c4c6d79cbaba2d824963b8cc217325beea`.
Независимый postcheck повторил `131 parents / 150 stock rows / 0 differences`;
SQL journal содержит один успешный manual `no_op`, без `running`/`failed`.

Cron установлен одной строкой `*/2 * * * *` с фиксированным образом и env path;
предыдущий crontab сохранён в
`/root/sync/crontab.before-tilda-sync-20260821_173353`. Первый запуск самого
планировщика вернул `no_op`, `auditWritten=false`, доказав и исполнение, и
idempotent dedup. Финальный postcheck: рабочий backend не заменялся и остался
`b24-app:ef4fecb`, running, restart `0`, без Tilda credentials; internal/public
health, readiness `database: up`, официальный ERP read и
`erpnext_frappe_network` успешны. One-shot Tilda containers отсутствуют.

25 августа commit `05cdb20` перевёл только источник Tilda-проекции на активный
leaf warehouse `Shelly` и добавил DOM-only статусы `В наличии` / `Под заказ`.
Перед переключением clean image прошёл read-only preview: 134 confirmed, 16
skipped, 66 zero, 68 positive, total 1225, `sourceStore=Shelly`. Backend
`b24-app:a2ea255` был сохранён остановленным как
`b24-backend-prev-before-05cdb20`; новый `b24-app:05cdb20` прошёл canary,
internal/public health, readiness `database: up`, официальный ERP read,
`/srv/b24-state:/app/state`, `127.0.0.1:3000`, restart policy
`unless-stopped`, restart count `0` и `erpnext_frappe_network`.

На время Tilda gate одна cron-строка была удалена с root-only копией
`/root/b24-app-ops/crontab.before-tilda-secret-rotation.20260825T155210Z`.
Ручной guarded cycle обновил 19 из 132 обратимых остатков и завершился
`verified`; non-quantity content hash до и после остался
`9665ff7ff329cccd1553c9a6671596c4c6d79cbaba2d824963b8cc217325beea`.
Повторный ручной cycle вернул `no_op`. Cron затем восстановлен с exact image
`b24-app:05cdb20`; первый штатный запуск в 16:00 UTC также вернул `no_op` с
Shelly projection hash
`144cae376caa2b157b1db4d8359d4333d3279267aad62faefad84bb81d7bc5a6`.
SQL source switch, migration и warehouse-document writes не выполнялись.

Несколько операторских diagnostic-команд завершились до mutation из-за
несовместимого SQL alias/BigInt JSON, попытки прочитать Docker env-file как
shell-файл и двух ошибок quoting в read-only postcheck. После исправления те же
проверки прошли; migration, mapping counts, backend и каталог не менялись этими
неуспешными попытками.

### Текущее состояние `/app/state`

Read-only аудит 2026-08-20 подтвердил bind mount `/srv/b24-state:/app/state`, но не нашёл его копирования в `core-backup.sh`, отдельном cron или backup timer. Это отдельный существующий риск: договоры, contract sequences, шаблоны и operation log нельзя считать восстановимыми из описанного выше ERPNext backup. Исправление state backup не смешивать с SQL provision; провести отдельный restore drill и только после него обновить этот статус.

### Tilda: 12 новых товаров Shelly, 2026-09-03

После разрешённого CommerceML-импорта и распределения по существующим разделам
публичный каталог вырос с `131/150` до `143/162` parent/stock rows. Все 12
новых карточек имеют уникальные UID, SKU равен ERP Item code, внешний ID имеет
вид `b24-app-erp-<Item code>`. Commit `a146a81` добавил отдельный versioned
mapping seed и one-shot backfill. Ограниченный `b24_app_backfill` с
`SELECT/INSERT/UPDATE` одной транзакцией добавил 12 confirmed mappings; SQL
counts стали `189 total / 146 confirmed / 43 ignored / 0 unresolved`.

Safety backup
`/root/core-backups/b24_app/20260903_085125-b24_app-database.sql.gz`
(`516414` bytes, 25 table definitions) прошёл checksum, внешний Disk read-back
и восстановление в сохранённую отдельную schema
`b24_app_restore_20260903_085125`. При первом запуске старый production Disk
uploader проигнорировал `B24_APP_BACKUP_RETENTION=off` и удалил три старейшие
внешние пары `20260901_164520`, `20260901_163547`, `20260901_144157`. Все три
локальные пары оставались целыми и прошли checksum; после установки актуального
uploader они возвращены на Disk с `retention skipped` и повторным read-back.
Standalone backup job также обновлён: при `retention=off` теперь не запускается
ни локальная, ни внешняя ротация.

Read-only preparation подтвердила новую форму `162 mappings / 146 offers / 16
skipped / 143 parents / 162 stock rows / 144 reversible / 2 unlimited`; цены
совпадали, отличались четыре количества. Ручной guarded cycle обновил ровно эти
четыре количества и завершился `verified` с неизменным protected content hash
`09d0228697f8491569e395ec56d0053ddf047cd8be56703ee49bdc0ca97251e2`.
Cron восстановлен одной строкой `*/2` с image `b24-app:a146a81`; первый
scheduled cycle вернул `no_op`, 144 stock targets и 136 price targets. Backup
предыдущего crontab:
`/root/b24-app-ops/crontab.before-enable-tilda-a146a81-20260903`.

### SQL shadow-write инвентаризаций, 2026-09-05

Перед включением выполнен backup
`20260905_045636-b24_app-database.sql.gz` (`5,447,652` bytes, `51` tables),
внешний read-back (`dump_id=107816`, `checksum_id=107814`) и сохранённый restore
`b24_app_restore_20260905_045636`. Все `51` table checksums совпали. Отдельный
`b24_app_inventory_runtime` получил только точечные `SELECT/INSERT/UPDATE` на
семь рабочих таблиц инвентаризации, без `DELETE`, DDL, schema privileges и
доступа к checkpoint; root-only secret files имеют mode `0600`.

Commit `aeeaebf` развёрнут как `b24-app:aeeaebf` с
`B24_APP_INVENTORY_SQL_WRITE=shadow`. Canary и production подтвердили internal
и public health/readiness, `inventorySqlWriter=up`, официальный ERP read,
`erpnext_frappe_network`, `/srv/b24-state:/app/state`, локальный порт, policy
`unless-stopped` и restart `0`. Rollback
`b24-backend-prev-before-aeeaebf` сохраняет `b24-app:b755998`.

После отдельного явного разрешения owner OAuth vault штатно ротирован без
вывода токенов; envelope остался root-owned mode `0600`. Полная read-only
сверка Bitrix и SQL подтвердила неизменный plan hash
`10b4a9826eba4e165167f377842fd5fd969d49242279c366738b7a302c3d5e06`, точное
совпадение `10` inventories / `10` points / `606` sections / `2,507` snapshots /
`1,682` counts / `370` results / `7` ERP docs и `0` differences. Ошибок
inventory shadow-write нет. Bitrix остаётся источником правды; SQL reads,
primary mode и новый backfill не включались.

SQL-first запись инвентаризаций включается только отдельным производственным
шагом после миграций `0072`-`0074`, свежего backup/restore drill и выдачи
существующему `b24_app_inventory_runtime` точечных `SELECT/INSERT/UPDATE` на
`inventory_public_ids`, `inventory_mutations`, `inventory_commands` и
`inventory_bitrix_outbox`. Сначала подтверждается повторная полная parity
текущих Bitrix/SQL записей и отсутствие неназначенных `public_id`; затем один
deploy меняет только `B24_APP_INVENTORY_SQL_WRITE=primary`, сохраняя
`B24_APP_INVENTORY_SQL_READ=primary`. После переключения проверяются internal и
public health, readiness, официальный ERP read, сеть `erpnext_frappe_network`,
создание одной тестовой ревизии, повтор того же idempotency key, её SQL-чтение и
доставка Bitrix-зеркала. Любая ошибка до переключения оставляет `shadow`; после
переключения rollback возвращает предыдущий контейнер и `WRITE=shadow`, не
удаляя SQL-команды, мутации, outbox, backup или restore-schema.

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
