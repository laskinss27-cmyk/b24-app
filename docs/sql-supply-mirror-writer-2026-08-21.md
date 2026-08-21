# Локальный supply mirror writer — 2026-08-21

## Граница этапа

Изначально был подготовлен только локальный атомарный writer для уже существующего read-only supply plan. В этом change set migration `0005` не применялась, SQL domain rows не записывались, backend не разворачивался, workflow по-прежнему использует Bitrix24 и официальный ERPNext API. Последующее отдельное создание production backfill credential зафиксировано ниже.

## Контракт writer

- план принимается только при `readyToApply=true`, отсутствии errors и полноте всех трёх источников;
- весь граф документов, строк, links и allocations записывается одной транзакцией;
- MariaDB named lock исключает параллельные mirror apply;
- `INSERT ... ON DUPLICATE KEY UPDATE` сохраняет внешние identities и обновляет только наблюдаемые поля;
- checkpoint `supply_mirror_checkpoints` уникален по бинарному SHA-256 plan hash;
- повтор уже применённого hash не выполняет row DML;
- ошибка любой строки откатывает документы, строки, связи, allocations и checkpoint целиком;
- writer не выполняет `DELETE`: строки старого snapshot сохраняются как история, а текущий срез определяется `observed_at` последнего checkpoint;
- writer не запускается при старте backend и не подключён к HTTP route.

Отдельная функция конфигурации требует `B24_APP_BACKFILL_DB_USER/PASSWORD`, запрещает совпадение имени с runtime/migration user и не меняет постоянный runtime pool. Права one-shot пользователя: только `SELECT`, `INSERT`, `UPDATE` на `b24_app`; DDL и `DELETE` запрещены.

## Migration `0005`

Append-only one-statement migration создаёт только `supply_mirror_checkpoints`: plan hash, source cardinalities, row counts, warning count, observed/applied timestamps. JSON, scheduler, payload storage и source switch не добавляются. После отдельных разрешений production содержит применённые `0001`-`0005`, 5 migration rows и первый неавторитетный supply mirror; точные counts приведены ниже.

## Проверки до и после

До изменения focused baseline `config + migrations + supply planner/snapshot` прошёл `36/36`.

После изменения:

- тот же набор и новые writer/config tests: `41/41`;
- полный backend: `220/220`;
- backend и общий workspace typecheck: успешно;
- `git diff --check`: успешно;
- изолированный MariaDB `11.8.8` tmpfs rehearsal: `0001`-`0005` применились, второй migration runner был no-op, первый mirror apply создал ожидаемые `2/2/1/1` graph rows и один checkpoint, повтор hash был no-op, изменённый plan обновил существующие identities и добавил второй checkpoint, искусственная row error откатила весь проход, DDL для backfill user получил отказ;
- временные schema, user и Docker container удалены; volume не создавался.

## Постороннее наблюдение

Первая локальная попытка MariaDB rehearsal не завершила первичную инициализацию за 45 секунд на Windows Docker storage. Контейнер был удалён без запуска теста. Повтор на временном `tmpfs` с тем же image `mariadb:11.8` завершился успешно. Это ограничение локальной среды не исправлялось в коде.

## Следующие отдельные gates

1. Проверить diff, создать commit и опубликовать его — выполнено: `d46475d` в `origin/main`.
2. До production DDL создать свежий safety backup, проверить checksum/external read-back и committed hash `0005` — выполнено отдельным preflight ниже.
3. Отдельно создать ограниченного production backfill user и независимо проверить grants — выполнено, см. ниже.
4. Применить только `0005`, повторить backup/restore drill уже с checkpoint table — выполнено, временная restore-схема сохранена до отдельного cleanup.
5. Только новым разрешением выполнить один полный mirror apply; после него сверить counts, hashes и выборочные graph chains, не переключая чтения — выполнено, см. ниже.
6. После нескольких успешных shadow comparisons отдельно проектировать SQL read path с Bitrix fallback.

## Production preflight перед `0005`

Commit `d46475d` опубликован в `origin/main`, но backend не развёртывался и остался на `b24-app:4579048`. Committed checksum `0005_create_supply_mirror_checkpoints.sql` — `885e8222db301725daf7fa3ef792ddbdc07328f0afaad5f1d6e6991e35a5fd97`; он совпадает с hash, прошедшим локальный MariaDB 11.8 rehearsal.

