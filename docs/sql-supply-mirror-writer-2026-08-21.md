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

1. Проверить diff и создать commit только по явной команде.
2. До production DDL: свежий safety backup, checksum/read-back и rehearsal точного `0005` hash.
3. Отдельно создать ограниченного production backfill user и независимо проверить grants.
4. Применить только `0005`, повторить backup/restore drill уже с checkpoint table.
5. Только новым разрешением выполнить один полный mirror apply; после него сверить counts, hashes и выборочные graph chains, не переключая чтения.
6. После нескольких успешных shadow comparisons отдельно проектировать SQL read path с Bitrix fallback.
