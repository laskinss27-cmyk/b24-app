# Supply shadow-read: локальный фундамент

## Граница change set

Добавлены только два изолированных backend-модуля: read-only SQL reader последнего supply mirror snapshot и чистый parity comparator. Они не подключены к server, HTTP route, startup, scheduler или пользовательскому workflow. Новых env, migrations и SQL-записей нет. Production и source-of-truth matrix не менялись.

## Read contract

`readLatestSupplyMirrorSnapshot()` сначала читает ровно один самый новый checkpoint по `applied_at, id`. После этого documents, lines, links и allocations читаются только с точным `observed_at` этого checkpoint. Это обязательно, потому что writer не делает `DELETE`: старые identities остаются как исторические evidence и не должны попадать в текущий snapshot.

Reader восстанавливает стабильные document/line/link/allocation identities, читает hashes через `HEX`, DECIMAL как числа и DATETIME как timezone-independent строки. Неизвестный enum, невалидное число или hash завершают чтение ошибкой.

## Comparison contract

`compareSupplyMirrorShadow()` сверяет свежий API-plan с SQL snapshot по plan hash, source cardinalities, checkpoint/loaded counts и каждому нормализованному полю всех четырёх типов rows. Разное техническое observation time не является business-расхождением. Отчёт имеет четыре явных статуса:

- `match` — все checkpoint и row fields совпали;
- `mismatch` — план полный, но есть расхождения;
- `plan_blocked` — хотя бы один текущий source неполон или план содержит error;
- `no_snapshot` — checkpoint в SQL отсутствует.

Число детальных differences ограничено, но общий счётчик не теряется. Неполный Bitrix/ERP read никогда не сравнивается как пустой реестр.

## Baseline и проверки

До изменения текущий focused SQL/supply набор прошёл `41/41`. После изменения тот же набор вместе с 8 новыми reader/comparator тестами прошёл `49/49`; полный backend — `229/229`. Backend и workspace typecheck, а также production build завершились успешно. Одноразовый MariaDB 11.8 tmpfs rehearsal прошёл writer/read/compare для первого и изменённого snapshot, а также прежние idempotency, rollback и DML-only guards; контейнер удалён, volume не создавался.

Первый production build остановился только из-за Windows sandbox `Access is denied` при чтении Vite config; повтор той же команды вне sandbox прошёл. Прежние npm warning о deprecated single-hyphen `-ws` и Vite warning о chunk больше 500 kB не исправлялись в этом этапе.

## Следующие отдельные gates

1. Отдельным решением commit/push локального фундамента.
2. Новым change set добавить только owner-only ручной shadow endpoint/runner с default-off gate; ответ workflow всегда оставить Bitrix/ERP.
3. Только после разрешённого deploy и нескольких успешных production comparisons проектировать SQL read path с Bitrix fallback.
