# Полное SQL-чтение перемещений снаба — подготовка 2 сентября 2026

## Граница change set

Изменение подготовлено и проверено локально. Production migration, backfill,
deploy и переключение runtime-флага не выполнялись. Развёрнутый backend остаётся
на `B24_APP_SUPPLY_SQL_READ=shadow` и продолжает возвращать данные Bitrix24.

Текущий graph mirror годится для сверки статусов, складов, количеств и связей,
но не может восстановить пользовательскую карточку перемещения: в нём нет
названия, комментария, автора, task/Stock Entry references, всех фаз строк и
истории. Поэтому прямой режим `sql` по-прежнему запрещён.

## Подготовленная модель

Migration `0022_create_supply_transfer_payloads.sql` создаёт специализированную
таблицу `supply_transfer_payloads`, привязанную к `workflow_documents`. Она хранит
канонический `TransferData` одного живого Bitrix transfer, его display name,
external ID, точное время mirror observation и SHA-256. Это не универсальное
хранилище произвольного JSON и не копия ERPNext: ERP stock/accounting data
по-прежнему читаются и изменяются только официальным API.

Mirror plan теперь:

- требует один полный payload для каждой живой Bitrix transfer-записи;
- сверяет число payloads с полной cardinality исходного реестра;
- проверяет совпадение ID, статуса, deal, основных строк и складов с
  нормализованным graph document;
- включает payload hashes в детерминированный plan hash;
- блокирует apply при неполной или противоречивой payload-модели.

Writer записывает graph и transfer payloads одной транзакцией перед checkpoint.
Reader выбирает payloads только по точному `observed_at` последнего checkpoint,
восстанавливает `TransferData`, повторно считает SHA-256 и fail-closed завершает
чтение при повреждении JSON, identity или hash.

## Переходный режим `verified`

Локально добавлен opt-in `B24_APP_SUPPLY_SQL_READ=verified`. Это ещё не отказ от
Bitrix24. На каждом запросе backend сначала читает полный живой реестр Bitrix,
затем сравнивает его с SQL, включая полное состояние карточек. Только при точном
совпадении дальнейший расчёт `/api/supply/orders` получает объекты,
восстановленные из SQL. При stale checkpoint, mismatch, пропущенной записи,
повреждённом payload или недоступной MariaDB ответ автоматически остаётся на
Bitrix. Порядок документов также сохраняется по живому реестру.

Таким образом, `verified` проверяет реальное формирование ответа из SQL, но ещё
не уменьшает зависимость от Bitrix. Независимый SQL source switch потребует
отдельного runtime write/dual-write этапа с idempotency и transaction recovery.

## Проверки

- focused migration/planner/writer/reader/shadow suite: `57/57`;
- полный backend suite: `351/351`;
- frontend suite: `129/129`;
- workspace typecheck: успешно;
- backend и production frontend build: успешно (остаётся прежнее предупреждение
  Vite о chunk больше 500 kB);
- одноразовая MariaDB `11.8.8`: migration, повторный migration no-op,
  транзакционный writer, checkpoint/read parity, rollback и запреты DDL/DELETE
  для DML-only user — успешно;
- временный MariaDB container после проверки удалён.

## Production gate

Следующий production шаг требует отдельной явной команды пользователя:

1. сделать pre-DDL backup `b24_app`, внешний read-back и restore drill;
2. применить только migration `0022` отдельным migrator credential;
3. повторить post-DDL backup/restore и privilege audit;
4. развернуть новый image, сохранив текущий backend как rollback и обязательную
   сеть `erpnext_frappe_network`; оставить runtime mode `shadow`;
5. построить свежий owner-authorized plan и применить его one-shot DML-only
   backfill user;
6. подтвердить 182+ payload rows (точное число определяется свежим source),
   hashes, latest-observation counts, нулевые orphan rows и полный shadow match;
7. только отдельной следующей командой переключить `shadow` на `verified` и
   проверить internal/public health, ERP read и реальный `/api/supply/orders` с
   `responseSource=sql`.

