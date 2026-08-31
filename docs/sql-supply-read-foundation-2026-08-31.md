# Supply SQL read foundation — 31 августа 2026

## Почему полный read switch ещё закрыт

Текущий `/api/supply/orders` возвращает не только граф документов. Для рабочего
интерфейса нужны живые остатки ERPNext, названия и строки товаров, цены и
поставщики закупок, комментарии, история, задачи и отдельные факты
сборки/отправки/приёмки перемещений. Текущая SQL mirror schema намеренно хранит
устойчивые IDs, статусы, склады, количества, links, allocations и hashes, но не
полный UI-документ.

Поэтому включать SQL как источник всего ответа сейчас запрещено: это потеряло бы
часть полей карточек и действий. ERPNext остаётся источником физических остатков
и проведённых документов; Bitrix entity JSON остаётся legacy-источником полной
карточки перемещения до отдельного расширения workflow schema.

## Безопасный opt-in слой

Добавлен `B24_APP_SUPPLY_SQL_READ=off|shadow`, default `off`. Значения `sql` пока
нет намеренно.

- `off`: `/api/supply/orders` не открывает SQL reader, не пишет дополнительный
  лог и выполняет прежний код без изменений;
- `shadow`: после успешного legacy read загружается только latest SQL checkpoint;
  пользователь всё равно получает исходный Bitrix/ERPNext ответ;
- отсутствие SQL, пустой checkpoint, ошибка, timeout или mismatch никогда не
  превращаются в пустой список и не меняют HTTP-ответ — фиксируется fallback;
- runtime reader использует существующий read-only credential и фильтрацию всех
  graph tables по точному `latest.observed_at`.

Shadow-проекция сравнивает только покрытый схемой transfer-layer: ID, статус,
deal ID, порядок и product ID строк, planned/actual quantities, склады и явные
links `transfers_for_request`, `transfers_for_purchase`, `corrects_transfer`.
Также проверяются checkpoint counts, полное чтение Bitrix transfer registry и
число валидно разобранных записей. Названия, история, комментарии и action fields
не объявляются SQL-паритетными и продолжают приходить только из legacy.

## Проверки и следующий gate

До изменения focused baseline прошёл `27/27`. После изменения SQL shadow/fallback
tests вместе с тем же baseline прошли `33/33`, backend typecheck успешен. На этом
этапе production env, container и source-of-truth не менялись; deploy и
активация shadow не выполнялись.

Перед production shadow canary требуется commit/build/deploy с флагом `off`,
обычный health/readiness/ERP/network gate и отдельное разрешение. Только после
серии `match` можно проектировать недостающие workflow details/events и обсуждать
первое чтение из SQL; Bitrix fallback удалять нельзя.
