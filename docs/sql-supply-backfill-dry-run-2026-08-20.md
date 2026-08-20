# Read-only dry-run снаба — локальный change set 2026-08-20

## Граница

Подготовлен только owner-only диагностический путь `POST /api/admin/sql-migration/supply/dry-run`. Развёрнутая версия читает ERPNext официальным REST API, `ctv_transfers` и `ctv_tr_requests` OAuth-контекстом владельца, строит нормализованный граф и возвращает агрегированный отчёт с blockers и стабильным hash исходного плана.

В change set отсутствуют SQL writer, checkpoint, вызов migrations, runtime-чтение workflow tables, frontend-кнопка и source switch. Bitrix/ERPNext остаются источниками текущего поведения.

## Fail-closed проверки

- 403/ошибка чтения `ctv_transfers` или `ctv_tr_requests` — incomplete source, не пустой список;
- invalid JSON/ID/primary lines перемещения — blocker;
- stale Material Request key, отсутствующий документ/строка, неоднозначный SKU match или дубликат identity — blocker;
- отсутствующий `b24_request_qty` для allocation заказа — blocker;
- все ERP вызовы коллектора ограничены `list/get`; `ensure/setup/create/update` не вызываются;
- ERP doctypes читаются последовательно, не более восьми полных документов одновременно;
- отчёт не возвращает raw source payload и OAuth token.

## Baseline и проверка после

- исходный зафиксированный baseline до planner change set: backend 186/186, frontend 117/117, typecheck успешен;
- промежуточный planner checkpoint: backend 190/190 и backend typecheck успешны;
- после полного dry-run change set: backend 195/195, frontend 117/117, общий backend/frontend typecheck успешен;
- focused planner/snapshot suite: 9/9;
- локальный follow-up standalone/manual: исходный focused baseline 9/9 и typecheck; после изменения focused 12/12, полный backend 198/198 и общий typecheck успешны;
- backend production build (`tsc -p tsconfig.json`) успешен;
- `git diff --check` не нашёл ошибок.

Посторонняя ошибка: общий `npm run build` дошёл до frontend Vite после успешного backend build и frontend TypeScript, затем sandbox Windows запретил esbuild чтение каталога выше workspace (`Cannot read directory`, `Access is denied`). Это ограничение локальной среды, не ошибка dry-run-кода; в рамках этапа не исправлялось.

## Следующий gate

Отдельно выбрать проверяемую модель для пяти исчезнувших исторических transfer ID, не выдумывая их исходный payload и строки. Затем отдельными change sets разобрать семь SKU mismatch и четыре stale revision links. Любой blocker оставляет SQL tables пустыми. Mirror writer проектируется только после нового dry-run с объяснённым паритетом; его deploy/apply и тем более source switch требуют новых отдельных разрешений.

## Production deploy и первый dry-run

Commit `98eee50` опубликован и 2026-08-20 развёрнут только как диагностический backend image `b24-app:98eee50`. Работавший `b24-app:596bddb` остановлен и сохранён как `b24-backend-prev-before-98eee50`. Новый контейнер сохранил `/srv/b24-state:/app/state`, `127.0.0.1:3000:8080`, `unless-stopped`, `B24_APP_DB_MODE=readiness` и `erpnext_frappe_network`; restart count после deploy и dry-run равен 0. Internal/public health, readiness и официальный ERPNext read успешны.

Owner-only production dry-run выполнен один раз в `2026-08-20T14:21:54.072Z` через временный локальный SSH tunnel; tunnel закрыт, browser runtime с OAuth token сброшен. Источники прочитаны полностью: ERPNext `383`, Bitrix transfers `108`. План `359fe92e45d548ac7f60cb80d1e03b91dcc4b30bbaad8dcc5cc2f61737a7384d` содержит:

- 491 documents: 55 Material Request, 83 Purchase Order, 56 Purchase Receipt, 108 Bitrix transfer и 189 Stock Entry;
- 974 lines, 495 typed document links и 692 line allocations;
- 64 fail-closed issues, поэтому `readyToApply=false`.

64 issue — коррелированные проявления шести сценариев, а не 64 подтверждённых повреждения данных:

