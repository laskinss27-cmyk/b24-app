# Нормализованное SQL-хранилище перемещений — 2026-09-02

## Цель этапа

Убрать зависимость workflow перемещений от одного изменяемого JSON-поля
`ctv_transfers.DETAIL_TEXT`, не меняя поведение пользователей одним опасным
переключением. На этом этапе Bitrix24 остаётся источником записи и чтения, а
`b24_app` получает полную нормализованную копию каждого изменения.

ERPNext по-прежнему доступен только через официальный API. Новые таблицы не
читают и не изменяют ERPNext SQL.

## Модель

Миграции `0023`–`0031` создают семь таблиц без SQL `JSON` и версионируют
представление scalar history values:

- `stock_transfer_records` — стабильная внешняя identity документа и tombstone;
- `stock_transfer_revisions` — неизменяемые скалярные версии состояния;
- `stock_transfer_revision_lines` — строки по фазам planned/collected/shipped/
  accepted/received/shortage;
- `stock_transfer_revision_history` — события истории;
- `stock_transfer_history_changes` — изменения внутри события;
- `stock_transfer_revision_corrections` — связи с корректировками;
- `stock_transfer_backfill_checkpoints` — детерминированные one-shot checkpoints.

`state_format_version=2` и отдельные `from_value_type`/`to_value_type`
сохраняют различие между числом `0` и строкой `""`. Версия 1 остаётся в
append-only истории, но reader принимает только последнюю полную версию 2.
Пустые необязательные `byName`, `note` и `changes` канонизируются как
отсутствующие поля, чтобы Bitrix и SQL не расходились только из-за формы записи.

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
- полный backend suite после итоговой канонизации: `367/367`;
- focused transfer/migration suite: `20/20`;
- отдельный reader suite: `2/2`;
- MariaDB `11.8` rehearsal на временной базе: DDL `0023`–`0031`, initial
  backfill, checkpoint no-op, append-only update, чтение/parity, tombstone и
  восстановление; DML-only user получил ожидаемый отказ на `DELETE` и DDL.

Временный контейнер и тестовая schema/user после проверки удалены. Production
на момент создания документа не изменён.

Для ручных migration-gate backups uploader получил явный
`B24_APP_BACKUP_RETENTION=off`: он всё так же загружает обе части пары, скачивает
их обратно и сверяет SHA-256, но не удаляет старые внешние копии. Штатный cron
без этой переменной сохраняет прежний retention `on`.

## Production-порядок

1. Зафиксировать текущие container/image/env/state/network/public URL из
   работающего `b24-backend` и сохранить его как rollback container.
2. Сделать отдельный backup `b24_app`, внешний read-back и restore drill.
3. Одноразовым migrator применить только `0023`–`0031`; credential не оставлять
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

## Production-результат 2026-09-02

Этап `Bitrix24 primary + SQL shadow write` развёрнут образом `b24-app:1fe3812`.
Предыдущий production-контейнер сохранён остановленным как
`b24-backend-prev-before-transfer-shadow-20260902-1525` с образом
`b24-app:ecc37d4`; он не удалён. Активный backend подключён к
`erpnext_frappe_network`, использует прежний `/srv/b24-state:/app/state`,
локальный порт `127.0.0.1:3000`, политику `unless-stopped` и имеет
`RestartCount=0`.

Миграции `0023`–`0031` и backfill выполнялись при выключенном runtime writer.
Первые два append-only прогона выявили две потери формы legacy payload до
переключения пользователей: различие `0` и `""`, затем пустые необязательные
`byName`, `note`, `changes`. Исправления `f2e7c3f` и `1fe3812` сохранили ранние
revisions как аудит и добавили каноническую последнюю revision. Итоговый план:

- hash `0d367e1b648187e2638e4f5d9484d84a9a7660ce3d4a2d8a01157a2de2e80184`;
- источник `183`, создано канонических revisions `175`, no-op `8`;
- повторный apply — checkpointed no-op;
- parity `183/183`, tombstones `0`, orphan rows `0`;
- всего сохранено `541` append-only revisions и `3` backfill checkpoints.

Контрольный post-backfill backup:
`/root/core-backups/b24_app/20260902_151844-b24_app-database.sql.gz`, 510628
байт, 25 таблиц. Пара выгружена во внешнее хранилище с отключённым retention и
прочитана обратно (`dump_id=106952`, `checksum_id=106950`). Restore drill в
`b24_app_restore_20260902_151844` совпал по 15 стабильным таблицам, колонкам,
индексам и ограничениям. Аудит:
`/root/b24-app-audits/20260902T152058Z-transfer-post-backfill-backup-restore.txt`,
SHA-256 `101c184f2401dada10f14a0b28fc337ae4573d6ce994e0414da1af04fb22cfa7`.

Постоянный writer использует отдельного пользователя
`b24_app_transfer_runtime`. У него только `SELECT/INSERT/UPDATE` на identity
таблицу и `SELECT/INSERT` на append-only revision tables; `DELETE` и DDL
проверенно запрещены. Secret хранится в
`/root/b24-app-secrets/transfer-runtime.env` с mode `0600`, итоговый env — в
`/root/b24-app-secrets/backend-1fe3812.env` с mode `0600`.

Canary и production прошли internal/public `/health=200`, `/ready` с
`database`, `reservations`, `transferSqlWriter = up`, а также read-only запрос к
ERPNext через официальный API. Production-аудит:
`/root/b24-app-audits/20260902T153000Z-transfer-shadow-deploy.txt`, SHA-256
`dff11c14deb70d80d750b5403fb1f8b38fbf7febecc2b8670e33cc4a6186eb9c`.
Post-deploy SQL-аудит:
`/root/b24-app-audits/20260902T153100Z-transfer-postdeploy-sql.txt`, SHA-256
`b2bf204c0ef7c7297b0d7fe1274ded6b192458a29701e2d0163edfba09c131dc`.

При первом ручном backup gate штатный uploader неожиданно применил свой
retention и удалил из внешней папки шесть старых пар: `20260901_141447`,
`20260901_132012`, `20260901_125103`, `20260901_123001`, `20260831_151622`,
`20260831_144012`. Все шесть проверенных оригиналов и checksum остались
локально. Повторная внешняя отправка не выполнялась: автоматическая защита
потребовала отдельного явного разрешения на передачу полных архивов. Все
последующие gate-upload выполнялись копией uploader с
`B24_APP_BACKUP_RETENTION=off`.

Это ещё не source switch: рабочее чтение и первичная запись перемещений остаются
в Bitrix24. SQL уже получает каждое новое изменение как нормализованную
append-only копию. Следующий gate — дождаться обычного create/update от
пользователей и подтвердить новую revision и точный live parity; только после
этого отдельно решать переключение чтения.
