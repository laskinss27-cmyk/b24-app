# Read-only аудит домена снаба для `b24_app`

Дата: 2026-08-20. Этот документ фиксирует только проектирование и read-only наблюдения. Доменные SQL-таблицы, backfill, shadow reads и переключение источников в рамках аудита не выполнялись.

## Неизменяемая граница

- Физические остатки и проведённые складские документы остаются в ERPNext; доступ — только официальный ERPNext API.
- Сделки, пользователи, права и CRM остаются в Битрикс24.
- `ctv_transfers` и аварийно-безопасная пагинация остаются действующим workflow/fallback.
- Production backend остаётся в `B24_APP_DB_MODE=readiness`: SQL используется только для `/ready` (`SELECT 1`).
- После отдельного последующего этапа четыре спроектированные domain tables созданы пустыми; workflow-данных, backfill и runtime-чтений/записей в них нет.

## Проверенный текущий граф

```text
Bitrix deal
  -> ERP Material Request
       -> ERP Purchase Order
            -> ERP Purchase Receipt
            -> Bitrix ctv_transfers (если товар надо довезти до склада заявки)
                 -> ERP Stock Entry ship
                 -> ERP Stock Entry receive
                 -> ERP Stock Entry correction при расхождении
       -> Bitrix ctv_transfers (обеспечение с существующего склада)
            -> ERP Stock Entry ship/receive/correction
  -> ERP Delivery Note (отдельный downstream-контур реализации)
```

Это граф, а не цепочка с отношением один-к-одному. Прямой проведённый `Purchase Receipt` на конечный склад заявки закрывает соответствующее количество без перемещения. Приход на другой склад сам по себе заявку не закрывает. Перемещение, созданное из закупки, продолжает движение тех же единиц и не является дополнительным покрытием.

## Идентификаторы и фактические места хранения

| Сущность | Текущее хранение | Текущий ключ/связь |
|---|---|---|
| сделка | Битрикс24 CRM | числовой deal ID; во всех других системах это внешняя ссылка |
| заявка снаба | ERP `Material Request` | `name`; приложение дополнительно строит immutable guard `requestKey = name@creation` |
| строка заявки | ERP `Material Request Item` | child-row `name`; `item_code` — SKU/product ID, но не уникальный ключ строки |
| заказ поставщику | ERP `Purchase Order` | `name`, `b24_supply_request`, `b24_supply_request_key`, `b24_deal_id` |
| доля заказа в потребности | ERP `Purchase Order Item` | child-row `name`; `b24_request_qty` отделяет количество заявки от общего количества закупки |
| приёмка | ERP `Purchase Receipt` | `name`, request name/key и `b24_purchase_order`; строки также могут иметь native ERP links на PO/MR items |
| workflow перемещения | Bitrix entity `ctv_transfers` | entity item ID + JSON `DETAIL_TEXT`; request name/key, optional PO, deal ID, статусы и ссылки на Stock Entry |
| проводки перемещения | ERP `Stock Entry` | `name`, `b24_transfer_document`, `b24_transfer_phase`, request name/key и optional PO |
| ручная заявка | Bitrix entity `ctv_tr_requests` | entity item ID + JSON `DETAIL_TEXT`; optional `transferId`/task ID |

## Обезличенный production baseline

Живой экран снаба был прочитан через уже авторизованную пользовательскую сессию без извлечения OAuth-токена и без новых write-вызовов. UI-карточки только открывались и закрывались.

Прямой server-side `entity.item.get` не выполнялся: существующий catalog webhook получил 403 на `ctv_transfers`, а права webhook намеренно не расширялись и новый token не создавался. Поэтому Bitrix-side baseline ниже основан на уже загруженном workflow UI; raw JSON integrity и `ctv_tr_requests` требуют отдельного разрешённого authenticated read-only прохода.

| Наблюдение | Значение |
|---|---:|
| заявок `Material Request`, показанных workflow | 54 |
| заявок с перемещениями | 44 |
| заявок с закупками | 40 |
| заявок одновременно с закупками и перемещениями | 30 |
| перемещений | 89 |
| заказов поставщикам | 78 |
| приёмок, вложенных в заказы поставщикам | 54 |
| максимум перемещений на одну заявку | 7 |
| максимум заказов поставщику на одну заявку | 9 |
| максимум дочерних transfer/purchase документов на одну заявку | 13 |
| максимум приёмок на один заказ в текущем наборе | 1 |

Текущие статусы также неоднородны: перемещения — 1 `Черновик`, 4 `Собрано`, 15 `В пути`, 62 `Принято`, 7 `Отменено`; закупки — 9 `Черновик`, 2 `На согласовании`, 13 `Заказано`, 54 `Получено`. У 54 закупок есть одна вложенная приёмка, у 24 приёмки ещё нет. Поэтому статус документа нельзя выводить только из факта наличия downstream-ссылки.