- 15 standalone transfers без purchase/request basis;
- три Purchase Order с виртуальным `__standalone__`: 3 missing document links + 3 missing line matches;
- три transfer, ссылающиеся на ручные `Заказ на перемещение #...`: 3 missing document links + 5 missing line matches;
- пять отсутствующих в текущем Bitrix registry старых transfer ID, на которые ссылаются 12 сохранённых ERP Stock Entry: 12 missing links + 12 missing line matches;
- семь отдельных несовпадений SKU между связанными Material Request / Purchase Order / Purchase Receipt / transfer;
- четыре документа со старым immutable request key для пересозданного `MAT-MR-2026-00002`.

Ни один сценарий не исправлялся и не был автоматически объявлен порчей данных. После dry-run runtime SELECT подтвердил 4 migration rows и `0|0|0|0` во всех четырёх workflow tables.

Follow-up `38ce403` моделирует `__standalone__` Purchase Order и перемещения без basis как допустимые корни графа. Ручная заявка `kind=transfer` читается из `ctv_tr_requests` как `bitrix:supply_request:<id>`, а связь берётся из устойчивого `transfer-request:<id>`, не из отображаемого имени. Записи `kind=supply` этим маленьким этапом не импортируются.

## Второй production dry-run

Image `b24-app:38ce403` развёрнут с сохранением `b24-backend-prev-before-38ce403` (`b24-app:98eee50`). Internal/public health, readiness, ERP read, state mount, port, restart policy и `erpnext_frappe_network` успешны; restart count 0. Один owner OAuth dry-run выполнен в `2026-08-20T15:06:45.424Z`, после чего SSH tunnel закрыт и browser runtime с OAuth token сброшен.

Все три источника прочитаны полностью: ERPNext `392`, `ctv_transfers` `110`, `ctv_tr_requests` `5`. План `cdad4b534ea4e17cb0973cd04ee7e36fc66609e35e45fcc113b9c8c597eea876` содержит 505 documents / 991 lines / 508 links / 705 allocations и 35 errors. Изменение данных между двумя запуска́ми отражает продолжающуюся рабочую эксплуатацию, поэтому абсолютные counts не используются как статичный fixture.

Ожидаемые 29 ложных blockers исчезли без новых issue: 15 standalone transfers, 6 проявлений виртуального `__standalone__` и 8 проявлений трёх ручных transfer requests. Остались ровно исходные независимые группы:

- 24 проявления пяти отсутствующих transfer ID: 12 missing document links + 12 missing line matches;
- 7 SKU line mismatches в существующих связанных документах;
- 4 stale request keys для пересозданного `MAT-MR-2026-00002`.

`readyToApply=false`. Независимый post-check подтвердил `B24_APP_DB_MODE=readiness`, 4 migration rows и `0|0|0|0` во всех workflow tables. Для пяти исчезнувших исторических transfer ID tombstone пока не создаётся: нельзя выдумывать отсутствующий payload или строки. SQL writer не проектируется до нового dry-run с объяснённым паритетом.

## Локальная tombstone-модель

Следующий локальный change set создаёт evidence-only tombstone только если положительный числовой transfer ID отсутствует в полном текущем `ctv_transfers`, но явно записан в проведённых ERP `Stock Entry.b24_transfer_document`, причём все такие Stock Entry старше 24 часов. Свежая, непроведённая или без читаемого timestamp ссылка остаётся error, чтобы concurrent scan не создавал ложную историю. Документ получает identity `bitrix:transfer:<id>`, статус `source_missing`, ноль строк и детерминированный список ERP-свидетельств: Stock Entry, поле ссылки и phase. Исходный Bitrix payload, deal, timestamps, quantities и строки не восстанавливаются по догадке.

Stock Entry получает проверяемую document link к tombstone. Line allocation не создаётся; для каждой строки возвращается `historical_transfer_line_unavailable` с severity `warning`. Существующая, но повреждённая запись `ctv_transfers` не превращается в tombstone: её source остаётся incomplete blocker. Отчёт теперь отдельно считает `errors` и `warnings`; только errors блокируют `readyToApply`.

Baseline перед изменением: focused 12/12 и общий typecheck. После 24-hour race gate: focused 14/14, полный backend 200/200 и общий typecheck успешны. На неизменном snapshot ожидаемая дельта — пять tombstone documents и 12 восстановленных document links, а прежние 24 historical errors заменяются 12 явными warnings без придуманных allocations. Фактическая production-дельта должна быть подтверждена отдельным deploy/dry-run; локальный код ещё не развёрнут.