Один явно разрешённый safety job создал `/root/core-backups/b24_app/20260821_072214-b24_app-database.sql.gz` размером 2513 bytes. Локальные `gzip -t` и SHA-256 успешны; Bitrix Disk upload/read-back подтверждён для dump ID `103718` и checksum ID `103716`. Dump содержит ровно пять текущих table definitions, четыре migration metadata rows, не содержит `supply_mirror_checkpoints` и domain INSERT.

До и после backup production подтвердил `B24_APP_DB_MODE=readiness`, отсутствие migration/backfill credentials в runtime, internal/public health, readiness `up`, официальный ERPNext GET, image `b24-app:4579048`, restart count 0, migrations `0001`-`0004` и SQL domain rows `0|0|0|0`. Backup lock освобождён, временные diagnostic-файлы удалены. На момент этого preflight migration `0005`, backfill user, deploy, mirror apply и source switch не выполнялись.

## Production backfill credential

21 августа после отдельного разрешения создан `b24_app_backfill`@`%`. Случайный credential сохранён только в `/root/b24-app-secrets/backfill.env` и `backfill.cnf`; оба файла принадлежат `root:root` и имеют mode `600`. Постоянный env `b24-backend` не менялся и не содержит `B24_APP_BACKFILL_DB_*`.

Независимая проверка через отдельный `mariadb:11.8` container подтвердила login, текущую базу `b24_app`, пять доступных таблиц и четыре migration rows. Фактические `DELETE` и `CREATE TABLE` получили отказ; schema privileges вне `b24_app` равны нулю. До и после проверки counts были `0|0|0|0|4`, probe table отсутствует. Internal/public health, readiness `up`, официальный ERPNext GET, `erpnext_frappe_network`, image `b24-app:4579048`, running state и restart count 0 подтверждены после provision. Migration `0005`, deploy, mirror apply и source switch не выполнялись; временные operator scripts удалены.

Первая команда cleanup не выполнилась из-за ошибки кавычек PowerShell до исполнения удалённого shell body. Исправленная команда удалила четыре точных временных файла; production runtime и SQL-состояние этот операторский артефакт не затронул.

## Production migration `0005` и restore drill

Непосредственно перед DDL повторный preflight подтвердил safety dump `20260821_072214-b24_app-database.sql.gz`, свободные backup locks, 5 tables / 4 migrations, отсутствие checkpoint и domain rows `0|0|0|0`, `B24_APP_DB_MODE=readiness`, отсутствие migration/backfill credentials в backend env, internal/public health, readiness, ERPNext API и network.

One-shot image `b24-app:migrate-d46475d-0005` собран из clean archive commit `d46475d`; внутри независимо подтверждены ровно `0001`-`0005` и SHA-256 `0005` `885e8222db301725daf7fa3ef792ddbdc07328f0afaad5f1d6e6991e35a5fd97`. Container `b24-app-migrate-d46475d-0005` применил только `0005` и завершился `exit 0`. Production после DDL: 6 tables / 5 migrations, 12 checkpoint columns, 3 index rows, 2 CHECK, InnoDB `utf8mb4_unicode_ci`, checkpoint 0 и workflow rows `0|0|0|0`.

Полный job создал `/root/core-backups/b24_app/20260821_074553-b24_app-database.sql.gz`, 2782 bytes и 6 table definitions. Checksum/gzip, Bitrix Disk upload/read-back и marker успешны; IDs dump `103730`, checksum `103728`. Dump содержит checkpoint DDL и migration `0005`, но не содержит workflow/checkpoint INSERT.

Официальный restore drill восстановил dump только в `b24_app_restore_20260821_074553`, source остался на 6 tables. Независимые signatures production/restore совпали: `utf8mb4/utf8mb4_unicode_ci`, 6 tables, 66 columns, 37 index rows, 5 FK, 22 CHECK, 5 migration rows и counts `0|0|0|0|0`. Временная restore schema, exited runner и migration image намеренно сохранены до отдельного cleanup-разрешения. Staging scripts/archive удалены. Финальный post-check подтвердил backend `b24-app:4579048`, running, restart 0, network, health/readiness и ERP read. Deploy, mirror apply, shadow read и source switch не выполнялись.

После документации повторены полный backend test `220/220`, workspace typecheck и `git diff --check`; все успешны. Прежнее npm warning о deprecated single-hyphen `-ws` не исправлялось.

### Посторонние наблюдения этапа

