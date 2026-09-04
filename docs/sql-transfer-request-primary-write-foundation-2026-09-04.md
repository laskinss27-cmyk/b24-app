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
   `SELECT/INSERT` allocator, `SELECT/INSERT/UPDATE` commands/outbox,
   `SELECT/INSERT/UPDATE` records и `SELECT/INSERT` revisions/lines;
5. развернуть код с текущими `shadow/verified`, проверить readiness, public и
   internal health, официальный ERPNext read, сеть и live parity;
6. отдельно включить согласованную пару `primary/primary`, сохранив rollback
   container и Bitrix fallback;
7. проверить create/update/cancel, отсутствие дублей и пустую либо успешно
   восстанавливаемую outbox.