Распределение связей подтверждает обязательные `document_links`: один nullable `parent_id` потеряет множественные ветки и связь перемещения как с заявкой, так и с закупкой.

### Проверка ERPNext через официальный API

После завершения штатного backup cron одноразовый контейнер выполнил только HTTP GET к ERPNext. Bitrix и SQL credentials ему не передавались, raw identifiers в отчёт не выводились.

| Область | Read-only результат |
|---|---|
| `Material Request` | 54 документа / 219 строк; все `Purchase`, `Draft`, `docstatus=0` |
| `Purchase Order` | 81 документ / 156 строк; 78 точно связаны с текущими MR, 3 custom-ссылки не разрешаются в текущий набор MR |
| `Purchase Receipt` | 55 связанных документов / 98 строк; 54 submitted и 1 cancelled |
| `Stock Entry` | 185 связанных документов / 307 строк; 173 submitted и 12 cancelled |
| фазы `Stock Entry` | 99 `ship`, 83 `receive`, 2 `correction_extra`, 1 `correction_return` |
| повтор активной transfer phase | 0 |

У всех 780 загруженных ERP child rows заполнен собственный `name`. В текущем наборе нет документов с повтором одного `item_code` в нескольких строках. Это полезный baseline для backfill, но не основание вводить уникальность SKU на документ: ERP допускает такие строки, а внешний набор может измениться.

При этом native line links фактически отсутствуют: 0 строк PO содержат пару `material_request/material_request_item`, 0 строк PR содержат native links на PO/MR item и 0 строк Stock Entry содержат native link на MR item. Все 156 строк PO имеют `b24_request_qty`. Следовательно, существующая связь на уровне строк восстанавливается только из document-level custom fields, SKU и количества. Такой результат можно хранить как derived/shadow allocation с audit source, но нельзя объявлять исходной жёсткой связью.

ERP-кардинальности: из 54 MR у 14 нет заказа поставщику, у 22 один, у 12 два, у 6 три или больше; максимум — 9. Среди 81 PO у 55 есть одна связанная PR, у 26 нет; текущий максимум — 1. На 47 сделок приходится 54 MR: у 41 сделки одна заявка, у 5 две, у 1 три. Все MR остаются `Draft`, поэтому завершённость workflow нельзя брать из статуса MR — она действительно рассчитывается из дочерних документов.

Неисправленные наблюдения для отдельной классификации: 3 PO не разрешаются в текущий MR-набор; одна cancelled PR имеет несовпадающий request key; среди Stock Entry 43 не ссылаются на текущую MR и ещё 3 имеют несовпадающий key. Часть Stock Entry может относиться к самостоятельным перемещениям, поэтому эти числа не объявляются порчей данных без Bitrix-side cross-check. Ничего из этого в рамках аудита не изменялось.

## Минимальная нормализованная модель-кандидат

Модель ниже реализована как четыре последовательных one-statement migration-файла. В рамках самого аудита они не применялись. Позднее точные hashes прошли isolated MariaDB rehearsal и отдельный разрешённый production DDL apply при 0 domain rows; это не разрешение на backfill или переключение источников.

### `workflow_documents`

Одна строка на наблюдаемую заявку, закупку, приёмку, перемещение или проводку.

- внутренний `id`;
- `document_type`: `supply_request`, `purchase_order`, `purchase_receipt`, `transfer`, `stock_entry`;
- `external_system`: `erpnext` или `bitrix`;
- `external_id` как строка, уникальная вместе с системой и типом;
- nullable `external_revision_key` для текущего `requestKey = name@creation` и его downstream-копий;
- текущий внешний `status` и nullable `docstatus`;
- nullable Bitrix deal ID как индексируемая внешняя ссылка;
- внешний `created_at`/`modified_at`, `observed_at` и hash полей, участвующих в shadow comparison.

Полный произвольный JSON payload не нужен: authoritative документы остаются во внешних системах, а зеркало хранит только проверяемые поля workflow.

### `workflow_document_lines`

- внутренний `id` и `document_id`;
- внешний child-row key, если источник его предоставляет;
- стабильная позиция строки как fallback только для диагностики;
- `erp_item_code`/product ID;
- `planned_qty`, nullable `request_qty`, nullable `actual_qty`;
- nullable `source_warehouse` и `target_warehouse` для документов, где маршрут задаётся построчно;
- внешний `modified_at` и hash сравниваемых полей.

Уникальность должна опираться на `(document_id, external_line_key)`, а не на `(document_id, product_id)`: одинаковый SKU может законно встретиться в нескольких строках. У Bitrix transfer JSON стабильного line key сейчас нет; для read-only mirror допустимы ordinal + payload hash, но будущий authoritative writer обязан выдавать внутренний line ID, а не закреплять ordinal как вечную идентичность.

### `workflow_document_links`

Направленная типизированная связь `from_document_id -> to_document_id`.

