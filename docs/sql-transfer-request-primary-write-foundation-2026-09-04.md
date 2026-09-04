# SQL-first для ручных заявок — локальный change set 4 сентября 2026

## Что подготовлено

Ручные заявки на перемещение и снабжение могут стать SQL-primary без потери
старых номеров. Существующие Bitrix ID переносятся в отдельную публичную
нумерацию детерминированным one-shot backfill. Новые номера выдаёт SQL.
Bitrix `ctv_tr_requests` сохраняется как compatibility mirror и аварийный
fallback; существующие JSON-записи не удаляются.

Миграции `0050`–`0056` добавляют nullable public identity, allocator,
checkpoint, idempotency commands и lease/outbox без JSON payload. Отдельная
миграция разрешает `sql_native` только в append-only revisions.

## Порядок операции

1. Create/update/delete сначала фиксируются одной MariaDB-транзакцией.
2. Повтор с тем же idempotency key возвращает тот же результат; повтор ключа с
   другим состоянием блокируется.
3. Каждое состояние остаётся неизменяемой revision с нормализованными строками.
4. После commit актуальная revision зеркалится в Bitrix. В payload добавляется
   только compatibility-маркер `sqlPublicId`.
5. Ошибка Bitrix не откатывает SQL. Outbox остаётся pending, получает
   60-секундную lease и повторяется ограниченными пачками при следующих
   обращениях.
6. Удаление означает SQL tombstone; ожидающие старые upsert помечаются
   `superseded`, после чего отдельно удаляется только Bitrix mirror.

Frontend передаёт уникальный ключ и неизменный `createdAt` одного клика. Это
защищает повтор того же HTTP-запроса от второго документа. После успешной
Bitrix-аутентификации фиксация заявки в SQL не зависит от успешной доставки
compatibility mirror. Создание Bitrix-задачи остаётся отдельным best-effort
побочным действием и не является частью SQL-транзакции.

## Runtime gates

- `B24_APP_TRANSFER_REQUEST_SQL_WRITE=off|shadow|primary`;
- `B24_APP_TRANSFER_REQUEST_SQL_READ=off|shadow|verified|primary`;
- write=`primary` требует read=`primary` и `B24_APP_DB_MODE=readiness`;
- readiness проверяет records, allocator, commands, outbox и отсутствие legacy
  записей без public ID.

## Локальная проверка

- transfer-request focused tests: `16/16`;
- backend suite: `409/409`;
- frontend suite: `133/133`;
- workspace typecheck и production backend/frontend builds: успешно;
- одноразовая MariaDB `11.8.8`: все `0046`–`0056` применились, повтор migrations
  стал no-op, legacy `#21` сохранил номер, SQL-native create получил `#22`,
  повтор create вернул тот же документ, update создал revision `2`, delete
  оставил tombstone и recoverable delete outbox;
- DML-only пользователь получил отказ на физический `DELETE` и DDL;
- временная база, пользователь и контейнер после теста удалены;
- `git diff --check`: успешно.

## До production switch

Этот change set локальный. Production schema, grants, данные, flags и контейнер
не изменялись.

Следующие ворота выполняются только отдельными явно разрешёнными шагами:

1. свежий backup отдельной `b24_app`, внешний read-back и restore drill;
2. применить `0050`–`0052`, не меняя runtime flags;
3. dry-run `transfer-requests:identity-backfill`, затем apply только с точным
   SHA-256 плана и повторный no-op/parity check;
4. применить `0053`–`0056` и выдать runtime только необходимые grants:
   `SELECT/INSERT/UPDATE` allocator, `SELECT/INSERT/UPDATE` commands/outbox,
   `SELECT/INSERT/UPDATE` records и `SELECT/INSERT` revisions/lines;
5. развернуть код с текущими `shadow/verified`, проверить readiness, public и
   internal health, официальный ERPNext read, сеть и live parity;
6. отдельно включить согласованную пару `primary/primary`, сохранив rollback
   container и Bitrix fallback;
7. проверить create/update/cancel, отсутствие дублей и пустую либо успешно
   восстанавливаемую outbox.

## Production foundation 4 сентября 2026

Перед DDL backup `20260904_135925-b24_app-database.sql.gz` прошёл локальную
checksum/gzip-проверку, внешний Bitrix Disk read-back (`dump_id=107734`,
`checksum_id=107732`) при выключенном retention и isolated restore drill. Затем
one-shot migrator применил ровно `0050`–`0052`; runtime остался
`shadow/verified`.

Post-DDL backup `20260904_142101-b24_app-database.sql.gz` прошёл restore drill и
внешний read-back (`dump_id=107754`, `checksum_id=107752`). Детерминированный
dry-run получил `17` записей, `17` назначений и plan hash
`6b6a6ee44812b23d9630b9e15c4f11535ad4f64c6fe434bdc3910d25318378f2`.
Отдельно разрешённый DML-only apply назначил все `17` public ID, сохранив
равенство legacy Bitrix ID, и записал один checkpoint. Повторный dry-run дал
`toAssign=0` с тем же hash. Post-backfill backup
`20260904_142656-b24_app-database.sql.gz` прошёл restore drill и внешний
read-back (`dump_id=107758`, `checksum_id=107756`) без retention.

Следующий one-shot migrator применил ровно `0053`–`0056`. Независимый аудит
подтвердил `56` migration rows, nullable Bitrix identity, две пустые
commands/outbox tables, `17/17` public identities и сохранённый checkpoint.
Существующему `b24_app_transfer_runtime` добавлены только table-level права:
`SELECT/INSERT/UPDATE` на allocator, commands, outbox и records, а также
`SELECT/INSERT` на revisions/lines. Schema/global privileges и
`DELETE/CREATE/ALTER/DROP` отсутствуют; фактический runtime probe подтвердил
разрешённые нулевые DML и отказ `DELETE`. Пароль не менялся.

Финальный локальный backup `20260904_144306-b24_app-database.sql.gz` восстановлен
в `b24_app_restore_20260904_144306`: все `43` таблицы, schema/migration
signatures и `39` стабильных table checksums совпали; четыре живые таблицы
изменились уже после снимка без изменения числа строк. Его внешний read-back
остаётся отдельным gate. Рабочий backend не перезапускался: image
`b24-app:613c177`, restart `0`, `B24_APP_TRANSFER_REQUEST_SQL_WRITE=shadow`,
`B24_APP_TRANSFER_REQUEST_SQL_READ=verified`; internal/public health,
официальный ERPNext read и `erpnext_frappe_network` успешны.
