# Read-only preflight `b24_app` — 2026-08-20

## Scope

Проверка выполнена без SQL-аутентификации, без изменения контейнеров, cron, env, файлов, БД или пользователей. Production-записи не выполнялись. Локальный baseline перед проверкой: 184/184 backend-теста и полный typecheck.

## Подтверждённые production-факты

| Проверка | Результат |
|---|---|
| backend | `b24-app:aabda51`, работает в `erpnext_frappe_network` |
| backend state | bind mount `/srv/b24-state` -> `/app/state` |
| MariaDB | контейнер `erpnext-db-1`, image `mariadb:11.8`, healthy |
| MariaDB DNS | network alias `db`, из backend резолвится в закрытый адрес Docker network |
| MariaDB порт | `3306/tcp` не опубликован на host |
| MariaDB TCP | соединение `b24-backend -> db:3306` устанавливается |
| SQL env backend | переменных `B24_APP_DB_*` нет; текущий runtime не подключён к SQL |
| internal health | `GET http://127.0.0.1:3000/health` — `ok: true` |
| public health | HTTP 200 |
| ERPNext read | авторизованный read-only `Company`, HTTP 200, одна строка |
| cron | `0 12 * * * /usr/bin/bash /root/sync/core-backup.sh` |
| host timezone | сервер возвращает UTC; cron 12:00 UTC = 15:00 Europe/Moscow на дату проверки |
| ERPNext DB backups | 14 локальных копий, последняя ожидаемо от 2026-08-19 до сегодняшнего cron |
| ERPNext files | weekly, локально 4 public и 2 private archives на дату проверки |
| external copy | последние DB backups отмечены в логе как успешно загруженные на Bitrix24 Disk |
| dump tooling | на host `mariadb-dump` отсутствует; в image/container MariaDB есть `mariadb-dump 11.8.8` |

Наличие или отсутствие уже созданной схемы `b24_app` не проверялось SQL-запросом: preflight намеренно не использовал MariaDB root или существующие ERPNext credentials.

## Отдельно найденный существующий риск

`/srv/b24-state` занимает около 2.8 MB и содержит 14 файлов, включая договоры/metadata, `contract-sequences.json`, operation log и manual recovery data. Текущий `/root/sync/core-backup.sh` этот каталог не копирует; отдельного state backup в проверенных `/root/core-backups`, `/root/sync`, cron и systemd timers не найдено.

Это не ошибка SQL-каркаса и не исправляется в данном этапе. Нужна самостоятельная согласованная задача с собственным baseline, шифрованием/retention, restore drill и проверкой договоров. До её выполнения нельзя описывать весь `/app/state` как резервируемый текущим core backup.

Права на проверенные пути не раскрывают секреты непривилегированному пользователю: `/root` и `/srv/b24-state` имеют mode `700`, `/root/sync/.env` — `600`. Владельцы файлов `/root/sync` имеют numeric UID/GID 1000, которые на host не сопоставлены имени; это операционная особенность, а не основание менять ownership без отдельной проверки.

## Предлагаемый следующий production change set

Ни один пункт ниже ещё не выполнялся. Каждый approval gate отдельный.

### A. Provision пустой базы и ролей

1. DBA интерактивно проверяет отсутствие конфликтующих schema/users.
2. Создаёт пустую `b24_app` и отдельные `runtime`, `migrator`, `backup` credentials по [sql-migration.md](sql-migration.md).
3. Runtime получает только `SELECT`; DML не выдаётся до отдельного writer-этапа.
4. Секреты сохраняются в root-only files; migration secret не попадает в постоянный env backend.

Это production SQL metadata write и требует явного разрешения. Rollback на этом шаге — перестать использовать созданные объекты и сохранить их для расследования; `DROP DATABASE/USER` не входит в автоматический rollback и требует отдельного destructive approval.

### B. Metadata migration без deploy

После commit/push/build разрешённого образа запустить его как одноразовый контейнер в `erpnext_frappe_network` только с migration credentials. Команда создаёт лишь `b24_app_schema_migrations`; backend-контейнер и текущие маршруты не меняются. Затем проверить таблицу read-only запросом migrator user.

### C. Отдельный backup и restore drill

Host client не устанавливать. Использовать уже локальный `mariadb:11.8` как ephemeral client в `erpnext_frappe_network`, с read-only bind mount option file ограниченного backup user. Dump идёт через stdout в temporary host file, затем `gzip -t`, checksum и atomic rename.

После ручного успешного dump DBA создаёт отдельно названную restore-check schema, dump импортируется ограниченным restore credential, проверяются migration checksum/counts, затем temporary schema сохраняется до фиксации результата. Её удаление — отдельное destructive действие.

Изменение `/root/sync/core-backup.sh` выполняется только после root-owned rollback copy и shell syntax check. Ручной тест не совмещается с ежедневным cron. Существующий ERPNext backup и его Bitrix Disk upload проверяются после изменения отдельно от `b24_app` dump.

### D. Readiness rollout

Только после A-C: commit/push/build/deploy по основному runbook, прежний container сохранить. Новый backend остаётся в `erpnext_frappe_network`, получает `B24_APP_DB_MODE=readiness`, runtime credential и `B24_APP_DB_HOST=db`. Проверки: internal/public `/health`, `/ready`, ERPNext GET и `docker inspect` network membership.

Rollback: вернуть сохранённый container или mode `off`. База и users при rollback не удаляются. Чтения и записи workflow всё ещё остаются Bitrix24/ERPNext.

## Влияние на менеджеров

A-C не требуют остановки менеджеров: они не меняют рабочие источники приложения. Их следует выполнять вне ежедневного backup и наблюдать MariaDB resources. D — обычный backend deployment с коротким окном замены контейнера и полным rollback; его время согласуется отдельно. Переключение workflow reads/writes в этот change set не входит.