Минимальные relation types: `ordered_for_request`, `received_against_order`, `received_for_request`, `transfers_for_request`, `transfers_for_purchase`, `posts_transfer_ship`, `posts_transfer_receive`, `posts_transfer_correction`, `corrects_transfer`. Deal ID остаётся индексируемой внешней ссылкой документа, пока CRM-сущности не входят в SQL workflow.

Направление document link единообразно: `from_document_id` — downstream/child, `to_document_id` — его upstream basis. Например PO → MR, PR → PO, transfer → PO/MR, Stock Entry → transfer, correction transfer → parent transfer.

Уникальность: `(from_document_id, to_document_id, relation_type)`. Ссылки не угадываются по одинаковому SKU или близкой дате.

### `workflow_line_allocations`

Эта таблица нужна уже на уровне модели, хотя её не было в исходном универсальном наброске:

- `source_line_id`, `target_line_id`;
- `allocation_type` (`ordered`, `received`, `transferred`, `fulfilled`, `cancelled`);
- количество, относящееся именно к этой связи;
- источник доказательства связи и `observed_at`.

Для allocation направление обратное по смыслу движения потребности: `source_line_id` — upstream demand/origin line, `target_line_id` — downstream line, покрывающая или исполняющая это количество. Такое различие с document links намеренное и фиксируется тестами будущего mapper, а не угадывается по названиям FK.

Без неё split одной строки заявки между несколькими закупками/перемещениями снова придётся вычислять агрегированием по product ID — то есть SQL повторит нынешнюю неоднозначность.

### Что откладывается

- `workflow_events` и idempotency keys — этап 4 после доказанного read-only mirror;
- `sync_jobs`/checkpoints — вместе с управляемым backfill и shadow comparison;
- ручные `ctv_tr_requests` — до отдельного authenticated аудита их пагинации, payload и кардинальностей; их нельзя смешивать с ERP `Material Request` только из-за одинакового слова «заявка»;
- реализации и другие модули — после отдельного аудита их собственных связей;
- `tilda_product_mappings` — отдельный поздний контур; остаток остаётся ERPNext, Tilda только проекция.

## Ограничения первого DDL change set

1. Четыре append-only файла по одному `CREATE TABLE IF NOT EXISTS`; без backfill и без runtime DML grants.
2. Никаких FK в ERPNext/Bitrix: внешние документы представлены локальными rows и проверяемыми links.
3. Внутренние `document_type`/`relation_type` ограничиваются явно; внешний статус сохраняется как raw `VARCHAR` и классифицируется отдельно, чтобы новый статус ERP/Bitrix не терялся и не блокировал зеркало.
4. Даты внешних систем и время наблюдения хранятся отдельно.
5. После DDL повторяются dump, внешний read-back и restore drill до любого backfill.
6. Rollback текущего runtime остаётся `B24_APP_DB_MODE=off`; удаление таблиц не является автоматическим rollback.

## Подготовленные локальные migrations

- `0001_create_workflow_documents.sql`;
- `0002_create_workflow_document_lines.sql`;
- `0003_create_workflow_document_links.sql`;
- `0004_create_workflow_line_allocations.sql`.

Каждый файл содержит ровно один DDL statement. Тест запрещает DML, `DROP`/`ALTER`/`TRUNCATE`, JSON columns, несколько statements и слишком длинные имена индексов/constraints. FK используют `ON DELETE RESTRICT`; внешний статус остаётся raw `VARCHAR`, а внутренние типы документов, связей и allocations ограничены CHECK constraints.

До production run обязательно отдельное разрешение и preflight отсутствия всех четырёх таблиц. `IF NOT EXISTS` нужен для восстановления после возможного разрыва между auto-commit DDL и записью metadata, но не должен маскировать неизвестную существующую схему. После DDL проверяются точные columns/indexes/FK/CHECK, затем выполняются новый dump, external read-back и isolated restore drill. Backfill всё ещё запрещён.

## Риски, найденные вне текущего этапа

- `ctv_transfers` требует полного entity scan; это уже защищено от ложной пустой страницы, но остаётся дорогим и хрупким fallback.
- Чтение `ctv_tr_requests` в текущем коде не использует тот же безопасный full paginator. Это отдельная существующая проблема; в рамках аудита не исправлялась.
- Прогресс заявки в нескольких местах агрегируется по product ID. Child-row key уже доступен у ERP заявки, но не проведён сквозным ключом через все документы.
- Отменённая закупка сейчас считается снятым спросом, а не вновь открытой потребностью. Shadow comparison обязан зафиксировать именно это текущее поведение до обсуждения бизнес-правила.
- Текущая production выборка имеет не более одной приёмки на заказ, однако тип в коде и ERP допускают массив приёмок; схема не должна закреплять наблюдавшийся максимум как ограничение.

Эти пункты записаны для следующих этапов и намеренно не исправлялись вместе с проектированием SQL.
