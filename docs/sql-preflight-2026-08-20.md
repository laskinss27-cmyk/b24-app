# Read-only preflight `b24_app` — 2026-08-20

## Scope

Проверка выполнена без SQL-аутентификации, без изменения контейнеров, cron, env, файлов, БД или пользователей. Production-записи не выполнялись. Локальный baseline перед проверкой: 184/184 backend-теста и полный typecheck.

## Provision result

После отдельного разрешения пользователя 2026-08-20 в 08:08 UTC выполнен одноразовый bootstrap через существующий MariaDB root внутри `erpnext-db-1`. Root credential не выводился, не копировался из контейнера и не сохранялся в новых файлах.

Созданы:

- пустая schema `b24_app`, `utf8mb4` / `utf8mb4_unicode_ci`;
- `b24_app_runtime@%`: только `SELECT` на `b24_app.*`;
- `b24_app_migrator@%`: DML и ограниченные schema DDL только на `b24_app.*`;
- `b24_app_backup@%`: `SELECT`, `SHOW VIEW`, `TRIGGER` только на `b24_app.*`.

Все три роли прошли отдельный login через alias `db`; после provision в schema ноль таблиц. Случайные credentials находятся только в `/root/b24-app-secrets`: каталог `root:root` mode `700`, файлы mode `600`. Backend остался на image `b24-app:aabda51`, не получил `B24_APP_DB_*`, не перезапускался и не подключался к schema. Internal/public health и ERPNext GET после provision успешны.

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

### A. Provision пустой базы и ролей — выполнено

1. DBA интерактивно проверяет отсутствие конфликтующих schema/users.
2. Создаёт пустую `b24_app` и отдельные `runtime`, `migrator`, `backup` credentials по [sql-migration.md](sql-migration.md).
3. Runtime получает только `SELECT`; DML не выдаётся до отдельного writer-этапа.
4. Секреты сохраняются в root-only files; migration secret не попадает в постоянный env backend.

Production SQL metadata write выполнен по явному разрешению. Rollback на этом шаге — не использовать созданные объекты и сохранить их для расследования; `DROP DATABASE/USER` не входит в автоматический rollback и требует отдельного destructive approval.

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

## Follow-up: deploy выключенного SQL-каркаса

После отдельного разрешения пользователя 2026-08-20 развёрнут image `b24-app:596bddb` с revision `596bddb06cf853a0a8816281bb2468ccdf9b3cfd`. Предыдущий production-контейнер `b24-app:aabda51` сохранён остановленным под именем `b24-backend-prev-before-596bddb`.

Перед запуском из снимка рабочего окружения удалены все переменные `B24_APP_DB_*`, затем явно добавлена только `B24_APP_DB_MODE=off`. SQL credentials новому контейнеру не передавались. Миграции, backfill, shadow reads/writes и переключение источников не запускались; рабочее поведение продолжает использовать Bitrix24 и официальный ERPNext API.

После переключения и отдельной повторной проверкой подтверждены:

- internal и public `/health` — HTTP 200;
- `/ready` — HTTP 200, `database.status=disabled`;
- авторизованный read-only ERPNext `Company` — одна строка;
- image `b24-app:596bddb`, `restart_count=0`, restart policy `unless-stopped`;
- сеть `erpnext_frappe_network`, порт `127.0.0.1:3000`, bind mount `/srv/b24-state:/app/state` read-write;
- ровно одна переменная `B24_APP_DB_*`: `B24_APP_DB_MODE=off`;
- rollback-контейнер существует, остановлен и сохраняет image `b24-app:aabda51`.

Два первых внутренних HTTP-запроса во время старта получили connection reset и были успешно повторены встроенным retry. После стабилизации независимые health-проверки прошли с первого запроса. Это ожидаемое короткое окно замены контейнера, а не обнаруженная ошибка приложения.

### Посторонние предупреждения, не исправленные в этом этапе

- production image использует Node.js `20.20.2`, а установленный `undici@8.4.1` декларирует engine `>=22.19.0`;
- `npm ci` сообщил о четырёх известных уязвимостях зависимостей: две moderate и две high;
- Vite повторил существующее предупреждение о frontend chunk около 970 kB после minification;
- локальный npm предупреждает, что форма флага `-ws` будет удалена в будущем;
- локальный Git повторяет существующие environment-предупреждения о недоступном global ignore и преобразовании LF/CRLF.

