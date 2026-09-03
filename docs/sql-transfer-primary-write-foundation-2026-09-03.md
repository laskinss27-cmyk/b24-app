# SQL-first запись перемещений — локальный change set 3 сентября 2026

## Результат

Подготовлен следующий, пока не активированный production-этап переноса
перемещений из `ctv_transfers.DETAIL_TEXT` в нормализованный `b24_app`.
Создание и изменение документа могут сначала атомарно фиксироваться в SQL, а
Bitrix24 становится восстанавливаемым compatibility mirror.

Рабочий production по-прежнему использует
`B24_APP_TRANSFER_SQL_WRITE=shadow` и `B24_APP_TRANSFER_SQL_READ=verified`.
Ни DDL `0035`-`0037`, ни новые grants, ни source switch этим change set не
выполняются автоматически.

## Схема без JSON

- `0035` разрешает `stock_transfer_records.bitrix_external_id = NULL` для
  документа, который уже записан в SQL, но ещё не получил технический ID
  Bitrix24. `public_id` остаётся обязательной прикладной идентичностью в
  SQL-first runtime.
- `0036` создаёт `stock_transfer_commands`: уникальный ASCII idempotency key,
  SHA-256 нормализованного состояния и ссылки на итоговые record/revision.
  Повтор того же запроса возвращает тот же документ; повтор ключа с другим
  payload завершается ошибкой до записи.
- `0037` создаёт `stock_transfer_bitrix_outbox`. Строка ссылается на
  неизменяемую нормализованную revision и не хранит JSON payload.

Физическое удаление SQL-строк не используется. ERPNext таблицы не читаются и
не изменяются напрямую.

## Порядок SQL-first операции

1. В одной MariaDB-транзакции блокируется idempotency command.
2. Для create аллокатор выдаёт новый `public_id`; старые номера уже заняты
   backfill-строками, поэтому последовательность продолжается без коллизии.
3. Записываются record, append-only revision, строки/история/корректировки,
   command result и outbox reference.
4. Только после SQL commit выполняется Bitrix compatibility mirror.
5. В mirror payload добавляется технический `sqlPublicId`. Если Bitrix успел
   создать запись, а подтверждение в SQL не сохранилось, повтор находит запись
   по этому маркеру и обновляет её вместо создания дубля.
6. Ошибка Bitrix не отменяет уже подтверждённый SQL-документ. Outbox остаётся
   pending и повторяется ограниченной пачкой при следующих обращениях к модулю.
7. Повтор уже завершённого create возвращает существующий SQL-документ и не
   создаёт повторно задачу или уведомление.
8. Удаление сначала атомарно ставит SQL tombstone, сохраняет все record/revision
   строки и добавляет отдельную delete-операцию в outbox. После commit зеркало
   удаляется из Bitrix; если его уже нет, операция считается доставленной.
9. Ожидающие upsert-записи удаляемого документа переводятся в `superseded`,
   поэтому старое состояние не сможет воскресить удалённое зеркало.

Перед обращением к Bitrix outbox получает 60-секундную SQL lease. Поэтому два
параллельных запроса не создают два зеркала; оборванная lease автоматически
становится доступной для recovery.

Все legacy-парсеры распознают `sqlPublicId`, поэтому технический entity ID
Bitrix не подменяет видимый номер документа.

## Runtime gates

- режимы записи: `off | shadow | primary`;
- режим `primary` запускается только вместе с
  `B24_APP_TRANSFER_SQL_READ=primary` и `B24_APP_DB_MODE=readiness`;
- readiness режима `primary` отдельно проверяет доступность records,
  allocator, commands и outbox;
- create endpoints передают уникальный ключ одного пользовательского клика;
  групповые перемещения получают детерминированные дочерние ключи;
- create/update/delete сериализуются idempotency-командами, а upsert/delete
  Bitrix mirror — общей lease одного документа;
- основные рабочие читатели перемещений, остатков, снабжения, реализации и
  вариантов сделки используют общий storage adapter и в `primary` читают SQL.

## Проверка

Unit/contract checks покрывают миграции, runtime gates, public-ID parsing,
порядок SQL commit → Bitrix mirror, отказ Bitrix и recovery без дубля.

Изолированная MariaDB 11.8 rehearsal применяет `0023`-`0037`, выполняет legacy
backfill и identity backfill, создаёт SQL-native документ, повторяет create с
тем же ключом, отвергает reuse ключа с другим состоянием, добавляет update
revision, доставляет две outbox-записи одним актуальным mirror и проверяет
SQL tombstone, повтор delete, отдельный cleanup mirror, отсутствие физического
удаления и запрет `DELETE`/DDL для DML-only пользователя. Временная schema,
user и контейнер после теста удаляются.

## Следующий production gate

До source switch требуется отдельное разрешение на каждый production-шаг:

1. сделать новый внешний backup/read-back и restore drill отдельной базы
   `b24_app`;
2. применить только `0035`-`0037` one-shot migrator-ом;
3. расширить права только `b24_app_transfer_runtime`: `INSERT` allocator,
   `SELECT/INSERT/UPDATE` commands и outbox, `UPDATE` legacy mirror link;
4. сначала развернуть код без смены текущих `shadow/verified` флагов и
   подтвердить live parity;
5. подтвердить live parity после кода и проверить, что очередь compatibility
   mirror пуста либо успешно восстанавливается;
6. только затем отдельной командой включить согласованную пару
   `WRITE=primary`, `READ=primary`, сохранив старые Bitrix JSON-записи.
