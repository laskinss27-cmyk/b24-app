# Read-only dry-run снаба — локальный change set 2026-08-20

## Граница

Подготовлен только owner-only диагностический путь `POST /api/admin/sql-migration/supply/dry-run`. Развёрнутая версия читает ERPNext официальным REST API и `ctv_transfers` OAuth-контекстом владельца, строит нормализованный граф и возвращает агрегированный отчёт с blockers и стабильным hash исходного плана. Локальный follow-up дополнительно читает `ctv_tr_requests`; он ещё не закоммичен и не развёрнут.

В change set отсутствуют SQL writer, checkpoint, вызов migrations, runtime-чтение workflow tables, frontend-кнопка и source switch. Bitrix/ERPNext остаются источниками текущего поведения.

## Fail-closed проверки

- 403/ошибка чтения `ctv_transfers` или локально добавленного `ctv_tr_requests` — incomplete source, не пустой список;
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

Сначала отдельно разрешаются commit/push и read-only deploy по production runbook. После internal/public health, ERP read и network inspect dry-run вызывается из существующей OAuth-сессии владельца. Любой blocker оставляет SQL tables пустыми. Mirror writer проектируется только после разбора production-отчёта; его deploy/apply и тем более source switch требуют новых отдельных разрешений.

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

Локальный follow-up моделирует `__standalone__` Purchase Order и перемещения без basis как допустимые корни графа. Ручная заявка `kind=transfer` читается из `ctv_tr_requests` как `bitrix:supply_request:<id>`, а связь берётся из устойчивого `transfer-request:<id>`, не из отображаемого имени. Записи `kind=supply` этим маленьким этапом не импортируются. Для пяти исчезнувших исторических transfer ID tombstone пока не создаётся: нельзя выдумывать отсутствующий payload или строки; это остаётся отдельным design gate вместе с семью line mismatches и четырьмя stale revision links. SQL writer не проектируется до нового dry-run с объяснённым паритетом.