- Первый Windows `git archive` преобразовал LF migration в CRLF. Archive checksum совпал с переданным файлом, но migration hash не совпал с committed `885e…`; fail-closed build остановился до image и DDL. Повторный archive с `core.autocrlf=false`/`core.eol=lf` побайтово совпал с Git blob.
- Первая LF-valid build-попытка не оставила image; повтор из того же проверенного archive успешно использовал Docker cache. В build output остались прежние предупреждения: `undici@8.4.1` требует Node `>=22.19.0` при image Node `20.20.2`, npm сообщил 2 moderate/2 high dependency vulnerabilities, Vite — chunk больше 500 kB. Они не исправлялись в SQL-этапе.
- После успешной сборки диагностический `find -printf` не поддерживался BusyBox. Точный hash уже прошёл, а список пяти migration files независимо подтверждён через `ls`; runner запускался только после этой проверки.
- Три вспомогательные команды с `$()`/`${…}` или shell loop были остановлены локальным PowerShell parsing/quoting до полезного remote body. Исправленные команды без подстановок прошли; production DDL/DML и runtime эти операторские ошибки не затронули.

## Сверка конкурентного deploy и объединённый runtime

Параллельный commit `0162f23` ошибочно заменил реальный отдел снабжения `10` на сервисный центр `12`, одновременно вернул редактирование цен и уточнил подписи. Он был опубликован только в `codex/admin-repair-documents` от старого parent `aabda51` и развёрнут как `b24-app:0162f23`; ветка не содержала 22 commits актуальной `main`, включая весь SQL foundation и `4579048`. Deploy сохранил `b24-app:4579048` как `b24-backend-prev-before-0162f23`, правильные network/mount/env и не изменил MariaDB, backup, restore или credentials, но internal/public `/ready` временно вернулись к 404. Health и ERP API оставались зелёными.

Read-only аудит rollback подтвердил `4579048`, exit 0, отсутствие OOM/state error, точное совпадение env/mount/port/restart policy и сохранённую `erpnext_frappe_network`. В его структурированных логах были только info-level записи; две writable-layer позиции относятся к `/app` и bind mount `/app/state`. В image статически присутствовали `/ready`, dry-run modules и `0001`-`0004`.

Патч `0162f23` чисто перенесён поверх актуальной истории как `d1a78b1`. Первый полный combined backend run обнаружил один старый fixture `[10]` в `catalog-content.test.ts`; production не переключался. Fixture изменён на `[12]` отдельным `740403a`. После этого focused access `10/10`, backend `221/221`, frontend `117/117`, workspace typecheck и production build успешны. Первый локальный build был остановлен Windows sandbox `E_ACCESSDENIED` при чтении Vite config; тот же build вне sandbox прошёл. Прежние npm `-ws` и Vite chunk-size warnings не исправлялись.

`740403a` опубликован fast-forward в `origin/main`, собран из clean LF archive и развёрнут после отдельного canary. Static image checks подтвердили включённое тогда ошибочное значение department `12`, `/ready`, пять migration files, writer module и hash `0005` `885e8222db301725daf7fa3ef792ddbdc07328f0afaad5f1d6e6991e35a5fd97`. Два ранних canary/release curl получили connection reset до готовности listener и успешно прошли встроенные retries; rollback не потребовался. Позднее реальный вход сотрудника снабжения доказал дефект: `stock/form-data` вернул не-снабженческую роль, потому что Bitrix24 использует `10` для «Снабжение» и `12` для сервисного центра.

Финальный независимый post-check: `b24-app:740403a`, running/restart 0, internal/public health и readiness `up`, ERP GET, state mount, localhost port, runtime env и network успешны. SQL осталось `6|5|0|0|0|0|0`; backup/restore/migration artifacts сохранены, новые логи только level 30. Rollback chain: `b24-backend-prev-before-740403a` → `b24-app:0162f23`, затем `b24-backend-prev-before-0162f23` → `b24-app:4579048`, оба exited 0. Canary, env snapshot, build directory и staging archives удалены. Mirror apply, shadow read и source switch не выполнялись.

## Первый production mirror apply

Перед DML повторный read-only preflight подтвердил неизменный runtime `b24-app:740403a`, restart 0, `erpnext_frappe_network`, internal/public health, readiness `up`, официальный ERPNext read, SQL `6 tables / 5 migrations / 0 domain/checkpoint rows`, свободный mirror lock и только `SELECT/INSERT/UPDATE` у `b24_app_backfill`. Локальный baseline backend перед этапом прошёл `221/221`.

