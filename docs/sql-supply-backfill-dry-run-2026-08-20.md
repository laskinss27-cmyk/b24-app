# Read-only dry-run снаба — локальный change set 2026-08-20

## Граница

Подготовлен только owner-only диагностический путь `POST /api/admin/sql-migration/supply/dry-run`. Он читает ERPNext официальным REST API и `ctv_transfers` OAuth-контекстом владельца, строит нормализованный граф и возвращает агрегированный отчёт с blockers и стабильным hash исходного плана.

В change set отсутствуют SQL writer, checkpoint, вызов migrations, runtime-чтение workflow tables, frontend-кнопка и source switch. Production не менялся: backend остаётся на прежнем image, `B24_APP_DB_MODE=readiness`, четыре domain tables пусты, Bitrix/ERPNext остаются источниками текущего поведения.

## Fail-closed проверки

- 403/ошибка чтения `ctv_transfers` — incomplete source, не пустой список;
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
- backend production build (`tsc -p tsconfig.json`) успешен;
- `git diff --check` не нашёл ошибок.

Посторонняя ошибка: общий `npm run build` дошёл до frontend Vite после успешного backend build и frontend TypeScript, затем sandbox Windows запретил esbuild чтение каталога выше workspace (`Cannot read directory`, `Access is denied`). Это ограничение локальной среды, не ошибка dry-run-кода; в рамках этапа не исправлялось.

## Следующий gate

Сначала отдельно разрешаются commit/push и read-only deploy по production runbook. После internal/public health, ERP read и network inspect dry-run вызывается из существующей OAuth-сессии владельца. Любой blocker оставляет SQL tables пустыми. Mirror writer проектируется только после разбора production-отчёта; его deploy/apply и тем более source switch требуют новых отдельных разрешений.
