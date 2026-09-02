# Нормализованное SQL-хранилище перемещений — 2026-09-02

## Цель этапа

Убрать зависимость workflow перемещений от одного изменяемого JSON-поля
`ctv_transfers.DETAIL_TEXT`, не меняя поведение пользователей одним опасным
переключением. На этом этапе Bitrix24 остаётся источником записи и чтения, а
`b24_app` получает полную нормализованную копию каждого изменения.

ERPNext по-прежнему доступен только через официальный API. Новые таблицы не
читают и не изменяют ERPNext SQL.

## Модель

Миграции `0023`–`0029` создают семь таблиц без SQL `JSON`:

- `stock_transfer_records` — стабильная внешняя identity документа и tombstone;
- `stock_transfer_revisions` — неизменяемые скалярные версии состояния;
- `stock_transfer_revision_lines` — строки по фазам planned/collected/shipped/
  accepted/received/shortage;
- `stock_transfer_revision_history` — события истории;
- `stock_transfer_history_changes` — изменения внутри события;
- `stock_transfer_revision_corrections` — связи с корректировками;
- `stock_transfer_backfill_checkpoints` — детерминированные one-shot checkpoints.

Обновление документа не переписывает прежнюю версию. Оно блокирует identity,
сравнивает SHA-256 полного канонического состояния и либо делает no-op, либо
добавляет следующую revision со всеми дочерними строками одной транзакцией.
Удаление в Bitrix24 отражается только `deleted_at`: SQL `DELETE` приложению не
нужен, история остаётся восстановимой.

## Ворота безопасности

Runtime-флаг `B24_APP_TRANSFER_SQL_WRITE` имеет только значения `off|shadow` и
по умолчанию равен `off`. Режим `shadow` требует:

- уже активный `B24_APP_DB_MODE=readiness`;
- отдельные `B24_APP_TRANSFER_DB_USER/PASSWORD`;
- identity, отличную от runtime, migrator, backfill, Tilda и reservations;
- только `SELECT, INSERT, UPDATE` на семь transfer-таблиц, без `DELETE`, DDL и
  доступа к таблицам ERPNext.

Все create/update/delete пути `ctv_transfers` проходят через единый storage
adapter. Сначала успешно записывается Bitrix24, затем выполняется shadow write.
Ошибка shadow write журналируется, но не превращает уже успешную рабочую
операцию в ложную ошибку пользователю. Пропуск обнаруживает полный parity pass.

Initial backfill читает только полный payload последнего verified supply mirror.
План блокируется при неполном источнике, несовпадении cardinality, дубликате ID
или невалидном документе. Apply требует точный hash, берёт named lock и пишет
весь набор плюс checkpoint одной транзакцией. Повтор того же hash — no-op.

Dry-run:

```bash
npm --workspace @b24-app/backend run transfers:backfill
```

Apply выполняется только после отдельного backup/restore gate и явного
операторского подтверждения hash:

```bash
npm --workspace @b24-app/backend run transfers:backfill -- --apply <PLAN_HASH>
```

После commit скрипт перечитывает нормализованные таблицы, повторно проверяет
stored hash каждой revision и требует точный canonical parity с источником.

## Проверка до production

Локально пройдены:

- typecheck всех workspace;
- полный backend suite: `364/364`;
- focused transfer/migration suite: `20/20`;
- отдельный reader suite: `2/2`;
- MariaDB `11.8` rehearsal на временной базе: DDL `0023`–`0029`, initial
  backfill, checkpoint no-op, append-only update, чтение/parity, tombstone и
  восстановление; DML-only user получил ожидаемый отказ на `DELETE` и DDL.

Временный контейнер и тестовая schema/user после проверки удалены. Production
на момент создания документа не изменён.

## Production-порядок

1. Зафиксировать текущие container/image/env/state/network/public URL из
   работающего `b24-backend` и сохранить его как rollback container.
2. Сделать отдельный backup `b24_app`, внешний read-back и restore drill.
3. Одноразовым migrator применить только `0023`–`0029`; credential не оставлять
   в backend env.
4. Повторить backup/read-back/restore, включая новые таблицы и migration hashes.
5. Одноразовым DML backfill user выполнить dry-run, записать hash, затем
   отдельно разрешённый apply точного hash и повторный no-op/parity.
6. Создать постоянного узкого transfer writer, сохранить пароль только в
   root-owned mode `0600` secret-файле; проверить отсутствие `DELETE`/DDL и
   лишних grants.
7. Собрать version-pinned image. Запустить новый `b24-backend` только с
   `--network erpnext_frappe_network`, фактическими env/state/port/restart
   параметрами прежнего контейнера и `B24_APP_TRANSFER_SQL_WRITE=shadow`.
8. Проверить internal/public `/health`, `/ready` с `transferSqlWriter: up`,
   официальный ERPNext read из backend, network membership и restart count.
9. Создать и изменить один обычный transfer через приложение, затем подтвердить
   новую revision и точный Bitrix/SQL parity. Не выполнять тестовые складские
   проводки ради этой проверки.

Откат runtime: вернуть сохранённый backend container или выставить
`B24_APP_TRANSFER_SQL_WRITE=off`. Новые таблицы, revisions, checkpoints, backup
и credentials при оперативном откате не удалять.