Эти пункты не проявились как ошибки тестов или production health-check, но требуют отдельных change sets со своими baseline и rollback; обновление Node/dependencies или разбиение frontend bundle с SQL rollout не совмещать.

## Follow-up: первая metadata migration

После отдельного разрешения пользователя 2026-08-20 в 11:16:38 UTC запущен одноразовый контейнер `b24-app:596bddb` с отдельным root-only `migrator.env`. Перед запуском подтверждены 0 таблиц, валидный checksum последнего пустого dump `20260820_102633-b24_app-database.sql.gz`, отсутствие backup-процессов, 0 доменных `.sql` в image и успешные health/ERP checks.

Runner сообщил `No pending migrations`: доменных файлов нет. Его обязательный metadata bootstrap изменил число таблиц с 0 на 1. После запуска в schema существует только `b24_app_schema_migrations`, в ней 0 строк. Одноразовый контейнер удалён.

Production backend не перезапускался: image `b24-app:596bddb`, `restart_count=0`, единственная SQL-переменная `B24_APP_DB_MODE=off`, `/ready` сообщает `database: disabled`. Internal/public health, ERPNext read, network membership и rollback-контейнер после DDL подтверждены повторно. Локальный baseline после этапа: backend 184/184, frontend 117/117 и полный typecheck.

Rollback этого шага намеренно не выполняет автоматический `DROP TABLE`: текущий безопасный rollback — оставить metadata неиспользуемой при `MODE=off`. Перед readiness нужен свежий backup и отдельный restore drill дампа с одной metadata-таблицей.

## Follow-up: metadata backup и restore drill

После отдельного разрешения пользователя 2026-08-20 полный `/root/sync/b24-app-backup-job.sh` создал `20260820_112406-b24_app-database.sql.gz` размером 924 bytes. Dump содержит ровно одну `b24_app_schema_migrations` и 0 data rows. Локальные gzip/checksum прошли; внешний upload и обратная SHA-проверка Bitrix Disk подтверждены для dump ID `103522` и checksum ID `103520`. Локальных scheduled-пар после job — 4, поэтому retention ничего не удалял.

Dump восстановлен только в `b24_app_restore_20260820_112406`. Встроенная и независимая проверки подтвердили одну metadata-таблицу с 0 строк, `utf8mb4/utf8mb4_unicode_ci`, совпадающие сигнатуры колонок и индексов и неизменную рабочую `b24_app` 1/0. Backend временную schema не использовал. После явного разрешения guarded cleanup удалил только временную schema; финальное число `b24_app_restore_%` равно 0.

После cleanup MariaDB healthy, cron active, backup-процессов нет, backend остаётся `b24-app:596bddb` с `B24_APP_DB_MODE=off`, `restart_count=0`, internal/public health, disabled readiness, ERP read и network check успешны. После этапа повторно прошли backend 184/184, frontend 117/117 и полный typecheck. Новых посторонних ошибок не найдено; прежние build/npm/Git warnings не исправлялись.

На момент этого follow-up metadata-only backup/restore gate был закрыт для следующего read-only readiness шага; его фактический rollout записан ниже. Gate для авторитетных данных остаётся открытым до появления доменных migrations, повторного dump/restore с row/link checks, измеренных RPO/RTO и проверки retention deletion branch.

## Follow-up: runtime readiness rollout

После отдельного разрешения пользователя 2026-08-20 в 11:33:35 UTC тот же image `b24-app:596bddb` пересоздан с `B24_APP_DB_MODE=readiness`. Перед переключением runtime login и grants проверены без вывода секрета: только `USAGE + SELECT`, DML/DDL отсутствуют. Новый env содержит ровно восемь разрешённых runtime `B24_APP_DB_*` ключей и не содержит `B24_APP_MIGRATION_DB_*`.

После config-only switch internal/public `/health` и `/ready` успешны; readiness возвращает `database.status=up`. Авторизованный ERPNext read, `erpnext_frappe_network`, порт `127.0.0.1:3000`, `/srv/b24-state:/app/state`, restart policy и `restart_count=0` подтверждены независимо. Schema не изменилась: одна `b24_app_schema_migrations`, 0 rows. Workflow SQL reads/writes, backfill, shadow reads и автоматические migrations не включались.

