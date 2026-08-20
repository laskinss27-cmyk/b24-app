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

Пять исчезнувших исторических transfer ID уже получили проверяемую canceled/submitted tombstone-модель без выдуманного payload и строк. Семь оставшихся SKU mismatch разобраны отдельным [read-only аудитом](sql-supply-line-mismatch-audit-2026-08-20.md): две live draft-связки остаются blockers, пять historical downstream-связок допускают только warning без line allocation. Узкая модель развёрнута и подтверждена пятым production dry-run; четыре stale revision links остаются отдельной задачей. Любой blocker оставляет SQL tables пустыми. Mirror writer проектируется только после плана с объяснённым паритетом; его deploy/apply и тем более source switch требуют новых отдельных разрешений.

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

## Третий production dry-run и фактическая причина historical gaps

Image `b24-app:dbd7b3c` развёрнут с сохранением `b24-backend-prev-before-dbd7b3c` (`b24-app:38ce403`). Internal/public health, readiness, официальный ERP read, state mount, port, restart policy и `erpnext_frappe_network` успешны; restart count 0. Один owner OAuth dry-run выполнен в `2026-08-20T15:36:28.596Z`, после чего SSH tunnel закрыт и краткоживущий OAuth token удалён из browser runtime.

Все источники снова прочитаны полностью: ERPNext `392`, `ctv_transfers` `110`, `ctv_tr_requests` `5`. План `bb879222bd3c2b1b1b051a0a8fef4648496d78e03a62357b0e13d74347f0f9e4` содержит 505 documents / 991 lines / 508 links / 705 allocations, 40 errors и 0 warnings. Tombstone не создался намеренно: политика требовала только проведённые ERP references, а официальный ERP API подтвердил, что все 12 Stock Entry для transfer `20156`, `20160`, `20182`, `20192`, `20298` отменены (`docstatus=2`) и старше 31 дня. Поэтому результат состоит из 12 missing links, 12 historical missing line matches, 5 `unconfirmed_missing_transfer`, 7 остальных SKU line mismatches и 4 stale request keys.

Это не concurrent race и не основание объявлять отменённые складские документы проведёнными. Независимый post-check подтвердил `B24_APP_DB_MODE=readiness`, 4 migration rows и `0|0|0|0` во всех workflow tables. Временные SSH/browser/diagnostic ресурсы удалены.

## Уточнённая локальная tombstone-модель

Новый ограниченный follow-up принимает две и только две однородные группы evidence старше 24 часов: все Stock Entry `docstatus=1` или все Stock Entry `docstatus=2`. Первая создаёт `source_missing`, вторая — `source_missing_canceled`. Смешанные submitted/canceled, draft, свежие и записи без читаемого timestamp остаются blocker. Статус описывает доказанное состояние ERP references; отсутствующий Bitrix payload по-прежнему не реконструируется.

Обе ветки создают только identity `bitrix:transfer:<id>`, детерминированный список Stock Entry/field/phase evidence и document links. Строки, deal, исходные timestamps, quantities и line allocations не выдумываются; каждая недоступная историческая строка остаётся warning `historical_transfer_line_unavailable`. Существующая повреждённая запись `ctv_transfers` по-прежнему делает source incomplete и tombstone не маскируется поверх неё.

Baseline уточнения: focused 14/14. После изменения focused suite 17/17, полный backend 203/203, общий typecheck и `git diff --check` успешны. На неизменном production snapshot ожидается 510 documents / 991 lines / 520 links / 705 allocations, 11 errors и 12 warnings. Это только локальное ожидание: deploy и четвёртый dry-run требуют отдельного разрешения; SQL writer и source switch отсутствуют.

## Четвёртый production dry-run

Commit `c9a3c0b` развёрнут как `b24-app:c9a3c0b`; предыдущий `b24-app:dbd7b3c` сохранён в `b24-backend-prev-before-c9a3c0b`. Internal/public health, readiness, официальный ERP read, state mount, port, restart policy и `erpnext_frappe_network` успешны; restart count 0. Один owner OAuth dry-run выполнен в `2026-08-20T16:19:23.083Z`. Production log содержит ровно один запрос и один `complete`, HTTP 200 за 3.67 s.

