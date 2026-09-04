# SQL-зеркало ручных заявок — локальный этап 4 сентября 2026

## Результат

Подготовлен, но ещё не развёрнут первый безопасный этап переноса ручных заявок
на перемещение и снабжение из `ctv_tr_requests.DETAIL_TEXT` в
нормализованный `b24_app`. Это не перенос ERPNext-заявок, заказов поставщику,
приёмок или складских документов: они по-прежнему доступны и изменяются только
через официальный ERPNext API.

Bitrix24 пока остаётся источником правды. Новый runtime умеет записывать SQL
только после успешной записи Bitrix и может вернуть SQL-результат только после
точного сравнения с полным актуальным реестром Bitrix. Режима `primary` для
ручных заявок в этом change set намеренно нет.

## Схема без JSON

Миграции `0046`–`0049` добавляют:

- `stock_transfer_request_records` — постоянная identity legacy-заявки,
  отображаемое имя, hash текущего состояния и мягкий tombstone;
- `stock_transfer_request_revisions` — неизменяемые ревизии заявки, её тип,
  статус, склады, комментарий, автор, даты и ссылки на задачу/перемещение;
- `stock_transfer_request_revision_lines` — нормализованные строки товара для
  заявок на перемещение и снабжение;
- `stock_transfer_request_backfill_checkpoints` — hash одобренного one-shot
  backfill-плана и его точные счётчики.

Физическое удаление SQL-строк не используется. Изменение создаёт новую
revision, а удаление legacy-заявки отмечает record как удалённый. SQL-таблицы не
содержат универсальных payload/JSON-колонок.

## Runtime gates

- `B24_APP_TRANSFER_REQUEST_SQL_WRITE=off|shadow`;
- `B24_APP_TRANSFER_REQUEST_SQL_READ=off|shadow|verified`;
- `shadow`-writer использует существующую отдельную DML identity подсистемы
  перемещений, но требует отдельные узкие grants на новые таблицы;
- `shadow`-чтение всегда возвращает Bitrix и только журналирует точность;
- `verified` сначала загружает весь Bitrix-реестр, сравнивает cardinality и
  каноническое состояние каждой заявки и только при полном совпадении возвращает
  SQL; mismatch/error автоматически оставляет legacy-ответ;
- SQL-ошибка после успешного обновления Bitrix не превращает пользовательскую
  операцию в ложную ошибку: Bitrix остаётся авторитетным источником этапа.

Одновременно исправлено legacy-чтение: список `ctv_tr_requests` теперь проходит
все страницы Bitrix, а не ограничивается первыми 50 строками.

## Backfill

`npm -w @b24-app/backend run transfer-requests:backfill` получает OAuth только
из server-side vault, повторно подтверждает владельца через `user.current` и
строит детерминированный fail-closed план. Запись возможна только отдельным
повтором с точным `--apply <planHash>` и one-shot backfill credential.

Apply выполняется одной транзакцией под MariaDB advisory lock. Неполный источник,
ошибка разбора, дубль ID, несовпадение количества или изменившийся hash блокируют
запись. Повтор уже применённого checkpoint является no-op.

## Локальная проверка

- focused transfer-request SQL tests: `9/9`;
- backend suite: `406/406`;
- workspace typecheck: успешно;
- production build backend/frontend: успешно;
- disposable MariaDB 11.8: миграции применились и повторились идемпотентно,
  backfill/checkpoint прошли, update создал append-only revision,
  tombstone/revive сохранили историю, DML-only user не смог выполнить
  `DELETE` или DDL;
- `git diff --check`: успешно.

Временный MariaDB-контейнер после теста остановлен и удалён. Production schema,
данные, grants, контейнер и flags этим локальным этапом не менялись.

## Следующий production gate

1. Создать свежий отдельный backup `b24_app`, проверить внешний read-back и
   выполнить restore drill без удаления production-данных.
2. Применить только `0046`–`0049` one-shot migrator-ом.
3. Выдать `b24_app_runtime` только `SELECT` на три read-таблицы; transfer runtime
   — `SELECT/INSERT/UPDATE` на records и `SELECT/INSERT` на revisions/lines.
   Checkpoint остаётся доступен только one-shot backfill identity.
4. Развернуть код с обоими новыми flags=`off` и проверить health/readiness,
   официальный ERPNext read и сеть `erpnext_frappe_network`.
5. Выполнить owner-verified dry-run, затем отдельный hash-guarded apply и точную
   сверку Bitrix/SQL.
6. Включить `WRITE=shadow`, собрать реальные изменения и подтвердить повторную
   parity; затем отдельно включить `READ=shadow`, после устойчивого совпадения —
   `READ=verified`.
7. Только после доказанной эксплуатации зеркала проектировать отдельный
   SQL-primary writer с idempotency/outbox. Старые Bitrix payload не удалять.