Предыдущий backend с `B24_APP_DB_MODE=off` сохранён остановленным как `b24-backend-prev-before-readiness-20260820-1131`; rollback `b24-app:aabda51` также сохранён. После этапа повторно прошли backend 184/184, frontend 117/117 и полный typecheck. При старте один внутренний health-запрос получил connection reset и успешно прошёл встроенный retry; после стабилизации повторные checks успешны с первого раза.

Отдельно обнаружен существующий housekeeping-долг: на host накоплено много старых остановленных `b24-backend-prev-*`/canary/failed контейнеров. Они не влияли на readiness rollout и не удалялись; инвентаризацию retention/rollback containers проводить отдельным этапом с точным списком сохраняемых образов.

## Follow-up: read-only аудит домена снаба

Перед проектированием первой доменной migration повторно прошли backend 184/184, frontend 117/117 и полный typecheck. Runtime-код не менялся.

Production UI через уже авторизованную сессию показал 54 заявки, 89 перемещений, 78 заказов поставщикам и 54 вложенные приёмки. Максимальные кардинальности: 7 перемещений, 9 закупок и 13 transfer/purchase документов на одну заявку. 30 заявок одновременно имеют закупки и перемещения. UI-карточки только открывались для обезличенного подсчёта и после аудита возвращены в свёрнутое состояние.

Существующий catalog webhook получил 403 на `entity.item.get` для `ctv_transfers`. Ошибка чтения не трактовалась как пустой список; webhook permissions не расширялись, token не создавался. Bitrix raw JSON и `ctv_tr_requests` оставлены для отдельного authenticated read-only аудита.

После завершения штатного 12:00 UTC backup одноразовый контейнер, не получавший Bitrix/SQL credentials, выполнил только GET через официальный ERPNext API. Загружены 54 MR / 219 строк, 81 PO / 156 строк, 55 связанных PR / 98 строк и 185 связанных Stock Entry / 307 строк. У всех 780 ERP child rows есть row `name`, повторов SKU внутри документа нет, все PO rows имеют `b24_request_qty`. Native ERP line links MR→PO→PR→Stock Entry во всех проверенных строках отсутствуют, поэтому будущий backfill обязан маркировать восстановленные по SKU/qty allocations как derived, а не исходные жёсткие связи.

Отдельно записаны, но не исправлялись: 3 PO custom links не разрешаются в текущий MR-набор, одна cancelled PR имеет несовпадающий request key, 43 Stock Entry не ссылаются на текущую MR и ещё 3 имеют несовпадающий key. Часть Stock Entry может быть самостоятельными перемещениями, поэтому без Bitrix cross-check эти строки не объявлены порчей данных.

Audit container и root-only temporary env удалились автоматически; два staging scripts после проверки удалены явно. Backend остался `running`, `restart_count=0`, MariaDB healthy, internal `/health` и `/ready` успешны, membership в `erpnext_frappe_network` сохранён. Первый post-check ошибочно использовал host mapping port 3000 изнутри контейнера и получил `ECONNREFUSED`; повтор на фактическом container port 8080 прошёл. Это операторская диагностическая ошибка, а не runtime incident.

Вывод и точная схема-кандидат вынесены в [sql-supply-domain-audit-2026-08-20.md](sql-supply-domain-audit-2026-08-20.md). Доменных таблиц, SQL backfill, shadow reads, workflow DML, deploy и source switch не было. После документационных изменений тот же baseline повторён: backend 184/184, frontend 117/117, полный typecheck успешен.

## Follow-up: локальный supply DDL change set

Перед изменением снова зафиксирован отдельный baseline: backend 184/184, frontend 117/117, полный typecheck успешен. Существующий runner не изменялся: его контракт требует один MariaDB statement на файл.

Локально добавлены четыре последовательных файла `0001_create_workflow_documents.sql` — `0004_create_workflow_line_allocations.sql`. Они создают только identity/graph mirror: внешние документы и revision key, строки с раздельными source/target warehouses, типизированные document links и количественные line allocations с evidence source. Произвольного JSON payload, events, sync jobs, comments writer или DML нет. FK используют `ON DELETE RESTRICT`; raw внешний статус не ограничивается enum/check, внутренние типы ограничены.