Фактический план `6e5072a3c5b702cc6e80a84560ba140cb2e91660c22f3429b97909f6d716ba8b` полностью совпал с предсказанной дельтой: источники ERPNext `392`, `ctv_transfers` `110`, `ctv_tr_requests` `5`; 510 documents / 991 lines / 520 links / 705 allocations, 11 errors и 12 warnings. Пять canceled evidence tombstone добавили пять transfer documents и 12 typed links. Прежние 12 missing links, 12 historical line errors и 5 unconfirmed-transfer errors исчезли; вместо недоступных исходных строк остались 12 явных `historical_transfer_line_unavailable` warnings без line allocations.

`readyToApply=false` сохраняется только из-за семи `missing_line_match` в существующих связанных документах и четырёх `stale_request_key`. Независимый post-check ограниченным runtime credential подтвердил `B24_APP_DB_MODE=readiness`, 4 migration rows и `0|0|0|0` domain rows. SSH tunnel закрыт, browser runtime с краткоживущим OAuth token сброшен, временные diagnostic/deploy файлы удалены. Следующий change set должен разбирать только одну из двух оставшихся групп; SQL writer и source switch по-прежнему запрещены.

## Пятый production dry-run

Commits `28232e1` и `b799329` fast-forward опубликованы в `origin/main`. Image `b24-app:b799329` собран из чистого `origin/main` archive, поэтому существующие production untracked `scripts/day-x-cleanup.mjs/.ts` не попали в build context и остались без изменений. Предыдущий `b24-app:c9a3c0b` сохранён как `b24-backend-prev-before-b799329`. Internal/public health, readiness, официальный ERP read, `/srv/b24-state:/app/state`, `127.0.0.1:3000`, `unless-stopped` и `erpnext_frappe_network` подтверждены; restart count после deploy и dry-run равен 0.

После отдельного action-time подтверждения один owner OAuth dry-run выполнен в `2026-08-20T17:01:10.827Z`. Production log содержит ровно один `POST /api/admin/sql-migration/supply/dry-run`, один `complete` и HTTP 200 за 4.35 s. План `e71076bbdfef8e9b9b07258755ad72ce4970e98e1261a59cca2acc33f35df4f2` полностью совпал с ожидаемой дельтой:

- полные источники: ERPNext `392`, `ctv_transfers` `110`, `ctv_tr_requests` `5`;
- 510 documents / 991 lines / 520 links / 705 allocations;
- 6 errors: 2 `missing_line_match` в live draft-связках и 4 `stale_request_key`;
- 17 warnings: 5 `historical_source_line_unavailable` и прежние 12 `historical_transfer_line_unavailable`.

Пять historical line errors стали warnings без изменения кардинальностей и без придуманных allocations. `readyToApply=false` сохраняется. Независимый runtime SELECT подтвердил `B24_APP_DB_MODE=readiness`, 4 migration rows и 0 строк в `workflow_documents`, `workflow_document_lines`, `workflow_document_links`, `workflow_line_allocations`. OAuth token затёрт, временная Chrome-вкладка закрыта, browser runtime сброшен, SSH tunnel и все временные deploy/post-check файлы удалены. SQL writer, backfill apply и source switch не выполнялись.

Последующий официальный ERP read разобрал все четыре `stale_request_key`: это одна удалённая версия `MAT-MR-2026-00002` от 17 июля, четыре canceled downstream-документа и новая draft-заявка с тем же именем от 21 июля без пересечения SKU. Отдельно обнаружено, что текущий `PUR-ORD-2026-00012` создан позже canceled `MAT-PRE-2026-00014` и содержит другой SKU, поэтому две document links приёмки в текущем dry-run ложные. Локальный historical revision change исключает их и ожидаемо меняет plan на 518 links / 2 errors / 20 warnings; focused `26/26`, полный backend `212/212` и typecheck успешны. Подробности: [аудит stale revision](sql-supply-stale-request-audit-2026-08-20.md). SQL остался пустым; commit и production deploy не выполнялись.

Посторонние наблюдения, не исправленные этим этапом: Docker build повторил существующие предупреждения Node 20 / `undici` engine, четыре npm audit findings и frontend chunk size; первоначальные независимые public/ERP команды не выполнились из-за локального PowerShell escaping и были безопасно повторены отдельным read-only скриптом; встроенный браузер блокировал адрес до загрузки, а новый Chrome placement не инициализировал BX24 SDK, поэтому OAuth был считан только из уже разрешённого placement POST через временное CDP-наблюдение. Ни одно из этих наблюдений не вызвало повторный dry-run и не менялось в коде.
