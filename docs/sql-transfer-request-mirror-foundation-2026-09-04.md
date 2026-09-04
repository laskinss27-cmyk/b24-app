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

## Production mirror rollout — 4 сентября 2026

Перед DDL штатный job с выключенным retention создал дамп
`20260904_100624-b24_app-database.sql.gz` размером `5 383 856` байт и
`35` table definitions. Локальные gzip/checksum и обратное чтение из закрытой
папки Bitrix Disk прошли; IDs копий `107584/107582`. Этот же файл восстановлен
только в `b24_app_restore_20260904_100624`, где подтверждены те же 35 таблиц;
production schema не изменилась. Проверочная БД сохранена.

One-shot migrator image `b24-app:1ab2977` применил ровно `0046`–`0049` и
остановился. Постоянный `b24_app_runtime` получил только `SELECT` на records,
revisions и lines. Существующий отдельный `b24_app_transfer_runtime` получил
`SELECT/INSERT/UPDATE` на records и `SELECT/INSERT` на revisions/lines.
`DELETE`, DDL и доступ runtime-ролей к checkpoint не выдавались.

Новый image сначала развёрнут с `REQUEST_SQL_READ=off` и
`REQUEST_SQL_WRITE=off`. Canary и независимый post-check подтвердили internal
и public health, readiness, официальный ERPNext read, `/srv/b24-state`, порт
`127.0.0.1:3000`, `unless-stopped`, restart count `0` и сеть
`erpnext_frappe_network`. Предыдущий image `b24-app:621df91` сохранён как
`b24-backend-prev-before-1ab2977`.

Owner-verified dry-run полностью прочитал `16` записей `ctv_tr_requests` и дал
готовый план
`ae89e56023aa18a11bb4b1902432c171804b375ac1b7cb2a70f09bf3e86f020e`.
Перед apply отдельный post-DDL backup
`20260904_101921-b24_app-database.sql.gz` (`39` tables) прошёл внешний read-back
с IDs `107596/107594` и restore drill в сохранённую
`b24_app_restore_20260904_101921`.

Exact-hash apply одной транзакцией создал `16` records/revisions и `31` line,
записал один checkpoint и завершился точной parity. Повтор того же плана вернул
`alreadyApplied=true` и снова подтвердил parity, не создав дублей. Post-backfill
backup `20260904_102218-b24_app-database.sql.gz` (`39` tables) прошёл внешний
read-back с IDs `107606/107604` и restore drill в сохранённую
`b24_app_restore_20260904_102218`. Ни один старый backup не удалялся.

После отдельного canary тот же image config-only переключён на
`B24_APP_TRANSFER_REQUEST_SQL_READ=shadow` и
`B24_APP_TRANSFER_REQUEST_SQL_WRITE=shadow`. Контейнер с обоими флагами `off`
сохранён как `b24-backend-prev-before-request-shadow-20260904-1023`.
Readiness отдельно показывает `transferRequestSqlWriter=up`. Один обычный
owner-authenticated runtime-запрос списка вернул `16` заявок; журнал сравнения:
`legacyCount=16`, `sqlCount=16`, `matches=true`, `0` differences,
`responseSource=legacy`. OAuth использован только в памяти сервера и не
печатался/не сохранялся.

Первые health probes сразу после container switch опережали HTTP
listener и получили transient reset/empty reply; встроенные retries прошли,
rollback не потребовался. Независимые post-checks после запуска зелёные.

Поскольку новых рабочих ревизий в текущий день не ожидалось, отдельным
разрешением выполнен config-only switch `READ=verified` при неизменном
`WRITE=shadow`. Предыдущий shadow-read контейнер сохранён как
`b24-backend-prev-before-request-verified-20260904`. Повторный обычный
owner-authenticated запрос дал `16/16`, `0` differences и
`responseSource=sql`. Финальный post-check подтвердил internal/public health,
readiness со всеми SQL writer checks `up`, официальный ERPNext read,
`erpnext_frappe_network`, restart count `0`, неизменные counts
`16 records / 16 revisions / 31 lines / 1 checkpoint` и отсутствие SQL-ошибок
заявок в журнале.

Текущий этап остаётся Bitrix-primary для записи и обязательной live-проверки:
`verified` на каждом чтении сначала загружает Bitrix и автоматически возвращает
его ответ при mismatch/error. SQL-primary writer для ручных заявок не
реализован и не разрешён этим rollout. Следующий этап начинается только после
наблюдения реального update/cancel/convert через shadow writer.