Contract tests подтверждают порядок/checksum, ровно один statement на файл, отсутствие DML/`DROP`/`ALTER`/`TRUNCATE`/JSON, ожидаемые unique keys, line identity, relation/allocation types, evidence classification и ограничения имён MariaDB. Узкий migration test: 4/4, backend typecheck успешен.

Общий `.gitignore` исключал все `*.sql`; добавлено узкое исключение только для `packages/backend/migrations/*.sql`. Dump/backup и SQL вне migration-каталога по-прежнему игнорируются.

Локальный MariaDB server/image в рабочем окружении недоступен, поэтому фактический server parse/apply здесь не имитировался. Это не обходится production-записью: перед реальным применением нужен отдельный разрешённый preflight, fresh safety dump и проверка отсутствия четырёх target tables. После manual runner обязательна независимая сверка columns/indexes/FK/CHECK при 0 domain rows, затем новый dump и isolated restore drill. Production по-прежнему содержит только metadata table с 0 migration rows.

После change set полный baseline повторён: backend 186/186 (добавлены только 2 migration contract tests), frontend 117/117, полный typecheck успешен.

## Follow-up: изолированная MariaDB DDL rehearsal

Перед rehearsal production preflight повторно подтвердил: backend `b24-app:596bddb` работает в `B24_APP_DB_MODE=readiness`, `restart_count=0`, migration credentials в runtime env отсутствуют, `erpnext_frappe_network` и `/srv/b24-state:/app/state` сохранены. Рабочая `b24_app` содержит только `b24_app_schema_migrations` с 0 строк; все четыре target tables отсутствуют. Internal/public health и readiness, ERPNext API read, MariaDB health, cron и последний checksum прошли.

Свежий safety job создал `20260820_122411-b24_app-database.sql.gz` размером 924 bytes с одной metadata table и 0 rows. Gzip/checksum и внешний Bitrix Disk read-back успешны; upload IDs: dump `103574`, checksum `103572`. Schema и backend этим job не менялись.

Четыре локальных DDL-файла затем проверены не в рабочей MariaDB, а в отдельном Docker network без published ports и без подключения к `erpnext_frappe_network`. Первый диагностический прогон выявил ошибку именно в rehearsal setup: автоматически созданная MariaDB database наследовала новый default `utf8mb4_uca1400_ai_ci`, поэтому metadata bootstrap получил эту collation, тогда как четыре доменные таблицы явно получили ожидаемую `utf8mb4_unicode_ci`. Production `b24_app` изначально provisioned явно как `utf8mb4/utf8mb4_unicode_ci` и не имеет этого расхождения. Ошибка не скрывалась: первый volume сохранён, MariaDB остановлена, рабочая schema повторно проверена как 1/0/0.

Чистый второй прогон использовал новый isolated volume и явный server default `utf8mb4_unicode_ci`; SQL-файлы и checksums не менялись. Реальный runner применил `0001`-`0004`, повторный запуск вернул `No pending migrations`. Независимая сверка дала 5 tables, 4 migration rows, 54 columns, 5 foreign keys, 20 CHECK constraints, 21 indexes и 5/5 InnoDB tables с `utf8mb4_unicode_ci`. Positive test сохранил две строки одного документа с одинаковым SKU и разными line identity/warehouses. Negative tests отклонили duplicate external identity, invalid document type, missing document FK, self document link, zero allocation и удаление связанного документа.

Обе rehearsal MariaDB были остановлены. После отдельного разрешения guarded cleanup удалил только два точно проверенных набора `20260820_1230` и `20260820_1231`: шесть stopped containers, два isolated volumes, две internal networks с 0 endpoints и два root-only staging directories. Независимый post-check подтвердил отсутствие всех целей cleanup, production backend `running`/`restart_count=0`, сеть `erpnext_frappe_network` и неизменную рабочую schema 1 metadata table / 0 migration rows / 0 target tables. Internal/public health и readiness, ERPNext API read и MariaDB health также прошли.

Локальный post-baseline после документации: backend 186/186, frontend 117/117, полный typecheck успешен. Прежнее npm warning о deprecated single-hyphen `-ws` не исправлялось. При передаче двух временных Bash-скриптов PowerShell добавил одиночный CR после уже завершённых проверок; это зафиксировано как операторский диагностический артефакт, runtime и результаты guard-проверок не затронуты. Ни один production migration, domain table, backfill, shadow read/write, deploy или source switch не выполнялся.
