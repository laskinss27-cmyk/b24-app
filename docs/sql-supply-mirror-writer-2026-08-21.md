# Локальный supply mirror writer — 2026-08-21

## Граница этапа

Подготовлен только локальный атомарный writer для уже существующего read-only supply plan. Production не читался и не изменялся: migration `0005` не применялась, backfill credential не создавался, SQL domain rows не записывались, backend не разворачивался, workflow по-прежнему использует Bitrix24 и официальный ERPNext API.

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

Отдельная функция конфигурации требует `B24_APP_BACKFILL_DB_USER/PASSWORD`, запрещает совпадение имени с runtime/migration user и не меняет постоянный runtime pool. Предполагаемые права one-shot пользователя: только `SELECT`, `INSERT`, `UPDATE` на `b24_app`; DDL и `DELETE` запрещены.

## Migration `0005`

Append-only one-statement migration создаёт только `supply_mirror_checkpoints`: plan hash, source cardinalities, row counts, warning count, observed/applied timestamps. JSON, scheduler, payload storage и source switch не добавляются. Production по-прежнему содержит только применённые `0001`-`0004`, 4 migration rows и четыре пустые domain tables.

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
3. Отдельно создать ограниченного production backfill user и независимо проверить grants.
4. Применить только `0005`, повторить backup/restore drill уже с checkpoint table.
5. Только новым разрешением выполнить один полный mirror apply; после него сверить counts, hashes и выборочные graph chains, не переключая чтения.
6. После нескольких успешных shadow comparisons отдельно проектировать SQL read path с Bitrix fallback.

## Production preflight перед `0005`

Commit `d46475d` опубликован в `origin/main`, но backend не развёртывался и остался на `b24-app:4579048`. Committed checksum `0005_create_supply_mirror_checkpoints.sql` — `885e8222db301725daf7fa3ef792ddbdc07328f0afaad5f1d6e6991e35a5fd97`; он совпадает с hash, прошедшим локальный MariaDB 11.8 rehearsal.

Один явно разрешённый safety job создал `/root/core-backups/b24_app/20260821_072214-b24_app-database.sql.gz` размером 2513 bytes. Локальные `gzip -t` и SHA-256 успешны; Bitrix Disk upload/read-back подтверждён для dump ID `103718` и checksum ID `103716`. Dump содержит ровно пять текущих table definitions, четыре migration metadata rows, не содержит `supply_mirror_checkpoints` и domain INSERT.

До и после backup production подтвердил `B24_APP_DB_MODE=readiness`, отсутствие migration/backfill credentials в runtime, internal/public health, readiness `up`, официальный ERPNext GET, image `b24-app:4579048`, restart count 0, migrations `0001`-`0004` и SQL domain rows `0|0|0|0`. Backup lock освобождён, временные diagnostic-файлы удалены. Migration `0005`, backfill user, deploy, mirror apply и source switch не выполнялись.