Свежий owner-authorized план с `observedAt=2026-08-21T09:03:35.037Z` полностью прочитал ERPNext `398`, `ctv_transfers` `110` и `ctv_tr_requests` `5`. План получил hash `181e72d285b576b9b22c00993d88eb9451ceb10f669bfcc2366a4e2cf35d02e6`, `516` documents / `1002` lines / `527` links / `716` allocations, `0` errors / `22` historical warnings и `readyToApply=true`. По сравнению с предыдущим полным планом прирост `+6/+11/+9/+11` объясняется новыми ERP records; warnings не ухудшились.

После отдельного явного разрешения one-shot process передал writer точный ожидаемый hash. Одна транзакция создала `516|1002|527|716` graph rows и один checkpoint; migration count остался `5`, lock освободился, orphan checks для lines/links/allocations равны `0|0|0`. Checkpoint сохранил точные source cardinalities, counts и `22` warnings. Немедленный повтор того же hash вернул `alreadyApplied=true` и не изменил counts. Выборочно проверены полные цепочки `заявка → заказ → приёмка → перемещение → реализация`, включая `MAT-MR-2026-00057 ← PUR-ORD-2026-00095 ← MAT-PRE-2026-00130` и `PUR-ORD-2026-00095 ← 20982 ← MAT-STE-2026-00265`.

Постоянный backend не менялся: image `740403a`, `B24_APP_DB_MODE=readiness`, read-only runtime credential, Bitrix/ERPNext workflow и fallback pagination остались прежними. Apply route, scheduler, shadow read и source switch не добавлялись. OAuth владельца был получен только разрешённым локальным loopback capture для одного операторского запуска; raw capture, OAuth и временный runtime env удалены сразу после проверки, one-shot containers отсутствуют.

Post-apply job `/root/sync/b24-app-backup-job.sh` создал `/root/core-backups/b24_app/20260821_090845-b24_app-database.sql.gz`, `163253` bytes и 6 table definitions. Gzip/checksum, Bitrix Disk upload/read-back и marker успешны; IDs dump `103800`, checksum `103798`. Официальный restore drill восстановил dump только в `b24_app_restore_20260821_090845`. Source/restore совпали по `utf8mb4/utf8mb4_unicode_ci`, 6 tables, 66 columns, 37 indexes, 40 constraints, 22 CHECK, 5 FK, всем шести row checksums и итоговым counts/hash `516|1002|527|716|1|5|181e…d02e6`. Source не изменился. Restore schema и безопасный staging без secrets сохранены до отдельного cleanup-разрешения.

### Посторонние операторские наблюдения mirror apply

- Browser/Windows automation дважды остановилась до действий, потому что не смогла достаточно уверенно определить URL активного браузера. Production mutation не было; после отдельного разрешения использован узкий loopback capture.
- Первые CRLF-копии двух read-only preflight scripts завершились служебной ошибкой `$'\r'` уже после всех проверок. Повтор с удалением CR прошёл; production это не затронуло.
- Один диагностический `SHOW GRANTS` вывел authentication hash, не пароль, в закрытый operator output. Значение не переносилось в файлы/документацию; дальнейшие проверки выполнялись через `information_schema` только по именам privileges. Эту форму диагностики не повторять.
- Одна локальная PowerShell-команда с pipe не дошла до remote shell, а один read-only `sed` по SSH выполнялся около 44 секунд. Оба события не меняли production.

## Восстановление доступа снабжения после mirror apply

Реальный вход сотрудника показал, что перенесённое из `0162f23` значение department `12` закрывает снабжение: фактический ID отдела снабжения — `10`, а `12` — сервисный центр. Commit `280e5e4` вернул только этот access constant и его fixtures, не меняя supply mirror или SQL-границы. Before/after tests: focused `10/10`, backend `221/221`, frontend `117/117`, typecheck и production build успешны.

Clean image `b24-app:280e5e4` развёрнут с обязательной сетью и сохранением `b24-app:740403a` как `b24-backend-prev-before-280e5e4`. Независимый post-check подтвердил internal/public health и readiness, официальный ERP read, network/mount/port/restart policy, department `10` в image и успешные живые supply requests. SQL осталось `516|1002|527|716|1|5` с исходным checkpoint hash, `22` warnings, нулевыми orphan checks и свободным lock. Runtime по-прежнему только `readiness`; source switch не выполнялся.
